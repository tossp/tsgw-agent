# Agent Tracing 模块

## 范围与接口

- 仅在 TSGW fork 中维护；复用现有 `av8d/tsgw-agent` CAT 项目、DSN、Release 与源码映射链路。
- 服务端默认创建手动 Agent/model/tool spans，采样 100%；无需环境变量，不提供额外运行时启停开关。不启用普通 HTTP、浏览器或 Edge 性能追踪。
- 当前手动埋点设置模型/provider、工具名称、token、缓存 token、估算美元费用、时长/状态、实例与会话关系；这描述当前实现，不是已批准的“只采元数据”政策。正文映射尚未实现，不能声称已有聊天回放。
- `AgentTracer(session, options)` 包装公开 `agent.streamFunction`；宿主在原始事件订阅调用 `onEvent()`，现有错误捕获通过 `withScope()` 关联，在释放会话时调用 `dispose()`。
- 每个 SDK session 一个实例，不依赖 SSE 订阅数；root 使用新 trace，跨轮通过 session UUID 的 `gen_ai.conversation.id` 聚合。
- 提示词、回复、工具参数/结果等正文的采集范围仍待确认；本轮不主动补充这些映射，不强制关闭 SDK 的 AI/MCP 输入输出，不新增字段白名单、span/envelope 裁剪或自定义脱敏。SDK 自带上下文按其标准行为处理，不能承诺发送数据仅含手动设置的字段。现有错误采集策略不变。
- 本次不变更服务端保留周期或扩容策略，不添加限流、离线队列、管理界面或模型 exporter 框架，不升级依赖。

## 主体文件

- `tracer.ts`：run、模型请求、工具及嵌套工具 span 生命周期；局部错误关联；dispose 中断收尾。
- `usage.ts`：Pi usage 到 Sentry token/估算费用字段的映射。
- `policy.ts`：服务端手动 root 采样、重叠 AI/MCP 自动埋点排除及 HTTP 自动 spans 关闭；不设置 dataCollection、beforeSendSpan、beforeEnvelope 或 ignoreSpans。
- 模块内 `*.test.mjs`：真实 Sentry SDK 与内存 transport、本地确定性模型 stream；不得外发遥测或调用收费模型。

## 模块外接入清单

| 文件 / 接入点 | 类型、原因与影响 |
| --- | --- |
| `lib/pi-types.ts` 的 `AgentSessionLike.agent.streamFunction` | 必要宿主类型：补充 SDK 公开的可写请求边界；可选以兼容既有测试 session，不改变 SDK 接口。 |
| `lib/rpc-manager.ts` 的 `AgentSessionWrapperOptions`、constructor | 必要注册：每 wrapper 建立一个 tracer，子代理只传 profile 与父 session ID，不传任务或路径。 |
| `AgentSessionWrapper.start()` 原始 `inner.subscribe` | 必要事件边界：在客户端投影、重播和 SSE 监听之前消费原始生命周期；浏览器连接数不影响采集。 |
| `AgentSessionWrapper.emit()` | 现有错误捕获的局部 scope：关联原有错误到相应 span，不重复 capture，也不改变错误内容/过滤。 |
| `AgentSessionWrapper.destroy()` | 必要释放：中断未结束 spans，恢复原 streamFunction，避免迟到 result 重复上报。 |
| `startRpcSession()` wrapper 创建及 `SUBAGENT_CONTROLLER.registerSession()` | 必要父子标识：普通/重开与新建子代理两条入口均使用已有 `sessionEntries`/内存 manager 的 `readSubagentRun` 元数据，不新增会话文件读取/写入。 |
| `sentry.server.config.ts` 初始化 | 服务端配置：在现有 CAT 配置后合入本模块选项；浏览器/Edge/共享 CAT 配置、发布与 source maps 不变。 |
| `docs/agents/sessions.md` CAT 小节 | 更新 Agent tracing 入口和事件边界说明，保留既有错误采集约束。 |

宿主 `lib/rpc-manager.ts` 已超过 500 行，本次仅保留必要接入，不借此拆分上游管理流程；新增逻辑及测试均在模块内。

## 依赖但未修改的宿主契约 / 升级核验

