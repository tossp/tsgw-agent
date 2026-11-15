# Debug 任务大盘模块规则

## 范围与入口

- `index.ts` 公开导出 `DebugPage`，外部经 `@/tsgw/debug` 接入。当前页面、数据语义和已核实缺口以 [DESIGN.md](DESIGN.md) 为准；本文件维护接入、宿主依赖和验证方法。
- 主体、样式、本模块文案及测试保留在 `tsgw/debug/`。保持上游 DebugPanel、聊天实现与生命周期独立，不另造会话管理或任务调度器；诊断能力以上游 Debug 为覆盖基线。
- 仅允许既有 `GET /api/agent/debug[?session=]`、`GET /api/sessions`、`GET /api/agent/<id>?systemPrompt=0`。不发送命令、不启动会话、不续租、不开 EventSource、不读上下文历史，不向用户会话注入测试。未经用户明确确认，不新增或改变后端接口、字段、参数和行为；数据缺口先报告必要性、方案及影响。

## 模块内职责

| 文件与函数 | 职责 |
| --- | --- |
| `DebugPage.tsx`：`DebugPage()`、`copySnapshot()` | 组装资源／模型读取器、可见性与轮询时钟、清理请求和定时器、复制观察结果。 |
| `page-observer.ts`：`createDebugPageObserver()`；`resource-observer.ts`：`createResourcePageObserver()` | 复用宿主 Debug 轮询器，读取目录并计量；按驻留集合公平轮换详情、隔离缓存与失败、退出清理。 |
| `live-model-observer.ts`：`createLiveModelObserver()` | 串行读取当前模型／思考状态，过滤并缓存所需字段；退出时永久失效旧请求，防止同 ID 再次驻留后收到旧结果。 |
| `DebugPageView.tsx`：`DebugPageView()`；`DashboardOverview.tsx`：`DashboardOverview()`；`ObserverPanel.tsx`：`ObserverPanel()` | 页面分区、概览、关注信号、服务器资源及本页轮询实测数据。 |
| `dashboard-state.ts`：`dashboardRole()`、`dashboardCounts()`、`dashboardGroups()`、`filterDashboardGroups()`、`dashboardIssues()`、`dashboardFreshness()` | 目录与快照角色适配、计数、家族分组、驻留过滤、问题提取和新鲜度；页面固定驻留视图，保留的纯辅助筛选不代表存在筛选 UI。 |
| `resource-families.ts`：`resourceFamilies()`；`ResourceBoard.tsx`：`ResourceBoard()`、`ResourceRow()`、`SummaryIdle()` | 依宿主家族边界拆分资源单元，展示成员、关系上下文及尚未采样的真实 summary 回收时间。 |
| `DebugSessionDetail.tsx`：`DebugSessionDetailView()`、`streamGroups()`、`Tag()` | 完整资源事实、按 holder 归组的逐连接明细、MCP 服务器及独立宿主／执行灯态。 |
| `DebugPageView.module.css`、`resources.module.css`、`detail.module.css`、`DashboardArt.tsx`、`*messages.ts` | 模块配色、分区和家族网格、紧凑明细、品牌素材、三语言及减少动态效果。 |

## 模块外接入清单

| 文件与接入点 | 原因与类别 |
| --- | --- |
| `app/debug/page.tsx`：`Debug()`、`metadata` | 导入公共入口并挂载独立页面、设置标题；必要路由接入。 |
| `proxy.ts`：`config.matcher`、`proxy()` 的登录回跳 | `/debug` 使用既有鉴权，登录后回到原路径；鉴权接入，不扩展业务能力。 |
| 根 `AGENTS.md`：Topic Notes；`tsgw/AGENTS.md`：公共入口与文档索引；`docs/agents/sessions.md`：TSGW-only standalone Debug page | 模块规则与设计的薄索引；文档接入。 |

本模块没有后端实现或共享行为重构。以下宿主文件仅作为依赖复用，不为大盘改写其契约。

## 宿主依赖与升级检查

