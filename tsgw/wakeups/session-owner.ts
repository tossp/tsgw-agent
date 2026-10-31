export interface SessionOwnerAccess<Wrapper> {
  <T>(sessionId: string, owned: (wrapper: Wrapper) => T, unowned: () => T): Promise<T>;
}

/**
 * A live wrapper owns its SessionManager. A starting wrapper has already read the file,
 * and a closing wrapper's shutdown handlers may still append to it. Only when none owns
 * the file may a synchronous disk mutation run, without an await between check and write.
 * This coordinates this server process, not simultaneous writers in another pi process.
 */
export function createSessionOwnerAccess<Wrapper extends { isAlive(): boolean }>(
  getWrapper: (sessionId: string) => Wrapper | undefined,
  pendingOwner: (sessionId: string) => Promise<unknown> | null | undefined,
): SessionOwnerAccess<Wrapper> {
  return async (sessionId, owned, unowned) => {
    for (;;) {
      const wrapper = getWrapper(sessionId);
      if (wrapper?.isAlive()) return owned(wrapper);
      const pending = pendingOwner(sessionId);
      if (!pending) return unowned();
      await pending.catch(() => undefined);
    }
  };
}
