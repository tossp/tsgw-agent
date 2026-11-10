"use client";

import { useI18n } from "@/hooks/useI18n";

export function NoticeDismissButton({ noticeId, onDismiss }: { noticeId: string; onDismiss: (id: string) => void }) {
  const { t } = useI18n();
  return (
    <button
      type="button"
      className="notice-shelf-dismiss"
      aria-label={t("chat.close")}
      title={t("chat.close")}
      onClick={() => onDismiss(noticeId)}
      style={{ flexShrink: 0, width: 44, height: 44, margin: "7px -8px 0 -6px", display: "grid", placeItems: "center", border: "none", borderRadius: 8, background: "transparent", color: "var(--text-muted)", cursor: "pointer" }}
    >
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8" /></svg>
    </button>
  );
}
