import type { Theme } from "@/shared/theme-context";

/**
 * The `appearance.theme` setting as a tiny external store.
 *
 * `ThemeProvider` reads it with `useSyncExternalStore`. The settings bridge
 * applies the synced value here and writes user changes back to the
 * document. The localStorage key `theme` is only a cache for the pre paint
 * script in `index.html`, so the first value comes from it.
 *
 * `origin` tells listeners who changed the value. `user` is a choice made in
 * this tab and is written to the document. `sync` came from the document or
 * from another tab and is already saved.
 */

export type ThemeOrigin = "user" | "sync";

/** Read by the pre paint script in `index.html`. Keep the name. */
export const THEME_CACHE_KEY = "theme";

const DEFAULT_THEME: Theme = "dark";

export function isTheme(value: unknown): value is Theme {
  return value === "light" || value === "dark" || value === "system";
}

function readCache(): Theme {
  try {
    const value =
      typeof localStorage === "undefined" ? null : localStorage.getItem(THEME_CACHE_KEY);
    return isTheme(value) ? value : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

let current: Theme | null = null;
const listeners = new Set<(origin: ThemeOrigin) => void>();

export function getThemeSetting(): Theme {
  if (current === null) current = readCache();
  return current;
}

export function setThemeSetting(theme: Theme, origin: ThemeOrigin = "user"): void {
  if (theme === getThemeSetting()) return;
  current = theme;
  for (const listener of listeners) listener(origin);
}

export function subscribeThemeSetting(listener: (origin: ThemeOrigin) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Drop the value so the next read starts from the cache again. */
export function resetThemeSettingForTests(): void {
  current = null;
  listeners.clear();
}
