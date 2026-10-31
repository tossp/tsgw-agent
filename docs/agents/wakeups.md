# TSGW：一次性会话唤醒

主体代码及测试位于 `tsgw/wakeups/`；全部模块外接入点、规则和上游升级复核清单见 [模块规则](../../tsgw/wakeups/AGENTS.md)。

## 范围与工具

仅普通、非 Chat-only 会话加载 `createWakeupExtension()`；不依赖内置子代理开关。子代理不加载这些工具。工具为普通扩展工具，可由模型直接调用，也可通过 `ctx.executeTool()`（包括 Code mode）调用，返回文本、`details` 和符合 `outputSchema` 的 `structuredContent`。

- `schedule_wakeup({ session_id?, after_seconds?, at?, message })`：默认当前会话；相对秒数与带时区的 ISO 时间二选一。时间必须在未来，消息不可为空。返回 SDK `uuidv7()` 生成的 `wakeupId` 及确定的 UTC 时间，不等待到点。
- `list_wakeups({})`：查询本服务进程内全部尚未触发的定时器，不是历史。
- `cancel_wakeup({ wakeup_id })`：只取消尚未触发的定时器，不终止模型、不撤回已排队消息。取消后写历史失败时，错误明确说明内存取消已经生效，不重新挂回定时器。
- `list_session_wakeups({ session_id })`：只读目标文件内全部分支的定时器记录，不启动模型，不恢复计时。

允许跨普通会话的定时交接，不传递来源会话的完整上下文或额外授权。所有创建、投递目标都必须已有持久化会话文件。含 `pi-web:subagent` custom entry 的目标直接拒绝，不能只依据文件头的 `parentSession` 判断，因为普通 fork 也有该字段。到点重新检查目标；子代理只能由被唤醒的主代理通过既有机制恢复。

## 内存与生命周期

`tsgw/wakeups/scheduler.ts` 使用 Map 和 `setTimeout().unref()`。`tsgw/wakeups/host.ts` 的 `Symbol.for("pi-web.wakeupRuntime")` 保存进程级 runtime，跨 Next 热更新保持同一实例。会话空闲回收、浏览器关闭、会话扩展重载都不取消定时器；进程重启全部丢失，不扫描历史恢复、不补发、不重试，无周期调度、数据库、后台服务或新增界面。

超过 Node 单次 timeout 上限（2,147,483,647 ms）的等待分段重设，避免溢出变成近乎立即触发。使用普通事件循环定时语义，不承诺精确触发时刻。到点先从待触发 Map 移除，再进行投递，因此此后不可取消，即使目标尚在启动或等待手动压缩结束。

## 会话写入与投递

`tsgw/wakeups/session-owner.ts` 通过宿主注入的现有 wrapper、启动／关闭等待入口协调写入：活动 wrapper 直接写其 manager；等待已有启动或关闭过程；没有 owner 时才同步打开文件追加，检查和写入间不能插入 await。它不维护独立的会话注册表或锁。模块隔离整理时已恢复原 `renameRpcSession()` 的实现及注释，不再为了本功能改写重命名流程；上游此处的所有权规则变化时，需要对照复核适配层。仍不支持两个 pi 进程同时续写同一文件，不新增跨进程锁。

meta 追加在**目标会话**的当前 leaf，保留 `sourceSessionId`。只有实际投递才启动目标 wrapper；写 meta 不启动 wrapper。未保存或删除的目标不新建替代会话。定时重开传 `requireExistingSession: true`，在等待已有 start/closing 后、真正 `SessionManager.open()` 前同步核对文件头 ID；返回 wrapper 也必须仍是原目标。非活动目标的有意写入沿用 SDK manager（可能进行 SDK 自身的版本迁移）；历史读取绝不走该路径。

投递复用 SDK `sendCustomMessage(..., { deliverAs: "followUp", triggerTurn: true })`，等待扩展绑定，沿用 wrapper 的 MCP 准备与 Stop 行为，并拒绝已不存在的 cwd。与普通 prompt 共用 `acquirePromptAdmission()`，只串行化准备与接受，不持有整轮执行；避免多个 MCP 准备覆盖唯一的 Stop 取消句柄。目标正在生成时排队，不中断当前回答；先让已有非 streaming 忙碌状态结束，再获取 admission；持有 admission 后只等待实际压缩/shell 标志，不能等待自身需要该锁才能排出的 parked prompt 计数。提交前再次确认目标文件未被删除。

SDK 的 send Promise 在空闲时等整轮结束，在忙碌时只等排队。host 在通知的 `message_start` 或 send Promise 提前返回时确认接受，不等待模型任务完成。`submitted` 审计写入失败单独记录服务日志，绝不追加表示投递失败的 `failed`，也不重投。通知带有明确的系统投递来源说明及原定时器信息，不能解释成新的用户授权。`pi-web:wakeup-notification` 使用现有 custom message 展示，并作为 turn anchor，避免新回答把前一轮回答折进 Process details。未来的定时器不接入子代理未完成状态，也不阻挡当前轮完成通知。

## 历史格式与查询

顶层 `customType: "pi-web:wakeup"` 的 `custom` entry 不进入模型上下文。其 `data` 为 v1 的完整定时器记录加事件：

- `created`：已经写入创建历史，随后在内存启动计时。
- `cancelled`：内存中的待触发项已经取消。
- `submitted`：SDK 已接受或排队；不证明通知已落盘，更不表示模型完成任务。之后的 Stop 可能清掉已排队消息。
- `failed`：投递阶段失败。若文件已删除，或已成为禁止写入的子代理，错误只能记录在服务日志，不能创建新文件或写子代理历史。

