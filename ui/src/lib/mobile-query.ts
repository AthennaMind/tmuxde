/**
 * What counts as the touch layout — phones and tablets.
 *
 * Width alone was not enough. An iPhone 14 in landscape is 844×390 CSS px, so
 * `(max-width: 768px)` called it a desktop the moment it was rotated — and
 * `useStableMediaQuery` re-evaluates on `orientationchange`, so it really did
 * swap layouts mid-session. That meant a 256px session sidebar eating a third
 * of a phone screen, and — because the bottom nav, the command bar and the
 * keyboard toolbar are all gated on this one flag — no Esc, no Tab and no
 * arrow keys until the user rotated back. It also tore down and rebuilt the
 * whole terminal subtree on every rotation.
 *
 * The second clause is the fix: a viewport under 500px tall with a coarse
 * pointer is a phone held sideways. `pointer: coarse` keeps a small *window* on
 * a laptop out of it, which is the case the width clause is there to serve.
 *
 * The third clause is the tablet.
 *
 * An iPad is 820–1366 CSS px wide, so both clauses above called it a desktop —
 * and the desktop layout is where none of the touch affordances live: no
 * bottom nav, no command bar, no keyboard toolbar, and (the one that made it
 * feel broken rather than merely bare) no gesture surface, so a finger could
 * not scroll tmux's history at all. Everything that layout offers instead
 * assumes a mouse and a hardware keyboard, neither of which a tablet has.
 *
 * `pointer: coarse` is again what keeps a laptop out of it, and the 1366px
 * bound keeps a coarse-pointer desktop — a touchscreen kiosk, a TV browser —
 * on the layout its screen can actually carry.
 */
export const MOBILE_MEDIA_QUERY =
  "(max-width: 768px), (max-height: 500px) and (pointer: coarse), (max-width: 1366px) and (pointer: coarse)";

/** The same question, for the handful of places that ask it imperatively. */
export function isMobileViewport(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia(MOBILE_MEDIA_QUERY).matches
  );
}
