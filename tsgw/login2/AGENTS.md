# login2 模块

## 公共入口

`index.ts` 默认导出登录页面，`app/login2/page.tsx` 只作 `@/tsgw/login2` 路由接线。Node-only 的 `getPiLoginSourceIp()` 从 `server.ts` 导出，`app/api/web-auth/route.ts` 使用 `@/tsgw/login2/server`；不得经客户端页面入口加载 `node:net`。行为、素材与浏览器验收见 [README.md](README.md)。

## 范围与入口

- fork 自有的第二套登录展示层。`LoginPage.tsx` 为客户端页面主体，`PiAccessScene.tsx`、`PiAccessReticle.tsx`、`pi-access.module.css` 为展示，`usePiAccess.ts` 管理现有阶段和认证适配，`PiAccessAudio.tsx`、`pi-access-voices.ts` 管理六段播报，`pi-access-copy.ts` 提供本页三语文案。
- `pi-access-auth.ts` 仅调用既有 `/api/web-auth`；`login-source-ip.ts` 的 `getPiLoginSourceIp()` 只为 GET 响应提供展示用 IP，不参与认证或限流。该文件依赖 `node:net`，只能由服务端使用，不得引入客户端依赖图。
- 同目录保存全部模块测试及独立 `login2*.mjs` 浏览器脚本。`login2.mjs` 从本目录向上两层定位项目根目录，日志和截图仍写入根目录 `test-results/login2/`。`login2-start.mjs` 对外提供 `assertPiAccessWaiting()`、`waitPiAccessReady()`、`startPiAccess()`，供模块浏览器脚本及发布 smoke 使用；其他浏览器辅助脚本彼此保持同目录相对引用。
- 不复制服务端密码、Cookie、Basic 或限流实现；不增加运行时依赖、插件系统、生成工具、音频处理或新的认证步骤。原 `/login` 必须继续可用。

## 模块外接入点清单

| 文件、函数或配置 | 接入及原因 | 维护约束 |
| --- | --- | --- |
| `app/login2/page.tsx` 默认导出 | Next App Router 的 `/login2` 路由入口；保留 `"use client"`，仅重导出本模块 `LoginPage` | 页面主体移入模块，宿主只留路由接线 |
| `app/api/web-auth/route.ts` 的 `GET()`、`getPiLoginSourceIp` import | 在既有 JSON 响应的 `X-Pi-Source-IP` 头返回展示元数据 | 只更新 import 到本模块；GET/POST/DELETE 行为不变 |
| `proxy.ts` 的 `proxy()` 未认证页面分支及 `config.matcher` | 默认未认证首页进入 `/login2`，保留查询参数为 `next`；`/debug` 也沿用该入口；`/login2` 和其公开资源不进入受保护 matcher | 不修改现有行为；不得把 `/login2` 加入 matcher 导致自重定向或资源拦截 |
| `components/SettingsPanel.tsx` 的 `logOut()` | 既有 DELETE 登出成功后 `window.location.replace("/login2")` | 现有字面量接线无需改动 |
| `public/login2/assets/` | Next 公开资源，地址固定 `/login2/assets/`；含 `emblem-source.png`、`emblem.webp`、MIT 声明和 connected/permission/password/read/verified/welcome 六段 MP3 | 原路径及字节保持不动；不迁入模块、不生成或改写音频 |
| `tsgw/release/smoke.mjs` 的 `startPiAccess` import | 发布验收复用相同开始操作，不维护另一套开场逻辑 | 使用 `../login2/login2-start.mjs` 专用浏览器辅助入口 |
| `package.json` 的 `scripts.test` / `files` | 测试由既有 `tsgw/**/*.test.mjs` 发现；打包文档改为 `tsgw/login2/README.md` | 仅调整迁移后的打包路径，不改变依赖或包身份 |
| `README.md`、`AGENTS.md`、`tsgw/AGENTS.md`、`docs/agents/files-and-access.md` 的 Default web login、`docs/agents/client-platform.md` 的启动跳转索引 | 固定文档入口指向本模块，行为与素材正文见本模块 `README.md` | 不复制认证行为正文，不将 fork 登录目标写入上游通用浏览器启动流程 |

