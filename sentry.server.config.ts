import * as Sentry from "@sentry/nextjs";
import { getCatConfig } from "./lib/cat-config";

const config = getCatConfig();
if (config.dsn) {
  Sentry.init({
    ...config,
    tracePropagationTargets: [],
    beforeSendLog: () => null,
    beforeSendMetric: () => null,
  });
}
