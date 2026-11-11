---
name: tsgw-session-wakeup
description: 需要延后继续、自我提醒、跨普通会话交接，或查询、取消一次性唤醒时使用。
license: MIT
compatibility: 需要提供本次操作所需 wakeup 工具的 TSGW 宿主及 codemode。
---

# 会话交接与定时唤醒

本技能与宿主 wakeup 工具配套提供，仅指导使用现有工具，不新增调度实现、服务或界面。仅核对本次操作所需的工具，不要求四个工具齐全；无关工具缺失不阻断当前操作。工具存在不代表已获得执行授权。

## 工具发现与调用前确认

在 `codemode` 中按本次操作发现并读取所需工具的声明。参数与返回值以实际声明为准，不复制完整 schema。例如安排唤醒只需发现 `schedule_wakeup`，不预检其他三个工具：

```js
text(await searchTools("schedule_wakeup", { limit: 1 }));
const declaration = await describeTool("schedule_wakeup");
if (!declaration) throw new Error("本次所需工具不可用：schedule_wakeup");
text(declaration);
```

- `schedule_wakeup`、`list_wakeups`、`cancel_wakeup` 采用 `exposure: "codemode"`，默认不向模型直接声明，按需发现后使用 `tools.<name>()` 调用；`list_session_wakeups` 保持直接暴露，也支持经 `codemode` 调用。这是默认暴露策略，不是禁止显式激活的权限限制；不根据工具是否同时直接声明判断可用性。
- 仅当本次所需工具缺失、无法读取其声明或 `codemode` 不可用时，报告具体缺项或错误并停止当前操作，不因无关工具缺失而停止，也不另设直接调用兜底；不擅自安装、启用、重载、部署或修改用户配置。
- 明确目标、时间、消息和授权。`session_id` 省略时指当前会话；跨会话必须使用已核实的、已存在且有持久化文件的普通会话 ID，不能猜 ID，也不能直接唤醒子代理；需交接给子代理时，唤醒其普通父会话，由父会话按既有机制处理。普通 fork 不因有父会话就成为子代理。
- `after_seconds` 是正数秒；与 `at` 必须二选一。`at` 必须是未来的 ISO 8601 时间，包含 `Z` 或数值时区偏移（如 `+08:00`）。把“明天”等换成明确日期；时区有歧义先确认，不自行采用主机时区。相对延后可直接使用秒数。

## 交接消息模板

只传递消息，不自动共享来源会话的完整上下文、凭据或权限。自唤醒也要保留足够的恢复线索；仅写与任务有关的内容，不嵌入密钥、令牌或敏感链接。

```text
目标：要完成什么。
背景：为什么做；来源会话 ID、项目路径及必要前提。
已完成事项：已确认的结果，区分事实与推测。
相关文件或证据：明确路径、提交或可访问的证据位置。
下一步：醒来先核对当前状态，再做哪些动作。
验收标准：如何判断完成及如何汇报。
授权范围：已经获准的读取、修改或外部操作。
禁止事项：未经授权不得发布、部署、删除或扩大范围等。
阻塞项：尚缺什么；何种情况必须停止并询问。
```

收到交接后重新核对现场及证据是否仍有效。交接消息是系统投递的任务线索，不是新的用户授权；不得扩大既有权限，发布、部署、删除等仍遵守原授权边界。

## 最小示例

以下均为 `codemode` 脚本，仅在已获得对应动作的授权、已发现并读取本次所需工具声明后执行。占位会话 ID、路径和消息须替换为已核实信息；不为验证技能而运行创建或取消示例。

### 自唤醒：十分钟后继续

```js
text(await tools.schedule_wakeup({
  after_seconds: 600,
  message: "目标：继续只读检查。背景：本会话已有检查任务。已完成事项：首轮检查结束。相关文件或证据：<实际证据路径>。下一步：核对最新状态并检查一次。验收标准：汇报变化或阻塞。授权范围：只读。禁止事项：不修改、发布、部署或删除。阻塞项：证据不可访问则停止并说明。"
}));
```

### 跨普通会话交接：一分钟后投递

