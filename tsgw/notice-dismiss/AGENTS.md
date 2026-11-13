# Targeted notice dismissal

## 公共入口

`index.ts` 统一导出 `NoticeDismissButton` 和 `useNoticeDismiss`；宿主使用 `@/tsgw/notice-dismiss`，不依赖内部文件路径。

## Scope and implementation
Adds an individual close button and a stable callback to remove exactly one notice and clear only that notice's pause. Existing notice state, queues, expiry, focus/hover pause and rendering belong to upstream.

## 单卡关闭契约

共享 `NoticeShelf` 卡片使用本地化 Close 按钮，触控目标为 44px。`dismissNotice(id)` 通过既有 reducer 仅移除目标卡片，从 pending notices 补位，并且仅当暂停属于该卡片时清除暂停。自动过期、hover/focus 暂停及通知内容保持不变。

根 [模块索引](../AGENTS.md)与 [sessions 主题索引](../../docs/agents/sessions.md#targeted-notice-dismissal)指向本模块。浏览器回归在同目录 `e2e.mjs`，用夹具扩展的真实 `ctx.ui.notify` 生成通知卡，不依赖消息用量按钮或其他模块。

## External integration inventory
| File / function | Integration |
| --- | --- |
| `hooks/useAgentSession.ts` / notice controls | Calls `useNoticeDismiss` with the existing reducer dispatch and pause setter; returns the callback. |
| `components/ChatWindow.tsx` / NoticeShelf | Renders `NoticeDismissButton` with the existing notice id and callback. |

## Host dependencies and upgrade checks
Keep the reducer's `remove` action, refill behavior and React dispatcher identities. Do not copy the upstream notice shelf or reducer into the fork module. Use the existing `chat.close` translation and preserve button geometry and accessibility.

## Verification
```sh
node --test tsgw/notice-dismiss/*.test.mjs
node tsgw/notice-dismiss/e2e.mjs
```

`e2e.mjs` 自起独占的 loopback `next dev`、私有临时 agent dir 和一份夹具扩展；夹具命令调用真实 `ctx.ui.notify`，经既有 extension notify 路径进入通知货架。发送前先用真实 `get_commands` 确保会话 wrapper 启动并核验 `e2e-notices` 已作为 extension command 注册，命令由 SDK 分发而不经过模型。回归覆盖 `MAX_NOTICES` 队列轮转与补位、单卡独立关闭（鼠标、Tab + Space、375px tap）、hover/focus 暂停及按剩余时间恢复过期、Close 的本地化标签与 44px 触控目标。脚本不导入语言包或用量模块，只依赖 en-US 界面的既有 `Close` / `Send` / `Stop agent` 文案；不新增后端接口；Node 侧 CAT 经 `../release/smoke-cat.mjs` 的 `startCatCapture` 重定向到本地收集器，浏览器 CAT 由同一夹具接收，finally 校验无旁路并关闭收集器；结束时有界关闭浏览器与开发服务，并复查本次端口已释放。产物在 `test-results/notice-dismiss/`。

宿主升级时复核 `MAX_NOTICES`（5）、`NOTICE_VISIBLE_MS`、`NOTICE_EXIT_ANIMATION_MS`、`.notice-shelf-item` 结构、`onPauseChange` / `onDismiss` 接线和 `chat.close` 文案，变化后重跑该浏览器回归。本回归不依赖消息用量模块，也不与其共享夹具，该模块删除后仍可独立运行。
