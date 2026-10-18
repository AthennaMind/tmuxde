// Own theme provider. It replaces next-themes and keeps the parts this app
// used: storage key "theme", a light or dark class on the root element,
// color-scheme, system tracking, tab sync and no transitions on change.
// index.html applies the stored theme before first paint with the same key.
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { ThemeContext, type ResolvedTheme, type Theme } from "@/shared/theme-context";

const STORAGE_KEY = "theme";
const DARK_QUERY = "(prefers-color-scheme: dark)";

function isTheme(value: unknown): value is Theme {
  return value === "light" || value === "dark" || value === "system";
}

function storedTheme(fallback: Theme): Theme {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return isTheme(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

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
  const [theme, setThemeState] = useState<Theme>(() => storedTheme(defaultTheme));
  const system = useSyncExternalStore(subscribeSystem, systemTheme, serverTheme);
  const resolvedTheme = theme === "system" ? system : theme;

  const setTheme = useCallback((next: Theme) => {
    setThemeState(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Storage can be blocked. The theme still applies to this tab.
    }
  }, []);

  // Another tab changed the theme. A removed key means the default.
  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (event.key !== STORAGE_KEY) return;
      setThemeState(isTheme(event.newValue) ? event.newValue : defaultTheme);
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
