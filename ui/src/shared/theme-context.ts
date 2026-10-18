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
