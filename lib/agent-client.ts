// Client-side helper for POST /api/agent/[id].
//
// Every /api/agent/[id] route returns one of:
//   { success: true, data: <result> }
//   { error: string }              (non-2xx)
//
// Call sites previously repeated the same 5-line fetch block 13× in
// hooks/useAgentSession.ts. This helper collapses that down to one line.

import { reportCatError } from "./cat-monitoring";
import { missingCwdFromBody } from "./missing-cwd";

export class AgentCommandError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
    public readonly accepted?: boolean,
    /** The session's folder, when the refusal is that it no longer exists (#1422). */
    public readonly missingCwd?: string,
  ) {
    super(message);
    this.name = "AgentCommandError";
  }
}

export function isPromptRejectedError(error: unknown): error is AgentCommandError {
  return error instanceof AgentCommandError
    && error.code === "prompt_rejected"
    && error.accepted === false;
}

/**
 * GET /api/agent/[id] without the system prompt, for status reads: the usage read after each
 * reply and on every stream connect, the settle and reconcile polls. None of them shows the
 * prompt, and it is nearly all of the reply (context files, skills, tool notes: hundreds of KB
 * in a large project), fetched again after every model call (#1302).
 */
export function agentStatusUrl(sessionId: string): string {
  return `/api/agent/${encodeURIComponent(sessionId)}?systemPrompt=0`;
}

export async function sendAgentCommand<T = unknown>(
  sessionId: string,
  command: Record<string, unknown>,
): Promise<T> {
  // Monitoring only: the command's type and the session, never its body (a prompt can
  // be long and carries nothing a broken reply needs).
  const tags = {
    source: "agent-command",
    operation: typeof command.type === "string" ? command.type : undefined,
    session_id: sessionId,
  };

  let res: Response;
  try {
    res = await fetch(`/api/agent/${encodeURIComponent(sessionId)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(command),
    });
  } catch (error) {
    reportCatError(error, tags);
    throw error;
  }

  type Body = {
    success?: boolean;
    data?: T;
    error?: string;
    code?: string;
    accepted?: boolean;
  };
  let body: Body = {};
  try {
    body = (await res.json()) as Body;
  } catch (error) {
    // A 2xx whose body is not JSON is a broken reply, reported here; a non-2xx one
    // is reported below as its status, never twice.
    if (res.ok) reportCatError(error, { ...tags, status: res.status });
  }

  if (!res.ok || body.error) {
    const error = new AgentCommandError(
      body.error ?? `HTTP ${res.status}`,
      res.status,
      body.code,
      body.accepted,
      missingCwdFromBody(body) ?? undefined,
    );
    // A 4xx is a refusal the caller shows as is; a 5xx, or a 2xx carrying `error`, is a failure.
    if (res.ok || res.status >= 500) reportCatError(error, { ...tags, status: res.status });
    throw error;
  }
  return body.data as T;
}
