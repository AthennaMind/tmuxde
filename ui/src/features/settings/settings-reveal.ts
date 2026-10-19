/**
 * Scroll to a settings section from elsewhere, such as the shortcuts dialog.
 *
 * Sections carry a data attribute rather than an id: a phone can hold two
 * settings pages at once, one of them hidden.
 */

const SECTION_ATTRIBUTE = "data-settings-section";

export const KEYBOARD_SHORTCUTS_SECTION = "keyboard-shortcuts";

/** Waits two frames for the settings page to render, then scrolls and focuses. */
export function revealSettingsSection(section: string): void {
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      const targets = document.querySelectorAll<HTMLElement>(`[${SECTION_ATTRIBUTE}="${section}"]`);
      const target = [...targets].find((element) => element.getClientRects().length > 0);
      if (!target) return;
      target.scrollIntoView({ block: "start" });
      target.focus({ preventScroll: true });
    }),
  );
}
