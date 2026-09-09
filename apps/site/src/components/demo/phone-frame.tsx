"use client";

import type { PhoneScreen, PhoneState } from "@/lib/demo/types";
import { cn } from "@/lib/utils";

/**
 * The phone half of the demo: markup and CSS, no image asset.
 *
 * What it shows is the *fixed* behaviour. A horizontal swipe steps tmux
 * **windows**, the tab strip above the terminal mirrors exactly what the swipe
 * steps, and panes only enter the picture when one is zoomed. Do not
 * re-describe this as "swipe between panes" — that was the pre-fix wording and
 * it is no longer true.
 */

interface Window {
  id: PhoneScreen;
  index: number;
  name: string;
  lines: { text: string; className?: string }[];
}

/** The three windows the phone steps through, in strip order. */
const WINDOWS: Window[] = [
  {
    id: "editor",
    index: 1,
    name: "edit",
    lines: [
      { text: "~/api  main", className: "text-term-path" },
      { text: "" },
      { text: " 12  export async function", className: "text-text-muted" },
      { text: " 13    handler(req) {", className: "text-text-muted" },
      { text: " 14      return json(req)", className: "text-term-keyword" },
      { text: " 15    }", className: "text-text-muted" },
      { text: "" },
      { text: "-- INSERT --", className: "text-term-flag" },
    ],
  },
  {
    id: "server",
    index: 2,
    name: "serve",
    lines: [
      { text: "$ pnpm dev", className: "text-term-prompt" },
      { text: "" },
      { text: "ready on :14100", className: "text-term-added" },
      { text: "GET  /api/health  200", className: "text-text-muted" },
      { text: "GET  /api/session 200", className: "text-text-muted" },
      { text: "POST /api/pair    201", className: "text-text-muted" },
      { text: "" },
      { text: "watching…", className: "text-text-faint" },
    ],
  },
  {
    id: "agent",
    index: 3,
    name: "agent",
    lines: [
      { text: "$ claude", className: "text-term-prompt" },
      { text: "" },
      { text: "· reading 14 files", className: "text-signal-agent" },
      { text: "· running the suite", className: "text-signal-agent" },
      { text: "" },
      { text: "  328 passed", className: "text-term-added" },
      { text: "" },
      { text: "still working…", className: "text-text-faint" },
    ],
  },
];

function byId(id: PhoneScreen): Window | undefined {
  return WINDOWS.find((w) => w.id === id);
}

/** The six-box pairing field, before the phone is attached. */
function PairScreen({ code, tapping }: { code: string; tapping: string | null }) {
  return (
    // Everything here is sized to fit the phone viewport's fixed height: at
    // the previous scale the prompt and the bottom keypad row were both clipped
    // by it, which read as a half-rendered screen rather than a phone.
    <div className="flex h-full flex-col items-center justify-center gap-3 px-4">
      <p className="text-center font-sans text-[0.75rem] leading-snug text-text-muted">
        Enter the code from your terminal
      </p>
      <div className="flex gap-1.5">
        {Array.from({ length: 6 }, (_, i) => (
          <span
            key={i}
            className={cn(
              "grid size-6 place-items-center rounded-md border font-mono text-[0.8125rem] transition-colors",
              code[i]
                ? "border-brand bg-brand-subtle text-text-strong"
                : "border-line bg-surface-sunken text-text-faint",
              // The box about to be filled gets the caret.
              i === code.length && "border-line-strong",
            )}
          >
            {code[i] ?? ""}
          </span>
        ))}
      </div>
      <div className="grid grid-cols-3 gap-1">
        {"123456789".split("").map((digit) => (
          <span
            key={digit}
            className={cn(
              "grid size-7 place-items-center rounded-md border border-line bg-surface-panel font-mono text-[0.75rem] text-text-muted transition-colors",
              tapping === `key-${digit}` &&
                "border-brand bg-brand text-brand-contrast",
            )}
          >
            {digit}
          </span>
        ))}
      </div>
    </div>
  );
}

