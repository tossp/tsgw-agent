export const PI_ACCESS_VOICE_NAMES = ["connected", "permission", "password", "read", "verified", "welcome"] as const;

export function piAccessVoiceSource(piName: string): string {
  return `/login2/assets/pi-${piName}.mp3`;
}

// Warm complete clips on the loading screen without playing them. A failed or slow
// decorative resource must never prevent the user from reaching authentication.
export async function preloadPiAccessVoices(piSignal: AbortSignal, piTimeoutMs = 8000): Promise<void> {
  if (piSignal.aborted) return;
  await Promise.all(PI_ACCESS_VOICE_NAMES.map((piName) => new Promise<void>((piResolve) => {
    let piAudio: HTMLAudioElement;
    try { piAudio = new Audio(); } catch { piResolve(); return; }
    let piSettled = false;
    const piFinish = () => {
      if (piSettled) return;
      piSettled = true;
      clearTimeout(piTimer);
      piAudio.removeEventListener("canplaythrough", piFinish);
      piAudio.removeEventListener("error", piFinish);
      piSignal.removeEventListener("abort", piAbort);
      piResolve();
    };
    const piAbort = () => {
      piFinish();
      try {
        piAudio.removeAttribute("src");
        piAudio.load();
      } catch { /* Detached or unsupported media still permits entry. */ }
    };
    const piTimer = setTimeout(piAbort, piTimeoutMs);
    piAudio.addEventListener("canplaythrough", piFinish);
    piAudio.addEventListener("error", piFinish);
    piSignal.addEventListener("abort", piAbort, { once: true });
    try {
      piAudio.preload = "auto";
      piAudio.src = piAccessVoiceSource(piName);
      piAudio.load();
    } catch { piFinish(); }
  })));
}
