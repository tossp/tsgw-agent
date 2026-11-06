"use client";

import { useEffect, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { useTheme } from "@/hooks/useTheme";
import { copyText } from "@/lib/clipboard";
import { readHttpProtocol, readPageVisibility, startPageVisibilityTracking } from "@/lib/page-debug";
import type { ObserverTelemetry } from "./ObserverPanel";
import type { SessionInfo } from "@/lib/types";
import { debugPollSample, DEBUG_POLL_MS, DEBUG_TICK_MS, EMPTY_DEBUG_SERVER_READING, type DebugServerReading } from "@/components/debug-panel-state";
import { createResourcePageObserver, type ResourceReadings } from "./resource-observer";
import { createLiveModelObserver, type LiveModelReadings } from "./live-model-observer";
import { DebugPageView } from "./DebugPageView";

/** A separate observer, never a chat mount: it owns no event stream or session lease. */
export function DebugPage() {
  const { t, locale } = useI18n();
  useTheme();
  const [server, setServer] = useState<DebugServerReading>(EMPTY_DEBUG_SERVER_READING);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [resources, setResources] = useState<ResourceReadings>({});
  const [liveModels, setLiveModels] = useState<LiveModelReadings>({});
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
    let nextPollAt = Date.now() + DEBUG_POLL_MS;
    const models = createLiveModelObserver({
      fetch: (url, init) => fetch(url, init),
      isVisible: () => document.visibilityState === "visible",
      onReading: setLiveModels,
    });
    const observer = createResourcePageObserver({
      fetch: (url, init) => fetch(url, init),
      isVisible: () => document.visibilityState === "visible",
      onReading: (reading) => {
        setServer(reading);
        setTelemetry(previous => ({
          ...previous,
          inFlightSince: null,
          protocol: readHttpProtocol(),
          visibility: readPageVisibility(),
          samples: (() => {
            const sample = debugPollSample(reading);
            return sample === null ? previous.samples : [...previous.samples, { ...sample, at: reading.failure?.at ?? reading.receivedAt ?? Date.now() }].slice(-24);
          })(),
        }));
        if (reading.reply) {
          const ids = reading.reply.sessions.map(session => session.sessionId);
          models.retain(ids);
          if (reading.sessionId) models.poll(reading.sessionId);
        }
      },
      onResources: setResources,
      onCatalog: (catalog, failed) => {
        if (catalog) {
          setSessions(catalog);
          setCatalogReceivedAt(Date.now());
        }
        setCatalogError(failed);
      },
    });
    const visibilityChanged = () => {
      const isHidden = document.visibilityState !== "visible";
      setHidden(isHidden);
      setTelemetry(previous => ({ ...previous, visibility: readPageVisibility() }));
      if (!isHidden) {
        setNow(Date.now());
        observer.poll(nextPollAt);
      }
    };
    visibilityChanged();
    const tick = setInterval(() => {
      if (document.visibilityState === "visible") {
        setNow(Date.now());
        setTelemetry(previous => ({ ...previous, inFlightSince: observer.inFlightSince(), nextDebugCheckAt: observer.nextDebugCheckAt(), catalog: observer.catalogTelemetry(), protocol: readHttpProtocol(), visibility: readPageVisibility() }));
      }
    }, DEBUG_TICK_MS);
    const poll = setInterval(() => {
      nextPollAt = Date.now() + DEBUG_POLL_MS;
      observer.poll(nextPollAt);
    }, DEBUG_POLL_MS);
    document.addEventListener("visibilitychange", visibilityChanged);
    return () => {
      mountedRef.current = false;
      observer.dispose();
      models.dispose();
      clearInterval(tick);
      clearInterval(poll);
      document.removeEventListener("visibilitychange", visibilityChanged);
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    };
  }, []);

  const copySnapshot = () => {
    const reply = server.reply;
    const payload = {
      ...reply,
      resources,
      liveModels,
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
      resources={resources}
      liveModels={liveModels}
      onCopy={copySnapshot}
      copied={copied}
      t={t}
      locale={locale}
    />
  );
}
