# Targeted notice dismissal

## 公共入口

`index.ts` 统一导出 `NoticeDismissButton` 和 `useNoticeDismiss`；宿主使用 `@/tsgw/notice-dismiss`，不依赖内部文件路径。

## Scope and implementation
Adds an individual close button and a stable callback to remove exactly one notice and clear only that notice's pause. Existing notice state, queues, expiry, focus/hover pause and rendering belong to upstream.

## 单卡关闭契约

共享 `NoticeShelf` 卡片使用本地化 Close 按钮，触控目标为 44px。`dismissNotice(id)` 通过既有 reducer 仅移除目标卡片，从 pending notices 补位，并且仅当暂停属于该卡片时清除暂停。自动过期、hover/focus 暂停及用量内容保持不变。

根 [模块索引](../AGENTS.md)与 [sessions 主题索引](../../docs/agents/sessions.md#compact-message-usage)指向本模块；跨模块浏览器回归见 [消息用量模块](../message-usage/AGENTS.md)。

## External integration inventory
| File / function | Integration |
| --- | --- |
| `hooks/useAgentSession.ts` / notice controls | Calls `useNoticeDismiss` with the existing reducer dispatch and pause setter; returns the callback. |
| `components/ChatWindow.tsx` / NoticeShelf | Renders `NoticeDismissButton` with the existing notice id and callback. |

## Host dependencies and upgrade checks
Keep the reducer's `remove` action, refill behavior and React dispatcher identities. Do not copy the upstream notice shelf or reducer into the fork module. Use the existing `chat.close` translation and preserve button geometry and accessibility.

## Verification
`node --test tsgw/notice-dismiss/*.test.mjs`

The usage module's `usage-notice.mjs` is the shared browser regression for detail cards, scrolling, expiry and individual dismissal.
