export type PiAccessFailure =
  | { kind: "invalid" | "failed" }
  | { kind: "throttled"; seconds: number };

export type PiAccessResult = { ok: true } | { ok: false; failure: PiAccessFailure };

/** Use the existing authentication contract; never infer login from animation. */
export async function readPiAccessAuth(piSignal: AbortSignal): Promise<boolean> {
  const piResponse = await fetch("/api/web-auth", {
    signal: piSignal, credentials: "same-origin", cache: "no-store", redirect: "error",
  });
  if (!piResponse.ok) throw new Error("Pi Web authentication status unavailable");
  const piState = await piResponse.json();
  if (typeof piState.enabled !== "boolean" || typeof piState.authenticated !== "boolean") {
    throw new Error("Unexpected Pi Web authentication status");
  }
  return !piState.enabled || piState.authenticated;
}

export async function submitPiAccessPassword(piPassword: string, piSignal: AbortSignal): Promise<PiAccessResult> {
  const piResponse = await fetch("/api/web-auth", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: piPassword }),
    signal: piSignal, credentials: "same-origin", cache: "no-store", redirect: "error",
  });
  if (piResponse.status === 401) return { ok: false, failure: { kind: "invalid" } };
  if (piResponse.status === 429) {
    const piSeconds = Number(piResponse.headers.get("retry-after"));
    return {
      ok: false,
      failure: { kind: "throttled", seconds: Number.isFinite(piSeconds) && piSeconds > 0 ? Math.ceil(piSeconds) : 1 },
    };
  }
  if (!piResponse.ok || (await piResponse.json())?.ok !== true) {
    return { ok: false, failure: { kind: "failed" } };
  }
  // Also verify that the browser actually received a valid session cookie.
  return await readPiAccessAuth(piSignal) ? { ok: true } : { ok: false, failure: { kind: "failed" } };
}
