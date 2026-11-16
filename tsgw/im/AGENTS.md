# IM 模块协作规则

## 范围与契约

首期支持微信 iLink 扫码、Telegram Bot API 长轮询、文字私聊、Telegram 群聊/Topic、项目内 Pi 会话关联、停止和重启恢复。操作说明与已知限制见 [README.md](README.md)，适配来源及许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

主体、样式和测试在本目录。浏览器公共入口为 `index.ts`（设置面板、来源角标与类型），Node 初始化和路由入口为 `server.ts`；会话来源的纯数据入口为 `message-data.ts`，宿主事件接入为 `message-source.ts`。客户端通过 `@/tsgw/im` 引用；Node 会话读写代码以相对路径引用这些公共入口，兼容现有不带 Next alias 的 Jiti/SDK 测试。浏览器入口不能导出 Node 模块。

- 机器人绑定项目目录；`[botId, chatId, threadId]` 为持久关联键。只恢复已关联会话；没有有效关联时新建，不猜测最近会话。不同聊天不能自动合并。
- Pi 宿主复用 `startRpcSession`、wrapper.send/onEvent 和 session-reader，不另建 SDK 会话管理器，不独立打开活跃会话文件。会话清单只读，排除子代理与侧聊，保留项目中的普通 fork。
- 等待 Web 当前任务结束再提交 IM。每次提交带唯一入站标记，订阅先于提交；仅返回归属明确的最终 assistant 文本，子代理仍活跃时继续等待。扩展移除标记或其他 Web 输入混入时提示用户查看 Web，不发送混合内容。
- 每次已接收的 IM 用户消息写入 `pi-web:im-source` custom entry，`version: 1`、`messageEntryId` 与 `source` 记录本次 requestId、channel、botId/botName、chatId/threadId、senderId 和平台 messageId；不写平台凭据，不进入模型上下文，不把整条会话标成某渠道。实时及历史只为对应 user 消息投影 `imSource`，移除本模块内部请求前缀；原 SDK 消息对象保持不变。
- SDK 当前先广播 `message_end` 再同步 appendMessage；宿主订阅安排微任务，在同一 manager 的真实 user entry 写入后追加 Meta。升级 SDK 必须用真实 wrapper 集成测试核对顺序、entryId 关联及原生消息对象。历史先从完整 entries 建索引，再分页；fork 保留原消息来源，新 Web 输入不会继承来源。
- Web 显示整个会话，微信/Telegram 角标只说明输入来源。任务仅回复发起它的原聊天/Topic；共享会话不广播 Web 输入、Web 回复或其他渠道的回复。持久 Meta 不代表恢复未完成投递或重启补发。
- `/stop` 绕过消息队列，取消本聊天当前等待、建会话和待提交输入，再通过原 wrapper 停止关联任务；后续新消息仍可接收。停用、换项目或删除机器人必须取消旧作用域，异步建会话结束后及关联写入回调内均核验取消状态。
- 管理操作与扫码凭据提交共用 `ImService` 的顺序队列；平台扫码轮询不占管理队列。关闭服务先取消生命周期和扫码，再排空管理操作、停止驱动，不能留下晚到重启。
- Telegram 必须先过滤允许用户，允许聊天名单可进一步收紧；群聊只响应明确指向本机器人的消息。微信只接受扫码返回的 `ownerUserId`。
- 凭据、轮询游标、去重记录和关联写入 agent 目录的 `integrations/im/state.json`，权限 `0600`；单进程持有，不支持多实例共用同一文件。API 返回状态与关联，不返回凭据或 checkpoint。损坏文件不得被默认空配置覆盖。
- 禁止将 Token、微信 context token、二维码授权票据写入日志、错误或 CAT。`credential-fetch.ts` 仅对本模块凭据请求调用 SDK 原生 `suppressTracing`；当前 Sentry 11.9 的 NodeFetch 同时跳过此请求的 breadcrumbs，不修改全局采集策略。升级时必须用真实 SDK envelope 回归确认，不能仅检查自定义错误文本。
- 遥测猫通过 `telemetry.ts` 复用 CAT 公共 capture：上报连接/接收入站、任务处理、回复发送、初始化、扫码失败以及设置页网络/JSON 故障；正常停止/取消（含从 Web 停止共享任务的 AbortError）、微信长轮询超时、二维码过期及管理校验 4xx 不报。初始化失败由 service 创建边界上报，GET 不重复捕获同一失败；其他 GET 读取故障和 POST 文件系统故障单独上报（保留原有 HTTP 响应）。任务/发送只报告失败阶段，不附加外部原始异常或聊天正文；接收错误使用驱动已生成的安全状态提示。
- IM 后台任务可能继承包含 Token 的管理请求上下文。每条服务端 IM 错误使用 Sentry 原生独立 current/isolation scope，复用现有 client 和 `initialScope`（保留 instance / release），标注 `source=im`、`operation`、可选 `channel` / `botId`；不继承请求、聊天上下文和 breadcrumbs，不修改全局 CAT 默认采集、过滤或限流。浏览器沿用 CAT 的标准 scope，仅传固定错误及阶段标签，不附加 action 或响应正文；包括纯文本 401/429 在内的 4xx 不因 JSON 解析失败而上报。连接重试的每次实际失败各自上报，交给遥测猫按异常分组；不另建故障状态或限流器。
- 长轮询、发送及等待都支持取消；游标只在 runtime 接收入站后推进。发送结果未知时不自动重试；重启恢复连接与关联，不自动重放已经接收的任务。

## 主体文件

