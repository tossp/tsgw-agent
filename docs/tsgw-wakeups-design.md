# Wakeups：持久化的一次性会话唤醒

本文件说明当前实现的目标、数据流、状态语义和取舍。实现接线、宿主依赖、升级复核与验证命令见[模块规则](../tsgw/wakeups/AGENTS.md)；工具调用方法见[技能](../tsgw/wakeups/skills/tsgw-session-wakeup/SKILL.md)。

## 目标与范围

Wakeups 在指定普通会话中，于指定时间投递一条交接消息，并提供全局状态查询与记录清理界面。任务可发往当前会话、已有普通会话，或在现有项目目录中即时创建的普通会话。只传交接消息，不复制来源上下文、凭据、工具选择或权限。

模块支持一次性任务、pending 持久化及服务启动恢复。它不支持周期任务、子代理目标、自动重试、业务完成回执、独立调度服务或新建项目目录。取消只取消尚未触发的任务；已经投递或排队的消息不能由 wakeup 取消。

## 数据与状态流

每个任务由 UUIDv7 标识，记录来源会话、目标会话、项目目录、预定时间和交接消息。权威清单位于 `getAgentDir()/integrations/wakeups/state.json`，使用版本化 JSON 和原子替换；会话中的 `pi-web:wakeup` custom entry 是审计镜像，不负责恢复计时器。缺失清单表示尚无持久化任务，格式损坏或版本未知时保留原文件并暂停调度。

创建先校验时间与目标，再保存 `pending`，最后安排计时器。到期时先保存 `dispatching`，之后才准备并调用 SDK；SDK 接受或排队后保存 `submitted`。目标会话原始 SDK 事件及通知 entry 用来补充 `received`、`run_settled`、`run_aborted` 或 `unknown` 观察。取消先持久化 `cancelled`，成功后才移除计时器。审计写入失败不回滚已提交的状态；结果包含诊断。

服务启动时，单一清单 owner 重新读盘，先原子清理已保存的正常结束、已取消及核实后关闭记录，保留中断、投递失败及待核实记录，再恢复：未来的 pending 按原时间安排，停机期间已到期的 pending 补投一次；dispatching 及后续状态缺少终结证据时，只核对原目标通知，不自动重投。恢复证据不足时标为 `unknown`。正常关闭停止计时和未提交准备并释放 owner。

状态文件写入失败会使 runtime 进入 `storage_error` 并暂停：清除尚未触发的计时器，拒绝新建、取消及尚未发送的投递。保留磁盘最后可靠状态；本进程观察到但未保存的事实可标记 `unsaved`，不可当作持久状态。修复后需重新初始化 owner 并从磁盘恢复。取消保存失败时明确返回 `cancellationConfirmed: false`。

## 目标会话与投递

`session_id` 和 `cwd` 互斥；不提供目标时使用当前会话。指定 `cwd` 会在该现存项目目录中创建普通空会话，可选 `title`，并立即把该会话绑定到任务。创建不启动 AgentSession 或加载项目资源；首次启动时沿用宿主对目标 cwd 的默认配置、规则、技能与 trust。创建成功但任务未能保存时，返回 `session_created_wakeup_not_scheduled` 和目标会话 ID；取消后保留空会话。

带有 `pi-web:subagent` metadata 的目标会被拒绝；仅有 `parentSession` 不代表子代理。投递复用宿主 wrapper owner、prompt admission、MCP 准备、Stop 和 `sendCustomMessage(..., { deliverAs: "followUp", triggerTurn: true })`。不在 admission 外等待启动完成，也不等待整个模型运行后才确认 SDK 接受。

状态含义有明确边界：`pending` 待触发；`dispatching` 已持久化投递意图；`submitted` 表示 SDK 接受或排队；`received` 表示观察到带匹配 wakeup ID 的通知；`run_settled`／`run_aborted` 表示包含通知的运行结束／中断；`delivery_failed` 表示确认接受前投递失败；`cancelled` 表示待触发任务已取消；`unknown` 表示证据不足；`closed` 表示经核实处置后显式关闭，保存关闭时间和处理说明并保留原投递证据，不认定业务成功或运行停止。received 和 settled 都不证明业务成功、每项要求完成或子代理全部结束。同一运行可含多个 wakeup，运行结果不能简单归因到单条任务。

通知 message_start 可先于发送 Promise 返回，因此迟到的 `submitted` 不得覆盖更强的 received／settled 事实。Stop／Recall 时 SDK `clearQueue()` 不提供 custom 消息 ID，且已出队通知可能尚未产生 message_start；因此不能逐条证明撤回。此时记录不确定，后续观察或目标文件中的完整通知可补证。

## 所有权、查询与界面

同一 agentDir 的持久化清单由一个 owner 调度。owner 锁位于独立目录，不依赖会被原子替换的清单文件；获取后重读清单。锁冲突时实例只读，不持续抢占。失锁时立即暂停，禁止旧 owner 继续发送或覆盖新 owner 的清单；已经进入 SDK 的发送无法撤回。该锁只协调参与本协议的 wakeup 清单，不保证多个进程对同一会话的写入安全，也不提供恰好一次投递保证。

