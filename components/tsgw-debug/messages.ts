import { translateMessage } from "@/lib/i18n/format";
import type { Locale, TranslationParams } from "@/lib/i18n/types";

/**
 * The Debug page's own words. Everything it borrows from the panel (countdowns, states, streams'
 * titles, MCP states) is translated by the `t` the page receives, so the global dictionaries keep
 * one wording for those. Only what the page alone says lives here: its title and read-only note,
 * the failure and residual notices, and the detail's block names. Adding a page string means adding
 * it in all three locales below, never a new global key.
 */
const EN = {
  "page.label": "Debug page: the server's state and the sessions it holds",
  "page.readOnly":
    "Read-only: this page asks GET /api/agent/debug and shows what the server reports. It starts, keeps alive or reconnects nothing, and it cannot see another window's own state.",
  "page.copyTitle": "Copy this page's data as JSON",
  "page.expand": "Show details",
  "page.collapse": "Hide details",
  "page.catalogFailed": "The session list could not be read: sessions are shown by id.",
  "page.stale": "Not the latest answer: {reason}. Showing the answer from {time}.",
  "page.staleCount": "{count} failures in a row",
  "page.residual": "The last answer still holds this session, but its list has no row for it.",
  "sessions.title": "Sessions the server holds",
  "detail.waiting": "Waiting for the server's answer about this session…",
  "detail.streams": "Event streams",
  "detail.history": "Process history",
  "detail.firstStart": "first {time}",
};

export type DebugPageKey = keyof typeof EN;

/** Every locale carries every key of EN; the annotation is what holds them together. */
export const DEBUG_PAGE_MESSAGES: Record<Locale, Record<DebugPageKey, string>> = {
  en: EN,
  "zh-CN": {
    "page.label": "调试页：服务器状态与它持有的会话",
    "page.readOnly":
      "只读：本页请求 GET /api/agent/debug，展示服务器报告的内容。它不会启动、保活或重连任何会话，也看不到其他窗口自身的状态。",
    "page.copyTitle": "把本页数据复制为 JSON",
    "page.expand": "展开详情",
    "page.collapse": "收起详情",
    "page.catalogFailed": "会话列表读取失败：按会话 ID 显示。",
    "page.stale": "不是最新结果：{reason}。下面是 {time}的回答。",
    "page.staleCount": "连续失败 {count} 次",
    "page.residual": "上一次回答仍持有该会话，但它的列表里已没有这一行。",
    "sessions.title": "服务器持有的会话",
    "detail.waiting": "正在等待服务器对这条会话的回答…",
    "detail.streams": "事件流",
    "detail.history": "进程历史",
    "detail.firstStart": "首次 {time}",
  },
  "zh-TW": {
    "page.label": "除錯頁：伺服器狀態與它持有的工作階段",
    "page.readOnly":
      "唯讀：本頁請求 GET /api/agent/debug，顯示伺服器回報的內容。它不會啟動、保活或重新連線任何工作階段，也看不到其他視窗自身的狀態。",
    "page.copyTitle": "將本頁資料複製為 JSON",
    "page.expand": "展開詳情",
    "page.collapse": "收合詳情",
    "page.catalogFailed": "工作階段清單讀取失敗：以工作階段 ID 顯示。",
    "page.stale": "不是最新結果：{reason}。以下是 {time}的回應。",
    "page.staleCount": "連續失敗 {count} 次",
    "page.residual": "上一次回應仍持有此工作階段，但清單中已沒有這一列。",
    "sessions.title": "伺服器持有的工作階段",
    "detail.waiting": "正在等待伺服器對此工作階段的回應…",
    "detail.streams": "事件串流",
    "detail.history": "行程歷史",
    "detail.firstStart": "首次 {time}",
  },
};

/** One of the page's own strings in `locale`, falling back to English as the app's dictionaries do. */
export function debugPageText(locale: Locale, key: DebugPageKey, params?: TranslationParams): string {
  return translateMessage(locale, key, DEBUG_PAGE_MESSAGES, params);
}
