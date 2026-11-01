import * as Sentry from "@sentry/nextjs";
import { getCatConfig } from "./lib/cat-config";
import { getAgentTracingOptions } from "./tsgw/agent-tracing/policy";

const config = getCatConfig();
if (config.dsn) {
  Sentry.init({
    ...config,
    ...getAgentTracingOptions(),
    tracePropagationTargets: [],
    beforeSendLog: () => null,
    beforeSendMetric: () => null,
  });
}
