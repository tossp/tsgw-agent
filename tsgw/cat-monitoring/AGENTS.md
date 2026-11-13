# CAT Monitoring 模块

## 公共入口

`index.ts` 统一导出跨环境 `reportCatError()`、`reportCatAgentEvent()`，宿主使用 `@/tsgw/cat-monitoring`；Node-only 配置从 `server.ts` 导出 `getCatConfig()`，使用 `@/tsgw/cat-monitoring/server`。`browser-init.ts`、`server-init.ts`、`next-config.mjs`、`global-error.tsx` 保持专用环境／框架入口，不混入公共 capture 依赖图。构建归档与补传的正式操作说明见 [BUILD.md](BUILD.md)。

## 范围与边界

- TSGW 自有错误采集、运行时公开配置、Sentry 构建包装、同次 JS/map 归档及补传；默认启用固定公开 DSN，Release 跟随包版本，instance 直接取 `os.hostname()`。
- 保持既有初始化时机、SDK 默认 request/user 收集、异常内容和采集范围。不新增脱敏、离线缓存、限流、界面、Replay、日志、指标、普通 HTTP/浏览器追踪或 Seer。
- `../agent-tracing/` 是独立模块，不迁移、不改其采集。Node 初始化仍原样合入 `getAgentTracingOptions()`，服务端错误仍由 wrapper 一次捕获，不移到每浏览器 SSE 转发。
- `reportCatError()` 忽略 AbortError，best-effort capture 不改变业务结果；`reportCatAgentEvent()` 仅处理原有 provider/prompt/extension 错误事件。不附加整段聊天或工具结果。
- 错误覆盖范围是浏览器／React 未捕获错误、失败的会话／命令请求、非预期 SSE 故障，以及服务端 API/provider/prompt/extension 错误；正常 abort/close 路径保持不报。wrapper 原始 emission 边界只采集一次，初始 `session_start` 的 `extension_error` 必须在上游转为启动通知并提前 return 前采集；重播通知不重复采集，不随订阅浏览器数量增加，不迁入逐浏览器 SSE 转发。tracer 须在 constructor 可能 emit 通知前初始化。
- 浏览器经 `/api/cat-config` 取得公开 DSN、服务器 hostname 和包版本；上传凭据仅由独立 CAT 补传 job 持有。仅 tsgw preview CI 注入构建 Release 并归档原始 JS/map，运行时不以补传成功作为启动条件。服务端 Agent tracing 是独立的追踪例外，采集及正文范围以 [Agent tracing 规则](../agent-tracing/AGENTS.md) 为准。

## 文件与运行环境

| 文件 | 职责 / 环境 |
| --- | --- |
| `cat-config.ts` | Node-only：hostname 与根 package.json 版本；`getCatConfig()` 仅返回公开 SDK 设置，绝不含上传凭据。 |
| `cat-monitoring.ts` | 客户端/服务端共用 capture helper；只能依赖跨环境 SDK，不导入 Node 配置或 tracing。 |
| `cat-agent-events.ts` | 服务端 wrapper 原始失败事件到错误采集；不改变事件本身。 |
| `browser-init.ts` | 浏览器副作用入口：静态加载后立即异步 fetch `/api/cat-config`，收到有效 DSN 后原样 `Sentry.init()`；不等待 hydration、不换动态加载、不增加重复初始化保护。浏览器统一 tunnel `https://cat.tossp.com/e`。 |
| `server-init.ts` | Node-only 副作用入口：读取配置，原样合入独立 tracing policy 后初始化；不得从浏览器或 Edge 导入。 |
| `global-error.tsx` | 客户端 React error boundary 内容：effect 报告错误，保留 NextError 与 html/body。 |
| `next-config.mjs` | Node 配置入口：`withCatMonitoring(nextConfig, version)`、`applyCatWebpack(config, {dev,isServer})`；仅抽出既有 CAT 配置，不接管宿主 webpack callback。使用可被 Node 原生解析的明确 `.mjs` 路径。 |
| `cat-artifacts.mjs` | CLI/API：同次构建 JS/map 原字节归档、Debug ID/逐文件 hash 校验；构建根默认仍为 cwd，不是脚本目录。 |
| `cat-upload.mjs` | CLI/API：校验归档并调用当前 SDK 依赖的官方插件公开 API；仅补传原件，不重新注入 Debug ID、不构建。 |
| `*.test.mjs` | 模块专属单测；真实 Sentry 内存 transport/beforeSend、本地 faux HTTP、真实 tar 与真实 SDK webpack 包装。 |
| `e2e.mjs` | 迁自 e2e 的浏览器回归；避免与运行时 cat-monitoring.ts 同名导致 extensionless import 误入 CLI；默认根定位为模块目录向上两层，也保留 CAT_E2E_ROOT。独占 dev 工作树才可启动，不在已有 dev 锁上另开服务。 |

