/**
 * Theme constants shared by the pre-paint script and the toggle.
 *
 * Both need to agree on the storage key, the class name and the set of valid
 * choices. They are pulled from here rather than typed twice: the failure mode
 * of a drift is a page that flashes the wrong scheme on every load, which is
 * invisible in review and obvious to every visitor.
 */
export const THEME_STORAGE_KEY = "mtmux-theme";

/** `system` stores nothing and follows `prefers-color-scheme`. */
export const THEME_CHOICES = ["system", "light", "dark"] as const;

export type ThemeChoice = (typeof THEME_CHOICES)[number];

/**
 * Dispatched on `window` whenever the choice changes, so every mounted toggle
 * re-reads the document rather than keeping its own copy of the answer.
 */
export const THEME_EVENT = "mtmux:themechange";

/**
 * Runs before first paint, inlined into `<head>`.
 *
 * The document is served with `class="dark"` — dark is the canonical mtmux
 * look and the right default for a terminal tool — so this only has work to do
 * for visitors who chose light or whose OS asks for it. Kept to one statement
 * per branch and wrapped in try/catch: storage throws in a locked-down browser,
 * and a theme preference is not worth a blank page.
 */
export const THEME_SCRIPT = `(function(){try{var s=localStorage.getItem(${JSON.stringify(
  THEME_STORAGE_KEY,
)});var d=s==="dark"||(s!=="light"&&window.matchMedia("(prefers-color-scheme: dark)").matches);document.documentElement.classList.toggle("dark",d);document.documentElement.dataset.theme=s||"system";}catch(e){}})();`;
