import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import * as Sentry from "@sentry/nextjs";
import type { Span } from "@sentry/nextjs";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, AssistantMessageEventStream } from "@earendil-works/pi-ai";
import { requestAttributes } from "./usage";
import { inheritRuntimeStreamAuth } from "./sdk-runtime";

type Event = { type: string; [key: string]: unknown };
type Outcome = "success" | "error" | "cancelled" | "interrupted";
type Session = { sessionId: string; agent: { streamFunction?: StreamFn } };
type Options = { parentSessionId?: string; agentName?: string };
type Run = { span: Span; id: string; outcome: Outcome; retries: number };

/** One controller per SDK session; SSE connections never own spans. */
export class AgentTracer {
  private readonly original: StreamFn | undefined;
  private readonly wrapped: StreamFn | undefined;
  private run: Run | undefined;
  private readonly tools = new Map<string, Span>();
  private readonly requests = new Set<Span>();
  private readonly modelSpans = new WeakMap<AssistantMessage, Span>();
  private disposed = false;

  constructor(private readonly session: Session, private readonly options: Options = {}) {
    if (!session.agent?.streamFunction) return;
    this.original = session.agent.streamFunction;
    const original = this.original;
    const request = (receiver: Session["agent"], [model, context, options]: Parameters<StreamFn>) => {
      if (this.disposed) return original.call(receiver, model, context, options);
      // The SDK uses distinct routing IDs for summaries/naming, which can overlap a run.
      const auxiliary = options?.sessionId !== undefined && options.sessionId !== session.sessionId;
      const run = auxiliary ? undefined : this.run;
      const span = this.startSpan("chat", `chat ${model.id}`, run?.span, {
        "gen_ai.provider.name": model.provider,
        "gen_ai.request.model": model.id,
        "tsgw.request.kind": auxiliary ? "auxiliary" : "model",
      });
      this.requests.add(span);
      const observe = (stream: AssistantMessageEventStream) => {
        // result() shares the final promise. Do not iterate, copy or replace the stream.
        void stream.result().then((message) => {
          this.modelSpans.set(message, span);
          if (!this.requests.delete(span)) return;
          span.setAttributes(requestAttributes(model, message));
          if (run) run.outcome = messageOutcome(message);
          finishSpan(span, messageOutcome(message), "model_error");
        }, () => {
          if (run) run.outcome = "error";
          if (this.requests.delete(span)) finishSpan(span, "error", "model_error");
        });
        return stream;
      };
      try {
        const result = original.call(receiver, model, context, options);
        return result instanceof Promise ? result.then(observe, (error: unknown) => {
          if (run) run.outcome = "error";
          if (this.requests.delete(span)) finishSpan(span, "error", "model_error");
          throw error;
        }) : observe(result);
      } catch (error) {
        if (run) run.outcome = "error";
        if (this.requests.delete(span)) finishSpan(span, "error", "model_error");
        throw error;
      }
    };
    this.wrapped = function (this: Session["agent"], ...args) { return request(this, args); };
    inheritRuntimeStreamAuth(original, this.wrapped);
    session.agent.streamFunction = this.wrapped;
  }

  onEvent(event: Event): void {
    if (this.disposed) return;
    switch (event.type) {
      case "agent_start":
        // A retry/continuation starts another low-level loop, not another logical run.
        if (!this.run) {
          const id = randomUUID();
          const span = this.startSpan("invoke_agent", `invoke_agent ${this.options.agentName ?? "TSGW Agent"}`, undefined, {
            "tsgw.run.id": id,
          });
          this.run = { span, id, outcome: "success", retries: 0 };
        }
        break;
      case "message_end": {
        const message = event.message as AssistantMessage | undefined;
        if (message?.role === "assistant" && this.run) this.run.outcome = messageOutcome(message);
        break;
      }
      case "auto_retry_start":
        if (this.run) this.run.span.setAttribute("tsgw.retry.count", ++this.run.retries);
        break;
      case "agent_settled":
        if (this.run) {
          finishSpan(this.run.span, event.aborted === true ? "cancelled" : this.run.outcome, "model_error");
          this.run = undefined;
        }
        break;
      case "tool_execution_start": {
        const id = event.toolCallId as string;
        const parent = this.tools.get(event.parentToolCallId as string) ?? this.run?.span;
        this.tools.set(id, this.startSpan("execute_tool", `execute_tool ${event.toolName as string}`, parent, {
          "gen_ai.tool.name": event.toolName as string,
          "tsgw.tool.call_id": id,
        }));
        break;
      }
      case "tool_execution_end": {
        const id = event.toolCallId as string;
        const span = this.tools.get(id);
        if (span) {
          finishSpan(span, event.isError === true ? "error" : "success", "tool_error");
          this.tools.delete(id);
        }
        break;
      }
    }
  }

  /** Associate existing error capture without activating a span around provider/tool IO. */
  withScope<T>(callback: () => T, event?: Event): T {
    const message = event?.message as AssistantMessage | undefined;
    const span = (message && this.modelSpans.get(message)) ?? this.run?.span;
    return span ? Sentry.withActiveSpan(span, callback) : callback();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const span of this.requests) finishSpan(span, "interrupted");
    for (const span of this.tools.values()) finishSpan(span, "interrupted");
    this.requests.clear();
    this.tools.clear();
    if (this.run) finishSpan(this.run.span, "interrupted");
    this.run = undefined;
    if (this.wrapped && this.session.agent.streamFunction === this.wrapped) {
      this.session.agent.streamFunction = this.original;
    }
  }

  private startSpan(operation: string, name: string, parent?: Span, attributes: Record<string, string | number | boolean> = {}): Span {
    const start = () => Sentry.startInactiveSpan({
      name,
      op: `gen_ai.${operation}`,
      // Never inherit an HTTP request's sampled flag or parent (background work outlives it).
      parentSpan: parent ?? null,
      attributes: {
        "tsgw.agent_tracing": true,
        instance: hostname(),
        "gen_ai.operation.name": operation,
        "gen_ai.agent.name": this.options.agentName ?? "TSGW Agent",
        "gen_ai.conversation.id": this.session.sessionId,
        ...(parent && this.run ? { "tsgw.run.id": this.run.id } : {}),
        ...(this.options.parentSessionId ? { "tsgw.parent_session_id": this.options.parentSessionId } : {}),
        ...attributes,
      },
    });
    return parent ? start() : Sentry.startNewTrace(start);
  }
}

function messageOutcome(message: AssistantMessage): Outcome {
  return message.stopReason === "aborted" ? "cancelled" : message.stopReason === "error" ? "error" : "success";
}

function finishSpan(span: Span, outcome: Outcome, errorType: string = outcome): void {
  span.setAttribute("tsgw.outcome", outcome);
  if (outcome === "success") span.setStatus({ code: 1 });
  else {
    span.setAttribute("error.type", outcome === "error" ? errorType : outcome);
    span.setStatus({ code: 2, message: outcome === "error" ? "internal_error" : outcome });
  }
  span.end();
}
