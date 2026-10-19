/**
 * Hold off key bindings while the shortcut recorder listens.
 *
 * The bindings listener sits on window in capture phase and runs before any
 * element sees a key, so a recorder cannot get there first. The listener
 * checks this flag and lets every key through while a pause holds. The
 * keymap in the store stays as it is, so hints, lists and conflict checks
 * render the same.
 */

let holds = 0;

/** Pause until the returned release runs. Pauses nest. Release twice is safe. */
export function pauseBindings(): () => void {
  holds += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holds -= 1;
  };
}

/** True while a recorder holds the bindings. */
export function bindingsPaused(): boolean {
  return holds > 0;
}
