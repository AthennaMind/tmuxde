import { useEffect, useState } from "react";
import { Check, Monitor, Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useTheme } from "@/hooks/use-theme";
import { cn } from "@/lib/utils";
import {
  DEFAULT_TERMINAL_THEME,
  getTerminalTheme,
  terminalThemes,
  type ColorScheme,
} from "@/lib/terminal-themes";
import {
  CODE_WEIGHTS,
  CODE_ZOOM_MAX,
  CODE_ZOOM_MIN,
  CODE_ZOOM_STEP,
  clampFontSize,
  useTerminalStore,
  type CodeWeight,
} from "@/stores/terminal-store";
import {
  GROUP_LABELS,
  useSettingsStore,
  type GestureSettings,
  type ToolbarKeyGroup,
} from "@/stores/settings-store";
import { LockSettings } from "@/components/lock/lock-settings";
import { DisconnectSection } from "./disconnect-section";
import { InstallAppSection } from "@/components/pwa/install-app-section";
import { useDictationAvailable } from "@/components/dictation/dictation-button";
import {
  Segmented,
  SettingsRow,
  SettingsSection,
  Stepper,
  SwitchRow,
  settingsFocus,
  settingsLabelFocus,
  type RowIds,
} from "./settings-rows";

const WEIGHT_LABELS: Record<CodeWeight, string> = {
  400: "Regular",
  500: "Medium",
  600: "Semibold",
  700: "Bold",
};

/** Each option draws the cursor it picks, in the label's color. */
const CURSOR_OPTIONS = [
  { value: "block", label: "Block", mark: "h-3.5 w-2" },
  { value: "underline", label: "Underline", mark: "h-0.5 w-2 self-end" },
  { value: "bar", label: "Bar", mark: "h-3.5 w-0.5" },
] as const;

/** Agent keys first. They are the ones people come here for. */
const KEY_GROUPS: ToolbarKeyGroup[] = ["agent", "core", "edit", "nav", "symbol"];

/** Only gestures the touch reducer reads. */
const GESTURES: [keyof GestureSettings, string][] = [
  ["swipeToSwitchSessions", "Swipe to switch sessions"],
  ["swipeToSwitchPanes", "Swipe to switch panes"],
  ["dragToScroll", "Drag to scroll history"],
  ["pinchToZoom", "Pinch to zoom"],
  ["longPressPaneMenu", "Long press a pane for options"],
];

/**
 * Every setting, as one page.
 *
 * Desktop shows it as a main-area tab, the phone as its Settings tab. Touch
 * adds the keyboard toolbar, gestures, haptics and auto zoom. Pointer adds
 * GPU rendering, the one renderer choice that only exists there.
 *
 * Sections read their stores field by field. The phone keeps this page
 * mounted while hidden, and a pinch writes `fontSize` many times a second.
 * Only the section showing font size should render for it.
 */
export function SettingsPanel({
  touch = true,
  className,
}: {
  touch?: boolean;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "@container overflow-y-auto overscroll-contain bg-background",
        className,
      )}
    >
      <div className="mx-auto w-full max-w-2xl space-y-10 px-4 pt-6 pb-16 @lg:px-8 @lg:pt-10">
        <header className="space-y-1">
          <h1 className="text-xl font-semibold text-foreground text-balance">
            Settings
          </h1>
          <p className="text-[13px] leading-5 text-muted-foreground">
            Saved in this browser only.
          </p>
        </header>
        <AppearanceSection />
        <TextSection touch={touch} />
        <TerminalSection touch={touch} />
        <SessionsSection />
        <MicrophoneSection />
        {touch && <KeyboardToolbarSection />}
        {touch && <TouchSection />}
        <LockSettings />
        <DisconnectSection />
        <InstallAppSection />
      </div>
    </div>
  );
}

function MicrophoneSection() {
  const available = useDictationAvailable();
  if (!available) return null;
  return (
    <SettingsSection title="Microphone" description="Audio is captured only while dictation is running.">
      <details className="text-sm">
        <summary className={cn("min-h-11 cursor-pointer rounded-md py-3 font-medium", settingsFocus)}>
          Remember microphone access
        </summary>
        <div className="space-y-3 pt-2 text-muted-foreground">
          <p>Browser controls permission for each site and device. To avoid repeated prompts, choose Allow for this site.</p>
          <p>iPhone Safari: Page Menu &gt; Website Settings &gt; Microphone &gt; Allow.</p>
          <p>Mac Safari: Settings &gt; Websites &gt; Microphone &gt; Allow.</p>
          <p>Chrome: site controls beside address bar &gt; Site settings &gt; Microphone &gt; Allow.</p>
          <p>Permission is reused between recordings while app stays open. Microphone stays muted between recordings and is released when app hides, locks, or disconnects.</p>
        </div>
      </details>
    </SettingsSection>
  );
}

