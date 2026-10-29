import { hostname } from "node:os";
import packageJson from "../package.json";

export function getCatConfig(env: NodeJS.ProcessEnv = process.env) {
  return {
    dsn: "https://24d86d19be5d513074e45febd5b004b8@cat.tossp.com/10",
    environment: env.SENTRY_ENVIRONMENT ?? env.NODE_ENV ?? "production",
    release: `tsgw-agent@${packageJson.version}`,
    tracesSampleRate: 0,
    dataCollection: { userInfo: true },
    initialScope: { tags: { instance: hostname() } },
  };
}
