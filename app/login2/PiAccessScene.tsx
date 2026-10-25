"use client";

import Image from "next/image";
import type { ReactNode } from "react";
import styles from "./pi-access.module.css";

export type PiAccessPhase =
  | "checking"
  | "intro"
  | "wash"
  | "permission"
  | "password"
  | "request"
  | "read"
  | "verified"
  | "welcome"
  | "handoff";

export interface PiAccessSceneProps {
  phase: PiAccessPhase;
  title: string;
  subtitle: string;
  log: string;
  fallbackHref: string;
  fallbackLabel: string;
  audioControl?: ReactNode;
  children?: ReactNode;
}

const PI_ACCESS_EMBLEM = "/login2/assets/emblem.webp";
const PI_ACCESS_REVISION = "REV 0.12.2";
const PI_ACCESS_SLAT_COUNT = 6;
const PI_ACCESS_LIGHT_PHASES = new Set<PiAccessPhase>([
  "permission",
  "password",
  "request",
  "read",
  "verified",
  "welcome",
  "handoff",
]);
const PI_ACCESS_BUSY_PHASES = new Set<PiAccessPhase>(["checking", "request", "read"]);
const PI_ACCESS_STAGE: Record<PiAccessPhase, number> = {
  checking: 0,
  intro: 0,
  wash: 1,
  permission: 2,
  password: 3,
  request: 4,
  read: 5,
  verified: 6,
  welcome: 6,
  handoff: 6,
};
const PI_ACCESS_HEX = [
  "0x2A · SESSION",
  "0x7F · TOKEN",
  "0xA1 · SCOPE",
  "0x5C · GRANT",
];