function AppearanceSection() {
  const { theme, resolvedTheme, setTheme } = useTheme();
  const themeName = useTerminalStore((s) => s.themeName);
  const setThemeName = useTerminalStore((s) => s.setThemeName);

  return (
    <SettingsSection title="Appearance">
      <SettingsRow label="App theme" hint="System follows your device." textLabel>
        {(ids) => (
          <Segmented
            ids={ids}
            value={theme}
            onChange={setTheme}
            options={[
              { value: "light", label: "Light", icon: <Sun className="h-3.5 w-3.5" aria-hidden /> },
              { value: "dark", label: "Dark", icon: <Moon className="h-3.5 w-3.5" aria-hidden /> },
              { value: "system", label: "System", icon: <Monitor className="h-3.5 w-3.5" aria-hidden /> },
            ]}
          />
        )}
      </SettingsRow>
      <SettingsRow label="Terminal theme" stacked textLabel>
        {(ids) => (
          <ThemeGrid
            ids={ids}
            value={themeName}
            onChange={setThemeName}
            scheme={resolvedTheme === "light" ? "light" : "dark"}
          />
        )}
      </SettingsRow>
    </SettingsSection>
  );
}

/** Terminal color schemes as native radios, each card a small preview. */
function ThemeGrid({
  ids,
  value,
  onChange,
  scheme,
}: {
  ids: RowIds;
  value: string;
  onChange: (name: string) => void;
  scheme: ColorScheme;
}) {
  const options = [
    // Follows App theme above, the way System follows the device. Previews
    // whichever tmuxde palette is showing now.
    {
      key: DEFAULT_TERMINAL_THEME,
      name: "Match app",
      theme: getTerminalTheme(DEFAULT_TERMINAL_THEME, scheme),
    },
    ...Object.entries(terminalThemes).map(([key, theme]) => ({
      key,
      name: theme.name,
      theme,
    })),
  ];
  return (
    <div
      role="radiogroup"
      aria-labelledby={ids.labelId}
      className="grid grid-cols-[repeat(auto-fill,minmax(9rem,1fr))] gap-2"
    >
      {options.map(({ key, name, theme }) => (
        <label
          key={key}
          className={cn(
            "group cursor-pointer rounded-lg border bg-card p-1 transition-colors hover:border-line-strong",
            "has-[:checked]:border-primary has-[:checked]:ring-1 has-[:checked]:ring-primary",
            settingsLabelFocus,
          )}
        >
          <input
            type="radio"
            name={ids.controlId}
            value={key}
            checked={value === key}
            onChange={() => onChange(key)}
            className="sr-only"
          />
          {/* 4px inside a 10px card, so the preview takes 6px. */}
          <div
            aria-hidden
            className="space-y-1.5 rounded-[6px] px-2.5 py-2 font-mono text-xs leading-4"
            style={{ backgroundColor: theme.background, color: theme.foreground }}
          >
            <div className="truncate">
              <span style={{ color: theme.green }}>~</span>{" "}
              <span style={{ color: theme.blue }}>git</span> status
            </div>
            <div className="flex gap-1">
              {[
                theme.red,
                theme.yellow,
                theme.green,
                theme.cyan,
                theme.blue,
                theme.magenta,
              ].map((color, index) => (
                <span
                  key={index}
                  className="h-2 w-2 rounded-full"
                  style={{ backgroundColor: color }}
                />
              ))}
            </div>
          </div>
          <div className="flex items-center justify-between gap-2 px-1.5 pt-1.5 pb-0.5">
            <span className="text-[13px] leading-5 text-foreground">
              {name}
            </span>
            <Check
              aria-hidden
              className="h-3.5 w-3.5 shrink-0 text-primary opacity-0 group-has-[:checked]:opacity-100"
            />
          </div>
        </label>
      ))}
    </div>
  );
}

