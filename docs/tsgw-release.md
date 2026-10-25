# tsgw 分支的 npm 发布

本仓库的 tsgw fork 用一条独立工作流发布 npm 包：`.github/workflows/tsgw-npm.yml`。
它只服务 `tsgw` 开发发布分支，不读写默认分支，不依赖 `main`；已有的 `.github/workflows/ci.yml`、`demo-pages.yml` 和 `package.json` 的 `scripts.release` 保持上游原样。

- 包：`@tossp/tsgw-agent`（身份持久化在源 `package.json`，CI 不替换）
- 预览版：push 到 `tsgw` → `next` dist-tag
- 稳定版：push `vX.Y.Z` 标签 → `latest` dist-tag
- 认证：npm 可信发布（OIDC），不保存 `NPM_TOKEN`
- 更新检查：正式版留在 `latest`、预览版留在 `next`；只接受本包同通道元数据，查看链接分别指向 `vX.Y.Z` 标签源码和 `tsgw` 分支，不依赖额外创建 GitHub Release。

## 1. 触发与版本规则

| 事件 | ref | 版本 | dist-tag | 是否发布 |
| --- | --- | --- | --- | --- |
| push | `tsgw` 分支 | `<源 version>-dev.<run_number>.<run_attempt>.g<sha 前 12 位>` | `next` | 是 |
| push | `vX.Y.Z` 标签 | `X.Y.Z`（必须等于该提交的源 `package.json.version`） | `latest` | 是 |

`build` job 有一道统一守卫，任何不在范围内的 ref 直接跳过：

```yaml
if: >-
  github.repository == 'tossp/tsgw-agent' &&
  (github.ref == 'refs/heads/tsgw' || startsWith(github.ref, 'refs/tags/v'))
```

所以默认分支和其它分支既不构建也不发布。仅保留分支推送和标签推送两种入口，不添加依赖默认分支注册的手动触发入口。

稳定 tag 有三道校验，任一不满足即失败（前两道在 `release/version.mjs` 内，第三道是工作流的一步）：

1. tag 名严格是 `v<semver>`，且与源 `package.json.version` 一致（正常流程是先 bump 提交，再打 tag）；
2. tag 提交必须在 `origin/tsgw` 的历史里（`git merge-base --is-ancestor HEAD refs/remotes/origin/tsgw`），所以误推上游旧 `v0.9.x` 标签不会发布；
3. 工作流把当前 `package.json` / `package-lock.json` 与 `git show HEAD:` 的基线做字段级比较（去掉 `version` 与 `packages[""].version` 后必须完全相等）。CI 只能给本次产物赋版本号，不能借机改写包名、`bin`、`repository`、`files`、许可证或依赖。

`release/version.mjs` 自己还会断言 `GITHUB_REPOSITORY == 'tossp/tsgw-agent'`、`HEAD == GITHUB_SHA`、包名与 lock 元信息一致，避免在上游仓库或错误 checkout 上发布。

## 2. 工作流结构

`build` job（`contents: read`，45 min）：

1. `actions/checkout@v7`，`fetch-depth: 0`、`fetch-tags: true`、`persist-credentials: false`
2. 显式 `git fetch origin +refs/heads/tsgw:refs/remotes/origin/tsgw`，供 tag 祖先核验
3. `actions/setup-node@v7`，Node 24，`cache: npm`
4. `npm ci` → `npm run lint` → `npx tsc --noEmit` → `npm test` → `node --test release/*.test.mjs`（`release/` 里没有测试文件时直接失败，不放行）
5. `node release/version.mjs`（写 `GITHUB_OUTPUT`：`version`、`tag`）
6. 字段级校验只有版本号被改写
7. `npm run build`，并拒绝 `.next/dev`、`.next/server/route-cache`
8. `node release/pack.mjs "$RUNNER_TEMP/tsgw-package"`
9. `npx playwright install --with-deps chromium`（smoke 用 Playwright 真的开登录页和终端）
10. `node release/smoke.mjs "$RUNNER_TEMP/tsgw-package"`
11. 写 step summary（包名、通道版本、dist-tag、ref、commit、事件），上传整个 pack 目录为 artifact `tsgw-npm-<version>`，保留 7 天