export function PiAccessScene({
  phase,
  title,
  subtitle,
  log,
  fallbackHref,
  fallbackLabel,
  audioControl,
  children,
}: PiAccessSceneProps) {
  const isLight = PI_ACCESS_LIGHT_PHASES.has(phase);
  const isWelcome = phase === "welcome" || phase === "handoff";
  const stage = PI_ACCESS_STAGE[phase];
  const stageLabel = `${String(stage).padStart(2, "0")} / 06`;
  const showReticle = phase === "request" || phase === "read" || phase === "verified";

  return (
    <div
      className={styles.piScene}
      data-pi-light={isLight ? "1" : "0"}
      data-pi-phase={phase}
      data-pi-reticle={showReticle ? "1" : "0"}
      data-pi-welcome={isWelcome ? "1" : "0"}
      aria-busy={PI_ACCESS_BUSY_PHASES.has(phase) || undefined}
    >
      <div className={styles.piPlate} aria-hidden="true" />
      <div className={styles.piArchive} aria-hidden="true">
        <i /><i /><i /><i />
      </div>
      <div className={styles.piVignette} aria-hidden="true" />
      <div className={styles.piGrain} aria-hidden="true" />

      <div className={styles.piFrame} aria-hidden="true">
        <i className={styles.piCorner} />
        <i className={styles.piCorner} />
        <i className={styles.piCorner} />
        <i className={styles.piCorner} />
        <div className={styles.piScanline} />
      </div>

      <header className={styles.piBrand}>
        <Image
          src={PI_ACCESS_EMBLEM}
          width={64}
          height={64}
          alt=""
          className={styles.piBrandMark}
        />
        <div className={styles.piBrandText}>
          <span className={styles.piBrandName}>PI WEB</span>
          <span className={styles.piBrandSub}>AGENT ACCESS</span>
        </div>
        <span className={styles.piBrandTag}>ARCHIVE</span>
      </header>

      <div className={styles.piMeta} aria-hidden="true">
        <span>{PI_ACCESS_REVISION}</span>
        <span className={styles.piMetaAccent}>WEB PROFILE</span>
      </div>

      <div className={styles.piSlats} aria-hidden="true">
        {Array.from({ length: PI_ACCESS_SLAT_COUNT }, (_, index) => (
          <i
            key={index}
            className={styles.piSlat}
            data-pi-state={index < stage ? "past" : index === stage ? "on" : undefined}
          />
        ))}
      </div>

      <a className={styles.piFallback} href={fallbackHref}>{fallbackLabel}</a>

      {audioControl ? (
        <div className={styles.piAudioControl}>{audioControl}</div>
      ) : null}

      <div className={styles.piReticle} aria-hidden="true">
        <svg viewBox="0 0 400 400" focusable="false">
          <g className={styles.piRetSpinA}>
            <path
              className={styles.piRetArcA}
              d="M113.96 322.87 A150 150 0 1 1 286.04 322.87"
            />
            <circle className={styles.piRetDotA} cx="286.04" cy="322.87" r="6" />
            <circle className={styles.piRetDotB} cx="113.96" cy="322.87" r="3" />
          </g>
          <g className={styles.piRetSpinB}>
            <path
              className={styles.piRetArcB}
              d="M140.33 285.16 A104 104 0 1 1 259.67 285.16"
            />
            <circle className={styles.piRetDotB} cx="140.33" cy="285.16" r="3" />
          </g>
          <g>
            <path className={styles.piRetBracket} d="M254.74 229.11 A62 62 0 0 1 145.26 229.11" />
            <path className={styles.piRetBracket} d="M145.26 170.89 A62 62 0 0 1 254.74 170.89" />
          </g>
          <circle className={styles.piRetDotA} cx="152" cy="132" r="2.6" />
          <circle className={styles.piRetDotA} cx="278" cy="150" r="2.2" />
        </svg>
      </div>

      <div className={styles.piHex} aria-hidden="true">
        {PI_ACCESS_HEX.map((line) => <span key={line}>{line}</span>)}
      </div>

      <div className={styles.piScroll}>
        <main
          className={styles.piCenter}
          aria-hidden={!isLight || isWelcome || undefined}
        >
          <p className={styles.piEyebrow}><i aria-hidden="true" />PI // ACCESS</p>
          <h1 className={styles.piTitle}>{title}</h1>
          <p className={styles.piSubtitle}>{subtitle}</p>
          <span className={styles.piRule} aria-hidden="true" />
          {phase === "password" ? (
            <div className={styles.piCredentialArea}>{children}</div>
          ) : null}
        </main>
      </div>

      <section className={styles.piWelcome} aria-hidden={!isWelcome || undefined}>
        <p className={styles.piWelcomeKicker}><i aria-hidden="true" />PI // ACCESS</p>
        <h2 className={styles.piWelcomeTitle} data-pi-text={title}>{title}</h2>
        <div className={styles.piWelcomePlate}>
          <Image
            src={PI_ACCESS_EMBLEM}
            width={128}
            height={128}
            alt=""
            className={styles.piWelcomeMark}
          />
          <span>PI WEB</span>
        </div>
        <p className={styles.piWelcomeSubtitle}>{subtitle}</p>
      </section>

      <div className={styles.piWash} aria-hidden="true" />

      <div className={styles.piPrologue} aria-hidden={isLight || undefined}>
        <div className={styles.piSweep} aria-hidden="true" />
        <div className={styles.piPrologoInner}>
          <Image
            src={PI_ACCESS_EMBLEM}
            width={256}
            height={256}
            alt=""
            priority
            className={styles.piPrologoMark}
          />
          <p className={styles.piPrologoBrand}>PI WEB</p>
          <p className={styles.piPrologoTag}>AGENT ACCESS</p>
          <p className={styles.piPrologoTitle}>{title}</p>
          <p className={styles.piPrologoSubtitle}>{subtitle}</p>
        </div>
        <p className={styles.piPrologoFoot}>PI · ACCESS PROTOCOL</p>
      </div>

      <footer className={styles.piFoot} aria-hidden={!isLight || isWelcome || undefined}>
        <div className={styles.piFootSide}>
          <span className={styles.piStepCount}>[ {stageLabel} ]</span>
          <span className={styles.piVoiceBars} aria-hidden="true">
            <i /><i /><i /><i /><i />
          </span>
        </div>
        <p className={styles.piLog} role="status" aria-live="polite">{log}</p>
        <div className={styles.piFootSideEnd}>
          <span>PI WEB · ACCESS</span>
          <span className={styles.piFootRev}>{PI_ACCESS_REVISION}</span>
        </div>
      </footer>

      <div className={styles.piProgress} aria-hidden="true">
        <i style={{ width: `${(stage / PI_ACCESS_SLAT_COUNT) * 100}%` }} />
      </div>

      <div className={styles.piBloom} aria-hidden="true" />
      <div className={styles.piStreak} aria-hidden="true" />
    </div>
  );
}