function TextSection({ touch }: { touch: boolean }) {
  const fontSize = useTerminalStore((s) => s.fontSize);
  const setFontSize = useTerminalStore((s) => s.setFontSize);
  const terminalWeight = useTerminalStore((s) => s.terminalWeight);
  const setTerminalWeight = useTerminalStore((s) => s.setTerminalWeight);
  const codeWeight = useTerminalStore((s) => s.codeWeight);
  const setCodeWeight = useTerminalStore((s) => s.setCodeWeight);
  const codeZoom = useTerminalStore((s) => s.codeZoom);
  const setCodeZoom = useTerminalStore((s) => s.setCodeZoom);

  return (
    <SettingsSection title="Text">
      <SettingsRow
        label="Terminal font size"
        hint={touch ? undefined : "Ctrl with + or - also works in the terminal."}
        textLabel
      >
        {(ids) => (
          <Stepper
            ids={ids}
            noun="terminal font size"
            value={fontSize}
            display={`${fontSize}px`}
            min={8}
            // The cap depends on the window. See `clampFontSize`.
            max={clampFontSize(Number.MAX_SAFE_INTEGER)}
            onChange={setFontSize}
          />
        )}
      </SettingsRow>
      <SettingsRow
        label="Terminal font weight"
        hint="At Bold, bold output looks like the rest."
        textLabel
      >
        {(ids) => (
          <WeightPicker
            ids={ids}
            value={terminalWeight}
            onChange={setTerminalWeight}
          />
        )}
      </SettingsRow>
      <SettingsRow
        label="File and diff text size"
        hint={
          touch
            ? "Files, diffs and the editor."
            : "Ctrl with + or - also works in a file or diff."
        }
        textLabel
      >
        {(ids) => (
          <Stepper
            ids={ids}
            noun="file and diff text size"
            value={codeZoom}
            display={`${Math.round(codeZoom * 100)}%`}
            min={CODE_ZOOM_MIN}
            max={CODE_ZOOM_MAX}
            step={CODE_ZOOM_STEP}
            onChange={setCodeZoom}
          />
        )}
      </SettingsRow>
      <SettingsRow
        label="File and diff text weight"
        hint="Files, diffs and the editor."
        textLabel
      >
        {(ids) => (
          <WeightPicker ids={ids} value={codeWeight} onChange={setCodeWeight} />
        )}
      </SettingsRow>
    </SettingsSection>
  );
}

function WeightPicker({
  ids,
  value,
  onChange,
}: {
  ids: RowIds;
  value: CodeWeight;
  onChange: (weight: CodeWeight) => void;
}) {
  return (
    <Segmented
      ids={ids}
      value={value}
      onChange={onChange}
      options={CODE_WEIGHTS.map((weight) => ({
        value: weight,
        label: WEIGHT_LABELS[weight],
        // Each label previews its own weight in the code face.
        className: "font-mono",
        style: { fontWeight: weight },
      }))}
    />
  );
}

function TerminalSection({ touch }: { touch: boolean }) {
  const cursorStyle = useTerminalStore((s) => s.cursorStyle);
  const setCursorStyle = useTerminalStore((s) => s.setCursorStyle);
  const cursorBlink = useTerminalStore((s) => s.cursorBlink);
  const setCursorBlink = useTerminalStore((s) => s.setCursorBlink);
  const copyOnSelect = useTerminalStore((s) => s.copyOnSelect);
  const setCopyOnSelect = useTerminalStore((s) => s.setCopyOnSelect);
  const gpuRendering = useTerminalStore((s) => s.gpuRendering);
  const setGpuRendering = useTerminalStore((s) => s.setGpuRendering);

  return (
    <SettingsSection title="Terminal">
      <SettingsRow label="Cursor" textLabel>
        {(ids) => (
          <Segmented
            ids={ids}
            value={cursorStyle}
            onChange={setCursorStyle}
            options={CURSOR_OPTIONS.map((option) => ({
              value: option.value,
              label: option.label,
              icon: (
                <span aria-hidden className="flex h-3.5 w-2 justify-center">
                  <span className={cn("rounded-[1px] bg-current", option.mark)} />
                </span>
              ),
            }))}
          />
        )}
      </SettingsRow>
      <SwitchRow
        label="Blink the cursor"
        checked={cursorBlink}
        onChange={setCursorBlink}
      />
      <SwitchRow
        label="Copy on select"
        hint="Copy selected terminal text, including copies from tmux and terminal apps."
        checked={copyOnSelect}
        onChange={setCopyOnSelect}
      />
      <SettingsRow
        label="Scrollback lines"
        hint="How far back you can scroll. 100 to 50,000."
      >
        {(ids) => <ScrollbackInput ids={ids} />}
      </SettingsRow>
      {!touch && (
        <SwitchRow
          label="GPU rendering"
          hint="Faster with heavy output. Text looks softer. Applies after reload."
          checked={gpuRendering}
          onChange={setGpuRendering}
        />
      )}
    </SettingsSection>
  );
}

