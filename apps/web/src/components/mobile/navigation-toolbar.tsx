"use client";

import { useEffect, useMemo } from "react";
import { Keyboard } from "lucide-react";
import { createKeyRepeat } from "@/lib/key-repeat.js";
import { sendKeySequence } from "@/lib/send-key";
import { useConnectionStore } from "@/stores/connection-store";
import { useSessionStore } from "@/stores/session-store";
import { usePaneStore } from "@/stores/pane-store";

const keys = [
  { label: "Arrow left", text: "←", value: "\x1b[D" },
  { label: "Arrow down", text: "↓", value: "\x1b[B" },
  { label: "Arrow up", text: "↑", value: "\x1b[A" },
  { label: "Arrow right", text: "→", value: "\x1b[C" },
];

export function NavigationToolbar({
  onKeyboard,
  onMore,
  moreOpen,
}: {
  onKeyboard: () => void;
  onMore: () => void;
  moreOpen: boolean;
}) {
  const connected = useConnectionStore((s) => s.status === "connected");
  const session = useSessionStore((s) => s.activeSessionId);
  const pane = usePaneStore((s) => s.activePaneId);
  const repeat = useMemo(() => createKeyRepeat(sendKeySequence), []);
  const disabled = !connected || !session;
  useEffect(() => {
    const stop = () => repeat.stop();
    window.addEventListener("blur", stop);
    document.addEventListener("visibilitychange", stop);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
    return () => {
      stop();
      window.removeEventListener("blur", stop);
      document.removeEventListener("visibilitychange", stop);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
    };
  }, [repeat, connected, session, pane, moreOpen]);
  const keyClass =
    "flex h-11 min-w-11 shrink-0 items-center justify-center rounded-md border border-border bg-background px-1 text-xs font-medium text-foreground active:bg-accent disabled:opacity-40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";
  return (
    <div
      role="group"
      aria-label="Terminal navigation"
      className="flex gap-1 p-1"
    >
      <button
        data-terminal-key
        className={keyClass}
        aria-label="Show keyboard"
        disabled={disabled}
        onClick={onKeyboard}
      >
        <Keyboard className="h-4 w-4" />
      </button>
      <div className="flex min-w-0 flex-1 gap-1 overflow-x-auto [scrollbar-width:none]">
        {keys.map((key) => (
          <button
            key={key.label}
            data-terminal-key
            className={`${keyClass} flex-1 touch-pan-x select-none`}
            aria-label={key.label}
            disabled={disabled}
            onContextMenu={(event) => event.preventDefault()}
            onPointerDown={(event) => {
              if (!event.isPrimary || event.button !== 0) return;
              event.preventDefault();
              event.currentTarget.setPointerCapture(event.pointerId);
              repeat.start(key.value);
            }}
            onPointerUp={() => repeat.stop()}
            onPointerCancel={() => repeat.stop()}
            onPointerLeave={() => repeat.stop()}
            onLostPointerCapture={() => repeat.stop()}
            onClick={(event) => {
              if (event.detail === 0) sendKeySequence(key.value);
            }}
          >
            {key.text}
          </button>
        ))}
        {[
          ["Esc", "\x1b"],
          ["Enter", "\r"],
        ].map(([label, value]) => (
          <button
            key={label}
            data-terminal-key
            className={`${keyClass} flex-1`}
            disabled={disabled}
            onClick={() => sendKeySequence(value!)}
          >
            {label}
          </button>
        ))}
      </div>
      <button
        data-terminal-key
        className={keyClass}
        aria-label="More terminal controls"
        aria-expanded={moreOpen}
        onClick={onMore}
      >
        More
      </button>
    </div>
  );
}
