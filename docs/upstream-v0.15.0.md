# v0.15.0 上游同步记录

## 固定边界与批准范围

- fork 基线：`78578665830c042ff0d3cdd947d274e7c9900d8e`，分支 `tsgw`；包含最新 Debug 家族网格与标题时间修复。
- 上游目标：`agegr/pi-web` 的固定标签 `v0.15.0`，提交 `f130910abf662b506b2ef2f475fc21a2fe57badc`；完整包含 `v0.14.2`。
- 独立工作树：`/root/proj/pi-web-v0.15.0`，分支 `integrate/v0.15.0`。
- 用户批准本地整合、验证、提交并合回 `tsgw`；不推送、不发布、不打标签、不部署或重启服务。
- 上游功能和行为完整保留，fork 只做增项；冲突时适配 fork，不恢复旧替代实现、不新增侧聊限制，不关闭摘要或 tracing 规避兼容问题。

## 上游完整接入与 fork 保留项

| 范围 | 整合要求 |
| --- | --- |
| 侧聊与右侧标签 | 接入按主会话恢复侧聊、删除单个侧聊、统一未命名侧聊编号及混合标签拖动；保留创建迟到归属原父会话和跨项目标签规则。拖动顺序仍仅在页面内保存，不扩展成持久排序。 |
| 模型 | 接入 scoped/all、运行中切模型、提供商显示名、自定义模型排序及 ChatGPT device ID 登录；不改变 session-scoped 选择与默认值保存的边界。 |
| 展示 | 接入新 `AssistantMessageHeader` 的固定高度、等宽数字与列宽；保留独立 `UserMessageView` 的 Source/Rendered、用量明细、整轮统计与四位费用截断。流式估算速度与完成后整轮平均速度不混用。 |
| 手机与扩展 | 接入 Agents 常驻、触控尺寸、逐级全屏设置与系统返回，以及扩展 ANSI 主题；不恢复旧 More 折叠徽章。 |
| 修复 | 接入通知去重、听写粘贴、HTML 导出、Windows PowerShell 和归档空态修复；保留三色 Pi、PWA 与 login2 增项。 |
| 配置语义 | 采用上游 MCP OAuth `auto`、保存的“不信任”决定及无效模型条目清理语义；本次不对用户配置执行清理或迁移。 |
| Debug | 保留最新运行态家族网格、只读 GET 与独立模型采样，不调整后端契约。侧聊仍按目录关系识别，目录缺失时的身份限制不变。 |
| wakeups | 保留 owner/lifecycle 与侧聊既定边界；仅将生产及测试的 `Type` 导入迁到 `typebox`。 |
| tracing | 必须保留 Pi 1.5 的摘要认证路径和自定义 stream 语义；兼容适配主体留在 `tsgw/agent-tracing/`，内部 SDK 依赖与验收记录由模块规则集中维护。 |

## 依赖与发布适配

- 八个 `@earendil-works/*` 包精确锁定为 `1.5.0`，新增 `pi-schema`；`typebox` 固定 `1.3.27`；跟随上游升级 Next.js `16.4.4`、undici `8.12.3` 及相应 ESLint 配置。
- 保留 `tsgw-agent` 包名、CLI、源版本 `0.1.0`、仓库身份、`@sentry/nextjs@11.9.0` 与既有发布契约。
- 锁文件以固定上游锁为基础，由 npm 重新解析 fork 的 Sentry 依赖，不保留冲突文件自动重算引入的无关浮动升级。现有上游包仅 `@types/estree` 因新增依赖关系升至 `1.0.10`，其余原有路径的版本与上游一致。
- 上游容器 job 从 `container.yml` 迁入 `publish.yml`，完整保留 `check-tag` 与 `container`；只给 `npm` job 延续上游仓库条件。fork 的 npm 仍仅通过 `tsgw-npm.yml` 发布，OIDC、CAT 原件归档与独立补传不变。
- Dockerfile 采用上游 `npm ci --ignore-scripts`，不另加 fork 仓库禁令；本次不运行 Docker 构建或镜像发布。

