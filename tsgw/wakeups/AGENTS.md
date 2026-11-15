# Wakeups 模块规则

## 入口与文档

- 浏览器经 `@/tsgw/wakeups` 的 `index.ts` 使用 `WakeupPanelTrigger` 和纯数据类型。入口由宿主传入 `open/onToggle/onClose` 与 `panelHost`，模块将只读内容挂入共享顶栏面板槽位。
- Node 宿主经 `@/tsgw/wakeups/server` 使用工具注册、owner 适配、runtime、observer 和只读查询；浏览器不得导入 Node 入口。
- 技能资源位于 `skills/tsgw-session-wakeup/SKILL.md`。当前行为、数据流和取舍见[设计文档](../../docs/tsgw-wakeups-design.md)；工具调用说明以技能为准。

## 实现职责

| 文件 | 职责 |
| --- | --- |
| `extension.ts` | 注册五个工具、schema 和内置技能资源。 |
| `scheduler.ts` | 进程内计时器；持久化和恢复由 runtime/store 负责。 |
| `types.ts`、`runtime.ts` | 状态、健康和观察类型；调度、取消、投递、持久化、恢复与查询。 |
| `store.ts`、`ownership.ts` | 版本化清单校验、原子保存、单 owner 锁和失锁通知。 |
| `host.ts`、`session-owner.ts` | SDK 投递、严格重开、wrapper owner/admission、MCP 与 Stop 衔接。 |
| `observer.ts` | 原始 SDK 事件、通知与运行观察、entry/分支证据。 |
| `new-session.ts` | 在现有项目中持久化普通空会话，并更新宿主路径、文件访问和会话列表缓存。 |
| `history.ts`、`reconcile.ts` | 会话审计投影及原目标通知补证；只读解析 JSONL。 |
| `query.ts`、`server-query.ts` | 工具/API 共用过滤、分页、详情和健康投影；查询不初始化 runtime。 |
| `ui.tsx`、`ui-view.ts`、`ui.module.css` | 会话相关的只读面板、按需详情、三语文案和响应式样式。 |
| `*.test.mjs` | 模块实现、SDK/宿主集成、UI、资源和存储验证。 |

关键契约：状态清单 `getAgentDir()/integrations/wakeups/state.json` 是恢复权威；状态写入失败暂停调度；只恢复 pending，逾期 pending 补投一次，dispatching 及后续不自动重投。owner 丢失时停止写入和新发送。通知 received 与所在运行 settled 不代表业务成功；SDK `clearQueue()` 无逐条 custom 消息 ID，Stop/Recall 只能记录不确定。目标必须是普通会话；取消不会删除已创建的空会话。细节见设计文档，避免在本规则重复维护完整状态说明。

## 模块外接入清单

修改以下接入点时同步检查本表及其宿主升级契约；上游文件只保留必要接线。

| 文件 | 函数或位置 | 接入职责 |
| --- | --- | --- |
| `lib/rpc-manager.ts` | Node imports、`initializeWakeups()`、普通分支 `extensionFactories` | 初始化服务级 runtime，并仅为普通会话注册工具。 |
| `lib/rpc-manager.ts` | `AgentSessionWrapper.start()`、unsubscribe、abort／`clear_queue` | 订阅原始 SDK 事件，释放 observer，Stop/Recall 时通知模块并中止未提交准备。 |
| `lib/rpc-manager.ts` | `RpcSessionStartOptions.requireExistingSession` 及实际 open 前 | 定时投递严格重开并核对 ID，禁止 SDK 为已删目标创建替代文件；其他调用保持原语义。 |
| `lib/rpc-manager.ts` | `acquirePromptAdmission()`、`shellRunning`、`beginCustomMessageSubmission()` | 复用宿主 admission、shell 状态与提交计数，不另建会话锁或注册表。 |
| `instrumentation-node.ts` | `registerNodeInstrumentation()` | Node 服务启动时初始化恢复；错误写日志，不改其他 instrumentation 初始化。 |
| `app/api/tsgw/wakeups/route.ts`、`[wakeupId]/route.ts` | GET | 模块专用只读查询，统一投影、禁缓存、非法过滤返回 400。 |
| `components/AppShell.tsx` | 模块 import、当前会话顶栏、`activeTopPanel`/`toggleTopPanel`、共享面板槽位 | 接入独立 wakeup 按钮、受控开关及 portal 容器；沿用共享顶面板互斥和布局，不在宿主组件实现任务列表或调度。 |
| `lib/message-display.ts` | `isMessageGroupAnchor()` | 让 wakeup 通知保持独立消息锚点，不改写其他上游分组语义。 |
| `package.json` | `scripts.test`、`files` | 发现 `tsgw/**/*.test.mjs` 并将技能资源包含在包中。 |
| `AGENTS.md`、`tsgw/AGENTS.md`、`docs/agents/tools.md` | 模块索引 | 仅维护专用入口、行为文档和技能的链接索引。 |
| `docs/tsgw-wakeups-design.md` | 当前设计 | 维护用户目标、数据流、状态语义与设计限制。 |