每条包含 `wakeupId`、`sourceSessionId`、`targetSessionId`、`createdAt`、`scheduledAt`、`message`、`version: 1`、`event`、`recordedAt`，失败时包含 `error`。pi 自身 entry id/parentId 不变。投递给模型的是独立的 `custom_message`，`customType: "pi-web:wakeup-notification"`，不是 meta。

`wakeupHistory()` 按 UUID 聚合**全部分支**，文件追加顺序决定最后事件，不按事件时间重排。`active` 以本进程的待触发 Map 为准；只有创建记录但内存无项时显示 `inactive`，不臆测取消、失败或投递成功。fork 复制来的历史保留原 `targetSessionId`，不能被误认为 fork 的活动定时器。

`readWakeupSessionFile()` 逐行只读、不调用 `SessionManager.open()`，保留顶层 custom entry，丢弃对话正文。SDK 写出的消息以 `type` 开头，先读取该字段跳过普通消息，避免解析大图片；非标准键序回退原生 JSON 解析。不采用自定义 JSON 解析器。只按 LF 拆行（CRLF 的 CR 由 JSON 空白规则处理），因为当前 Node 的 readline 会错误拆开字符串内部的 U+2028/U+2029。查询不写文件、不改变 mtime、不做版本迁移。

## 验证入口

```bash
node --experimental-strip-types --test "tsgw/wakeups/*.test.mjs"
node --experimental-strip-types --test app/api/sessions/rename-route.test.mjs lib/message-display.test.mjs
node_modules/.bin/tsc --noEmit
npm run lint
npm test
```

集成测试使用真实 pi SDK、SessionManager、AgentSessionWrapper 和本地 faux provider，验证四工具直接/嵌套调用、自唤醒与 live leaf 连通、跨会话 meta 隔离、空闲/忙碌/已关闭目标、普通 fork 与子代理区分、取消、重建 runtime 不恢复、查询字节/mtime 不变、共享发送准备协调、已删除目标不重建及错误目标 ID 拒绝。无真实模型请求或用户会话改动。开发期间不运行 `next build`。

### 初次实现验证（2026-10-30）

- 上述两组定向测试合并运行：71/71 通过。
- `tsc --noEmit`、`npm run lint`、`git diff --check` 通过；主动 LSP 检查无返回诊断，但当前服务器不能证明静默文件通过，故以 tsc 为类型验证依据。
- 最后一次全量 `npm test`：3318 项，3316 通过、1 失败、1 跳过。失败为原有 `lib/rotate-preview-secrets.test.mjs` 的只读目录断言；当前以 root 运行仍能写入，未改动的 `tsgw` 基线同一用例也失败。不修改该无关测试、不降低检查。
- 另一次全量运行出现过原有 MCP 20ms idle 定时测试的时序失败；在本工作树和未改动基线上分别重跑该测试文件均 54/54 通过，再次全量不再出现，保留此不稳定性记录。
- 独立审阅发现并修复的实际失败路径：MCP 准备覆盖 Stop 句柄、读取后删除目标造成 SDK 新建替代会话、已提交但审计写入失败被错误归为投递失败。相关协调、严格重开、审计失败回归已纳入测试。
- 修复后的独立复审通过，未发现确定残留问题。另以隔离 SDK 验证 Stop 取消当前 MCP 准备、读取已打开文件后删除、等待关闭 owner 期间删除、错误 header ID、自唤醒及压缩/暂存 prompt/admission 的交错，均未重现原问题或死锁。

### 模块隔离整理验证（2026-10-31）

- 代码及全部新增功能测试归入 `tsgw/wakeups/`，建立父级与模块规则；测试脚本加入 `tsgw/**/*.test.mjs`，无依赖或 TypeScript 配置变更。
- `renameRpcSession()` 实现与注释、`lib/message-display.test.mjs` 已逐字节对照 `b056cb2`，确认原样；分组回归改在模块 `display.test.mjs` 中验证。
- 迁移后定向测试 71/71 通过；全量测试仍发现 3318 项，3316 通过、1 失败、1 跳过。唯一持续失败仍是已在未修改基线复现的 root 只读目录断言。并行高负载运行再次出现原 MCP idle 时序用例失败，单独重跑全量后不再出现；未修改、跳过这些无关用例。
- `tsc --noEmit --incremental false`、`npm run lint`、`git diff --check` 通过。主动 LSP 未确认部分静默文件，附带报告的 25 个 AST 规则诊断源码行全部已存在于未修改基线 `lib/rpc-manager.ts`；没有借目录整理修复或压制它们，类型验证以 tsc 为准。
- 根 `tsgw/AGENTS.md` 定义模块隔离规则；模块 `AGENTS.md` 是全部外部接入点与升级复核的清单。原工作区未修改，未提交、合并、推送、发布或部署。
- 目录隔离独立验收通过：6 个源码文件、6 个测试文件归位完整，旧路径与旧导出无残留；两级规则覆盖实际接入，原重命名实现及原测试与基线一致，未新增会话注册表或锁。测试发现、TypeScript／lint 覆盖及打包配置静态检查通过，未发现新增客户端到服务端模块的导入路径或回到 RPC 实现的运行时循环依赖。未执行 `next build`，实际构建产物仍不在本次验证范围。
