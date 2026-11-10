# TSGW npm 发布与更新通道

## 范围与入口

本模块集中维护 fork 的版本派生、打包校验、安装冒烟、发布工作流契约测试，以及 CLI/Web 共用的包身份和更新通道规则。保持既有发布、安装及更新行为。操作说明见 [README.md](README.md)，CAT 归档与独立补传见 [BUILD.md](../cat-monitoring/BUILD.md)。

- `version.mjs`：`deriveRelease()`、`prepareVersion()`；默认以调用者工作目录为项目根，仅 CI 赋值版本字段。
- `pack.mjs`：`verifyPack()`、`readPackResult()`、`packRelease()`；校验生产构建和包内容，生成原有归档与摘要。
- `smoke.mjs`：安装已打包产物，在独立临时 prefix 中验证 CLI、生产启动、登录和原生终端；`terminal-output.mjs` 重组 SSE 输出。
- `smoke-environment.mjs`：仅测试子进程的环境允许列表、私有 HOME/agent/npm cache/双 npmrc；不继承宿主运行时、代理或凭据。
- `smoke-cat.mjs` / `smoke-cat-preload.cjs`：仅验收进程的回环收集器、Node 原生 HTTP/fetch 重定向、DNS 漏网失败记录和浏览器 context 路由；原始 envelope 只在内存中，不改产物/固定 DSN/默认监控。
- `smoke-isolation.test.mjs`：真实 Node SDK 默认 transport、未捕获异常退出码、环境及漏网失败封闭回归；`smoke-browser-regression.mjs`：真实 browser-init/Next SDK 的独立 Chromium 回归，不由需要先装浏览器的普通源测试入口隐式执行。
- `index.js` / `index.d.ts`：原生 CommonJS 公共 API（外部使用模块根路径或显式 `index.js`，不保留旧文件转发壳）；包身份、SemVer、`next` / `latest` 通道、注册表元数据与源码链接。JS 保持原生 CommonJS，根 manifest 固定从 `../../package.json` 加载，不依赖 cwd、TypeScript 转译或 Next 编译。
- `*.test.mjs`：真实实现、工作流内联脚本及临时 fixture 测试；不向 npm/CAT 发布或请求真实镜像同步。

CAT 归档和补传属于 `../cat-monitoring/`；登录与 Playwright 登录辅助属于 `../login2/`。不修改上游容器发布、触发条件、权限、OIDC、并发、网络参数或凭据边界；不提供旧路径兼容空壳。

## 模块外接入与共享修改

| 文件 / 位置 | 必要接线及原因 |
| --- | --- |
| `bin/pi-web-options.js`：`COMMAND_NAME` require | 从本模块原始 CJS 读取命令名，CLI 无需编译即可运行 |
| `bin/pi-web-update.js`：包身份/通道 helper require | 更新检查和安装继续遵循当前包及当前通道；不改 npm 调用和更新决策 |
| `app/api/app-update/route.ts`：helper import | Web 更新端点复用本模块；缓存、超时及响应契约不变 |
| `lib/pi-web-options.test.mjs`：helper require | 测试跟随新路径，保留命令名断言 |
| `.github/workflows/tsgw-npm.yml`：`Release helper tests`、版本/打包/冒烟、CAT 归档/补传步骤 | 调用新路径；测试步骤逐模块要求 `tsgw/release/*.test.mjs` 与 `tsgw/cat-monitoring/*.test.mjs` 非空，然后显式运行两者 |
| `.github/workflows/tsgw-npm-bootstrap.yml`：版本公式注释 | 仅修正文档性源码路径，初始化与认证行为不变 |
| `package.json`：`files`、`scripts.test` | 原始运行时文件与模块正式文档必须入包；`npm test` 的 `tsgw/**/*.test.mjs` 包含 release 在内的全部模块，CI 同时显式定向 release 与 CAT |
| `tsgw/AGENTS.md`：公共入口、文档与测试发现约定 | 常规测试覆盖全部模块，CI 对 release 与 CAT 另保留显式非空测试入口 |
| 根 `README.md`、`AGENTS.md`、`tsgw/AGENTS.md`、`e2e/README.md` | 正式发布说明为本模块 `README.md`，登录行为为 `../login2/README.md`，CAT 构建说明为 `../cat-monitoring/BUILD.md`；固定入口保留薄索引，包内断言使用新路径 |

没有通用共享代码重构。`bin/run-records.js` 的既有 `tsgw-agent` 进程识别保持原样；`lib/pi-web-cli-commands.test.mjs` 原有 CLI/bin 路径仍有效，不需机械改写。

## 宿主依赖与打包约束

