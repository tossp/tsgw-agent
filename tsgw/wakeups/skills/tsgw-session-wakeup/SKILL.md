---
name: tsgw-session-wakeup
description: 需要延后继续、自我提醒、按项目新建会话并交接，或查询、取消一次性唤醒时使用。
license: MIT
compatibility: 需要提供本次操作所需 wakeup 工具的 TSGW 宿主及 codemode。
---

# 会话交接与定时唤醒

本技能只指导现有宿主能力。先核对本次所需工具，不要求其他工具同时可用；工具存在不代表已获得执行授权。安排成功后由宿主到点投递，不用 sleep 或轮询等待。

## 发现工具与明确边界

在 codemode 中按需发现并读取实际声明，不复制固定 schema：

```js
text(await searchTools("schedule_wakeup", { limit: 1 }));
const declaration = await describeTool("schedule_wakeup");
if (!declaration) throw new Error("本次所需工具不可用：schedule_wakeup");
text(declaration);
```

- 五个唤醒工具默认经 codemode 调用，默认不出现在模型原始工具声明中；可用 `searchTools`／`describeTool` 发现后嵌套调用。不以是否同时直接声明判断可用性。
- 本次所需工具缺失、声明不可读或 codemode 不可用时，报告具体问题并停止当前操作。不因无关工具缺失而阻断，也不安装、启用、重载、部署、改配置或换服务兜底。
- 明确目标、时间、交接内容与已有授权。不传目标时唤醒当前会话；`session_id` 必须是核实过的现有普通会话 ID；`cwd` 指核实过的现存绝对项目目录，立即为本次交接创建普通新会话。两者互斥；`title` 仅用于 cwd 新目标。不得猜 ID、按项目显示名猜路径或自动创建项目目录。
- 拒绝子代理目标；需恢复子代理时唤醒其普通父会话。普通 fork 和侧聊不是子代理，但侧聊自己的工具 allow-list 仍然生效。
- `after_seconds` 为正数，与 `at` 二选一；`at` 必须是未来 ISO 8601 时间并带 Z 或数值时区。将相对日期换成明确日期；时区有实质歧义先确认，不默认主机时区。

## 交接内容

只传消息，不共享来源完整上下文、凭据或权限。新目标首次启动时加载目标项目自己的规则和现有默认配置；取消后保留该会话。消息中保留恢复所需证据，不嵌入密钥或令牌：

```text
目标：要完成什么。
背景：来源会话、项目、必要前提。
已完成事项：已确认结果，区分事实与推测。
证据：文件、提交或可访问的位置。
下一步：醒来先核对现场，再做哪些动作。
验收：怎样判断完成及汇报。
授权：已经获准的读取、修改或外部操作。
边界：未经授权不得发布、部署、删除或扩大范围。
阻塞：何种情况必须停止并询问。
```

收到交接后重新核对现场。系统交接是任务线索，不是新用户授权，不能扩大既有操作边界。

## 安排示例

以下仅在已获得对应授权、发现并读取所需工具声明后使用。占位信息必须替换为核实值；不为验证技能创建真实任务。

自唤醒：

```js
text(await tools.schedule_wakeup({
  after_seconds: 600,
  message: "目标：继续只读检查。背景：本会话已有检查任务。证据：<实际文件>。下一步：核对最新状态并检查一次。验收：汇报变化或阻塞。授权：只读。边界：不修改、不发布、不部署、不删除。"
}));
```

向已有普通会话交接：

```js
text(await tools.schedule_wakeup({
  session_id: "<已核实的普通会话 ID>",
  after_seconds: 60,
  message: "目标：接续验收。背景：来源 <ID>，项目 <路径>。已完成：<事实>。证据：<文件和提交>。下一步：先核对现场。验收：列出通过项与阻塞。授权：只读。边界：不修改、不提交、不发布、不部署、不删除。"
}));
```

按项目立即建立新目标、稍后交接：

