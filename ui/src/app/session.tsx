import { useEffect, useRef } from "react";
import { useNavigate, useParams } from "react-router";
import { useSessionStore } from "@/features/session/session-store";
import { LAST_SESSION_KEY, writeStored } from "@/shared/storage-keys";
import { isGone, renamedTo } from "@/features/session/session-lifecycle";

/** Adopt session deep links while TerminalLayout keeps workspace mounted. */
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
      navigate(activeSessionId ? `/s/${encodeURIComponent(activeSessionId)}` : "/", {
        replace: true,
      });
    }
  }, [sessionId, activeSessionId, navigate]);

  return null;
}
