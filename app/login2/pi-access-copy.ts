import type { PiAccessPhase } from "./PiAccessScene";

const piSubtitles: Record<PiAccessPhase, string> = {
  checking: "CONNECTING TO ACCESS TERMINAL", intro: "PI WEB · AGENT ACCESS TERMINAL",
  wash: "INITIALIZING ACCESS SEQUENCE", permission: "ACCESS PERMISSION REQUIRED",
  password: "IDENTITY VERIFICATION", request: "ACCESS REQUEST RECEIVED",
  read: "READING PERMISSION SET", verified: "READ COMPLETE · VERIFIED",
  welcome: "WELCOME TO PI WEB", handoff: "SESSION ESTABLISHED",
};

const piLogSubtitles: Record<PiAccessPhase, string> = {
  checking: "CHECKING EXISTING SESSION", intro: "SYSTEM SELF-CHECK", wash: "INITIALIZING ACCESS",
  permission: "AWAITING OPERATOR CONSENT", password: "MATCHING OPERATOR RECORD",
  request: "HANDSHAKE ESTABLISHED", read: "READING PERMISSION SET",
  verified: "PERMISSION AUTHORIZED", welcome: "IDENTITY VERIFIED · SESSION ESTABLISHED", handoff: "OPENING WORKSPACE",
};

const piCopies = {
  en: {
    original: "Skip animation · Original login ↗", enter: "Enter Pi Web ↗",
    enableAudio: "Enable Chinese voice", muteAudio: "Mute voice",
    identityCard: "Identity credentials", identityToken: "Identity token", identityNumber: "Identity number",
    accessLevel: "Access level", confirmIdentity: "Confirm identity", clickEnter: "Click to enter",
    sessionExpired: "Your session has expired. Please enter your identity token again.",
    existingPermission: "Your session is valid. Confirm to enter.", existingPassword: "Identity confirmed. Click to enter the workspace.",
    titles: {
      checking: "Connecting", intro: "Pi Web", wash: "Initializing", permission: "Access required",
      password: "Verify identity", request: "Request received", read: "Reading permissions",
      verified: "Identity verified", welcome: "Welcome", handoff: "Entering Pi Web",
    },
    logs: {
      checking: "Checking your existing Pi Web session…", intro: "Agent access terminal · Ready to connect",
      wash: "Preparing secure access…", permission: "A password is required to access this terminal.",
      password: "Enter your Pi Web password to continue.", request: "Session authenticated. Preparing the workspace…",
      read: "Access granted · Preparing the handoff", verified: "Verification complete · Session established",
      welcome: "Your Pi Web workspace is ready.", handoff: "Opening your destination…",
    },
  },
  "zh-CN": {
    original: "跳过动画 · 普通登录 ↗", enter: "直接进入 Pi Web ↗",
    enableAudio: "开启中文播报", muteAudio: "关闭播报",
    identityCard: "身份资料", identityToken: "身份令牌", identityNumber: "身份编号",
    accessLevel: "权限等级", confirmIdentity: "确认身份", clickEnter: "点击进入",
    sessionExpired: "登录会话已失效，请重新填写身份令牌。",
    existingPermission: "已有有效登录状态，确认后即可进入。", existingPassword: "身份已确认，点击进入工作区。",
    titles: {
      checking: "连接访问终端", intro: "智能协作", wash: "初始化访问序列", permission: "需要访问许可",
      password: "身份资料确认", request: "接收访问需求", read: "开始读取权限",
      verified: "读取完毕 · 核验通过", welcome: "欢迎访问", handoff: "进入 Pi Web",
    },
    logs: {
      checking: "正在检查已有的 Pi Web 登录状态…", intro: "智能协作终端 · 等待连接",
      wash: "准备安全访问通道…", permission: "此终端需要访问密码。",
      password: "输入 Pi Web 访问密码，继续身份核验。", request: "身份验证成功，正在准备工作区…",
      read: "访问已授权 · 准备进入工作区", verified: "身份核验完成，会话已建立",
      welcome: "Pi Web 工作区已就绪。", handoff: "正在打开目标页面…",
    },
  },
  "zh-TW": {
    original: "跳過動畫 · 一般登入 ↗", enter: "直接進入 Pi Web ↗",
    enableAudio: "開啟中文播報", muteAudio: "關閉播報",
    identityCard: "身分資料", identityToken: "身分權杖", identityNumber: "身分編號",
    accessLevel: "權限等級", confirmIdentity: "確認身分", clickEnter: "點擊進入",
    sessionExpired: "登入工作階段已失效，請重新填寫身分權杖。",
    existingPermission: "已有有效登入狀態，確認後即可進入。", existingPassword: "身分已確認，點擊進入工作區。",
    titles: {
      checking: "連接存取終端", intro: "智慧協作", wash: "初始化存取序列", permission: "需要存取許可",
      password: "身分資料確認", request: "接收存取需求", read: "開始讀取權限",
      verified: "讀取完畢 · 驗證通過", welcome: "歡迎存取", handoff: "進入 Pi Web",
    },
    logs: {
      checking: "正在檢查既有的 Pi Web 登入狀態…", intro: "智慧協作終端 · 等待連接",
      wash: "準備安全存取通道…", permission: "此終端需要存取密碼。",
      password: "輸入 Pi Web 存取密碼，繼續身分驗證。", request: "身分驗證成功，正在準備工作區…",
      read: "存取已授權 · 準備進入工作區", verified: "身分驗證完成，工作階段已建立",
      welcome: "Pi Web 工作區已就緒。", handoff: "正在開啟目標頁面…",
    },
  },
};

export function getPiAccessCopy(piLocale: string, piPhase: PiAccessPhase, piAuthenticated = false) {
  const piCopy = piCopies[piLocale as keyof typeof piCopies] || piCopies.en;
  return {
    title: piCopy.titles[piPhase], subtitle: piSubtitles[piPhase],
    log: piAuthenticated && piPhase === "permission" ? piCopy.existingPermission
      : piAuthenticated && piPhase === "password" ? piCopy.existingPassword : piCopy.logs[piPhase],
    logSubtitle: piLogSubtitles[piPhase], identityCard: piCopy.identityCard, identityToken: piCopy.identityToken,
    identityNumber: piCopy.identityNumber, accessLevel: piCopy.accessLevel, confirmIdentity: piCopy.confirmIdentity,
    clickEnter: piCopy.clickEnter, sessionExpired: piCopy.sessionExpired,
    original: piCopy.original, enter: piCopy.enter, enableAudio: piCopy.enableAudio, muteAudio: piCopy.muteAudio,
  };
}
