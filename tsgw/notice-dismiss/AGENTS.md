# Targeted notice dismissal

## Scope and implementation
Adds an individual close button and a stable callback to remove exactly one notice and clear only that notice's pause. Existing notice state, queues, expiry, focus/hover pause and rendering belong to upstream.

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
