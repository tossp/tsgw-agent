# 用户消息显示模块

## 范围、入口与边界

- `UserMessageView.tsx` 提供 `UserMessageView` 和 `replaceUserMessageText`。保留宿主已有复制、编辑、取消编辑、新会话、时间、附件、技能紧凑显示/展开、CRLF/lone CR 显示归一化；默认 Markdown 渲染，增加的 Source / Render 是每个已挂载消息的局部状态。
- Source 是 React 文本节点，保持 HTML 标签、实体、模板和 Markdown 的字面值，不走 Markdown/HTML/math 管线；无文本消息不显示切换。复制/编辑技能仍使用命令；切换不发送请求、不改变原始消息或模型输入。
- `messages.ts` 由主代理归集三语言 `chat.messageSource` / `chat.renderMessage`，宿主语言包薄 spread；组件继续通过既有 `useI18n` 读取。
- 不接管会话、发送、分支或编辑机制，不另造状态存储或渲染器。旧专有文件已迁走、不留兼容壳；旧 docs 不搬，文档映射等待用户确认。

## 模块外接入清单

| 文件 / 具体接入 | 原因与类别 |
| --- | --- |
| `components/MessageView.tsx`：`UserMessageView` 导入、`replaceUserMessageText` 原出口 | 本轮只更新路径；用户角色分派继续传入原 props。保留原公开 `replaceUserMessageText` 导出供 `ChatWindow` 和上游测试使用，不改宿主接口。必要调用/出口接线。 |
| `lib/i18n/messages/{en,zh-CN,zh-TW}.ts`：`chat.messageSource` / `chat.renderMessage` | 主代理迁至本模块 `messages.ts`，原语言包薄 spread。仅文案接入，不改共享动作/guard 文案或 fallback。 |
| 原 `components/{UserMessageView.tsx,UserMessageView.test.mjs}`、`e2e/{user-message-render-toggle.mjs,user-message-render-fixtures.mjs}` | 用 mv 迁入本模块；修复宿主导入及 E2E 项目根目录推导。 |

`components/MessageView.test.mjs` 的宿主导入和公开出口保持有效，本轮无需改动。`components/ChatWindow.tsx` 仍从宿主 `MessageView` 使用既有出口，不要求改成依赖本模块内部；主代理统一处理共享文件。无新增生命周期或后端接入。

## 共享代码权衡

- `components/SafeMarkdownBody.tsx` 保持原位、不修改也不复制。它是上游 Markdown 大消息保护的共享拆分，用户消息/技能展开和宿主助手 `TextBlock` 都要消费，100,000 字符 guard、点击显示原文与可滚动区域必须一致。
- 最小做法是本模块向共享组件单向依赖；代价是本模块并非无宿主依赖的独立包，升级需复核 props 和 guard。把它复制到 fork 会分叉安全/性能行为；把唯一实现搬入 fork 会让上游助手主体反向依赖定制模块，两者都不采用。
- `ImagePreview`、`MarkdownBody`、剪贴板、技能解析等通用上游工具同样留在原位，不复制或增加 re-export 壳。

## 宿主依赖与升级复核

- `components/SafeMarkdownBody.tsx` / `MarkdownBody.tsx`：普通用户 HTML 继续采用宿主文本化；Markdown/math 正常渲染；大消息从 Source 切回 Render 后仍受 guard，技能正文展开也不能绕过。
- `components/ImagePreview.tsx`、`lib/types.ts` 的 `UserMessage` / `TextContent` / `ImageContent`：附件预览、两种磁盘图片结构；文本替换不丢附件、不改原消息，兼容性双重断言有就地 SAFETY 依据。
- `lib/clipboard.ts` 的 `copyText`、`lib/slash-display.ts` 的 `skillExpansionToCommand` / `skillExpansionContent`：技能命令复制/编辑、去 envelope 的展开正文与完整 Source 各自语义保持。
- `hooks/useI18n.tsx`、`lib/i18n/registry.ts`、宿主语言包：英/简/繁目标视图标签，复用共享复制/编辑/新会话/展开/guard 文案，不改 key 或值。
- `components/MessageView.tsx`：time 格式化、entryId、cwd/onOpenFile、forking、编辑与取消回调原样传递；`ChatWindow` 的分支/发送生命周期不归本模块。
- `app/globals.css`：既有 `.message-action-label` 在窄屏隐藏文字、保留 title 与图标；保持 hover/focus 显示、键盘操作、窄屏换行和 300px 消息泡滚动。
- React 提供组件局部状态与 JSX；测试用 `jiti`（启用 tsconfigPaths）和 `react-dom/server` 经宿主 `MessageView` / `I18nProvider` 渲染真实实现。浏览器夹具消费 Playwright、Next dev CLI 与 sessions / agent API；只使用临时 JSONL，不调用模型。CAT 接入由宿主维护，不从本模块接线。
- `package.json` 已有 `tsgw/**/*.test.mjs`，无需改测试发现或依赖；`e2e/run.mjs` 是独立宿主入口，不由本模块改写。

## 验证与验收

```sh
node --experimental-strip-types --test tsgw/user-message-view/*.test.mjs components/MessageView.test.mjs
node_modules/.bin/eslint components/MessageView.tsx tsgw/user-message-view/*.{ts,tsx,mjs}
node_modules/.bin/tsc --noEmit --incremental false
node tsgw/user-message-view/user-message-render-toggle.mjs
```

- 独立浏览器脚本会起停当前 checkout 的回环 Next dev，应与其他 E2E 串行并使用隔离环境执行。产物仍在 `test-results/e2e/`；不构建、不使用真实用户会话或模型。
- 验收：默认渲染及 HTML 字面显示、逐消息独立切换、Source fidelity、复制/编辑/新会话、图片、技能折叠/展开、大消息 guard、英简繁标签、键盘与桌面/手机布局均保持。
- 两模块加 `MessageView.test.mjs` 合计 81/81 真实测试通过；TypeScript noEmit 与定向 ESLint 通过；首次主动 LSP 未报类型错误，复查的 push-only 静默结果不单独作为 clean 证据。E2E 已做语法检查，浏览器执行及全仓集成检查由主代理在共享接线稳定后统筹；本轮不运行构建。行为说明/既有验收入口仍见 `docs/agents/sessions.md` 的 User messages: Source / Render 章节，不另建重复台账。
