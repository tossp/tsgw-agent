# v0.16.0 上游同步记录

## 固定边界与授权

- fork 基线：`4641e0e`，已按用户要求完整撤销 `tsgw/message-usage/` 和 `tsgw/subagent-status/`，恢复上游用量及子代理展示；不恢复这两块定制。
- 上游目标：`agegr/pi-web` 固定标签 `v0.16.0`，提交 `97e411f3c7433088937ce6ba18039439658f5e6e`；本地 `main`、`upstream/main` 已同步至该提交。
- 整合工作树：`/root/proj/pi-web-v0.16.0`，分支 `integrate/v0.16.0`。
- 用户授权提交、同步上游、合回 `tsgw` 并通过既有 Actions/OIDC 发布 `next`；不包含部署、重启现有服务、稳定标签或真实模型/遥测实发验收。
- 上游功能完整保留，fork 只做必要增项适配；独立提示卡关闭、Source/Render、通用 Pi branding、login2、Debug、CORS、标题、tracing 和 wakeups 保留。

## 接入与适配

| 范围 | 处理与验收重点 |
| --- | --- |
| 上游运行时 | 完整接入 `!` 实时输出、shell 与 streaming 队列并行、Stop 清队列、扩展 shutdown、启动诊断、空闲扩展消息补读、子代理排队保活及项目 trust 继承。 |
| 展示与编辑 | 接入工具计时、相关工具 entries 的 memo 比较、Stopped 和过程/最终答案去重、token/TPS 布局、复制拒绝处理、编辑器焦点/粘贴/扩展操作及目录选择修复。 |
| 用户消息 | 迁出的 `UserMessageView` 同步 `onFork(entryId, editTarget)`，普通/仅图片消息传原消息，技能命令还原并保留附件；Source/Render、字面 HTML 和大消息保护不变。 |
| 通知 | `ChatWindow` 相对上游仅保留独立通知关闭的五处接线；上游启动通知、链接和暂停行为完整保留。 |
| wakeups | 复用宿主 pending/mutation 生命周期、admission 和完整 shell 状态，只协调准备与接受；streaming 可与 shell 并行排队，新的轮次等待 `user_bash` hook，shutdown 不提前回收准备中的投递。未来 timer 不取消，已接受通知被 Stop 清除后不重投。 |
| tracing/CAT | 两个创建入口保留 tracing 及上游 `modelFallbackMessage`；tracer 先于启动通知初始化。CAT 在启动错误转通知前单次采集，重播不重复，404/500 标签与实际响应一致。 |
| 浏览器入口 | `e2e/run.mjs` 同时保留 fork 侧聊和上游 directory picker。新增真实组件交互检查用非 `.test.mjs` 文件名，在浏览器主入口及发布工作流安装 Chromium 后显式运行，不增加普通单测的浏览器要求。 |

## 依赖与发布契约

- 八个 `@earendil-works/*` 包及锁文件精确更新为 `1.5.2`；实际独立安装验证，无共享依赖软链。`lib/pi-packages.test.mjs` 通过。
- 保留 `tsgw-agent@0.1.0` 源版本、CLI/仓库身份、Sentry `11.9.0`、npm files、测试发现、OIDC、同次 CAT 原件归档和独立补传。预览版本仍由 CI 派生，不改为上游版本号。
- 真实 Pi 1.5.2 的 private marker、同实例 `AgentSession`、原始 stream 来源与摘要认证契约保持；运行实现无需修改。测试目标和打包迁移失败守卫同步，详见 tracing 模块规则。
- 新增浏览器交互步骤不修改发布权限、通道、归档内容、网络参数或上游 `ci.yml`；上游 npm job 的原有 fork 隔离守卫不变。

## 本地验证

- 模拟无浏览器安装的环境执行完整 `npm test`：**3839 项通过、1 项原有跳过、0 失败**。沿既有方法只撤去该测试进程的 DAC override/read-search capabilities，不跳过权限用例。
- tracing **45/45**；运行时作者定向 **345/345**；release/CAT CI 契约 **79/79**。完整 TypeScript、全仓 ESLint 和 diff 检查通过。
- 桌面/手机主浏览器回归通过，包含侧聊、目录选择、扩展编辑器操作、焦点、模型与布局；新增真实 React/Chromium 的 fork、附件/技能、复制拒绝和 Source/Render 交互 **4/4**，已由最终主入口实际执行。
- notice-dismiss 桌面/手机回归通过；Source/Render 独立浏览器回归通过且原 JSONL 不变；login2 全套复验通过。
- 两路独立审阅分别核对运行时生命周期和上游/发布完整性。运行时未发现阻塞；界面/发布审阅发现并闭合普通单测提前启动 Chromium 的问题，保留全部真实交互断言。
- 主动 LSP 五个改动文件无诊断，但 push-only 服务未确认 clean；类型结论以完整 `tsc` 补充，不宣称 LSP 全部 clean。
- 测试使用私有 HOME/agent、合成会话和本地 faux provider；Node/浏览器 CAT 拦截在本地。测试服务已关闭，端口复查释放，没有调用收费模型或向 CAT 实发测试事件。

## 已知限制与证据

- 普通单测首次暴露两个新增上游 hook 测试未配置 JSX 转译；按仓库现有 hook 测试范式补自动 JSX runtime 和同一 React shim 解析，原断言不变，定向 14 项及全量复跑通过。
- 重用开发缓存时再次出现既有 Next 16.4 Turbopack 重载循环：页面重复 GET/Compiled，导致 E2E 未等到 state 请求或 login2 执行上下文被导航销毁。保留首次日志，在确认本次测试进程退出、端口释放后备份缓存，用干净缓存复验通过；不关闭 HMR、不降级或修改产品行为。
- login2 全套超过最初 300 秒外层工具预算；确认该次进程和端口均已退出后，以更长外层预算完整复跑通过，未放宽产品或测试断言的等待时限。
- 日志在 `/tmp/pi-web-v16-*.log`，浏览器截图/trace 在工作树 `test-results/`，缓存备份在 `/tmp/pi-web-v16-*/`；不提交生成工件。失败的私有夹具可能含合成凭据，不上传。
- 未在开发工作树运行 `next build`；生产构建、同一 tarball 的安装/登录/PTY 验收由既有发布 CI 执行，须独立核对其结果。真实供应商 OAuth 刷新/扣费、CAT 实际 AI 摄入、Docker 和跨 OS 行为不属于本轮本地实测结论。
