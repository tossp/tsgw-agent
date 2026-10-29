# CAT 错误收集（TSGW 自有功能）

本功能仅在 TSGW fork 维护，不提交上游。接入自建 Sentry `cat.tossp.com`；项目为 `sentry/tsgw-agent`，项目 ID 为 `10`。管理、DSN 查询和错误检索统一使用 `ts_tool → cat`。

## 范围

- 浏览器未捕获异常、React 渲染异常。
- 新建会话和发送命令时的网络失败、异常响应和服务端 5xx。
- SSE 意外断流、建连超时及启动失败；正常关闭和切换会话不报错。
- 服务端关键 API catch、模型请求错误、异步 prompt 和扩展错误。
- 保留原错误及其堆栈，并附带 source、session_id、operation、provider/model 等定位标签。

按自建实例需求，不实现自定义脱敏、离线缓存、限流、告警规则或管理界面；不启用录屏、日志、指标、性能追踪、Seer。SDK 自带的默认处理仍保留，可能携带请求上下文；不额外附加整段对话或工具结果。不改变原有重试、消息发送和会话管理。

## 运行时配置

无需配置环境变量即可启用，前后端共用 `lib/cat-config.ts`：

- DSN 固定为 `sentry/tsgw-agent` 项目的公开采集地址，安装后默认启用，不读取 `SENTRY_DSN`。
- 实例标签直接使用服务端 `os.hostname()`，不读取 `SENTRY_INSTANCE`。
- Release 固定为产物的 `tsgw-agent@<package.json.version>`，部署时不需要设置 `SENTRY_RELEASE`。CI 的版本准备步骤先改写产物版本，再把同一 Release 交给上传插件。
- `SENTRY_ENVIRONMENT` 仅用于可选的环境标签，未配置时使用 `NODE_ENV`。

浏览器在启动时读取 `/api/cat-config`，取得部署机器名等公开 SDK 配置；该只读接口仍受原有 Host/Origin 校验，不需要登录。它不返回上传令牌或其他环境配置。配置读取失败不阻止页面启动；读取完成前发生的浏览器错误没有采集保证。

浏览器和服务端直接向 DSN 采集端点上报，MCP 不转发事件。完全断网时事件不保证保存或补报；SSE error 本身无法证明具体 DNS/TLS/代理根因。按要求不增加限流，持续断流时会随现有重连逐次上报（单浏览器可能约每秒一条），不改变原重连机制。

## 源码映射

`next.config.ts` 接入官方构建插件。仅 `tsgw` 分支的构建步骤从 GitHub **Repository secrets** 读取 `SENTRY_AUTH_TOKEN`，并用本次通道版本设置构建期 `SENTRY_RELEASE`；上传目标默认是自建实例的 `sentry/tsgw-agent`。`v*` 标签仍按原流程发布，但不注入这两个值、不做 CAT 上传。上传凭据不进入浏览器配置。

有令牌时生成 server `source-map`、client `hidden-source-map` 并由官方插件上传；上传失败抛错终止构建，成功记录在构建日志中。`build` job 不声明 `npm` environment，故该环境内的 Secret 不对构建生效。

没有上传令牌时跳过源码映射生成/上传，错误上报仍工作，但生产压缩代码的可读性受限。现有 npm files 规则排除 JS map。

## 验证入口

- `node --experimental-strip-types --test lib/cat-monitoring.test.mjs lib/agent-client.test.mjs lib/agent-event-connection.test.mjs hooks/cat-new-session.test.mjs`
- `node_modules/.bin/tsc --noEmit`、`npm run lint`、`npm test`
- `node --test release/cat-ci.test.mjs` 检查分支门控、Release 和官方 webpack 包装的源码映射开关，不执行上传。
- `node e2e/cat-monitoring.mjs`；发布构建快照使用 `E2E_SERVER_MODE=start node e2e/cat-monitoring.mjs`。默认在浏览器拦截真实 SDK envelope，不主动触发服务端异常；不验证 CAT 接收或源码还原。只有显式设置 `CAT_E2E_LIVE=1` 才发送前后端真实测试事件，须再通过 `ts_tool → cat` 回读服务端事件及源码堆栈。CAT 升级期间不运行该验收。
- 独立构建快照验收 Webpack 发布产物；独立开发进程验收 Turbopack，不污染正在运行实例的 `.next`。
- 发送具名测试事件，并通过 `ts_tool → cat` 回读确认；不增加永久测试路由。

