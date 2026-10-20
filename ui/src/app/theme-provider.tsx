// Own theme provider. It replaces next-themes and keeps the parts this app
// used: a light or dark class on the root element, color-scheme, system
// tracking, tab sync and no transitions on change.
//
// The theme is the synced `appearance.theme` setting, held in
// features/settings/theme-setting.ts. The localStorage key "theme" stays as
// its cache: index.html applies it before first paint, and other tabs see
// changes to it through the storage event.
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  ThemeContext,
  registerThemeSetter,
  type ResolvedTheme,
  type Theme,
} from "@/shared/theme-context";
import {
  THEME_CACHE_KEY,
  getThemeSetting,
  isTheme,
  setThemeSetting,
  subscribeThemeSetting,
} from "@/features/settings/theme-setting";

const DARK_QUERY = "(prefers-color-scheme: dark)";

let darkQuery: MediaQueryList | null | undefined;

function systemQuery(): MediaQueryList | null {
  if (darkQuery === undefined) {
    darkQuery =
      typeof window !== "undefined" && typeof window.matchMedia === "function"
        ? window.matchMedia(DARK_QUERY)
        : null;
  }
  return darkQuery;
}

function subscribeSystem(onChange: () => void) {
  const query = systemQuery();
  query?.addEventListener("change", onChange);
  return () => query?.removeEventListener("change", onChange);
}

function systemTheme(): ResolvedTheme {
  return systemQuery()?.matches === false ? "light" : "dark";
}

function serverTheme(): ResolvedTheme {
  return "dark";
}

function applyTheme(resolved: ResolvedTheme) {
  const root = document.documentElement;
  const other = resolved === "dark" ? "light" : "dark";
  if (
    root.classList.contains(resolved) &&
    !root.classList.contains(other) &&
    root.style.colorScheme === resolved
  ) {
    return;
  }
  // Transitions stay off while the new colors are computed and for the
  // next frame. Otherwise every themed element fades on its own schedule.
  const style = document.createElement("style");
  style.textContent = "*,*::before,*::after{transition:none!important}";
  document.head.appendChild(style);
  root.classList.remove(other);
  root.classList.add(resolved);
  root.style.colorScheme = resolved;
  void window.getComputedStyle(document.body).transition;
  requestAnimationFrame(() => requestAnimationFrame(() => style.remove()));
}

export function ThemeProvider({
  children,
  defaultTheme = "dark",
}: {
  children: ReactNode;
  defaultTheme?: Theme;
}) {
  const theme = useSyncExternalStore(subscribeThemeSetting, getThemeSetting, () => defaultTheme);
  const system = useSyncExternalStore(subscribeSystem, systemTheme, serverTheme);
  const resolvedTheme = theme === "system" ? system : theme;

  const setTheme = useCallback((next: Theme) => setThemeSetting(next), []);

  // Theme commands run outside React and reach the setting through this.
  useEffect(() => registerThemeSetter(setTheme), [setTheme]);

  // Cache for the pre paint script and for other tabs.
  useEffect(() => {
    try {
      if (localStorage.getItem(THEME_CACHE_KEY) !== theme) {
        localStorage.setItem(THEME_CACHE_KEY, theme);
      }
    } catch {
      // Storage can be blocked. The theme still applies to this tab.
    }
  }, [theme]);

  // Another tab changed the theme. A removed key means the default. That tab
  // already saved the change, so it lands here as a sync, not a new choice.
  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (event.key !== THEME_CACHE_KEY) return;
      setThemeSetting(isTheme(event.newValue) ? event.newValue : defaultTheme, "sync");
    };
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, [defaultTheme]);

  useLayoutEffect(() => applyTheme(resolvedTheme), [resolvedTheme]);

  const value = useMemo(
    () => ({ theme, resolvedTheme, setTheme }),
    [theme, resolvedTheme, setTheme],
  );
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}
