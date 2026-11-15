# Wakeups：一次性会话唤醒模块

## 公共入口与范围

- 浏览器经 `@/tsgw/wakeups` 的 `index.ts` 使用 `WakeupPanelTrigger` 和纯数据类型。
- Node 宿主经 `@/tsgw/wakeups/server` 使用工具注册、会话 owner 适配、进程 runtime、原始事件 observer 及只读查询。不得从浏览器导入该入口。
- 模块内部和集成测试可直接引用实现文件。技能使用 `skills/tsgw-session-wakeup/SKILL.md` 专用资源路径。
- 设计取舍与验收标准见 [综合设计与验收](../../docs/tsgw-wakeups-design.md)，工具调用指导见[技能](skills/tsgw-session-wakeup/SKILL.md)。

支持自身及跨普通会话的一次性唤醒、按现有项目目录创建普通目标、pending 持久化与启动恢复、投递与消费事实查询及只读界面。拒绝子代理目标；普通 fork 和侧聊不是子代理。只传交接消息，不复制来源上下文、凭据、工具选择或授权。不实现周期任务、自动重试、数据库、独立调度服务、新建项目目录或业务完成回执。

## 文件与职责

| 文件 | 职责 |
| --- | --- |
| `extension.ts` | 注册五工具、参数及返回 schema；扩展贡献内置技能。Pi 1.5.2 的 `Type` 直接取自 `typebox`。 |
| `scheduler.ts` | 进程内计时器，长等待分段、单次触发及取消；不是恢复数据源。 |
| `types.ts`、`runtime.ts` | 任务、健康与观察契约；创建、取消、claim、投递、证据提交及恢复。 |
| `store.ts`、`ownership.ts` | 版本化 JSON 入口校验、原子保存、单一调度所有权及失锁处理。 |
| `host.ts`、`session-owner.ts` | SDK 接受边界、严格重开、现有 wrapper owner／admission；不得另建会话注册表。 |
| `observer.ts` | 原始 SDK 通知和 `agent_settled` 关联，运行 ID 跨重试保留，真实 entry／分支证据。 |
| `new-session.ts` | 轻量创建普通空会话并更新现有路径／列表／文件访问缓存。 |
| `history.ts`、`reconcile.ts` | 只读历史聚合、完整通知补证；不迁移源 JSONL。 |
| `query.ts`、`server-query.ts` | 工具和 API 共用过滤、分页、详情、健康及实际 `armed` 投影；读取不初始化 runtime。 |
| `ui.tsx`、`ui-view.ts`、`ui.module.css` | 当前会话相关任务入口、只读弹窗、按需详情、三语与移动端样式。 |
| `*.test.mjs` | 临时目录、真实 SDK／wrapper、本地 faux provider、隔离 Chromium；基准另行显式运行。 |

## 运行契约

### 持久化、失败与所有权

- 权威清单固定为 `getAgentDir()/integrations/wakeups/state.json`，格式 `{ version: 1, tasks: [...] }`。目录 0700、文件 0600，复用现有原子替换；同步提交之间没有 await。文件缺失表示尚未使用，未知版本／损坏不能清空或覆盖。
- 创建先验证输入和目标，保存 pending，再挂 timer。取消先保存 cancelled，再移除 timer；到点已取得 pending 后拒绝取消。取消不终止模型、不撤回队列。
- 发送前保存 dispatching；写失败不发送。接受后保存 submitted；received／settled 证据可先于接受返回，后来的 submitted 不得使状态倒退。
- 状态写失败进入 `storage_error`，移除所有未触发 timer、中止尚未发送的准备、拒绝新调度／取消。不自动重试写入。查询保留磁盘最后可靠状态及健康；新观察仅以 `unsaved` 在本进程展示。修复存储后须重新初始化所有者并读盘。
- 状态保存成功但会话审计失败不撤销安排或取消，返回成功及 `diagnostics`。新会话已创建但 pending 未保存，以 `isError` 和 `session_created_wakeup_not_scheduled`、`scheduled: false`、`targetSessionId` 报告部分生效。cancelled 未保存则 `cancellationConfirmed: false`，不能声称取消。
- 首版保留终态和交接正文，不自动清理。分页只缩小响应，不减少整文件写入成本。设计日常规模约 1000 条／8 MiB、保存 p95 目标 100 ms；10000 条／64 MiB 只测退化，不承诺容量。容量导致写失败仍执行暂停规则。
- `proper-lockfile` 锁独立 `owner` 目录，不锁被替换的 JSON inode；stale 10 秒、update 5 秒、启动原生重试最多 30 秒。获取锁后重新读状态；存活 owner 导致本实例转 `read_only`，不自动持续抢锁。查询不等待取锁，可在 `starting` 期间只读磁盘。
- `onCompromised` 自定义处理，失锁不使整站退出。失锁立即暂停、禁写、停止新的实际发送；准备结束、调用发送前、状态提交前复核所有权。已进入 SDK 的动作无法撤回，旧实例只能保留未保存观察，不覆盖新 owner。
- 正常退出停止调度并释放锁。同进程通过 `Symbol.for("pi-web.wakeupRuntime")` 跨 Next HMR 复用；会话回收、关闭浏览器或扩展重载不取消未来任务。
- 单所有者仅保护参与该协议的 wakeup 清单；不解决多进程同时续写同一会话，也不保证跨进程恰好执行一次。