上述源码接入只有路由注册、单个服务端展示辅助调用和现有跳转；没有新增共享代码调整。外部回归测试依赖 `app/api/web-auth/route.test.mjs`、`components/SettingsPanel.test.mjs`、`lib/web-auth-proxy.test.mjs`，本次无需迁移其上游通用用例或修改路径。

## 宿主依赖与不得改变的契约

- `hooks/useI18n.tsx` 的 `I18nProvider` / `useI18n`，`lib/login-destination.ts` 的 `safeLoginDestination()`；后者同时供经典登录使用，仍留宿主。`PiAccessScene.tsx` 从根 `package.json` 读取版本。使用项目现有 React、Next `Image`、TypeScript/CSS Modules 与 `@/` 别名。
- 黑幕并行 GET 会话与预加载六段音频，用户手势才开始；六段原速播报、阶段顺序、最短时长及有界等待、静音/隐藏/失败回退均保持原样。身份编号固定 9527、等级固定 3，来源 IP 和 hostname 仅展示。
- 已有有效会话和无密码模式仍等待用户点击进入，身份令牌只显示固定遮罩 `••••••••`，不读取密码/Cookie；点击只用 GET 复查。失效后移除遮罩，恢复空密码输入框，重新输入后才允许 POST。不能把动画或预加载结果视为认证成功。
- 手动密码仍 POST 后 GET 验证 Cookie；错误密码、429、请求取消、单次在途提交不变。`next` 仍由共享安全规则检查并排除登录页循环；备用链接保持经典 `/login`，成功序列开始后才成为直接目标链接。
- 来源 IP 继续按 `X-Ts-Client-IP`、`CF-Connecting-IP`、`X-Real-IP`、`X-Forwarded-For` 首地址读取，仅检查 IP 格式，不新增可信代理策略。Next 缺省补齐的连接地址与现有全局限流、Cookie、Basic、API 401 合同不变。
- 浏览器脚本使用现有 Playwright；当前 `login2*.mjs` 没有导入 `e2e/helpers`，不应复制共享 E2E 框架。若以后引入宿主辅助脚本，使用从本目录到根 `e2e/` 的真实相对路径。

## 升级检查

1. 确认 Next 仍允许客户端路由薄重导出、模块外 CSS Modules、公开 `/login2/assets/` 路径和根路径别名；先阅读本机 `node_modules/next/dist/docs/` 的结构、页面与 `use client` 规范。
2. 核对 `/api/web-auth` 响应、Cookie、Basic 与全局限流；只适配模块调用者，不复制或收紧上游行为。确认服务端 IP 模块未进入浏览器图。
3. 核对 `proxy.ts` 默认首页跳转、matcher 排除、Settings 登出目标及原 `/login` 可用性，保留 safe next 和已登录显式点击复查。
4. 核对语言上下文、根版本读取、六段静态素材地址及字节、媒体手势和 reduced-motion 行为；不得以目录迁移为由重构或替换音频。
5. 核对发布 smoke 的开始辅助脚本 import、测试发现模式以及 E2E 项目根目录。不要为了兼容旧源码路径留下实现壳；同时核对根文档薄索引及模块行为说明的新路径。

## 验证

在项目根目录执行：

```sh
node --experimental-strip-types --test tsgw/login2/*.test.mjs app/api/web-auth/route.test.mjs components/SettingsPanel.test.mjs lib/web-auth-proxy.test.mjs lib/login-destination.test.mjs
node_modules/.bin/eslint app/login2/page.tsx app/api/web-auth/route.ts tsgw/login2
node_modules/.bin/tsc --noEmit --incremental false
node --check tsgw/login2/login2.mjs
node tsgw/login2/login2.mjs
```

- 最后一条为完整浏览器验收，会启动自己的 Next dev；执行前确认同工作树无其他开发进程/锁，不启动第二个服务。禁止在开发工作树执行 `next build`；依赖、提交、推送或部署操作仍需对应授权。
- 目录迁移的定向单测、lint、语法检查和原文件字节对照不能替代浏览器验收。浏览器应覆盖真实密码/Cookie/429、默认入口与 Settings 登出、经典 `/login`、safe next、已有会话点击/失效空密码、六音频加载/开始/完成/失败/静音，以及移动端和减少动态效果。
- 静态启发式诊断可能报告既有 URL、日志或 `isSecureRequest()` 的 URL 构造；不作为本次纯迁移扩大修复的理由，以实际 TypeScript/模块加载和已有行为测试确认接线。