| 宿主文件／具体接口 | 必须复核的契约 |
| --- | --- |
| `lib/debug-types.ts`：`DebugSnapshotResponse`、`DebugSessionSummary`、`DebugSessionDetail`；`lib/debug-snapshot.ts`：`buildDebugSnapshot()`；`app/api/agent/debug/route.ts`：`GET()` | wrapper／流定义驻留集合，摘要与详情含各自快照时钟；读取不启动 wrapper、不续租、不开流、不调用 `send()`。明细会查询保活 provider 状态，摘要只计登记数量；每源异常回退不等于健康。 |
| `lib/rpc-manager.ts`：`AgentSessionWrapper.getDebugSnapshot()`、`send()` 的 `get_state` 分支 | `subagent` 实为 `suppressCompletionNotifications`，侧聊也可为 true。`dashboardRole()` 优先目录 side 关系；侧聊计入 ordinary，已确认侧聊从标志子代理数排除，角色子代理数兼容目录 subagent 关系。目录缺失仍存在身份回退限制。 |
| `lib/agent-client.ts`：`agentStatusUrl()`；`app/api/agent/[id]/route.ts`：`GET()`；上述 `send()` | `systemPrompt=0`，只查已有存活 wrapper，冷会话返回 `running=false`；模型／思考字段来自当前状态。`get_state` 不更新最近命令或 idle；接口可能等待扩展绑定，本页需保持超时取消。响应仍有其他字段，不扩大本模块缓存与复制范围。 |
| `components/debug-panel-state.ts`：`createDebugPoller()`、`groupDebugSessions()`、`debugStatusState()`、`debugServerClock()` 及格式化辅助 | 单在途、5 秒取消、隐藏暂停、失败保留原采样时间；普通／侧聊／子代理状态判定一致，服务端时间加本页经过时长推算倒计时，不将检查时间当关闭保证。 |
| `app/api/sessions/route.ts`：`GET()`；`lib/types.ts`：`SessionInfo` 及关系类型；`lib/session-tree.ts`：`projectNameOf()`；`lib/workspace-memory.ts`：`workspaceKeyOf()`；`components/SessionTree.tsx`：`sessionRowTitle()` | 目录提供名称／项目／分支与关系，不是任务执行记录；家族只按委派关系组织，fork／side 独立成根。非驻留父级仅作关系上下文，不增加资源、计数或请求。 |
| `components/mcp-config-helpers.ts`：`MCP_SESSION_STATE_KEYS`；`lib/page-debug.ts`：`readHttpProtocol()`、`readPageVisibility()`、`startPageVisibilityTracking()` | MCP 状态翻译与未知值回退；`mcp.active`／`mcp.runActive` 保持独立，执行灯不表示工具调用。本页协议／可见性不能代表其他聊天页的客户端内存或连接池。 |
| `hooks/useI18n.tsx`：`useI18n()`；`hooks/useTheme.ts`：`useTheme()`；`lib/i18n/format.ts`：`translateMessage()`；`lib/clipboard.ts`：`copyText()` | 本地三语言字典、主题与剪贴板依赖；大盘配色局限模块，不扩散自有文案到全局字典。 |
| `package.json`：`scripts.test`；`proxy.ts` 的上述接入 | 保持 `tsgw/**/*.test.mjs` 测试发现及 `/debug` 鉴权回跳；不得因独立页面影响上游 Debug 或聊天。 |

`login2` 仅作视觉参考，可使用公开品牌素材，不依赖其认证状态机或播报。wakeups 查询虽已有独立只读接口，当前 Debug 未消费它；升级时不能自动扩大本页三接口范围。当前数据缺口统一见 [设计说明](DESIGN.md#当前数据缺口)。

## 验证

从项目根运行，按实际变更选择检查，不执行 `next build`：

```bash
node --experimental-strip-types --test 'tsgw/debug/*.test.mjs'
node_modules/.bin/tsc --noEmit --incremental false
npm run lint
npm test
git diff --check
```

- 浏览器入口：`E2E_BASE_URL=http://127.0.0.1:30145 node tsgw/debug/e2e.mjs`。脚本强制使用此隔离地址，不接受任意现有服务；`e2e-dev.mjs` 默认端口为 30144，准备服务时须明确设 `E2E_DEV_PORT=30145`，且使用独立开发工作树，避免争用当前工作树的 `.next`。复用已健康的隔离服务，不并发启动第二个同工作树开发进程。
- 浏览器使用响应夹具并拦截 CAT，不调用真实模型或用户任务；网络仅允许三种既有 GET（宿主 CAT 配置读取除外），禁止历史／非驻留详情请求和 SSE。夹具验收不等于部署产物或真实执行验收。
- 验收覆盖正常／异常／空／未知／过期、目录及资源／模型失败、慢请求与超时恢复、隐藏暂停、退出及迟到回复、复制、三语言和减少动态效果。
- 关系与资源检查包括同项目多家族、多级／孤立子代理、非驻留父级、fork／侧聊来源及目录缺失回退，历史目录不进入资源或采样，模型／MCP／SSE／时钟互相隔离，同 holder 合并仍保留逐连接事实，回收／释放倒计时及条随真实时间变化。
- 布局检查左观测右资源、1366×768／1440×900 两列及三普通主会话代表夹具同屏、宽屏三列与末行填充、长家族和第十二条资源可达、区域滚动及手机全内容可达；不承诺任意大型明细全部同屏。
- 以差异确认后端合约、上游 DebugPanel 和聊天行为未改变。仅整理文档时检查本地链接及测试是否依赖历史文案，不沿用历史测试次数作为当前验证结论。
