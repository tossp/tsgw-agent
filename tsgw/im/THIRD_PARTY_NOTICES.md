# IM third-party notices

The Telegram and Weixin adapters use the protocol and routing behavior of
`xmanrui/dsh-im` v5.10.0 as a reference, especially:

- `src/channels/telegram/telegram-api.mjs`
- `src/channels/telegram/telegram-runtime.mjs`
- `src/channels/weixin/weixin-api.mjs`
- `src/channels/weixin/weixin-controller.mjs`
- `src/channels/weixin/weixin-runtime.mjs`

Source: https://github.com/xmanrui/dsh-im/tree/v5.10.0

Copyright (c) 2026 xmanrui

The Weixin iLink protocol described by that project derives from Tencent's
`openclaw-weixin` at commit `cef0bfc390393f716903e16d50408118047f87e0`
(package version 2.4.6).

Source: https://github.com/Tencent/openclaw-weixin/tree/cef0bfc390393f716903e16d50408118047f87e0

Copyright (C) 2026 Tencent. All rights reserved.

Both projects use the MIT License. Their copyright and permission notices are
retained here for adapted portions. This module does not install or bundle the
DSH plugin, its host runtime, or its unrelated channel SDKs.

## MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## QR code dependency

QR images are generated locally with `qrcode` 1.5.4, distributed under its MIT
license and the copyright notice included in that package. Its dependency
licenses remain with their installed packages.
