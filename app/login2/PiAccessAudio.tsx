"use client";

import { useEffect, useRef, useState } from "react";
import type { PiAccessPhase } from "./PiAccessScene";

const piVoiceFiles: Partial<Record<PiAccessPhase, string>> = {
  permission: "permission", password: "password", request: "read", read: "read",
  verified: "verified", welcome: "welcome", handoff: "welcome",
};

export function PiAccessAudio({ piPhase, piAuthenticated = false, piEnableLabel, piMuteLabel }: {
  piPhase: PiAccessPhase; piAuthenticated?: boolean; piEnableLabel: string; piMuteLabel: string;
}) {
  const piAudioRef = useRef<HTMLAudioElement>(null);
  const piEnabledRef = useRef(true);
  const piResumeRef = useRef<(() => void) | null>(null);
  const [piEnabled, setPiEnabled] = useState(true);
  const piVoice = piAuthenticated && piPhase === "password" ? undefined : piVoiceFiles[piPhase];
  const piSource = piVoice ? `/login2/assets/pi-${piVoice}.mp3` : undefined;

  useEffect(() => {
    const piAudio = piAudioRef.current;
    if (!piAudio || !piSource) return;
    let piActive = true;
    let piPending = false;
    const piPlay = () => {
      if (!piActive || !piEnabledRef.current || document.hidden || piPending
        || piAudio.error || piAudio.ended || !piAudio.paused) return;
      piPending = true;
      // Call directly inside interaction handlers so the browser can grant playback.
      // A rejected autoplay attempt must not turn off subsequent interaction retries.
      void piAudio.play().then(() => {
        if (piActive && (!piEnabledRef.current || document.hidden)) piAudio.pause();
      }).catch(() => {}).finally(() => { piPending = false; });
    };
    const piInteraction = (piEvent: Event) => {
      // The dedicated control handles its own gesture, including an explicit mute.
      if (piEvent.target instanceof Element && piEvent.target.closest("[data-pi-audio-control]")) return;
      piPlay();
    };
    const piVisibilityChange = () => {
      if (document.hidden) piAudio.pause();
      else piPlay();
    };
    const piEvents = ["click", "pointerup", "touchend", "keydown"] as const;
    piResumeRef.current = piPlay;
    for (const piEvent of piEvents) document.addEventListener(piEvent, piInteraction, true);
    document.addEventListener("visibilitychange", piVisibilityChange);
    piPlay();
    return () => {
      piActive = false;
      piResumeRef.current = null;
      for (const piEvent of piEvents) document.removeEventListener(piEvent, piInteraction, true);
      document.removeEventListener("visibilitychange", piVisibilityChange);
      piAudio.pause();
    };
  }, [piSource]);

  const piToggleAudio = () => {
    const piNextEnabled = !piEnabledRef.current;
    piEnabledRef.current = piNextEnabled;
    setPiEnabled(piNextEnabled);
    if (piNextEnabled) piResumeRef.current?.();
    else piAudioRef.current?.pause();
  };

  const piUpdateMeter = () => {
    const piAudio = piAudioRef.current;
    piAudio?.closest("[data-pi-phase]")?.setAttribute("data-pi-speaking", piAudio.paused || piAudio.ended ? "0" : "1");
  };

  return (
    <>
      {/* These are decorative Mandarin cues; all information remains in visible text. */}
      <audio ref={piAudioRef} src={piSource} preload="none"
        onPlay={piUpdateMeter} onPause={piUpdateMeter} onEnded={piUpdateMeter} onError={piUpdateMeter} />
      <button type="button" data-pi-audio-control onClick={piToggleAudio} aria-pressed={piEnabled} disabled={!piSource}>
        {piEnabled ? piMuteLabel : piEnableLabel}
      </button>
    </>
  );
}
