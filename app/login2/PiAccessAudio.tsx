"use client";

import { useEffect, useRef, useState } from "react";
import type { PiAccessPhase } from "./PiAccessScene";

const piVoiceFiles: Partial<Record<PiAccessPhase, string>> = {
  permission: "permission", password: "password", request: "read", read: "read",
  verified: "verified", welcome: "welcome", handoff: "welcome",
};

export function PiAccessAudio({ piPhase, piEnableLabel, piMuteLabel }: {
  piPhase: PiAccessPhase; piEnableLabel: string; piMuteLabel: string;
}) {
  const piAudioRef = useRef<HTMLAudioElement>(null);
  const [piEnabled, setPiEnabled] = useState(false);
  const piVoice = piVoiceFiles[piPhase];
  const piSource = piVoice ? `/login2/assets/pi-${piVoice}.mp3` : undefined;

  useEffect(() => {
    const piAudio = piAudioRef.current;
    if (!piAudio || !piEnabled || !piSource) return;
    // Playback failure is purely presentational; authentication never waits on it.
    let piActive = true;
    void piAudio.play().catch(() => { if (piActive) setPiEnabled(false); });
    return () => { piActive = false; piAudio.pause(); };
  }, [piEnabled, piSource]);

  useEffect(() => {
    const piAudio = piAudioRef.current;
    const piPauseHidden = () => {
      if (document.hidden) {
        piAudio?.pause();
        setPiEnabled(false);
      }
    };
    document.addEventListener("visibilitychange", piPauseHidden);
    return () => { document.removeEventListener("visibilitychange", piPauseHidden); piAudio?.pause(); };
  }, []);

  const piToggleAudio = () => {
    const piAudio = piAudioRef.current;
    if (!piAudio) return;
    if (piEnabled) {
      piAudio.pause();
      setPiEnabled(false);
    } else if (piSource) {
      // Call synchronously from the gesture, rather than relying on autoplay.
      void piAudio.play().then(() => {
        if (!piAudio.isConnected || document.hidden) {
          piAudio.pause();
          return;
        }
        setPiEnabled(true);
      }).catch(() => setPiEnabled(false));
    }
  };

  return (
    <>
      {/* These are decorative Mandarin cues; all information remains in visible text. */}
      <audio ref={piAudioRef} src={piSource} preload="none" onError={() => setPiEnabled(false)} />
      <button type="button" onClick={piToggleAudio} aria-pressed={piEnabled} disabled={!piSource}>
        {piEnabled ? piMuteLabel : piEnableLabel}
      </button>
    </>
  );
}
