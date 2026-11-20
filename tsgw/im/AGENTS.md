# IM 模块协作规则

## 范围与契约

当前接入微信 iLink 主人私聊，支持扫码、文本与图片/文件双向、语音转写和 inline 引用。用户操作见 [README.md](README.md)，会话及投递契约见 [DESIGN.md](DESIGN.md)。保留 Telegram 旧配置的兼容读取，运行时与设置页仅启用微信。

- 浏览器公共入口 `index.ts` 导出设置面板及类型。Node 入口 `server.ts` 提供初始化、管理 API 和工具接入。主体、样式和测试位于本目录。
- 机器人绑定项目，`[botId, chatId, threadId]` 为既有持久绑定键。微信只接受扫码绑定主人。绑定选择、按聊天串行提交、重放去重、取消及管理命令由 IM 管理。对普通会话的筛选复用 [session-management](../session-management/AGENTS.md)，排除侧聊、子代理，保留普通 fork。
- `pi-host.ts` 复用 `startRpcSession`，并通过 [session-management](../session-management/AGENTS.md) 共用 wrapper 的通知受理和 MCP 准备。在 admission 内调用 SDK `sendCustomMessage`，直接将忙碌会话的通知提交为 `followUp`。IM 队列只等提交，SDK 空闲路径返回的整轮 promise 用于反馈提交/运行异常，回复内容只能由 `im_send` 投递。按现有 SDK 语义，纯通知的新会话从第一条 assistant 消息开始落盘。
- `notification.ts` 使用 SDK 原生 `custom_message`，将两句 [回复技能](skills/tsgw-im-reply/SKILL.md) 与正文、媒体和句柄一同交给模型。真实路由位于通知 `details`，通过同一会话当前分支的 SDK 历史解析，凭据由微信驱动单独持有。普通会话注册 `im_send`，Chat-only 仅在最近一次用户输入或原生通知为有效微信通知时临时增加回复能力，侧聊和子代理不注册。升级时验证这两种模式、独立唤醒、Web 普通消息及动态工具。
- `/stop` 跳过 IM 队列，取消本聊天的下载、建立绑定和未提交输入，再复用原 wrapper 停止、清除 Pi 队列。停用机器人只撤销 IM 接入与投递。管理操作及扫码凭据提交共用 `ImService` 顺序队列，平台扫码轮询独立。切换项目清除旧关联。
- 微信驱动持有协议配置、重连和 checkpoint。平台媒体下载由 `onMessage(message, prepare?)` 交给 IM 聊天队列以保持轮询可响应；准备失败提示用户，图片保留原始字节，回复媒体为 `im_send` 的显式参数。Web 复用原生通知展示和既有精确文件引用访问。输入状态覆盖 IM 通知准备和提交，票据内存保留、每 5 秒续显，取消使用独立时限，失败按安全阶段上报。
- `im_send` 将明确的机器人名称或 ID 解析到当前项目的微信绑定主人。句柄回复额外验证原通知会话和原收件人。工具分项报告发送结果，遇到首次失败停止发送剩余项，驱动对结果未知的发送不自动重试。连接状态和 `deliveryError` 独立，成功发送会清除后者。
- 凭据、轮询游标、去重和关联存于 agent 目录 `integrations/im/state.json`，权限 `0600`，单进程持有；读取失败不得覆盖原数据。重启恢复连接和绑定。会话历史中的句柄由 SDK 持久化，复制后的会话 ID 不具有相同的回复权限。
- CAT 错误按实际阶段上报，沿用 [telemetry.ts](telemetry.ts) 的原生独立 scope 和 [credential-fetch.ts](credential-fetch.ts) 的 SDK 采集抑制。正文、Token、context token、二维码授权票据及 raw provider errors 不进入遥测。正常取消、长轮询超时、二维码过期及管理校验 4xx 保持静默。升级时核验真实 SDK envelope 及普通 HTTP 采集对照。

## 模块外接入清单

| 文件 / 接入点 | 原因与升级核验 |
| --- | --- |
| `lib/rpc-manager.ts` → `startRpcSession()` | 普通会话注册发送扩展，Chat-only 安装 IM 回复的请求内工具，侧聊和子代理按原设置。复用现有自定义消息受理与 wrapper 生命周期。 |
| `lib/message-display.ts` → `isMessageGroupAnchor()` | 将 IM 原生通知作为独立轮次锚点，包括新会话第一条消息。复用通用通知组件。 |
| `instrumentation-node.ts` → `registerNodeInstrumentation()` | 异步恢复已启用的微信机器人。模块管理退出停机。 |
| `app/api/tsgw/im/route.ts` → GET/POST | 薄代理，沿用原 proxy 的 Web 认证及 Host/Origin 校验。 |
| `components/SettingsPanel.tsx`、`lib/settings-navigation.ts` | 设置入口、栏目图标和 `im` 导航值。未选中时卸载面板并停止页面轮询。 |
| `package.json`、`package-lock.json` | 本地二维码依赖与发布的技能、操作说明及许可。打包须包含 `tsgw/im/skills/tsgw-im-reply/SKILL.md`。 |
| `tsgw/AGENTS.md` | 模块索引。 |

## 验证

```sh
node --experimental-strip-types --test tsgw/im/*.test.mjs
node_modules/.bin/tsc --noEmit --incremental false
npm run lint
npm test
IM_E2E_URL=http://127.0.0.1:30141 node tsgw/im/e2e.mjs
```

改动 TS/TSX 使用主动 LSP 诊断。测试覆盖已有及新绑定、原生通知和工具调用、旧数据兼容、协议收发、媒体、取消及遥测。运行浏览器测试时复用健康开发服务，或者用临时 agent 目录启动；禁止 `next build`。模拟测试与手机扫码收发分开验收。提交、发布、部署及真实机器人连接需要对应授权。
