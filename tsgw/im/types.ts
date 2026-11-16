export type ImChannel = "weixin" | "telegram";

export interface TelegramCredentials {
  token: string;
  username: string;
}

export interface WeixinCredentials {
  token: string;
  baseUrl: string;
  accountId: string;
  ownerUserId: string;
}

export interface ImBot {
  id: string;
  channel: ImChannel;
  name: string;
  cwd: string;
  enabled: boolean;
  allowedUserIds: string[];
  allowedChatIds: string[];
  credentials: TelegramCredentials | WeixinCredentials;
}

export interface ImAttachment {
  type: "image" | "file";
  path: string;
  name: string;
  mimeType: string;
}

export interface ImReply {
  text: string;
  attachments?: ImAttachment[];
}

export interface ImInbound {
  id: string;
  /** Native message ID when the receipt key above differs (Telegram update_id). */
  messageId?: string;
  chatId: string;
  senderId: string;
  text: string;
  isGroup: boolean;
  threadId?: string;
  chatTitle?: string;
  attachments?: ImAttachment[];
  quotedText?: string;
  /** Safe local preparation failure; reply to the sender without invoking the model. */
  preparationError?: string;
}

export interface ImDriverStatus {
  state: "stopped" | "connecting" | "connected" | "error";
  error?: string;
}

export interface ImDriver {
  start(): void;
  stop(): Promise<void>;
  send(message: ImInbound, text: string): Promise<void>;
  sendAttachment?(message: ImInbound, attachment: ImAttachment, signal?: AbortSignal): Promise<void>;
  setTyping?(message: ImInbound, active: boolean): void;
}

export interface ImDriverOptions {
  bot: ImBot;
  checkpoint: Record<string, unknown>;
  saveCheckpoint(checkpoint: Record<string, unknown>): Promise<void>;
  onMessage(message: ImInbound, prepare?: (signal: AbortSignal) => Promise<ImInbound>): Promise<void>;
  onStatus(status: ImDriverStatus): void;
  fetchImpl?: typeof fetch;
  mediaDirectory?: string;
}

export interface WeixinLogin {
  id: string;
  state: "waiting" | "scanned" | "connected" | "expired" | "error";
  qrUrl?: string;
  botId?: string;
  error?: string;
}

export interface ImConversation {
  key: string;
  botId: string;
  chatId: string;
  threadId?: string;
  title: string;
  sessionId: string | null;
  cwd: string;
  updatedAt: string;
}

export interface ImBotView extends Omit<ImBot, "credentials"> {
  status: ImDriverStatus;
  username?: string;
}

export interface ImSessionView {
  id: string;
  title: string;
  cwd: string;
}

export interface ImSnapshot {
  bots: ImBotView[];
  conversations: ImConversation[];
}

export type ImAction =
  | { action: "add-telegram"; token: string; name: string; cwd: string; allowedUserIds: string[]; allowedChatIds: string[] }
  | { action: "login-weixin"; name: string; cwd: string }
  | { action: "poll-weixin"; loginId: string }
  | { action: "cancel-weixin"; loginId: string }
  | { action: "update-bot"; botId: string; name: string; cwd: string; enabled: boolean; allowedUserIds: string[]; allowedChatIds: string[] }
  | { action: "remove-bot"; botId: string }
  | { action: "bind"; conversationKey: string; sessionId: string | null };

export interface WeixinLoginResult extends WeixinLogin {
  qrImage?: string;
}
