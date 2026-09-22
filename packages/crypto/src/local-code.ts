import { randomBytes } from "./bytes";

/**
 * The digits `mtmux start` prints when there is no broker in the picture.
 *
 *     4 8 3   9 2 1
 *     └──────┬──────┘
 *        all secret
 *
 * ## Why a second code format exists
 *
 * A broker code (`pairing-code.ts`) is `slot(3) + secret(6)`, and the split is
 * there so a *third party* can route a claim without learning the password.
 * Local pairing has no third party: the browser talks to the machine directly,
 * over the LAN or over loopback. There is nothing to route to, so a routing
 * half would be six digits of ceremony that buy nothing and cost the reader
 * three of them.
 *
 * So this form is all secret, and shorter — because the thing it is protected
 * by is not its own entropy.
 *
 * ## Six digits, and what actually guards them
 *
 * A million is not a big number. On its own this would be a bad credential,
 * and it is not meant to be one on its own. Three things stand in front of it,
 * and the code is only the first:
 *
 *  1. **You have to be on the network already.** There is no route to this
 *     endpoint from the internet — that is what invariant #4 means. The
 *     guesser has to be on your wifi.
 *  2. **The code buys a handful of guesses, ever.** `pairing-local.ts` burns
 *     the code after a few wrong ones and the terminal prints a fresh one. A
 *     million-guess search needs the code to survive a million guesses; it
 *     does not survive five.
 *  3. **A correct guess still has to be let in by a human.** Redemption raises
 *     the same approval question as every other path, on the machine itself.
 *     Knowing the code is not consent, which is the whole argument
 *     `access-prompt.ts` makes about the nine-digit one.
 *
 * Six digits are what makes the thing typeable by someone holding a phone in
 * the other hand. The bound is enforced elsewhere on purpose: a longer code
 * would make the *first* line of defence look stronger while changing nothing
 * about the two that are actually doing the work.
 *
 * ## It cannot be confused with a broker code
 *
 * Six digits against nine, and `parseCode` in `pairing-code.ts` rejects
 * anything that is not exactly 9 or 26 characters. One field can therefore
 * take both and tell them apart by length alone, which is what
 * `connect-panel.tsx` does — no mode switch, no second box, no "which kind of
 * code is this?" for someone who has never been told there are two kinds.
 */

export const LOCAL_CODE_DIGITS = 6;

const LOCAL_CODE_RE = new RegExp(`^\\d{${LOCAL_CODE_DIGITS}}$`);

/**
 * Uniform digits from the CSPRNG.
 *
 * Rejection-sampled for the same reason `uniformBelow` is in
 * `pairing-code.ts`: `% 10` over a byte is biased towards 0–5, and a bias in a
 * code with a five-guess budget is a bias in exactly the quantity that budget
 * is sized against.
 */
export function generateLocalCode(): string {
  let out = "";
  while (out.length < LOCAL_CODE_DIGITS) {
    for (const byte of randomBytes(LOCAL_CODE_DIGITS)) {
      if (byte >= 250) continue; // 250 = floor(256/10)*10
      out += String(byte % 10);
      if (out.length === LOCAL_CODE_DIGITS) break;
    }
  }
  return out;
}

/** Strip what a human typed down to six digits, or null. */
export function normalizeLocalCode(input: string): string | null {
  const digits = input.replace(/[\s-]/g, "");
  return LOCAL_CODE_RE.test(digits) ? digits : null;
}

export function isLocalCode(input: string): boolean {
  return normalizeLocalCode(input) !== null;
}

/** `483921` → `483 921`, so it survives being read out across a room. */
export function formatLocalCodeForDisplay(code: string): string {
  const digits = normalizeLocalCode(code);
  if (digits === null) throw new Error("Invalid local pairing code");
  return `${digits.slice(0, 3)} ${digits.slice(3)}`;
}