- `types.ts`、`actions.ts`：平台与宿主接口、管理请求入口校验。
- `store.ts`、`runtime.ts`、`service.ts`：文件持久化、消息路由与取消、管理与扫码生命周期。
- `pi-host.ts`、`pi-host-run.ts`、`host-types.ts`：既有 wrapper 的会话清单、创建/恢复、顺序提交与回答归属。
- `message-data.ts`、`message-source.ts`：具体用户消息的来源记录、历史校验/索引、Web 投影及宿主 manager 的临时请求注册。
- `ImSourceBadge.tsx` 与来源角标样式：微信/Telegram 的用户消息角标，普通 Web 消息无角标。
- `telegram.ts`：身份核验、授权与群聊路由、长轮询与分段发送。
- `weixin-login.ts`、`weixin-transport.ts`、`weixin.ts`：扫码状态机、平台传输、主人过滤及 context/cursor 持久化。`weixin-transport.ts` 保留 uint64 JSON 整数精度。
- `ImSettings.tsx`、`ImBotDetail.tsx`、`useImSettings.ts`、`im-ui.ts`、`im-settings.module.css`：设置、扫码取消和会话关联。沿用 SettingsUi 与 DirectoryPicker，使用原有手机导航上下文。
- `telemetry.ts`、`telemetry.test.mjs`：IM 专属错误上报 scope 和真实 SDK 内存 envelope 回归，含默认请求采集阴性对照及正常取消/超时不报。
- `*.test.mjs`、`e2e.mjs`、`source-e2e.mjs`：协议、路由、并发与取消、真实 wrapper/fork、真实 Sentry 内存 transport 回归，以及设置和消息角标界面流程。

## 模块外接入清单

| 文件 / 接入点 | 原因与升级核验 |
| --- | --- |
| `lib/rpc-manager.ts` 的 `AgentSessionWrapper.start()`、`fork`、`fork_branch`、`clone` | 发出 Web 事件前投影 IM 来源，安排同一 manager 追加 Meta；各复制入口补齐被保留用户消息的来源，含来源 Meta 位于另一分支的共享祖先。保留原 SDK/扩展对象及 notices、subagents、队列、计时与 fork 语义。 |
| `lib/session-fork.ts` 的 `forkSessionBranch()` | 离线复制同样补齐被保留用户消息的来源，含恰好截止在 user entry 的分支；原文件字节/mtime 不变，excludeLeaf 不带被排除消息的来源。 |
| `lib/session-reader.ts` 的 `buildSessionContext()` | 从完整条目索引来源后按 user entryId 投影，保持分页、entryIds、分支和普通消息行为；只读路径不写文件。 |
| `lib/types.ts` 的 `UserMessage.imSource` | 可选来源数据，普通 Web/assistant 消息维持原有角色和结构。 |
| `components/MessageView.tsx` 的 `UserMessageView()` | 只挂来源角标；正文、复制、编辑和分支仍使用原有展示投影。 |
| `components/MessageView.test.mjs` 的 Node loader | 沿用仓库 CSS module 的 SSR 测试处理，让新增角标和聚合入口的样式不阻断原有消息回归；实际样式另用浏览器验证。 |
| `instrumentation-node.ts` 的 `registerNodeInstrumentation()` | 异步导入 Node 入口，启动恢复已启用机器人；不阻塞原有启动与 SDK 预热。退出监听在本模块注册，沿用原 SSE 关闭逻辑。 |
| `app/api/tsgw/im/route.ts` 的 GET/POST | Node 薄路由代理本模块 handler，保留原 proxy 的 Web 认证、Host/Origin 边界；GET 不落盘，JSON 解析错误不回显正文。 |
| `components/SettingsPanel.tsx` 的 `SettingsSectionIcon()`、`SettingsPanel()` | 栏目、图标与面板接线；未选中时卸载 IM，终止页面轮询。保留原手机详情导航及各上游设置功能。宿主已超过 500 行，只保留必要接线，不在此实现业务。 |
| `lib/settings-navigation.ts` 的 `SETTINGS_SECTION_VALUES` | 加入 `im`，无需已选项目即可管理全局机器人；创建时仍校验实际项目目录。 |
| `package.json`、`package-lock.json` | 固定 `qrcode` 1.5.4 与 `@types/qrcode` 1.5.6；二维码在本机生成。发布清单包含模块 README 与第三方许可。 |
| `tsgw/AGENTS.md` 的公共入口索引 | 模块规则、客户端/Node 入口和操作说明索引。 |

## 验收

```sh
node --experimental-strip-types --test tsgw/im/*.test.mjs
node_modules/.bin/tsc --noEmit --incremental false
npm run lint
npm test
IM_E2E_URL=http://127.0.0.1:30141 node tsgw/im/e2e.mjs
# 与该服务 PI_CODING_AGENT_DIR 相同的临时目录，脚本会创建独立会话夹具。
IM_E2E_AGENT_DIR=<临时agent目录> IM_E2E_URL=http://127.0.0.1:30141 node tsgw/im/source-e2e.mjs
```

按职责拆分，源文件不超过 500 行；改动 TS/TSX 需主动 LSP 检查。全量测试在 root 的 DAC override/read-search capabilities 下存在原有权限用例差异，必要时只对测试进程按既有方式撤去 capabilities，不跳过用例。

协议使用模拟 HTTP；Pi 宿主集成使用真实 wrapper 和本地模型服务；遥测回归仅使用内存 transport，必须保留未抑制请求可复现泄漏的负对照，以及普通 HTTP breadcrumbs 仍存在的正例。浏览器使用临时 agent 目录，拦截全部 IM 管理操作与 CAT 初始化请求，不新增真实机器人。

先检查并复用健康开发服务，禁止在开发工作树运行 `next build`。模拟测试不代表真实微信扫码、Telegram 收发或生产包验收；真实账号需用户完成扫码/Token 配置后再联调。提交、发布、部署及连接真实机器人需对应授权。