```js
text(await tools.schedule_wakeup({
  cwd: "<已核实的现存绝对项目目录>",
  title: "<可选会话名称>",
  after_seconds: 600,
  message: "目标：<任务>。背景：来源 <ID>，项目 <路径>。证据：<文件>。下一步：核对项目规则和现场后继续。验收：<标准>。授权：<已批准范围>。边界：<禁止事项>。"
}));
```

绝对时间用已核实、带时区的 `at` 替换 `after_seconds`，不同时保留。

## 查询状态

优先发现并读取 `query_wakeups`。无过滤默认当前会话发出或接收的记录；支持 ID、来源、目标、项目、状态及分页。返回固定 `{ items, nextCursor, health }`。普通列表不返回完整正文；按 ID 详情会含正文和证据，输出时仍只选任务所需字段：

```js
const state = await tools.query_wakeups({
  wakeup_id: "<实际 wakeupId>"
});
text({
  health: state.health,
  items: state.items.map(({ wakeupId, targetSessionId, scheduledAt, status, armed, unsaved }) =>
    ({ wakeupId, targetSessionId, scheduledAt, status, armed, unsaved }))
});
```

| 状态 | 可确认事实 |
| --- | --- |
| pending | 记录待触发；仍须看 armed 与 health 判断是否实际调度。 |
| dispatching | 已取得本次投递权，尚不能证明接受。 |
| submitted | SDK 已接受或排队，可能尚未收到，Stop 仍可能清队列。 |
| received | 已观察到目标通知，不等同业务执行成功。 |
| run_settled／run_aborted | 通知所在运行结束／中断，不证明每条要求完成或副作用撤销。 |
| delivery_failed／cancelled | 投递在确认接受前失败／尚未触发的取消已保存。 |
| unknown | 结果不明，需要核实；不能当作失败、安全重投或已撤回。 |

- health 为 starting／read_only／paused／storage_error 时同时报告原因；磁盘 pending 不等于 timer 实际挂起。`unsaved` 是本进程观察、尚未保存，不是持久化确认。
- `list_wakeups({})` 保留原数组及 message，只列本实例实际 armed timer；空数组不能证明持久化无任务。若使用它，先在 codemode 内按已知 ID 筛选，再输出必要字段，不把其他会话的正文带入上下文。
- `list_session_wakeups({ session_id })` 是旧审计只读查询，历史写在目标会话、涵盖全部分支；inactive 不证明取消、成功或失败。fork 继承的原目标记录不是新任务。它不代替新状态查询，也不恢复计时器。
- UI 在当前会话工具栏提供相关唤醒入口，可查看状态、原始响应与来源／目标会话；查询不启动模型、不延长租期。不通过打开目标 SSE 来观察。

## 取消与异常

读取 `cancel_wakeup` 声明后，用实际 ID：

```js
text(await tools.cancel_wakeup({ wakeup_id: "<实际 wakeupId>" }));
```

- 只能取消仍 pending 的项；到点已进入投递即拒绝，不中止会话、模型或撤回队列。取消新目标的任务后，目标会话保留。
- pending 持久化并在服务启动恢复；停机期间到期的补投一次。dispatching、已接受或后续结果未知的任务不自动重投；可能实际尚未发送，但为避免重复仍须先核实。
- 共享清单只有一个调度所有者，其他实例只读。不要擅自重启或改配置争抢所有权；按实际健康报告阻塞。
- 创建／取消调用结果不明，先按实际 ID、目标、时间查询，不盲目重复。`session_created_wakeup_not_scheduled` 表示会话已建、唤醒未安排，应复用返回的 targetSessionId；`cancellationConfirmed: false` 不能声称已取消。审计失败 diagnostics 不撤销已确认生效的安排或取消。
- 只在工具成功返回后说“已安排”，报告实际 wakeupId、targetSessionId 和 scheduledAt 对应的明确日期时间及其时区。区分已安排、接受、收到、运行结束与业务完成；不以查询成功冒充真实触发验收。
- 不自建周期任务、自我续排或自动重投。终态和交接正文持续保留，不主动永久删除；发布、部署、真实升级／迁移／重启仍按已有授权边界处理。
