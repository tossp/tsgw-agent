# TSGW npm 发布

`tsgw-agent` 由 `.github/workflows/tsgw-npm.yml` 发布。包名、CLI、仓库身份和源版本持久化在 manifest 与 lock 中；CI 只为产物赋版本号。上游发布说明见 [docs/release.md](../../docs/release.md)，fork 使用本指南。

## 通道与版本

| 推送对象 | 产物版本 | npm 标签 |
| --- | --- | --- |
| `tsgw` 分支 | `<源 version>-dev.<run_number>.<run_attempt>.g<sha 前 12 位>` | `next` |
| `vX.Y.Z` 标签 | `X.Y.Z` | `latest` |

- 仅 `tossp/tsgw-agent` 的上述 ref 进入发布；默认分支和其他分支不发布。
- 稳定标签必须是严格 SemVer、等于该提交的源 `package.json.version`，且提交属于 `origin/tsgw` 历史。
- 源 `package.json`、lock 根及 `packages[""].version` 保持一致；预览版本不回写 Git。CI 校验除版本字段外的包身份、依赖等字段均未变化。
- 正式版和预览版统一用 GitHub Actions OIDC；不依赖本机 npm 登录，不配置 `NPM_TOKEN` / `NODE_AUTH_TOKEN` 回退。
- CLI/Web 更新检查保持原安装通道；源码链接分别指向稳定标签和 `tsgw`，无需创建 GitHub Release。
- fork 的日常 npm 发布仅走本工作流。上游 `publish.yml` 的 npm job 保留 `agegr/pi-web` 仓库守卫，`check-tag`、容器发布和 `scripts.release` 保持上游行为；正式 `v*` 标签仍可能同时发布容器。

## 日常发布

预览版：

```sh
git switch tsgw
git fetch origin
npm run lint
node_modules/.bin/tsc --noEmit
npm test
git push origin tsgw
```

推送前整合远端 `tsgw` 的新增提交；上游同步按 [整合指南](../../docs/upstream.md) 执行。安装预览版使用 `npm install -g tsgw-agent@next`。

稳定版先更新并提交 manifest 与 lock 的目标版本，再按名称推送标签：

```sh
release_version=$(node -p "require('./package.json').version")
git tag -a "v$release_version" -m "v$release_version"
git push origin tsgw
git push origin "v$release_version"
```

不得用 `git push --tags`。正式发布后同步提升 manifest 与 lock 的源版本，供下一轮预览使用。上游 `npm run release` 只修改版本、提交并创建标签，不执行构建或发布。

### 发布验收

从本次流水线读取实际版本和 SHA，分别检查构建、npm 与 CAT job，随后回读官方注册表：

```sh
gh run list --repo tossp/tsgw-agent --workflow tsgw-npm.yml --branch tsgw --limit 5
npm view tsgw-agent dist-tags --json --registry=https://registry.npmjs.org
# 将版本占位符替换为本次发布日志中的值。
npm view tsgw-agent@X.Y.Z-dev.N.A.gSHA version dist.integrity --json --registry=https://registry.npmjs.org
```

精确版本可见、目标标签指向该版本后，才确认注册表验收完成。npm 已受理但仍在处理或传播时，CI 可能成功而查询暂时返回 `404`；继续只读核验，不重复发布。镜像同步请求返回任务 ID 只代表已受理，不代表镜像已更新。

## 工作流与产物

工作流的 runner、Actions 和 npm 固定版本以 [YAML](../../.github/workflows/tsgw-npm.yml) 为准，不另维护“最新版本”快照。

| job | 流程与结果 |
| --- | --- |
| `build` | 干净安装 → lint、类型检查、全量源测试和 release/CAT 契约测试 → 派生版本并核对字段 → 生产构建 → 打包 → 从 tgz 全新安装并验证 CLI、登录和原生终端。 |
| `publish` | 只消费同次构建的 `tsgw-npm-<version>` artifact，校验唯一 tgz、`SHA256SUMS`、包身份、版本、通道和 `release.json` 后通过 OIDC 发布；不重新构建。artifact 保留 7 天。 |
| `cat-upload` | 仅 `tsgw` 分支消费同次构建的 S3 原始 JS/map，独立创建 CAT Release 并补传映射。见 [CAT 归档与补传](../cat-monitoring/BUILD.md)。 |

`tsgw` 构建先离线生成并归档 JS/map，S3 保存成功后才移除 npm 构建目录中的 map。S3 归档失败阻断构建；`publish` 和 `cat-upload` 都只依赖 `build`，CAT 上传失败不会阻止 npm 发布。稳定标签保留原构建行为，不启用这套分支专用归档。

发布保护：

- 源测试先于版本赋值；release 和 CAT 两组定向测试都必须非空。
- 预览发布前确认 `origin/tsgw` 仍指向本次 SHA，旧提交跳过后续发布。
- 精确版本预检只有 HTTP `404` 放行；`200` 表示已存在，其他状态、超时和网络错误均阻断。
- 稳定发布不得降低 `latest`；只有首次暂存的确切占位值 `0.0.0-stage` 按尚无稳定版处理，其他异常值不放行。
- workflow 按 ref 串行，publish 再用固定组 `tsgw-npm-publish` 跨 ref 串行，均不取消进行中的运行。
- npm 发布成功且未跳过时才请求 npmmirror 同步；同步无 npm 凭据、不自动重试，失败只告警，不改变 npm 结果。

版本、打包和冒烟脚本入口及升级检查见 [模块规则](AGENTS.md)。

## 可信发布配置

维护者在 npm 的 Trusted Publisher 中核对：