源测试先于版本赋值运行，是为了让 metadata 测试看到源版本，而不是 CI 派生版本。

`publish` job（`needs: build`，仅 `push` 事件，`environment: npm`，`contents: read` + `id-token: write`，20 min），固定并发组 `tsgw-npm-publish`、`cancel-in-progress: false`：

1. checkout 触发该运行的提交（provenance 的 git 上下文），下载同一 artifact
2. 校验 artifact：恰好一个 `.tgz`、`sha256sum -c SHA256SUMS`、tarball 内 `package.json` 的 `name` 必须是 `@tossp/tsgw-agent`、`version` 必须等于本次通道版本、`release.json` 的 `version`/`tag` 也要一致；dist-tag 只允许 `next`/`latest`，且必须与版本通道对应（预发布 → `next`，稳定 → `latest`）
3. 装 Node 24 与 `npm@11.21.1`（发布只需 `>=11.5.1`，见 §7）
4. 分支推送额外确认 `origin/tsgw` 的 head 仍是本次 `GITHUB_SHA`；不是则记 notice 并跳过后续发布步骤（step output 控制，不是简单 return）
5. 注册表预检：精确版本 URL 只有 **HTTP 404** 才放行；200 → 已发布，报错要求 bump 版本；其它状态码、网络错误、超时 → 一律拦下，避免盲目重发
6. 稳定版另做 `latest` 不降级检查：读 `dist-tags.latest`，若已有稳定版更高，拒绝旧标签把 `latest` 拉回去（数字元组比较，`latest` 与待发版本都必须是严格稳定 SemVer）
7. `npm publish <tgz> --access public --registry https://registry.npmjs.org --tag <next|latest> --provenance`
8. 失败即失败，不自动重试；之后只读轮询 `npm view <pkg>@<version>` 约 2 分钟确认可解析，不可见时只告警
9. 仅在 npm 发布成功且未被跳过时，向 npmmirror 的 `PUT /-/package/@tossp/tsgw-agent/syncs` 请求同步（30 秒超时，无 npm 凭据、不自动重试）。返回有效任务 ID 只代表已受理，不代表镜像已同步完成；失败只告警，不改变 npm 发布结果，更不能重新发布同一版本
10. 写 publish step summary（含 job 状态与镜像请求状态 `requested` / `failed` / `not requested`）

并发分两层：工作流级 `tsgw-npm-${{ github.ref }}` 让同 ref 排队（稳定版永不被取消）；publish job 级固定组 `tsgw-npm-publish` 让**不同** `v*` 标签也串行，避免两条标签并行改写 `latest`。预览通道的乱序由「head 即本次提交」+ 预检共同挡住。

## 3. 一次性配置（需要维护者配合）

### 3.1 npm 侧

首次操作前先现场核验（不要依赖本文档的快照）：

```bash
npm whoami                                   # 未登录时会提示先 npm login
npm org ls tossp                             # 仅当 @tossp 是组织；个人 scope 则核对用户名
npm view @tossp/tsgw-agent version           # 包目前是否存在
git ls-remote --heads origin                 # origin 是否已有 tsgw
```

首次准备时（2026-10-25）本机 npm 未登录，scope 权限尚未知，registry 返回 404，远程尚无 `tsgw`；实际首发前需重新核验。`@tossp` 可以是个人 scope 或组织 scope，不将组织查询失败直接等同于没有权限。

信任关系的建立顺序：npm 只能在**已存在的包**的设置页里配置可信发布，包不存在时没有这个页面。新包如何建立第一个可信发布连接，官方文档没有明文；下面的顺序是按平台结构推断的流程，第一次实操时确认。

