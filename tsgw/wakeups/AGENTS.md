# Wakeups：一次性会话唤醒模块

## 公共入口

`index.ts` 统一导出宿主接入所需的 `createSessionOwnerAccess()`、`createWakeupExtension()` 和 `getWakeupRuntime()`，宿主通过 `@/tsgw/wakeups` 导入；模块内部可直接引用实现文件。`createWakeupHost()` 是宿主适配层内部及集成测试接口，不纳入公共聚合入口。内置技能保留 `skills/tsgw-session-wakeup/SKILL.md` 专用资源路径，不经 TypeScript 入口加载。维护规则、运行约束和验证入口统一在本文件；工具调用指导见该技能。

## 范围、入口与文件

只实现进程内存中的一次性定时唤醒：支持自身及跨普通会话交接，拒绝子代理；只传递交接消息，不共享来源上下文或增加授权。重启丢失、不恢复、不补发、不重试；不做周期任务、数据库、独立后台服务或新增界面。子代理只能由被唤醒的主代理通过已有机制恢复。

- Pi 1.5.2 不再从 `pi-ai` 导出 `Type`；`extension.ts` 与 `wakeup.integration.test.mjs` 直接从 `typebox` 导入，沿用上游 schema 包，不改变工具定义、owner 或 lifecycle。
- `extension.ts`：`createWakeupExtension()` 注册四个工具；`schedule_wakeup`、`list_wakeups`、`cancel_wakeup` 使用 SDK 的 `exposure: "codemode"`，默认不激活、不向模型直接声明，通过 codemode 调用。`list_session_wakeups` 保持直接暴露。仅调整本模块注册，不改全局 codemode 设置或强制激活它；沿用 SDK 显式激活工具及恢复会话工具集的语义。普通非 Chat-only 会话可用。上游侧聊的工具 allow-list 会排除这四工具，保持未注册、不可调用；这不构成侧聊作为投递目标的禁令。
- `skills/tsgw-session-wakeup/SKILL.md`：随宿主提供的调用指导。`extension.ts` 通过 SDK `resources_discover` 贡献技能，沿用现有扩展加载流程，不新增会话类型过滤。仅本次所需工具缺失、其声明不可读或 codemode 不可用时，技能要求报告具体错误并停止当前操作；不因无关工具缺失而阻断，也不降级、不安装、不改配置；工具存在不代表已获得操作授权。
- `skill.integration.test.mjs`：使用真实 SDK 验证技能发现、正文按需展开、重载不重复，以及隔离目录 npm 打包解压后的资源迁移；不执行技能示例、不约束示例数量或错误文案。侧聊用例另行验证技能仍可发现、工具 allow-list 不变。
- `scheduler.ts`：`WakeupScheduler` 保存进程内待触发项、单次触发及取消，长等待分段处理。
- `runtime.ts`：`WakeupRuntime` 校验入口参数、生成 SDK UUIDv7、协调历史与调度；`submitted` 只表示 SDK 接受或排队，不是模型任务完成。
- `history.ts`：`pi-web:wakeup` custom meta 的只读聚合；`pi-web:wakeup-notification` 是另行进入模型上下文的通知。查询全部分支，不迁移文件、不启动会话。
- `host.ts`：唯一的宿主适配层，提供 `createWakeupHost()`、进程级 `getWakeupRuntime()`；对接现有会话、文件及 SDK 投递。
- `session-owner.ts`：通过宿主注入的现有 wrapper、启动／关闭 Promise 协调写入；不持有另一个会话注册表或锁。
- `*.test.mjs`：单元测试及真实 SDK、SessionManager、AgentSessionWrapper 配合本地 faux provider 的集成测试。`side-session.integration.test.mjs` 使用真实 `createSideSession()`、`startRpcSession()`、宿主注册表和 `createWakeupHost()` 验证侧聊目标、严格重开、工具限制及静默完成；不修改上游运行时。

## 运行与维护约束

### 目标与生命周期

- 目标必须已有持久化会话文件；含 `pi-web:subagent` custom entry 的目标拒绝，普通 fork 的 `parentSession` 和侧聊的 `pi-web:side` 不构成拒绝依据。侧聊自身不能调用工具，但其他普通会话可以向已有侧聊投递；回收后严格重开仍保留上游工具限制和完成通知静默。
- 定时器由 `Map` 和 `setTimeout().unref()` 保存；宿主使用 `Symbol.for("pi-web.wakeupRuntime")` 在同一进程的 Next 热更新间复用 runtime。会话回收、关闭浏览器或重载扩展不取消定时器，服务进程重启则全部丢失。超过 Node 单次 timeout 上限（2,147,483,647 ms）的等待分段调度，不承诺精确触发时刻。
- 到点先移出待执行集合，再准备投递；此后即使目标尚在启动或压缩也不能取消。取消不终止模型或撤回队列；内存取消后写历史失败时明确说明已取消，不重新挂回。

