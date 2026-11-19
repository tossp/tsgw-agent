import { toToolDeclaration } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { defineTool, type AgentSession, type InlineExtension } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { IM_NOTIFICATION_TYPE, resolveImReplyHandle } from "./notification";
import type { ImRuntime } from "./runtime";

const nonEmpty = Type.String({ minLength: 1 });
const destinationSchema = Type.Union([
  Type.Object({ handle: nonEmpty }, { additionalProperties: false }),
  Type.Object({ bot: Type.String({ minLength: 1, description: "Name or ID of a WeChat bot configured for this project." }) }, { additionalProperties: false }),
]);
const itemSchema = Type.Union([
  Type.Object({ type: Type.Literal("text"), text: nonEmpty }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal("image"), path: nonEmpty }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal("file"), path: nonEmpty }, { additionalProperties: false }),
]);
const tool = {
  name: "im_send", label: "Send WeChat message",
  description: "Send ordered text, image, or file messages to WeChat. Use destination.handle to reply to a notification, or an explicitly requested destination.bot to push to a configured bot's linked WeChat user. Image and file items take a local path. A failed item may be partially delivered or unconfirmed. Do not resend it automatically.",
  parameters: Type.Object({ destination: destinationSchema, items: Type.Array(itemSchema, { minItems: 1 }) }),
};

type GetRuntime = () => Promise<Pick<ImRuntime, "send">>;
type ToolSession = { sessionManager: Parameters<typeof resolveImReplyHandle>[0]; cwd: string };

async function send(getRuntime: GetRuntime, ctx: ToolSession, { destination, items }: Static<typeof tool.parameters>, signal?: AbortSignal) {
  signal?.throwIfAborted();
  let target: Parameters<ImRuntime["send"]>[1];
  if ("bot" in destination) {
    target = destination;
  } else {
    const handle = resolveImReplyHandle(ctx.sessionManager, destination.handle);
    if (!handle) throw new Error("当前会话分支没有这个微信回复句柄。");
    target = { handle };
  }
  const runtime = await getRuntime();
  const details = await runtime.send(ctx.cwd, target, items, signal);
  return { content: [{ type: "text" as const, text: JSON.stringify(details) }], details, isError: !details.success };
}

export function createImExtension(getRuntime: GetRuntime): InlineExtension {
  return {
    name: "pi-web-im", hidden: true,
    factory: (pi) => {
      pi.registerTool(defineTool({
        ...tool, exposure: "model-only",
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
        executionMode: "sequential",
        execute: (_id, args, signal, _update, ctx) => send(getRuntime, ctx, args, signal),
      }));
    },
  };
}

/** Chat-only keeps its ordinary Web tool selection and exact system prompt. */
export function installChatOnlyImReply(session: Pick<AgentSession, "agent" | "sessionManager">, getRuntime: GetRuntime): void {
  const { agent, sessionManager } = session;
  const replyParameters = Type.Object({ destination: Type.Object({ handle: nonEmpty }), items: tool.parameters.properties.items });
  const replyTool: AgentTool<typeof replyParameters> = {
    ...tool,
    description: "Send an ordered text, image, or file reply to the supplied WeChat notification handle.",
    parameters: replyParameters,
    executionMode: "sequential",
    execute: (_id, args, signal) => send(getRuntime, { sessionManager, cwd: sessionManager.getCwd() }, args, signal),
  };
  const declaration = toToolDeclaration(replyTool);
  const isImRequest = (messages: typeof agent.state.messages) => {
    const input = messages.findLast((message) => message.role === "user" || (message.role === "custom" && message.customType === IM_NOTIFICATION_TYPE));
    if (input?.role !== "custom") return false;
    const id = (input.details as { id?: string } | undefined)?.id;
    return id !== undefined && resolveImReplyHandle(sessionManager, id) !== undefined;
  };
  const prepareRequest = agent.prepareRequest;
  agent.prepareRequest = async (request, signal) => {
    const prepared = await prepareRequest?.(request, signal);
    const context = prepared?.context ?? request.context;
    if (!isImRequest(context.messages)) return prepared ?? undefined;
    return { ...prepared, context: { ...context, tools: [...(context.tools ?? []), replyTool] } };
  };
  const transformContext = agent.transformContext;
  agent.transformContext = async (messages, signal) => {
    const transformed = transformContext ? await transformContext(messages, signal) : messages;
    if (!isImRequest(messages)) return transformed;
    const head = transformed[0];
    if (head?.role === "system") return [{ ...head, toolsAdded: [...(head.toolsAdded ?? []), declaration] }, ...transformed.slice(1)];
    return [{ role: "system", content: "", toolsAdded: [declaration], timestamp: Date.now() }, ...transformed];
  };
}
