"use client";

import { useCallback, useState, useRef } from "react";
import { Plus, RefreshCw, Terminal, Loader2, PlugZap } from "lucide-react";
import { Button } from "@repo/ui/components/ui/button";
import { ScrollArea } from "@repo/ui/components/ui/scroll-area";
import { cn } from "@repo/ui/lib/utils";
import { useSessionStore } from "@/stores/session-store";
import { useConnectionStore } from "@/stores/connection-store";
import { useUiStore } from "@/stores/ui-store";
import { getRelayClient } from "@/hooks/use-websocket";
import { SessionCard } from "./session-card";
import { LAST_SESSION_KEY, writeStored } from "@/lib/storage-keys";
import { RequireUnlockDialog } from "@/components/lock/require-unlock-dialog";
import { isSessionLocked } from "@/lib/lock-store";
import { getActiveServerId } from "@/lib/relay-registry";

interface SessionListProps {
  onCreateClick: () => void;
  className?: string;
}

export function SessionList({ onCreateClick, className }: SessionListProps) {
  const sessions = useSessionStore((s) => s.sessions);
  const sessionsLoaded = useSessionStore((s) => s.sessionsLoaded);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const setActiveSession = useSessionStore((s) => s.setActiveSession);
  const status = useConnectionStore((s) => s.status);

  /*
   * `sessionsLoaded` is set by a `session:list` reply and by nothing else, so
   * on a cold load against a machine that never answers it stays false
   * forever — and three pulsing bars said "nearly there" indefinitely, with no
   * error and nothing to press. The skeleton is only honest while a reply is
   * still plausibly coming; once the socket has given up, so should it.
   */
  const unreachable =
    !sessionsLoaded && (status === "disconnected" || status === "reconnecting");
  const isLoading = !sessionsLoaded && !unreachable;

  const [pullDistance, setPullDistance] = useState(0);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const touchStartY = useRef(0);
  // The pull must only arm at the top of the list. Radix scrolls its *viewport*,
  // not the ScrollArea root — reading scrollTop off the root always gave 0, so
  // the pull fired from anywhere in the list.
  const listRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(() => {
    getRelayClient()?.send({ type: "session:list" });
  }, []);

  /** Set while a session marked "require unlock" waits on its PIN. */
  const [challenge, setChallenge] = useState<string | null>(null);

  const attachNow = useCallback(
    (name: string) => {
      setActiveSession(name);
      if (typeof window !== "undefined") {
        writeStored(LAST_SESSION_KEY, name);
      }
      useUiStore.getState().setMobileTab("terminal");
    },
    [setActiveSession],
  );

  const handleAttach = useCallback(
    (name: string) => {
      // The same re-prompt the dashboard applies. Gating in both places is the
      // point: a session marked here should not open just because you came at
      // it from the sidebar instead.
      const serverId = getActiveServerId();
      if (serverId && isSessionLocked(serverId, name)) {
        setChallenge(name);
        return;
      }
      attachNow(name);
    },
    [attachNow],
  );

  const handleKill = useCallback((name: string) => {
    getRelayClient()?.send({ type: "session:kill", name });
  }, []);

  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    touchStartY.current = e.touches[0]!.clientY;
  }, []);

  const handleTouchMove = useCallback(
    (e: React.TouchEvent) => {
      const viewport = listRef.current?.closest<HTMLElement>(
        "[data-radix-scroll-area-viewport]",
      );
      if (!viewport || viewport.scrollTop > 0 || isRefreshing) return;
      const dy = e.touches[0]!.clientY - touchStartY.current;
      if (dy > 0) {
        setPullDistance(Math.min(dy * 0.5, 80));
      }
    },
    [isRefreshing],
  );

  const handleTouchEnd = useCallback(() => {
    if (pullDistance >= 60) {
      setIsRefreshing(true);
      refresh();
      setTimeout(() => {
        setIsRefreshing(false);
        setPullDistance(0);
      }, 800);
    } else {
      setPullDistance(0);
    }
  }, [pullDistance, refresh]);

  return (
    <div className={cn("flex flex-col overflow-hidden", className)}>
      <div className="flex items-center justify-between px-3 py-1 border-b shrink-0">
        <h2 className="text-sm font-semibold">Sessions</h2>
        <div className="flex gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="h-11 w-11"
            aria-label="Refresh sessions"
            onClick={refresh}
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-11 w-11"
            aria-label="Create session"
            onClick={onCreateClick}
          >
            <Plus className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
      <ScrollArea className="h-0 flex-1">
        {(pullDistance > 0 || isRefreshing) && (
          <div
            className="flex items-center justify-center transition-all"
            style={{ height: isRefreshing ? 40 : pullDistance }}
          >
            <Loader2
              className={cn(
                "h-5 w-5 text-muted-foreground",
                isRefreshing && "animate-spin",
              )}
            />
          </div>
        )}
        <div
          ref={listRef}
          className="space-y-1.5 px-3 pb-2"
          onTouchStart={handleTouchStart}
          onTouchMove={handleTouchMove}
          onTouchEnd={handleTouchEnd}
        >
          {unreachable ? (
            <div className="flex flex-col items-center gap-3 py-8 text-center">
              <PlugZap
                className="h-10 w-10 text-muted-foreground"
                aria-hidden
              />
              <div>
                <p className="text-sm font-medium">
                  Can&apos;t reach this machine
                </p>
                <p className="text-xs text-muted-foreground mt-1">
                  {status === "reconnecting"
                    ? "Still trying. Its sessions are safe — tmux keeps running whether or not anything is watching."
                    : "The connection dropped. Its sessions are safe — tmux keeps running whether or not anything is watching."}
                </p>
              </div>
              <Button
                size="sm"
                className="min-h-11"
                onClick={() => getRelayClient()?.connect()}
              >
                <RefreshCw className="mr-1 h-3.5 w-3.5" aria-hidden />
                Try again
              </Button>
            </div>
          ) : isLoading ? (
            <>
              <div className="animate-pulse rounded-md bg-muted h-16" />
              <div className="animate-pulse rounded-md bg-muted h-16" />
              <div className="animate-pulse rounded-md bg-muted h-16" />
            </>
          ) : sessions.length === 0 ? (
            <div className="flex flex-col items-center gap-3 py-8 text-center">
              <Terminal className="h-10 w-10 text-muted-foreground" />
              <div>
                <p className="text-sm font-medium">No sessions yet</p>
                <p className="text-xs text-muted-foreground mt-1">
                  Create your first terminal session to get started
                </p>
              </div>
              <Button size="sm" onClick={onCreateClick}>
                <Plus className="mr-1 h-3.5 w-3.5" />
                Create Session
              </Button>
            </div>
          ) : (
            sessions.map((session) => (
              <SessionCard
                key={session.name}
                session={session}
                isActive={session.name === activeSessionId}
                onAttach={handleAttach}
                onKill={handleKill}
              />
            ))
          )}
        </div>
      </ScrollArea>

      <RequireUnlockDialog
        open={challenge !== null}
        onOpenChange={(open) => {
          if (!open) setChallenge(null);
        }}
        sessionName={challenge ?? ""}
        onUnlocked={() => {
          const pending = challenge;
          setChallenge(null);
          if (pending) attachNow(pending);
        }}
      />
    </div>
  );
}
