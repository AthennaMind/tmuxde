import { useCallback, useEffect, useState } from "react";
import { TransferPanel } from "@/components/files/transfer-controls";
import { Outlet, useNavigate } from "react-router";
import { TerminalWorkspace } from "@/components/terminal/terminal-workspace";
import { useMachineStore } from "@/stores/machine-store";
import { MachineWorkspace } from "@/components/machine-workspace";
import { AppShell } from "@/components/app-shell";
import { useWebSocket, getRelayClient } from "@/hooks/use-websocket";
import {
  filesDisabled,
  isReadOnly,
  useConnectionStore,
} from "@/stores/connection-store";
import { useSessionStore } from "@/stores/session-store";
import { useStableMediaQuery } from "@/hooks/use-media-query";
import { MOBILE_MEDIA_QUERY, isMobileViewport } from "@/lib/mobile-query";
import { fontZoomStep } from "@/lib/font-zoom-key.js";
import { isDictationKey } from "@/lib/dictation-key";
import { toggleDictation } from "@/lib/dictation";
import {
  applyFontZoom,
  fontZoomSurface,
  trackZoomPointer,
} from "@/lib/font-zoom";
import { MobileNav } from "@/components/mobile/mobile-nav";
import { CommandComposer } from "@/components/mobile/command-composer";
import { KeyboardToolbar } from "@/components/mobile/keyboard-toolbar";
import { useUiStore } from "@/stores/ui-store";
import { OVERVIEW_TAB, TERMINAL_TAB, useMainTabsStore } from "@/stores/main-tabs-store";
import { useAlertStore } from "@/stores/alert-store";
import { getTerminalHandle } from "@/components/terminal/terminal-handle";
import { useTerminalStore } from "@/stores/terminal-store";
import { CommandPalette } from "@/components/command/command-palette";
import { KeyboardShortcutsDialog } from "@/components/keyboard-shortcuts-dialog";
import { ErrorBoundary } from "@/components/error-boundary";
import { ConnectionBanner } from "@/components/connection-banner";
import { CapabilityBanner } from "@/components/capability-banner";
import { LockGate } from "@/components/lock/lock-gate";
import { VisualViewportSync } from "@/components/visual-viewport-sync";
import { useMobileHistory } from "@/hooks/use-mobile-history";
import { resolveRelayWsUrl } from "@/lib/relay-url";
import { Loader2 } from "lucide-react";
import { copyFailureReason, copyText } from "@/lib/clipboard";
import {
  LAST_SESSION_KEY,
  readSelfHostedToken,
  readStored,
} from "@/lib/storage-keys";
import { GlobalTerminalSearch } from "@/components/terminal/global-terminal-search";

/**
 * The gate is outside the layout body on purpose.
 *
 * While locked, the token is sealed and `readSelfHostedToken()` returns null,
 * which the auth guard below reads as "no session" and bounces to /login. Put
 * the gate inside and a locked device would land on the login page instead of
 * the lock screen. Outside, the inner component's effects never run at all
 * until the device is open.
 */
export function TerminalLayout() {
  return (
    <LockGate>
      <MachineWorkspace>
        <TerminalLayoutInner />
      </MachineWorkspace>
    </LockGate>
  );
}

/**
 * Three states, not two. Checking shows a spinner, none goes to /login and
 * ready opens the socket with the token.
 */
type Auth =
  | { phase: "checking" }
  | { phase: "none" }
  | { phase: "ready"; token: string };

