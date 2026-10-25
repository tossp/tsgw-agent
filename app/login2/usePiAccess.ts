import { useCallback, useEffect, useRef, useState } from "react";
import { safeLoginDestination } from "@/lib/login-destination";
import { readPiAccessAuth, submitPiAccessPassword, type PiAccessFailure } from "./pi-access-auth";
import type { PiAccessPhase } from "./PiAccessScene";

const piTimedPhases: Partial<Record<PiAccessPhase, { next: PiAccessPhase; delay: number }>> = {
  intro: { next: "wash", delay: 2700 },
  wash: { next: "permission", delay: 1020 },
  permission: { next: "password", delay: 2600 },
  request: { next: "read", delay: 1600 },
  read: { next: "verified", delay: 4900 },
  verified: { next: "welcome", delay: 3550 },
  welcome: { next: "handoff", delay: 3900 },
};

function getPiAccessDestination(): string {
  const piDestination = safeLoginDestination(new URLSearchParams(window.location.search).get("next"), window.location.origin);
  const piUrl = new URL(piDestination, window.location.origin);
  // Avoid replay/redirect loops when someone supplied a login page as next.
  return /^\/login(?:2)?(?:\/|$)/.test(piUrl.pathname) ? "/" : piDestination;
}

export function usePiAccess() {
  const [piPhase, setPiPhase] = useState<PiAccessPhase>("checking");
  const [piBusy, setPiBusy] = useState(false);
  const [piAuthenticated, setPiAuthenticated] = useState(false);
  const [piSourceIp, setPiSourceIp] = useState("");
  const [piFailure, setPiFailure] = useState<PiAccessFailure | null>(null);
  const [piFallbackHref, setPiFallbackHref] = useState("/login");
  const piDestinationRef = useRef("/");
  const piClassicHrefRef = useRef("/login");
  const piPendingRef = useRef<AbortController | null>(null);
  const piMountedRef = useRef(false);
  const piSubmittingRef = useRef(false);
  const piAuthenticatedRef = useRef(false);
  const piReducedMotionRef = useRef(false);

  useEffect(() => {
    piMountedRef.current = true;
    const piController = new AbortController();
    piPendingRef.current = piController;
    const piDestination = getPiAccessDestination();
    piDestinationRef.current = piDestination;
    const piUrl = new URL(piDestination, window.location.origin);
    const piClassicHref = "/login?" + new URLSearchParams({ next: piUrl.pathname + piUrl.search + piUrl.hash });
    piClassicHrefRef.current = piClassicHref;
    setPiFallbackHref(piClassicHref);
    const piMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    piReducedMotionRef.current = piMotion.matches;
    const piMotionChange = () => {
      piReducedMotionRef.current = piMotion.matches;
      if (piMotion.matches) {
        setPiPhase((piCurrent) => {
          if (piCurrent === "checking") return piCurrent;
          return piAuthenticatedRef.current && ["request", "read", "verified", "welcome", "handoff"].includes(piCurrent)
            ? "handoff" : "password";
        });
      }
    };
    piMotion.addEventListener("change", piMotionChange);
    const piTimeout = window.setTimeout(() => piController.abort(), 15000);
    void readPiAccessAuth(piController.signal, (piIp) => {
      if (!piController.signal.aborted) setPiSourceIp(piIp);
    }).then((piAuthenticated) => {
      if (piController.signal.aborted) return;
      if (piAuthenticated) {
        piAuthenticatedRef.current = true;
        setPiAuthenticated(true);
      }
      setPiPhase(piReducedMotionRef.current ? "password" : "intro");
    }).catch(() => {
      if (piPendingRef.current === piController) window.location.replace(piClassicHref);
    }).finally(() => {
      window.clearTimeout(piTimeout);
      if (piPendingRef.current === piController) piPendingRef.current = null;
    });
    return () => {
      piMountedRef.current = false;
      piPendingRef.current?.abort();
      piPendingRef.current = null;
      piController.abort();
      window.clearTimeout(piTimeout);
      piMotion.removeEventListener("change", piMotionChange);
    };
  }, []);

  useEffect(() => {
    if (piPhase === "handoff") {
      const piTimer = window.setTimeout(() => {
        if (piAuthenticatedRef.current) window.location.replace(piDestinationRef.current);
      }, 780);
      return () => window.clearTimeout(piTimer);
    }
    const piStep = piTimedPhases[piPhase];
    if (!piStep) return;
    const piTimer = window.setTimeout(() => setPiPhase(piStep.next), piStep.delay);
    return () => window.clearTimeout(piTimer);
  }, [piPhase]);

  const piSubmit = useCallback(async (piPassword: string): Promise<boolean> => {
    if (!piMountedRef.current || piSubmittingRef.current || piPhase !== "password") return false;
    piSubmittingRef.current = true;
    const piController = new AbortController();
    piPendingRef.current = piController;
    const piTimeout = window.setTimeout(() => piController.abort(), 15000);
    setPiBusy(true);
    setPiFailure(null);
    try {
      const piResult = piAuthenticatedRef.current
        ? { ok: await readPiAccessAuth(piController.signal), failure: { kind: "expired" as const } }
        : await submitPiAccessPassword(piPassword, piController.signal);
      if (piPendingRef.current !== piController) return false;
      if (piController.signal.aborted) throw new Error("Pi Web login timed out");
      if (!piResult.ok) {
        piAuthenticatedRef.current = false;
        setPiAuthenticated(false);
        setPiFallbackHref(piClassicHrefRef.current);
        setPiFailure(piResult.failure);
        return false;
      }
      piAuthenticatedRef.current = true;
      setPiFallbackHref(piDestinationRef.current);
      if (piReducedMotionRef.current) window.location.replace(piDestinationRef.current);
      else setPiPhase("request");
      return true;
    } catch {
      if (piPendingRef.current === piController) setPiFailure({ kind: "failed" });
      return false;
    } finally {
      window.clearTimeout(piTimeout);
      if (piPendingRef.current === piController) {
        piPendingRef.current = null;
        piSubmittingRef.current = false;
        setPiBusy(false);
      }
    }
  }, [piPhase]);

  return { piPhase, piBusy, piFailure, piFallbackHref, piSubmit, piSourceIp, piAuthenticated };
}