## 全部模块外接入点

| 文件 / 函数或配置 | 必要接线与升级检查 |
| --- | --- |
| 根 `instrumentation-client.ts` | Next 规定的根入口，静态导入 browser-init；不能改成 fire-and-forget dynamic import 或延后到 React effect。 |
| 根 `instrumentation.ts` 的 register / onRequestError | 保留 SDK captureRequestError 导出及 NEXT_RUNTIME === nodejs 内对 sentry.server.config 的 await import；然后照旧注册 instrumentation-node。编译期分支防止 Node API 进入 Edge。该文件无需改动。 |
| 根 `sentry.server.config.ts` | SDK/Next 约定位置，仅静态导入 server-init；实际初始化仍发生在 register 的 Node 分支 await import 内。 |
| `app/global-error.tsx` | 保留 use client 与默认导出，通过模块重导出实际 boundary。 |
| `app/api/cat-config/route.ts` 的 GET / dynamic | 仅改 getCatConfig import；force-dynamic、Response.json、Cache-Control: no-store 原样保留。 |
| 根 `next.config.ts` 的 webpack / default export | webpack callback 内调用 applyCatWebpack 后继续宿主 GFM loader；default export 调用 withCatMonitoring，保留配置根路径、版本读取、Next/webpack callback 及全部上游配置。 |
| `lib/agent-client.ts` 的 sendAgentCommand | 仅改 reportCatError import；原 transport、异常重抛、4xx 不报告、5xx/2xx error 报告、2xx 无效 JSON 报告后仍返回 undefined 语义不变。 |
| `lib/agent-event-connection.ts` 的 ensureConnected / open / fail | 仅改 import；继续在原失败边界报告，manual close、换会话、页面释放不报告，不另建状态机或重连机制。 |
| `lib/agent-event-stream.ts` 的 publishSession catch | 仅改 import；启动失败仍发 startup_error，普通中断/关闭不变。 |
| `app/api/agent/new/route.ts` 的 POST / `app/api/agent/[id]/route.ts` 的 POST | 经模块入口采集；保留 source、operation、session 与响应内容。已有会话 POST 的 catch 复用上游最终 status（404 或 500）报告，不能把真实 404 记成 500。 |
| `lib/rpc-manager.ts` 的 AgentSessionWrapper.emit / constructor | 仍在 wrapper 单次原始事件边界、tracer 局部 scope 内报告，并在初始 `session_start` 错误转为可重播通知前执行；tracer 在 constructor 首次通知前就绪，不因浏览器数量或重播重复采集。 |
| `hooks/useAgentSession.ts` 的 handleSend 新会话 catch | reportCatError import 使用本模块公共入口；不改发送、恢复、状态或其他 hook 逻辑。 |
| `tsgw/agent-tracing/policy.test.mjs` | getCatConfig import 使用 ../cat-monitoring/server；不改变 tracing 实现/测试断言。 |
| `lib/agent-client.test.mjs` / `lib/agent-event-connection.test.mjs` | 保留真实宿主客户端/连接测试原位；仅 CAT 专属测试与其 Sentry setup 迁本模块。模块测试仍执行真实宿主代码，连接 fake 仅是测试夹具。 |
| `.github/workflows/tsgw-npm.yml` | 归档/上传命令使用本模块同名脚本；保持既有触发、分支守卫、job 依赖及凭据边界。 |
| 根 `package.json` 的 files / scripts.test | 测试发现必须包含全部 tsgw/**/*.test.mjs（包括 release）；Next 启动读取原始 next.config.ts，故原始 tsgw/cat-monitoring/next-config.mjs 必须进入 npm files，不能只打包 .next。 |
| 根 `AGENTS.md`、`README.md`、`tsgw/AGENTS.md`、`e2e/README.md`、`docs/agents/sessions.md` CAT 段、`tsgw/release/README.md` | 固定入口与发布说明只索引本模块规则和 `BUILD.md`，保留上游其余说明。 |

