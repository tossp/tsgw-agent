# CORS：可信主机名跨域接入

## 范围与公共入口

- fork 自有能力，公共 TypeScript 入口为 `index.ts`，外部使用 `@/tsgw/cors`。配置和使用说明见 [README.md](README.md)。主体、测试及浏览器验收均保留在本模块。
- `TSGW_ALLOWED_ORIGINS` 为逗号分隔的精确 hostname 或 HTTP(S) Origin；只信任 hostname，忽略协议和端口，不支持通配符、子域名隐式匹配或 opaque Origin。
- `mergeCorsAllowedHosts()` 在 Node 启动阶段把提取的 hostname 合并到进程内 `PI_WEB_ALLOWED_HOSTS`，保留原值且去重，不回写文件。旧 Host 白名单不反向授予跨域权限。
- `getAllowedCorsOrigin()` 同时供公共请求校验和 CORS 响应使用；返回请求的实际完整 Origin。`withCors()` 包裹既有 proxy，处理预检与响应头，不复制鉴权实现。
- 未配置时保持上游默认保护；开启后仅对 `/api`、`/api/*` 生效。仅可信来源且通过现有请求校验的预检可在鉴权之前返回；实际请求仍走 Cookie/Basic Auth、全局限流、路由权限和 Content-Type 校验。
- 不增加聚合服务、接口、依赖、静态全局 CORS 头，不修改 Cookie 的 SameSite/Secure 属性，不调整聊天或 Debug 面板。

## 模块外接入清单

| 文件 / 位置 | 必要调整及原因 |
| --- | --- |
| `instrumentation-node.ts` / `registerNodeInstrumentation()` | 调用 `mergeCorsAllowedHosts()`，使开发和生产 Node 实例在开始服务前合并运行时 Host 配置 |
| `lib/request-security.ts` / `isApiRequestOriginAllowed()` | 在默认跨站拒绝前调用 `getAllowedCorsOrigin()`；所有 API 路由的二次校验复用相同规则 |
| `proxy.ts` / `proxy()`、原逻辑移为私有 `handleRequest()` | `withCors()` 包裹原流程，覆盖预检及成功、401、403、429 响应；原鉴权和 matcher 不变 |
| `lib/request-security.test.mjs` / `loadSubject()` | 与现有 proxy 测试一致，通过 jiti 加载 `@/` 公共入口；保留全部原有断言 |
| `bin/pi-web-options.js` / `getHelpText()` | 新增环境变量帮助行；启动参数和身份不变 |
| `README.md` 配置表、`docs/agents/files-and-access.md` 来源校验说明 | 只保留新配置和本模块说明的薄索引 |
| `compose.yaml` 环境变量、`docs/docker.md` 配置表 | 显式转发新变量，避免 `.env` 中设置但容器未收到 |
| `tsgw/AGENTS.md`、根 `AGENTS.md` 模块索引 | 注册本模块及文档入口，不修改其他模块职责 |
| `package.json` / `files` | 将配置指南 `tsgw/cors/README.md` 随 npm 包发布；运行时代码由 Next 编译，不增加依赖或改测试发现模式 |

共享代码只增加上述调用及 proxy 外层包装。不逐项改写调用公共 guard 的路由，不迁移上游安全实现。

## 宿主依赖及升级核对

1. `isApiRequestAllowed()` 仍必须先检查目标 Host，保留非浏览器请求、代理重写同源和用户主动打开安全文档的上游例外；跨域白名单不能绕过目标 Host 校验。
2. `proxy.ts` 的 Basic、Cookie、401/429、登录跳转及认证豁免仍由宿主维护。预检无凭据，实际请求不能因此获得认证；不放宽 JSON、文件访问或项目权限。
3. Next Proxy 返回的响应头必须到达真实 Route Handler 响应；不在 `next.config.ts` 设置 `Access-Control-Allow-Origin: *`。开启本功能时 API 响应使用 `Vary: Origin`，只向匹配来源回显实际 Origin。
4. Node instrumentation 必须在开始服务前执行；以实际开发服务器请求验证 Host 合并对 proxy 和路由均生效，不假设不同运行单元共享模块状态。
5. 全量测试由现有 `tsgw/**/*.test.mjs` 发现；测试使用真实 helper、proxy 和浏览器 fetch，不复制业务逻辑。Host 边界验证必须用 `node:http.request()`：本机 Node 24.22.1 的 fetch 会忽略调用者设置的 Host。浏览器预检通过 CDP Network 观察；认证拒绝用 `cache: "no-store"`，缓存隔离另用实际缓存命中验证。

## 验证

在工作树根目录运行：

```sh
node --experimental-strip-types --test tsgw/cors/*.test.mjs lib/request-security.test.mjs lib/web-auth-proxy.test.mjs lib/pi-web-options.test.mjs
node_modules/.bin/tsc --noEmit --incremental false
npm run lint
node tsgw/cors/e2e.mjs
npm test
```

本机 root 执行全量测试时沿用既有权限测试流程：`capsh --drop=cap_dac_override,cap_dac_read_search -- -c 'npm test'`，仅在测试子进程移除 root 的 DAC 绕过能力，不修改业务代码或测试断言。

浏览器验收使用本工作树自己的 Next dev 和临时静态页面，覆盖真实跨域预检、Basic、JSON 登录及 Cookie、未认证拒绝、非白名单拒绝、同主机名不同端口及缓存隔离；结束后关闭自建进程。生产验证在独立临时副本构建后，使用 `CORS_E2E_ROOT=<副本绝对路径> CORS_E2E_MODE=production node tsgw/cors/e2e.mjs` 复用同一组检查；构建时不设置白名单，启动时再设置，以确认配置不被固化进产物。禁止在开发工作树执行 `next build`。测试不得创建真实用户会话、发送提示、改变用户配置或调用真实模型。提交、合并、推送、发布及部署必须分别获得对应授权。
