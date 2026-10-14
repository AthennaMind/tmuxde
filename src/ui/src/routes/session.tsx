import { useEffect, useRef } from "react";
import { useNavigate, useParams } from "react-router";
import { TerminalWorkspace } from "@/components/terminal/terminal-workspace";
import { useSessionStore } from "@/stores/session-store";
import { LAST_SESSION_KEY, writeStored } from "@/lib/storage-keys";
import { isGone, renamedTo } from "@/lib/session-lifecycle";

/**
 * Deep-link straight to one tmux session.
 *
 * ## Why `/s/` and not `/<sessionId>`
 *
 * Unprefixed, this is a catch-all at the root of the terminal group, so every
 * new top-level route is one tmux session name away from being shadowed — or
 * from shadowing. A session called `start`, `pair` or `settings` is an entirely
 * ordinary thing to create, and any of them would have silently taken over a
 * real page. A one-character namespace removes the whole class.
 *
 * ## Why it renders the workspace
 *
 * It used to `return null` with a comment claiming the parent layout drew the
 * terminal. The layout draws `children`, and `children` was that null — so this
 * route rendered the app shell around an empty box. It was broken, not merely
 * unlinked.
 */
export function SessionPage() {
  // React Router decodes params. Decoding again would throw on a `%`.
  const { sessionId } = useParams<{ sessionId: string }>();
  const setActiveSession = useSessionStore((s) => s.setActiveSession);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const navigate = useNavigate();
  // Set once the store has taken the session from the URL. Before that the
  // active session is whatever the layout restored, not a change to follow.
  const adopted = useRef(false);

  useEffect(() => {
    adopted.current = false;
    if (sessionId) {
      setActiveSession(sessionId);
      writeStored(LAST_SESSION_KEY, sessionId);
    }
  }, [sessionId, setActiveSession]);

  // The URL names a session, so it follows that session's rename and lets
  // go of it once it is gone. Otherwise a reload attaches a name that no
  // longer exists. Switching to another session leaves the URL alone, as
  // it always has.
  useEffect(() => {
    if (!sessionId) return;
    if (activeSessionId === sessionId) {
      adopted.current = true;
      return;
    }
    if (!adopted.current) return;
    const to = renamedTo(sessionId);
    if (to !== null && to === activeSessionId) {
      navigate(`/s/${encodeURIComponent(to)}`, { replace: true });
      return;
    }
    if (isGone(sessionId)) {
      navigate(
        activeSessionId ? `/s/${encodeURIComponent(activeSessionId)}` : "/",
        { replace: true },
      );
    }
  }, [sessionId, activeSessionId, navigate]);

  return <TerminalWorkspace />;
}
