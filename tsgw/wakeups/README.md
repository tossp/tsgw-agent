# TSGW：一次性会话唤醒

主体代码及测试位于 `tsgw/wakeups/`；全部模块外接入点、规则和上游升级复核清单见 [模块规则](AGENTS.md)。

## 范围与工具

普通、非 Chat-only 会话可使用 `createWakeupExtension()` 的工具；不依赖内置子代理开关。子代理不加载这些工具。侧聊沿用上游严格工具 allow-list，四个 wakeup 工具不进入其注册表、模型声明或可调用集合，不能自行调用。工具返回文本、`details` 和符合 `outputSchema` 的 `structuredContent`。

`schedule_wakeup`、`list_wakeups`、`cancel_wakeup` 使用 SDK 的 `exposure: "codemode"`：注册时不激活、不向模型直接声明，由 Code mode 列出并通过 `tools.<name>()` 调用，也保留 `ctx.executeTool()` 的嵌套调用能力。未启用 Code mode 时需先启用，不自动更改全局设置或其他工具。`list_session_wakeups` 保持直接暴露。此处采用 SDK 原生暴露语义，不是禁止显式激活的权限控制；显式选中或从既有会话工具集恢复为 active 时，SDK 仍可直接声明这些工具。

- `schedule_wakeup({ session_id?, after_seconds?, at?, message })`：默认当前会话；相对秒数与带时区的 ISO 时间二选一。时间必须在未来，消息不可为空。返回 SDK `uuidv7()` 生成的 `wakeupId` 及确定的 UTC 时间，不等待到点。
- `list_wakeups({})`：查询本服务进程内全部尚未触发的定时器，不是历史。
- `cancel_wakeup({ wakeup_id })`：只取消尚未触发的定时器，不终止模型、不撤回已排队消息。取消后写历史失败时，错误明确说明内存取消已经生效，不重新挂回定时器。
- `list_session_wakeups({ session_id })`：只读目标文件内全部分支的定时器记录，不启动模型，不恢复计时。

允许跨普通会话的定时交接，不传递来源会话的完整上下文或额外授权。所有创建、投递目标都必须已有持久化会话文件。含 `pi-web:subagent` custom entry 的目标直接拒绝，不能只依据文件头的 `parentSession` 判断，因为普通 fork 也有该字段。到点重新检查目标；子代理只能由被唤醒的主代理通过既有机制恢复。

### 侧聊的不对称行为

侧聊自身不能调用 wakeup 工具，但其他普通会话可以将已有侧聊作为 `schedule_wakeup` 的目标；`pi-web:side` 不等于 `pi-web:subagent`，不新增侧聊目标禁令。侧聊空闲回收后，投递仍通过真实 `startRpcSession(..., { requireExistingSession: true })` 严格重开，保留上游工具限制与完成通知静默。目标被删除时不重建，包括宿主读取有效快照后、严格重开前删除的竞态。此处只是 fork 增项与上游行为的集成，不改变上游侧聊、会话 API 或运行时。

## 内置技能

`tsgw/wakeups/skills/tsgw-session-wakeup/SKILL.md` 随 npm 包提供。现有 `createWakeupExtension()` 通过 SDK `resources_discover` 返回该文件的绝对路径，启动绑定和重载时发现；初始提示词仅广告名称、描述和路径，正文由模型按需读取，或通过 `/skill:tsgw-session-wakeup` 显式展开。不新增全局设置、不复制到用户技能目录、不修改工具注册、调度或权限。

路径以启动器 `bin/pi-web.js` 为 Next 设置的安装包根 cwd 为基准，不使用会话项目目录，也不使用会被 Next 固化为构建机路径的 `import.meta.url`。`package.json.files` 包含 `tsgw/wakeups/skills`；模块测试在临时目录用真实 npm 打包、解压到另一目录后，再用真实 SDK 验证加载。

技能与工具是配套能力，技能正文先通过 Code mode 的 `ALL_TOOLS` 核对四个工具；缺少任何工具时直接报“宿主能力不一致：缺少工具 …”并停止。Code mode 不可用或无法读取工具声明时同样报告具体错误，不直接调用兜底、不擅自安装或启用。这里是技能的使用契约和可执行检查，不是新增宿主启动失败钩子，也不增加执行授权。查询示例先过滤本次任务，再输出必要字段，不输出其他会话的交接正文。

沿用现有扩展接入范围，不新增会话类型过滤。侧聊仍会发现技能，但四个 wakeup 工具依旧被上游 allow-list 排除；遇到该能力不一致时按技能要求报错，不放宽侧聊权限。子代理和 Chat-only 不因本次改动加载 wakeup 扩展。