### 服务启动恢复

Node instrumentation 主动初始化，不依赖浏览器或先打开会话。恢复只依据新清单：

| 保存状态 | 动作 |
| --- | --- |
| pending，未来到期 | 按原时间挂 timer。 |
| pending，停机期间到期 | 补投一次，保留原时间并记录恢复事实。 |
| dispatching／submitted／received，缺终结证据 | 针对原目标只读核对通知，保留已收到证据，状态待核实，不重投。 |
| cancelled／delivery_failed／run_settled／run_aborted | 不恢复发送。 |
| 旧版会话审计 created | 不重放、不补造任务。 |

dispatching 保存后、实际发送前退出可能一次也未发出，但仍不自动重投；这是已批准的保守取舍。旧 pending 的真实升级交接及服务重启另行授权，不在代码测试中操作。

### 目标、写入与投递

- 默认当前会话；`session_id` 指现有持久化普通会话；`cwd` 与之互斥，立即创建该现存项目内的新普通目标，可选 `title`。含 `pi-web:subagent` metadata 的目标拒绝；不凭 `parentSession` 判断子代理。
- 新目标使用 SDK header／entries，以 `wx`、0600 显式落盘；SDK `create()` 不自动保存空会话。显式保存后丢弃原 manager，后续 owner 必须重开，不能保留未 flushed 的 manager。
- 创建不启动 wrapper、加载扩展或初始化模型；无来源 parent／fork、工具 pin 或模型快照。首次启动才按目标 cwd 的现有默认配置、规则、技能和 trust 约束加载；用户提前打开也可能提前启动。取消后保留会话，不自动删除。
- meta 追加在目标当前 leaf，保留 `sourceSessionId`。活动 wrapper 使用其 manager；等待已有启动／关闭后重查；没有 owner 才同步打开追加，检查到写盘之间无 await。非活动目标的有意写入可发生 SDK 自身迁移，只读路径不允许。
- 重开使用 `requireExistingSession: true`，实际 open 前同步核对头 ID；目标已删、变成子代理、cwd 消失时失败，不创建替代文件。
- `beginCustomMessageSubmission()` 同步计入现有 pending／mutation；在 admission 内用 `prepareMcpForRun(signal)` 等扩展绑定、延迟模型切换和 MCP，沿用 Stop。不能先在 admission 外等 ready，也不能持有 admission 等整轮或 `isRunning()`。
- streaming 时 followUp 可在 shell 旁排队；新开轮时等待压缩及 `shellRunning`，包括尚未结束的 `user_bash` hook。MCP 结束后再复查；Stop、失锁或销毁后的异步准备不得继续发送。
- 用 `sendCustomMessage(..., { deliverAs: "followUp", triggerTurn: true })`；通知 `message_start` 匹配或 send Promise 返回即确认接受。SDK 空闲 Promise 等整轮、忙时只等排队，宿主不能等待空闲整轮才确认接受。
- 通知是进入模型上下文的 `pi-web:wakeup-notification` custom message，说明系统来源、不增加权限，保留独立 turn anchor。未来 timer 不计活跃子代理，不阻止当前轮完成通知。

### 消费、历史与只读查询

