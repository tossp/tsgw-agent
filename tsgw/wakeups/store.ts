import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { writePrivateFileAtomicSync } from "../../lib/atomic-file";
import type { WakeupStatus, WakeupTask } from "./types";

const statuses = new Set<WakeupStatus>([
  "pending", "dispatching", "submitted", "received", "run_settled",
  "run_aborted", "delivery_failed", "cancelled", "unknown",
]);
const requiredStrings = ["wakeupId", "sourceSessionId", "targetSessionId", "message"] as const;
const requiredDates = ["createdAt", "scheduledAt", "updatedAt"] as const;
const optionalStrings = ["cwd", "runId", "notificationEntryId", "branchLeafId", "error"] as const;
const optionalDates = [
  "dispatchingAt", "submittedAt", "receivedAt", "settledAt", "cancelledAt", "recoveredAt",
] as const;
const keys = new Set<string>([
  ...requiredStrings, ...requiredDates, ...optionalStrings, ...optionalDates,
  "status", "responseEntryIds", "aborted",
]);

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validDate(value: unknown): boolean {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function validateTasks(value: unknown): asserts value is WakeupTask[] {
  if (!Array.isArray(value)) throw new Error("Invalid wakeup tasks: expected an array");
  const ids = new Set<string>();
  for (const task of value) {
    if (!record(task)
      || Object.keys(task).some((key) => !keys.has(key))
      || requiredStrings.some((key) => typeof task[key] !== "string" || !task[key])
      || requiredDates.some((key) => !validDate(task[key]))
      || optionalStrings.some((key) => key in task && typeof task[key] !== "string")
      || optionalDates.some((key) => key in task && !validDate(task[key]))
      || !statuses.has(task.status as WakeupStatus)
      || ("aborted" in task && typeof task.aborted !== "boolean")
      || ("responseEntryIds" in task && (!Array.isArray(task.responseEntryIds)
        || task.responseEntryIds.some((id) => typeof id !== "string" || !id)))) {
      throw new Error("Invalid wakeup task shape");
    }
    const id = task.wakeupId as string;
    if (ids.has(id)) throw new Error("Duplicate wakeupId in wakeup tasks");
    ids.add(id);
  }
}

/** Disk snapshots only; the runtime owns the authoritative in-memory state. */
export class WakeupStore {
  private readonly file: string;
  private readonly write: (file: string, contents: string) => void;

  constructor(file: string, options?: { write?: (file: string, contents: string) => void }) {
    this.file = file;
    this.write = options?.write ?? writePrivateFileAtomicSync;
  }

  read(): WakeupTask[] {
    let contents: string;
    try {
      contents = readFileSync(this.file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    let data: unknown;
    try {
      data = JSON.parse(contents);
    } catch (cause) {
      throw new Error("Invalid wakeup store JSON", { cause });
    }
    if (!record(data) || data.version !== 1
      || Object.keys(data).some((key) => key !== "version" && key !== "tasks")) {
      throw new Error("Invalid wakeup store version or format");
    }
    validateTasks(data.tasks);
    return data.tasks;
  }

  save(tasks: readonly WakeupTask[]): void {
    // unsaved describes this process's observations, never a persisted fact.
    const persisted = tasks.map((task) => {
      const copy = { ...task };
      delete copy.unsaved;
      return copy;
    });
    const contents = JSON.stringify({ version: 1, tasks: persisted });
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    this.write(this.file, contents);
  }
}
