# Wakeups：一次性会话唤醒模块

## 范围、入口与文件

只实现进程内存中的一次性定时唤醒：支持自身及跨普通会话交接，拒绝子代理；只传递交接消息，不共享来源上下文或增加授权。重启丢失、不恢复、不补发、不重试；不做周期任务、数据库、独立后台服务或新增界面。子代理只能由被唤醒的主代理通过已有机制恢复。

- `extension.ts`：`createWakeupExtension()` 注册 `schedule_wakeup`、`list_wakeups`、`cancel_wakeup`、`list_session_wakeups`；只注入普通非 Chat-only 会话。
- `scheduler.ts`：`WakeupScheduler` 保存进程内待触发项、单次触发及取消，长等待分段处理。
- `runtime.ts`：`WakeupRuntime` 校验入口参数、生成 SDK UUIDv7、协调历史与调度；`submitted` 只表示 SDK 接受或排队，不是模型任务完成。
- `history.ts`：`pi-web:wakeup` custom meta 的只读聚合；`pi-web:wakeup-notification` 是另行进入模型上下文的通知。查询全部分支，不迁移文件、不启动会话。
- `host.ts`：唯一的宿主适配层，提供 `createWakeupHost()`、进程级 `getWakeupRuntime()`；对接现有会话、文件及 SDK 投递。
- `session-owner.ts`：通过宿主注入的现有 wrapper、启动／关闭 Promise 协调写入；不持有另一个会话注册表或锁。
- `*.test.mjs`：单元测试及真实 SDK、SessionManager、AgentSessionWrapper 配合本地 faux provider 的集成测试。

详细行为、历史格式及验证记录以 [../../docs/agents/wakeups.md](../../docs/agents/wakeups.md) 为准。本文件是模块接入清单，不重复维护完整设计。

## 修改的模块外文件与接入点

以下是本功能相对接入前 `tsgw` 基线 `b056cb2` 的完整模块外改动清单；更新接入时必须同步维护。

| 文件 | 函数、类型或位置 | 改动与必要性 |
| --- | --- | --- |
| `lib/rpc-manager.ts` | 模块 imports | 导入本模块工具、runtime 与写入协调适配；不在上游文件放调度主体。 |
| `lib/rpc-manager.ts` | `RpcSessionStartOptions.requireExistingSession`、`startRpcSession()` 的实际 open 前检查 | 为定时恢复增加仅本调用启用的严格模式；等待已有启动／关闭过程后同步核对文件头 ID，禁止 SDK 在目标被删后创建替代会话。其他调用默认行为不变。 |
| `lib/rpc-manager.ts` | `AgentSessionWrapper.acquirePromptAdmission()` | 从 private 改为可供宿主适配调用；复用普通 prompt 的现有 admission，不新增锁、不改变方法实现。准备 MCP 的唯一 Stop 句柄不能被并发发送覆盖。 |
| `lib/rpc-manager.ts` | `startRpcSession()` 的普通会话 `extensionFactories` | 注册工具并注入 `getRpcSession`、严格 `startRpcSession` 及现有 `getLocks`／`closingRpcSessionWait` 等待入口。子代理及 Chat-only 分支不注册。 |
| `lib/message-display.ts` | `isMessageGroupAnchor()` | 将可见 `pi-web:wakeup-notification` 视为新轮次，防止新回答把前一轮回答折入 Process details；无新增组件或界面。 |
| `package.json` | `scripts.test` | 增加 `tsgw/**/*.test.mjs`，使模块测试继续被全量测试发现；无依赖变更。 |
| `AGENTS.md` | TSGW 模块规则入口、wakeups 主题索引 | 链接统一规则、本模块规则及行为说明，指向新的代码目录。 |
| `tsgw/AGENTS.md` | 新增的 fork 模块统一规则 | 规定模块隔离、外部接入清单、变更同步与测试发现要求；本模块遵守该父级规则。 |
| `docs/agents/tools.md` | 文件开头的 TSGW 唤醒说明 | 为模型工具增加文档入口，不改动上游其他工具规则。 |
| `docs/agents/wakeups.md` | 唤醒功能说明及验证入口 | 维护实际目录、会话写入方式、行为约定及验证证据。 |

### 共享代码调整的处理

首次实现曾抽取并改写 `renameRpcSession()` 以复用写入协调；模块隔离整理时已恢复该函数及注释为接入前 `tsgw` 基线原样，移除 `withRpcSessionOwner` 导出。重命名不依赖本模块。新增的唤醒通知分组用例已归入模块内 `display.test.mjs`，原 `lib/message-display.test.mjs` 亦保持基线原样。

模块内的 `session-owner.ts` 只封装必要的宿主协调：活动 wrapper 使用它的 manager，等待已有启动／关闭 Promise 后重新检查，没有 owner 才同步写盘；检查与磁盘写入之间不得插入 await。它使用现有宿主状态，不复制整个会话管理机制。上游更新此所有权约定时，需要对照检查本适配层，但不要再次为了消除这段小范围协调而改写重命名流程。

## 依赖但未修改的宿主接口

- `lib/session-reader.ts`：`resolveSessionPath()`、`readSessionHeader()`、会话列表及 manager 缓存失效方法。历史查询不调用可能迁移文件的 `SessionManager.open()`。
- `lib/subagents.ts`：`SUBAGENT_META_TYPE`；不能凭 `parentSession` 头判断子代理，因为普通 fork 也有此字段。
- `AgentSessionWrapper`：`inner`、`isAlive()`、`isRunning()`、`waitUntilReady()`、`prepareMcpForRun()`、`cwd`、`sessionFile`。仅 `host.ts` 以 type import 依赖该类型，功能其余部分不导入 RPC 实现。
- pi SDK：`uuidv7()`、`SessionManager` 的有意写入、`sendCustomMessage(..., { deliverAs: "followUp", triggerTurn: true })` 及消息开始事件。

## 升级上游时的复核点

1. `startRpcSession()` 的子代理／Chat-only 分支和启动／关闭等待顺序是否变化；严格目标检查仍必须位于真正 open 前。
2. prompt admission、MCP 准备、Stop 取消、手动压缩及暂存 prompt 的时序；只协调准备与接受，不能持有整轮或等待需要自身 admission 才能排出的 prompt。
3. wrapper 对 manager 的独占关系、文件删除语义及缓存失效方式；不新增多进程同文件写入支持。
4. SDK 空闲发送的 Promise 等整轮、忙碌发送只等排队的语义，以及通知事件匹配方式；审计写入失败不能改称投递失败或自动重投。
5. custom meta 不进入模型上下文、通知进入上下文，以及通知在聊天中的分组规则。
6. Node 测试发现范围仍包含本模块，TypeScript／lint 仍覆盖根 `tsgw/`；不得在目录迁移时漏掉原有测试。

## 验证命令与标准

在仓库根目录执行：

```bash
node --experimental-strip-types --test "tsgw/wakeups/*.test.mjs" app/api/sessions/rename-route.test.mjs lib/message-display.test.mjs
node_modules/.bin/tsc --noEmit --incremental false
npm run lint
npm test
git diff --check
```

验收包括：四工具直接及嵌套调用；创建后立即返回；UUIDv7；自唤醒与跨普通会话投递；忙时不打断；空闲回收后恢复；子代理拒绝且普通 fork 不误判；历史 bytes／mtime 不变；取消及 runtime 重建不恢复；删除目标不重建；MCP 共享发送协调；审计失败不重投；原有重命名与通知分组回归。

禁止真实模型请求、用户会话或配置修改。已知全量验证限制及本次结果见行为说明的验证记录，不在本文件复制动态测试计数。
