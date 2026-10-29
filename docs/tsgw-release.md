# tsgw 分支的 npm 发布

本仓库的 tsgw fork 用一条独立工作流发布 npm 包：`.github/workflows/tsgw-npm.yml`。
它只服务 `tsgw` 开发发布分支，不读写默认分支，不依赖 `main`；已有的 `.github/workflows/ci.yml`、`demo-pages.yml` 和 `package.json` 的 `scripts.release` 保持上游原样。

- 包：`tsgw-agent`（身份持久化在源 `package.json`，CI 不替换）
- 预览版：push 到 `tsgw` → `next` dist-tag
- 稳定版：push `vX.Y.Z` 标签 → `latest` dist-tag
- 认证：正式版和预览版统一由 GitHub Actions 使用 OIDC 可信发布；不依赖开发设备登录 npm，不执行本机首发，不配置 `NPM_TOKEN` / `NODE_AUTH_TOKEN` 回退
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
7. `npm run build`（仅 `tsgw` 分支注入 CAT 的 `SENTRY_RELEASE` / `SENTRY_AUTH_TOKEN`，见 §10），并拒绝 `.next/dev`、`.next/server/route-cache`
8. `node release/pack.mjs "$RUNNER_TEMP/tsgw-package"`
9. `npx playwright install --with-deps chromium`（smoke 用 Playwright 真的开登录页和终端）
10. `node release/smoke.mjs "$RUNNER_TEMP/tsgw-package"`
11. 写 step summary（包名、通道版本、dist-tag、ref、commit、事件），上传整个 pack 目录为 artifact `tsgw-npm-<version>`，保留 7 天

源测试先于版本赋值运行，是为了让 metadata 测试看到源版本，而不是 CI 派生版本。

`publish` job（`needs: build`，仅 `push` 事件，`environment: npm`，`contents: read` + `id-token: write`，20 min），固定并发组 `tsgw-npm-publish`、`cancel-in-progress: false`：

1. checkout 触发该运行的提交（provenance 的 git 上下文），下载同一 artifact
2. 校验 artifact：恰好一个 `.tgz`、`sha256sum -c SHA256SUMS`、tarball 内 `package.json` 的 `name` 必须是 `tsgw-agent`、`version` 必须等于本次通道版本、`release.json` 的 `version`/`tag` 也要一致；dist-tag 只允许 `next`/`latest`，且必须与版本通道对应（预发布 → `next`，稳定 → `latest`）
3. 装 Node 24 与 `npm@11.21.1`（发布只需 `>=11.5.1`，见 §7）
4. 分支推送额外确认 `origin/tsgw` 的 head 仍是本次 `GITHUB_SHA`；不是则记 notice 并跳过后续发布步骤（step output 控制，不是简单 return）
5. 注册表预检：精确版本 URL 只有 **HTTP 404** 才放行；200 → 已发布，报错要求 bump 版本；其它状态码、网络错误、超时 → 一律拦下，避免盲目重发
6. 稳定版另做 `latest` 不降级检查：读 `dist-tags.latest`，若已有稳定版更高，拒绝旧标签把 `latest` 拉回去（数字元组比较，已有版本与待发版本都必须是严格稳定 SemVer）。唯一例外是 npm 首次暂存自动创建的确切占位值 `0.0.0-stage`，按尚无稳定版处理，允许首次正式发布替换它；其它异常／预发布值仍拒绝
7. `npm publish <tgz> --access public --registry https://registry.npmjs.org --tag <next|latest> --provenance`
8. 失败即失败，不自动重试；之后只读轮询 `npm view <pkg>@<version>` 约 2 分钟确认可解析，不可见时只告警
9. 仅在 npm 发布成功且未被跳过时，向 npmmirror 的 `PUT /-/package/tsgw-agent/syncs` 请求同步（30 秒超时，无 npm 凭据、不自动重试）。返回有效任务 ID 只代表已受理，不代表镜像已同步完成；失败只告警，不改变 npm 发布结果，更不能重新发布同一版本
10. 写 publish step summary（含 job 状态与镜像请求状态 `requested` / `failed` / `not requested`）

并发分两层：工作流级 `tsgw-npm-${{ github.ref }}` 让同 ref 排队（稳定版永不被取消）；publish job 级固定组 `tsgw-npm-publish` 让**不同** `v*` 标签也串行，避免两条标签并行改写 `latest`。预览通道的乱序由「head 即本次提交」+ 预检共同挡住。