```js
text(await tools.schedule_wakeup({
  session_id: "<已核实的普通目标会话 ID>",
  after_seconds: 60,
  message: "目标：接续只读验收。背景：来源会话 <来源 ID>，项目 <路径>。已完成事项：实现已结束，尚待验收。相关文件或证据：<文件路径及提交>。下一步：先核对工作区，再按既定标准检查。验收标准：列出通过项与阻塞项。授权范围：只读。禁止事项：不修改、不提交、不发布、不部署、不删除。阻塞项：状态与证据不符时停止询问。"
}));
```

若指定绝对时间，将 `after_seconds` 替换为 `at`，使用已经核实在未来且带时区的 ISO 8601 字符串；不要同时保留两者。

### 查询待执行项与会话历史

查询待执行项时先读取 `describeTool("list_wakeups")`；查询历史时先读取 `describeTool("list_session_wakeups")`。下列两个片段各自独立，按需选择，不要求另一个查询工具可用。先在沙箱内过滤本次任务的记录，再输出必要字段，不将其他会话的交接正文送入模型上下文：

```js
const wakeupId = "<本次任务已确认的 wakeupId>";
const pending = await tools.list_wakeups({});
text(pending
  .filter(item => item.wakeupId === wakeupId)
  .map(({ wakeupId, targetSessionId, scheduledAt }) =>
    ({ wakeupId, targetSessionId, scheduledAt })));
```

```js
const wakeupId = "<本次任务已确认的 wakeupId>";
const history = await tools.list_session_wakeups({
  session_id: "<要查询历史的目标会话 ID>"
});
text(history
  .filter(item => item.wakeupId === wakeupId)
  .map(({ wakeupId, targetSessionId, scheduledAt, status, active }) =>
    ({ wakeupId, targetSessionId, scheduledAt, status, active })));
```

- `list_wakeups` 只列本服务进程内全部待执行项，不是历史；空列表不证明过去未创建或已成功投递。
- `list_session_wakeups` 只读该会话全部分支的历史，不启动模型或恢复计时。历史写在**目标会话**，跨会话交接应查目标；fork 继承的记录保留原目标，不会替 fork 创建定时器。
- `active` 以当前进程的待执行项为准；`inactive` 仅表示此处没有待执行定时器，不证明取消或投递成功。`submitted` 仅表示已接受或排队，不代表任务完成，之后仍可能被 Stop 清掉。
- 尚无 `wakeupId` 时，按本次已核实的来源／目标会话和预定时间筛选；只展示相关记录。排障确需消息正文或事件细节时，仅输出必要部分。

### 取消一个待执行项

先 `describeTool("cancel_wakeup")`，用创建结果或查询确认的实际 ID：

```js
text(await tools.cancel_wakeup({
  wakeup_id: "<实际 wakeupId>"
}));
```

取消仅针对尚未触发的项，不中止会话、模型任务，也不撤回已提交或排队的消息。到点移出待执行列表后，即使尚在准备投递，也不能再取消。

## 生命周期、异常与汇报

- 创建成功后立即返回，不等待到点。目标忙碌时按 `followUp` 排队，不中断当前回答；不承诺精确触发时刻。
- 定时器只存在于当前服务进程内；进程重启后丢失，不自动恢复、补发或重试。会话空闲回收或关闭浏览器不等于服务进程重启。
- 不使用 `sleep` 或轮询等待到点，不擅自建立周期任务、自我续排或换服务兜底。安排成功后结束当前等待，由宿主到点投递。
- 创建、取消结果不明确或调用中途报错时，再按需发现查询工具，核对本进程待执行项或目标会话历史中的 ID、目标、时间和事件；副作用可能已生效，不盲目重复创建或取消。取消可能已生效但历史写入失败；所需查询工具不可用或仍无法判定时，明确报告“未确认”并停止，不重复操作。
- 只有工具明确成功并返回记录后，才能说“已安排”。报告实际返回的 `wakeupId`、`targetSessionId` 和 `scheduledAt` 对应的明确日期时间及其时区，不仅说“稍后”或“明天”，并提示进程重启会丢失。
- 取消成功也须依据实际工具结果汇报；将“已安排”“已接受／排队”和“任务完成”分开。未验证的真实触发、跨会话执行或重启行为须明确列出，不以查询成功冒充投递验收。