对模型只注册 `schedule_wakeup`、`query_wakeups`、`cancel_wakeup`、`close_wakeup`、`clear_wakeup` 五个工具，全部 `exposure: "codemode"`。管理状态统一以 `query_wakeups` 为准，与列表 GET API 共用过滤、分页、详情和健康投影；详情 GET API 按 ID 查询。默认读取同一状态文件的全局记录，不跨设备聚合。ID、会话、来源、目标、项目、状态和可选 `armed: boolean` 条件先组合筛选再分页；API 接受 `armed=true`／`armed=false`，非法值返回 400。`armed: true` 只列本进程确有计时器的任务，`false` 只列未在本进程挂起的记录，省略则不过滤；空结果须结合过滤条件和 health 判断。列表默认提供摘要，按 wakeup ID 查询才返回正文。健康状态包括 `ready`、`starting`、`read_only`、`paused` 和 `storage_error`。内部 `runtime.list()` 继续提供实际计时器列表，`history()` 和会话审计保留证据职责，均不公开为工具，不作为管理状态权威。查找或读取目标会话时按需使用宿主提供的 `tsgw-session-management` 技能，先确认当前所需能力可用。

API 和界面查询读取状态文件，补充进程内未保存观察和实际计时器状态；不初始化 runtime、不争夺 owner、不启动目标 wrapper、不发送模型消息，也不延长会话租期。全局顶栏在存在任务、读取失败或健康异常时显示独立时钟入口，无需选中会话；入口显示已加载数量（还有分页时加 `+`）、活动状态与异常提示。点击沿用 Agents 的顶栏展开交互，与其他顶面板互斥，再次点击、点击外部或 Escape 关闭；保留上游 Agents、侧聊和 MiniStrip 行为。

面板保留任务摘要、health、实际 armed、消费证据及关联响应，详情按需读取，并显示关闭时间和处理说明，不提供 UI 新建、取消、关闭或重投。已保存的 `run_settled`、`cancelled`、`closed` 记录在投递收尾后自动从清单移除；取消和核实关闭在审计追加后清理。`run_aborted`、`delivery_failed` 保留供用户查看，确认后可手动清理。待触发、投递中、执行中及 `unknown` 继续展示，`unknown` 必须先核实关闭。手动清理按钮及工具/API 继续接受五类可清理终态；`DELETE /api/tsgw/wakeups/[wakeupId]` 仅允许已有 owner 原子删除清单记录并同步内存，不读取或修改会话、消息、回复与审计，也不从历史重新导入。未结束、`unknown`、未保存观察或尚在投递收尾的记录拒绝清理；保存失败保留记录并暂停调度。清理结果未确认时保留错误提示并刷新事实，不能宣称已清理。挂载及宿主 refreshKey 变化读取一次；打开且页面可见时每 2.5 秒刷新，关闭不持续轮询、隐藏页暂停。刷新保留仍存在记录的已加载分页、详情和阅读位置，并移除已清理记录。入口在手机固定为一个图标宽度并保留可见计数与完整可访问名称；面板采用普通键盘顺序，打开聚焦关闭按钮，Escape/关闭按钮恢复入口焦点。响应入口复用宿主会话与 entry 定位，并沿用上游回退行为。

## 待核实记录的处置

AI 按用户要求通过 `query_wakeups` 读取异常原因、原任务与证据，核对目标会话和实际执行结果后，调用 `close_wakeup(wakeup_id, reason)`。该工具仅接受已保存且无投递收尾的 unknown；先原子保存 closed、closedAt、closeReason，再向目标会话追加 closed 审计。审计失败通过 diagnostics 报告，不撤销已保存的关闭。存储失败不确认关闭，并沿用暂停调度策略。

关闭返回关闭时间和处理说明，审计保留已有通知、响应和异常证据；随后自动移除清单记录，不构造运行结束或业务完成事实。重启与迟到观察不恢复已清理记录。补充执行或重新派任务仍使用现有 `schedule_wakeup`，不提供自动核实、自动重投或额外续办流程。

AI 可按用户授权调用 `clear_wakeup(wakeup_id)`，复用界面和 DELETE API 的单条清理实现与资格；unknown 必须先核实关闭。正常结束、已取消和核实后关闭的记录会自动移除，再清理会返回不存在。中断及投递失败记录保留，用户确认后可手动清理。清单中不存在记录不证明业务成功，处理结果仍以目标会话及审计为准。工具默认通过 codemode 发现与调用，侧聊的现有 allow-list 继续排除全部唤醒工具。

## 持续有效的限制

- `dispatching` 保存后、SDK 实际接受前若进程退出，任务可能一次也未投递；仍不自动重投，以避免未知副作用导致重复执行。
- 状态 JSON 与会话审计不是跨文件事务。状态清单是恢复依据；审计缺失通过返回诊断表达。
- 自动清理只删除状态清单记录，会话、消息、响应和审计保持原样；写入失败保留记录并暂停调度，不静默隐藏或转为内存调度。分页只限制响应大小，不降低整份状态文件的读取和原子写入成本。
- 日常容量按约 1000 条／文件不超过 8 MiB 验收，测量原子保存耗时和事件循环停顿，目标保存耗时 p95 不超过 100 ms；10000 条／约 64 MiB 仅测退化，不作为承诺容量。日常规模未达标时先修订存储方案，不删除数据或降低标准。
- 旧版会话审计记录不重建为新清单任务。读取历史和恢复通知使用只读 JSONL 解析，不调用可能迁移或重写会话文件的 `SessionManager.open()`。
- 通知观察、entry 关联和运行结束是宿主可见事实，不构成业务验收、撤销执行或跨进程恰好一次的保证。