## 3. 一次性配置（需要维护者配合）

### 3.1 npm 侧

本机无需 npm CLI 登录。以下公开状态检查可匿名执行：

```bash
npm view tsgw-agent version --registry=https://registry.npmjs.org/
git ls-remote --heads origin tsgw
```

维护者在 npm 网页确认账号对 `tsgw-agent` 的管理权限，并检查包是否已经存在；不要求在开发设备运行 `npm whoami`、登录账号或提供凭据。

**新包初始化与 CI 发布授权是两个问题。** npm 的 `npm trust` 文档明确要求包已经存在；因此，包尚不存在时，不能把已有的 OIDC 工作流直接视为完成首发配置。本机登录既不能授权 GitHub runner，也不是解决此问题的前置步骤。

官方已支持通过 staged publishing 创建新包，但首次暂存会公开创建 `0.0.0-stage` 占位版本；使用 CI 暂存新包仍需要适当的认证，不能靠未建立的 OIDC 信任凭空获得权限。该方式不是本项目默认回退方案。若新包初始化需要占位版本、临时 token 或其它授权方式，必须先核实最小范围、说明副作用并取得用户单独同意，不自行执行。

未完成包初始化及可信发布配置时，保留已验收的 CI artifact 并报告阻塞；不回退本机发布、不复制本机凭据、不自动添加 secret，也不为认证错误反复重跑发布。

包已存在且维护者具备管理权限后，按以下步骤配置：

1. 在 npmjs.com → Packages → `tsgw-agent` → Settings → Trusted Publisher 添加 GitHub Actions，字段必须精确：

   - Organization or user：`tossp`
   - Repository：`tsgw-agent`
   - Workflow filename：`tsgw-npm.yml`（只填文件名，含 `.yml`）
   - Environment name：`npm`
   - Allowed actions：勾选 **Allow npm publish** 即可。`npm publish --tag next` 属于 publish 自身，本工作流从不调用 `npm dist-tag`，因此不需要、也不要为此扩大 dist-tag 权限；2026-09-03 之后新建的配置默认只有 `npm stage publish`，不勾 `npm publish` 会在发布时因权限不足失败。

2. 新建的可信发布配置必须在 **2 天内**完成第一次成功发布，否则配置过期且不可编辑，只能删掉重建。应先备好工作流和产物，再创建配置，并在发布授权范围内安排验证。
3. `package.json` 的 `repository.url` 必须精确指向本仓库（`git+https://github.com/tossp/tsgw-agent.git`），npm 用它在 OIDC 发布时校验来源。
4. 可信发布跑通后，建议把 Publishing access 设为 “Require two-factor authentication and disallow tokens”；可信发布用的是 OIDC，不受该开关影响。

### 3.2 GitHub 侧

- 仓库 Settings → Environments 新建 `npm`：
  - Deployment branches and tags 选 “Selected” 并允许 `tsgw` 与 `v*`，否则 publish job 会被拦下；
  - 可选：加 required reviewers 作为人工闸门；不需要、也不要配置任何 secret。
- 建议为 `v*` 开 tag protection rules（或 ruleset），只让发布者创建正式 tag。
- 不需要 `NPM_TOKEN` / `NODE_AUTH_TOKEN`。工作流不给 `setup-node` 传 `registry-url`，因此不会生成带 token 的 `.npmrc`；npm CLI 检测到 OIDC 环境后自动换取短期发布凭据。

### 3.3 经单独授权的一次性 CI 暂存初始化

独立入口为 `.github/workflows/tsgw-npm-bootstrap.yml`。先用新包名完成常规 CI 的检查、构建、打包和安装冒烟，再把对应运行 ID 保存为仓库变量 `TSGW_NPM_BOOTSTRAP_RUN_ID`，临时凭据只保存在 GitHub 的 `npm` 环境 Secret `NPM_STAGE_TOKEN`。

缺少运行 ID 或临时凭据时，初始化入口仅提示等待，不下载或暂存产物。配置就绪后重跑同一提交的初始化运行；它核验常规 CI 的工作流、分支、提交和构建验收结果，下载该次产物并校验摘要、包身份及版本，只执行一次 `npm stage publish --tag next`，不本机发布、不重建产物、不修改旧包。

