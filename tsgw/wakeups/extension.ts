import type { JsonValue } from "@earendil-works/pi-ai";
import { join } from "node:path";
import { Type } from "typebox";
import { defineTool, type InlineExtension } from "@earendil-works/pi-coding-agent";
import { WakeupOperationError, type WakeupRuntime } from "./runtime";

export const WAKEUP_TOOL_NAMES = ["schedule_wakeup", "list_wakeups", "cancel_wakeup", "list_session_wakeups", "query_wakeups"] as const;

const wakeupSchema = Type.Object({
  wakeupId: Type.String(), sourceSessionId: Type.String(), targetSessionId: Type.String(),
  createdAt: Type.String(), scheduledAt: Type.String(), message: Type.String(),
  diagnostics: Type.Optional(Type.Array(Type.Object({ code: Type.String(), message: Type.String() }))),
});
const operationErrorSchema = Type.Object({
  code: Type.String(), scheduled: Type.Optional(Type.Literal(false)),
  targetSessionId: Type.Optional(Type.String()), cancellationConfirmed: Type.Optional(Type.Literal(false)),
});
const querySchema = Type.Object({
  wakeup_id: Type.Optional(Type.String({ minLength: 1 })), session_id: Type.Optional(Type.String({ minLength: 1 })),
  source_session_id: Type.Optional(Type.String({ minLength: 1 })), target_session_id: Type.Optional(Type.String({ minLength: 1 })),
  cwd: Type.Optional(Type.String({ minLength: 1 })), status: Type.Optional(Type.Union([
    Type.Literal("pending"), Type.Literal("dispatching"), Type.Literal("submitted"), Type.Literal("received"),
    Type.Literal("run_settled"), Type.Literal("run_aborted"), Type.Literal("delivery_failed"), Type.Literal("cancelled"), Type.Literal("unknown"),
  ])),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })), cursor: Type.Optional(Type.String({ minLength: 1 })),
});
const queryResultSchema = Type.Object({
  items: Type.Array(Type.Intersect([Type.Omit(wakeupSchema, ["message"]), Type.Object({
    message: Type.Optional(Type.String()), summary: Type.String(), armed: Type.Boolean(), status: Type.String(), updatedAt: Type.String(),
    cwd: Type.Optional(Type.String()), runId: Type.Optional(Type.String()),
    notificationEntryId: Type.Optional(Type.String()), branchLeafId: Type.Optional(Type.String()),
    responseEntryIds: Type.Optional(Type.Array(Type.String())),
    dispatchingAt: Type.Optional(Type.String()), submittedAt: Type.Optional(Type.String()), receivedAt: Type.Optional(Type.String()),
    settledAt: Type.Optional(Type.String()), cancelledAt: Type.Optional(Type.String()), recoveredAt: Type.Optional(Type.String()),
    aborted: Type.Optional(Type.Boolean()), error: Type.Optional(Type.String()), unsaved: Type.Optional(Type.Boolean()),
  })])),
  nextCursor: Type.Union([Type.String(), Type.Null()]),
  health: Type.Object({ state: Type.String(), isOwner: Type.Boolean(), reason: Type.Optional(Type.String()) }),
});
const eventSchema = Type.Intersect([wakeupSchema, Type.Object({
  version: Type.Literal(1), event: Type.Union(["created", "cancelled", "submitted", "failed", "received", "run_settled", "run_aborted", "unknown"].map((value) => Type.Literal(value))),
  recordedAt: Type.String(), error: Type.Optional(Type.String()),
})]);
const historySchema = Type.Intersect([wakeupSchema, Type.Object({
  status: Type.String(), active: Type.Boolean(), events: Type.Array(eventSchema),
})]);

function result(value: unknown) {
  const text = JSON.stringify(value);
  // Results are module-owned JSON data; interface types lack JsonValue's index signature.
  return { content: [{ type: "text" as const, text }], details: value, structuredContent: value as JsonValue };
}