| 字段 | 值 |
| --- | --- |
| Organization or user | `tossp` |
| Repository | `tsgw-agent` |
| Workflow filename | `tsgw-npm.yml` |
| Environment name | `npm` |
| Allowed actions | `Allow npm publish` |

`npm publish --tag` 属于 publish；本工作流不调用 `npm dist-tag`，无需扩大该项权限。`repository.url` 必须指向 `git+https://github.com/tossp/tsgw-agent.git`。

GitHub 的 `npm` environment 只允许 `tsgw` 与 `v*`，可设置人工审批；无需 npm token secret。publish job 使用 GitHub 托管 runner 和 `id-token: write`，不向 `setup-node` 传 `registry-url`。

新包初始化与日常 OIDC 发布是独立操作。若确需初始化新包，另行核实授权和最小凭据范围；保留的 `.github/workflows/tsgw-npm-bootstrap.yml` 只消费 `TSGW_NPM_BOOTSTRAP_RUN_ID` 指向的已验收 artifact，使用临时环境 Secret `NPM_STAGE_TOKEN` 暂存，不本机首发、不重建。暂存完成后删除临时 Secret/变量，并由维护者在 npm 撤销 token、审批和配置可信发布。已有包日常发布不使用该入口，也不操作旧 `@tossp/tsgw-agent` 包。

## 排障与收尾

- **版本已存在或发布结果未知**：先核验精确版本、标签和原运行日志，不直接重跑发布或修改 dist-tag。
- **预检网络错误或 5xx**：尚不能确认版本是否存在；恢复后先只读核验，再决定是否重试尚未发布的任务。
- **`latest` 比目标版本新**：拒绝旧标签降级，使用更高的目标稳定版本。
- **`ENEEDAUTH`**：核对包是否存在、可信关系是否有效，以及仓库、工作流文件名、environment、`Allow npm publish`、托管 runner 和 OIDC 权限；不以本机登录或 token 回退绕过。
- **“origin/tsgw moved”**：该运行的提交已不是分支 head，应跟踪新提交对应的运行。
- **注册表 `404`、标签旧值或 `0.0.0-stage`**：区分新版本尚不可见与没有正式版；占位版本不能作为稳定版验收。
- **源测试失败或 `.next/dev`、`.next/server/route-cache` 污染**：修复或使用干净检出，不跳过检查、不从开发 `.next` 打包。
- **CAT job 失败**：分别报告 npm 和 CAT 结果；在其他已授权任务完成后按 [补传规则](../cat-monitoring/BUILD.md) 主动收尾。只使用同次 S3 原件，核实服务端状态后补传，不重建或重发 npm。

## 本地生产验收

优先使用发布 CI。需要本地构建时，使用最终提交的独立 worktree；不在正在开发的工作树运行 `next build`：

```sh
git worktree add --detach ../tsgw-build HEAD
```

未提交改动不在该快照中。验收前核对 HEAD、manifest/lock 和全部未跟踪文件；存在污染则停止，不删除他人成果。构建目录不得带有 `.next`、宿主 `.env*`、npmrc、共享依赖软链或活动 dev 锁。完成后移除干净的临时 worktree。

测试层隔离要求：

1. 使用 `createSmokeEnvironment()` 创建私有 HOME、agent、XDG、临时目录、npm cache 和双 npmrc；只显式传入工具链 PATH、语言和已安装的 Chromium 缓存。不继承宿主运行时、代理或凭据，依赖通过 `npm ci --include=dev` 独立安装。
2. 构建前异步启动 `startCatCapture()`，把 `capture.env` 传给构建子进程，保持父事件循环可用；结束时检查 `capture.assertClean()` 并关闭收集器。测试只重定向传输，不改变固定 DSN、默认监控或 tgz 字节，不向真实 CAT/S3 上传。
3. 对空产物目录依次运行 `node tsgw/release/pack.mjs <outDir>` 和 `node tsgw/release/smoke.mjs <outDir>`。pack 拒绝 dev/敏感文件并要求生产 BUILD_ID；smoke 从同一 tgz 全新联网安装，不软链源依赖、不跳过 PTY。
4. npm 12 的生命周期放行只在临时 userconfig 精确匹配已验 tgz 的 `file:<绝对路径>` 与 manifest 指定的 node-pty 版本；不全局放开脚本。必要的 macOS helper 权限修复仍须执行；npm 11 保持既有行为。
5. Node 原生 HTTP/fetch 与浏览器 CAT 请求均在测试层截获，漏网 DNS、pageerror、安装或服务异常仍失败。服务组、PID、端口及 PTY 分别核验清理；非预期晚期退出不能判成功，leader 退出也须回收其子进程。

隔离只约束测试启动器与夹具，不是操作系统沙箱，安装仍访问公开 npm registry。失败夹具保持私有权限，可能含随机测试凭据，不直接上传；成功移除安装/HOME 夹具。报告保留日志、退出状态、截图及仅含通道/条目类型的 CAT 摘要，不保存 envelope 正文。详细实现约束见 [模块规则](AGENTS.md#宿主依赖与打包约束)。

独立隔离回归不执行完整 build/pack/install smoke，也不向真实 CAT 上报：

```sh
node --test tsgw/release/smoke-isolation.test.mjs tsgw/release/smoke-install-scripts.test.mjs tsgw/release/smoke-lifecycle.test.mjs
# 必须预先提供已安装的 Chromium 缓存。
PLAYWRIGHT_BROWSERS_PATH=<现有浏览器缓存> node --test tsgw/release/smoke-browser-regression.mjs
```

浏览器回归在安装 Chromium 后单独执行，普通源测试不隐式要求浏览器。Linux 安装冒烟不能替代 macOS/Windows、真实供应商、生产 CAT 摄入或事件堆栈还原的专项验证。
