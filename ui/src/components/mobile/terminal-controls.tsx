import { useEffect, useRef, useState, type RefObject, type ComponentType } from "react";
import { ArrowLeft, Clipboard, ClipboardCopy, ClipboardPaste, HelpCircle, Images, Keyboard, LayoutGrid, PenLine, Search, Terminal, ZoomIn, ZoomOut } from "lucide-react";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { useConnectionStore } from "@/stores/connection-store";
import { useSessionStore } from "@/stores/session-store";
import { useMachineStore } from "@/stores/machine-store";
import { usePaneStore } from "@/stores/pane-store";
import { useTerminalStore } from "@/stores/terminal-store";
import { useUiStore } from "@/stores/ui-store";
import { openPalette } from "@/stores/palette-store";
import { useAlertStore } from "@/stores/alert-store";
import { useTerminalInput } from "@/lib/terminal-input.js";
import { sendKeySequence } from "@/lib/send-key";
import { getRelayClient } from "@/hooks/use-websocket";
import { getTerminalHandle } from "@/components/terminal/terminal-handle";
import { PhotoUpload } from "@/components/terminal/photo-upload";
import { RecentPhotoList } from "@/components/terminal/recent-photos";
import { TerminalKeys } from "./key-sheet";

interface TerminalControlsProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  triggerRef: RefObject<HTMLButtonElement | null>;
  navigation: boolean;
  onNavigation: () => void;
  onSearchOpen?: () => void;
  onCopy?: () => void;
  onHelp: () => void;
}

const actionClass = "flex min-h-14 min-w-0 items-center justify-center gap-2 rounded-xl bg-surface-panel px-3 py-2 text-sm font-medium text-foreground active:bg-surface-hover disabled:opacity-40 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring";

