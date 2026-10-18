import { useEffect } from "react";
import { useRouteError } from "react-router";

/**
 * The last boundary: a throw in the root layout or in a route without its own
 * boundary.
 *
 * It renders in place of the root layout, so it cannot use anything that
 * layout provides. That rules out `ThemeProvider` and every `components/ui`
 * component that depends on it. The styling is inline and deliberately plain,
 * so the worst case is a legible sentence and a working button.
 */
export function RootError() {
  const error = useRouteError();

  useEffect(() => {
    console.error("root route error", error);
  }, [error]);

  return (
    <div
      style={{
        margin: 0,
        minHeight: "100dvh",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: "0.75rem",
        padding: "2rem 1rem",
        textAlign: "center",
        fontFamily: "ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif",
        background: "#0a0b0a",
        color: "#f4f6f2",
      }}
    >
      <h1 style={{ fontSize: "1.25rem", fontWeight: 600, margin: 0 }}>tmuxde failed to start</h1>
      <p
        style={{
          margin: 0,
          maxWidth: "28rem",
          fontSize: "0.875rem",
          opacity: 0.75,
        }}
      >
        Nothing on your machines was affected. This is the browser app, and reloading it is safe.
      </p>
      <button
        type="button"
        onClick={() => window.location.reload()}
        style={{
          marginTop: "0.5rem",
          minHeight: "44px",
          padding: "0 1.25rem",
          borderRadius: "0.5rem",
          border: "1px solid #3d443c",
          background: "#171917",
          color: "inherit",
          font: "inherit",
          cursor: "pointer",
        }}
      >
        Reload
      </button>
    </div>
  );
}
