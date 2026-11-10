# Pi branding

## Scope and implementation
Three-colour Pi favicon, transparent Apple Touch PNG, manifest icons and the favicon badge's base image. The upstream manifest, badge counters and service worker remain upstream-owned.

## External integration inventory
| File / function | Integration |
| --- | --- |
| `app/layout.tsx` / metadata.icons | Imports this module's icon metadata. |
| `app/manifest.webmanifest/route.ts` / GET | Uses this module's manifest icon list; preserves runtime app name and other metadata. |
| `lib/favicon-badge.ts` / FAVICON_BASE_ICON_URL | Uses the module's SVG URL without changing badge behavior. |
| `public/sw.js` / install cache | Keeps the SVG and PNG URLs in its offline precache. Classic worker has no TS import. |
| `public/icons/pi-blocks.svg`, `pi-blocks-180.png` | Stable Next public URLs; source files and bytes remain here. |

## Host dependencies and upgrade checks
Next exposes public assets from `public/`; moving them into this module alone would break those URLs. Keep the original SVG shape, PNG 180×180 RGBA, manifest purpose `any`, runtime name, cache behavior and existing icon URLs. Running/still animation assets belong to `subagent-status`.

## Verification
`node --test tsgw/branding/*.test.mjs app/manifest.test.mjs lib/favicon-badge.test.mjs public/sw.test.mjs`