## 验证结果

- 全量 **3552 项通过、1 项原有跳过**；权限相关用例按既有方式撤去测试进程的 DAC override/read-search capabilities，不跳过或改写用例。
- release helper **100/100**；前端定向 **123/123**；tracing **42/42**（含新增真实 Pi 1.5.0 的 **8/8**），tracing／wakeups／宿主定向合计 **185/185**。
- tracing 覆盖手动、threshold／overflow 自动压缩、分支摘要、自定义 stream／真实扩展替换负例、dispose 恢复，以及同轮 A→B 的一个 run、两个模型请求和各自 token／模拟费用归属。来源适配和内部接口约束见模块规则，不重复维护实现细节。
- TypeScript、全仓 ESLint、diff-check 通过；主代理对 8 个相关 TypeScript 文件主动 LSP 检查，全部明确 clean。
- 桌面／手机主浏览器回归通过，包含新流式数字布局、scoped/all 模型选择、自定义模型排序、Source、用量、独立子代理状态和刷新后恢复侧聊。主回归还经真实 Next 开发路由创建 wrapper，覆盖该环境的 SDK 模块身份。
- login2 全套通过；CAT 固定配置和浏览器异常 envelope 本地拦截通过（`live=false`）；Agents 模型行在 1280／390／320px 及简体中文通过。仅适配旧测试入口以跟随手机 Agents 常驻和逐级全屏设置，不修改对应产品行为。
- 最新 Debug 家族网格完整 **45/45**，451 次夹具 GET，0 越界请求；证据目录 `test-results/tsgw-debug-grid/2026-11-06T07-46-08-273Z/`。既有 30145 为其他工作树占用，临时启动器将同一测试的精确 loopback 限制绑定到本次专属随机端口；未连接、停止或修改其他开发服务，仓库测试脚本不变。
- 独立只读复审未发现有证据的阻塞或重要缺陷，并独立复跑真实 SDK **8/8**；核对上游新 Header、侧聊逻辑、发布守卫与锁文件保留完整。提交前另行复核最终暂存差异、模块接入清单与包锁一致性，不纳入生成工件或无关改动。
- 无收费模型、用户真实会话或生产遥测验收。真实供应商 OAuth、生产 Next 产物模块身份、Docker 与跨 OS 行为未在本轮实测，不将其描述为通过。

## 现场限制与证据

- 本机默认 npm `12.0.2` 在锁文件解析时把镜像 registry tarball 误判为禁止的 remote 依赖；未放宽 `allow-remote`，改用已有 Node 工具链所带 npm `11.19.1`。
- 一次镜像依赖下载超时后，确认进程已结束，使用官方 registry 与缓存完成干净安装；不改全局 npm 配置。
- 安装、锁文件与发布 helper 日志位于 `/tmp/pi-web-v0150-*.log`。浏览器证据位于整合工作树 `test-results/`，不提交生成工件。
- 缓存复用时出现与 `vercel/next.js#100251`、`vercel/next.js#100267` 一致的 Next 16.4 Turbopack HMR 重载循环：instrumentation chunk 的 `restart`／hash mismatch 导致页面反复 reload，打断 CAT envelope 与 login2 检查。该问题仍属上游开发环境限制，不宣称已修复。确认本工作树无活跃 dev 进程后，将缓存移到独立临时备份，以全新缓存重跑，CAT 和 login2 均通过；未关闭缓存／HMR、改 SDK、放宽超时或降级依赖。保留首次失败日志与诊断证据。
- 开发测试进程显式不继承 `NODE_ENV`、`NEXT_RUNTIME`、`PORT`；调研中一次环境泄漏使 Next 自动追加的 `.next/dev/dev/types` 配置已恢复，不把该生成改动纳入提交。
- 本次不在开发工作树运行 `next build`，不把本地回归描述成生产构建、远程 CI、CAT 实际摄入或部署验收。