- 状态区分 pending、dispatching、submitted、received、run_settled、run_aborted、delivery_failed、cancelled、unknown。submitted 只表示接受／排队；received 只表示通知被观察；settled 只表示所在运行终结，不代表业务成功、每条要求完成或子代理全部结束。
- observer 在服务器订阅原始 SDK 事件，按 `details.wakeupId` 和 `targetSessionId` 识别。运行 ID 从首次 agent_start／通知收到延续到 agent_settled，跨 retry／compaction／扩展续发保留。多条 wakeup 可共享运行，不能将最终错误归为每条任务失败。
- SDK `clearQueue()` 不返回 custom 通知 ID，且已出队通知可能尚未 message_start。Stop／Recall 只能记不确定；不得推断逐条 queue_cleared。后来的 received／settled 可以补证。观察器销毁释放跟踪并对未终结观察记 unknown。
- 会话审计仍是 `customType: "pi-web:wakeup"`、`version: 1`，不进入模型上下文；保留旧字段和事件，新增 received／run_settled／run_aborted／unknown。聚合依据证据强度及同级追加顺序，迟到 submitted 不覆盖更强事实；不以 recordedAt 重排。
- 历史读取全部分支；`active` 仅反映本实例实际 timer。fork 继承保留原 targetSessionId，不替 fork 创造任务。旧记录 inactive 不证明成功、失败或取消。
- `history.ts`／`reconcile.ts` 只读 JSONL，不使用会迁移文件的 `SessionManager.open()`，bytes／mtime 不变。只按 LF 分行，保留 JSON 字符串里的 U+2028／U+2029；先识别类型跳过大普通消息，不引入自定义 JSON 解析器。
- 重启补证仅认头 ID 和原目标的完整通知；缺证据不推断模型开始、逐条清队列或运行终结。
- `schedule_wakeup`、`list_wakeups`、`cancel_wakeup`、`query_wakeups` 默认 `exposure: "codemode"`；`list_session_wakeups` 仍直接暴露。上游侧聊工具 allow-list 排除全部五工具；其他普通会话仍可向已有侧聊投递。
- `list_wakeups({})` 保留含必需 message 的数组，只列本实例实际 armed timer。主查询 `query_wakeups`／两个 GET API 返回 `{ items, nextCursor, health }`，支持来源、目标、会话、cwd、状态、ID 及分页；工具无过滤默认当前会话相关。
- 普通列表只含摘要，指定 wakeupId 才取完整正文；每项含实际 armed，health 区分 ready／starting／read_only／paused／storage_error。查询不取锁、不启动 wrapper、不开 SSE、不发送模型消息、不延长租期。
- 响应入口复用宿主 `handleSelectSession(session, false, entryId)` 搜索定位；深层历史或其他分支沿用上游打开会话的回退，不新增 URL 协议或改写上游定位范围。
- UI 在有相关记录或健康异常时显示紧凑入口；手机顶栏使用固定宽度图标并保留完整可访问名称，避免挤出已有操作。挂载及现有 refreshKey 变化读一次，关闭面板不轮询；打开且页面可见时每 2.5 秒刷新。详情按需取，保留分页位置、请求取消、Escape／遮罩关闭与焦点恢复。仅只读，不加新建、取消、重投或独立大盘。

### 技能资源

技能由 `resources_discover` 贡献，初始提示词只广告，正文按需读取或 `/skill:tsgw-session-wakeup` 展开。路径跟随安装包根 cwd；不复制用户技能目录、不新增全局配置、不改 Settings／slash 独立列表。不因无关工具缺失阻断；本次所需工具不可用则报告，不安装或换服务兜底。工具存在不等于操作获授权。

## 模块外接入清单

以下为相对接入前 `tsgw` 基线 `b056cb2` 的完整必要接线，升级时同步检查：

