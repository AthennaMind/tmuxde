"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  forwardRef,
  useImperativeHandle,
} from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { SearchAddon } from "@xterm/addon-search";
import "@xterm/xterm/css/xterm.css";
import {
  getTerminalTheme,
  terminalThemeToXterm,
} from "@repo/ui/terminal-themes";
import { createXterm } from "@/lib/xterm-factory";
import { useTerminalStore } from "@/stores/terminal-store";
import { usePaneStore } from "@/stores/pane-store";
import { useSettingsStore } from "@/stores/settings-store";
import { isMobileViewport } from "@/lib/mobile-query";
import { useAlertStore } from "@/stores/alert-store";
import { isReadOnly, useConnectionStore } from "@/stores/connection-store";
import { getRelayClient, useRelaySubscription } from "@/hooks/use-websocket";
import {
  IDLE,
  attachedName,
  needsAttach,
  nextAttachId,
  reduceAttach,
  shouldWriteOutput,
  type AttachState,
} from "@/lib/attach-state";
import {
  setTerminalHandle,
  type TerminalHandle,
} from "@/components/terminal/terminal-handle";
import { Terminal, Plus, Loader2 } from "lucide-react";
import { Button } from "@repo/ui/components/ui/button";
import { cn } from "@repo/ui/lib/utils";
import type { ServerMessage } from "@repo/protocol";

interface TerminalViewProps {
  sessionName: string | null;
  className?: string;
  onCreateSession?: () => void;
}

export type TerminalViewHandle = TerminalHandle;

/**
 * All layout signals (ResizeObserver, window resize, orientation, visualViewport,
 * tab visibility, font changes) funnel into a single debounced fit. Previously
 * each had its own timer ladder, producing up to a dozen fits — and a dozen
 * `terminal:resize` round-trips — in the first 1.5s after mount. Every distinct
 * size is a SIGWINCH that makes tmux redraw for *all* attached clients, which is
 * what the flicker actually was.
 */
const FIT_DEBOUNCE_MS = 80;
/** One trailing fit after CSS transitions settle (the sidebar toggle is 200ms). */
const FIT_SETTLE_MS = 260;
/** Mount-time ladder for a container that is still 0-height (mobile tabs, CSS). */
const MOUNT_FIT_RETRY_DELAYS = [0, 50, 100, 200, 400, 800, 1500];
/**
 * When the GPU canvas is measured against its CSS box, in ms after mount.
 *
 * More than one because the box may not exist yet on the first pass and the
 * addon sizes itself asynchronously; the check is idempotent and stops mattering
 * once the addon is gone.
 */
const WEBGL_CHECK_DELAYS = [0, 250, 1000];
const ATTACH_TIMEOUT_MS = 5000;
const FALLBACK_SIZE = { cols: 80, rows: 24 };

