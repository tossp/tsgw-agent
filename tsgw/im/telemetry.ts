import { getClient, Scope, withIsolationScope, withScope } from "@sentry/nextjs";
import { reportCatError } from "../cat-monitoring";
import type { ImAction, ImChannel } from "./types";

/** IM can inherit the management request carrying a Token or QR authorization. */
export function reportImError(
  operation: string,
  context: {
    channel?: ImChannel;
    botId?: string;
    request?: "status" | "sessions" | ImAction["action"];
    method?: "GET" | "POST";
    responseReceived?: boolean;
    status?: number;
    errorType?: string;
    online?: boolean;
  } = {},
  message = `IM ${operation} failed`,
): void {
  const error = new Error(message);
  const tags = { source: "im", operation, ...context };
  if (typeof window !== "undefined") {
    reportCatError(error, tags);
    return;
  }
  // Native server scopes keep credentials and chat data out of this background event,
  // without changing collection for other CAT callers.
  const client = getClient();
  const scope = new Scope();
  scope.setClient(client);
  scope.update(client?.getOptions().initialScope);
  withIsolationScope(new Scope(), () => withScope(scope, () => {
    reportCatError(error, tags);
  }));
}