- Pi 1.4.0 的 Coding Agent `ModelRuntime.streamSimple()` 未安装 `pi.ai.request` observer；本模块直接观察公开 stream，不声称已接通原生 Pi telemetry，不修改 provider、认证、路由或 node_modules。
- `StreamFn` 可同步或异步返回同一个 `AssistantMessageEventStream`，`result()` 为共享 promise；只观察结果，不增加流迭代器或改变参数。
- 第一个 `agent_start` 开 run；自动 retry/continuation 可再次发 start/end，只有最终 `agent_settled` 结束 run。最新 assistant stopReason 决定失败/恢复，settled.aborted 优先。
- `tool_execution_end.isError` 是工具最终结论，不能只看抛错或 result.isError；`parentToolCallId` 表达 codemode/MCP 嵌套工具关系。
- 内建 compaction/summary 和自动命名经过 `agent.streamFunction`；SDK 为其提供不同于主 session UUID 的 routing `options.sessionId`，这些辅助请求独立模型 root，即使与主 run 并发也不继承其 span/run ID。未传 routing ID 的公开 stream 调用按普通请求处理。
- cache warming 直接访问 ModelRuntime，不在本模块覆盖内；扩展绕过该公开 stream/executeTool 的直接调用也不保证覆盖。preflight 不计入 run 耗时。
- 子代理独立 session/run，通过父 session ID 关联，不保持等待工具长开，不另建家族完成协议。
- Pi input 不含 cacheRead/cacheWrite；Sentry input 包含二者；缓存是输入子集，reasoning 为输出子集，不能重复相加。
- 仅模型 spans 携带 token/费用，不复制到父 run 或工具；采用 Pi calculateCost 的最高适用价格档位及严格阈值规则，本次命中档价格缺失/全零时省略费用。失败/取消的 SDK 合成全零 usage 视为未知并省略，部分实际 usage 保留；估算不等于供应商/AIH 最终扣费。
- Sentry 11.9.0 使用 streamed spans；名称、segment、links、状态、属性与 DSC 均按 SDK 标准输出，不自定义重建或删减。segment 名称由 SDK 取实际所属根 span 名称：Agent 子调用共享 run 名称，独立辅助请求使用其模型 root 名称。实例直接在建立手动 span 时取 hostname()。
- root 采样仅选择本模块手动创建的三类入口，不开启全站 tracing；不在发送前再次丢弃已采样 root 的合法子 spans。核对 SDK 默认 AI/MCP dataCollection（11.9.0 默认 inputs/outputs 为 true）、自动集成名称和 HTTP spans 开关；默认采集选项不等于本模块已实现正文映射。
- root 必须隔离 ambient HTTP/上一轮传播上下文；并发 session 和 summary 不得串 trace。

## 验证与授权

在工作树执行：

```bash
node --test tsgw/agent-tracing/*.test.mjs
node --experimental-strip-types --test lib/cat-monitoring.test.mjs lib/rpc-manager.test.mjs
node_modules/.bin/tsc --noEmit
npm run lint
npm test
```

- 所有遥测发送均使用内存 transport，检查最终 envelope，而非只检查内部属性；回归验证 SDK 合法属性/links/传播字段不被额外裁剪、名称与实际 segment 正确，不把“正文永不上传”写成未获批准的测试要求。
- 主动 LSP 检查变更 TS 文件；禁止运行 `next build`。
- 全量测试涉及只读权限的用例在 root CAP_DAC_OVERRIDE 下存在已知环境差异；必要时按既有方式撤去该测试进程的 DAC override/read-search capabilities 后执行，不跳过测试。
- 仅本地验证不等于 CAT 摄入、Conversations 或费用展示通过。一次受控端到端发送需另行授权，并通过 `ts_tool → cat` 回读 spans、会话、token、耗时、工具及实际 retention_days。
- 提交、合并、推送、发布、重启或部署均需对应授权；2026-11-01 用户已授权本功能合并与发布，不包含部署或真实 AI 测试遥测。源码映射按既有发布规则归档与补传，不改原件。

## 验证记录与容量边界

- 六项整改后模块34项、全量3386项及CAT/RPC定向14项通过，全量1项原有跳过；TypeScript、lint、diff及变更核心主动LSP通过。独立只读复审未发现阻塞或重要问题，独立模块34项通过。
- 2026-11-01 合入当前tsgw后，全量3408项通过、1项原有跳过，发布契约100项通过；TypeScript、lint及合并暂存差异检查通过。源码与已审阅功能分支一致，冲突处理仅保留主线文档归并并迁移本模块说明。
- 验证使用内存transport与本机临时HTTP端点，没有调用收费模型或向CAT发送AI测试遥测。代码与本地测试完成不等于实际摄入、Conversations、费用展示通过；部署后仍需按授权回读核对。
- 容量按100%采集规划，span数约为run＋模型请求＋工具执行，含重试、嵌套与子代理。单条未压缩1–4 KB仅为预算假设，不是实际落盘倍率；首次实际摄入后再量测。
- 2026-10-31 已核验现网Sentry/Snuba保留配置90天；spans由ClickHouse按各记录retention_days异步TTL清理，首次AI摄入仍须确认该字段。每天UTC00:00的sentry cleanup不能代替spans TTL，也不能保证全部文件保留90天。本次不降采样、不改清理或存储配置。
- 主线已移除冗余的docs/cat-monitoring.md；本模块行为与证据收敛于此，错误采集约束见docs/agents/sessions.md，发布与补传按docs/tsgw-release.md §10，不恢复已删除文档。
