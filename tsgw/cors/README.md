# 可信主机名跨域接入

这是 TSGW fork 自有能力：让独立静态页面直接读取现有 API，不增加聚合服务或新接口。实现和升级检查见 [AGENTS.md](AGENTS.md)。

## 配置

启动前设置逗号分隔的白名单，修改后重启服务，无需重新构建：

```dotenv
TSGW_ALLOWED_ORIGINS=dashboard.example.com,https://100.64.170.247:30141
```

- 可写精确 hostname、IP 地址或完整 HTTP(S) Origin；匹配时只看 hostname，忽略协议和端口。
- 上例也会信任 `http://dashboard.example.com:8080`，但不会信任 `sub.dashboard.example.com` 或 `dashboard.example.com.attacker.test`。
- 不支持通配符；不接受含路径、用户名、密码、查询或片段的配置。无效配置会使启动失败，避免静默采用错误的授权范围。
- IPv6 可写 `::1`、`[::1]` 或 `http://[::1]:30141`。域名大小写、尾部 DNS 点和 URL 的 IDN/IP 规范化按同一规则处理。
- 未配置或配置为空时，保留原有跨站保护，不添加 CORS 响应头。

**这会信任该 hostname 下所有协议、端口对应的网页。只配置自己信任的主机名，不把不可信应用共用的主机加入名单。**

## Host 自动合并

Node 启动时，配置中的 hostname 会合并、去重到进程内 `PI_WEB_ALLOWED_HOSTS`；保留已有手工配置，不回写 `.env` 或服务配置文件。

```dotenv
PI_WEB_ALLOWED_HOSTS=existing.example.com
TSGW_ALLOWED_ORIGINS=https://dashboard.example.com:8443
```

运行时 Host 白名单包含 `existing.example.com,dashboard.example.com`。但跨域来源只授权 `dashboard.example.com`，旧 `PI_WEB_ALLOWED_HOSTS` 不反向授予跨域权限，也不改变监听地址。

## 浏览器调用与鉴权

- 作用范围为 `/api`、`/api/*`。目标服务的 Host 校验、原有路由权限和 JSON 校验仍然有效。
- 只允许已匹配来源的 OPTIONS 预检在验证目标 Host 后免认证返回；实际请求仍需原有 Cookie 或 Basic Auth。
- 跨站 Cookie 仍受原有 SameSite/Secure 属性及浏览器策略限制。静态面板可使用 `fetch()` 手工发送 `Authorization: Basic …`，并使用 `credentials: "omit"`。用户名仍为 `pi`，密码为目标实例原有 `PI_WEB_PASSWORD`；不要把密码写入静态页面产物。
- 响应回显请求的实际完整 Origin，支持凭据模式，并设置 `Vary: Origin`；不会返回 `Access-Control-Allow-Origin: *`。启用本功能时，非白名单 API 响应也保留 `Vary: Origin`，但没有允许来源响应头。
- 预检支持 GET、HEAD、POST、PUT、PATCH、DELETE、OPTIONS，以及 Content-Type、Authorization 请求头；实际方法能否执行仍由路由决定。
- 401、429 等响应也携带匹配来源的 CORS 头；浏览器可读取 `WWW-Authenticate`、`Retry-After`，不会用跨域错误掩盖原有鉴权或限流状态。

## 验证

定向测试、类型检查、lint 和浏览器命令见 [AGENTS.md](AGENTS.md#验证)。`e2e.mjs` 启动自己的 Next dev 和静态页面，通过真实浏览器预检、认证请求、缓存和不同来源进行验证，结束后关闭自建服务；证据写入 `test-results/cors/`。
