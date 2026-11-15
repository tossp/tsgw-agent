import type { ImSessionView } from "./types";
import type { ImInputSource } from "./message-data";

export interface ImSessionHost {
  list(cwd: string): Promise<ImSessionView[]>;
  exists(sessionId: string, cwd: string): Promise<boolean>;
  create(cwd: string, title: string): Promise<string>;
  prompt(sessionId: string, text: string, signal: AbortSignal, source?: ImInputSource): Promise<string>;
  stop(sessionId: string): Promise<void>;
}
