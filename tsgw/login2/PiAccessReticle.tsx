"use client";

import { useId, useLayoutEffect, useRef, type RefObject } from "react";
import styles from "./pi-access.module.css";

// Original geometry and rotation; the mask is the local adaptation for longer copy.
export function PiAccessReticle({ piActive, piTextRef }: {
  piActive: boolean;
  piTextRef: RefObject<HTMLDivElement | null>;
}) {
  const piMaskId = useId().replace(/:/g, "");
  const piSvgRef = useRef<SVGSVGElement>(null);
  const piCutoutRef = useRef<SVGRectElement>(null);

  useLayoutEffect(() => {
    const piSvg = piSvgRef.current;
    const piText = piTextRef.current;
    const piCutout = piCutoutRef.current;
    if (!piActive || !piSvg || !piText || !piCutout) return;
    const piMeasure = () => {
      const piFrame = piSvg.getBoundingClientRect();
      const piBounds = piText.getBoundingClientRect();
      if (!piFrame.width || !piFrame.height) return;
      const piScale = 400 / piFrame.width;
      piCutout.setAttribute("x", String((piBounds.left - piFrame.left - 12) * piScale));
      piCutout.setAttribute("y", String((piBounds.top - piFrame.top - 5) * piScale));
      piCutout.setAttribute("width", String((piBounds.width + 24) * piScale));
      piCutout.setAttribute("height", String((piBounds.height + 10) * piScale));
    };
    piMeasure();
    const piObserver = new ResizeObserver(piMeasure);
    piObserver.observe(piSvg);
    piObserver.observe(piText);
    // The central logo collapses before VERIFY; follow the parent height transition too.
    if (piText.parentElement) piObserver.observe(piText.parentElement);
    window.addEventListener("resize", piMeasure);
    return () => {
      piObserver.disconnect();
      window.removeEventListener("resize", piMeasure);
    };
  }, [piActive, piTextRef]);

  return (
    <div className={styles.piReticle} aria-hidden="true" data-pi-scan>
      <svg ref={piSvgRef} viewBox="0 0 400 400" focusable="false">
        <defs>
          <mask id={piMaskId} maskUnits="userSpaceOnUse" x="0" y="0" width="400" height="400">
            <rect width="400" height="400" fill="white" />
            <rect ref={piCutoutRef} width="0" height="0" fill="black" data-pi-scan-cutout />
          </mask>
        </defs>
        <g mask={`url(#${piMaskId})`}>
          <g className={styles.piRetRotorA} data-pi-rotor="outer">
            <path className={styles.piRetArcA} d="M113.96 322.87 A150 150 0 1 1 286.04 322.87" />
            <circle className={styles.piRetDotA} cx="286.04" cy="322.87" r="7" />
          </g>
          <g className={styles.piRetRotorB} data-pi-rotor="inner">
            <path className={styles.piRetArcB} d="M164.43 297.73 A104 104 0 1 1 279.67 266.85" />
            <circle className={styles.piRetDotB} cx="164.43" cy="297.73" r="4" />
          </g>
          <g>
            <path className={styles.piRetBracket} d="M254.74 229.11 A62 62 0 0 1 145.26 229.11" />
            <path className={styles.piRetBracket} d="M145.26 170.89 A62 62 0 0 1 254.74 170.89" />
          </g>
          <circle className={styles.piRetDotAccent} cx="152" cy="132" r="2.8" />
          <circle className={styles.piRetDotAccent} cx="252" cy="268" r="2.8" />
          <circle className={styles.piRetDotAccent} cx="278" cy="150" r="2.8" />
        </g>
      </svg>
    </div>
  );
}
