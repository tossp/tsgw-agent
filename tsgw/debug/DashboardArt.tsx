/** Static drafting geometry only: no sample telemetry, identifiers or task states. */
export function DashboardArt({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 400 400"
      fill="none"
      aria-hidden="true"
      focusable="false"
      style={{ pointerEvents: "none" }}
    >
      <g stroke="currentColor" strokeWidth="1">
        <path d="M18 58V18h40M342 18h40v40M382 342v40h-40M58 382H18v-40" />
        <path d="M200 24v28m0 296v28M24 200h28m296 0h28" />
        <circle cx="200" cy="200" r="168" strokeDasharray="1 11" />
        <circle cx="200" cy="200" r="126" opacity=".35" />
        <path d="M92 200h30m156 0h30M200 92v30m0 156v30" opacity=".5" />
      </g>
      <g data-orbit>
        <path
          d="M114 323a150 150 0 1 1 172 0"
          stroke="currentColor"
          strokeWidth="7"
          strokeLinecap="square"
        />
        <circle cx="286" cy="323" r="7" fill="currentColor" />
        <path d="M200 39v13M200 348v13M39 200h13M348 200h13" stroke="currentColor" />
      </g>
      <g data-counter-orbit>
        <path
          d="M164 298a104 104 0 1 1 116-31"
          stroke="var(--dbg-card, #f7f5ef)"
          strokeWidth="12"
        />
        <path
          d="M164 298a104 104 0 1 1 116-31"
          stroke="currentColor"
          strokeWidth="2"
        />
        <circle cx="164" cy="298" r="4" fill="currentColor" />
      </g>
      <g stroke="currentColor" strokeWidth="2">
        <path d="M145 171a62 62 0 0 1 110 0M145 229a62 62 0 0 0 110 0" />
        <path d="M187 200h26M200 187v26" strokeWidth="1" />
      </g>
      <g fill="var(--dbg-orange, #b74706)">
        <path d="M196 30h8v8h-8zM362 196h8v8h-8z" />
        <circle cx="152" cy="132" r="3" />
        <circle cx="252" cy="268" r="3" />
      </g>
      <path
        d="M42 314h34m-34 7h20M316 80h42m-26 7h26"
        stroke="currentColor"
        strokeWidth="1"
      />
    </svg>
  );
}