function TerminalLayoutInner() {
  const navigate = useNavigate();
  const [auth, setAuth] = useState<Auth>({ phase: "checking" });
  // Selected, and for the sharpest reason of all: `composerDraft` lives in this
  // same store and is written on every keystroke in the command composer.
  const mobileTab = useUiStore((s) => s.mobileTab);
  const setMobileTab = useUiStore((s) => s.setMobileTab);
  const terminalTabActive = useMainTabsStore((s) => s.active === TERMINAL_TAB);

  const isMobile = useStableMediaQuery(MOBILE_MEDIA_QUERY);

  useMobileHistory();

  // The token from login, or the lock store after an unlock. Without one the
  // browser goes back to /login.
  useEffect(() => {
    const storedToken = readSelfHostedToken();
    if (storedToken) {
      setAuth({ phase: "ready", token: storedToken });
      return;
    }
    setAuth({ phase: "none" });
    navigate("/login", { replace: true });
  }, [navigate]);

  // What this credential may do, per `auth:success`. Null on the self-hosted
  // and full-grant paths, which is what unrestricted looks like.
  const capabilities = useConnectionStore((s) => s.capabilities);

  // A share with files off must not leave the browser sitting on a Files tab
  // that no longer has a nav entry — including the case where the tab was
  // restored from a previous, unscoped connection to the same machine.
  const noFiles = filesDisabled(capabilities);
  useEffect(() => {
    if (noFiles && mobileTab === "files") setMobileTab("terminal");
  }, [noFiles, mobileTab, setMobileTab]);

  // Restore the last session once per mount, on load and after an unlock.
  // Not whenever nothing is active: a kill or an exit clears the active
  // session on purpose, and restoring then attached the dead session again.
  useEffect(() => {
    const lastSession = readStored(LAST_SESSION_KEY);
    if (lastSession && !useSessionStore.getState().activeSessionId) {
      useSessionStore.getState().setActiveSession(lastSession);
    }
  }, []);

  // Keyboard shortcuts.
  //
  // Ctrl/Cmd with -, = and 0 size whatever has focus: the terminal, or a file
  // or diff. xterm skips them (see xterm-factory.ts), so they reach here
  // instead of the shell. Anywhere else they stay browser page zoom.
  //
  // Ctrl+B, Ctrl+E and Ctrl+O only outside the terminal. xterm has already
  // sent those to tmux by the time they bubble here, and Ctrl+B is tmux's
  // default prefix. Acting on it too would toggle the sidebar on every prefix
  // press.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Works from the terminal too: xterm passes it through.
      if (isDictationKey(e)) {
        if (!useConnectionStore.getState().features.has("dictation")) return;
        e.preventDefault();
        if (!e.repeat) toggleDictation();
        return;
      }
      const zoom = fontZoomStep(e);
      if (zoom !== null) {
        const surface = fontZoomSurface(e.target);
        if (!surface) return;
        e.preventDefault();
        applyFontZoom(surface, zoom);
        return;
      }
      if (!(e.ctrlKey || e.metaKey)) return;
      if (e.key !== "b" && e.key !== "e" && e.key !== "o") return;
      if (e.target instanceof Element && e.target.closest(".xterm")) return;
      e.preventDefault();
      if (e.key === "b") {
        useUiStore.getState().toggleSidebar();
        return;
      }
      if (e.key === "o") {
        // The overview tab, and back to the terminal on a second press.
        const tabs = useMainTabsStore.getState();
        const mobile = isMobileViewport();
        if (tabs.active !== OVERVIEW_TAB) tabs.openOverview();
        else {
          tabs.showTerminal();
          // Focus was in the page that just went away.
          if (!mobile) requestAnimationFrame(() => getTerminalHandle()?.focus());
        }
        if (mobile) useUiStore.getState().setMobileTab("terminal");
        return;
      }
      if (filesDisabled(useConnectionStore.getState().capabilities)) return;
      // Desktop has no Files tab. It has a sidebar view.
      if (isMobileViewport()) {
        useUiStore.getState().setMobileTab("files");
      } else {
        useUiStore.getState().toggleSidebarView("files");
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    const stopTracking = trackZoomPointer();
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      stopTracking();
    };
  }, []);

  // Copy the terminal's current selection. The toolbar lives in the shell
  // footer, outside the tree holding the terminal ref, hence the module-level
  // handle.
  const handleCopySelection = useCallback(async () => {
    const selection = getTerminalHandle()?.getSelection() ?? "";
    if (!selection) {
      // The old copy said "long-press the terminal", which does not work:
      // xterm's selection is mouse-driven and a long press on its canvas
      // produces nothing. Pointing at the thing that does work beats repeating
      // advice that has never been true on a phone.
      useAlertStore
        .getState()
        .push("info", "Nothing selected — use Copy Mode to copy the pane");
      return;
    }
    if (await copyText(selection)) {
      useAlertStore.getState().push("success", "Copied selection");
    } else {
      useAlertStore.getState().push("error", copyFailureReason());
    }
  }, []);

  // File and diff views read their weight and size settings from CSS. A store
  // subscription rather than a selector, so a change does not re-render the
  // terminal tree.
  useEffect(() => {
    const apply = (weight: number, zoom: number) => {
      const root = document.documentElement.style;
      root.setProperty("--code-weight", String(weight));
      root.setProperty("--code-zoom", String(zoom));
    };
    const { codeWeight, codeZoom } = useTerminalStore.getState();
    apply(codeWeight, codeZoom);
    return useTerminalStore.subscribe((s) => apply(s.codeWeight, s.codeZoom));
  }, []);

  // Called for its effect: this is where the socket is opened and registered.
  // Children reach it through `getRelayClient()`, not through a return value.
  const token = auth.phase === "ready" ? auth.token : null;
  const activeMachine = useMachineStore((s) => s.activeMachine);
  const switching = useMachineStore((s) => s.requested !== null);
  useWebSocket(token && !switching ? resolveRelayWsUrl(activeMachine) : "", token ?? "");

  if (auth.phase !== "ready") {
    // Same markup as `RequireSession`'s pending branch, and for the same
    // reason: a screen-reader user gets told what is happening, and a sighted
    // one can tell "checking" apart from "crashed".
    return (
      <div
        className="flex min-h-[100dvh] items-center justify-center bg-background"
        role="status"
        aria-live="polite"
      >
        <Loader2
          className="h-5 w-5 animate-spin text-muted-foreground"
          aria-hidden
        />
        <span className="sr-only">
          {auth.phase === "checking"
            ? "Checking this device for a session"
            : "Taking you to the connect page"}
        </span>
      </div>
    );
  }

  // Desktop has no header row. Window strip and actions sit in the terminal
  // bar, connection status in the sidebar. Banners stay here so a degraded
  // connection pushes the terminal down instead of covering its first row.
  const header = (
    <>
      {!isMobile && <ConnectionBanner />}
      {!isMobile && <CapabilityBanner />}
    </>
  );

  // Both of these exist only to send input, so a read-only share should not
  // carry them — a send button that does nothing is worse than no button.
  const canType = !isReadOnly(capabilities);

  const toolbar = isMobile ? (
    <div>
      <ConnectionBanner />
      <CapabilityBanner />
      {mobileTab === "terminal" && terminalTabActive && canType && (
        <KeyboardToolbar
          onFocusTerminal={() => getTerminalHandle()?.focus()}
          onBlurTerminal={() => getTerminalHandle()?.blur()}
          onSearchOpen={() => useUiStore.getState().setTerminalSearchOpen(true)}
          onCopy={handleCopySelection}
        />
      )}
      {/* Hidden by CSS while the keyboard is up — see globals.css. The
          wrapper exists so the nav itself stays a plain component. */}
      <div className="tmuxde-hide-when-keyboard">
        <MobileNav activeTab={mobileTab} onTabChange={setMobileTab} />
      </div>
    </div>
  ) : undefined;

  return (
    <AppShell
      className="tmuxde-terminal-shell"
      header={header}
      toolbar={toolbar}
    >
      {/* WebKit skips edge colors from boxes at most 10px tall. Clipping
          background to empty text preserves its color without covering content. */}
      {isMobile && (
        <div
          aria-hidden="true"
          className="tmuxde-status-bar pointer-events-none fixed inset-x-0 top-0 z-[var(--z-banner)] h-[max(11px,env(safe-area-inset-top))] bg-background bg-clip-text"
        />
      )}
      <VisualViewportSync />
      <ErrorBoundary fallbackMessage="Terminal crashed">
        <Outlet />
        <TerminalWorkspace />
      </ErrorBoundary>
      <TransferPanel />
      <CommandPalette />
      <GlobalTerminalSearch />
      <CommandComposer />
      <KeyboardShortcutsDialog />
    </AppShell>
  );
}
