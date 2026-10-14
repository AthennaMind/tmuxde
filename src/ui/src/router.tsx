import { createBrowserRouter } from "react-router";
import { EntryLayout } from "@/routes/auth-layout";
import { LoginPage } from "@/routes/login";
import { NotFound } from "@/routes/not-found";
import { RootError } from "@/routes/root-error";
import { RootLayout } from "@/routes/root-layout";
import { SessionPage } from "@/routes/session";
import { TerminalLayout } from "@/routes/terminal-layout";
import { TerminalPage } from "@/routes/terminal";

// Client only. The server answers index.html for every app path, and these
// routes pick the page. /start, /pair and /j are not here. The server
// redirects them to /login.
export const router = createBrowserRouter([
  {
    element: <RootLayout />,
    errorElement: <RootError />,
    children: [
      {
        element: <EntryLayout />,
        children: [{ path: "/login", element: <LoginPage /> }],
      },
      {
        element: <TerminalLayout />,
        children: [
          { index: true, element: <TerminalPage /> },
          { path: "/s/:sessionId", element: <SessionPage /> },
        ],
      },
      { path: "*", element: <NotFound /> },
    ],
  },
]);