## 依赖但未修改的宿主契约

- `proxy.ts` 继续允许未登录读取 `/api/cat-config`，并执行原有跨源策略；公开配置不是凭据入口。
- `instrumentation-node.ts` 的 HTTP dispatcher、codemode、关闭 SSE 和 SDK 预热均属于宿主，未迁移或修改。
- `cat-config.ts` 直接导入根 package.json，不依赖构建机工作目录；浏览器只通过 API 获得公开配置，不能导入 Node-only 文件。
- Next 本地指南：`node_modules/next/dist/docs/01-app/02-guides/instrumentation.md`、`03-api-reference/03-file-conventions/instrumentation{,-client}.md`、`03-api-reference/05-config/01-next-config-js/webpack.md`。根入口位置、Node/Edge 分支、静态客户端加载及 webpack 回调次数均需升级复核。
- Sentry 继续使用原 `@sentry/nextjs` 与官方构建插件；不自行重建 SDK 配置 schema 或默认集成列表。

## 构建与发布边界

- 仅 tsgw preview CI 注入 SENTRY_RELEASE / CAT_DEFER_UPLOAD=1；离线构建保持 Debug ID 与 server source-map/client hidden-source-map，不拿上传 token，不访问 CAT。
- 构建原件 S3 归档成功后再删 map、打包发布；独立 cat-upload job 使用归档原件，失败不能静默成功，也不阻塞已完成归档的 publish job。
- 不设置 CAT_DEFER_UPLOAD 时保持本地/token/标签行为：无 token 不生成上传 map，显式本地 token 保留同步上传及失败抛错；标签不自动启用 preview 归档。
- 补传规则以 [BUILD.md](BUILD.md) 为准；不改网络路由、并发、分片、超时、认证或权限。

## 验证

```bash
node --experimental-strip-types --test tsgw/cat-monitoring/*.test.mjs lib/agent-client.test.mjs lib/agent-event-connection.test.mjs lib/agent-event-stream.test.mjs lib/rpc-manager.test.mjs
node_modules/.bin/tsc --noEmit --incremental false
node_modules/.bin/eslint tsgw/cat-monitoring next.config.ts instrumentation-client.ts sentry.server.config.ts app/global-error.tsx app/api/cat-config/route.ts lib/agent-client.ts lib/agent-client.test.mjs lib/agent-event-connection.ts lib/agent-event-connection.test.mjs lib/agent-event-stream.ts 'app/api/agent/[id]/route.ts' app/api/agent/new/route.ts
node tsgw/cat-monitoring/e2e.mjs
```

- `cat-startup-events.integration.test.mjs` 使用真实 Pi SDK、wrapper 与内存 Sentry capture，验证 constructor 启动通知可用、初始 hook 错误只采一次、重播无额外事件，以及真实 route catch 的 CAT status 与最终 HTTP status 一致；不发真实遥测。
- 最后一条为独占工作树的可选浏览器回归，默认拦截 envelope，不证明服务端入库或 symbolication；`E2E_SERVER_MODE=start` 仅用于已有干净生产构建的隔离目录。`CAT_E2E_LIVE=1` 会真实发事件，必须另获授权并回读 CAT 确认；CAT 升级期间不得运行，也不增加永久测试路由。
- 目录归集的既有验证记录：模块及真实宿主/RPC 定向 103 项全部通过；完整 tsc、定向 ESLint、git diff --check 通过。LSP 12 文件未报诊断，但仅 2 个确认 clean，其余超时或 push-only，不能声称全部 LSP clean。
- 首轮测试暴露同名 .mjs/.ts 的 Jiti 解析冲突，意外执行一次默认拦截模式浏览器回归并通过，未启用 live；已将浏览器脚本改为 e2e.mjs，后续 103 项重跑无此副作用。
- 主动 LSP 不确认 clean 时用完整 tsc 补充；lib/rpc-manager.ts 仅改一行 import，其既有 Reflect.get / 类型断言等静态规则问题不属于目录归集授权，不通过改业务实现规避。
- 禁止在开发工作树执行 `next build`。构建、提交、推送、依赖调整及真实遥测实发均需对应授权，不覆盖并行模块改动。