| 文件 | 函数或位置 | 必要性 |
| --- | --- | --- |
| `lib/rpc-manager.ts` | Node imports、`initializeWakeups()`、普通分支 extensionFactories | 注入现有 getRpcSession／严格 startRpcSession／启动关闭等待，注册工具，供服务启动复用。子代理及 Chat-only 不注册工具。 |
| `lib/rpc-manager.ts` | `AgentSessionWrapper.start()`、unsubscribe、abort／clear_queue | 原始 SDK observer、释放观察器、Stop／Recall 标记不确定并中止未发送准备。 |
| `lib/rpc-manager.ts` | `RpcSessionStartOptions.requireExistingSession`、实际 open 前 | 仅定时严格重开核对文件与 ID，禁止删除目标被 SDK 重建；其他调用默认行为不变。 |
| `lib/rpc-manager.ts` | `acquirePromptAdmission()`、`shellRunning`、`beginCustomMessageSubmission()` | 必要 admission／shell getter／提交计数接入，复用 idle、完成与 extension shutdown；不另建投递锁。 |
| `instrumentation-node.ts` | `registerNodeInstrumentation()` | Node 服务启动异步初始化恢复，不依赖浏览器；错误报告日志，不改 CAT 初始化。 |
| `app/api/tsgw/wakeups/route.ts`、`[wakeupId]/route.ts` | GET | 薄只读 API，统一查询投影，禁缓存，非法过滤返回 400。 |
| `components/AppShell.tsx` | import、当前会话顶栏 | 仅挂载模块入口；不在上游文件实现面板和调度。 |
| `lib/message-display.ts` | `isMessageGroupAnchor()` | 保留可见 wakeup 通知的独立锚点；截断、错误、缺少结束原因时仍另起轮次，上游扩展锚点不变。 |
| `package.json` | 原有 test／files | 发现 `tsgw/**/*.test.mjs`，随包包含技能资源；本轮无依赖或包配置改动。 |
| `AGENTS.md`、`tsgw/AGENTS.md`、`docs/agents/tools.md` | 模块索引 | 行为、专用入口及技能的薄索引；不复制实现。 |
| `docs/tsgw-wakeups-design.md` | 综合设计与验收 | 按用户要求集中保存方案，模块规则只保留引用。 |

首次实现曾改写重命名以复用 owner，隔离整理时已恢复原 `renameRpcSession()` 并移除 `withRpcSessionOwner`。本轮仍不改重命名、原消息分组测试或其他 fork 模块。

## 依赖但未修改的接口与升级复核

1. `lib/session-reader.ts` 的路径、头、列表及 manager 缓存，`lib/allowed-roots.ts` 的文件访问根；新会话只调用现有 helper。
2. `lib/subagents.ts` 的 metadata 类型；普通 fork／side 不能误拒绝。严格重开仍须在实际 open 前；上游侧聊工具限制与静默完成保持完整。
3. SDK 普通用户消息不支持任意 meta；custom entry 不进上下文，custom message 进入。不得混淆或改公共扩展 API／SDK 私有字段。
4. wrapper owner、启动／关闭、admission、MCP／Stop／压缩／shell 时序变化时复核宿主适配；不解决多进程同会话写入。
5. SDK 通知接受边界、agent_settled、重试／compaction、entry 落盘时机、clearQueue 无 custom ID 以及消息对象／entry 关联变化，必须重新跑真实 SDK 回归。
6. 上游通知锚点只在部分结束原因后推断，不能代替 wakeup 独立 anchor。未来 timer 不改变 subagentsActive 和完成语义。
7. codemode exposure、显式激活与恢复工具集、资源发现／重载和 launcher 包根 cwd；不修改全局工具配置。npm `files` 继续包含技能，打包迁移回归通过。
8. Node instrumentation、信号和 HMR 复用、proper-lockfile stale／update、原子保存方式变化时复核恢复及失锁边界；不能把锁描述为恰好一次。

## 验证

```bash
node --experimental-strip-types --test "tsgw/wakeups/*.test.mjs" lib/rpc-manager-side.integration.test.mjs app/api/sessions/rename-route.test.mjs lib/message-display.test.mjs
node_modules/.bin/tsc --noEmit --incremental false
npm run lint
npm test
git diff --check
# 显式基准；默认测试不执行耗时规模测量
WAKEUP_STORE_BENCHMARK=1 node --experimental-strip-types --test tsgw/wakeups/store.performance.test.mjs
```

验收包括持久化各写入点故障／取消／未知不重投、目标删除不重建、锁竞争／崩溃接管／失锁旧回调、真实 SDK 按项目创建与恢复／通知与运行 entry 关联、忙时 Stop、普通 follow-up 混排、重试与压缩、多 wakeup 共轮、子代理拒绝和侧聊限制、旧数组及结构化部分生效兼容、API 只读／分页／损坏清单、技能发现／打包迁移、三语移动端／键盘与原有重命名／分组回归。

测试只用临时 agentDir、项目、本地 faux provider 和隔离浏览器。禁止真实模型请求、真实用户任务／配置修改或开发工作树 `next build`。技能不写措辞／示例数量策略测试。执行结果留在任务回报，不累积历史流水。真实升级、迁移、重启、发布仍须单独授权。