## 首次接入验收（2026-10-28，配置修正前）

- 类型检查、lint 和变更路径主动 LSP 检查通过；全量测试 2952 项通过、1 项原有跳过；发布相关测试 62 项通过。
- root 默认权限下的只读目录测试在原分支同样失败；撤去测试子进程的 `cap_dac_override`、`cap_dac_read_search` 后，全量通过，未跳过或修改该测试。
- Turbopack 开发模式已验证浏览器及服务端 SDK 真实 envelope；关闭 DSN 后不发送事件，业务 API 认证和配置接口的 Origin 校验保持有效。
- 未配置 DSN 构建的 Webpack 发布产物，在运行时设置 DSN 后成功上报。通过 `ts_tool → cat` 回读到浏览器和服务端两条测试事件：`instance:cat-e2e-1793179292182`，环境 `test`，release `tsgw-agent@0.1.0`；浏览器事件 ID 为 `ad20dbd6c5ca4665b29d55e71a22cfe1`。
- 本次验收未使用上传令牌，实际源码映射上传未验证；原生 iOS 16.2 设备未实测。新增客户端产物检查未发现 RegExp lookbehind 字面量或 class static block。
- 已完成独立打包、干净临时前缀安装和现有发布冒烟测试；安装后的 CLI、认证、登录页、原生终端及 SSE 均通过。另对实际安装包执行 CAT 回归，浏览器和服务端均成功发送 SDK envelope，运行时开关生效。
- 宿主重启后补充复核：相关测试及发布测试合计 89 项通过，类型检查、lint、diff 检查通过。独立只读审阅完成，无必须修复的阻塞项；首次带上传令牌的构建仍需单独验收源码映射上传结果。
- 上述验收不包含发布或部署；提交与合并状态以 Git 记录为准。

## 固定配置修正验收（本地端到端已通过，真实 CI 待验证）

- DSN 默认启用、机器名标签、产物版本及 `tsgw` 分支门控已完成源码和测试修正，独立只读审阅无阻塞代码问题。
- 全量测试 3042 项通过、1 项原有跳过；相关及发布测试 93 项通过；类型检查、lint 和 diff 检查通过。变更文件主动 LSP 无 TypeScript 诊断；`next.config.ts` 的 4 条原有辅助规则提示未扩大范围处理。
- 干净快照的 Webpack 发布构建通过；该产物的浏览器回归通过，实际 SDK 信封中的实例为 `claw`、release 为 `tsgw-agent@0.1.0`。信封在浏览器侧拦截，没有据此宣称 CAT 已接收。
- 使用测试令牌和本地 HTTP 端点模拟拒绝创建 Release，真实构建插件收到 403 后以退出码 1 失败。此项验证了构建失败路径，**未进入真实 CAT 的 artifact 上传阶段**。
- 用户提供的专用上传令牌已验证具有 `org:read`、`project:releases`；2026-10-28 已写入 GitHub 仓库级 `SENTRY_AUTH_TOKEN` 并回读名称及更新时间。令牌没有写入源码、日志或浏览器；本地临时文件权限为 0600，并已加入本地 Git 排除规则。
- 首次真实上传遇到 504；随后在同一具名验证 Release `tsgw-agent@0.1.0-catverify.1793193732116.g304c4ebb7555` 重试，及完全干净快照重建，均构建成功，Node/Edge/Client 三个插件均记录上传成功。这是本地上传验收，不是 GitHub Actions 运行或 npm 发布。
- 2026-10-29 回读确认同一 Release 有四个 artifact bundle（两轮各 302、12 个文件）。已用实际 chunk 的 Debug ID 确认浏览器 JS/map 在 12 文件包 `0c3e1b35-ce24-93ef-1b4f-de924a0c2822`，服务端 API route 的 Debug ID 命中 `artifact_bundle/48`。此前按文件数量把 12 文件包判断为 Edge 包不准确；应以 Debug ID 和对应文件为准。源码映射上传和文件关联已验证，不等于事件堆栈还原已验收。
- 已用浏览器实际输入 `/` 触发现有 `agent-new-request` 错误，原始堆栈来自打包 chunk（不是 eval），CAT 返回 HTTP 200 及匹配的事件 ID `78dc0f619c7e42bb85e8c7c6f89b32b7`；另外触发服务端现有参数错误。通过 `ts_tool → cat` 尚未检索到本轮新事件；去掉 localhost 请求上下文的独立传输探针也取得 200 和匹配 ID，但尚未能回读。