export function TerminalControls({ open, onOpenChange, triggerRef, navigation, onNavigation, onSearchOpen, onCopy, onHelp }: TerminalControlsProps) {
  const connected = useConnectionStore((s) => s.status === "connected");
  const session = useSessionStore((s) => s.activeSessionId);
  const machine = useMachineStore((s) => s.machines.find((m) => m.id === (s.activeMachine ?? "local"))?.name);
  const paneIndex = usePaneStore((s) => s.panes.find((p) => p.id === s.activePaneId)?.index);
  const capabilities = useConnectionStore((s) => s.capabilities);
  const fontSize = useTerminalStore((s) => s.fontSize);
  const [tab, setTab] = useState("keys");
  const [photos, setPhotos] = useState(false);
  const nextAction = useRef<(() => void) | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const disabled = !connected || !session;

  useEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = 0;
  }, [tab, photos]);

  // Open another tool only after this dialog releases focus and background.
  const handoff = (action: () => void) => {
    useTerminalInput.getState().reset();
    nextAction.current = action;
    onOpenChange(false);
  };

  const paste = async () => {
    const client = getRelayClient();
    const pane = usePaneStore.getState().activePaneId;
    const terminal = getTerminalHandle();
    try {
      const text = await navigator.clipboard.readText();
      if (!terminal || client !== getRelayClient() || client?.status !== "connected" || pane !== usePaneStore.getState().activePaneId || session !== useSessionStore.getState().activeSessionId || terminal !== getTerminalHandle()) {
        useAlertStore.getState().push("error", "Terminal changed. Open controls on intended pane and paste again.");
        return;
      }
      useTerminalInput.getState().reset();
      if (text) terminal.paste(text);
      else useAlertStore.getState().push("info", "Clipboard is empty. Copy text, then paste again.");
    } catch {
      useAlertStore.getState().push("error", "Clipboard unavailable. Use Paste from device keyboard.");
    }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom"
        className="flex flex-col gap-0 overflow-hidden rounded-t-3xl px-4 pt-4 font-sans data-[state=open]:duration-150 data-[state=closed]:duration-150 [&>button]:top-2 [&>button]:right-3 [&>button]:flex [&>button]:size-11 [&>button]:items-center [&>button]:justify-center [&>button]:rounded-xl"
        style={{ height: "min(34rem, calc(var(--vv-height, 100dvh) - 1rem))" }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          const action = nextAction.current;
          nextAction.current = null;
          triggerRef.current?.focus({ preventScroll: true });
          if (action) requestAnimationFrame(action);
        }}>
        <SheetHeader className="shrink-0 pb-4 text-left">
          <SheetTitle className="text-base">Terminal controls</SheetTitle>
          <SheetDescription className="text-xs">
            {session ? [machine, session, paneIndex !== undefined ? `Pane ${paneIndex}` : null, !connected ? "Disconnected" : null].filter(Boolean).join(" · ") : "Select a session to send input."}
          </SheetDescription>
        </SheetHeader>
        <Tabs value={tab} onValueChange={(value) => { setTab(value); setPhotos(false); }} className="flex min-h-0 flex-1 flex-col">
          <TabsList aria-label="Control groups" className="grid h-auto shrink-0 grid-cols-3 rounded-2xl p-1">
            {[['keys', 'Keys'], ['actions', 'Actions'], ['view', 'View']].map(([value, label]) => (
              <TabsTrigger key={value} value={value!} className="min-h-11 rounded-xl transition-colors data-[state=active]:bg-brand-subtle data-[state=active]:text-primary">{label}</TabsTrigger>
            ))}
          </TabsList>
          <div ref={bodyRef} className="min-h-0 flex-1 overflow-y-auto overscroll-contain pt-4 pb-1" data-controls-body>
            <TabsContent value="keys" className="m-0"><TerminalKeys /></TabsContent>
            <TabsContent value="actions" className="m-0 space-y-4">
              {photos ? <>
                <button type="button" className={cn(actionClass, "min-h-11 justify-start")}
                  onClick={() => setPhotos(false)}><ArrowLeft aria-hidden className="size-4" />Back to actions</button>
                <RecentPhotoList onReused={() => onOpenChange(false)} />
              </> : <>
                <div className="grid grid-cols-2 gap-2">
                  <Action icon={PenLine} label="Draft command" disabled={disabled} onClick={() => handoff(() => useUiStore.getState().openComposer())} />
                  <PhotoUpload stacked className={cn(actionClass, "h-auto w-full border-0")} />
                  <Action icon={Images} label="Recent photos" disabled={!connected || capabilities?.files === "none"} onClick={() => setPhotos(true)} />
                  <Action icon={ClipboardPaste} label="Paste" disabled={disabled} onClick={() => void paste()} />
                  {onCopy && <Action icon={Clipboard} label="Copy selection" disabled={disabled} onClick={() => handoff(onCopy)} />}
                  <Action icon={ClipboardCopy} label="Select text" disabled={disabled} onClick={() => handoff(() => useUiStore.getState().setCopyModeOpen(true))} />
                </div>
                <section className="space-y-2">
                  <h3 className="text-xs font-medium text-muted-foreground">Process controls</h3>
                  <div className="grid grid-cols-3 gap-2">
                    {[["Interrupt", "Ctrl+C", "\x03"], ["End input", "Ctrl+D", "\x04"], ["Suspend", "Ctrl+Z", "\x1a"]].map(([label, shortcut, sequence]) => (
                      <button key={shortcut} type="button" disabled={disabled} className={cn(actionClass, "flex-col gap-1 px-1 text-xs", shortcut === "Ctrl+C" && "bg-signal-failed-surface text-destructive")}
                        onClick={() => { useTerminalInput.getState().reset(); sendKeySequence(sequence!); }}>
                        <span>{label}</span><span className="font-mono text-xs">{shortcut}</span>
                      </button>
                    ))}
                  </div>
                </section>
              </>}
            </TabsContent>
            <TabsContent value="view" className="m-0 space-y-4">
              <div className="grid grid-cols-2 gap-2">
                <Action icon={Keyboard} label={navigation ? "Typing controls" : "Navigation controls"} onClick={() => handoff(onNavigation)} />
                <Action icon={LayoutGrid} label="Panes and windows" disabled={disabled} onClick={() => handoff(() => useUiStore.getState().setFabOpen(true))} />
                {onSearchOpen && <Action icon={Search} label="Find in terminal" disabled={disabled} onClick={() => handoff(onSearchOpen)} />}
                <Action icon={Terminal} label="Command palette" onClick={() => handoff(() => openPalette("commands"))} />
              </div>
              <section className="rounded-2xl bg-surface-panel p-3">
                <div className="mb-2 flex items-center justify-between text-sm"><h3 className="font-medium">Text size</h3><output className="text-muted-foreground tabular-nums">{fontSize}px</output></div>
                <div className="grid grid-cols-2 gap-2">
                  <Action icon={ZoomOut} label="Smaller" disabled={fontSize <= 8} onClick={() => useTerminalStore.getState().setFontSize(Math.max(8, fontSize - 1))} />
                  <Action icon={ZoomIn} label="Larger" disabled={fontSize >= 24} onClick={() => useTerminalStore.getState().setFontSize(Math.min(24, fontSize + 1))} />
                </div>
              </section>
              <Action icon={HelpCircle} label="Gestures and shortcuts" className="w-full" onClick={() => handoff(onHelp)} />
            </TabsContent>
          </div>
        </Tabs>
      </SheetContent>
    </Sheet>
  );
}

function Action({ icon: Icon, label, className, ...props }: {
  icon: ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
  label: string;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button type="button" className={cn(actionClass, className)} {...props}><Icon aria-hidden className="size-4 shrink-0" /><span>{label}</span></button>;
}