export const TerminalView = forwardRef<TerminalViewHandle, TerminalViewProps>(
  function TerminalView({ sessionName, className, onCreateSession }, ref) {
    const containerRef = useRef<HTMLDivElement>(null);
    const terminalRef = useRef<XTerm | null>(null);
    const fitAddonRef = useRef<FitAddon | null>(null);
    const searchAddonRef = useRef<SearchAddon | null>(null);
    const webglAddonRef = useRef<WebglAddon | null>(null);

    // Single source of truth for the attach lifecycle — see lib/attach-state.ts.
    const attachStateRef = useRef<AttachState>(IDLE);
    // Last size actually sent to the relay, so repeated fits at the same
    // dimensions never hit the wire.
    const lastSentSizeRef = useRef<{ cols: number; rows: number } | null>(null);

    // Imperative handles owned by the init effect, used by the effects below.
    const scheduleFitRef = useRef<(() => void) | null>(null);
    const syncSizeRef = useRef<(() => void) | null>(null);

    const fitTimersRef = useRef<{
      debounce: ReturnType<typeof setTimeout> | null;
      settle: ReturnType<typeof setTimeout> | null;
      mountRetries: ReturnType<typeof setTimeout>[];
    }>({ debounce: null, settle: null, mountRetries: [] });
    const optionsRafRef = useRef<number | null>(null);
    const atlasDisposableRef = useRef<{ dispose: () => void } | null>(null);

    // Per-field selectors: a change to one setting shouldn't re-render this
    // component for the others (pinch-zoom writes fontSize many times a second).
    const fontSize = useTerminalStore((s) => s.fontSize);
    const fontFamily = useTerminalStore((s) => s.fontFamily);
    const themeName = useTerminalStore((s) => s.themeName);
    const cursorStyle = useTerminalStore((s) => s.cursorStyle);
    const cursorBlink = useTerminalStore((s) => s.cursorBlink);
    const scrollback = useTerminalStore((s) => s.scrollback);
    // Read once per mount: swapping renderers on a live terminal is not
    // something xterm supports cleanly, so the init effect below owns this and
    // the toggle takes effect on the next mount/reload.
    const gpuRendering = useTerminalStore((s) => s.gpuRendering);
    const status = useConnectionStore((s) => s.status);
    const readOnly = isReadOnly(useConnectionStore((s) => s.capabilities));
    // Mirrors the attach machine for rendering only: until the ack lands the
    // terminal is a blank black rectangle, for up to ATTACH_TIMEOUT_MS.
    const [attaching, setAttaching] = useState(false);

    // Capabilities land with `auth:success`, after the init effect below has
    // already built the terminal — so this is its own effect rather than a
    // constructor option. It hides the cursor and stops mobile raising the
    // keyboard; the `onData` guard is what actually enforces it.
    useEffect(() => {
      const terminal = terminalRef.current;
      if (!terminal) return;
      terminal.options.disableStdin = readOnly;
    }, [readOnly, status]);

    /**
     * Re-fit, drop the glyph atlas and repaint every row.
     *
     * The blur this fixes is a backing-store mismatch: xterm sizes its canvases
     * once, in device pixels, from the devicePixelRatio and box it saw at the
     * time. Nothing re-derives that later, so a DPR change, a `filter` applied
     * to an ancestor while the tab is hidden, or a mobile tab swap that never
     * re-fits all leave a canvas the browser has to scale — and scaled text is
     * soft text. Clearing the texture atlas is the part that matters for the
     * WebGL renderer; the DOM renderer needs only the refresh.
     */
    const redraw = useCallback(() => {
      const terminal = terminalRef.current;
      if (!terminal) return;
      try {
        fitAddonRef.current?.fit();
      } catch {
        // Renderer mid-swap; the refresh below is still worth attempting.
      }
      try {
        webglAddonRef.current?.clearTextureAtlas();
      } catch {
        // Addon already disposed.
      }
      try {
        if (terminal.rows > 0) terminal.refresh(0, terminal.rows - 1);
      } catch {
        // Same.
      }
    }, []);

    /**
     * One handle, two consumers.
     *
     * The ref and the module-level registry used to carry hand-copied twins of
     * this object, so every method had to be added twice and the two could
     * silently drift. Built once here instead; the refs it closes over are
     * stable for the component's life, so it never needs rebuilding.
     */
    const makeHandle = useCallback(
      (): TerminalViewHandle => ({
        search: (term: string) => {
          searchAddonRef.current?.findNext(term);
        },
        findNext: () => {
          searchAddonRef.current?.findNext("");
        },
        findPrevious: () => {
          searchAddonRef.current?.findPrevious("");
        },
        getSelection: () => terminalRef.current?.getSelection() ?? "",
        clearSelection: () => terminalRef.current?.clearSelection(),
        getCellHeightPx: () => {
          // No public API exposes the measured cell box. This is the same
          // `_core` reach the renderer patch below already depends on, and the
          // caller treats 0 as "estimate instead".
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const core = (terminalRef.current as any)?._core;
          const height: unknown =
            core?._renderService?.dimensions?.css?.cell?.height;
          return typeof height === "number" && height > 0 ? height : 0;
        },
        redraw,
        inspect: () => {
          const term = terminalRef.current;
          if (!term) {
            return {
              cols: 0,
              rows: 0,
              cursor: { x: 0, y: 0 },
              alt: false,
              scrollback: 0,
              viewportY: 0,
              lines: [],
            };
          }
          const buf = term.buffer.active;
          const lines: string[] = [];
          for (let y = 0; y < term.rows; y++) {
            // `buf.viewportY + y`, not `y`: `getLine` indexes the whole buffer
            // including scrollback, so reading from zero returns the oldest
            // history rather than what is on screen.
            const line = buf.getLine(buf.viewportY + y);
            lines.push(
              (line?.translateToString(true) ?? "").replace(/\s+$/, ""),
            );
          }
          return {
            cols: term.cols,
            rows: term.rows,
            cursor: { x: buf.cursorX, y: buf.cursorY },
            alt: buf.type === "alternate",
            scrollback: buf.baseY,
            viewportY: buf.viewportY,
            lines,
          };
        },
      }),
      [redraw],
    );

    useImperativeHandle(ref, makeHandle, [makeHandle]);

    // Same handle, reachable from outside this subtree — see terminal-handle.ts.
    useEffect(() => {
      setTerminalHandle(makeHandle());
      return () => setTerminalHandle(null);
    }, [makeHandle]);

    // Initialize terminal ONCE on mount — no sessionName dependency
    useEffect(() => {
      if (!containerRef.current) return;

      // Stable object for the lifetime of this effect — captured once so the
      // cleanup below doesn't read a ref that could have been reassigned.
      const timers = fitTimersRef.current;
      const { terminal, fitAddon, searchAddon } = createXterm({
        container: containerRef.current,
        themeName,
        fontSize,
        fontFamily,
        cursorStyle,
        cursorBlink,
        scrollback,
      });

      terminalRef.current = terminal;
      fitAddonRef.current = fitAddon;
      searchAddonRef.current = searchAddon;

      // Safe fit wrapper — renderer may not be initialized during deferred calls
      const safeFit = () => {
        try {
          fitAddon.fit();
        } catch {
          // Renderer not ready — ignore
        }
      };

      const runFit = () => {
        safeFit();
        try {
          if (terminal.rows > 0) terminal.refresh(0, terminal.rows - 1);
        } catch {
          // refresh can throw if the renderer is mid-swap
        }
      };

      // THE fit entry point. Every layout signal calls this and nothing else.
      const scheduleFit = () => {
        if (timers.debounce) clearTimeout(timers.debounce);
        timers.debounce = setTimeout(() => {
          timers.debounce = null;
          runFit();
        }, FIT_DEBOUNCE_MS);
        if (timers.settle) clearTimeout(timers.settle);
        timers.settle = setTimeout(() => {
          timers.settle = null;
          runFit();
        }, FIT_SETTLE_MS);
      };
      scheduleFitRef.current = scheduleFit;

      // THE resize send point. Guarded on an attached session (an unguarded send
      // during startup earns a NOT_ATTACHED error toast) and deduped against the
      // last size we actually sent.
      const sendResize = (cols: number, rows: number) => {
        if (cols < 1 || rows < 1) return;
        if (!shouldWriteOutput(attachStateRef.current)) return;
        const last = lastSentSizeRef.current;
        if (last && last.cols === cols && last.rows === rows) return;
        lastSentSizeRef.current = { cols, rows };
        getRelayClient()?.send({
          type: "terminal:resize",
          size: { cols, rows },
        });
      };

      // Reconcile after an attach: the size advertised in `session:attach` may
      // predate the container being laid out.
      syncSizeRef.current = () => {
        sendResize(terminal.cols, terminal.rows);
      };

      const hasBox = () =>
        !!containerRef.current &&
        containerRef.current.offsetWidth > 0 &&
        containerRef.current.offsetHeight > 0;

      let webglAddon: WebglAddon | null = null;
      // The WebGL renderer places cells using device-pixel metrics in CSS space
      // — it applies devicePixelRatio exactly one time too many. At DPR 2 only
      // half the columns paint, at DPR 3 only a third; the rest of every line is
      // drawn off-canvas and is simply invisible. At DPR 1 the error cancels,
      // which is why this only shows up on mobile / HiDPI. Disabling the addon
      // renders correctly at every DPR, so `gpuRendering` exists as an escape
      // hatch (Settings → Terminal) for anyone hitting it.
      if (gpuRendering) {
        try {
          webglAddon = new WebglAddon();
          webglAddon.onContextLoss(() => {
            try {
              webglAddon?.dispose();
            } catch {
              // Already disposed
            }
            webglAddon = null;
            webglAddonRef.current = null;
            // Disposing hands rendering back to the DOM renderer, but nothing
            // tells it to paint — so without this the terminal froze on the
            // last GPU frame until the next resize. It is also why a lost
            // context used to look like a hang rather than a fallback.
            redraw();
          });
          terminal.loadAddon(webglAddon);
          webglAddonRef.current = webglAddon;
        } catch {
          // WebGL not supported, using default canvas renderer
          webglAddon = null;
          webglAddonRef.current = null;
        }
      }

      /*
       * Prove the GPU canvas is actually at device resolution, or drop it.
       *
       * On a DPR-3 phone the WebGL canvas is created with a 375x496 backing
       * store for a 375x496 CSS box while the DOM layers alongside it are
       * correctly 1125x1488 — a 1x render the browser then upscales 3x. That
       * is the blur, and it is silent: nothing throws, the text is simply
       * soft. So the size is checked rather than assumed, and a renderer that
       * cannot be trusted at this DPR is replaced by the DOM one, which is
       * correct at every DPR.
       *
       * Deferred behind a frame and retried: at mount the container is often
       * still 0-height (the mobile tab ladder above exists for the same
       * reason), and a zero box makes the comparison meaningless.
       */
      const isCanvasCrisp = (canvas: HTMLCanvasElement): boolean => {
        const cssWidth = canvas.clientWidth;
        const cssHeight = canvas.clientHeight;
        if (cssWidth < 1 || cssHeight < 1) return true; // Not laid out; no verdict.
        const dpr = window.devicePixelRatio || 1;
        // Rounding differs by a pixel between browsers; 1.5 device pixels of
        // slack is well inside that and nowhere near a whole DPR step.
        return (
          Math.abs(canvas.width - cssWidth * dpr) <= 1.5 &&
          Math.abs(canvas.height - cssHeight * dpr) <= 1.5
        );
      };

      const checkWebglResolution = () => {
        const addon = webglAddonRef.current;
        const container = containerRef.current;
        if (!addon || !container) return;
        if (container.offsetWidth < 1 || container.offsetHeight < 1) return;
        // The DOM/canvas layers carry `xterm-*-layer` classes; the WebGL
        // addon's canvas is appended bare, which is what tells them apart.
        const canvases = Array.from(
          container.querySelectorAll<HTMLCanvasElement>("canvas"),
        ).filter((c) => c.className === "");
        if (canvases.length === 0) return;
        if (canvases.every(isCanvasCrisp)) return;
        try {
          addon.dispose();
        } catch {
          // Already gone.
        }
        webglAddon = null;
        webglAddonRef.current = null;
        atlasDisposableRef.current?.dispose();
        atlasDisposableRef.current = null;
        redraw();
      };

      if (webglAddonRef.current) {
        WEBGL_CHECK_DELAYS.forEach((delay) => {
          timers.mountRetries.push(
            setTimeout(() => {
              requestAnimationFrame(checkWebglResolution);
            }, delay),
          );
        });
      }

      // Initial fit — if the container has dimensions, fit immediately;
      // otherwise walk a retry ladder until it does (0-height at mount happens
      // with mobile tab visibility and CSS layout settling), stopping at the
      // first success.
      if (hasBox()) {
        safeFit();
      } else {
        let attempt = 0;
        const retryFit = () => {
          if (attempt >= MOUNT_FIT_RETRY_DELAYS.length) return;
          const delay = MOUNT_FIT_RETRY_DELAYS[attempt++]!;
          const timerId = setTimeout(() => {
            if (hasBox()) {
              safeFit();
              return;
            }
            retryFit();
          }, delay);
          timers.mountRetries.push(timerId);
        };
        retryFit();
      }

      // Wire terminal input to WebSocket.
      //
      // The read-only check is here rather than only in `disableStdin` because
      // this effect runs once on mount, before `auth:success` has said what the
      // credential may do. Reading the store at send time is the version that
      // cannot be stale.
      const dataDisposable = terminal.onData((data) => {
        if (isReadOnly(useConnectionStore.getState().capabilities)) return;
        getRelayClient()?.send({ type: "terminal:input", data });
      });

      // xterm fires onResize only when fit() actually changes the dimensions,
      // which makes it the natural single place to notify the relay.
      const resizeDisposable = terminal.onResize(({ cols, rows }) => {
        sendResize(cols, rows);
      });

      const resizeObserver = new ResizeObserver(() => scheduleFit());
      resizeObserver.observe(containerRef.current);

      // Window resize — catches devtools responsive toggle, desktop resize
      const handleWindowResize = () => scheduleFit();
      window.addEventListener("resize", handleWindowResize);

      // Orientation change on mobile
      const handleOrientationChange = () => scheduleFit();
      window.addEventListener("orientationchange", handleOrientationChange);

      // visualViewport resize/scroll — browser-level zoom, on-screen keyboard,
      // panning a zoomed viewport
      const handleViewportChange = () => scheduleFit();
      window.visualViewport?.addEventListener("resize", handleViewportChange);
      window.visualViewport?.addEventListener("scroll", handleViewportChange);

      // Mobile tab visibility (display:none → display:flex)
      const intersectionObserver = new IntersectionObserver((entries) => {
        if (entries[0]?.isIntersecting) scheduleFit();
      });
      intersectionObserver.observe(containerRef.current);

      return () => {
        if (timers.debounce) clearTimeout(timers.debounce);
        if (timers.settle) clearTimeout(timers.settle);
        timers.mountRetries.forEach((id) => clearTimeout(id));
        timers.debounce = null;
        timers.settle = null;
        timers.mountRetries = [];
        if (optionsRafRef.current !== null) {
          cancelAnimationFrame(optionsRafRef.current);
          optionsRafRef.current = null;
        }
        atlasDisposableRef.current?.dispose();
        atlasDisposableRef.current = null;
        resizeObserver.disconnect();
        intersectionObserver.disconnect();
        window.removeEventListener("resize", handleWindowResize);
        window.removeEventListener(
          "orientationchange",
          handleOrientationChange,
        );
        window.visualViewport?.removeEventListener(
          "resize",
          handleViewportChange,
        );
        window.visualViewport?.removeEventListener(
          "scroll",
          handleViewportChange,
        );
        dataDisposable.dispose();
        resizeDisposable.dispose();
        // Real unmount — release the relay-side PTY. (Session *switches* don't
        // detach: the relay's attach handler replaces the bridge, and an
        // unpaired detach is exactly what used to wedge the client.)
        if (attachedName(attachStateRef.current)) {
          getRelayClient()?.send({ type: "session:detach" });
        }
        attachStateRef.current = IDLE;
        lastSentSizeRef.current = null;
        scheduleFitRef.current = null;
        syncSizeRef.current = null;
        terminal.dispose();
        terminalRef.current = null;
        fitAddonRef.current = null;
        searchAddonRef.current = null;
        webglAddonRef.current = null;
      };
    }, []); // eslint-disable-line react-hooks/exhaustive-deps -- terminal created once on mount; `redraw` is stable

    /*
     * Repaint when the tab comes back, and when the display changes.
     *
     * Two separate ways the canvas goes stale while nobody is looking:
     *
     *  - The lock screen puts `filter: blur(18px)` on `body`
     *    (`app/globals.css`), which rasterizes the canvas through a filter
     *    layer. Coming back needs an explicit repaint; xterm has no reason to
     *    issue one, because from its side nothing changed.
     *  - devicePixelRatio changes — moving a window between a laptop panel and
     *    an external monitor, or browser zoom, which is a DPR change as far as
     *    canvas sizing is concerned. The atlas was built for the old ratio and
     *    is simply the wrong resolution for the new one.
     *
     * A DPR change cannot be observed directly; the idiom is a `resolution`
     * media query for the *current* ratio, which stops matching the moment it
     * changes — so the listener has to be re-armed at the new ratio each time.
     */
    useEffect(() => {
      const onVisible = () => {
        if (document.visibilityState !== "visible") return;
        requestAnimationFrame(redraw);
      };
      document.addEventListener("visibilitychange", onVisible);

      let query: MediaQueryList | null = null;
      const onDprChange = () => {
        redraw();
        arm();
      };
      const arm = () => {
        query?.removeEventListener("change", onDprChange);
        if (typeof window.matchMedia !== "function") return;
        query = window.matchMedia(
          `(resolution: ${window.devicePixelRatio}dppx)`,
        );
        query.addEventListener("change", onDprChange);
      };
      arm();

      return () => {
        document.removeEventListener("visibilitychange", onVisible);
        query?.removeEventListener("change", onDprChange);
      };
    }, [redraw]);

    // Apply terminal option changes. Writes are coalesced into a single frame:
    // each write can trigger a WebGL character-atlas rebuild, and pinch-to-zoom
    // drives fontSize many times per second.
    useEffect(() => {
      if (!terminalRef.current) return;

      if (optionsRafRef.current !== null) {
        cancelAnimationFrame(optionsRafRef.current);
      }
      optionsRafRef.current = requestAnimationFrame(() => {
        optionsRafRef.current = null;
        const terminal = terminalRef.current;
        if (!terminal) return;

        terminal.options.fontSize = fontSize;
        terminal.options.fontFamily = fontFamily;
        terminal.options.cursorStyle = cursorStyle;
        terminal.options.cursorBlink = cursorBlink;
        terminal.options.scrollback = scrollback;
        terminal.options.theme = terminalThemeToXterm(
          getTerminalTheme(themeName),
        );

        scheduleFitRef.current?.();

        // A font/theme change rebuilds the WebGL atlas asynchronously; refit
        // once it lands, otherwise cell metrics can be stale. Debounced through
        // scheduleFit, so this is bounded no matter how often the atlas churns.
        atlasDisposableRef.current?.dispose();
        const webgl = webglAddonRef.current;
        if (webgl) {
          atlasDisposableRef.current = webgl.onChangeTextureAtlas(() => {
            scheduleFitRef.current?.();
          });
        }
      });
    }, [fontSize, fontFamily, themeName, cursorStyle, cursorBlink, scrollback]);

    useRelaySubscription((msg: ServerMessage) => {
      // NOTE: there is deliberately no auth:success re-attach here. Reconnects
      // flow through the status-dependent attach effect below, so exactly one
      // session:attach is sent per connection — two would kill and respawn the
      // PTY, replaying the capture twice.
      if (msg.type === "session:attached") {
        const prev = attachStateRef.current;
        const next = reduceAttach(prev, {
          type: "serverAttached",
          name: msg.name,
          attachId: msg.attachId,
        });
        // Stale ack for a superseded attach — ignore it rather than let it
        // corrupt the state machine.
        if (next === prev) return;
        attachStateRef.current = next;
        setAttaching(false);
        // reset(), not clear(): clear() leaves modes and the alternate buffer
        // intact, so old content bleeds through the replayed scrollback.
        terminalRef.current?.reset();
        syncSizeRef.current?.();
        return;
      }
      if (
        msg.type === "terminal:output" &&
        terminalRef.current &&
        shouldWriteOutput(attachStateRef.current)
      ) {
        terminalRef.current.write(msg.data);
      }
    });

    // Attach when the session changes *or* the connection comes up. The status
    // dependency is what fixes the mount-order race: TerminalView's effects run
    // before the parent layout has created the relay client, so the first pass
    // has nothing to send to and must re-run once the client exists.
    //
    // `status` is used purely as a re-run trigger — the decision below reads the
    // client's own status. The store can be written directly (the browser
    // `offline` event does), and trusting a value that doesn't match the live
    // socket would freeze the terminal while its connection is perfectly fine.
    useEffect(() => {
      if (!sessionName) {
        if (attachedName(attachStateRef.current)) {
          getRelayClient()?.send({ type: "session:detach" });
        }
        attachStateRef.current = reduceAttach(attachStateRef.current, {
          type: "detach",
        });
        lastSentSizeRef.current = null;
        setAttaching(false);
        return;
      }

      // Armed before any early return so a stuck attach is always surfaced,
      // whatever the reason it stalled.
      const errorTimer = setTimeout(() => {
        setAttaching(false);
        if (
          !shouldWriteOutput(attachStateRef.current) &&
          attachedName(attachStateRef.current) === sessionName &&
          // While the relay is unreachable the ConnectionBanner already says so;
          // a second "couldn't open session" toast per switch is just noise.
          getRelayClient()?.status === "connected"
        ) {
          useAlertStore
            .getState()
            .push(
              "error",
              `Couldn't open session "${sessionName}" — try again or check the relay.`,
            );
        }
      }, ATTACH_TIMEOUT_MS);

      const client = getRelayClient();
      if (!client || client.status !== "connected") {
        // Nothing to send to yet. Remember the desired session so the next run
        // (triggered by the status change) issues exactly one attach.
        attachStateRef.current = reduceAttach(attachStateRef.current, {
          type: "connectionLost",
        });
        return () => clearTimeout(errorTimer);
      }

      if (needsAttach(attachStateRef.current, sessionName)) {
        const terminal = terminalRef.current;
        const size =
          terminal && terminal.cols > 0 && terminal.rows > 0
            ? { cols: terminal.cols, rows: terminal.rows }
            : FALLBACK_SIZE;
        const attachId = nextAttachId();

        attachStateRef.current = reduceAttach(attachStateRef.current, {
          type: "requestAttach",
          name: sessionName,
          attachId,
        });
        lastSentSizeRef.current = size;
        setAttaching(true);

        client.send({
          type: "session:attach",
          name: sessionName,
          size,
          capture: true,
          attachId,
        });
        client.send({ type: "pane:list" });
        client.send({ type: "window:list" });

        if (useSettingsStore.getState().autoZoom && isMobileViewport()) {
          usePaneStore.getState().setPendingAutoZoom(true);
        }
      }

      return () => clearTimeout(errorTimer);
    }, [sessionName, status]);

    return (
      <div
        className={cn("relative", className)}
        style={{ width: "100%", height: "100%" }}
      >
        {/*
          Terminal container — always mounted.

          Named, because the product's primary surface was a bare `<div>` to
          assistive tech: no role, no label, nothing to announce on focus. The
          group role is the honest one — xterm builds its own focusable textarea
          and (when screen-reader mode is on) its own live region inside this
          element, so claiming `textbox` here would describe a control that is
          not this node.
        */}
        <div
          ref={containerRef}
          role="group"
          aria-label={
            sessionName ? `Terminal, session ${sessionName}` : "Terminal"
          }
          className={cn("h-full w-full", !sessionName && "invisible")}
        />

        {/* Attaching — pointer-events-none so keyboard/touch input still lands
            on the terminal underneath the moment output starts flowing. */}
        {sessionName && attaching && (
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-3 bg-background/80 text-muted-foreground">
            <Loader2 className="h-6 w-6 animate-spin" />
            <p className="text-sm">
              Attaching to <span className="font-mono">{sessionName}</span>…
            </p>
          </div>
        )}

        {/* No session overlay */}
        {!sessionName && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 text-muted-foreground bg-background">
            <Terminal className="h-16 w-16 text-muted-foreground/20" />
            <div className="text-center">
              <p className="text-base font-semibold text-foreground">
                No session selected
              </p>
              <p className="text-sm mt-1">
                Create or select a session to get started
              </p>
            </div>
            {onCreateSession && (
              <Button
                onClick={onCreateSession}
                className="animate-pulse hover:animate-none"
              >
                <Plus className="mr-1.5 h-4 w-4" />
                Create Session
              </Button>
            )}
          </div>
        )}
      </div>
    );
  },
);