/**
 * Pane grids: the Sessions panel or tab, the overview and the phone's pane
 * sheet. Every one of them reads this switch.
 */
function SessionsSection() {
  const showPaneIndexes = useSettingsStore((s) => s.showPaneIndexes);
  const setShowPaneIndexes = useSettingsStore((s) => s.setShowPaneIndexes);

  return (
    <SettingsSection title="Sessions">
      <SwitchRow
        label="Show pane indexes"
        hint="The number tmux gives each pane, in the corner of its box."
        checked={showPaneIndexes}
        onChange={setShowPaneIndexes}
      />
    </SettingsSection>
  );
}

/** Commits on blur or Enter, so typing 10000 never passes through 1. */
function ScrollbackInput({ ids }: { ids: RowIds }) {
  const scrollback = useTerminalStore((s) => s.scrollback);
  const setScrollback = useTerminalStore((s) => s.setScrollback);
  const [draft, setDraft] = useState(String(scrollback));
  useEffect(() => setDraft(String(scrollback)), [scrollback]);

  const commit = () => {
    const lines = Math.max(
      100,
      Math.min(50000, Math.round(Number(draft)) || 1000),
    );
    setScrollback(lines);
    setDraft(String(lines));
  };

  return (
    <Input
      id={ids.controlId}
      aria-describedby={ids.hintId}
      type="number"
      inputMode="numeric"
      min={100}
      max={50000}
      step={500}
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") commit();
      }}
      className="h-8 w-28 text-end tabular-nums pointer-coarse:h-11"
    />
  );
}

function KeyboardToolbarSection() {
  const toolbarKeys = useSettingsStore((s) => s.toolbarKeys);
  const toggleToolbarKey = useSettingsStore((s) => s.toggleToolbarKey);
  const resetToolbarKeys = useSettingsStore((s) => s.resetToolbarKeys);

  return (
    <SettingsSection
      title="Pinned terminal keys"
      description="Choose keys shown in Controls > Keys > Pinned keys. Esc, Tab, Ctrl, Alt, and arrows stay beside terminal."
      action={
        <Button
          variant="ghost"
          size="sm"
          className="shrink-0 pointer-coarse:h-11"
          onClick={() => resetToolbarKeys()}
        >
          Reset keys
        </Button>
      }
    >
      {KEY_GROUPS.map((group) => {
        const keys = toolbarKeys.filter((k) => k.group === group && k.group !== "core");
        if (keys.length === 0) return null;
        return (
          <SettingsRow key={group} label={GROUP_LABELS[group]} stacked textLabel>
            {(ids) => (
              <div
                role="group"
                aria-labelledby={ids.labelId}
                className="flex flex-wrap gap-1.5"
              >
                {keys.map((key) => (
                  <button
                    key={key.id}
                    type="button"
                    aria-pressed={key.visible}
                    aria-label={key.hint ? `${key.label}, ${key.hint}` : undefined}
                    title={key.hint}
                    onClick={() => toggleToolbarKey(key.id)}
                    className={cn(
                      "min-h-9 rounded-md border px-2.5 text-[13px] transition-colors pointer-coarse:min-h-11",
                      settingsFocus,
                      // Solid when shown, dashed when hidden. Not color alone.
                      key.visible
                        ? "border-primary bg-primary/10 text-foreground"
                        : "border-dashed border-line-strong text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {key.label}
                  </button>
                ))}
              </div>
            )}
          </SettingsRow>
        );
      })}
    </SettingsSection>
  );
}

function TouchSection() {
  const gestures = useSettingsStore((s) => s.gestures);
  const setGesture = useSettingsStore((s) => s.setGesture);
  const autoZoom = useSettingsStore((s) => s.autoZoom);
  const setAutoZoom = useSettingsStore((s) => s.setAutoZoom);
  const hapticEnabled = useSettingsStore((s) => s.hapticEnabled);
  const setHapticEnabled = useSettingsStore((s) => s.setHapticEnabled);

  return (
    <SettingsSection title="Touch">
      {GESTURES.map(([key, label]) => (
        <SwitchRow
          key={key}
          label={label}
          checked={gestures[key]}
          onChange={(checked) => setGesture(key, checked)}
        />
      ))}
      <SwitchRow
        label="Zoom the active pane"
        hint="When you open a session or split a pane."
        checked={autoZoom}
        onChange={setAutoZoom}
      />
      <SwitchRow
        label="Vibrate on key press"
        checked={hapticEnabled}
        onChange={setHapticEnabled}
      />
    </SettingsSection>
  );
}
