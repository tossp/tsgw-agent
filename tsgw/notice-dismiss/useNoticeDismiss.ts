import { useCallback, type Dispatch, type SetStateAction } from "react";

export function useNoticeDismiss(
  dispatchNotice: (action: { type: "remove"; id: string }) => void,
  setPausedNoticeId: Dispatch<SetStateAction<string | null>>,
) {
  return useCallback((id: string) => {
    dispatchNotice({ type: "remove", id });
    setPausedNoticeId((paused) => paused === id ? null : paused);
  }, [dispatchNotice, setPausedNoticeId]);
}
