// Light, dark or system, from the nearest ThemeProvider.
import { useContext } from "react";
import { ThemeContext, type ThemeState } from "./theme-context";

export function useTheme(): ThemeState {
  return useContext(ThemeContext);
}
