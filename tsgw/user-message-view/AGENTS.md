# 用户消息显示模块

## 公共入口

`index.ts` 统一导出 `UserMessageView`、`replaceUserMessageText`；宿主使用 `@/tsgw/user-message-view`。`messages.ts` 保持纯数据专用入口，语言包直接读取它，避免 locale → 组件 → `useI18n` 循环。

## 范围、入口与边界

- `UserMessageView.tsx` 提供 `UserMessageView` 和 `replaceUserMessageText`。保留宿主已有复制、编辑、取消编辑、新会话、时间、附件、技能紧凑显示/展开、CRLF/lone CR 显示归一化；默认 Markdown 渲染，增加的 Source / Render 是每个已挂载消息的局部状态。
- v0.16.0 的 `onFork(entryId, editTarget)` 两参数契约必须同步到迁移后的组件：普通消息/仅图片消息传原消息，技能传恢复为 `/skill:` 命令且保留附件的消息，由宿主填入新会话草稿。复制拒绝由失败回调消费，不显示 Copied、不产生未处理的 Promise rejection；只有成功才显示 Copied。
- Source 是 React 文本节点，保持 HTML 标签、实体、模板和 Markdown 的字面值，不走 Markdown/HTML/math 管线；无文本消息不显示切换。复制/编辑技能仍使用命令；切换不发送请求、不改变原始消息或模型输入。
- `messages.ts` 保存三语言 `chat.messageSource` / `chat.renderMessage`，宿主语言包薄 spread；组件继续通过既有 `useI18n` 读取。
- 不接管会话、发送、分支或编辑机制，不另造状态存储或渲染器。旧专有文件已迁走、不留兼容壳；行为细则集中在本模块，`docs/agents/sessions.md` 仅保留固定主题索引。

## Source / Render 细则

- User messages still render Markdown by default. The fourth action names the target view: Source (code icon), then Render (eye icon) while showing source. Only messages with text offer it; the state belongs to that mounted message, not localStorage, settings or session entries.
- Source is a React text child with `white-space: pre-wrap` and wrapping for long lines, never the Markdown/HTML/math pipeline or `dangerouslySetInnerHTML`. It shows HTML tags, `${…}`, entities and Markdown literally. It keeps the existing display normalization of CRLF/lone CR to LF. Skill source shows the full stored expansion; switching back restores the compact skill and its expansion state. Attachments stay available in both views.
- Copy, edit-from-here and fork keep their existing inputs and behavior (a skill still copies/restores its command). Switching view sends no command and never alters model input or saved messages. Actions reveal on hover or keyboard focus; the footer wraps within narrow screens.
- `SafeMarkdownBody.tsx` holds the existing 100,000-character Markdown guard shared by user and assistant views. Returning to Render does not bypass it; expanded skill content uses it too. User-message rendering moved out of the large `MessageView.tsx`; its existing `replaceUserMessageText` export remains available there.
- Checks: `tsgw/user-message-view/UserMessageView.test.mjs` covers default actions, attachment/skill behavior and the large-content guard. `node tsgw/user-message-view/user-message-render-toggle.mjs` uses temporary sessions and an isolated dev server for literal-source fidelity, per-message switching, keyboard controls, copying, and desktop/mobile layout; no model calls.

## 模块外接入清单

| 文件 / 具体接入 | 原因与类别 |
| --- | --- |
| `components/MessageView.tsx`：`UserMessageView` 导入、`replaceUserMessageText` 原出口 | 公共入口接线；用户角色分派继续传入原 props。保留原公开 `replaceUserMessageText` 导出供 `ChatWindow` 和上游测试使用，不改宿主接口。必要调用/出口接线。 |
| `lib/i18n/messages/{en,zh-CN,zh-TW}.ts`：`chat.messageSource` / `chat.renderMessage` | 原语言包直接从本模块纯数据 `messages.ts` 薄 spread。仅文案接入，不改共享动作/guard 文案或 fallback。 |
| `lib/sidebar-actions.test.mjs`：三语言夹具加载 | 沿用该测试已有的 Jiti 读取实际语言包，支持模块文案的无扩展名导入；不修改生产逻辑或测试断言。 |
| 原 `components/{UserMessageView.tsx,UserMessageView.test.mjs}`、`e2e/{user-message-render-toggle.mjs,user-message-render-fixtures.mjs}` | 用 mv 迁入本模块；修复宿主导入及 E2E 项目根目录推导。 |
| `e2e/run.mjs`；`.github/workflows/tsgw-npm.yml` 的 Chromium 安装后步骤 | 显式执行 `user-message-interactions.mjs`；不进入普通单测发现，不要求无浏览器的 checks job 安装 Chromium。 |

`components/MessageView.test.mjs` 的宿主导入和公开出口保持有效；完整保留上游测试，仅追加相关工具结果/时钟的 memo 比较和时钟传递回归。`components/ChatWindow.tsx` 的 `forkFromMessage` 沿用上游：将第二参数解析为草稿文本与图片后交给 `handleFork`，不改成依赖本模块内部；无新增生命周期或后端接入。根 `AGENTS.md`、`tsgw/AGENTS.md`、`docs/agents/sessions.md` 和 `e2e/README.md` 保留模块薄索引。