## 宿主依赖与升级复核

- `lib/session-reader.ts` 提供路径解析、会话路径缓存和列表缓存；`lib/allowed-roots.ts` 提供文件访问根。新会话仅调用现有 helper，不在模块外复制缓存或路径策略。
- `lib/subagents.ts` 的 `SUBAGENT_META_TYPE` 是子代理识别依据。普通 fork/side session 不因 `parentSession` 被拒绝；严格重开必须在实际 `SessionManager.open()` 前核对目标文件与 ID。
- SDK 的 `custom_message` 进入模型上下文；wakeup 审计 custom entry 不进入上下文。不要混淆两者，也不修改公共扩展 API 或 SDK 私有字段。
- wrapper owner、启动/关闭、prompt admission、MCP、Stop/Recall、压缩和 shell 时序变化时，复核 `host.ts` 与 `session-owner.ts`。投递接受边界、`agent_settled`、重试/compaction、entry 落盘和消息/entry 关联变化时，复核 observer 与真实 SDK 回归。
- `clearQueue()` 不提供逐条 custom 通知标识；不得据其结果展示逐条已撤回。调度 owner 锁不解决多进程同时写同一会话，也不保证恰好一次执行。
- Node instrumentation、进程信号、HMR 复用、`proper-lockfile` stale/update 与原子文件写入方式变化时，复核恢复、失锁暂停和旧 owner 禁写约束。
- codemode exposure、显式激活及恢复工具集、资源发现/重载和 launcher 包根 cwd 变化时，复核工具可见性；npm `files` 变化时，确认技能资源仍进入包。
- `message-display.ts` 的 wakeup 锚点应与上游通知分组逻辑并存。未来计时器不计入 `subagentsActive`，不改变上游轮次完成语义。
- 顶栏 `activeTopPanel`、共享容器定位、窄屏 More、Agents/侧聊和 MiniStrip 行为变化时，复核 wakeup 互斥接线；面板内部继续由模块实现。`ui.test.mjs` 运行真实 React 与隔离 Chromium；`e2e.mjs` 在本 worktree 独占 Next dev 中核验真实 AppShell，仅用合成会话、只读查询与本地 CAT 拦截。

## 验证命令

以下命令在仓库根目录运行，按改动范围选用；开发工作树禁止执行 `next build`。

```bash
node --experimental-strip-types --test "tsgw/wakeups/*.test.mjs" lib/rpc-manager-side.integration.test.mjs app/api/sessions/rename-route.test.mjs lib/message-display.test.mjs
node_modules/.bin/tsc --noEmit --incremental false
npm run lint
npm test
git diff --check
# 显式浏览器回归：本 worktree 无其他开发服务，安装本地 Chromium
node tsgw/wakeups/e2e.mjs
```

存储性能测量为显式操作，不属于默认测试：

```bash
WAKEUP_STORE_BENCHMARK=1 node --experimental-strip-types --test tsgw/wakeups/store.performance.test.mjs
```

验证应覆盖持久化故障与暂停、owner 竞争和失锁、未知不重投、目标删除不重建、SDK 通知与运行观察、Stop/MCP/admission、普通项目目标创建、只读 API 与健康分页、技能打包以及 UI。测试仅使用临时 agentDir、项目、faux provider 和隔离浏览器；不得向真实模型发送请求或操作真实 wakeup 状态。真实升级、pending 迁移、服务重启、发布和部署均按各自授权边界处理。