### 写入与投递

- meta 写在目标会话当前 leaf，保留 `sourceSessionId`；仅写 meta 不启动目标 wrapper。活动 wrapper 使用其 manager；等待已有启动／关闭过程后重查，无 owner 才同步打开文件追加，检查与写盘之间不能插入 await。不复制注册表或锁，不支持两个 pi 进程同时续写同一文件。
- 非活动目标的有意追加使用 SDK manager，可能发生 SDK 自身迁移；只读历史查询不能走该路径。定时重开必须使用 `requireExistingSession: true`，在真正 open 前核对文件头 ID，目标已删时不新建替代文件。
- 投递使用 `sendCustomMessage(..., { deliverAs: "followUp", triggerTurn: true })`，在 admission 内经 wrapper 的 `prepareMcpForRun()` 统一等待扩展绑定（含延迟模型切换）并准备 MCP，复用其 Stop 行为；不能在外层先等 `waitUntilReady()`，否则 Stop 无法中断尚未完成的 `session_start`；拒绝已不存在的 cwd，提交前再次确认目标文件。准备前同步调用 wrapper 的 `beginCustomMessageSubmission()`，复用其 `pendingPromptCount`／`activeMutatingCommands`，阻止空闲时新的 `!bash` 抢先并让扩展 `ctx.shutdown()` 等到接受或失败。与普通 prompt 共用 admission，只协调准备与接受，不持有整轮，也不等待 `isRunning()`（parked prompt 需要同一 admission）。streaming 时允许通知在 shell 旁排队；只在新开轮时等待压缩及 `shellRunning`（含尚未结束的 `user_bash` hook），尤其须复查 MCP 等待后的状态。
- SDK 空闲发送的 Promise 等整轮，忙碌发送只等排队。宿主在通知的 `message_start` 或 send Promise 提前返回时确认接受，不等待模型完成；`submitted` 写审计失败只记服务日志，不改称投递失败、不追加 `failed`、不自动重投。
- 模型通知是独立的 `custom_message`，类型为 `pi-web:wakeup-notification`，说明系统投递来源，不增加权限；展示时作为 turn anchor。未来定时器不计入活跃子代理，也不阻挡当前轮完成通知。

### 历史格式与只读查询

- 历史为不进入模型上下文的 `customType: "pi-web:wakeup"` entry，`data` 包含 `version: 1`、`wakeupId`、`sourceSessionId`、`targetSessionId`、`createdAt`、`scheduledAt`、`message`、`event`、`recordedAt`；失败时另有 `error`。SDK 的 entry id／parentId 不变。
- `created` 表示创建历史已写入、随后开始计时；`cancelled` 表示已从内存取消；`submitted` 仅表示接受或排队，不证明通知落盘或任务完成，Stop 仍可能清掉队列；`failed` 表示投递失败。目标已删或变成子代理时，失败仅记服务日志，不重建文件或写入子代理历史。
- 按全部分支聚合，最后事件取文件追加顺序，不按事件时间重排。`active` 只反映当前进程的待执行集合；`inactive` 不证明取消或投递成功。fork 继承的记录保留原 `targetSessionId`，不是 fork 自身的新定时器。
- `readWakeupSessionFile()` 只读且不启动模型、不恢复计时、不改 bytes／mtime。标准 SDK 行先识别 `type` 跳过普通消息，避免解析大图片；非标准键序回退 `JSON.parse`。只按 LF 拆行，CRLF 的 CR 由 JSON 空白规则处理，避免 readline 错拆字符串内的 U+2028／U+2029；不引入自定义 JSON 解析器。

### 技能资源

技能由 `resources_discover` 在绑定／重载时贡献；初始提示词只广告名称、描述和路径，正文按需读取或由 `/skill:tsgw-session-wakeup` 展开。不复制到用户技能目录，不增加全局配置或会话类型过滤。路径必须跟随安装包根 cwd 迁移，不能依赖会话 cwd 或构建机路径；Settings／slash palette 的独立列表不发现扩展技能，不为显示它改写上游。