- CLI 宿主：`bin/pi-web.js`、`pi-web-commands.js`、`pi-web-options.js`、`pi-web-update.js`、`run-records.js`、`process-lifecycle.js`；仍使用宿主的全局 npm / npx 判断、运行记录和进程生命周期。
- Web 宿主：更新路由、`lib/api-types.ts`、`NEXT_PUBLIC_APP_VERSION`、`PI_WEB_SKIP_VERSION_CHECK`；保留原接口与缓存行为。
- 根 `package.json` / lock 持久化包身份、依赖和源版本；依赖既有 `semver`，不增加依赖。
- `files` 必须包含 `tsgw/release/index.js`、`tsgw/cat-monitoring/next-config.mjs`、`tsgw/login2/README.md`、`tsgw/release/README.md` 和 `tsgw/cat-monitoring/BUILD.md`。CAT 的原始配置由包内 `next.config.ts` 直接加载，CLI 直接 require release 的原生 CJS，不能只依赖 `.next` 编译结果。不要求打包整个模块、发布脚本、测试或 AGENTS；其他既有 files 条目按各自职责保留。
- 包内继续要求生产 `.next/BUILD_ID`、登录路由、既有公开资产和文档。归档/冒烟依赖 npm、Git、tar、Playwright Chromium、原生 PTY；构建与打包必须使用干净 CI 或隔离目录，不能污染开发 `.next`。
- CI 保持源测试先于版本派生、同一次产物打包/冒烟/发布、CAT 归档先于移除 map、CAT 补传与 npm 发布互不依赖；初始化仍仅消费已验收产物。
- smoke 的全局式 npm 安装仍联网解析公开 registry 依赖并执行必要生命周期；npm 12 只在临时 userconfig 精确允许当前包版本与源 manifest 指定的 node-pty 版本，不全局放开。安装阶段不拿到测试密码或 Node preload。
- 服务启动前传入测试 preload（经 NODE_OPTIONS 覆盖 CLI 的 Next 子进程），浏览器页面创建前安装 context route 并禁用夹具 Service Worker 绕过。当前 SDK `@sentry/node/build/cjs/transports/http.js` 使用原生 `https.request`；升级须重新核验，不能只拦 fetch。漏网 CAT DNS 或本地收集错误令验收失败，不吞原始 pageerror/退出码。
- smoke 使用回环临时端口；清理后复查本次 Node PID、端口复用、PTY DELETE/404 与真实 shell PID 退出。报告写独立临时目录（输出路径），成功删除 HOME/prefix；失败保留 0700 fixture，包含随机测试凭据的可能性不能据此上传。日志只移除本次已知密码/Basic/Cookie 值，不新增产品脱敏策略。

## 升级检查

1. 核对 CLI 入口仍直接支持 Node CommonJS，根 manifest 定位正确；Web 编译能找到随文件迁移的 `.d.ts`。
2. 核对包身份/通道、版本派生、lock 字段以及工作流触发、权限、OIDC 和上游容器行为无漂移。
3. 检查 `next.config.ts` 原始导入及 CLI 原始 require 的依赖全部在 npm `files`；不要以 Next 编译成功替代安装后可用性检查。
4. 检查 `npm test` 的 `tsgw/**/*.test.mjs` 发现包括 release 在内的全部模块；CI 显式发布测试入口对 release 与 CAT 两模块均非空且不跳过既有用例。
5. 核对 smoke 的 `../login2/login2-start.mjs`、登录资产/API、终端 SSE 和安装目录契约仍符合宿主。
6. 核对模块文档、固定根索引和打包断言引用新路径；`docs/upstream-v*.md` 是历史验收事实，允许保留当时路径，不机械改写。

## 验证

在项目根运行：

```sh
node --test tsgw/release/*.test.mjs tsgw/cat-monitoring/*.test.mjs
# 单独运行；要求预装匹配的 Chromium，PLAYWRIGHT_BROWSERS_PATH 显式指向现有缓存。
node --test tsgw/release/smoke-browser-regression.mjs
node --test lib/pi-web-cli-commands.test.mjs lib/pi-web-options.test.mjs
node_modules/.bin/eslint tsgw/release bin/pi-web-options.js bin/pi-web-update.js app/api/app-update/route.ts lib/pi-web-cli-commands.test.mjs lib/pi-web-options.test.mjs
node_modules/.bin/tsc --noEmit
node bin/pi-web.js --version
node bin/pi-web.js --help
```

验收要求：上述测试不降低既有断言；同通道更新、异常元数据拒绝、发布保护与包内原始 helper 校验通过。`npm test` 不排除 release，CI 同时显式执行 release 与 CAT，不能用单一入口通过冒充全部验证完成。

开发工作树不执行 build。真实打包安装冒烟、发布、部署或提交需对应授权；完整生产安装验收使用干净 CI/隔离环境。验证流程与发布证据见 [README.md](README.md)，CAT 收尾见 [BUILD.md](../cat-monitoring/BUILD.md)，不另建台账。
