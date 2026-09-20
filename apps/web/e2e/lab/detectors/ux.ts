import { findingId, type Detector, type Finding } from "./types";

/**
 * Whether the interface explains itself.
 *
 * ## Why this is testable at all
 *
 * "Intuitive" is not directly measurable, and a detector that claimed to
 * measure it would be inventing numbers. What *is* measurable is the set of
 * concrete properties that make an interface legible, each of which fails in a
 * way a user reports as confusion rather than as a bug:
 *
 *  - **An unlabelled control.** An icon-only button with no accessible name is
 *    a guess for a sighted user and silence for a screen reader. Windows,
 *    panes and sessions in this app are largely icon-driven chrome, which is
 *    exactly where this bites.
 *  - **Invisible state.** A tab strip where nothing is marked current, or a
 *    toggle with no pressed state, means the answer to "where am I?" is "look
 *    at the terminal and guess" — and a tmux redraw after a switch can look
 *    identical to the screen before it. That is why `ui-store.switchHint`
 *    exists at all.
 *  - **Unreachable state.** A control that is disabled with no explanation is
 *    a dead end; the user cannot tell whether it is broken, not ready, or not
 *    for them.
 *  - **Untargetable text.** Text below ~11px on a phone is not read, it is
 *    squinted at.
 *  - **Truncation with no recourse.** A session name clipped to "my-long-…"
 *    with no title and no accessible name cannot be disambiguated from its
 *    neighbour, which is the specific failure of having many sessions.
 */
export const ux: Detector = async ({ page, stop, device }) => {
  const result = await page.evaluate(() => {
    const coarse = matchMedia("(pointer: coarse)").matches;

    const visible = (el: Element) => {
      const style = getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden")
        return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };

    const name = (el: Element): string =>
      (
        el.getAttribute("aria-label") ??
        el.getAttribute("title") ??
        el.getAttribute("alt") ??
        el.textContent ??
        ""
      ).trim();

    const describe = (el: Element) => {
      const cls =
        typeof el.className === "string" && el.className
          ? `.${el.className.trim().split(/\s+/).slice(0, 2).join(".")}`
          : "";
      return `${el.tagName.toLowerCase()}${cls}`;
    };

    const unlabelled: string[] = [];
    for (const el of Array.from(
      document.querySelectorAll("button, [role=button], a[href], [role=tab]"),
    )) {
      if (!visible(el)) continue;
      if (name(el)) continue;
      // An `aria-labelledby` pointing at real text is a label too.
      const ref = el.getAttribute("aria-labelledby");
      if (ref && ref.split(/\s+/).some((id) => document.getElementById(id))) {
        continue;
      }
      unlabelled.push(describe(el));
    }

    // A group of tabs with nothing marked current. Reported per group, not per
    // tab: the defect is the group's, and one finding names it.
    const tablistsWithoutCurrent: string[] = [];
    for (const list of Array.from(
      document.querySelectorAll("[role=tablist]"),
    )) {
      if (!visible(list)) continue;
      const tabs = Array.from(list.querySelectorAll("[role=tab]")).filter(
        visible,
      );
      if (tabs.length < 2) continue;
      const marked = tabs.some(
        (t) =>
          t.getAttribute("aria-selected") === "true" ||
          t.getAttribute("data-state") === "active" ||
          t.getAttribute("aria-current") !== null,
      );
      if (!marked) tablistsWithoutCurrent.push(describe(list));
    }

    const unexplainedDisabled: string[] = [];
    for (const el of Array.from(
      document.querySelectorAll(
        "button[disabled], [aria-disabled='true'], input[disabled]",
      ),
    )) {
      if (!visible(el)) continue;
      const explained =
        el.getAttribute("title") ||
        el.getAttribute("aria-describedby") ||
        el.closest("[title]");
      if (!explained) unexplainedDisabled.push(`${describe(el)} "${name(el)}"`);
    }

    const tinyText: { label: string; px: number }[] = [];
    const truncated: string[] = [];
    for (const el of Array.from(document.querySelectorAll<HTMLElement>("*"))) {
      if (!visible(el)) continue;
      const text = (el.textContent ?? "").trim();
      if (!text) continue;
      // Leaf-ish only: a wrapper's textContent is its children's, and reporting
      // both makes every finding appear once per ancestor.
      if (el.children.length > 0) continue;
      const style = getComputedStyle(el);
      const px = parseFloat(style.fontSize);
      /*
       * The floor is a touch floor, so it only applies on a touch device.
       *
       * Dense 10px metadata in a desktop sidebar read at arm's length with a
       * mouse is a legitimate design choice; the same 10px on a phone held at
       * arm's length is not read at all. Applying one number to both produced
       * findings on desktop whose only honest fix would have been to make the
       * desktop UI worse.
       */
      if (coarse && px && px < 11) {
        tinyText.push({ label: text.slice(0, 32), px });
      }

      const clipped =
        el.scrollWidth > el.clientWidth + 1 &&
        (style.textOverflow === "ellipsis" || style.overflow === "hidden");
      /*
       * The recourse may be on an ancestor, and usually is.
       *
       * A session tab puts `title` on the tab and clips a `<span>` inside it;
       * the connection indicator puts `title` and an `sr-only` copy on the
       * wrapper and clips the hostname within. Checking only the clipped node
       * reported both as defects when both already do the right thing — and a
       * detector that cannot be satisfied by the correct fix is worse than no
       * detector, because it trains people to ignore it.
       */
      if (clipped && !el.closest("[title], [aria-label]")) {
        truncated.push(text.slice(0, 32));
      }
    }

    return {
      unlabelled: Array.from(new Set(unlabelled)).slice(0, 10),
      tablistsWithoutCurrent: tablistsWithoutCurrent.slice(0, 5),
      unexplainedDisabled: Array.from(new Set(unexplainedDisabled)).slice(0, 8),
      tinyText: tinyText.slice(0, 8),
      truncated: Array.from(new Set(truncated)).slice(0, 8),
    };
  });

  const findings: Finding[] = [];
  const add = (
    id: string,
    detail: string,
    severity: Finding["severity"] = "minor",
  ) =>
    findings.push({
      id: findingId("ux", id, device),
      severity,
      detector: "ux",
      detail,
      where: `${stop.session}/${stop.state}`,
    });

  for (const el of result.unlabelled) {
    add(
      `unlabelled-${el}`,
      `${el} is an icon-only control with no accessible name — nothing tells ` +
        "anyone what it does, by sight or by screen reader",
      "major",
    );
  }
  for (const list of result.tablistsWithoutCurrent) {
    add(
      `no-current-tab-${list}`,
      `${list} is a tablist with nothing marked selected, so there is no way ` +
        "to tell which window or session is active without reading the terminal",
      "major",
    );
  }
  for (const el of result.unexplainedDisabled) {
    add(
      `unexplained-disabled-${el}`,
      `${el} is disabled with no title or description — the user cannot tell ` +
        "whether it is broken, not ready, or not for them",
    );
  }
  for (const t of result.tinyText) {
    add(
      `tiny-text-${t.label}`,
      `"${t.label}" renders at ${Math.round(t.px * 10) / 10}px, below the 11px ` +
        "floor for text on a touch device",
    );
  }
  for (const t of result.truncated) {
    add(
      `truncated-${t}`,
      `"${t}" is clipped with no title or aria-label, so two similarly named ` +
        "sessions or windows cannot be told apart",
    );
  }

  return findings;
};
