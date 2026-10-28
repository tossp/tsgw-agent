import * as Sentry from "@sentry/nextjs";

// NEXT_PUBLIC_* is frozen at build time; this package is configured after installation.
void fetch("/api/cat-config", { cache: "no-store" })
  .then(async (response) => {
    if (!response.ok) return;
    const config = await response.json();
    if (!config.dsn) return;
    Sentry.init({
      ...config,
      tracePropagationTargets: [],
      enhanceFetchErrorMessages: "report-only",
      beforeSendLog: () => null,
      beforeSendMetric: () => null,
    });
  })
  .catch(() => { /* unavailable monitoring must not prevent app startup */ });
