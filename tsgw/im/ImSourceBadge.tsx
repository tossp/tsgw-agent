"use client";

import { useI18n } from "@/hooks/useI18n";
import type { ImMessageSource } from "./message-data";
import { imCopy } from "./im-ui";
import styles from "./im-source-badge.module.css";

export function ImSourceBadge({ source }: { source: ImMessageSource }) {
  const { locale } = useI18n();
  const copy = imCopy(locale);
  const label = source.channel === "weixin" ? copy.weixin : copy.telegram;

  return (
    <span className={styles.badge} title={source.botName}>
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {source.channel === "weixin" ? (
          <>
            <path d="M14 8.5C13.7 5.4 11 3 7.8 3 4 3 1 5.6 1 8.8c0 1.8.9 3.4 2.4 4.5L3 16l2.8-1.5c.6.2 1.3.3 2 .3" />
            <path d="M23 14.5c0-3-2.7-5.5-6-5.5s-6 2.5-6 5.5 2.7 5.5 6 5.5c.6 0 1.2-.1 1.8-.2L21.5 21l-.4-2.5c1.2-1 1.9-2.4 1.9-4Z" />
            <path d="M5.5 7h.1M10 7h.1M14.5 13h.1M19 13h.1" strokeWidth="2.4" />
          </>
        ) : (
          <>
            <path d="m22 3-4 18-6-5-4 3 1-7L22 3ZM9 12 2 9 22 3M12 16l10-13" />
          </>
        )}
      </svg>
      <span>{label}</span>
    </span>
  );
}
