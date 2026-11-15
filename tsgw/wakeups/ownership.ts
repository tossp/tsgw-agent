import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import lockfile from "proper-lockfile";

/** A long-lived lock on a stable directory, independent of state.json replacement. */
export async function acquireWakeupOwnership(
  directory: string,
  onLost: (error: Error) => void,
  options?: { retries?: number; stale?: number; update?: number },
): Promise<{ isOwner(): boolean; release(): Promise<void> }> {
  const retries = options?.retries ?? 30;
  if (!Number.isInteger(retries) || retries < 0 || retries > 30) {
    throw new RangeError("Wakeup ownership retries must be an integer from 0 to 30");
  }
  const ownerDirectory = join(directory, "owner");
  await mkdir(ownerDirectory, { recursive: true, mode: 0o700 });
  let owner = true;
  const unlock = await lockfile.lock(ownerDirectory, {
    realpath: false,
    stale: options?.stale ?? 10_000,
    update: options?.update ?? 5_000,
    retries: { retries, factor: 1, minTimeout: 1_000, maxTimeout: 1_000, randomize: false },
    onCompromised(error) {
      if (!owner) return;
      owner = false;
      onLost(error);
    },
  });
  let releasing: Promise<void> | undefined;
  return {
    isOwner: () => owner,
    release() {
      if (releasing) return releasing;
      // A compromised lock belongs to nobody here; do not remove a successor's lock.
      if (!owner) return Promise.resolve();
      owner = false;
      releasing = unlock();
      return releasing;
    },
  };
}
