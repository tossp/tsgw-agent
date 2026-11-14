# v0.17.0 上游同步记录

## 固定边界与授权

- fork 基线：`2a04eb70`（已合入 v0.16.0）。
- 上游目标：`agegr/pi-web` 标签 `v0.17.0`，提交 `174bff967807cdb59abb0204198d3d7cc19c862d`；本次抓取时上游 `main` 同样指向此提交。
- 先将本地 `main` 从 `97e411f3` 快进同步到上游，再在 `/root/proj/pi-web-v0.17.0` 的 `integrate/v0.17.0` 分支整合，验证后合回本地 `tsgw`。
- 本轮授权为本地同步、适配、验证及合并，不含远程推送、发布、部署、现有服务重启或真实模型/遥测实发验收。
- 保留全部上游功能；fork 的 login2、branding、Debug、CORS、标题、CAT/tracing、wakeups、单卡通知关闭和用户消息 Source/Render 继续保留。不恢复已撤销的定制用量与聊天尾部子代理状态。

## 上游变化与接入

| 范围 | 合并及核验重点 |
| --- | --- |
| 启动与关闭 | 保留 `session_start` 阻塞对话框可见性、临时事件流、延迟模型切换、回答后状态刷新和绑定/关闭期限；fork 追踪与错误采集沿用现有接线。 |
| 消息分组与唤醒 | 在上游 `getTurnAnchors()` 中保留可见 wakeup 通知的无上下文锚点；投递在 admission 内经 `prepareMcpForRun()` 等待启动和 MCP，去掉绕过 Stop 的外层绑定等待。新增真实 SDK 的启动等待中取消回归，以及截断/失败回答后的分组用例。 |
| Agents 与侧聊 | 完整接入 Agents strip、固定开关、侧聊独有内容搜索及父会话面板定位；保留 fork 的侧聊分支安全检查。 |
| MCP 与 trust | 接入测试成功后会话失败连接恢复、项目 agent 配置及 enabledModels 的 trust 约束。 |
| 文件与界面 | 接入整次上传 100MB、异步写入、文件预览/路径/diff/Markdown/输入法修复，以及跨页面提示音去重。 |
| 开发指引 | 采用上游简化后的指引和主题索引，保留 fork 模块入口及完整性原则。 |

## 依赖与发布契约

- `package.json` 和 lock 保留 `tsgw-agent@0.1.0` 源身份；v0.17.0 未变更依赖版本，fork 的八个 Pi 包仍精确固定为 `1.5.2`，Sentry 为 `11.9.0`。
- 独立工作树通过 `npm ci` 安装锁定依赖，不借用其他工作树的 node_modules。
- 保留原有 npm files、全模块测试发现、OIDC 发布、同次 CAT 构建归档和补传流程；本次不触发这些远程流程。

## 验证

- 完整 `npm test`：**3944 项通过、0 失败、2 项平台相关跳过**（Windows junction、未安装 PowerShell 的真实 shell 用例）。沿既有方式只撤去测试进程的 DAC override/read-search capabilities，保留权限断言；通过不存在的 Playwright 缓存路径验证普通单测不隐式依赖浏览器。
- 完整 TypeScript `--noEmit --incremental false`、全仓 lint、diff 检查通过。
- 发布/CAT 契约定向 61 项通过；运行时/唤醒定向 294 项通过；UI/客户端审阅定向 158 项通过，新增启动对话框夹具修复后 3 项通过。
- 主动 LSP 最终未报错误，4 个核心文件中 1 个确认 clean，3 个为 push-only 未确认；不把静默结果视为全部 clean，类型结论由完整 tsc 补充。
- 桌面/手机主浏览器回归通过，包含分页、分支、扩展对话框、编辑器焦点、文件预览、字体/模型设置、多标签页导航、侧聊和目录选择。真实 React/Chromium 的用户消息 fork、复制拒绝、附件/技能及 Source/Render 交互 4 项通过。
- UI/客户端与运行时两路独立审阅均未发现剩余阻塞。暂存树审计确认 139 个仅上游修改的文件与上游字节一致，234 个仅 fork 修改且无需本轮适配的文件与原 fork 一致；21 个双方重叠文件和列明的适配文件单独核对。
- 单卡通知关闭的独立桌面/手机浏览器回归通过：真实扩展通知队列补位、鼠标/键盘/触摸独立关闭、44px 点击区域、hover/focus 暂停及剩余时间恢复均保持；测试服务退出并确认端口释放。
- 测试使用私有 HOME/agent、合成会话和本地 faux provider；CAT 请求在 Node 和浏览器两侧拦截到本地收集器，未发现旁路，未调用收费模型或向 CAT 实发测试遥测。日志位于 `/tmp/pi-web-v17-*.log`，运行时定向日志为 `/tmp/pi-web-v017-runtime-tests.log`；生成工件不入提交。

## 修复与验证边界

- 新增上游 `hooks/session-start-dialog.test.mjs` 通过真实 fork hook 导入到 JSX 模块，原 Jiti 配置不足；按现有 hook 夹具补 automatic JSX 和同一 `react/jsx-runtime` 别名，保留原断言。
- 首轮真实 wakeup 回归证明外层 `waitUntilReady()` 绕过启动等待的 Stop 句柄；修复宿主适配后取消能及时释放提交计数，启动后不补投，不修改上游生命周期。
- 第一轮浏览器包装器设置 `serviceWorkers: "block"`，导致 Playwright 在沙箱 HTML 预览 frame 中读取 `navigator.serviceWorker` 报错；仅撤销临时包装器设置，保留原浏览器断言。CAT 的 Node HTTP/fetch 和浏览器请求仍重定向到本地收集器。
- 未在开发工作树运行 `next build`。本轮不验证生产 tarball 安装、真实供应商请求/OAuth 刷新、CAT 入库与源码映射、Docker 或跨 OS 行为。
