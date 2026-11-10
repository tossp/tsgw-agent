import * as Sentry from "@sentry/nextjs";
import { getCatConfig } from "./cat-config";
import { getAgentTracingOptions } from "../agent-tracing/policy";

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