### CAT 后台排障（历史阶段）

以下为分阶段结果，当前接入状态以下方最新验收为准。

- 2026-10-29 01:09（UTC+8）只读现场核验：`scnet:/ts/sentry` 的 Relay 对本项目公开 DSN key 仍持续等待项目配置，最近 45 分钟匹配到 30 条等待超时警告。已定位到项目配置获取未就绪，配置构建任务未完成的具体原因仍在取证；不能仅据 pending 断定 Redis 故障。
- 同日 01:16—01:22（UTC+8）只读追踪：worker 已导入 `sentry.tasks.relay`、未限制 namespace，默认路由和 broker 消费 topic 均为 `taskworker`，未发现静态漏订阅（未读取数据库动态路由）。共享队列提交进度曾落后五分钟前的消息边界；随后 51.568 秒采样中 committed offset 不变、生产增加 424 条，lag 从 4830 增至 5254。期间仍有跨窗口提交推进，不能判定整个 worker 停摆。
- worker 十分钟日志聚合有 detector 缺失 479 条、`processing_state.missing` 650 条及锁竞争；这些是日志条数，不等于独立任务数，也未证明与本项目任务的因果关系。单次 worker CPU 17.87%、内存 1.312 GiB，不能仅据积压认定 CPU 饱和或直接提高并发。配置构建任务的 30 秒过期/处理期限使排队超时成为重点候选，但目标任务的提交、执行及回填尚缺闭环证据；没有通过读数据库、任务载荷或修改监控来扩大授权范围。
- 01:29（UTC+8）对当前消费位点附近有限采样 1000 条 Kafka 消息，仅在进程内读取任务元数据：553 条为配置构建，其中 218 条匹配本项目公开 key，创建集中于 26 秒内，观察时全部超过自身 30 秒有效期；未加入生产消费组或提交 offset。此项排除了目标任务未入队，但不等于已证实 broker 将这些任务按过期丢弃。
- 定向源码与配置核对已找到重复调度的确定原因：当前继承 `projectconfig_debounce_cache.base.ProjectConfigDebounceCache`，`is_debounced()` 恒为 False，写入/解除防抖均为 No-op；现有实际配置缓存则是 Redis。官方另有 `projectconfig_debounce_cache.redis.RedisProjectConfigDebounceCache` 可复用既有集群；已在下述授权修复中切换。该差异解释重复任务不受抑制，不等于已证明全部未入库事件只由此造成。配置缓存后端、TTL 与类名取证不读取业务配置值或凭据。通用源码结论与版本边界见 Blinko 1068。
- 01:56（UTC+8）按用户明确授权启用 CAT 官方 Redis 防抖，仅重启 `web` 与 `taskworker`，两服务 healthy、ID/IP 不变，入口健康及严格 TLS 登录页均 200。未改 TTL/任务期限/并发、Compose/env、业务数据库或队列；未重建容器。原配置单文件备份为 `scnet:/ts/sentry/backups/sentry.conf.py.pre-relay-debounce-20261029T015601.bak`（0600）。
- 修复后采样确认防抖生效：本项目任务相邻创建最短 10.027 秒、中位 10.056 秒；指定 debounce 键存在且 TTL 为 7 秒。配置构建占样本比例由 55.3% 降至 2.0%。但 02:06（UTC+8）队列提交边界仍滞后约 287 秒、lag 1887，配置缓存仍不存在；不能把去重生效视为摄入已恢复。
- 新一轮独立快照验收的浏览器事件为 `3fbfd95d158f46448a0464ff8067fcc0`（真实打包 chunk、HTTP 200 及匹配 ID），服务端同时触发既有参数校验错误；通过 `ts_tool → cat` 仍未查询到这两类新事件，源码还原仍未通过。证据在 `/root/.cache/pi-web-cat-verification/cat-post-debounce-1793210535719/`。
- 后续经正式业务 API 确认 `internal`、`cd50` 缺少项目级 `issue_stream` 默认记录；用户另行明确授权后，2026-10-29 10:07（UTC+8）以 Sentry 应用账户使用现有初始化逻辑仅补齐两条记录 **64、65**。业务 API 独立复核两条均启用，本项目原 detector 8 不变；未重启服务、改规则或队列。
- 修复后 120 秒内相关缺失报错由 752 条降为 0，但队列 lag 仍从 1578 增至 1854，目标配置缓存未回填。这排除了“缺失检测器报错仍未修复”，不证明剩余队列阻塞已解决；不能继续把两者当成同一原因。
- 10:14（UTC+8）复用已上传映射的同一构建，仅做前后端各一次新验收：浏览器事件 `c2c2934549e34518a673421503331766` 得到 200 和匹配 ID，但随后 `ts_tool → cat` 仍查不到本轮浏览器和服务端错误。证据位于 `/root/.cache/pi-web-cat-verification/cat-post-detector-1793240074982/`。没有重复上传/构建或扩大写入范围；服务端执行及授权详见运维仓库 `operations/changes/2026-10-28-sentry-26.10-upgrade.md`。