1. 先把 `tsgw` 推送到 `tossp/tsgw-agent`，让工作流跑一次 `build`。`publish` 会因为还没有 OIDC 信任关系而失败，这是预期的；artifact 仍然可用。
2. 从那次运行下载**已验收的产物**，不要用源目录重新打包：

   ```bash
   gh run download <run-id> -n tsgw-npm-<version> -D /tmp/tsgw-bootstrap
   cd /tmp/tsgw-bootstrap && sha256sum -c SHA256SUMS
   ```

3. 用有 2FA 的账号 `npm login`，在**明确授权**后把该 artifact 以 `next` 通道首发（源目录、手工改版本都不参与）：

   ```bash
   npm publish /tmp/tsgw-bootstrap/tossp-tsgw-agent-<version>.tgz --access public --tag next
   ```

这一步只建立包、只写 `next`，不会产生 `latest`；版本号是 CI 派生的预览版本，后续预览仍按序增长。
4. 在 npmjs.com → Packages → `@tossp/tsgw-agent` → Settings → Trusted Publisher 添加 GitHub Actions，字段必须精确：

   - Organization or user：`tossp`
   - Repository：`tsgw-agent`
   - Workflow filename：`tsgw-npm.yml`（只填文件名，含 `.yml`）
   - Environment name：`npm`
   - Allowed actions：勾选 **Allow npm publish** 即可。`npm publish --tag next` 属于 publish 自身，本工作流从不调用 `npm dist-tag`，因此不需要、也不要为此扩大 dist-tag 权限；2026-09-03 之后新建的配置默认只有 `npm stage publish`，不勾 `npm publish` 会在发布时因权限不足失败。

5. 新建的可信发布配置必须在 **2 天内**完成第一次成功发布，否则配置过期且不可编辑，只能删掉重建。所以先把 workflow 与本文件推好，再创建配置并立刻推一次 `tsgw` 验证。
6. `package.json` 的 `repository.url` 必须精确指向本仓库（`git+https://github.com/tossp/tsgw-agent.git`），npm 用它在 OIDC 发布时校验来源。
7. 可信发布跑通后，建议把 Publishing access 设为 “Require two-factor authentication and disallow tokens”；可信发布用的是 OIDC，不受该开关影响。

### 3.2 GitHub 侧

- 仓库 Settings → Environments 新建 `npm`：
  - Deployment branches and tags 选 “Selected” 并允许 `tsgw` 与 `v*`，否则 publish job 会被拦下；
  - 可选：加 required reviewers 作为人工闸门；不需要、也不要配置任何 secret。
- 建议为 `v*` 开 tag protection rules（或 ruleset），只让发布者创建正式 tag。
- 不需要 `NPM_TOKEN` / `NODE_AUTH_TOKEN`。工作流不给 `setup-node` 传 `registry-url`，因此不会生成带 token 的 `.npmrc`；npm CLI 检测到 OIDC 环境后自动换取短期发布凭据。

## 4. 日常流程

预览版（推一次 `tsgw` 就发布）：

```bash
git switch tsgw
git fetch origin
git rebase origin/tsgw        # 或 merge，取决于分支约定
npm run lint && npx tsc --noEmit && npm test   # 本地检查，不 build
git push origin tsgw          # 触发预览发布，dist-tag next
```

安装预览版：`npm install -g @tossp/tsgw-agent@next`。

稳定版：

```bash
git switch tsgw
node -e "console.log(require('./package.json').version)"   # 确认源版本
git tag -a v0.1.0 -m "v0.1.0"                              # tag 必须等于源版本
git push origin tsgw                                        # 让 tag 提交落在 origin/tsgw 上
git push origin v0.1.0                                      # 按名推送，禁止 git push --tags
```

版本号规则：预览版不回写 Git；稳定 tag 必须等于该提交的源版本。正式版发布后，把 `package.json` 与 lock 的源版本一起提升到下一轮目标（如 `0.1.1`），后续预览即为 `0.1.1-dev.*`，准备就绪再打 `v0.1.1`。也可以在打 tag 前单独提交目标版本的 bump。`npm run release` 是上游脚本（自行 bump 版本、`next build`、直接 `npm publish` 到 `latest`），在 tsgw 分支不使用它。

