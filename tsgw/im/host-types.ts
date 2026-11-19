import type { ImInbound, ImSessionView } from "./types";
import type { ImReplyHandle } from "./notification";

export interface ImSessionHost {
  list(cwd: string): Promise<ImSessionView[]>;
  exists(sessionId: string, cwd: string): Promise<boolean>;
  create(cwd: string): Promise<string>;
  notify(handle: ImReplyHandle, cwd: string, input: ImInbound, signal: AbortSignal): Promise<{ completion: Promise<void> }>;
  stop(sessionId: string): Promise<void>;
}