### 最新验收：2026-10-29 10:34（UTC+8）新事件及源码还原通过

- 用户另行明确授权一次原生配置构建诊断后，10:32:28 以 UID/GID 999:999 对活跃的本项目公开 key 同步执行 `build_project_config` 恰好一次，耗时 **11.858 毫秒**，未抛异常或捕获 ERROR；未入队、重试、重启或改参数。
- **执行前配置及 revision 缓存已存在**（TTL 8144 秒），执行后 TTL 8400 秒；debounce 前后均不存在。不能把已有缓存的恢复归功于本次手动调用，也不把一次缓存刷新视为长期修复。
- 复用同一已上传映射的生产构建，前后端各发送一条新测试错误。通过 `ts_tool → cat` 回读：
  - 浏览器：事件 `54477353d7ab4cdba979da2d8bf84e8d`，issue `TSGW-AGENT-3`，由压缩 chunk 第 12 行第 90030 列还原为 **`hooks/useAgentSession.ts:1007:23`**。
  - Node：事件 `972e8e6d7d934692bee0ad482b8a5725`，issue `TSGW-AGENT-4`，还原为 **`app/api/agent/new/route.ts:51:13`**。
- 两条事件的 Release 均为 `tsgw-agent@0.1.0-catverify.1793193732116.g304c4ebb7555`，`instance=claw`、`environment=test`；原始源码片段与独立构建快照对应行逐项比对一致。此项证明了 SDK → CAT 摄入/检索 → 已上传映射 → 前后端源码堆栈的本地端到端链路，不再只是 HTTP 200 或上传日志。
- 安全元数据、发送回执及验收结果位于 `/root/.cache/pi-web-cat-verification/cat-post-config-diagnostic-1793241254346/`；未保存凭据或完整业务响应。没有重复构建/上传、关闭测试 issue 或改告警规则。
- 10:37 收尾只读核验共享队列 lag 从前窗 1854 降至 **3**，进度接近队尾；目标配置 TTL 为 8117 秒，最近五分钟本项目 pending、worker ERROR／缺失 detector 日志均为 0，Web/taskworker healthy。不是只靠本次事件通过推断后台恢复，但仍不外推所有服务或长期稳定性。
- **尚未验证/执行**：真实 GitHub Actions 构建及上传、发布和生产部署；共享 CAT 其他升级遗留异常不在本次接入闭环通过的范围内。本次固定配置修正仍未提交、合并或推送。
