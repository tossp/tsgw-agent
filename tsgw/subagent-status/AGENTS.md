# Running subagent status

## 公共入口

`index.ts` 统一导出 `RunningSubagentsStatus` 和 `getRunningSubagents`；宿主使用 `@/tsgw/subagent-status`。`messages.ts` 保持纯数据专用入口，语言包直接读取它，避免 locale → 组件 → `useI18n` 循环。

## Scope and implementation
Independent chat-tail status, task descriptions, soft three-colour animation and reduced-motion fallback. Uses the existing family and running-id snapshots; no request, completion protocol or main-agent phase ownership. Includes nested subagents and excludes side chats.

## Chat-tail behavior

- `RunningSubagentsStatus` only shows the current family’s running subagent count and dispatch descriptions in parentheses in its own block below the main phase label. The original main phase and shell-command JSX remains unchanged in `ChatWindow`, including its conditions, styles and pulse; the new component takes no main-agent or command status. A decorative 1rem native SVG (`public/icons/pi-blocks-running.svg`) sits before only the subagent line. Its original three solid-colour blocks stay fixed while opacity crossfades clockwise (coral → yellow → blue), using a 450 ms `ease-in-out` cycle with 150 ms phase offsets. Each block fades from full opacity to 0.3 over the first third, stays dim for the middle third, then fades back to full opacity, matching the selected soft-fade preview without a jump at the cycle boundary; no JavaScript timer, raster conversion or whole-icon rotation. A tight viewBox fills the 1rem box, which follows the root font size (14 px at the default). A `<picture>` source selects `public/icons/pi-blocks-still.svg` under `prefers-reduced-motion`, showing all three blocks at full opacity; Chromium did not apply the embedded SVG's media query when loaded as an image, so the image source must actually be static. The running SVG also keeps its media query for direct document viewing. The line stays visible while the main agent streams or is idle, and disappears with its icon when no subagents run. Long descriptions wrap beside the non-shrinking icon rather than requiring a hover or opening Agents.
- `AppShell` passes `getRunningSubagents()` from the existing family and running-id poll; the count and descriptions include only real subagents (including nested descendants), never side chats, with no new request. The upstream Agents badge continues to include both hidden family kinds. Persisted status can lag, so running ids, not `relation.status`, decide membership. Completed, failed, aborted and interrupted runs drop out on the next poll; queued/MCP preparation is not a running wrapper yet. Blank descriptions fall back to the profile.

## External integration inventory
| File / function | Integration |
| --- | --- |
| `components/AppShell.tsx` / active family | Calls `getRunningSubagents()` with upstream family members and running ids. |
| `components/ChatWindow.tsx` / chat tail | Renders `RunningSubagentsStatus` between unchanged upstream phase and command blocks. |
| `lib/i18n/messages/{en,zh-CN,zh-TW}.ts` | Spreads this module's translations into the existing locale. |
| `lib/sidebar-actions.test.mjs`：三语言夹具加载 | 沿用该测试已有的 Jiti 读取实际语言包，支持模块文案的无扩展名导入；不修改生产逻辑或测试断言。 |
| `public/icons/pi-blocks-{running,still}.svg` | Next public assets; stable URL and original bytes, not duplicated here. |
| `e2e/run.mjs` | Calls the module's existing fixture-driven browser check. |

## Host dependencies and upgrade checks
Preserve `SessionInfo`, upstream family grouping, side-chat Agents badges, polling and both host status blocks. The persisted subagent status is not a live running signal. Keep public assets accessible at their existing URLs.

## Verification
`node --test tsgw/subagent-status/*.test.mjs lib/session-family.test.mjs`

The shared E2E runner exercises this status at desktop and phone widths without model dispatch. Its script is `subagent-status.mjs`; `pi-blocks-icon.mjs` checks the native SVG animation.