/** One window's content. Deliberately static — the motion is the swipe. */
function WindowScreen({ window: win }: { window: Window }) {
  return (
    <div className="flex h-full flex-col gap-0.5 px-3 py-2.5 font-mono text-[0.75rem] leading-[1.7]">
      {win.lines.map((line, i) => (
        <div key={i} className={cn("truncate", line.className ?? "text-text")}>
          {line.text || " "}
        </div>
      ))}
    </div>
  );
}

function ScreenFor({
  screen,
  code,
  tapping,
}: {
  screen: PhoneScreen;
  code: string;
  tapping: string | null;
}) {
  const win = byId(screen);
  return win ? (
    <WindowScreen window={win} />
  ) : (
    <PairScreen code={code} tapping={tapping} />
  );
}

export function PhoneFrame({
  phone,
  className,
}: {
  phone: PhoneState;
  className?: string;
}) {
  const active = byId(phone.screen);
  // Mid-swipe the strip should already point at where you are going: that
  // optimistic highlight is exactly what the real client now does, and it is
  // why the switch stopped feeling dead over a tunnel.
  const highlighted = phone.incoming ?? phone.screen;

  return (
    <div
      className={cn(
        "terminal-scope mx-auto w-full max-w-[15rem] rounded-[1.75rem] border border-line-strong bg-surface-panel p-2 shadow-float",
        className,
      )}
      aria-hidden="true"
    >
      <div className="overflow-hidden rounded-[1.25rem] border border-line bg-surface-sunken">
        {/* Browser chrome */}
        <div className="flex items-center gap-1.5 border-b border-line-subtle bg-surface-panel px-2.5 py-1.5">
          <span className="size-1.5 rounded-full bg-signal-done" />
          <span className="truncate font-mono text-[0.6875rem] text-text-faint">
            app.mtmux.com
          </span>
        </div>

        {/* The tab strip. One entry per window, and it is the same list the
            swipe steps — that shared derivation is the whole point. */}
        {phone.paired && (
          <div className="flex items-center gap-1 border-b border-line-subtle px-2 py-1.5">
            {WINDOWS.map((win) => (
              <span
                key={win.id}
                className={cn(
                  "flex items-center gap-0.5 rounded px-1.5 py-0.5 font-mono text-[0.6875rem] transition-colors",
                  win.id === highlighted
                    ? "bg-brand text-brand-contrast"
                    : "bg-surface-panel text-text-faint",
                  phone.tapping === `tab-${win.id}` && "ring-1 ring-brand",
                )}
              >
                <span className="opacity-60">{win.index}</span>
                {win.name}
              </span>
            ))}
          </div>
        )}

        {/* The viewport. Fixed height so a screen swap never resizes the
            card, and both screens are absolutely positioned inside it so the
            slide costs one composited transform and no reflow. */}
        <div className="relative h-[10.5rem] overflow-hidden">
          <div
            className="absolute inset-0"
            style={{ transform: `translateX(${phone.swipe * 100}%)` }}
          >
            <ScreenFor
              screen={phone.screen}
              code={phone.code}
              tapping={phone.tapping}
            />
          </div>
          {phone.incoming && (
            <div
              className="absolute inset-0"
              style={{
                // Enters from whichever edge the outgoing screen is leaving
                // towards, so the pair reads as one continuous track.
                transform: `translateX(${(phone.swipe + (phone.swipe < 0 ? 1 : -1)) * 100}%)`,
              }}
            >
              <ScreenFor
                screen={phone.incoming}
                code={phone.code}
                tapping={phone.tapping}
              />
            </div>
          )}
        </div>

        {/* Status line */}
        <div className="border-t border-line-subtle px-2.5 py-1.5 font-mono text-[0.6875rem] text-text-faint">
          {phone.paired
            ? `${active?.index ?? 1} · ${active?.name ?? ""}  ·  swipe to move`
            : "waiting to pair"}
        </div>
      </div>
    </div>
  );
}

export { WINDOWS };
