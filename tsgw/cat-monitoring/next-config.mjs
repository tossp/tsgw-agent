import { withSentryConfig } from "@sentry/nextjs/config";

// Preview CI preserves this build's maps and debug IDs; CAT uploads happen in a separate job.
const catDeferredUpload = process.env.CAT_DEFER_UPLOAD === "1";
const sentryAuthToken = process.env.SENTRY_AUTH_TOKEN?.trim() || undefined;

/** @param {Parameters<NonNullable<import("next").NextConfig["webpack"]>>[0]} config
 * @param {{ dev: boolean, isServer: boolean }} context
 */
export function applyCatWebpack(config, { dev, isServer }) {
  // Sentry injects IDs; Next remains responsible for generating the maps.
  if (catDeferredUpload && !dev) {
    config.devtool = isServer ? "source-map" : "hidden-source-map";
  }
}

/** @param {import("next").NextConfig} nextConfig
 * @param {string} version
 */
export function withCatMonitoring(nextConfig, version) {
  // Only tsgw preview CI overrides the release; local and tag builds use the source version.
  const sentryRelease = process.env.SENTRY_RELEASE || `tsgw-agent@${version}`;
  return withSentryConfig(nextConfig, {
    sentryUrl: process.env.SENTRY_URL ?? "https://cat.tossp.com",
    org: process.env.SENTRY_ORG ?? "av8d",
    project: process.env.SENTRY_PROJECT ?? "tsgw-agent",
    authToken: sentryAuthToken,
    telemetry: false,
    silent: !sentryAuthToken,
    // The SDK treats some upload failures as recoverable; fail this build instead.
    errorHandler: (error) => {
      throw error;
    },
    sourcemaps: {
      disable: catDeferredUpload ? "disable-upload" : !sentryAuthToken,
      deleteSourcemapsAfterUpload: catDeferredUpload ? false : undefined,
    },
    release: {
      name: sentryRelease,
      create: catDeferredUpload ? false : undefined,
      finalize: catDeferredUpload ? false : undefined,
      setCommits: catDeferredUpload ? false : undefined,
    },
    buildTimeInstrumentation: false,
  });
}
