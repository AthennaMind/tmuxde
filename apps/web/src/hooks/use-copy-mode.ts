"use client";

import { useSyncExternalStore } from "react";

import {
  believedInCopyMode,
  subscribeCopyModeBelief,
} from "@/lib/copy-mode-belief";

/**
 * Whether this session is believed to be in tmux's copy mode, reactively.
 *
 * Separate from the belief module so that module stays importable from
 * anywhere — `terminal-scroll.ts` writes to it from a plain function, and
 * pulling React in there would put a hook next to code that is not a
 * component.
 *
 * `useSyncExternalStore` rather than a `useEffect` + `useState` pair because
 * the belief can change during the same commit that renders the reader: a drag
 * enters copy mode from an event handler, and the tearing this hook exists to
 * prevent would show a toolbar that has not noticed.
 */
export function useBelievedInCopyMode(session: string | null): boolean {
  return useSyncExternalStore(
    subscribeCopyModeBelief,
    () => believedInCopyMode(session),
    // Server render: there is no belief yet, and claiming copy mode on the
    // server would hydrate a chip that then vanishes.
    () => false,
  );
}
