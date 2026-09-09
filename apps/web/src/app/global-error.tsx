"use client";

import { useEffect } from "react";

/**
 * The last boundary: a throw in the root layout itself.
 *
 * It replaces the whole document — `<html>` and `<body>` included — which is
 * why it renders them, and why it cannot use anything from the root layout that
 * just failed. That rules out `ThemeProvider`, the font variables, and every
 * `@repo/ui` component that resolves a CSS custom property, since the
 * stylesheet is loaded by the layout that is not there.
 *
 * So the styling is inline and scheme-aware by hand. It is deliberately plain:
 * this page exists so the worst case is a legible sentence and a working
 * button, not a white screen.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("root layout error", error.digest, error);
  }, [error]);

  return (
    <html lang="en">
      <body
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
          fontFamily:
            "ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif",
          background: "#0a0b0a",
          color: "#f4f6f2",
        }}
      >
        <h1 style={{ fontSize: "1.25rem", fontWeight: 600, margin: 0 }}>
          mtmux failed to start
        </h1>
        <p
          style={{
            margin: 0,
            maxWidth: "28rem",
            fontSize: "0.875rem",
            opacity: 0.75,
          }}
        >
          Nothing on your machines was affected — this is the browser app, and
          reloading it is safe.
        </p>
        <button
          type="button"
          onClick={reset}
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
        {error.digest && (
          <p
            style={{
              margin: 0,
              fontFamily: "ui-monospace, SFMono-Regular, monospace",
              fontSize: "0.75rem",
              opacity: 0.5,
            }}
          >
            {error.digest}
          </p>
        )}
      </body>
    </html>
  );
}
