"use client";

import Image from "next/image";
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { version as piVersion } from "../../package.json";
import { PiAccessReticle } from "./PiAccessReticle";
import styles from "./pi-access.module.css";

export type PiAccessPhase =
  | "checking" | "ready" | "intro" | "wash" | "permission" | "password"
  | "request" | "read" | "verified" | "welcome" | "handoff";

export interface PiAccessSceneProps {
  phase: PiAccessPhase;
  title: string;
  subtitle: string;
  log: string;
  logSubtitle: string;
  sourceIp: string;
  fallbackHref: string;
  fallbackLabel: string;
  audioControl?: ReactNode;
  openingControl?: ReactNode;
  children?: ReactNode;
}

const PI_ACCESS_EMBLEM = "/login2/assets/emblem.webp";
const PI_ACCESS_LIGHT_PHASES = new Set<PiAccessPhase>([
  "permission", "password", "request", "read", "verified", "welcome", "handoff",
]);
const PI_ACCESS_BUSY_PHASES = new Set<PiAccessPhase>(["checking", "request", "read"]);
const PI_ACCESS_STAGE: Record<PiAccessPhase, number> = {
  checking: 0, ready: 0, intro: 0, wash: 0, permission: 1, password: 2,
  request: 3, read: 4, verified: 5, welcome: 6, handoff: 6,
};
const PI_ACCESS_BADGES = ["BOOT", "AUTHORIZATION", "IDENTITY", "REQUEST", "READ", "VERIFY", "WELCOME"];
const PI_ACCESS_PROGRESS = [0.12, 0.34, 0.5, 0.66, 0.8, 0.93, 1];
const PI_ACCESS_HEX = [
  "2A 7F A1 5C 00 19 4B 6E 82 31 C0 0F",
  "B4 08 3D 91 E2 6A 20 FF 73 05 A8 4C",
  "61 9E 04 D7 3B 82 C5 10 6F A2 58 93",
  "A9 40 72 1E 8B C0 56 3F 9D 24 67 B1",
  "05 D8 31 A4 7C 92 E6 0B 48 F3 6A 15",
  "F2 6C 80 4A B7 19 53 E0 2D 95 C1 78",
  "38 A5 0E 72 C4 96 1B F0 67 3D 82 A9",
  "C7 12 9A 50 E3 6B 04 D8 71 2F B5 60",
];

function PiAccessCharacters({ piText, piStagger }: { piText: string; piStagger: number }) {
  return Array.from(piText).map((piCharacter, piIndex) => (
    <span key={piIndex} className={styles.piCharacter} aria-hidden="true"
      style={{ "--pi-character-delay": `${piIndex * piStagger}ms` } as CSSProperties}>
      {piCharacter === " " ? "\u00a0" : piCharacter}
    </span>
  ));
}

function PiAccessClock() {
  const [piClock, setPiClock] = useState("--:--:--");
  useEffect(() => {
    const piUpdate = () => setPiClock(new Date().toLocaleTimeString("en-GB", { hour12: false }));
    piUpdate();
    const piTimer = window.setInterval(piUpdate, 1000);
    return () => window.clearInterval(piTimer);
  }, []);
  return <span className={styles.piMetaAccent} data-pi-clock suppressHydrationWarning>{piClock}</span>;
}

function PiAccessHostname() {
  const [piHostname, setPiHostname] = useState("");
  useEffect(() => { setPiHostname(window.location.hostname); }, []);
  return <span data-pi-hostname>{piHostname}</span>;
}

