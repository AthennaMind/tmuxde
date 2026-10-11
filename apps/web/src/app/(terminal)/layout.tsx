"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { AppShell } from "@repo/ui/components/app-shell";
import { useWebSocket, getRelayClient } from "@/hooks/use-websocket";
import {
  filesDisabled,
  isReadOnly,
  useConnectionStore,
} from "@/stores/connection-store";
import { useSessionStore } from "@/stores/session-store";
import { useStableMediaQuery } from "@repo/ui/hooks/use-media-query";
import { MOBILE_MEDIA_QUERY, isMobileViewport } from "@/lib/mobile-query";
import { MobileNav } from "@/components/mobile/mobile-nav";
import { CommandComposer } from "@/components/mobile/command-composer";
import { KeyboardToolbar } from "@/components/mobile/keyboard-toolbar";
import { useUiStore } from "@/stores/ui-store";
import { useAlertStore } from "@/stores/alert-store";
import { getTerminalHandle } from "@/components/terminal/terminal-handle";
import {
  useTerminalStore,
  getDefaultFontSize,
  clampFontSize,
} from "@/stores/terminal-store";
import { CommandPalette } from "@/components/command/command-palette";
import { KeyboardShortcutsDialog } from "@/components/keyboard-shortcuts-dialog";
import { ErrorBoundary } from "@/components/error-boundary";
import { DeviceApprovalDialog } from "@/components/device-approval-dialog";
import { ConnectionBanner } from "@/components/connection-banner";
import { CapabilityBanner } from "@/components/capability-banner";
import { LockGate } from "@/components/lock/lock-gate";
import { registerDisconnect } from "@/lib/lock-controller";
import { VisualViewportSync } from "@/components/visual-viewport-sync";
import { SessionCreateDialog } from "@/components/session/session-create-dialog";
import { useMobileHistory } from "@/hooks/use-mobile-history";
import { resolveRelayWsUrl } from "@/lib/relay-url";
import {
  clearDescriptorMirror,
  loadDescriptor,
  hydrateDescriptor,
  loadSessionKeys,
  serverIdFor,
} from "@/lib/session-store";
import { type TransportFactory } from "@/lib/transport";
import { resolveRoute } from "@/lib/resolve-route";
import { Loader2 } from "lucide-react";
import { markBounced } from "@/lib/bounce-guard";
import { copyFailureReason, copyText } from "@/lib/clipboard";
import {
  LAST_SESSION_KEY,
  OPEN_NEW_SESSION_KEY,
  readSelfHostedToken,
  readStored,
} from "@/lib/storage-keys";

/**
 * The gate is outside the layout body on purpose.
 *
 * While locked, `loadSessionKeys()` cannot decrypt and returns null — which the
 * auth guard below reads, correctly, as "no session" and bounces to /start. Put
 * the gate inside and a locked device would round-trip through the entry pages
 * instead of showing the lock screen. Outside, the inner component's effects
 * never run at all until the device is open.
 */
export default function TerminalLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <LockGate>
      <TerminalLayoutInner>{children}</TerminalLayoutInner>
    </LockGate>
  );
}

/**
 * Three states, not two.
 *
 * `token: string | null` conflated "still looking" with "there is nothing" —
 * and since looking means an async IndexedDB read, every cold load rendered the
 * `null` branch first. That branch returned `null`, so the first thing anyone
 * saw on app.mtmux.com was a blank white screen for as long as the read took.
 * A spinner is not a nicety here; it is the difference between a page that is
 * working and a page that is broken, and they looked identical.
 */
type Auth =
  | { phase: "checking" }
  | { phase: "none" }
  | { phase: "ready"; token: string };