## 修改的模块外文件与接入点

以下是本功能相对接入前 `tsgw` 基线 `b056cb2` 的完整模块外改动清单；更新接入时必须同步维护。

| 文件 | 函数、类型或位置 | 改动与必要性 |
| --- | --- | --- |
| `lib/rpc-manager.ts` | 模块 imports | 经 `@/tsgw/wakeups` 公共入口导入工具、runtime 与写入协调适配；不在上游文件放调度主体。 |
| `lib/rpc-manager.ts` | `RpcSessionStartOptions.requireExistingSession`、`startRpcSession()` 的实际 open 前检查 | 为定时恢复增加仅本调用启用的严格模式；等待已有启动／关闭过程后同步核对文件头 ID，禁止 SDK 在目标被删后创建替代会话。其他调用默认行为不变。 |
| `lib/rpc-manager.ts` | `AgentSessionWrapper.acquirePromptAdmission()`、`shellRunning`、`beginCustomMessageSubmission()` | admission 与 shell getter 公开给适配层；新增同步开始、幂等结束的提交生命周期计数，复用已有 pending／mutation、idle／完成及扩展 shutdown 检查。只计准备与接受，不另建锁／状态机；MCP 的唯一 Stop 句柄不能被并发覆盖。 |
| `lib/rpc-manager.ts` | `startRpcSession()` 的普通会话 `extensionFactories` | 注册工具并注入 `getRpcSession`、严格 `startRpcSession` 及现有 `getLocks`／`closingRpcSessionWait` 等待入口。子代理及 Chat-only 分支不注册。 |
| `lib/message-display.ts` | `isMessageGroupAnchor()` | 在上游 `TurnAnchorMessage`／`getTurnAnchors()` 上保留可见 `pi-web:wakeup-notification` 的无上下文锚点；即使前一回答被截断、出错或缺少结束原因，唤醒仍另起轮次。其他扩展触发轮次继续沿用上游推断，不加替代分组流程或界面。 |
| `package.json` | `scripts.test`、`files` | 模块测试继续由 `tsgw/**/*.test.mjs` 发现；`files` 增加 `tsgw/wakeups/skills`，仅将技能资源随 npm 包发布，无依赖变更。 |
| `AGENTS.md` | TSGW 模块规则入口、wakeups 主题索引 | 链接本模块规则，集中维护行为、接入与验证入口。 |
| `tsgw/AGENTS.md` | 新增的 fork 模块统一规则 | 规定模块隔离、外部接入清单、变更同步与测试发现要求；本模块遵守该父级规则。 |
| `docs/agents/tools.md` | 文件开头的 TSGW 唤醒说明 | 为模型工具增加文档入口，不改动上游其他工具规则。 |

### 共享代码调整的处理

首次实现曾抽取并改写 `renameRpcSession()` 以复用写入协调；模块隔离整理时已恢复该函数及注释为接入前 `tsgw` 基线原样，移除 `withRpcSessionOwner` 导出。重命名不依赖本模块。新增的唤醒通知分组用例已归入模块内 `display.test.mjs`，原 `lib/message-display.test.mjs` 亦保持基线原样。

模块内的 `session-owner.ts` 只封装必要的宿主协调：活动 wrapper 使用它的 manager，等待已有启动／关闭 Promise 后重新检查，没有 owner 才同步写盘；检查与磁盘写入之间不得插入 await。它使用现有宿主状态，不复制整个会话管理机制。上游更新此所有权约定时，需要对照检查本适配层，但不要再次为了消除这段小范围协调而改写重命名流程。

## 依赖但未修改的宿主接口

- `lib/session-reader.ts`：`resolveSessionPath()`、`readSessionHeader()`、会话列表及 manager 缓存失效方法。历史查询不调用可能迁移文件的 `SessionManager.open()`。
- `lib/subagents.ts`：`SUBAGENT_META_TYPE`；不能凭 `parentSession` 头判断子代理，因为普通 fork 也有此字段。
- `AgentSessionWrapper`：`inner`、`isAlive()`、`prepareMcpForRun()`、`cwd`、`sessionFile`；`host.ts` 另使用上表公开的 admission、shell getter 和提交生命周期接线。仅 `host.ts` 以 type import 依赖该类型，功能其余部分不导入 RPC 实现。
- pi SDK：`uuidv7()`、`SessionManager` 的有意写入、`sendCustomMessage(..., { deliverAs: "followUp", triggerTurn: true })` 及消息开始事件；`resources_discover` / `skillPaths` 负责启动、重载时发现技能并按需加载正文。
- `bin/pi-web.js.startServer()`：Next 子进程的 cwd 固定为安装包根；`extension.ts` 据 `process.cwd()` 生成技能绝对路径，不能用会话 cwd 或会被 Next 固化为构建机路径的 `import.meta.url`。
- `lib/skills-service.ts`：Settings／slash palette 的独立只读列表不绑定会话，也不发现扩展贡献的技能。本次沿用该上游行为，不修改列表或写入用户技能目录；会话内的技能广告与显式 `/skill:tsgw-session-wakeup` 正常可用。

