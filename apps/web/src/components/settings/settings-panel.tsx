"use client";

import { Button } from "@repo/ui/components/ui/button";
import { Separator } from "@repo/ui/components/ui/separator";
import { Label } from "@repo/ui/components/ui/label";
import { Input } from "@repo/ui/components/ui/input";
import { ScrollArea } from "@repo/ui/components/ui/scroll-area";
import { Switch } from "@repo/ui/components/ui/switch";
import { ThemeToggle } from "@repo/ui/components/theme-toggle";
import { cn } from "@repo/ui/lib/utils";
import { terminalThemes } from "@repo/ui/terminal-themes";
import { useTerminalStore } from "@/stores/terminal-store";
import {
  GROUP_LABELS,
  useSettingsStore,
  type ToolbarKeyGroup,
} from "@/stores/settings-store";
import { LockSettings } from "@/components/lock/lock-settings";
import { InstallAppSection } from "@/components/pwa/install-app-section";
import { isHostedBuild } from "@/lib/auth-client";
import { AccountNudge } from "@/components/account/account-nudge";

/** Raw buttons here need the same focus ring the shared Button component has. */
const focusRing =
  "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

interface SettingsPanelProps {
  className?: string;
}

export function SettingsPanel({ className }: SettingsPanelProps) {
  /*
   * Field by field, not `useTerminalStore()`.
   *
   * On a phone this panel is never unmounted — the workspace hides it with
   * `hidden` so the terminal keeps its xterm instance — and an unselected
   * subscription re-renders on *any* store write. The gesture surface writes
   * `fontSize` up to twenty times a second during a pinch, so the whole
   * settings tree, terminal theme swatches and all, was re-rendering every
   * frame of a gesture happening on a different screen.
   */
  const fontSize = useTerminalStore((s) => s.fontSize);
  const setFontSize = useTerminalStore((s) => s.setFontSize);
  const cursorStyle = useTerminalStore((s) => s.cursorStyle);
  const setCursorStyle = useTerminalStore((s) => s.setCursorStyle);
  const cursorBlink = useTerminalStore((s) => s.cursorBlink);
  const setCursorBlink = useTerminalStore((s) => s.setCursorBlink);
  const gpuRendering = useTerminalStore((s) => s.gpuRendering);
  const setGpuRendering = useTerminalStore((s) => s.setGpuRendering);
  const scrollback = useTerminalStore((s) => s.scrollback);
  const setScrollback = useTerminalStore((s) => s.setScrollback);
  const themeName = useTerminalStore((s) => s.themeName);
  const setThemeName = useTerminalStore((s) => s.setThemeName);

  const toolbarKeys = useSettingsStore((s) => s.toolbarKeys);
  const toggleToolbarKey = useSettingsStore((s) => s.toggleToolbarKey);
  const resetToolbarKeys = useSettingsStore((s) => s.resetToolbarKeys);
  const gestures = useSettingsStore((s) => s.gestures);
  const setGesture = useSettingsStore((s) => s.setGesture);
  const autoZoom = useSettingsStore((s) => s.autoZoom);
  const setAutoZoom = useSettingsStore((s) => s.setAutoZoom);
  const hapticEnabled = useSettingsStore((s) => s.hapticEnabled);
  const setHapticEnabled = useSettingsStore((s) => s.setHapticEnabled);

  return (
    <ScrollArea className={cn("h-full", className)}>
      <div className="space-y-6 p-4">
        {/* #12: Appearance / Theme toggle */}
        <section>
          <h3 className="text-sm font-semibold mb-3">Appearance</h3>
          <div className="flex items-center justify-between">
            <Label className="text-xs">Theme</Label>
            <ThemeToggle />
          </div>
        </section>

        <Separator />

        {/* Terminal Settings */}
        <section>
          <h3 className="text-sm font-semibold mb-3">Terminal</h3>
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <Label className="text-xs" id="setting-font-size">
                Font Size
              </Label>
              {/* The two buttons are one control, and the number between them
                  is its value — without the group a screen reader reads three
                  unrelated things, none of them called "font size". */}
              <div
                className="flex items-center gap-2"
                role="group"
                aria-labelledby="setting-font-size"
              >
                <button
                  className={cn("h-11 w-11 rounded border text-sm", focusRing)}
                  aria-label="Decrease font size"
                  onClick={() => setFontSize(Math.max(8, fontSize - 1))}
                >
                  -
                </button>
                <span className="w-8 text-center text-sm">{fontSize}</span>
                <button
                  className={cn("h-11 w-11 rounded border text-sm", focusRing)}
                  aria-label="Increase font size"
                  onClick={() => setFontSize(Math.min(24, fontSize + 1))}
                >
                  +
                </button>
              </div>
            </div>
            <div className="space-y-1">
              <Label className="text-xs" id="setting-cursor-style">
                Cursor Style
              </Label>
              <div
                className="flex gap-1"
                role="group"
                aria-labelledby="setting-cursor-style"
              >
                {(["block", "underline", "bar"] as const).map((style) => (
                  <button
                    key={style}
                    className={cn(
                      "min-h-11 rounded-md border px-3 py-1 text-xs capitalize transition-colors",
                      focusRing,
                      cursorStyle === style
                        ? "border-primary bg-primary/10"
                        : "hover:bg-accent",
                    )}
                    aria-pressed={cursorStyle === style}
                    onClick={() => setCursorStyle(style)}
                  >
                    {style}
                  </button>
                ))}
              </div>
            </div>
            {/* Every Switch below takes its name from the Label beside it via
                `aria-labelledby`, not `htmlFor`: Radix renders a <button>, and
                a <label for> only binds to labelable elements — so the markup
                looked correct and announced "switch, on" with no name at all. */}
            <div className="flex items-center justify-between">
              <Label className="text-xs" id="setting-cursor-blink">
                Cursor Blink
              </Label>
              <Switch
                aria-labelledby="setting-cursor-blink"
                checked={cursorBlink}
                onCheckedChange={(checked) => setCursorBlink(checked)}
              />
            </div>
            <div className="flex items-center justify-between">
              <div>
                <Label className="text-xs" id="setting-auto-zoom">
                  Auto-zoom Panes
                </Label>
                <p
                  className="text-[10px] text-muted-foreground"
                  id="setting-auto-zoom-hint"
                >
                  Auto-zoom into active pane on attach and split (mobile only)
                </p>
              </div>
              <Switch
                aria-labelledby="setting-auto-zoom"
                aria-describedby="setting-auto-zoom-hint"
                checked={autoZoom}
                onCheckedChange={(checked) => setAutoZoom(checked)}
              />
            </div>
            <div className="flex items-center justify-between">
              <div>
                <Label className="text-xs" id="setting-gpu">
                  GPU Rendering
                </Label>
                <p
                  className="text-[10px] text-muted-foreground"
                  id="setting-gpu-hint"
                >
                  Turn off if only part of each line is visible. Applies after
                  reload.
                </p>
              </div>
              <Switch
                aria-labelledby="setting-gpu"
                aria-describedby="setting-gpu-hint"
                checked={gpuRendering}
                onCheckedChange={(checked) => setGpuRendering(checked)}
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs" htmlFor="setting-scrollback">
                Scrollback Lines
              </Label>
              <Input
                id="setting-scrollback"
                type="number"
                value={scrollback}
                onChange={(e) => setScrollback(Number(e.target.value))}
                onBlur={(e) => {
                  const v = Math.max(
                    100,
                    Math.min(50000, Number(e.target.value) || 1000),
                  );
                  setScrollback(v);
                }}
                className="h-8 text-sm"
                min={100}
                max={50000}
                step={500}
              />
            </div>
          </div>
        </section>

        <Separator />

        {/* Terminal Theme Settings */}
        <section>
          <h3 className="text-sm font-semibold mb-3">Terminal Theme</h3>
          <div className="grid grid-cols-2 gap-2">
            {Object.entries(terminalThemes).map(([key, theme]) => (
              <button
                key={key}
                className={cn(
                  "rounded-lg border p-2 transition-colors text-left",
                  focusRing,
                  themeName === key
                    ? "border-primary ring-1 ring-primary"
                    : "hover:border-foreground/30",
                )}
                aria-pressed={themeName === key}
                onClick={() => setThemeName(key)}
              >
                <div
                  className="mb-1.5 rounded-md px-2 py-1 font-mono text-[10px]"
                  style={{
                    backgroundColor: theme.background,
                    color: theme.foreground,
                  }}
                >
                  <span style={{ color: theme.green }}>$</span>{" "}
                  <span style={{ color: theme.cyan }}>hello</span>
                </div>
                <span className="text-xs">{theme.name}</span>
              </button>
            ))}
          </div>
        </section>

        <Separator />

        {/* Keyboard Toolbar */}
        <section>
          <div className="mb-1 flex items-center justify-between">
            <h3 className="text-sm font-semibold">Keyboard Toolbar</h3>
            <Button
              variant="ghost"
              size="sm"
              className="h-8 text-xs"
              onClick={() => resetToolbarKeys()}
            >
              Reset
            </Button>
          </div>
          {/* Grouped, because one flat wrap of forty chips is a wall. The
              agent keys are first: they are the ones people come here for. */}
          <p className="mb-3 text-[10px] text-muted-foreground">
            Which keys sit in the row above the keyboard. The rest are still one
            tap away, under ⋯ in that row.
          </p>
          <div className="space-y-4">
            {(
              ["agent", "core", "edit", "nav", "symbol"] as ToolbarKeyGroup[]
            ).map((group) => {
              const keys = toolbarKeys.filter((k) => k.group === group);
              if (keys.length === 0) return null;
              return (
                <div key={group}>
                  <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">
                    {GROUP_LABELS[group]}
                  </Label>
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    {keys.map((key) => (
                      <button
                        key={key.id}
                        className={cn(
                          "min-h-11 rounded-md border px-2.5 py-1 text-xs transition-colors",
                          focusRing,
                          key.visible
                            ? "border-primary bg-primary/10"
                            : "opacity-50",
                        )}
                        aria-pressed={key.visible}
                        aria-label={
                          key.hint ? `${key.label} — ${key.hint}` : key.label
                        }
                        title={key.hint}
                        onClick={() => toggleToolbarKey(key.id)}
                      >
                        {key.label}
                      </button>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        <Separator />

        {/* Gestures — #11: Switch replaces manual toggles */}
        <section>
          <h3 className="text-sm font-semibold mb-3">Gestures</h3>
          {/* Only gestures the reducer actually reads. "Double-tap to copy"
              and "Long-press context menu" used to sit here, defaulted on and
              wired to nothing — see GestureSettings in the store. */}
          <div className="space-y-2">
            {(
              [
                ["swipeToSwitchSessions", "Swipe to switch sessions"],
                ["swipeToSwitchPanes", "Swipe to switch panes"],
                ["dragToScroll", "Drag to scroll history"],
                ["pinchToZoom", "Pinch to zoom"],
              ] as const
            ).map(([key, label]) => (
              <div key={key} className="flex items-center justify-between">
                <Label className="text-xs" id={`setting-gesture-${key}`}>
                  {label}
                </Label>
                <Switch
                  aria-labelledby={`setting-gesture-${key}`}
                  checked={gestures[key]}
                  onCheckedChange={(checked) => setGesture(key, checked)}
                />
              </div>
            ))}
          </div>
        </section>

        <Separator />

        {/* Haptics — #11: Switch replaces manual toggle */}
        <section>
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-sm font-semibold" id="setting-haptics">
                Haptic Feedback
              </h3>
              <p
                className="text-xs text-muted-foreground"
                id="setting-haptics-hint"
              >
                Vibrate on key press
              </p>
            </div>
            <Switch
              aria-labelledby="setting-haptics"
              aria-describedby="setting-haptics-hint"
              checked={hapticEnabled}
              onCheckedChange={(checked) => setHapticEnabled(checked)}
            />
          </div>
        </section>

        <Separator />

        <LockSettings />

        {/* Renders nothing when the browser has no install path, so the
            separator has to come with it rather than sit above it. */}
        <InstallAppSection />

        {/* On a phone this panel *is* the settings page — the desktop header
            with its dashboard link is hidden below 768px — so without this
            section the terminal and the account are two islands with no bridge
            on the device most people use.

            `AccountNudge` owns the signed-in/signed-out split; this used to
            show "Your machines" to everyone and bounce anonymous pairers to
            /signin with no explanation. It renders null on a self-hosted build
            and when it has nothing to say, hence the separator moving inside. */}
        {isHostedBuild && (
          <>
            <Separator />
            <AccountNudge />
          </>
        )}
      </div>
    </ScrollArea>
  );
}
