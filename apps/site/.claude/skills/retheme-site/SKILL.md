---
name: retheme-site
description: Change the mtmux site's colours, typography or visual theme by editing the design tokens in globals.css. Use this whenever the user wants to change a colour, adjust the palette, tweak contrast, rebrand, change fonts, fix something that looks wrong visually, or asks where a colour is defined. Also use it before adding any new colour to a component — new colours belong in the token file, never inline.
---

# Retheme the site

Every colour on this site is defined in exactly one file: `src/app/globals.css`. Components
reference semantic tokens and never literal values, which is what makes a rebrand a ten-line diff
instead of a two-day find-and-replace.

If you are here because a component needs a colour it does not have, the answer is almost never
"add a hex code to the component" — it is either "use the right existing token" or "add a token".

## How the system is layered

```
Layer 1a  :root                  scheme-independent constants (terminal + term-* syntax)
Layer 1b  :root                  light scheme values
Layer 1c  .dark                  dark scheme values
Layer 2   @theme inline          maps each token to a Tailwind utility
Layer 3   components             use utilities only: bg-surface-raised, text-brand
```

**Both schemes ship.** Every token name is defined in both blocks, so a hand-written component
never needs a `dark:` variant — if a value differs per scheme, change the token, not the markup.
`<html>` is served with `class="dark"`; the pre-paint script in `src/lib/theme.ts` swaps it
before first paint, and `ThemeToggle` cycles system → light → dark.

A subtree that draws a terminal carries **`terminal-scope`**, which remaps the surface/line/text
tokens onto the fixed `--t-*` palette so the illustration stays dark on a light page. Change
`--t-*` (or `term-*`) only if you mean to restyle every terminal on the site.

Contrast is a real constraint on the light side: the acid green that carries dark is ~1.9:1 on
paper, which is why light has its own deeper `--brand`. Check any new colour pair against the
surface it sits on before shipping it.

## Token families

| Family   | Tokens                                                                                                              | Use for                        |
| -------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| Surfaces | `surface-base`, `surface-raised`, `surface-panel`, `surface-sunken`, `surface-inverse`                              | Page and card backgrounds      |
| Lines    | `line-subtle`, `line`, `line-strong`                                                                                | Borders and dividers           |
| Text     | `text-strong`, `text`, `text-muted`, `text-subtle`, `text-faint`, `text-inverse`                                    | Every text colour              |
| Brand    | `brand`, `brand-hover`, `brand-contrast`, `brand-subtle`                                                            | The green, and what sits on it |
| Signals  | `signal-done`, `signal-blocked`, `signal-stalled`, `signal-failed`, `signal-agent` (+ `-surface`)                   | Agent lifecycle states         |
| Terminal | `term-prompt`, `term-path`, `term-value`, `term-comment`, `term-keyword`, `term-flag`, `term-added`, `term-removed` | Hand-authored terminal output  |

`brand-contrast` is the colour that goes _on_ the brand — use it for text on a green button
rather than picking white or black, so a rebrand only has to change one pair.

The signal colours are **generic status colours**, not product vocabulary. They were introduced
for an agent-notification feature that does not exist and has been removed from every page; what
survives is their use as ordinary accents — terminal window chrome, the "untrusted" stage on the
security data path, changelog entry types. Do not reintroduce done/blocked/stalled/failed as
though mtmux emits those states.

## Changing the palette

Edit the `:root` (light) and `.dark` blocks in `src/app/globals.css`. Nothing else — and change
both, or the site is half-rethemed.

Values are OKLCH, which is worth keeping because it makes lightness perceptually uniform — you
can adjust the L channel and get a predictable result instead of re-guessing every shade.

To convert a hex value:

```bash
node -e '
const lin=c=>c<=0.04045?c/12.92:Math.pow((c+0.055)/1.055,2.4);
const hex=process.argv[1].replace("#","");
const [r,g,b]=[0,2,4].map(i=>lin(parseInt(hex.slice(i,i+2),16)/255));
const l=Math.cbrt(0.4122214708*r+0.5363325363*g+0.0514459929*b);
const m=Math.cbrt(0.2119034982*r+0.6806995451*g+0.1073969566*b);
const s=Math.cbrt(0.0883024619*r+0.2817188376*g+0.6299787005*b);
const L=0.2104542553*l+0.7936177850*m-0.0040720468*s;
const A=1.9779984951*l-2.4285922050*m+0.4505937099*s;
const B=0.0259040371*l+0.7827717662*m-0.8086757660*s;
let H=Math.atan2(B,A)*180/Math.PI; if(H<0)H+=360;
console.log(`oklch(${L.toFixed(4)} ${Math.hypot(A,B).toFixed(4)} ${H.toFixed(2)})`);
' "#A6E96B"
```

### A full rebrand

Change `--brand`, `--brand-hover` and `--brand-subtle`, then check `--brand-contrast` still reads
against the new colour. If the new brand is light, `brand-contrast` should be dark and
vice versa — this is the one pairing that breaks silently and shows up as unreadable buttons.

Keep the neutral ramp's hue near the brand's hue. The current surfaces sit around hue 145 with
chroma under 0.008, which reads as a warm, slightly green charcoal rather than dead grey; a brand
change that leaves the neutrals behind makes the whole site look mismatched in a way that is hard
to name.

### Adding a token

Add the raw value to `:root`, then map it in `@theme inline`:

```css
:root {
  --accent-warm: oklch(0.8 0.13 62);
}

@theme inline {
  --color-accent-warm: var(--accent-warm);
}
```

It is then available as `bg-accent-warm`, `text-accent-warm`, `border-accent-warm`. Forgetting the
`@theme inline` mapping is the usual bug — the variable exists but no utility references it.

## Typography

Fonts are CSS variables set by `next/font` in `src/app/[locale]/layout.tsx` and mapped in
`@theme inline`:

- `font-display` — Martian Mono. Headings only; applied globally to `h1`–`h4`.
- `font-sans` — IBM Plex Sans. Body copy and UI.
- `font-mono` — IBM Plex Mono. Code, terminal output, keycaps, eyebrows, metadata.

To swap a face, change the `next/font` import and keep the CSS variable name. `next/font`
self-hosts and preloads, which is what keeps the layout from shifting — do not replace it with a
`<link>` to Google Fonts.

Long-form article styling is driven entirely through the typography plugin's CSS variables, so
blog content inherits the theme with no separate config. See the trap at the end of this file
before moving that block.

## Verify

```bash
pnpm dev
```

Look specifically at:

- text on brand-coloured buttons (the `brand-contrast` pairing)
- `line-subtle` borders, which are easy to lose against an adjacent surface
- code blocks, which take their colours from Shiki via `--shiki-dark`
- the four signal colours, which must stay distinguishable from each other and from the brand

Then guard the invariant:

```bash
grep -rnE '#[0-9a-fA-F]{3,8}\b|oklch\(|(text|bg|border)-(zinc|slate|gray|green|red|blue|amber)-[0-9]' src/components src/app --include=*.tsx
```

That should return nothing. Any hit is a hardcoded colour that will not follow the theme.

## A trap worth knowing

Long-form article styling lives in a `.prose.prose-mtmux` block that is **deliberately outside
any `@layer`**. The Tailwind typography plugin registers `prose` in the `utilities` layer, and
cascade layers outrank specificity — so overrides written inside `@layer components` lose to the
plugin no matter how specific the selector is. That mistake renders the entire blog in the
plugin's default dark-on-light colours, which on this site is near-invisible text. If you
restructure `globals.css`, keep that block unlayered.
