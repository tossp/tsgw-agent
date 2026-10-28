import packageJson from "../package.json";

export function getCatConfig(env: NodeJS.ProcessEnv = process.env) {
  return {
    dsn: env.SENTRY_DSN ?? "",
    environment: env.SENTRY_ENVIRONMENT ?? env.NODE_ENV ?? "production",
    release: env.SENTRY_RELEASE ?? `tsgw-agent@${packageJson.version}`,
    tracesSampleRate: 0,
    initialScope: { tags: { instance: env.SENTRY_INSTANCE ?? "" } },
  };
}
