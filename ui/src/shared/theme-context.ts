import { createContext } from "react";

export type Theme = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

export interface ThemeState {
  theme: Theme;
  resolvedTheme: ResolvedTheme;
  setTheme: (theme: Theme) => void;
}

// Outside a provider, as in server rendered tests, the app looks dark.
export const ThemeContext = createContext<ThemeState>({
  theme: "dark",
  resolvedTheme: "dark",
  setTheme: () => {},
});

type ThemeSetter = (theme: Theme) => void;

let themeSetter: ThemeSetter | null = null;

/**
 * Let the theme provider hand its setter to code outside React, such as
 * keybinding commands. Returns the cleanup, which only clears its own setter.
 */
export function registerThemeSetter(setter: ThemeSetter): () => void {
  themeSetter = setter;
  return () => {
    if (themeSetter === setter) themeSetter = null;
  };
}

/** Set the theme from a command. False while no provider has registered. */
export function setThemeFromCommand(theme: Theme): boolean {
  if (!themeSetter) return false;
  themeSetter(theme);
  return true;
}
