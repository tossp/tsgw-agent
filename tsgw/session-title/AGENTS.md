# Session title prompt

## Scope and implementation
Only the fork's title instruction lives here: retain transcript-supported task dates, periods and deadlines, express dates briefly, follow explicit corrections and never infer calendar dates without a reliable reference.

## External integration inventory
| File / function | Integration |
| --- | --- |
| `lib/session-title.ts` / buildTitleRequest | Imports `TITLE_PROMPT` and appends it to the upstream bounded transcript. |

## Host dependencies and upgrade checks
Keep the upstream request builder, model/thinking selection, timeouts, transcript budget, usage accounting and auto-name route. No current-date injection, extra request or title post-processing. Changes to the upstream prompt contract require review of this text, not a copy of the generator.

## Verification
`node --test lib/session-title.test.mjs`
