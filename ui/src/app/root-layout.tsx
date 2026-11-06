import { Outlet } from "react-router";
import { ThemeProvider } from "./theme-provider";
import { ToastProvider } from "./toast-provider";
import { PwaProvider } from "@/features/pwa/pwa-provider";

/**
 * Wraps every route. Base metadata lives in index.html. Workspace titles
 * follow active view inside terminal layout.
 */
export function RootLayout() {
  return (
    // Dark by default rather than following the OS. This is a terminal, and
    // the dark look is the canonical one. Light mode is one tap away.
    <ThemeProvider defaultTheme="dark">
      <PwaProvider />
      <Outlet />
      <ToastProvider />
    </ThemeProvider>
  );
}
