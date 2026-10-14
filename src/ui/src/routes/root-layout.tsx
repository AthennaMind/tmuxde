import { Outlet } from "react-router";
import { ThemeProvider } from "@/providers/theme-provider";
import { ToastProvider } from "@/providers/toast-provider";
import { PwaProvider } from "@/components/pwa/pwa-provider";

/**
 * Wraps every route. Title, metadata, viewport and icons are static tags in
 * index.html.
 */
export function RootLayout() {
  return (
    // Dark by default rather than following the OS. This is a terminal, and
    // the dark look is the canonical one. Light mode is one tap away.
    //
    // next-themes renders an inline script for server rendering. A client
    // render never runs it, and React warns about it. A data block type keeps
    // it inert and quiet. index.html sets the first theme instead.
    <ThemeProvider
      defaultTheme="dark"
      scriptProps={{ type: "application/json" }}
    >
      <PwaProvider />
      <Outlet />
      <ToastProvider />
    </ThemeProvider>
  );
}
