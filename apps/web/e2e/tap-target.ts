import { expect, type Locator } from "@playwright/test";

/**
 * The 44px floor, asserted rather than hoped for.
 *
 * ## Why this is a helper and not a review habit
 *
 * Three of the four controls that were under the floor were the *primary*
 * action on the surface they lived on — "Pair this device" on a phone that has
 * never paired with anything was 36px, and the copy button on the empty state,
 * the very first thing a new user is asked to press, was the same. None of them
 * was noticed, because until this change no dashboard spec had ever run at a
 * phone viewport at all.
 *
 * 44 is Apple's HIG minimum and the number WCAG 2.2's 2.5.8 (Target Size,
 * Minimum) rounds down from at 24 CSS px; 44 is the one that matches what the
 * rest of this app already uses (`h-11`). Height only: width is often
 * legitimately narrower for an icon in a row of icons, and the vertical axis is
 * where a thumb misses.
 */
export const MIN_TAP_PX = 44;

export async function expectTapTarget(locator: Locator, label?: string) {
  const box = await locator.boundingBox();
  expect(box, `${label ?? "control"} is not laid out`).not.toBeNull();
  expect(
    Math.round(box!.height),
    `${label ?? "control"} is ${box!.height}px tall, under the ${MIN_TAP_PX}px floor`,
  ).toBeGreaterThanOrEqual(MIN_TAP_PX);
}