export function PiAccessScene({
  phase, title, subtitle, log, logSubtitle, sourceIp, fallbackHref, fallbackLabel, audioControl, openingControl, children,
}: PiAccessSceneProps) {
  const piTextRef = useRef<HTMLDivElement>(null);
  const piReadoutRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const piReadout = piReadoutRef.current;
    if (!piReadout) return;
    const piMeasure = () => piReadout.parentElement?.style.setProperty(
      "--pi-readout-height", `${piReadout.getBoundingClientRect().height}px`,
    );
    piMeasure();
    const piObserver = new ResizeObserver(piMeasure);
    piObserver.observe(piReadout);
    return () => piObserver.disconnect();
  }, []);
  const piIsLight = PI_ACCESS_LIGHT_PHASES.has(phase);
  const piIsWelcome = phase === "welcome" || phase === "handoff";
  const piStage = PI_ACCESS_STAGE[phase];
  const piShowReticle = phase === "verified";
  const piShowLogo = phase === "request" || phase === "read";

  return (
    <div className={styles.piScene} data-pi-light={piIsLight ? "1" : "0"}
      data-pi-phase={phase} data-pi-reticle={piShowReticle ? "1" : "0"}
      data-pi-welcome={piIsWelcome ? "1" : "0"} data-pi-logo={piShowLogo ? "1" : "0"}
      aria-busy={PI_ACCESS_BUSY_PHASES.has(phase) || undefined}>
      <div className={styles.piPlate} aria-hidden="true" />
      <div className={styles.piArchive} aria-hidden="true"><i /><i /><i /><i /></div>
      <div className={styles.piVignette} aria-hidden="true" />
      <div className={styles.piGrain} aria-hidden="true" />
      <div className={styles.piFrame} aria-hidden="true">
        <i className={styles.piCorner} /><i className={styles.piCorner} />
        <i className={styles.piCorner} /><i className={styles.piCorner} />
        <div className={styles.piScanline} key={piShowReticle ? "verified" : "boot"} />
      </div>

      <header className={styles.piBrand} aria-label="TSGW Agent">
        <span className={styles.piBrandName}>TSGW</span>
        <span className={styles.piBrandSub}>SYNTHESIZE INTELLIGENCE</span>
        <span className={styles.piBrandSystem}><b>AGENT</b> WEB</span>
      </header>
      <div className={styles.piMeta} aria-hidden="true">
        <span>REV {piVersion} · WEB PROFILE</span><PiAccessClock />
      </div>
      <div className={styles.piSlats} aria-hidden="true">
        {Array.from({ length: 6 }, (_, piIndex) => (
          <i key={piIndex} className={styles.piSlat}
            data-pi-state={piIndex + 1 < piStage ? "past" : piIndex + 1 === piStage ? "on" : undefined} />
        ))}
      </div>

      <div className={styles.piControls}>
        <a className={styles.piFallback} href={fallbackHref}>{fallbackLabel}</a>
        <div className={styles.piUtilityLinks}>
          <a className={styles.piGithub} href="https://github.com/tossp/tsgw-agent"
            target="_blank" rel="noopener noreferrer" aria-label="GitHub · tossp/tsgw-agent">
            GitHub <span aria-hidden="true">↗</span>
          </a>
          {audioControl ? <div className={styles.piAudioControl}>{audioControl}</div> : null}
        </div>
      </div>

      <PiAccessReticle piActive={piShowReticle} piTextRef={piTextRef} />
      <div className={styles.piHex} aria-hidden="true">
        {PI_ACCESS_HEX.map((piLine) => <span key={piLine}>{piLine}</span>)}
      </div>

      <div className={styles.piScroll}>
        <main className={styles.piCenter} aria-hidden={!piIsLight || piIsWelcome || undefined}>
          <div className={styles.piStatusText} ref={piTextRef} data-pi-status-text>
            <h1 key={`${phase}-title`} className={styles.piTitle} aria-label={title}>
              <PiAccessCharacters piText={title} piStagger={46} />
              {phase === "password" || phase === "permission" ? <i className={styles.piCaret} aria-hidden="true" /> : null}
            </h1>
            <p key={`${phase}-subtitle`} className={styles.piSubtitle} aria-label={subtitle}>
              <PiAccessCharacters piText={subtitle} piStagger={13} />
            </p>
          </div>
          <span className={styles.piRule} aria-hidden="true" />
          <div className={styles.piAssembly} aria-hidden="true">
            <Image src={PI_ACCESS_EMBLEM} width={84} height={84} alt="" className={styles.piAssemblyMark} />
            <span>PI WEB · AGENT</span><i className={styles.piAssemblyDots} />
          </div>
        </main>
        {phase === "password" ? <div className={styles.piCredentialArea} data-pi-action>{children}</div> : null}
      </div>

      <section className={styles.piWelcome} aria-hidden={!piIsWelcome || undefined}>
        <h2 className={styles.piWelcomeTitle} data-pi-text="WELCOME TO">WELCOME TO</h2>
        <p className={styles.piWelcomeBox} data-pi-text="TSGW AGENT">TSGW AGENT</p>
        <div className={styles.piWelcomeMarkGroup}>
          <Image src={PI_ACCESS_EMBLEM} width={76} height={76} alt="" className={styles.piWelcomeMark} />
          <span>PI WEB · AGENT</span>
        </div>
        <p className={styles.piWelcomeSubtitle} data-pi-text={title}>{title}</p>
      </section>

      <div className={styles.piWash} aria-hidden="true" />
      {openingControl ? <div className={styles.piOpening}>{openingControl}</div> : null}
      <div className={styles.piPrologue} aria-hidden={piIsLight || undefined}>
        <div className={styles.piSweep} aria-hidden="true" />
        <div className={styles.piPrologoInner}>
          <Image src={PI_ACCESS_EMBLEM} width={256} height={256} alt="" priority className={styles.piPrologoMark} />
          <p className={styles.piPrologoTitle}>智能协作</p>
          <p className={styles.piPrologoBrand}>TSGW AGENT</p>
          <p className={styles.piPrologoSubtitle}>PI WEB · ACCESS TERMINAL</p>
        </div>
      </div>

      <div ref={piReadoutRef} className={styles.piHostReadout} aria-hidden="true" data-pi-host-readout>
        {sourceIp ? <div data-pi-source-ip>· SOURCE IP : {sourceIp}</div> : null}
        <div>· HOST : <PiAccessHostname /></div>
      </div>
      <div className={styles.piStepCount} aria-hidden="true">
        [ {String(piStage).padStart(2, "0")} / 06 ] {PI_ACCESS_BADGES[piStage]}
      </div>
      <div className={styles.piVoiceBars} aria-hidden="true"><i /><i /><i /><i /><i /></div>
      <footer className={styles.piFoot} aria-hidden={!piIsLight || undefined}>
        <span>POWERED BY TSGW</span><i />
      </footer>
      <div className={styles.piLog} role="status" aria-live="polite">
        <p key={`${phase}-log`}>{log}</p><span key={`${phase}-log-sub`}>{logSubtitle}</span>
      </div>
      <div className={styles.piProgress} aria-hidden="true">
        <i style={{ width: `${PI_ACCESS_PROGRESS[piStage] * 100}%` }} />
      </div>
      <div className={styles.piBloom} aria-hidden="true" />
      <div className={styles.piStreak} aria-hidden="true" />
      <div className={styles.piFlash} aria-hidden="true" />
    </div>
  );
}
