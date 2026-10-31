# Debug 任务大盘模块

## 范围与硬边界

- `/debug` 是当前实例的全局任务观察大盘，诊断是其中一层；信息能力以上游 Debug 为基线，不以独立页面为由删减。
- **未经用户先行明确确认，不得新增或调整后端接口、返回字段、参数或行为。** 数据缺口先报告必要性、方案与影响，不能用只读接口名义绕过。
- 当前仅消费既有 `GET /api/agent/debug[?session=]`、`GET /api/sessions`。不启动会话、不续期、不创建 EventSource、不发送 agent 命令，不向用户会话注入测试。
- 不伪造其他窗口的客户端状态；会话目录不等于执行记录，未驻留不等于已完成；历史定时记录不等于进程内仍有定时器。
- UI 参考 `login2` 的档案底板、品牌、SVG 准星、暖色强调及适量动效，不套聊天工作区的极简限制；尊重减少动态效果和键盘操作。
- 主体、样式、文案和测试留在本模块；不修改原 `DebugPanel` 或聊天实现，不另造会话或任务调度器。

## 模块外接入清单

| 文件与接入点 | 原因 / 类别 |
| --- | --- |
| `app/debug/page.tsx`：`Debug` 与 metadata | 路由入口、导入本模块与页面标题；必要接入 |
| `AGENTS.md`：Topic Notes | 新模块规则与行为入口索引；文档 |
| `docs/agents/sessions.md`：独立 Debug 页章节 | 维护正式主题索引、范围和验收命令；文档 |
| `docs/agents/debug-dashboard.md` | 信息覆盖、数据边界、页面方案及验收记录；文档 |
| 原 `components/tsgw-debug/*` | 模块主体及测试归位后移除，接口不变 |
| 原 `e2e/tsgw-debug.mjs` | 浏览器验收归入本模块，不丢失验证入口 |

`proxy.ts` 已有 `/debug` 鉴权及登录回跳，本轮不修改。`package.json` 已有 `tsgw/**/*.test.mjs` 测试发现，不重复增加脚本。无后端改动，无共享行为重构。

## 宿主依赖与升级复核

- `lib/debug-types.ts`、`components/debug-panel-state.ts`：快照及纯格式化/分组/轮询辅助；必须核对字段语义，不能仅为大盘改宿主契约。
- `lib/types.ts` 的 `SessionInfo` / 关系信息、`components/SessionTree.tsx` 的标题规则、`SidebarIcons` 和 MCP 状态翻译；目录信息与实时快照分开标注。
- `useI18n`、`useTheme`、clipboard；本模块自有文案不扩散到上游全局字典。
- `app/login2/` 仅是视觉参考；可复用公开品牌图片，不依赖其认证状态机或播报。
- 升级后检查会话分组、Debug GET 的只读性与时钟、轮询取消、鉴权回跳、每种故障和旧数据提示。

## 验证

- `node --experimental-strip-types --test 'tsgw/debug/*.test.mjs'`
- `node_modules/.bin/tsc --noEmit --incremental false`、`npm run lint`、`npm test`
- `E2E_BASE_URL=<已有开发服务> node tsgw/debug/e2e.mjs`：浏览器夹具，不调用真实模型或任务；不执行 `next build`。
- 对照正式信息覆盖清单；正常、异常、空数据、过期、筛选、单展开、复制、长列表、手机及减少动效均需验收。
- 以源码差异确认后端和上游 Debug 未改变；浏览器网络只允许上述既有 GET（宿主既有 CAT 配置读取除外）。