## 升级上游时的复核点

1. `startRpcSession()` 的子代理／Chat-only／侧聊分支和启动／关闭等待顺序是否变化；严格目标检查仍必须位于真正 open 前。侧聊工具 allow-list 与完成通知静默沿用上游，其他普通会话仍可调度已有侧聊目标，不新增目标禁令。
2. prompt admission、MCP 准备、Stop 取消、手动压缩及暂存 prompt 的时序；只协调准备与接受，不能持有整轮或等待需要自身 admission 才能排出的 prompt。`shellRunning` 必须仍含 `user_bash` hook；streaming+shell 的通知及普通 follow-up 不能相互阻塞。提交计数须在扩展绑定／MCP 前存在，扩展 shutdown 不能提前处置，但不得取消未来 timer；已接受队列被 Stop 清除不重投。
3. wrapper 对 manager 的独占关系、文件删除语义及缓存失效方式；不新增多进程同文件写入支持。
4. SDK 空闲发送的 Promise 等整轮、忙碌发送只等排队的语义，以及通知事件匹配方式；审计写入失败不能改称投递失败或自动重投。
5. custom meta 不进入模型上下文、通知进入上下文，以及通知在聊天中的分组规则。上游扩展锚点只在前一回答以 stop／aborted 结束时推断；不可用它替代唤醒的无上下文锚点。`display.test.mjs` 覆盖截断／错误／缺少结束原因，以及与上游扩展触发消息混排。
6. SDK 的 `codemode` exposure 仍默认不声明、注册后可被嵌套调用；codemode 能列出三个工具及调度指导，历史工具仍直接暴露。不得通过修改全局 `codemode.mode` 或改变其他工具注册来实现本模块的暴露策略。
7. Node 测试发现范围仍包含本模块，TypeScript／lint 仍覆盖根 `tsgw/`；不得在目录迁移时漏掉原有测试。
8. SDK 资源发现在绑定及重载后仍会加载扩展贡献的技能，不受 `noSkills` 的常规目录扫描开关影响；不以新增过滤隐藏工具缺失。启动器仍从安装包根运行 Next，npm `files` 仍包含技能，隔离包迁移回归必须通过。

## 验证命令与标准

在仓库根目录执行：

```bash
node --experimental-strip-types --test "tsgw/wakeups/*.test.mjs" lib/rpc-manager-side.integration.test.mjs app/api/sessions/rename-route.test.mjs lib/message-display.test.mjs
node_modules/.bin/tsc --noEmit --incremental false
npm run lint
npm test
git diff --check
```

验收包括：内置技能启动／重载发现、正文按需展开、npm 资源随包迁移且不依赖会话 cwd；侧聊仍可发现技能但不能调用 wakeup 工具；三个调度工具默认只通过 codemode 声明与调用、伪造直接调用被拒绝；历史工具仍直接调用、四工具嵌套调用及结构化结果；创建后立即返回；UUIDv7；自唤醒与跨普通会话投递；忙时不打断；空闲回收后恢复；子代理拒绝且普通 fork 不误判；历史 bytes／mtime 不变；取消及 runtime 重建不恢复；删除目标不重建；MCP 共享发送协调；审计失败不重投；原有重命名与通知分组回归。

`lifecycle.integration.test.mjs` 独立覆盖 streaming+shell 与普通 follow-up、MCP 完成时仍在 `user_bash` hook、准备期扩展 shutdown、未来 timer 保留、Stop 在 `session_start` 仍未完成时释放提交且不在绑定完成后补投，以及 Stop 清除已接受通知后不重投；不让现有集成测试文件继续膨胀。

测试使用临时目录、本地 faux provider 和真实 SDK／宿主实现，禁止真实模型请求、用户会话或配置修改。不为技能措辞或示例写策略测试；执行结果留在任务回报与会话，不在本文件累积历史测试计数和过程流水。
