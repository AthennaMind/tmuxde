/**
 * Break the `/ ↔ /login` ping-pong, and leave the user something to press.
 *
 * ## The loop
 *
 * The terminal bounces to an entry page when it cannot find a usable session.
 * The entry page, helpfully, calls `hydrateDescriptor()` and navigates back to
 * the terminal if it finds one. Those two are consistent only as long as they
 * agree on what "usable" means — and they did not: `hydrateDescriptor` used to
 * return the sessionStorage mirror without checking that the keys behind it
 * still existed, while the terminal requires the keys. A mirror that outlived
 * its IndexedDB keys therefore satisfied one and failed the other, forever.
 * Safari's ITP eviction produces exactly this: it clears IndexedDB and leaves
 * sessionStorage alone.
 *
 * `hydrateDescriptor` now validates before returning, which fixes that specific
 * mismatch. This guard is the belt to that braces: **any** future disagreement
 * between the two sides costs one round trip and then stops, instead of
 * spinning the address bar until the tab is killed.
 *
 * ## Why a button rather than a nicer redirect
 *
 * A loop that resolves itself invisibly is a loop nobody reports. Stopping with
 * "Reconnect" costs one tap in the rare case the bounce was a genuine race, and
 * in every other case it puts a human in front of a broken state instead of an
 * animation. sessionStorage, not localStorage: the guard is about *this tab's*
 * navigation, and it must not outlive it.
 */

const BOUNCE_KEY = "tmuxde:bounced";

/** Called by the terminal as it gives up and sends the visitor to an entry page. */
export function markBounced(): void {
  try {
    sessionStorage.setItem(BOUNCE_KEY, "1");
  } catch {
    // Blocked storage. The worst case is the old behaviour.
  }
}

/**
 * True exactly once per bounce.
 *
 * Read-and-clear so a visitor who then pairs successfully, or who navigates
 * away and comes back, is not still being shown a stale warning.
 */
export function takeBounce(): boolean {
  try {
    if (!sessionStorage.getItem(BOUNCE_KEY)) return false;
    sessionStorage.removeItem(BOUNCE_KEY);
    return true;
  } catch {
    return false;
  }
}