function TerminalLayoutInner({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [auth, setAuth] = useState<Auth>({ phase: "checking" });
  // Transport state stays compatible with saved machine connections.
  const [transport, setTransport] = useState<TransportFactory | undefined>();
  // Selected, and for the sharpest reason of all: `composerDraft` lives in this
  // same store and is written on every keystroke in the command composer.
  const mobileTab = useUiStore((s) => s.mobileTab);
  const setMobileTab = useUiStore((s) => s.setMobileTab);
  const [showCreateDialog, setShowCreateDialog] = useState(false);

  /** Open session creation when requested by a saved machine control. */
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (window.sessionStorage.getItem(OPEN_NEW_SESSION_KEY) !== "1") return;
    window.sessionStorage.removeItem(OPEN_NEW_SESSION_KEY);
    setShowCreateDialog(true);
  }, []);
  const isMobile = useStableMediaQuery(MOBILE_MEDIA_QUERY);
  /*
   * Field by field, not `useConnectionStore()`.
   *
   * This component renders `AppShell` → children → the entire
   * `TerminalWorkspace` and its xterm instance, and an unselected subscription
   * re-renders on *any* write to the store. `setLatency` fires on every pong,
   * i.e. every ten seconds, and `composerDraft` in the UI store is written on
   * every character typed into the command composer — so the whole terminal
   * subtree was re-rendering per keystroke. Connection status lives in
   * `SidebarStatus` for the same reason.
   */
  const activeSessionId = useSessionStore((s) => s.activeSessionId);

  useMobileHistory();

  // Accept a local token or saved keys with a working permitted route.
  useEffect(() => {
    const storedToken = readSelfHostedToken();
    if (storedToken) {
      clearDescriptorMirror();
      setAuth({ phase: "ready", token: storedToken });
      return;
    }

    let cancelled = false;

    // Failed saved routes return to token login without deleting stored keys.
    const giveUp = () => {
      setAuth({ phase: "none" });
      markBounced();
      router.replace("/login");
    };

    void (async () => {
      // `loadDescriptor` reads a tab-scoped mirror, which a fresh tab has not
      // filled yet — so an empty one means "not loaded", not "never paired".
      // Falling back to the durable record before giving up is what stops every
      // reload bouncing through an entry page and straight back again.
      const session = loadDescriptor() ?? (await hydrateDescriptor());
      if (cancelled) return;
      if (!session) {
        giveUp();
        return;
      }

      const keys = await loadSessionKeys(serverIdFor(session.descriptor));
      if (cancelled) return;
      if (!keys) {
        giveUp();
        return;
      }

      // Authenticate only after a permitted candidate accepts these keys.
      const route = await resolveRoute(session, keys);
      if (cancelled) return;
      if (!route.preferredCandidate) {
        clearDescriptorMirror();
        giveUp();
        return;
      }
      setTransport(() => route.transport);
      setAuth({ phase: "ready", token: keys.directToken });
    })();

    return () => {
      cancelled = true;
    };
  }, [router]);

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

  // Auto-restore last session
  useEffect(() => {
    const lastSession = readStored(LAST_SESSION_KEY);
    if (lastSession && !activeSessionId) {
      useSessionStore.getState().setActiveSession(lastSession);
    }
  }, [activeSessionId]);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey) {
        const { fontSize, setFontSize } = useTerminalStore.getState();
        if (e.key === "=" || e.key === "+") {
          e.preventDefault();
          setFontSize(clampFontSize(fontSize + 1));
        } else if (e.key === "-") {
          e.preventDefault();
          setFontSize(clampFontSize(fontSize - 1));
        } else if (e.key === "0") {
          e.preventDefault();
          setFontSize(getDefaultFontSize());
        } else if (e.key === "b") {
          e.preventDefault();
          useUiStore.getState().toggleSidebar();
        } else if (e.key === "e") {
          e.preventDefault();
          if (filesDisabled(useConnectionStore.getState().capabilities)) return;
          // Desktop has no Files tab. It has a side panel.
          if (isMobileViewport()) {
            useUiStore.getState().setMobileTab("files");
          } else {
            useUiStore.getState().toggleFilesPanel();
          }
        }
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
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

  // File and diff views read the Code weight setting from CSS. A store
  // subscription rather than a selector, so a change does not re-render the
  // terminal tree.
  useEffect(() => {
    const apply = (weight: number) =>
      document.documentElement.style.setProperty(
        "--code-weight",
        String(weight),
      );
    apply(useTerminalStore.getState().codeWeight);
    return useTerminalStore.subscribe((s) => apply(s.codeWeight));
  }, []);

  // Hand the lock the one thing it cannot reach on its own. Locking has to
  // drop the socket as well as the keys: an authenticated connection left open
  // behind a lock screen is a live capability a lock-screen XSS could drive.
  useEffect(() => {
    registerDisconnect(() => getRelayClient()?.disconnect());
    return () => registerDisconnect(null);
  }, []);

  // Called for its effect: this is where the socket is opened and registered.
  // Children reach it through `getRelayClient()`, not through a return value.
  const token = auth.phase === "ready" ? auth.token : null;
  useWebSocket(token ? resolveRelayWsUrl() : "", token ?? "", transport);

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
  const header = isMobile ? undefined : (
    <>
      <ConnectionBanner />
      <CapabilityBanner />
    </>
  );

  // Both of these exist only to send input, so a read-only share should not
  // carry them — a send button that does nothing is worse than no button.
  const canType = !isReadOnly(capabilities);

  const toolbar = isMobile ? (
    <div>
      <ConnectionBanner />
      <CapabilityBanner />
      {mobileTab === "terminal" && canType && (
        <KeyboardToolbar
          onFocusTerminal={() => getTerminalHandle()?.focus()}
          onBlurTerminal={() => getTerminalHandle()?.blur()}
          onSearchOpen={() => useUiStore.getState().setTerminalSearchOpen(true)}
          onCopy={handleCopySelection}
        />
      )}
      {/* Hidden by CSS while the keyboard is up — see globals.css. The
          wrapper exists so the nav itself stays a plain component. */}
      <div className="mtmux-hide-when-keyboard">
        <MobileNav activeTab={mobileTab} onTabChange={setMobileTab} />
      </div>
    </div>
  ) : undefined;

  return (
    <AppShell
      className="mtmux-terminal-shell"
      header={header}
      toolbar={toolbar}
    >
      {/* WebKit skips edge colors from boxes at most 10px tall. Clipping
          background to empty text preserves its color without covering content. */}
      {isMobile && (
        <div
          aria-hidden="true"
          className="mtmux-status-bar pointer-events-none fixed inset-x-0 top-0 z-[var(--z-banner)] h-[max(11px,env(safe-area-inset-top))] bg-background bg-clip-text"
        />
      )}
      <VisualViewportSync />
      <ErrorBoundary fallbackMessage="Terminal crashed">
        {children}
      </ErrorBoundary>
      <CommandPalette />
      <CommandComposer />
      <KeyboardShortcutsDialog />
      {/* Last, and outside every other overlay, because it outranks all of
          them: if a device is asking to be let onto this machine, that is the
          only thing on screen worth deciding. It renders nothing until there
          is a question. */}
      <DeviceApprovalDialog />
      <SessionCreateDialog
        open={showCreateDialog}
        onOpenChange={setShowCreateDialog}
      />
    </AppShell>
  );
}