暂存成功后立即删除临时 Secret 和运行 ID 变量，并通知维护者在 npm 网页吊销 Token。维护者随后审批暂存版本并配置常规工作流的 OIDC 信任；正常正式版／预览版流程不读取临时 Token。删除 GitHub Secret 不等于吊销 npm Token。

## 4. 日常流程

预览版（推一次 `tsgw` 就发布）：

```bash
git switch tsgw
git fetch origin
git rebase origin/tsgw        # 或 merge，取决于分支约定
npm run lint && npx tsc --noEmit && npm test   # 本地检查，不 build
git push origin tsgw          # 触发预览发布，dist-tag next
```

安装预览版：`npm install -g tsgw-agent@next`。

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
npm view tsgw-agent dist-tags --registry https://registry.npmjs.org
npm view tsgw-agent versions --json --registry https://registry.npmjs.org | tail -c 400
gh run list --workflow tsgw-npm.yml --limit 5
```

- **预检报 HTTP 5xx / 请求失败**：这是设计上的拦截，说明无法确认版本是否已存在，绝不在不确定的情况下发布。等 registry 恢复后重跑该次运行即可。
- **预检说“已发布，去 bump 版本”**：该版本确实存在，重跑同一个 tag 没有意义。
- **预检说“latest 是 X，比待发版本新”**：说明标签是旧的，工作流拒绝把 `latest` 降级。按顺序补发更高的版本。
- **E404 / `dist-tags` 还是旧值**：新版本要几分钟才可见，这是传播延迟，不是发布失败，不是重发依据。
- **`npm publish` 失败但日志显示已上传**：先按上面命令确认版本；确认存在后再考虑 bump 版本，不要直接重跑。
- **`ENEEDAUTH` / “Unable to authenticate”**：先确认包已存在、可信发布关系已创建且未过期，再逐字核对组织、仓库、工作流文件名（含 `.yml`）、environment 名 `npm` 和 Allow npm publish；确认是 GitHub 托管 runner，且 job 有 `id-token: write`。该错误不是要求开发设备登录 npm 的依据。
- **预览版被跳过**：日志里出现 “origin/tsgw moved to …”，说明该次运行的提交已不是分支 head，更新的运行会发布 `next`。
- **源测试本来就失败**：工作流不跳过、不放行，保持失败。先在本机 `npm test` 复现并修好，再推分支。
- **`.next/server/route-cache` 报错**：本地用 `npm run test:e2e`（`start` 模式）跑过后 `.next` 被污染，换干净 checkout 或让 CI 构建。
- **CAT source map 上传失败**：`tsgw` 分支构建会因此直接失败（`next.config.ts` 的 `errorHandler` 重新抛出 SDK 错误），不会产出看起来成功但没有符号化信息的产物。先核对 `SENTRY_AUTH_TOKEN` 是否在仓库级 secret、是否对该 CAT 项目有效，再重跑；失败日志里的 token 不复制到对话或提交里。

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
| `node release/pack.mjs <outDir>` | 已构建的工作目录 | 在空目录里产出恰好一个 `tsgw-agent-<version>.tgz`、`sha256sum -c` 兼容的 `SHA256SUMS`，以及含 `version`/`tag`/`filename`/`files` 的 `release.json`；拒绝 dev 锁与污染的 `.next` |
| `node release/smoke.mjs <outDir>` | 同上 | 从 tgz 装到临时 prefix，用 Playwright Chromium 验收登录页与终端；需要 CI 预装 Chromium |

发布 job 不重新构建，只发布 artifact 里的 tgz；冒烟也从同一 tgz 全新安装，所以最终发布的字节就是验收过的字节。

## 9. 包名调整与首次初始化（2026-10-25）

- 当前包身份调整为不带 scope 的 `tsgw-agent`，启动命令仍为 `tsgw-agent`；正式版 `latest` 与预览版 `next` 均以本包为目标。
- 旧的 `@tossp/tsgw-agent` 曾由 CI `40175947678` 暂存，npm 页面显示 `0.0.0-stage` 占位版本。旧 Token 已由维护者撤销；旧包及待审批版本不自动删除、审批或复用。
- 新包已由 CI `40177252293` 完成构建、打包和全新安装验收，再由初始化 CI `40177252224` 暂存；维护者已审批 `0.1.0-dev.3.1.g77d1c47f742c`，`next` 已可安装，临时 Secret 和初始化变量已删除。旧 scoped 包的产物未复用。
- npm 首次暂存自动将 `latest` 指向 `0.0.0-stage`；首个正式标签发布前请使用 `tsgw-agent@next`，不要把占位版本当成正式版。此占位值已纳入首次正式发布的校验例外，不需要额外的 npm dist-tag 权限。
- 可信发布配置已由维护者创建；仍需常规 CI 成功完成一次 OIDC 发布才能验收自动发布，不以人工审批的初始化版本替代该验证。
- GitHub 的 `npm` 环境仅允许 `tsgw` 分支和 `v*` 标签；开发设备不登录 npm、不手动首发，不为正常发布添加 Token 回退。

新包初始化依据：npm 官方 `npm trust` 的 Prerequisites，以及 `staged-publishing` 的新包占位版本说明。

## 10. CAT source map 上传（仅 tsgw 分支）

自建 CAT（Sentry，实例 `cat.tossp.com`、org `sentry`、project `tsgw-agent`）的构建期 source map 上传是 fork 自有功能，只挂在 `tsgw` 分支的预览构建上，不改变上游 CI、`scripts.release` 或标签发布流程。

- **生效范围**：`Build` 步骤的两个变量都以 `github.ref == 'refs/heads/tsgw'` 为条件；触发入口仍是 `branches: [tsgw]` 与 `tags: ["v*"]`，没有新增分支、手动触发或 job。`v*` 标签构建保留原有发布流程，但拿不到这两个值（空字符串），因此不做 CAT 上传，也不会把标签构建改成 `tsgw` 专属行为。
- **凭据位置**：GitHub 仓库 Settings → Secrets and variables → Actions → **Repository secrets** 中的 `SENTRY_AUTH_TOKEN`。必须放**仓库级**：`build` job 不声明 `environment`，只有 `publish` job 用 `npm` environment，所以放在 `npm` environment 下的同名 secret 对构建不可见。2026-10-28 已配置并回读确认仓库级 `SENTRY_AUTH_TOKEN`；`npm` environment 不需要重复配置。
- **无凭据时**：`SENTRY_AUTH_TOKEN` 缺失或为空 → `next.config.ts` 关闭 source map（不生成也不上传），普通构建照常完成；本地开发与不含该变量的构建行为不变。
- **有凭据时**：构建生成 source map 并上传，release 名为 `tsgw-agent@<本次通道版本>`。CI 通过 `SENTRY_RELEASE=tsgw-agent@<steps.version.outputs.version>` 显式给出该名字；本地或标签构建没有该变量时回落到源 `package.json` 版本。打包前 `release/version.mjs` 已把 `package.json` 改成同一通道版本，因此构建期 release、产物版本与运行时 `lib/cat-config.ts` 的 release 一致。部署时不需要再设置 `SENTRY_RELEASE`。
- **失败不静默**：SDK 会把部分上传失败当作可恢复错误，`next.config.ts` 用显式 `errorHandler` 重新抛出，确保上传失败即构建失败；有上传凭据时保留插件日志，便于核实实际上传结果。
- **实例差异**：`SENTRY_URL` / `SENTRY_ORG` / `SENTRY_PROJECT` 仍可用环境变量覆盖（默认自建实例、`sentry`、`tsgw-agent`）。运行时 DSN 由源码 `lib/cat-config.ts` 固定，与构建期上传凭据无关；构建期只需上传凭据，不需要 DSN。

验证边界：`release/cat-ci.test.mjs` 在本地用真实 `.github/workflows/tsgw-npm.yml`（js-yaml）与真实 `next.config.ts`（子进程加载并驱动 SDK 的 webpack 包装）核对分支范围、凭据位置、release 名与 source map 开关，不联网、不上传。**本地构建到真实 CAT 的端到端验收已通过**：仓库级 `SENTRY_AUTH_TOKEN` 已配置。独立干净快照的真实构建成功，Node/Edge/Client 插件上传成功，CAT 可回读 Release 及浏览器/服务端 Debug ID 对应的 artifact。2026-10-29 10:34（UTC+8）两条新错误经 `ts_tool → cat` 回读，分别还原到 `hooks/useAgentSession.ts:1007:23` 和 `app/api/agent/new/route.ts:51:13`，源码片段与产物快照一致；Release 和机器名标签正确。上传被本地测试端点以 403 拒绝时真实构建会失败。此项不等于真实 GitHub Actions 已运行或 npm 已发布；推送/发布仍需授权，完整证据和 CAT 后台观察边界见 `docs/cat-monitoring.md`。
