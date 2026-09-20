/**
 * A user agent, said the way a person would say it.
 *
 * ## Why this exists rather than a dependency
 *
 * The panel has one question to answer about an unnamed connection: *what is
 * that*. "Safari on iPhone" answers it. A full UA database answers it in more
 * cases and costs a megabyte and a monthly update to do so, for a string the
 * browser is free to lie about anyway. So this is a short table of the browsers
 * and platforms a terminal client actually turns up in, and it is honest about
 * missing: an agent it does not recognise returns null, and the caller falls
 * back to "A device" rather than to a confident wrong answer.
 *
 * ## The ordering is the whole implementation
 *
 * Every browser lies in the same direction. Chrome's UA contains "Safari",
 * Edge's contains "Chrome" *and* "Safari", Opera's contains all three, and
 * every one of them says "Mozilla/5.0". The only thing that makes this work is
 * testing the most specific claim first, so the list below is ordered by how
 * much each name is impersonated and must stay that way.
 */

const BROWSERS: [name: string, needle: RegExp][] = [
  // Before Chrome: these all carry "Chrome" in their own UA.
  ["Edge", /\bEdg[A-Z]?\//],
  ["Opera", /\bOPR\//],
  ["Samsung Internet", /\bSamsungBrowser\//],
  ["Vivaldi", /\bVivaldi\//],
  ["Brave", /\bBrave\//],
  // Before Safari: Chrome carries "Safari", and so does every engine above.
  ["Chrome", /\b(?:CriOS|Chrome|Chromium)\//],
  ["Firefox", /\b(?:FxiOS|Firefox)\//],
  ["Safari", /\bSafari\//],
];

const PLATFORMS: [name: string, needle: RegExp][] = [
  // iPad before Mac: iPadOS reports "Macintosh" in desktop-site mode, and the
  // giveaway is the touch claim it cannot help also sending.
  ["iPhone", /\biPhone\b/],
  ["iPad", /\biPad\b/],
  ["Android", /\bAndroid\b/],
  ["Windows", /\bWindows NT\b/],
  ["Linux", /\b(?:Linux|X11)\b/],
  ["Mac", /\b(?:Macintosh|Mac OS X)\b/],
];

/**
 * "Safari on iPhone", "Chrome", "Android", or null.
 *
 * Returns whichever halves it is sure of. A browser with no recognised
 * platform is still worth saying, and so is a platform with no recognised
 * browser — a curl or a bespoke client is a thing the reader wants to know
 * about, not a thing to round down to nothing.
 */
export function describeUserAgent(
  ua: string | null | undefined,
): string | null {
  if (!ua) return null;
  const browser = BROWSERS.find(([, re]) => re.test(ua))?.[0] ?? null;
  const platform = PLATFORMS.find(([, re]) => re.test(ua))?.[0] ?? null;
  if (browser && platform) return `${browser} on ${platform}`;
  return browser ?? platform;
}
