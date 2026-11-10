# Running subagent status

## Scope and implementation
Independent chat-tail status, task descriptions, soft three-colour animation and reduced-motion fallback. Uses the existing family and running-id snapshots; no request, completion protocol or main-agent phase ownership. Includes nested subagents and excludes side chats.

## External integration inventory
| File / function | Integration |
| --- | --- |
| `components/AppShell.tsx` / active family | Calls `getRunningSubagents()` with upstream family members and running ids. |
| `components/ChatWindow.tsx` / chat tail | Renders `RunningSubagentsStatus` between unchanged upstream phase and command blocks. |
| `lib/i18n/messages/{en,zh-CN,zh-TW}.ts` | Spreads this module's translations into the existing locale. |
| `public/icons/pi-blocks-{running,still}.svg` | Next public assets; stable URL and original bytes, not duplicated here. |
| `e2e/run.mjs` | Calls the module's existing fixture-driven browser check. |

## Host dependencies and upgrade checks
Preserve `SessionInfo`, upstream family grouping, side-chat Agents badges, polling and both host status blocks. The persisted subagent status is not a live running signal. Keep public assets accessible at their existing URLs.

## Verification
`node --test tsgw/subagent-status/*.test.mjs lib/session-family.test.mjs`

The shared E2E runner exercises this status at desktop and phone widths without model dispatch. Its script is `subagent-status.mjs`; `pi-blocks-icon.mjs` checks the native SVG animation.