Settings › Skills 和 slash palette 使用的独立列表不会运行扩展资源发现，因此不列出该技能；本次不改变此上游行为。会话内技能广告及手动 `/skill:tsgw-session-wakeup` 使用已绑定会话的资源加载器，不受该列表限制。

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
node --experimental-strip-types --test "tsgw/wakeups/*.test.mjs" lib/rpc-manager-side.integration.test.mjs
node --experimental-strip-types --test app/api/sessions/rename-route.test.mjs lib/message-display.test.mjs
node_modules/.bin/tsc --noEmit
npm run lint
npm test
```

集成测试使用真实 pi SDK、SessionManager、AgentSessionWrapper、Code mode 沙箱和本地 faux provider，验证内置技能发现／按需展开／重载、缺工具直接报错、npm 技能资源迁移、侧聊发现技能但保持原工具限制、三个调度工具默认不直接声明且拒绝伪造直接调用、Code mode 工具列表及调度指导、真实脚本调用与结构化结果、历史工具直接调用、四工具嵌套调用、自唤醒与 live leaf 连通、跨会话 meta 隔离、空闲/忙碌/已关闭目标、普通 fork 与子代理区分、取消、重建 runtime 不恢复、查询字节/mtime 不变、共享发送准备协调、已删除目标不重建及错误目标 ID 拒绝。无真实模型请求或用户会话改动。开发期间不运行 `next build`。

### 内置技能接入回归

- 新增 `skills/tsgw-session-wakeup/SKILL.md`、SDK `resources_discover` 接线及 npm `files` 条目；不修改工具暴露、会话 allow-list 或全局配置。四工具缺失直接报错，不增加侧聊技能过滤或工具权限。
- 新增 3 个真实 SDK／Code mode 用例：启动广告与 `/skill:` 正文展开、重载后不重复、缺工具时在任何调用动作前报错、隔离 npm 打包解压后按新安装根定位技能；示例仅作语法检查和只读能力核验，不运行技能中的调度／取消示例。现有侧聊回归增加技能可发现且四工具仍不可调用的断言。
- wakeups、侧聊、重命名、消息分组及 skills-service 定向测试 86/86 通过；`tsc --noEmit --incremental false`、`npm run lint` 和本轮文件的 `git diff --check` 通过。主动 LSP 有 1 个文件未确认；扩展文件的无后缀导入 warning 与长参数列表 hint 均位于原有代码，类型检查以 tsc 为准。
- 全量 `npm test`：3647 项，3644 通过、2 失败、1 跳过。失败分别为既有 root 只读目录断言，以及 `lib/sidebar-actions.test.mjs` 加载 `lib/i18n/messages/en.ts` 时无法解析 `tsgw/subagent-status/messages`；两处单独重跑仍失败，本轮未修改这些文件或跳过测试。
- 没有真实模型请求、用户定时器／配置修改或服务操作；未运行开发目录 `next build`。npm 验证为临时目录内的技能资源打包与 SDK 加载，不代表完整生产构建／安装冒烟。当前改动未提交、发布或部署。

### Code mode 注册回归（2026-11-10）

- 仅将 `schedule_wakeup`、`list_wakeups`、`cancel_wakeup` 注册为 `exposure: "codemode"`，保留历史工具的直接暴露；不改全局设置、宿主接线或调度与投递逻辑。
- 真实 SDK 与 Code mode 沙箱验证默认不激活、不直接声明，伪造直接调用被拒绝且不写定时器历史；三个工具仍出现在 Code mode 工具列表中，调度指导仍可见，脚本能创建、列出及取消定时器。自唤醒、跨会话及侧聊投递改由真实脚本触发，保留原有运行时回归。
- 定向验证 80/80 通过；`node --check`、`tsc --noEmit --incremental false`、`npm run lint`、`git diff --check` 通过。主动 LSP 检查未确认两个静默文件；扩展文件附带的无后缀导入 warning 和长参数列表 hint 均在未修改行，类型验证以 tsc 为准。
- 全量 `npm test`：3556 项，3554 通过、1 失败、1 跳过。唯一失败仍为已记录的 `lib/rotate-preview-secrets.test.mjs` root 只读目录断言，单独重跑同样失败；未修改或跳过该用例。
- 未使用真实模型或用户会话，未修改用户配置，未提交、发布或部署；当前运行服务不会因源码修改自动切换注册方式。

### 上游 v0.14.1 侧聊集成回归（2026-11-02）

- 新增 `tsgw/wakeups/side-session.integration.test.mjs` 两个真实集成用例，单独运行 2/2 通过；与 wakeups 全部原测试、`lib/rpc-manager-side.integration.test.mjs`、重命名和消息分组合跑 80/80 通过。
- 普通会话由本地模型实际调用 `schedule_wakeup`，向活动侧聊及回收后严格重开的侧聊投递；侧聊的四工具在注册表、模型声明及可调用集合中均不存在，强行发起四个工具调用也全部被 SDK 拒绝。重开后再次验证限制，并以普通会话正常完成推送为对照，确认侧聊完成通知静默。
- 删除用例覆盖到点前删除，以及宿主读取有效快照后、真实严格重开前删除；后者实际返回 `ENOENT`，目标及替代文件均未生成，也未启动模型。删除目标无法写入失败历史而产生的服务日志属于预期结果。
- 使用临时 agent/project/session 目录、真实 SDK 与宿主注册表；只注入本地 faux provider、目标路径及内存推送传输。未初始化 CAT client，并阻断网络连接和 fetch；没有真实模型请求、外发遥测、用户数据修改或服务操作。回收验证调用真实 `shutdown()`，不等待空闲定时器；测试不并发制造宿主启动／关闭所有权竞态，相关协调由既有模块用例覆盖。
- 新测试的 ESLint、`node --check` 及本次三文件 `git diff --check` 通过；本次不改上游运行时、API 或目标准入规则，不承担前端、debug 或整树合并验证。

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
