// Light, dark or system, from the nearest ThemeProvider.
import { useContext } from "react";
import { ThemeContext, type ThemeState } from "@/providers/theme-context";

export function useTheme(): ThemeState {
  return useContext(ThemeContext);
}