## 5. 验证与排障

发布后只读确认：

```bash
npm view @tossp/tsgw-agent dist-tags --registry https://registry.npmjs.org
npm view @tossp/tsgw-agent versions --json --registry https://registry.npmjs.org | tail -c 400
gh run list --workflow tsgw-npm.yml --limit 5
```

- **预检报 HTTP 5xx / 请求失败**：这是设计上的拦截，说明无法确认版本是否已存在，绝不在不确定的情况下发布。等 registry 恢复后重跑该次运行即可。
- **预检说“已发布，去 bump 版本”**：该版本确实存在，重跑同一个 tag 没有意义。
- **预检说“latest 是 X，比待发版本新”**：说明标签是旧的，工作流拒绝把 `latest` 降级。按顺序补发更高的版本。
- **E404 / `dist-tags` 还是旧值**：新版本要几分钟才可见，这是传播延迟，不是发布失败，不是重发依据。
- **`npm publish` 失败但日志显示已上传**：先按上面命令确认版本；确认存在后再考虑 bump 版本，不要直接重跑。
- **`ENEEDAUTH` / “Unable to authenticate”**：可信发布字段不一致。逐字核对组织、仓库、工作流文件名（含 `.yml`）、environment 名 `npm`，确认用的是 GitHub 托管 runner（自托管 runner 不支持可信发布），并确认 job 有 `id-token: write`。
- **预览版被跳过**：日志里出现 “origin/tsgw moved to …”，说明该次运行的提交已不是分支 head，更新的运行会发布 `next`。
- **源测试本来就失败**：工作流不跳过、不放行，保持失败。先在本机 `npm test` 复现并修好，再推分支。
- **`.next/server/route-cache` 报错**：本地用 `npm run test:e2e`（`start` 模式）跑过后 `.next` 被污染，换干净 checkout 或让 CI 构建。

## 6. 本地构建与打包

`next build` 会重写 `.next/`，正在跑的 `npm run dev` 会因此报 “factory is not available”。发布构建只在 CI 或一次性 worktree 里做：

```bash
git worktree add --detach ../tsgw-build HEAD   # 分支已在别处 checkout，必须 --detach
cd ../tsgw-build
npm ci && npm run build
node release/pack.mjs /tmp/tsgw-local && node release/smoke.mjs /tmp/tsgw-local
```

`--detach` 构建的是**当前已提交的代码**；未提交的改动不在里面。要在本地验收未提交改动，先把改动提交（或复制一份快照目录并在其中初始化 git），再按上面的方式构建，否则 smoke 与 pack 验收的不是将要发布的内容。用完 `git worktree remove ../tsgw-build`。

`release/pack.mjs` 要求目标目录为空、`.next/BUILD_ID` 存在、没有运行中的 dev 锁；`release/smoke.mjs` 需要本机已有 Playwright Chromium（`npx playwright install --with-deps chromium`）。

本地已验证 Linux 的正式版和预览版安装、生产启动、登录和原生终端；macOS、Windows 尚未验收。npm 12 的安装脚本策略可能阻止本包的 `prepare-terminal.js` 和 `node-pty` 安装脚本；若遇原生终端或 macOS helper 权限问题，先核对安装日志，再只对确认需要的包放行脚本，不全局关闭脚本保护。

## 7. 依赖与证据（2026-10-25）

npm 官方文档（docs.npmjs.com/trusted-publishers）：

