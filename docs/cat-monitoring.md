# CAT 错误收集（TSGW 自有功能）

本功能仅在 TSGW fork 维护，不提交上游。接入自建 Sentry `cat.tossp.com`；项目为 `sentry/tsgw-agent`，项目 ID 为 `10`。管理、DSN 查询和错误检索统一使用 `ts_tool → cat`。

## 范围

- 浏览器未捕获异常、React 渲染异常。
- 新建会话和发送命令时的网络失败、异常响应和服务端 5xx。
- SSE 意外断流、建连超时及启动失败；正常关闭和切换会话不报错。
- 服务端关键 API catch、模型请求错误、异步 prompt 和扩展错误。
- 保留原错误及其堆栈，并附带 source、session_id、operation、provider/model 等定位标签。

按自建实例需求，不实现自定义脱敏、离线缓存、限流、告警规则或管理界面；不启用录屏、日志、指标、性能追踪、Seer。SDK 自带的默认处理仍保留，可能携带请求上下文；不额外附加整段对话或工具结果。不改变原有重试、消息发送和会话管理。

## 运行时配置

部署服务的环境文件中设置，重启后生效（发布和部署需另行授权）：

```dotenv
SENTRY_DSN=<通过 ts_tool → cat 查询 sentry/tsgw-agent 的公开 DSN>
SENTRY_ENVIRONMENT=production
SENTRY_INSTANCE=hq-dev
```

未设置 `SENTRY_DSN` 时不初始化采集。`SENTRY_INSTANCE` 是可选的部署实例标签。Release 默认使用构建时的 npm 包版本 `tsgw-agent@<version>`，可用 `SENTRY_RELEASE` 覆盖（必须与上传源码映射的构建一致）。

发布物是预构建 npm 包，故不使用构建后无法修改的 `NEXT_PUBLIC_SENTRY_DSN`。浏览器在启动时读取 `/api/cat-config` 的公开 SDK 配置；该只读接口仍受原有 Host/Origin 校验，不需要登录。它不返回上传令牌或其他环境配置。配置读取失败不阻止页面启动；读取完成前发生的浏览器错误没有采集保证。

浏览器和服务端直接向 DSN 采集端点上报，MCP 不转发事件。完全断网时事件不保证保存或补报；SSE error 本身无法证明具体 DNS/TLS/代理根因。按要求不增加限流，持续断流时会随现有重连逐次上报（单浏览器可能约每秒一条），不改变原重连机制。

## 源码映射

`next.config.ts` 已接入官方构建插件。fork 发布工作流在构建步骤读取可选的 `SENTRY_AUTH_TOKEN` Secret，上传至自建实例的 `sentry/tsgw-agent`；可用 `SENTRY_URL`、`SENTRY_ORG`、`SENTRY_PROJECT` 覆盖目标。令牌仅在构建时使用，不进入浏览器配置。

没有上传令牌时跳过源码映射生成/上传，错误上报仍工作，但生产压缩代码的可读性受限。现有 npm files 规则排除 JS map。

## 验证入口

- `node --experimental-strip-types --test lib/cat-monitoring.test.mjs lib/agent-client.test.mjs lib/agent-event-connection.test.mjs hooks/cat-new-session.test.mjs`
- `node_modules/.bin/tsc --noEmit`、`npm run lint`、`npm test`
- `node e2e/cat-monitoring.mjs`；发布构建快照使用 `E2E_SERVER_MODE=start node e2e/cat-monitoring.mjs`。默认使用临时本地采集器，不接触实际业务数据或调用模型。只有显式设置 `CAT_E2E_DSN` 才发送真实测试事件，此时还须在 CAT 回读服务端事件。
- 独立构建快照验收 Webpack 发布产物；独立开发进程验收 Turbopack，不污染正在运行实例的 `.next`。
- 发送具名测试事件，并通过 `ts_tool → cat` 回读确认；不增加永久测试路由。

## 本次验收（2026-10-28）

- 类型检查、lint 和变更路径主动 LSP 检查通过；全量测试 2952 项通过、1 项原有跳过；发布相关测试 62 项通过。
- root 默认权限下的只读目录测试在原分支同样失败；撤去测试子进程的 `cap_dac_override`、`cap_dac_read_search` 后，全量通过，未跳过或修改该测试。
- Turbopack 开发模式已验证浏览器及服务端 SDK 真实 envelope；关闭 DSN 后不发送事件，业务 API 认证和配置接口的 Origin 校验保持有效。
- 未配置 DSN 构建的 Webpack 发布产物，在运行时设置 DSN 后成功上报。通过 `ts_tool → cat` 回读到浏览器和服务端两条测试事件：`instance:cat-e2e-1793179292182`，环境 `test`，release `tsgw-agent@0.1.0`；浏览器事件 ID 为 `ad20dbd6c5ca4665b29d55e71a22cfe1`。
- 本次验收未使用上传令牌，实际源码映射上传未验证；原生 iOS 16.2 设备未实测。新增客户端产物检查未发现 RegExp lookbehind 字面量或 class static block。
- 已完成独立打包、干净临时前缀安装和现有发布冒烟测试；安装后的 CLI、认证、登录页、原生终端及 SSE 均通过。另对实际安装包执行 CAT 回归，浏览器和服务端均成功发送 SDK envelope，运行时开关生效。
- 宿主重启后补充复核：相关测试及发布测试合计 89 项通过，类型检查、lint、diff 检查通过。独立只读审阅完成，无必须修复的阻塞项；首次带上传令牌的构建仍需单独验收源码映射上传结果。
- 上述验收不包含发布或部署；提交与合并状态以 Git 记录为准。
