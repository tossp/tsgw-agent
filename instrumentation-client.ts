import * as Sentry from "@sentry/nextjs";

// The DSN is fixed, but the deployment's hostname is only available at runtime.
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
