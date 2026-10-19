import { Palette } from "@/features/palette/palette";
import { useCallback, useEffect, useState } from "react";
import { TransferPanel } from "@/features/files/transfer-controls";
import { Outlet, useNavigate } from "react-router";
import { TerminalWorkspace } from "@/features/workspace/terminal-workspace";
import { useMachineStore } from "@/features/connection/machine-store";
import { MachineWorkspace } from "@/features/workspace/machine-workspace";
import { useActiveTabMachine } from "@/features/workspace/use-active-tab-machine";
import { AppShell } from "./app-shell";
import { useWebSocket } from "@/features/connection/use-websocket";
import { useUserDocumentsSync } from "@/features/settings/settings-sync";
import {
  filesDisabled,
  isReadOnly,
  useConnectionStore,
} from "@/features/connection/connection-store";
import { useSessionStore } from "@/features/session/session-store";
import { useStableMediaQuery } from "@/shared/use-media-query";
import { MOBILE_MEDIA_QUERY } from "@/shared/mobile-query";
import { trackZoomPointer } from "@/features/terminal/font-zoom";
import { useKeybindings } from "@/features/keybindings/use-keybindings";
import { MobileNav } from "@/features/mobile/mobile-nav";
import { CommandComposer } from "@/features/mobile/command-composer";
import { KeyboardToolbar } from "@/features/mobile/keyboard-toolbar";
import { useUiStore } from "@/features/workspace/ui-store";
import { TERMINAL_TAB, useMainTabsStore } from "@/features/workspace/main-tabs-store";
import { useAlertStore } from "@/shared/alert-store";
import { getTerminalHandle } from "@/features/terminal/terminal-handle";
import { useTerminalStore } from "@/features/terminal/terminal-store";
import { KeyboardShortcutsDialog } from "@/features/palette/keyboard-shortcuts-dialog";
import { TerminalErrorBoundary } from "./terminal-error-boundary";
import { ConnectionBanner } from "@/features/connection/connection-banner";
import { CapabilityBanner } from "@/features/connection/capability-banner";
import { LockGate } from "@/features/lock/lock-gate";
import { VisualViewportSync } from "@/features/mobile/visual-viewport-sync";
import { useMobileHistory } from "@/features/mobile/use-mobile-history";
import { resolveRelayWsUrl } from "@/features/connection/relay-url";
import { Loader2 } from "lucide-react";
import { copyFailureReason, copyText } from "@/shared/clipboard";
import {
  LAST_SESSION_KEY,
  readSelfHostedToken,
  readStored,
} from "@/features/connection/storage-keys";

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

function TerminalLayoutInner() {
  const navigate = useNavigate();
  // The token from login, or the lock store after an unlock. Read once per
  // mount: the read is synchronous, and `LockGate` mounts this anew after
  // every unlock. Without a token the browser goes back to /login.
  const [token] = useState(readSelfHostedToken);
  // Selected, and for the sharpest reason of all: `composerDraft` lives in this
  // same store and is written on every keystroke in the command composer.
  const mobileTab = useUiStore((s) => s.mobileTab);
  const setMobileTab = useUiStore((s) => s.setMobileTab);
  const terminalTabActive = useMainTabsStore((s) => s.active === TERMINAL_TAB);

  const isMobile = useStableMediaQuery(MOBILE_MEDIA_QUERY);

  useMobileHistory();

  useEffect(() => {
    if (!token) navigate("/login", { replace: true });
  }, [token, navigate]);

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

  // Key bindings, one capture listener on window. See features/keybindings.
  useKeybindings();

  // Zoom keys size what was clicked last when nothing has focus.
  useEffect(() => trackZoomPointer(), []);

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
      useAlertStore.getState().push("info", "Nothing selected — use Copy Mode to copy the pane");
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
  // The active tab's machine is settled first. A tab of another machine asks
  // for a switch, and the socket effect then waits for it.
  const activeMachine = useMachineStore((s) => s.activeMachine);
  const switching = useMachineStore((s) => s.requested !== null);
  useActiveTabMachine();
  useWebSocket(token && !switching ? resolveRelayWsUrl(activeMachine) : "", token ?? "");
  // Settings and keybindings from the hub, loaded on every connect.
  useUserDocumentsSync();

  if (!token) {
    // Same markup as `LockGate`'s pending branch, and for the same reason: a
    // screen-reader user gets told what is happening, and a sighted one can
    // tell "leaving" apart from "crashed".
    return (
      <div
        className="flex min-h-[100dvh] items-center justify-center bg-background"
        role="status"
        aria-live="polite"
      >
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" aria-hidden />
        <span className="sr-only">Taking you to the connect page</span>
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
    <AppShell className="tmuxde-terminal-shell" header={header} toolbar={toolbar}>
      {/* WebKit skips edge colors from boxes at most 10px tall. Clipping
          background to empty text preserves its color without covering content. */}
      {isMobile && (
        <div
          aria-hidden="true"
          className="tmuxde-status-bar pointer-events-none fixed inset-x-0 top-0 z-[var(--z-banner)] h-[max(11px,env(safe-area-inset-top))] bg-background bg-clip-text"
        />
      )}
      <VisualViewportSync />
      <TerminalErrorBoundary fallbackMessage="Terminal crashed">
        <Outlet />
        <TerminalWorkspace />
      </TerminalErrorBoundary>
      <TransferPanel />
      <Palette />
      <CommandComposer />
      <KeyboardShortcutsDialog />
    </AppShell>
  );
}
