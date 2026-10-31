"use client";

import { useEffect, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { useTheme } from "@/hooks/useTheme";
import { copyText } from "@/lib/clipboard";
import { readHttpProtocol, readPageVisibility, startPageVisibilityTracking } from "@/lib/page-debug";
import type { ObserverTelemetry } from "./ObserverPanel";
import type { SessionInfo } from "@/lib/types";
import { DEBUG_POLL_MS, DEBUG_TICK_MS, EMPTY_DEBUG_SERVER_READING, type DebugServerReading } from "@/components/debug-panel-state";
import { createDebugPageObserver } from "./page-observer";
import { DebugPageView } from "./DebugPageView";

/** A separate observer, never a chat mount: it owns no event stream or session lease. */
export function DebugPage() {
  const { t, locale } = useI18n();
  useTheme();
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const selectedRef = useRef<string | null>(null);
  const observerRef = useRef<ReturnType<typeof createDebugPageObserver> | null>(null);
  const [server, setServer] = useState<DebugServerReading>(EMPTY_DEBUG_SERVER_READING);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [catalogError, setCatalogError] = useState(false);
  const [catalogReceivedAt, setCatalogReceivedAt] = useState<number | null>(null);
  const [now, setNow] = useState(0);
  const [hidden, setHidden] = useState(false);
  const [copied, setCopied] = useState(false);
  const [telemetry, setTelemetry] = useState<ObserverTelemetry>({ samples: [], inFlightSince: null, protocol: null });
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    startPageVisibilityTracking();
    const observer = createDebugPageObserver({
      fetch: (url, init) => fetch(url, init),
      sessionId: () => selectedRef.current,
      isVisible: () => document.visibilityState === "visible",
      onReading: (reading) => {
        setServer(reading);
        setTelemetry(previous => ({
          ...previous,
          inFlightSince: null,
          protocol: readHttpProtocol(),
          visibility: readPageVisibility(),
          samples: reading.failure || reading.roundTripMs === null || reading.receivedAt === null
            ? previous.samples
            : [...previous.samples, { at: reading.receivedAt, ms: reading.roundTripMs }].slice(-24),
        }));
      },
      onCatalog: (catalog, failed) => {
        if (catalog) {
          setSessions(catalog);
          setCatalogReceivedAt(Date.now());
        }
        setCatalogError(failed);
      },
    });
    observerRef.current = observer;
    const visibilityChanged = () => {
      const isHidden = document.visibilityState !== "visible";
      setHidden(isHidden);
      setTelemetry(previous => ({ ...previous, visibility: readPageVisibility() }));
      if (!isHidden) {
        setNow(Date.now());
        observer.poll();
      }
    };
    visibilityChanged();
    const tick = setInterval(() => {
      if (document.visibilityState === "visible") {
        setNow(Date.now());
        setTelemetry(previous => ({ ...previous, inFlightSince: observer.inFlightSince(), protocol: readHttpProtocol(), visibility: readPageVisibility() }));
      }
    }, DEBUG_TICK_MS);
    const poll = setInterval(() => observer.poll(), DEBUG_POLL_MS);
    document.addEventListener("visibilitychange", visibilityChanged);
    return () => {
      mountedRef.current = false;
      observer.dispose();
      observerRef.current = null;
      clearInterval(tick);
      clearInterval(poll);
      document.removeEventListener("visibilitychange", visibilityChanged);
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    };
  }, []);

  const toggleSession = (id: string) => {
    const next = selectedRef.current === id ? null : id;
    selectedRef.current = next;
    setSelectedSessionId(next);
    observerRef.current?.sync();
  };

  const copySnapshot = () => {
    const reply = server.reply;
    const payload = {
      ...reply,
      session: reply?.session?.sessionId === selectedSessionId ? reply?.session : null,
      observation: {
        ...telemetry, hidden, now, catalogError, catalogReceivedAt,
        receivedAt: server.receivedAt, roundTripMs: server.roundTripMs, failure: server.failure,
        requests: server.requests, failures: server.failures, consecutiveFailures: server.consecutiveFailures,
      },
    };
    void copyText(JSON.stringify(payload, null, 2)).then(() => {
      if (!mountedRef.current) return;
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
      setCopied(true);
      copyTimerRef.current = setTimeout(() => setCopied(false), 1400);
    }, () => {});
  };

  return (
    <DebugPageView
      server={server}
      telemetry={telemetry}
      now={now}
      hidden={hidden}
      sessions={sessions}
      catalogError={catalogError}
      catalogReceivedAt={catalogReceivedAt}
      selectedSessionId={selectedSessionId}
      onToggleSession={toggleSession}
      onCopy={copySnapshot}
      copied={copied}
      t={t}
      locale={locale}
    />
  );
}
