---
name: tsgw-im-reply
description: Reply to a WeChat notification with its reply handle.
---

收到带回复句柄的 IM 入站通知后，处理完任务时用通知里的句柄调用 `im_send`，把结论和需要交付的内容发回去。
文字、图片和文件可以按需要分多次发送。
