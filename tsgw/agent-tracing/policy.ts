import type { Integration } from "@sentry/core";
import * as Sentry from "@sentry/nextjs";

const OPERATIONS = new Set(["gen_ai.invoke_agent", "gen_ai.chat", "gen_ai.execute_tool"]);
const AUTO_AI_INTEGRATIONS = new Set([
  "LangChain", "LangGraph", "Mastra", "PiDurable", "VercelAI", "OpenAI",
  "Anthropic_AI", "Google_GenAI", "Mistral", "Groq", "TogetherAI", "McpServer",
]);

function manualIntegrations(integrations: Integration[]): Integration[] {
  return integrations.filter((integration) => !AUTO_AI_INTEGRATIONS.has(integration.name))
    .map((integration) => {
      // Keep the existing request isolation, error context and breadcrumbs.
      if (integration.name === "Http") return Sentry.httpIntegration({ spans: false });
      if (integration.name === "NodeFetch") return Sentry.nativeNodeFetchIntegration({ spans: false });
      return integration;
    });
}

/** Server-only additions: shared browser/edge/error collection is unchanged. */
export function getAgentTracingOptions() {
  return {
    tracesSampleRate: 0,
    traceLifecycle: "stream" as const,
    tracesSampler: ({ attributes }: { attributes: Record<string, unknown> }) =>
      attributes["tsgw.agent_tracing"] === true &&
      typeof attributes["sentry.op"] === "string" && OPERATIONS.has(attributes["sentry.op"]) ? 1 : 0,
    integrations: manualIntegrations,
  };
}
