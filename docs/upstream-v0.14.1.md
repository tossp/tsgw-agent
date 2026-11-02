# v0.14.1 上游同步记录

## 固定边界与批准范围

- fork 基线：`c056184ec43513b14d7f205cac21f38aecaf87d1`，分支 `tsgw`。
- 上游目标：`agegr/pi-web` 的 `v0.14.1`，提交 `506168bf11dc444c02aea9cf9c85ca63755b8e0f`；包含此前取消发布的 v0.14.0 改动。
- 独立工作树：`/root/proj/pi-web-v0.14.1`，分支 `integrate/v0.14.1`。本轮授权为整合、验证、提交及合回本地 `tsgw`；不推送、不打发布标签、不发布、不部署。
- 用户明确原则：上游功能与行为完整保留，fork 仅做增项；冲突时适配 fork，不禁用上游能力、不保留旧替代实现、不默认收紧上游行为。此原则已写入根 `AGENTS.md`。
- 包名、CLI、源版本、七个 Pi 包的精确版本、OIDC、登录与 CAT 配置保留 fork 定制；本轮不升级依赖、不改用户配置或会话。

## 上游功能完整接入

| 范围 | 整合结果 |
| --- | --- |
| 侧聊 | 完整保留 `/side`、运行中入口、选文侧聊、Agents 入口、隐藏家族关系、上下文边界、工具 allow-list、独立统计与通知静默。 |
| 子代理面板 | 采用完整 `SessionChatPanel`，接受其运行时启动与继续对话行为；不恢复旧只读 `SubagentViewer`。 |
| 文件与排版 | 保留 Git 改动目录树、文本默认换行、HTML 内存 storage、扩展消息终端排版与手机操作按钮折叠。 |
| PWA 与角标 | 采用 manifest 显式路由与携带凭据的链接；保留三色 Pi 品牌，新增角标在同一 SVG 底图绘制。 |
| 运行时 | 保留工具顺序、子代理中断状态收尾、候选会话提示及模型运行时缓存更新。 |
| Docker | `Dockerfile`、`compose.yaml`、`.dockerignore`、`.env.example`、容器工作流与上游一致；不新增仓库守卫或禁用标签触发。未来正式标签可能同时触发容器发布，本轮未推送标签。 |

侧聊是工具缩减而非安全沙箱：可能保留父会话已有的 bash／PowerShell，不能声称不会写文件；只读父会话仍无 shell。侧聊不能嵌套或 fork，不能自动把回答送回父会话，沿用上游边界。

## fork 增项适配

- `AppShell`／`ChatWindow` 保留独立运行状态块、任务描述、用量汇总、平均速度、四位费用截断及单张提示卡关闭；不改主阶段、完成通知或侧聊接线。
- `getRunningSubagents()` 只给 fork 状态块返回真实子代理；上游 Agents 徽章仍包含运行中的侧聊与子代理。
- `UserMessageView` 继续独立维护 Source／Rendered 切换、HTML 文本化和图片／技能展示，并接入上游窄屏操作标签折叠。浏览器测试改用稳定的 Copy message 标题定位，保留原有四按钮、图标、复制与视口边界断言。
- `lib/rpc-manager.ts` 并列保留上游 `sideChat` 与 fork `agentTracing`，以及原有 wakeups 写入协调，不替换上游生命周期。
- Debug 大盘仅在 `tsgw/debug/` 根据现有 `relation.kind` 识别侧聊，不改变 Debug API 或上游面板。目录尚未返回时，既有布尔标志无法区分侧聊／子代理，继续显示原回退及目录错误提示；精确后端角色契约不在本轮范围。
- wakeups 不增加侧聊目标禁令：普通会话能调度已有侧聊；侧聊自身四工具仍受上游 allow-list 排除；严格重开保留限制与通知静默，删除后不重建。
- Agent tracing 沿用每 wrapper 独立会话／根 trace；本轮不新增侧聊父级字段、正文映射或采集策略。

## 验收结果（2026-11-02）

- 全量：`setpriv --bounding-set=-dac_override,-dac_read_search -- npm test`，3467 项通过、0 失败、1 项原有平台跳过。仅对测试进程去除 root 权限绕过能力，未修改测试断言。
- `node_modules/.bin/tsc --noEmit --incremental false`、`npm run lint` 通过；11 个核心 TypeScript 文件主动 LSP 检查全部 clean。
- 独立前端定向 164/164、Debug 模块 61/61、发布与 CAT 归档契约 100/100 通过；新增侧聊 wakeups 两项真实 SDK／faux provider 集成回归纳入全量。
- `node e2e/run.mjs`：桌面／手机主回归通过，并新增两种视口 `/side` 创建、上下文边界、完整面板输入框、草稿隔离、隐藏侧栏关系及真实工具列表验证；手机使用发送按钮，遵守原生换行行为。
- `node e2e/user-message-render-toggle.mjs`：桌面／375px 消息切换、复制、键盘、图片、技能及长消息通过，合成会话正文未变化。
- `node e2e/usage-notice.mjs`：桌面／375px 用量、整轮统计、速率、费用与提示卡独立关闭通过。
- `node e2e/login2.mjs`：登录动画、语音、已有与失效会话、回跳及多语言布局通过。
- `node e2e/cat-monitoring.mjs`：固定配置、认证边界及浏览器 SDK envelope 通过；本地拦截，未验证生产 CAT 摄入或源码映射。
- `E2E_BASE_URL=<隔离临时开发服务> node tsgw/debug/e2e.mjs`：24/24 检查通过，191 次夹具 GET、0 禁止操作；覆盖桌面／手机、故障恢复、目录关系、轮询与网络只读边界。
- 独立只读审阅未发现确定新增阻塞问题；另行运行消息、家族与 manifest 定向 17/17 通过。

## 验证限制与本地证据

- 所有模型集成使用本机 faux provider；遥测测试使用内存 transport 或本地浏览器拦截，不主动外发 AI 测试数据、不使用用户会话或凭据。
- 未运行 `next build` 或 Docker 构建，未验证 OS 层实际 PWA 安装、GHCR 发布、远程 CI 或部署。Docker 构建应使用干净检出，不把本机私有上传凭据带入构建上下文。
- Turbopack 拒绝指向工作树外的 `node_modules` 软链接；验证改为复制原依赖树，未修改依赖或 Next 配置。
- 证据位于整合工作树 `test-results/e2e/`、`test-results/usage-notice/`、`test-results/login2/`、`test-results/tsgw-debug/`，以及 `/tmp/pi-web-v0141-final-tests.TLrvfe.log`；均不提交生成工件。
