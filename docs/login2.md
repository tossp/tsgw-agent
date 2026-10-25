# Pi Web 第二套登录页

## 边界与入口

- 独立入口：`/login2`，可带 `?next=...`，只接受同源站内目标。
- 原 `/login`、默认登录跳转、`proxy.ts`、密码校验、Cookie 和限流均不修改。
- 无密码或已有有效会话时直接进入目标页面；不能把动画结束当作认证成功。
- 未认证时跳过动画进入原 `/login`；认证后可直接跳过余下动画进入目标页面。
- 本功能是 fork 的局部增量，不引入插件系统、新配置文件或运行时依赖。

## 实现

全部动画由 React 组件、状态和 CSS Modules 重现；无 iframe、注入脚本或第三方运行时。

- `app/login2/page.tsx`：React 页面、现有语言上下文和密码表单。
- `app/login2/PiAccessScene.tsx`、`pi-access.module.css`：纯呈现组件和隔离样式。
- `app/login2/usePiAccess.ts`：阶段计时、请求取消和登录状态。
- `app/login2/pi-access-auth.ts`：只调用现有 `/api/web-auth`，成功后复查会话。
- `app/login2/PiAccessAudio.tsx`：用户主动开启的中文语音；失败静音，不阻塞认证。
- `app/login2/pi-access-copy.ts`：本页专用三语文案，不扩散修改上游语言包。
- `public/login2/assets/`：原创生成的静态图片和音频。

序列为黑幕开场、洗白、访问许可、密码输入、请求接收、读取、核验通过、欢迎和揭幕。
只有密码接口与会话复查均成功，才能进入后半段；密码错误和 429 均停留在输入阶段。
没有音频 Promise 或动画事件参与认证判断。降低动态效果时跳过装饰序列。

## 素材来源

视觉参考：`6shenhonghong9/dsh-startup-screen`，参考版本 `1.1.1`、
commit `8ec3132e69f0906b3ed2f7eb083b1035cd69c1d4`（原仓库 MIT）。
未接入其宿主、插件设置、运行时、鲸鱼标识或录音。
参考代码的 MIT 声明保留在 `public/login2/assets/pi-reference-license.txt`。

图片由生图工具 Sunburst 创建：纯白、透明底、π/门形几何标识，无品牌文字。
`emblem-source.png` 为生成原稿，`emblem.webp` 为本地缩小压缩的网页资产。
品牌文字由 React 渲染，不烘焙进图。

语音由 `generate_audio` 生成，使用预置音色“茉莉”，指导为冷静、清晰、克制的系统播报。
不克隆真人或原插件音色；不含背景音乐。

| 文件 | 实际播报正文 | 时长（秒，约） |
| --- | --- | --- |
| `pi-permission.mp3` | 需要访问许可。 | 2.448 |
| `pi-password.mp3` | 请确认身份。输入访问密码。 | 4.056 |
| `pi-read.mp3` | 访问请求已接收。正在读取权限。 | 4.704 |
| `pi-verified.mp3` | 读取完毕，身份核验通过。 | 3.408 |
| `pi-welcome.mp3` | 欢迎访问，派智能协作终端。 | 3.744 |

首次使用保持静音，用户点击按钮后才尝试播放；切换阶段、隐藏页面或卸载会停止相应播放。
浏览器拒绝播放或资源加载失败时静音继续。可见文案始终提供全部必要信息。

## 上游同步与重放

同步 Pi Web 上游时，本功能仅包含新增文件，不需要修改上游核心实现。
保留或重新应用本功能提交后，检查现有 `/api/web-auth` 与 `safeLoginDestination()` 契约。
若上游改变接口，仅调整本目录的适配代码，不复制服务端密码逻辑。

运行：

```sh
node --experimental-strip-types --test app/login2/pi-access.test.mjs
node_modules/.bin/tsc --noEmit
npm run lint
node e2e/login2.mjs
```

浏览器脚本使用隔离的临时 agent 目录及测试密码，启动并停止自己的开发进程。
不要在同一 checkout 已运行开发服务时启动第二个 Next 进程，不执行 `next build`。
验收包括真实登录与限流、Cookie、站内跳转、移动端、减少动态效果及音频失败。
如以后要将此页设为默认登录入口，另行确认后再改跳转，不混入此增量。
