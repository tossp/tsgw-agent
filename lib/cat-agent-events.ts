import { reportCatError } from "./cat-monitoring";

/** Provider failures are SDK event data, not uncaught JavaScript exceptions. */
export function reportCatAgentEvent(event: { type: string; [key: string]: unknown }, sessionId: string): void {
  if (event.type === "message_end") {
    const message = event.message as { role?: string; stopReason?: string; errorMessage?: string; provider?: string; model?: string } | undefined;
    if (message?.role === "assistant" && message.stopReason === "error") {
      reportCatError(new Error(message.errorMessage ?? "Model request failed"), {
        source: "provider", session_id: sessionId, provider: message.provider, model: message.model,
      });
    }
  } else if (event.type === "prompt_error" || event.type === "extension_error") {
    reportCatError(new Error(String(event.errorMessage ?? event.error)), {
      source: event.type, session_id: sessionId,
    });
  }
}
