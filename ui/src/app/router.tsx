import { createBrowserRouter } from "react-router";
import { EntryLayout } from "./auth-layout";
import { LoginPage } from "./login";
import { NotFound } from "./not-found";
import { RootError } from "./root-error";
import { RootLayout } from "./root-layout";
import { SessionPage } from "./session";
import { TerminalLayout } from "./terminal-layout";
import { TerminalPage } from "./terminal";

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
          { path: "/m/:machineId", element: <TerminalPage /> },
          { path: "/m/:machineId/s/:sessionId", element: <SessionPage /> },
        ],
      },
      { path: "*", element: <NotFound /> },
    ],
  },
]);
