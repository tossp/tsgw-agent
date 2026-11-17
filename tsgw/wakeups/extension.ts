import type { JsonValue } from "@earendil-works/pi-ai";
import { join } from "node:path";
import { Type } from "typebox";
import { defineTool, type InlineExtension } from "@earendil-works/pi-coding-agent";
import { WakeupOperationError, type WakeupRuntime } from "./runtime";

export const WAKEUP_TOOL_NAMES = ["schedule_wakeup", "query_wakeups", "cancel_wakeup", "close_wakeup", "clear_wakeup"] as const;

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
    Type.Literal("run_settled"), Type.Literal("run_aborted"), Type.Literal("delivery_failed"), Type.Literal("cancelled"), Type.Literal("unknown"), Type.Literal("closed"),
  ])),
  armed: Type.Optional(Type.Boolean({ description: "Filter by timers actually armed in this server process; false includes tasks not scheduled here." })),
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
    closedAt: Type.Optional(Type.String()), closeReason: Type.Optional(Type.String()),
    aborted: Type.Optional(Type.Boolean()), error: Type.Optional(Type.String()), unsaved: Type.Optional(Type.Boolean()),
  })])),
  nextCursor: Type.Union([Type.String(), Type.Null()]),
  health: Type.Object({ state: Type.String(), isOwner: Type.Boolean(), reason: Type.Optional(Type.String()) }),
});

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
        description: "Read the authoritative global wakeup status, observation evidence and scheduler health. Filter explicitly by session_id, source, target, cwd, status, armed or pagination; armed=true lists only timers actually armed in this process. Filter by wakeup_id for full message and evidence. received means notification observed; run_settled is not task success. Saved run_settled, cancelled and closed records are automatically removed after submission finishes. Interrupted, delivery_failed and unknown records remain for review; absence does not prove task success. Session messages and audit remain. Unknown dispatches are not retried. Read-only: never starts or leases a session.",
        annotations: { readOnlyHint: true, openWorldHint: false },
        parameters: querySchema, outputSchema: queryResultSchema,
        async execute(_id, input, signal) {
          signal?.throwIfAborted();
          return result(await runtime.query(input));
        },
      }));
      pi.registerTool(defineTool({
        name: "close_wakeup", label: "Close uncertain wakeup", exposure: "codemode",
        description: "Close a saved unknown wakeup after investigating its target session and outcome. Requires a reason describing the findings and disposition. Preserves delivery evidence; does not certify success, stop a running session, retract a message or retry delivery. Use schedule_wakeup separately for any authorized follow-up.",
        promptSnippet: "Close an investigated uncertain wakeup with a reason",
        promptGuidelines: ["Query the wakeup and investigate the target session before closing it. Record what was verified and how remaining work will be handled; closing is not proof of task success."],
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
        executionMode: "sequential",
        parameters: Type.Object({ wakeup_id: Type.String({ minLength: 1 }), reason: Type.String({ minLength: 1, description: "Investigation findings and disposition, including any separately arranged follow-up." }) }),
        outputSchema: Type.Union([Type.Object({
          wakeupId: Type.String(), status: Type.Literal("closed"), closedAt: Type.String(), closeReason: Type.String(),
          diagnostics: Type.Optional(Type.Array(Type.Object({ code: Type.String(), message: Type.String() }))),
        }), operationErrorSchema]),
        async execute(_id, input, signal) {
          signal?.throwIfAborted();
          try { return result(await runtime.close(input.wakeup_id, input.reason)); }
          catch (error) {
            if (error instanceof WakeupOperationError) return { ...result(error.details), isError: true };
            throw error;
          }
        },
      }));
      pi.registerTool(defineTool({
        name: "clear_wakeup", label: "Clear ended wakeup record", exposure: "codemode",
        description: "Remove one saved ended or explicitly closed wakeup from the persistent status list. Allowed statuses: run_settled, run_aborted, delivery_failed, cancelled, closed. Refuses pending, delivering, received, unknown or unsaved records. Preserves sessions, messages, responses and audit history; does not stop or retry work.",
        annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
        executionMode: "sequential",
        parameters: Type.Object({ wakeup_id: Type.String({ minLength: 1 }) }),
        outputSchema: Type.Union([Type.Object({ wakeupId: Type.String() }), operationErrorSchema]),
        async execute(_id, input, signal) {
          signal?.throwIfAborted();
          await runtime.ready();
          try { return result(runtime.clear(input.wakeup_id)); }
          catch (error) {
            if (error instanceof WakeupOperationError) return { ...result(error.details), isError: true };
            throw error;
          }
        },
      }));
    },
  };
}