export function createWakeupExtension(runtime: WakeupRuntime): InlineExtension {
  return {
    name: "pi-web-wakeup", hidden: true,
    factory: (pi) => {
      // Next runs from the installed package root, not the agent session's cwd.
      pi.on("resources_discover", () => ({
        skillPaths: [join(process.cwd(), "tsgw/wakeups/skills/tsgw-session-wakeup/SKILL.md")],
      }));
      pi.registerTool(defineTool({
        name: "schedule_wakeup", label: "Schedule wakeup", exposure: "codemode",
        description: "Schedule a persistent one-time wakeup. Default target is this session; provide session_id for an existing ordinary session, OR cwd (optional title) to create a normal session in that project immediately. Specify after_seconds OR at with a timezone. Pending tasks survive restart; overdue pending tasks are submitted once on recovery. Uncertain dispatches are not retried. Only the handoff message transfers, not source context or permissions; subagent targets are forbidden.",
        promptSnippet: "Schedule a one-time session wakeup or handoff",
        promptGuidelines: ["Use schedule_wakeup for deferred work; do not sleep or poll until the due time. Use query_wakeups to verify persistent status and storage health; accepted or settled does not prove task success."],
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
        executionMode: "sequential",
        parameters: Type.Object({
          session_id: Type.Optional(Type.String({ minLength: 1, description: "Existing ordinary target session ID. Defaults to this session; never a subagent." })),
          cwd: Type.Optional(Type.String({ minLength: 1, description: "Existing absolute project directory; creates a new ordinary target now. Mutually exclusive with session_id." })),
          title: Type.Optional(Type.String({ minLength: 1, description: "Optional name for a new target; requires cwd." })),
          after_seconds: Type.Optional(Type.Number({ exclusiveMinimum: 0, description: "Positive delay in seconds. Mutually exclusive with at." })),
          at: Type.Optional(Type.String({ description: "Future ISO 8601 time with Z or numeric timezone, e.g. 2026-11-01T09:00:00+08:00. Mutually exclusive with after_seconds." })),
          message: Type.String({ minLength: 1, description: "Instructions to continue later, including the context needed for a cross-session handoff." }),
        }),
        outputSchema: Type.Union([wakeupSchema, operationErrorSchema]),
        async execute(_id, input, signal, _update, ctx) {
          signal?.throwIfAborted();
          try { return result(await runtime.schedule(ctx.sessionManager.getSessionId(), input)); }
          catch (error) {
            if (error instanceof WakeupOperationError) return { ...result(error.details), isError: true };
            throw error;
          }
        },
      }));
      pi.registerTool(defineTool({
        name: "list_wakeups", label: "List pending wakeups", exposure: "codemode",
        description: "Compatibility query: list only timers actually armed in this server process, as an array including message. An empty result does not prove no persistent tasks: the scheduler may be starting, paused or owned elsewhere. Prefer query_wakeups for durable status and health. Does not start a model.",
        annotations: { readOnlyHint: true, openWorldHint: false },
        parameters: Type.Object({}), outputSchema: Type.Array(wakeupSchema),
        async execute() { return result(runtime.list()); },
      }));
      pi.registerTool(defineTool({
        name: "cancel_wakeup", label: "Cancel wakeup", exposure: "codemode",
        description: "Cancel a pending wakeup by its UUIDv7 ID. Does not stop a session or retract an already submitted message. Refuses an ID no longer pending in this server process.",
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
        executionMode: "sequential",
        parameters: Type.Object({ wakeup_id: Type.String({ minLength: 1, description: "UUIDv7 returned by schedule_wakeup." }) }),
        outputSchema: Type.Union([wakeupSchema, operationErrorSchema]),
        async execute(_id, input, signal) {
          signal?.throwIfAborted();
          try { return result(await runtime.cancel(input.wakeup_id)); }
          catch (error) {
            if (error instanceof WakeupOperationError) return { ...result(error.details), isError: true };
            throw error;
          }
        },
      }));
      pi.registerTool(defineTool({
        name: "query_wakeups", label: "Query wakeup status", exposure: "codemode",
        description: "Read persistent wakeup status, observation evidence and scheduler health. Defaults to tasks sent or received by this session; filter by wakeup_id for full message and evidence. Other filters support source, target, cwd, status and pagination. received means notification observed; run_settled is not task success. Unknown dispatches are not retried. Read-only: never starts or leases a session.",
        annotations: { readOnlyHint: true, openWorldHint: false },
        parameters: querySchema, outputSchema: queryResultSchema,
        async execute(_id, input, signal, _update, ctx) {
          signal?.throwIfAborted();
          const filter = input.wakeup_id || input.session_id || input.source_session_id || input.target_session_id || input.cwd;
          return result(await runtime.query(filter ? input : { ...input, session_id: ctx.sessionManager.getSessionId() }));
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
