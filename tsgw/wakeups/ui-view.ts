import type { Locale } from "@/lib/i18n/types";
import type { WakeupHealth, WakeupQueryItem, WakeupStatus } from "./types";

const EN = {
  title: "Wakeups", close: "Close", loading: "Loading…", empty: "No wakeups.",
  clear: "Clear", clearing: "Clearing…", clearFailed: "Could not confirm cleanup. Refresh to check the record.",
  loadMore: "Show more", retry: "Try again", readFailed: "Could not refresh wakeups. Previously loaded records are kept.",
  detailFailed: "Could not read the details.", missing: "This wakeup is no longer available.",
  active: "active", verify: "to verify", more: "+", details: "Details", message: "Handoff message",
  project: "Project", noProject: "Not recorded", scheduled: "Originally scheduled", updated: "Last updated",
  source: "Source session", target: "Target session", response: "Run response", created: "Created", received: "Received", settled: "Run ended",
  armed: "Scheduled", unarmed: "This instance is not scheduling this wakeup", unsaved: "Observed in this process; not saved.",
  semantics: "Received means the notification was received. Run ended describes the run containing it; it does not confirm task success.",
  diagnostics: "Storage details",
  pending: "Pending", dispatching: "Delivering", submitted: "Accepted (may be queued)",
  statusReceived: "Notification received", run_settled: "Run ended", run_aborted: "Run interrupted",
  delivery_failed: "Delivery failed", cancelled: "Cancelled", unknown: "Needs verification",
  ready: "Storage available", starting: "Starting scheduling", read_only: "Managed by another instance; read only here",
  paused: "Scheduling paused", storage_error: "Storage unavailable; scheduling paused",
} as const;
type Key = keyof typeof EN;
const MESSAGES: Record<Locale, Record<Key, string>> = {
  en: EN,
  "zh-CN": {
    title: "唤醒", close: "关闭", loading: "正在读取…", empty: "暂无唤醒任务。",
    clear: "清理", clearing: "正在清理…", clearFailed: "清理结果未确认，请刷新后查看。",
    loadMore: "显示更多", retry: "重试", readFailed: "唤醒状态刷新失败，保留已读取记录。",
    detailFailed: "详情读取失败。", missing: "此唤醒任务已不可用。",
    active: "未终结", verify: "待核实", more: "+", details: "详情", message: "交接正文",
    project: "项目", noProject: "未记录", scheduled: "原定时间", updated: "最新状态时间",
    source: "来源会话", target: "目标会话", response: "所在运行响应", created: "创建时间", received: "收到时间", settled: "运行结束时间",
    armed: "已安排触发", unarmed: "本实例未安排触发", unsaved: "本进程已观察到，尚未保存。",
    semantics: "“通知已收到”仅表示通知收到；“所在运行已结束”仅表示包含该通知的运行结束，不代表任务成功。",
    diagnostics: "存储详情",
    pending: "待触发", dispatching: "投递中", submitted: "已接受（可能排队）",
    statusReceived: "通知已收到", run_settled: "所在运行已结束", run_aborted: "所在运行已中断",
    delivery_failed: "投递失败", cancelled: "已取消", unknown: "待核实",
    ready: "存储正常", starting: "调度正在启动", read_only: "由另一实例管理，本实例只读",
    paused: "调度已暂停", storage_error: "存储异常，调度已暂停",
  },
  "zh-TW": {
    title: "喚醒", close: "關閉", loading: "正在讀取…", empty: "暫無喚醒工作。",
    clear: "清理", clearing: "正在清理…", clearFailed: "清理結果未確認，請重新整理後查看。",
    loadMore: "顯示更多", retry: "重試", readFailed: "喚醒狀態重新整理失敗，保留已讀取紀錄。",
    detailFailed: "詳情讀取失敗。", missing: "此喚醒工作已無法使用。",
    active: "未終結", verify: "待核實", more: "+", details: "詳情", message: "交接正文",
    project: "專案", noProject: "未記錄", scheduled: "原定時間", updated: "最新狀態時間",
    source: "來源工作階段", target: "目標工作階段", response: "所在執行回覆", created: "建立時間", received: "收到時間", settled: "執行結束時間",
    armed: "已安排觸發", unarmed: "本執行個體未安排觸發", unsaved: "本程序已觀察到，尚未儲存。",
    semantics: "「通知已收到」僅表示通知收到；「所在執行已結束」僅表示包含該通知的執行結束，不代表工作成功。",
    diagnostics: "儲存詳情",
    pending: "待觸發", dispatching: "傳送中", submitted: "已接受（可能排隊）",
    statusReceived: "通知已收到", run_settled: "所在執行已結束", run_aborted: "所在執行已中斷",
    delivery_failed: "傳送失敗", cancelled: "已取消", unknown: "待核實",
    ready: "儲存正常", starting: "排程正在啟動", read_only: "由另一執行個體管理，本執行個體唯讀",
    paused: "排程已暫停", storage_error: "儲存異常，排程已暫停",
  },
};
export function wakeupText(locale: Locale, key: Key): string { return (MESSAGES[locale] ?? EN)[key]; }
export function wakeupStatusText(locale: Locale, status: WakeupStatus): string {
  if (status === "received") return wakeupText(locale, "statusReceived");
  return wakeupText(locale, status in EN ? status : "unknown");
}
export function wakeupTime(locale: Locale, value: string): string {
  const time = new Date(value);
  return Number.isFinite(time.getTime()) ? new Intl.DateTimeFormat(locale, {
    year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", timeZoneName: "short",
  }).format(time) : value;
}

/** Counts describe loaded records only; a cursor is shown as +, never an invented total. */
export function wakeupCounts(items: WakeupQueryItem[]) {
  return items.reduce((counts, item) => {
    if (["pending", "dispatching", "submitted", "received"].includes(item.status)) counts.active++;
    if (item.status === "unknown") counts.unknown++;
    return counts;
  }, { active: 0, unknown: 0 });
}
export function showWakeupTrigger(items: WakeupQueryItem[], health?: WakeupHealth, failed = false): boolean {
  return items.length > 0 || Boolean(health && health.state !== "ready") || failed;
}

/** Matches the API's createdAt/wakeupId ordering, including timestamp ties. */
export function compareWakeupCreation(a: WakeupQueryItem, b: WakeupQueryItem): number {
  return a.createdAt.localeCompare(b.createdAt) || a.wakeupId.localeCompare(b.wakeupId);
}

/** Refresh removes missing rows; paging appends without changing the reading order. */
export function mergeWakeupRows(previous: WakeupQueryItem[], incoming: WakeupQueryItem[], append = false): WakeupQueryItem[] {
  const updates = new Map(incoming.map(item => [item.wakeupId, item]));
  const seen = new Set(previous.map(item => item.wakeupId));
  return [...previous.filter(item => append || updates.has(item.wakeupId)).map(item => updates.get(item.wakeupId) ?? item), ...Array.from(updates.values()).filter(item => !seen.has(item.wakeupId))];
}
