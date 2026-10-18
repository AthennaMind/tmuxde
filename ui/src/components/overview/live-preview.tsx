import { useEffect, useId, useRef, useState } from "react";
import { TerminalScreen } from "@/components/terminal/terminal-screen";
import { previewKey, useTerminalPreviewStore, watchPreview } from "@/stores/terminal-preview-store";

/** Read-only screen. Card owns navigation and its accessible name. */
export function LivePreview({ machineId, session, paneId, supported, locked, connected }: {
  machineId: string; session: string; paneId: string;
  supported: boolean; locked: boolean; connected: boolean;
}) {
  const owner = useId();
  const root = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const key = previewKey(machineId, paneId);
  const frame = useTerminalPreviewStore((s) => s.frames[key]);
  const watching = useTerminalPreviewStore((s) => s.watching[key]);
  useEffect(() => {
    const observer = new IntersectionObserver(([entry]) => setVisible(!!entry?.isIntersecting));
    observer.observe(root.current!);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!visible || locked || !supported || !connected) return;
    return watchPreview(owner, machineId, [{ session, paneId }]);
  }, [visible, locked, supported, connected, owner, machineId, session, paneId]);
  const message = locked ? "Unlock to view" : !connected ? "Reconnecting…"
    : !supported ? "Update machine to enable previews"
    : frame?.unavailable ? "Preview unavailable"
    : !frame ? !visible ? "Preview loads when visible"
    : watching === false ? "Preview limit reached. Use larger cards." : "Loading preview…" : undefined;
  return <div ref={root} className="relative aspect-video w-full overflow-hidden rounded-xl border border-border bg-background group-hover:border-muted-foreground group-focus-visible:border-ring">
    {!message && frame && visible && <TerminalScreen frame={frame} readable />}
    {message && <span className="absolute inset-0 flex items-center justify-center p-4 text-center text-xs leading-5 text-muted-foreground">{message}</span>}
  </div>;
}
