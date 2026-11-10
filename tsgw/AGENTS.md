# TSGW fork 模块规则

## 目录与职责

- fork 自有功能的主体代码及对应测试放在根目录 `tsgw/<模块名>/`，以功能模块为边界，不继续平铺到上游 `lib/`、`components/` 等目录。跨模块调整按实际职责逐项维护，不顺带迁移无关功能。
- 模块内先平铺；按真实职责、规模或运行环境需要再拆子目录，不预设 `services/`、`utils/` 等层级，不为未来需求建立通用框架或统一注册器。
- 每个模块必须有自己的 `AGENTS.md`。本文件规定统一要求，模块规则补充具体边界。

## 公共入口与文档索引

- 模块对外的 TypeScript API 统一经 `index.ts` 导出；外部调用使用 `@/tsgw/<模块名>`，模块内部可直接引用实现文件。公开入口不是导出全部内部文件的聚合器。
- 按运行环境保留必要专用入口：CAT 和 login2 的 Node-only helper 走 `server.ts`；CAT 的 `browser-init.ts`、`server-init.ts`、`next-config.mjs`、`global-error.tsx` 保持专用。Agent tracing 的初始化 policy 独立于 tracer 公共入口。
- `message-usage`、`user-message-view`、`subagent-status` 的 `messages.ts` 是纯数据专用入口，不经过组件 `index.ts`，避免 locale → 组件 → `useI18n` 的循环依赖。
- release 使用原生 CommonJS `index.js` 与 `index.d.ts`，外部 CLI/API 使用模块根路径或显式 `index.js`；不保留旧文件的转发壳。构建、归档与补传的 `.mjs` 脚本仍是显式命令入口。
- 模块规则集中在各模块 `AGENTS.md`；用户行为、设计或操作文档按真实职责同模块存放。文档不超过 500 行，不另建重复计划或状态台账。固定根主题文档只保留 fork 薄索引，上游其余段落及历史 `docs/upstream-v*.md` 验收事实保持完整。以下命令均在项目根运行。

| 模块 | 公共 API / 专用入口 | 正式文档 |
| --- | --- | --- |
| [cat-monitoring](cat-monitoring/AGENTS.md) | `index.ts`：跨环境 capture；`server.ts`：`getCatConfig`；环境初始化、Next 配置和 error boundary 独立 | [构建归档与补传](cat-monitoring/BUILD.md) |
| [login2](login2/AGENTS.md) | `index.ts`：页面默认导出；`server.ts`：来源 IP helper | [行为与素材](login2/README.md) |
| [release](release/AGENTS.md) | `index.js` / `index.d.ts`：包身份及更新通道；`.mjs`：显式构建命令 | [发布说明](release/README.md) |
| [branding](branding/AGENTS.md) | `index.ts`：图标 URL、metadata 与 manifest 图标 | 模块规则 |
| [message-usage](message-usage/AGENTS.md) | `index.ts`：组件、图标、计算 helper 与 type；`messages.ts`：纯文案 | 模块规则 |
| [user-message-view](user-message-view/AGENTS.md) | `index.ts`：组件、文本替换 helper；`messages.ts`：纯文案 | 模块规则 |
| [subagent-status](subagent-status/AGENTS.md) | `index.ts`：状态组件与筛选器；`messages.ts`：纯文案 | 模块规则 |
| [notice-dismiss](notice-dismiss/AGENTS.md) | `index.ts`：关闭按钮与 hook | 模块规则 |
| [session-title](session-title/AGENTS.md) | `index.ts`：`TITLE_PROMPT` | 模块规则 |
| [debug](debug/AGENTS.md) | `index.ts`：`DebugPage` | [信息覆盖、设计与验收](debug/DESIGN.md) |
| [cors](cors/AGENTS.md) | `index.ts`：Origin 匹配、Host 合并、CORS proxy 包装 | [配置与接入](cors/README.md) |
| [agent-tracing](agent-tracing/AGENTS.md) | `index.ts`：tracer、`createTracingAgentSessionFromServices`；`policy.ts`：初始化策略 | 模块规则 |
| [wakeups](wakeups/AGENTS.md) | `index.ts`：`createSessionOwnerAccess`、`createWakeupExtension`、`getWakeupRuntime` | [行为、技能与验证](wakeups/README.md) |

### wakeups

[模块规则](wakeups/AGENTS.md)与[行为说明](wakeups/README.md)维护现有契约。公开宿主入口为 `index.ts`；运行时、会话写入与生命周期约束仍以模块规则为准。

## 接入与上游改动清单

模块的 `AGENTS.md` 必须列明：

1. 功能范围、明确排除的能力、入口及对外接口。
2. 为接入功能而修改的全部模块外文件，尤其是上游文件；逐项写出具体函数、类型、配置项或文档章节，以及修改原因。
3. 区分必要注册、调用、生命周期衔接与共享代码调整；共享调整必须说明必要性及影响，不能以复用为由顺带改写无关上游流程。
4. 模块依赖但未修改的宿主接口，以及升级上游时需要重新核对的行为。
5. 可执行的验证命令、验收条件与已知验证限制；验证证据引用项目已有记录，不另建重复台账。

修改任意接入点时，同步更新模块清单。不要把文件挪入本目录就宣称完成解耦：宿主依赖必须明确、可检查。

上游文件尽量只保留必要注册、调用和生命周期衔接。不得为了减少表面改动而复制会话管理、发送机制或另建一套注册表、锁及状态机。跨环境共享常量也不得引入浏览器对服务端模块的依赖。

## 验证与操作边界

- 模块测试与代码同目录存放；根 `package.json` 的 `scripts.test` 必须包含 `tsgw/**/*.test.mjs`，目录调整后检查包括 release 在内的全部模块测试确实被发现，不排除发布 fixture；release 与 CAT 在 CI 中另有显式定向入口。
- 按改动范围运行真实实现测试、TypeScript 检查和 lint；禁止在开发工作树执行 `next build`。不得通过跳过原有失败用例或降低检查来宣称通过。
- 保持项目既有权限边界；目录整理不代表已获提交、合并、推送、发布或部署授权。