## 共享代码权衡

- `components/SafeMarkdownBody.tsx` 保持原位、不修改也不复制。它是上游 Markdown 大消息保护的共享拆分，用户消息/技能展开和宿主助手 `TextBlock` 都要消费，100,000 字符 guard、点击显示原文与可滚动区域必须一致。
- 最小做法是本模块向共享组件单向依赖；代价是本模块并非无宿主依赖的独立包，升级需复核 props 和 guard。把它复制到 fork 会分叉安全/性能行为；把唯一实现搬入 fork 会让上游助手主体反向依赖定制模块，两者都不采用。
- `ImagePreview`、`MarkdownBody`、剪贴板、技能解析等通用上游工具同样留在原位，不复制或增加 re-export 壳。

## 宿主依赖与升级复核

- `components/SafeMarkdownBody.tsx` / `MarkdownBody.tsx`：普通用户 HTML 继续采用宿主文本化；Markdown/math 正常渲染；大消息从 Source 切回 Render 后仍受 guard，技能正文展开也不能绕过。
- `components/ImagePreview.tsx`、`lib/types.ts` 的 `UserMessage` / `TextContent` / `ImageContent`：附件预览、两种磁盘图片结构；文本替换不丢附件、不改原消息，兼容性双重断言有就地 SAFETY 依据。
- `lib/clipboard.ts` 的 `copyText`、`lib/slash-display.ts` 的 `skillExpansionToCommand` / `skillExpansionContent`：技能命令复制/编辑、去 envelope 的展开正文与完整 Source 各自语义保持。
- `hooks/useI18n.tsx`、`lib/i18n/registry.ts`、宿主语言包：英/简/繁目标视图标签，复用共享复制/编辑/新会话/展开/guard 文案，不改 key 或值。
- `components/MessageView.tsx`：time 格式化、entryId、cwd/onOpenFile、两参数 onFork、forking、编辑与取消回调原样传递；除迁出用户组件/文本替换 helper、共享 SafeMarkdownBody 引用外，助手/工具主体保持上游实现，包括 toolClocks、相关 entries 的 memo 比较、Stopped 及错误/最终答案去重、复制失败处理和 natural token width / 8ch TPS badge。`ChatWindow` 的 `onSessionEnded`、分支草稿/发送生命周期不归本模块。
- `app/globals.css`：既有 `.message-action-label` 在窄屏隐藏文字、保留 title 与图标；保持 hover/focus 显示、键盘操作、窄屏换行和 300px 消息泡滚动。
- React 提供组件局部状态与 JSX；测试用 `jiti`（启用 tsconfigPaths）和 `react-dom/server` 经宿主 `MessageView` / `I18nProvider` 渲染真实实现。浏览器夹具消费 Playwright、Next dev CLI 与 sessions / agent API；只使用临时 JSONL，不调用模型。CAT 接入由宿主维护，不从本模块接线。
- `user-message-interactions.mjs` 用 Next 自带 webpack 和 TypeScript 将真实 `MessageView`、`I18nProvider` 及其依赖打入临时目录，由 Playwright route 在 Chromium 内加载并点击；不 mock 组件/hook、不起服务、不写 `.next`，仅在复制拒绝/成功场景替换浏览器剪贴板边界。覆盖普通/仅图片/技能消息的 fork 第二参数、编辑目标与附件、forking 禁用、拒绝复制、Source/Render/技能展开及大消息 guard。临时包与浏览器在退出时清理，需已有 Playwright Chromium。
- `package.json` 已有 `tsgw/**/*.test.mjs`；该模式只发现无浏览器的模块单测。组件浏览器检查使用非 `.test.mjs` 专用文件名，由 `e2e/run.mjs` 和 fork 发布工作流在 Chromium 就绪后显式调用；不静默跳过、不增加普通单测的浏览器依赖。

## 验证与验收

```sh
node --experimental-strip-types --test tsgw/user-message-view/*.test.mjs components/MessageView.test.mjs
node_modules/.bin/eslint components/MessageView.tsx tsgw/user-message-view/*.{ts,tsx,mjs}
node_modules/.bin/tsc --noEmit --incremental false
node tsgw/user-message-view/user-message-render-toggle.mjs
node --test tsgw/user-message-view/user-message-interactions.mjs
```

- 独立浏览器脚本会起停当前 checkout 的回环 Next dev，应与其他 E2E 串行并使用隔离环境执行。产物仍在 `test-results/e2e/`；不构建、不使用真实用户会话或模型。
- 验收：默认渲染及 HTML 字面显示、逐消息独立切换、Source fidelity、复制/编辑/新会话、图片、技能折叠/展开、大消息 guard、英简繁标签、键盘与桌面/手机布局均保持。
- 单独组件浏览器回归不等于会话 API/通知货架的端到端回归；后两者仍用各自独立脚本验收。LSP push-only 静默结果不能单独视为 clean，配合 TypeScript noEmit 与定向 ESLint。
