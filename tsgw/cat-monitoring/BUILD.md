# CAT 构建归档与独立补传

发布通道与工作流总览见 [发布说明](../release/README.md)；运行时采集边界和接入清单见 [模块规则](AGENTS.md)。以下命令均从项目根目录执行。

自建 CAT（`cat.tossp.com`，org `av8d`、project `tsgw-agent`）属于 fork。为避免 CAT 网络问题阻塞发布，`tsgw` 把同次构建的 JS/map 先归档到七牛，再由独立 job 创建 Release 和上传；不改上游 CI、`scripts.release` 或 `v*` 标签发布流程。

- **离线构建**：`Build` 只在 `tsgw` 注入 `SENTRY_RELEASE=tsgw-agent@<通道版本>`、`CAT_DEFER_UPLOAD=1`，不拿到 `SENTRY_AUTH_TOKEN`，不执行 CAT 健康检查。SDK 的 `sourcemaps.disable="disable-upload"` 保留 Debug ID 注入；Webpack 显式生成 server `source-map` / client `hidden-source-map`，保留 map，并禁用构建时 Release 创建、结束和提交关联。
- **同次产物归档**：`node tsgw/cat-monitoring/cat-artifacts.mjs <outDir>` 保存 `.next/server`、`.next/static` 下的 JS 及实际生成的对应 map；有 map 时严格校验 Debug ID，一些无 map 的 Next/vendor 小 chunk 也按原字节保留，但不承诺源码还原。产出 `artifacts.tar.gz`、`manifest.json`、`SHA256SUMS`；清单记录版本、Release、commit、BUILD_ID 和每文件 SHA-256。前后端各至少一对有效映射，清单内任一文件丢失或变化则失败；不能仅凭产后目录区分未生成 map 与归档前已丢 map，也不能靠重新构建来补传旧版本。
- **S3 位置**：`s3://tsoht/tsgw-agent/cat/<通道版本>/`，标准端点 `https://s3.us-north-1.qiniucs.com`、区域 `us-north-1`。CI 使用 runner 已有的 AWS CLI；只在 S3 步骤注入仓库级 `CAT_S3_ACCESS_KEY_ID` / `CAT_S3_SECRET_ACCESS_KEY`，不使用 rclone 或复制本机配置。未配置清理或生命周期策略，归档按版本保留。
- **发布边界**：S3 归档成功后从临时构建目录移除 `.map`（不改 JS），再打包、冒烟和发布 npm；不能只依赖 npm files 排除规则。`publish` 与 `cat-upload` 均只 `needs: build`，互不依赖，因此 CAT 不可达或补传失败不会阻断已验收产物发布。S3 归档失败仍阻断，避免 map 丢失。
- **独立补传**：`cat-upload` 下载原版本归档并校验外层 SHA-256，`tsgw/cat-monitoring/cat-upload.mjs` 再校验每文件 hash、版本及 Debug ID，使用 SDK 已依赖的官方插件公开 API 创建 Release、直接上传已带 Debug ID 的归档目录，绕过可能静默跳过文件的准备步骤。原 JS/map 不修改，不再注入 ID，也不重新构建。该 job 独占仓库级 `SENTRY_AUTH_TOKEN`；错误仍抛出，job 保持失败而非静默成功。
- **网络入口**：只有补传 runner 将 `cat.tossp.com` 临时解析到 `mctx 1.13.102.6` 并校验 TLS 和健康接口；API 和同域分片地址都走该通道。未改公共 DNS、scnet、DSN、分片大小、并发或 30 秒请求时限。
- **重试与收尾**：CAT job 超时失败时，在本轮发布、部署及其他已授权任务完成后主动追加手动补传，不等待用户提醒。先确认版本、job 和服务端现状，成功或结果未知时不盲目重复上传；仅下载对应版本同次构建的上述三份归档，校验外层摘要、解压后，以 `NODE_ENV=production`、独立临时 `SENTRY_CONFIG_DIR` 和安全注入的 `SENTRY_AUTH_TOKEN` 执行 `node tsgw/cat-monitoring/cat-upload.mjs <解压目录>`。随后回读 Release、artifact bundle 与版本关联；索引暂不完整时只做有界只读复核，不立即重传。不改 hosts、中转、分片或超时参数，不重新构建、不运行 `tsgw/release/version.mjs`、不重发 npm。如使用 CI 重试，只重跑该运行的失败 CAT job，仍使用已归档原件。
- **状态与排队**：CAT job 失败可令整条 workflow 显示红色，但 npm 可能已发布成功，应分别读取两个 job 的结果。沿用原 workflow 级同 ref 并发锁，慢补传仍可能延迟下一次同分支运行；本轮不重构并发策略。
- **运行时不变**：DSN 默认启用，Release 仍由产物版本确定，机器名仍取 `os.hostname()`；不依赖 CAT 已存在 Release。补传前不保证源码还原，不能承诺旧事件补传后自动重新处理。
- **本地与标签**：不设置 `CAT_DEFER_UPLOAD` 时保留原行为：没有 token 不生成/上传 map；显式提供 token 的本地构建仍同步上传且失败抛错。`v*` 标签没有上述两个构建值，跳过 S3 归档和 CAT job，原正式版流程不变。

测试入口：`node --test tsgw/cat-monitoring/cat-ci.test.mjs tsgw/cat-monitoring/cat-artifacts.test.mjs tsgw/cat-monitoring/cat-upload.test.mjs`。覆盖真实 SDK 包装、工作流依赖、S3 参数、真实 tar、逐文件完整性及真实 SDK 的本地 HTTP 拒绝路径；不向真实 CAT 发单元测试事件。分别核验 CI、npm 发布、S3 原件完整性及 CAT 版本／映射关联，不可将其中一个结果当作全部完成；映射上传成功也不等于已验证事件堆栈还原。