- 可信发布要求 npm CLI ≥ 11.5.1、Node ≥ 22.14.0；只支持 GitHub 托管 runner、GitLab.com 共享 runner、CircleCI cloud，自托管 runner 不支持。
- 可信发布的 GitHub 字段分组织、仓库、工作流文件名（必须在 `.github/workflows/` 里，含扩展名）、可选 environment 名、Allowed actions；`npm publish` 与 dist-tag 权限互相独立，需分别勾选；本工作流只用前者。
- 2026-09-03 之后创建的配置默认允许 `npm stage publish`，需显式勾选才能 `npm publish`。
- `npm dist-tag` 命令在 OIDC 下要求 npm ≥ 11.21.0（或 ≥ 12.2.0），并需要 Allow npm dist-tag；本工作流不调用该命令，`npm publish --tag` 属于 publish 的一部分。
- 新建可信发布配置需在 2 天内完成首次成功发布，否则过期。
- 公开包的可信发布会自动生成 provenance（命令里显式带 `--provenance` 只为可读性）。
- 发布的 `repository.url` 必须与 GitHub 仓库精确匹配；私有仓库发布不会生成 provenance。
- 工作流文件名必须与 npm 配置一致；本工作流只由 `push` 触发。

工作流把 `npm@11.21.1` 固定安装到 runner 上：发布本身只要 ≥ 11.5.1，固定版本是为了可复现，不是 dist-tag 权限要求。

GitHub Action 版本（`gh api repos/<action>/releases/latest` 与 `contents/action.yml`）：

| Action | 使用 | 最新发布 | `runs.using` |
| --- | --- | --- | --- |
| actions/checkout | `@v7` | v7.0.1（2026-07-20） | node24 |
| actions/setup-node | `@v7` | v7.1.0（2026-10-08） | node24 |
| actions/upload-artifact | `@v7` | v7.0.2（2026-10-07） | node24 |
| actions/download-artifact | `@v8` | v8.0.2（2026-10-07） | node24 |

四个浮动主标签 `v7` / `v7` / `v7` / `v8` 都存在于各自仓库（`git/matching-refs/tags/v` 可查），因此引用按主版本浮动，补丁升级自动生效；全部使用 node24 运行时，需要 GitHub 托管的 `ubuntu-latest`。`setup-node@v7` 移除了无效的 `NODE_AUTH_TOKEN` 占位（设置了 `registry-url` 却没有 token 时 legacy Yarn 1.x 与旧 npm 可能出错，pnpm 会告警，npm 可信发布不受影响）。本工作流不给 `registry-url`，不会生成带 token 的 `.npmrc`；publish job 另设 `package-manager-cache: false`。

## 8. 脚本契约（`release/` 与工作流之间）

工作流只依赖这三个命令，文件属于项目源码，不是 CI 生成物：

| 命令 | 输入 | 约定输出 |
| --- | --- | --- |
| `node release/version.mjs` | `GITHUB_REPOSITORY`、`GITHUB_REF`、`GITHUB_SHA`、`GITHUB_RUN_NUMBER`、`GITHUB_RUN_ATTEMPT`、`GITHUB_OUTPUT`、本地 git（`refs/remotes/origin/tsgw`） | stdout 打印 JSON `{ "version": "…", "tag": "next"|"latest" }`；设置了 `GITHUB_OUTPUT` 时写入 `version` 与 `tag`；只改写本次 checkout 的 `package.json` / `package-lock.json` 的版本字段；断言仓库、`HEAD`、包名与 lock 元信息 |
| `node release/pack.mjs <outDir>` | 已构建的工作目录 | 在空目录里产出恰好一个 `tossp-tsgw-agent-<version>.tgz`、`sha256sum -c` 兼容的 `SHA256SUMS`，以及含 `version`/`tag`/`filename`/`files` 的 `release.json`；拒绝 dev 锁与污染的 `.next` |
| `node release/smoke.mjs <outDir>` | 同上 | 从 tgz 装到临时 prefix，用 Playwright Chromium 验收登录页与终端；需要 CI 预装 Chromium |

发布 job 不重新构建，只发布 artifact 里的 tgz；冒烟也从同一 tgz 全新安装，所以最终发布的字节就是验收过的字节。

## 9. 首次实操要确认的事

- `@tossp` 个人／组织 scope 的发布权限与 npm 登录状态；
- registry 上包是否真的不存在（404）；
- 新包首个可信发布连接的建立方式（本文档按平台结构推断，官方无明文）；
- `origin/tsgw` 尚未建立，首次推送前确认分支名与上游遗留 `v*` 标签的范围（记得只按名推 tag）。
