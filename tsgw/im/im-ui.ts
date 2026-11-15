export const imCopy = (locale: string) => locale.startsWith("zh") ? {
  title: "即时通讯", add: "添加机器人", telegram: "Telegram", weixin: "微信", name: "名称",
  cwd: "项目目录", token: "Bot Token", users: "允许的用户 ID", chats: "允许的聊天 ID（可选）",
  idsHint: "多个 ID 用逗号或换行分隔。", chatsHint: "留空则不额外限制聊天 ID。",
  ownerHint: "微信仅接受扫码账号的消息。", save: "保存", remove: "删除机器人", cancel: "取消",
  confirmRemove: "确认删除这个机器人？", start: "启动", stop: "停止", create: "创建机器人",
  scan: "获取微信二维码", scanAlt: "使用微信扫描此二维码", scanHint: "请使用微信扫码并确认登录。",
  waiting: "等待扫码", scanned: "已扫码，等待确认", connected: "已连接", expired: "二维码已过期，请重新获取",
  error: "连接错误", connecting: "连接中", stopped: "已停止", loading: "加载中…", saving: "正在保存…",
  required: "请填写名称和项目目录。", tokenRequired: "请填写 Bot Token 和至少一个允许的用户 ID。",
  conversations: "已收到的对话", noConversations: "收到消息后，对话及其关联的 Pi 会话会出现在这里。",
  newSession: "新建会话（下条消息自动创建）", currentSession: "当前关联会话", session: "关联 Pi 会话",
  bindingHint: "每个对话独立关联会话；未关联时自动新建，不会选用项目最近会话。",
  noBots: "尚未添加机器人", selectBot: "选择机器人或添加一个。", refresh: "刷新", enabled: "运行状态",
  retry: "重试", unavailableQr: "二维码尚未就绪。请重新获取。", noChanges: "没有待保存的更改。",
  projectChanged: "保存项目目录后，可选择新项目的会话。", sessionsFailed: "无法读取项目会话。",
} : {
  title: "Messaging", add: "Add bot", telegram: "Telegram", weixin: "WeChat", name: "Name",
  cwd: "Project directory", token: "Bot Token", users: "Allowed user IDs", chats: "Allowed chat IDs (optional)",
  idsHint: "Separate IDs with commas or newlines.", chatsHint: "Leave empty for no additional chat ID restriction.",
  ownerHint: "WeChat only accepts messages from the account that scans the code.", save: "Save", remove: "Delete bot", cancel: "Cancel",
  confirmRemove: "Delete this bot?", start: "Start", stop: "Stop", create: "Create bot",
  scan: "Get WeChat QR code", scanAlt: "Scan this code with WeChat", scanHint: "Scan with WeChat and confirm sign-in.",
  waiting: "Waiting for scan", scanned: "Scanned, awaiting confirmation", connected: "Connected", expired: "QR code expired. Get a new code.",
  error: "Connection error", connecting: "Connecting", stopped: "Stopped", loading: "Loading…", saving: "Saving…",
  required: "Enter a name and project directory.", tokenRequired: "Enter a Bot Token and at least one allowed user ID.",
  conversations: "Received conversations", noConversations: "Conversations and their linked Pi sessions appear here after a message arrives.",
  newSession: "New session (created on the next message)", currentSession: "Currently linked session", session: "Linked Pi session",
  bindingHint: "Each conversation has its own session. Unlinked conversations create a new one; the latest project session is never selected automatically.",
  noBots: "No bots added", selectBot: "Select a bot or add one.", refresh: "Refresh", enabled: "Runtime status",
  retry: "Retry", unavailableQr: "QR code is unavailable. Get a new code.", noChanges: "No changes to save.",
  projectChanged: "Save the project directory to choose sessions from the new project.", sessionsFailed: "Could not load project sessions.",
};

export type ImCopy = ReturnType<typeof imCopy>;

export function parseImIds(value: string): string[] {
  return [...new Set(value.split(/[,，\s]+/).map((id) => id.trim()).filter(Boolean))];
}
