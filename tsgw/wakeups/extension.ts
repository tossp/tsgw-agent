import { Type } from "@earendil-works/pi-ai";
import { defineTool, type InlineExtension } from "@earendil-works/pi-coding-agent";
import type { WakeupRuntime } from "./runtime";

export const WAKEUP_TOOL_NAMES = ["schedule_wakeup", "list_wakeups", "cancel_wakeup", "list_session_wakeups"] as const;

const wakeupSchema = Type.Object({
  wakeupId: Type.String(), sourceSessionId: Type.String(), targetSessionId: Type.String(),
  createdAt: Type.String(), scheduledAt: Type.String(), message: Type.String(),
});
const eventSchema = Type.Intersect([wakeupSchema, Type.Object({
  version: Type.Literal(1), event: Type.Union(["created", "cancelled", "submitted", "failed"].map((value) => Type.Literal(value))),
  recordedAt: Type.String(), error: Type.Optional(Type.String()),
})]);
const historySchema = Type.Intersect([wakeupSchema, Type.Object({
  status: Type.String(), active: Type.Boolean(), events: Type.Array(eventSchema),
})]);

function result<T>(value: T) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }], details: value, structuredContent: value };
}

export function createWakeupExtension(runtime: WakeupRuntime): InlineExtension {
  return {
    name: "pi-web-wakeup", hidden: true,
    factory: (pi) => {
      pi.registerTool(defineTool({
        name: "schedule_wakeup", label: "Schedule wakeup",
        description: "Schedule a one-time wakeup of an existing ordinary session (default: this session). Specify after_seconds OR at with an explicit timezone, and a self-reminder or handoff message. Returns immediately. Timers live only in this server process: restart loses them, with no recovery or catch-up. Subagent targets are forbidden; wake their parent instead. This transfers only the message, not source context or permissions.",
        promptSnippet: "Schedule a one-time session wakeup or handoff",
        promptGuidelines: ["Use schedule_wakeup for deferred work; do not sleep or poll until the due time. A server restart discards pending wakeups."],
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
        executionMode: "sequential",
        parameters: Type.Object({
          session_id: Type.Optional(Type.String({ minLength: 1, description: "Existing ordinary target session ID. Defaults to this session; never a subagent." })),
          after_seconds: Type.Optional(Type.Number({ exclusiveMinimum: 0, description: "Positive delay in seconds. Mutually exclusive with at." })),
          at: Type.Optional(Type.String({ description: "Future ISO 8601 time with Z or numeric timezone, e.g. 2026-11-01T09:00:00+08:00. Mutually exclusive with after_seconds." })),
          message: Type.String({ minLength: 1, description: "Instructions to continue later, including the context needed for a cross-session handoff." }),
        }),
        outputSchema: wakeupSchema,
        async execute(_id, input, signal, _update, ctx) {
          signal?.throwIfAborted();
          return result(await runtime.schedule(ctx.sessionManager.getSessionId(), input));
        },
      }));
      pi.registerTool(defineTool({
        name: "list_wakeups", label: "List pending wakeups",
        description: "List pending wakeups in this server process across ordinary sessions. Not history. Empty after server restart; does not restore timers or start a model.",
        annotations: { readOnlyHint: true, openWorldHint: false },
        parameters: Type.Object({}), outputSchema: Type.Array(wakeupSchema),
        async execute() { return result(runtime.list()); },
      }));
      pi.registerTool(defineTool({
        name: "cancel_wakeup", label: "Cancel wakeup",
        description: "Cancel a pending wakeup by its UUIDv7 ID. Does not stop a session or retract an already submitted message. Refuses an ID no longer pending in this server process.",
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
        executionMode: "sequential",
        parameters: Type.Object({ wakeup_id: Type.String({ minLength: 1, description: "UUIDv7 returned by schedule_wakeup." }) }),
        outputSchema: wakeupSchema,
        async execute(_id, input, signal) {
          signal?.throwIfAborted();
          return result(await runtime.cancel(input.wakeup_id));
        },
      }));
      pi.registerTool(defineTool({
        name: "list_session_wakeups", label: "Read session wakeup history",
        description: "Read all wakeup metadata in a session's JSONL, across all branches, without starting the session or changing its file. Reports history separately from current in-memory activity. inactive means no pending timer here, not proof of cancellation or delivery. submitted means accepted/queued, not model task completion. Fork-inherited records do not schedule wakeups for the fork.",
        annotations: { readOnlyHint: true, openWorldHint: false },
        parameters: Type.Object({ session_id: Type.String({ minLength: 1, description: "Session ID whose file to inspect." }) }),
        outputSchema: Type.Array(historySchema),
        async execute(_id, input, signal) {
          signal?.throwIfAborted();
          return result(await runtime.history(input.session_id));
        },
      }));
    },
  };
}
