/**
 * Who this product is, in one place.
 *
 * ## What was here before
 *
 * A module named after the product that called it `ccremote`, pointed at
 * `ccremote.dev`, credited someone else's GitHub repo, and duplicated six
 * colour values as strings. Nothing imported it, which is the only reason none
 * of that had surfaced in the UI.
 *
 * ## What is deliberately not here
 *
 * **Colours.** They were the worst part: a second, stale copy of values that
 * live in `globals.css`, in a format no stylesheet can consume, guaranteed to
 * drift the first time the palette moved — which it since has, twice. The
 * token layer is the single source of colour truth. Anything that needs the
 * brand green uses `text-brand` / `bg-brand-fill`, never a string from here.
 */

export const brand = {
  name: "tmuxde",
  longName: "Tmux Development Environment",
  tagline: "Your tmux on any screen. Nothing leaves your network.",
  description:
    "Self-hosted web terminal for tmux. Drive shells and coding agents from your phone over your private network. No accounts, no telemetry, no update checks.",
  repository: "https://github.com/AthennaMind/tmuxde",
} as const;

export type Brand = typeof brand;
