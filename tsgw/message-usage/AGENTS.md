# 消息用量模块

## 范围、入口与边界

- `MessageUsage.tsx` 提供 `MessageUsage`、`UsageDuration`、`usageDetailsText`；`UsageIcon.tsx` 提供 `UsageIcon` / `UsageIconKind`。`message-usage.ts` 提供 `MessageUsageSummary`、格式化、实际平均速度、整轮汇总与摘要比较。
- 保持既有完整行为：最终答案汇总原始整轮，过程步骤保留单响应；费用向零截断至最多四位；缺失或无效用量/时间不猜测速度；只读展示没有无效按钮。细节只消费已载入响应，不查询模型配置、会话文件或历史思考档位。
- 流式文本估算、上游完成通知、会话管理、持久化和 notice 调度不是本模块职责；不复制这些宿主实现。
- `messages.ts` 由主代理归集三语言专属文案，宿主语言包薄 spread 接入；组件继续通过 `useI18n` 取文案，不另建运行时或注册器。
- 测试与独立浏览器回归同目录平铺；旧专有文件已迁走，不留 re-export 兼容壳。旧 `docs/` 不在本轮迁移范围，映射等待用户确认。

## 模块外接入清单

| 文件 / 具体接入 | 原因与类别 |
| --- | --- |
| `components/MessageView.tsx`：导入 `MessageUsage`、`UsageDuration`、`UsageIcon`、`sameUsageSummary` / `MessageUsageSummary` | 本轮更新路径；`AssistantMessageView`、`AssistantMessageHeader`、`Props` 和 memo 比较继续消费原接口。必要调用接线，不改消息分派、流式估算或工具显示。 |
| `components/ChatWindow.tsx`：`summarizeTurnUsage` / `MessageUsageSummary` 导入；`renderMessage`、`showUsageDetails` | 主代理更新导入。沿用原始消息范围与 `getTurnDurationMs`，通过既有 `addNotice({ message })` 展示精确用量；保留过程/答案拆分与去重。必要调用接线。 |
| `components/AppShell.tsx`：`UsageIcon` 导入、工具栏与移动端统计 | 主代理更新导入；只改路径，不改变原统计来源、格式化或图标方向。必要调用接线。 |
| `lib/i18n/messages/{en,zh-CN,zh-TW}.ts`：本模块专属 `chat.usage*` 文案 | 主代理迁至 `messages.ts` 后薄 spread；共享的 `session.*`、`chat.turnDuration` 留宿主。文案接入，不新增语言机制。 |
| 原 `components/{MessageUsage.tsx,MessageUsage.test.mjs,UsageIcon.tsx}`、`lib/{message-usage.ts,message-usage.test.mjs}`、`e2e/usage-notice.mjs` | 主体及测试用 mv 归集到本模块；修复导入、源码文本定位和 E2E 项目根目录推导。 |

无新增后端、共享实现重构或生命周期接管。本模块不修改 `hooks/useAgentSession.ts`、`e2e/run.mjs`、package 或根文档；共享点由主代理统一处理。

## 宿主依赖与升级复核

- `lib/types.ts`：`AgentMessage`、`AgentUsage`、`AssistantMessage` 的 usage / cost / timestamp / durationMs / stopReason / errorMessage。升级检查实际记录语义，不从展示值反推原始用量。
- `lib/turn-duration.ts`：`formatTurnDuration` 与整轮计时契约；宿主必须传与汇总范围相同的原始毫秒，不能用格式化秒数计算速度。
- `hooks/useI18n.tsx`、`lib/i18n/registry.ts`、宿主三语言包：翻译入口、语言切换和共享统计标签；文案归集不改变 key、值或 fallback。
- `components/MessageView.tsx`：响应/整轮作用域、静态渲染和 memo 比较；`components/ChatWindow.tsx`：原始消息范围、无 anchor 时不伪造整轮时间、最终响应过程副本不重复 footer。
- `components/ChatWindow.tsx` 的 `NoticeShelf`、`hooks/useAgentSession.ts` 的 `addNotice` / 暂停 / 自动过期，以及 `tsgw/notice-dismiss/` 的单卡关闭是跨模块边界。`usage-notice.mjs` 同时覆盖独立关闭、键盘/触控、暂停与恢复过期；不把该跨模块回归删成单模块测试。
- React 提供组件与 JSX；测试用 `jiti`（启用 tsconfigPaths）和 `react-dom/server` 加载并渲染真实实现，不 mock 汇总逻辑。E2E 消费 Playwright、Next dev CLI、既有 sessions / agent API 和临时 JSONL 夹具；只起受控回环开发服务，不运行模型、不写真实用户会话。CAT 接入归宿主，模块不接线。
- `package.json` 现有 `tsgw/**/*.test.mjs` glob 已发现本模块测试，无需新增脚本或依赖。

## 验证与验收

```sh
node --experimental-strip-types --test tsgw/message-usage/*.test.mjs components/MessageView.test.mjs
node_modules/.bin/eslint components/MessageView.tsx tsgw/message-usage/*.{ts,tsx,mjs}
node_modules/.bin/tsc --noEmit --incremental false
node tsgw/message-usage/usage-notice.mjs
```

- 浏览器回归独占当前 checkout 的 Next dev；与其他模块串行运行，不删除其他进程的 lock。仅在宿主接线稳定、无真实凭据 env 文件时执行，产物仍在 `test-results/usage-notice/`。
- 验收：单响应/整轮、费用各项、零值、旧数据、缺时长/用量、精确提示、同内容多卡、独立关闭/自动过期、桌面/手机均保持。源码文本测试仍读取实际 `components/ChatWindow.tsx`，不改成替代实现。
- 目录归集时两模块加 `MessageView.test.mjs` 合计 81/81 真实测试通过；TypeScript noEmit 与定向 ESLint 通过；首次主动 LSP 未报类型错误，既有 inline-style 提示保留，复查的 push-only 静默结果不单独作为 clean 证据。独立 E2E 已做语法检查，浏览器执行及全仓集成检查由主代理在共享接线稳定后统筹；本轮不运行构建。既有行为说明/验收记录仍在 `docs/agents/sessions.md` 的 Compact message usage 章节，不另建重复台账。
