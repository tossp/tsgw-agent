"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ImAction, ImSnapshot, WeixinLoginResult } from "./types";
import { reportImError } from "./telemetry";

export async function imRequest<T>(signal: AbortSignal, action?: ImAction, cwd?: string): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api/tsgw/im${cwd === undefined ? "" : `?cwd=${encodeURIComponent(cwd)}`}`, {
      signal, cache: "no-store",
      ...(action ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(action) } : {}),
    });
  } catch (error) {
    if (!signal.aborted) reportImError("settings-request");
    throw error;
  }
  let data: T & { error?: string };
  try {
    data = await response.json() as T & { error?: string };
  } catch (error) {
    if (!signal.aborted && (response.status < 400 || response.status >= 500)) reportImError("settings-response");
    throw error;
  }
  if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
  return data;
}

export function useImSettings() {
  const [snapshot, setSnapshot] = useState<ImSnapshot | null>(null);
  const [login, setLogin] = useState<WeixinLoginResult | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const pollController = useRef<AbortController | null>(null);
  const pending = useRef(false);
  const revision = useRef(0);

  const refresh = useCallback(async () => {
    const scope = controller.current;
    if (!scope || scope.signal.aborted) return;
    const version = ++revision.current;
    try {
      const next = await imRequest<ImSnapshot>(scope.signal);
      if (!scope.signal.aborted && version === revision.current) {
        setSnapshot(next);
        setError("");
      }
    } catch (cause) {
      if (!scope.signal.aborted && version === revision.current) setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    const scope = new AbortController();
    controller.current = scope;
    void refresh();
    const timer = setInterval(() => { if (!pending.current) void refresh(); }, 5000);
    return () => { scope.abort(); clearInterval(timer); };
  }, [refresh]);

  const act = useCallback(async (action: ImAction): Promise<boolean> => {
    const scope = controller.current;
    if (!scope || scope.signal.aborted || pending.current) return false;
    pending.current = true;
    ++revision.current;
    setBusy(true);
    setError("");
    try {
      if (action.action === "login-weixin") setLogin(null);
      const result = await imRequest<ImSnapshot | WeixinLoginResult>(scope.signal, action);
      if (scope.signal.aborted) return false;
      if (action.action === "login-weixin" || action.action === "poll-weixin") setLogin(result as WeixinLoginResult);
      if (action.action === "cancel-weixin") {
        pollController.current?.abort();
        setLogin((current) => current?.id === action.loginId ? null : current);
      }
      await refresh();
      return true;
    } catch (cause) {
      if (!scope.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause));
      return false;
    } finally {
      pending.current = false;
      if (!scope.signal.aborted) setBusy(false);
    }
  }, [refresh]);

  const loginId = login?.id;
  const polling = login?.state === "waiting" || login?.state === "scanned";
  useEffect(() => {
    if (!loginId || !polling) return;
    const scope = new AbortController();
    pollController.current = scope;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      if (scope.signal.aborted) return;
      if (pending.current) { timer = setTimeout(poll, 2000); return; }
      try {
        const next = await imRequest<WeixinLoginResult>(scope.signal, { action: "poll-weixin", loginId });
        if (scope.signal.aborted) return;
        setLogin((current) => current?.id === next.id ? { ...current, ...next } : current);
        if (next.state === "connected") await refresh();
        if (next.state === "waiting" || next.state === "scanned") timer = setTimeout(poll, 2000);
      } catch (cause) {
        if (!scope.signal.aborted) {
          setLogin((current) => current?.id === loginId ? { ...current, state: "error", error: cause instanceof Error ? cause.message : String(cause) } : current);
        }
      }
    };
    timer = setTimeout(poll, 2000);
    return () => { scope.abort(); clearTimeout(timer); };
  }, [loginId, polling, refresh]);

  const cancelLogin = () => login ? act({ action: "cancel-weixin", loginId: login.id }) : Promise.resolve(false);
  return { snapshot, login, error, busy, act, refresh, cancelLogin };
}
