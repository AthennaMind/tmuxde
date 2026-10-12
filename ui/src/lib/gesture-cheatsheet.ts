import type { GestureSettings } from "@/stores/settings-store";

/**
 * What this app does that nothing on screen says.
 *
 * A phone terminal is mostly gestures, and a gesture has no label. Everything
 * in the toolbar announces itself by being a button; a press, a pinch and a
 * swipe announce themselves only by being tried. The three that matter most —
 * drag to scroll, press for a pane's options, pinch for the font — are all
 * discoverable by accident and none of them is discoverable on purpose, which
 * is the same as saying most people will never find them.
 *
 * So the list is data rather than markup. Two reasons, and the second is the
 * one that earns the file:
 *
 *  - It has to be filtered by the gesture settings. A cheat sheet that teaches
 *    a gesture the user has switched off is worse than no cheat sheet, because
 *    they will try it, it will not work, and they will conclude the whole page
 *    is lying.
 *  - It has to be assertable. The failure mode of a document like this is not
 *    that it renders wrong, it is that it goes quietly out of date — the same
 *    rot that produced two settings switches wired to nothing. A test can hold
 *    this array against the reducer's inputs; it cannot hold JSX against them.
 */
export interface CheatsheetEntry {
  /** The gesture or control, named the way a person would say it. */
  gesture: string;
  /** What it does. One line, present tense, no "you can". */
  effect: string;
  /**
   * The setting that gates it, when one does. Entries with no key are always
   * available — they are not gestures the reducer can be told to ignore.
   */
  setting?: keyof GestureSettings;
}

export interface CheatsheetSection {
  title: string;
  entries: CheatsheetEntry[];
}

const SECTIONS: CheatsheetSection[] = [
  {
    title: "On the terminal",
    entries: [
      {
        gesture: "Press and hold",
        effect: "Options for the pane under your finger — zoom, split, close",
        setting: "longPressPaneMenu",
      },
      {
        gesture: "Drag up or down",
        effect: "Scroll back through this pane's history",
        setting: "dragToScroll",
      },
      {
        gesture: "Flick and release",
        effect: "Keeps scrolling, and slows to a stop",
        setting: "dragToScroll",
      },
      {
        gesture: "Pinch",
        effect: "Font size, from 8 up to 24",
        setting: "pinchToZoom",
      },
      {
        gesture: "Swipe left or right",
        effect: "Step to the next pane, window or session",
        setting: "swipeToSwitchPanes",
      },
      {
        gesture: "Tap",
        effect: "Focus the terminal, and leave copy mode if you were in it",
      },
    ],
  },
  {
    title: "In the bar below",
    entries: [
      {
        gesture: "Copy mode",
        effect: "Grab this pane's text where you can select and copy it",
      },
      { gesture: "Compose", effect: "Write several lines before running them" },
      { gesture: "Swipe the row", effect: "More keys — it scrolls sideways" },
      {
        gesture: "⌃ or ⌥",
        effect: "Latches for the next key in this row only",
      },
      { gesture: "···", effect: "Every key there is. Pin the ones you use" },
    ],
  },
  {
    title: "Elsewhere",
    entries: [
      {
        gesture: "The round button",
        effect: "Sessions, windows and panes, in one sheet",
      },
      {
        gesture: "Hold it",
        effect: "Split this pane without opening the sheet",
      },
      { gesture: "Tap a window tab", effect: "Switch to that window" },
      {
        gesture: "Hold a window tab",
        effect: "Opens that sheet on it — rename and close are in there",
      },
    ],
  },
];

/**
 * The sheet, with anything the user has switched off removed.
 *
 * Sections that empty out are dropped rather than left as a heading over
 * nothing — the same rule the CLI's device panel follows for an empty table.
 */
export function cheatsheetFor(gestures: GestureSettings): CheatsheetSection[] {
  const swipeOn = gestures.swipeToSwitchPanes || gestures.swipeToSwitchSessions;
  return SECTIONS.map((section) => ({
    title: section.title,
    entries: section.entries.filter((entry) => {
      if (entry.setting === "swipeToSwitchPanes") return swipeOn;
      return entry.setting ? gestures[entry.setting] : true;
    }),
  })).filter((section) => section.entries.length > 0);
}
