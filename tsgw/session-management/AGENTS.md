# 会话管理模块

## 范围与入口

本模块为机器人、普通会话代理提供共享的会话查询与整理能力。Node-only 公共入口为 `index.ts`，不允许浏览器导入。工具只有 `list_sessions`、`read_session`、`rename_session`、`archive_session`，统一 `exposure: "codemode"`。调用指引为 [技能](skills/tsgw-session-management/SKILL.md)。不提供删除工具、标题维护状态机、后台命名模型或自动清理任务。

- `catalog.ts` 复用宿主磁盘与内存清单，并统一普通会话、普通 fork 和项目真实路径匹配；IM 沿用该筛选，排除侧聊和子代理。
- `service.ts` 复用现有搜索、分支上下文转换、wrapper 改名和 Web 家族归档，不另建会话管理器或注册表。列表不传 cwd/archived 时覆盖全部项目和归档状态；正文搜索沿用上游限额并返回 truncated。
- 离线观察只用 SDK parse/migrate 纯函数处理内存，不调用可能迁移并重写文件的 SessionManager.open。v1 原文件没有条目 ID；SDK 内存迁移后按文件顺序重映射为稳定的只读分页 ID，并同步 compaction 引用，避免重复读取随机生成 ID 使游标失效。活跃读取直接使用原 wrapper 的 manager；不启动、不续租、不重开会话。
- read_session 返回当前分支最近 50 条可见消息的文本与 nextBefore；不返回图片字节和 thinking。before 用于继续读历史；目标缺失或分页位置不存在则明确失败。
- 改名通过 renameRpcSession 协调活跃／启动／关闭 owner；只有无 owner 时才同步使用 mutable manager 追加 session_info，并失效已有缓存。比较、保存与返回统一采用 SDK 的 CR/LF→空格及 trim 规则；同名不写入，空白标题拒绝。不增加自动／固定模式，代理按技能中的当前目标规则判断调用时机。
- 归档复用 getSessionFamily / isFamilyArchived / updateSessionUiState，作用于现有家族根，保留 pin/archive 互斥、新活动和运行中保持可见的上游行为。返回 requestedArchived 和实际 archived，不把保存标记当作已隐藏。
- 侧聊与 Chat only 沿用上游工具边界；子代理不新增本模块工具。普通会话可按明确 ID 读取其他类型会话用于核实。

## 模块外接入清单

| 文件 / 位置 | 原因与升级核验 |
| --- | --- |
| `lib/rpc-manager.ts` 的 import、普通分支 extensionFactories | 注册工具与技能资源；保持 Chat only、子代理、侧聊 allow-list、现有 builtins 和扩展加载完整。Node 路径使用相对模块公共入口以兼容 Jiti 测试。 |
| `tsgw/im/pi-host.ts` 的 defaultAccess.list、项目清单及普通目标筛选 | 调用共享 catalogue / projectSessions / 路径及类型判断；保留注入式测试 seam、消息队列、创建与恢复、来源及媒体流程。 |
| `package.json` 的 files | 发布新技能资源，测试清单已包含 tsgw/**/*.test.mjs，无需额外测试脚本。 |
| `tsgw/AGENTS.md`、`docs/agents/tools.md` | 模块与技能薄索引。 |
| `tsgw/im/AGENTS.md` | 记录 IM 对共享查询入口的依赖。 |

## 依赖与验证

复核 SDK parseSessionEntries / migrateSessionEntries 的纯内存行为、getEntries/getLeafId/getSessionName、宿主 mergeSessionLists / listAllSessions、buildSessionContext 分页和 IM 来源投影、searchSessionContents 的有界搜索、renameRpcSession owner 时序、sidebar 家族归档及 UI state 锁。不得复制这些实现来绕过宿主约定。

```sh
node --experimental-strip-types --test "tsgw/session-management/*.test.mjs" tsgw/im/pi-host.test.mjs lib/rpc-manager-side.integration.test.mjs app/api/sessions/rename-route.test.mjs
node_modules/.bin/tsc --noEmit --incremental false
npm run lint
git diff --check
```

验证采用临时 agent/project、真实 SDK 与 faux provider，不操作真实会话和唤醒。必须覆盖读取旧文件字节/mtime不变、分页和媒体/thinking省略、名称及正文搜索、归档恢复与新活动语义、活跃改名分支/事件、codemode exposure及结构化结果、技能按需发现/reload与真实files清单隔离打包。禁止在开发工作树运行 next build；提交、推送、发布、部署与重启仍需对应授权。
