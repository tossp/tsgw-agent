"use client";

import { useState, type SubmitEvent } from "react";
import { I18nProvider, useI18n } from "@/hooks/useI18n";
import { PiAccessScene } from "./PiAccessScene";
import { PiAccessAudio } from "./PiAccessAudio";
import { getPiAccessCopy } from "./pi-access-copy";
import { usePiAccess } from "./usePiAccess";

function PiLoginContent() {
  const { locale: piLocale, t: piTranslate } = useI18n();
  const { piPhase, piBusy, piFailure, piFallbackHref, piSubmit } = usePiAccess();
  const [piPassword, setPiPassword] = useState("");
  const piCopy = getPiAccessCopy(piLocale, piPhase);
  const piAfterLogin = ["request", "read", "verified", "welcome", "handoff"].includes(piPhase);
  const piError = !piFailure ? "" : piFailure.kind === "invalid" ? piTranslate("auth.invalidPassword")
    : piFailure.kind === "throttled" ? piTranslate("auth.tooManyAttempts", { seconds: piFailure.seconds })
    : piTranslate("auth.loginFailed");

  const piHandleSubmit = async (piEvent: SubmitEvent<HTMLFormElement>) => {
    piEvent.preventDefault();
    if (piPassword && await piSubmit(piPassword)) setPiPassword("");
  };

  return (
    <PiAccessScene
      phase={piPhase} title={piCopy.title} subtitle={piCopy.subtitle} log={piCopy.log}
      fallbackHref={piFallbackHref} fallbackLabel={piAfterLogin ? piCopy.enter : piCopy.original}
      audioControl={<PiAccessAudio piPhase={piPhase} piEnableLabel={piCopy.enableAudio} piMuteLabel={piCopy.muteAudio} />}
    >
      <form data-pi-access-form onSubmit={piHandleSubmit} aria-busy={piBusy}>
        <label htmlFor="pi-access-password">{piTranslate("auth.password")}</label>
        <input
          id="pi-access-password" name="password" type="password" autoComplete="current-password"
          autoFocus required value={piPassword} disabled={piBusy} aria-describedby="pi-access-error"
          aria-invalid={piFailure?.kind === "invalid" || undefined}
          onChange={(piEvent) => setPiPassword(piEvent.target.value)}
          onKeyDown={(piEvent) => {
            if (piEvent.key === "Enter" && piEvent.nativeEvent.isComposing) piEvent.preventDefault();
          }}
        />
        <button type="submit" disabled={piBusy || !piPassword}>
          {piTranslate(piBusy ? "auth.loggingIn" : "auth.logIn")}
        </button>
        <p id="pi-access-error" role="alert" aria-live="polite">{piError}</p>
      </form>
    </PiAccessScene>
  );
}

export default function PiLoginPage() {
  return <I18nProvider><PiLoginContent /></I18nProvider>;
}
