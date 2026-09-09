import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Every foreground/background pair in the design system, checked against WCAG.
 *
 * ## Why this is a unit test and not a screenshot
 *
 * The tokens are the source of truth, and a contrast failure is a property of
 * two numbers — not of a rendered page. Parsing the CSS and doing the maths
 * catches a bad value the moment somebody edits it, in the fast suite, with a
 * message naming the exact pair. A visual check would catch the same thing
 * later, more slowly, and only on the pages that happen to use it.
 *
 * ## The hazard this exists for
 *
 * The site's brand is `oklch(0.8627 0.1721 132.3)` — L = 0.86. On a white
 * surface that is **1.39:1** as text or a border. The site never hits it
 * because the site is dark-only; the app has a theme toggle, so the port had
 * to define `--brand` twice. This test is what stops someone "simplifying"
 * that back to one value.
 *
 * ## Why "every pair" is now true
 *
 * It was not. The scheme reader took `:root` and `.dark` and stopped there,
 * which skipped the shadcn alias block entirely — and that block is what every
 * shadcn component in `packages/ui` is written against. It held exactly one
 * literal colour, `--destructive-foreground`, and that colour was 2.72:1 on
 * `--destructive` in dark mode for as long as it existed. A test whose
 * docstring promises coverage it does not have is worse than no test, because
 * the promise is what stops anyone looking. The aliases are resolved one level
 * below and asserted per scheme.
 *
 * ## What is known-failing and not asserted
 *
 * - `--border` / `--input` (`--line`) on the surfaces: 1.41:1 light, 1.31:1
 *   dark, against the 3:1 floor WCAG 1.4.11 sets for a control boundary.
 *   Fixing it needs a distinct token for control borders rather than a darker
 *   `--line` for every divider in the app — a design decision, not a bug fix.
 * - The xterm palettes in `terminal-themes.ts`. They are reproductions of
 *   named palettes (Dracula, Solarized, …); "correct" there means faithful to
 *   the original, and several originals fail. Changing them would make the
 *   themes wrong in a different way.
 */

const CSS = readFileSync(
  path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../../packages/ui/src/globals.css",
  ),
  "utf8",
);

type Oklch = { L: number; C: number; h: number };

/** The text of one declaration block, selected by its opening selector. */
function block(selector: string): string {
  const start = CSS.indexOf(selector);
  expect(start, `${selector} block not found`).toBeGreaterThan(-1);
  const open = CSS.indexOf("{", start);
  const close = CSS.indexOf("\n}", open);
  return CSS.slice(open, close);
}

/**
 * Read one scheme's raw token values.
 *
 * Only the literal `oklch(...)` declarations. Aliases live in their own block
 * and are handled by `aliases()` below, which is a deliberate split: the raw
 * tokens flip per scheme, the aliases do not, and conflating the two is how
 * the alias block went unread for as long as it did.
 */
function scheme(selector: string): Record<string, Oklch> {
  const out: Record<string, Oklch> = {};
  const re =
    /(--[\w-]+):\s*oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*(?:\/[^)]*)?\)/g;
  for (const m of block(selector).matchAll(re)) {
    out[m[1]!] = { L: Number(m[2]), C: Number(m[3]), h: Number(m[4]) };
  }
  return out;
}

/**
 * The shadcn alias block: `--x` -> the token it points at.
 *
 * One level of indirection, resolved by hand rather than by reimplementing the
 * cascade — which is all the block uses, and a nested alias is caught below
 * rather than silently followed. A literal `oklch()` here is a token that has
 * opted out of flipping with the scheme; that is legal but almost always a
 * mistake, so it is reported by name.
 */
function aliases(): { refs: Record<string, string>; literals: string[] } {
  const source = block(":root,\n.dark {");
  const refs: Record<string, string> = {};
  for (const m of source.matchAll(/(--[\w-]+):\s*var\(\s*(--[\w-]+)\s*\)/g)) {
    refs[m[1]!] = m[2]!;
  }
  const literals = [...source.matchAll(/(--[\w-]+):\s*oklch\(/g)].map(
    (m) => m[1]!,
  );
  return { refs, literals };
}

/** oklch → linear sRGB. The standard matrix; no gamma, luminance wants linear. */
function linearSrgb({ L, C, h }: Oklch): [number, number, number] {
  const hr = (h * Math.PI) / 180;
  const a = C * Math.cos(hr);
  const b = C * Math.sin(hr);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

function luminance(c: Oklch): number {
  const [r, g, b] = linearSrgb(c).map((v) => Math.min(1, Math.max(0, v)));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

function contrast(fg: Oklch, bg: Oklch): number {
  const a = luminance(fg);
  const b = luminance(bg);
  return a > b ? (a + 0.05) / (b + 0.05) : (b + 0.05) / (a + 0.05);
}

/** True when the colour survives a round trip through sRGB unclipped. */
function inGamut(c: Oklch): boolean {
  return linearSrgb(c).every((v) => v >= -0.001 && v <= 1.001);
}

const SURFACES = [
  "--surface-base",
  "--surface-raised",
  "--surface-panel",
  "--surface-sunken",
] as const;

/**
 * Body text and anything load-bearing needs 4.5:1. `--text-subtle` and
 * `--text-faint` are, by name and by use, secondary and decorative — timestamps,
 * placeholder hints, disabled labels — so they are held to the 3:1 large-text
 * and non-text floor rather than being either over-promised or unchecked.
 */
const AA_NORMAL = 4.5;
const AA_LARGE = 3;

const FOREGROUNDS: [string, number][] = [
  ["--text-strong", AA_NORMAL],
  ["--text", AA_NORMAL],
  ["--text-muted", AA_NORMAL],
  ["--text-subtle", AA_LARGE],
  ["--text-faint", AA_LARGE],
  ["--brand", AA_NORMAL],
  ["--brand-hover", AA_NORMAL],
  ["--signal-done", AA_NORMAL],
  ["--signal-blocked", AA_NORMAL],
  ["--signal-stalled", AA_NORMAL],
  ["--signal-failed", AA_NORMAL],
  ["--signal-agent", AA_NORMAL],
];

describe.each([
  ["light", ":root {"],
  ["dark", ".dark {"],
])("the %s scheme", (name, selector) => {
  const tokens = scheme(selector);

  it("declares every token the other scheme does", () => {
    const other = scheme(name === "light" ? ".dark {" : ":root {");
    // Symmetric difference must be empty. A token defined in one scheme only
    // inherits the other's value, which is how a dark-only colour ends up on a
    // white page.
    expect(Object.keys(tokens).sort()).toEqual(Object.keys(other).sort());
  });

  it.each(SURFACES)("is readable on %s", (surface) => {
    const bg = tokens[surface];
    expect(bg, `${surface} missing from the ${name} scheme`).toBeDefined();

    for (const [fg, need] of FOREGROUNDS) {
      const colour = tokens[fg];
      expect(colour, `${fg} missing from the ${name} scheme`).toBeDefined();
      const ratio = contrast(colour!, bg!);
      expect(
        ratio,
        `${fg} on ${surface} is ${ratio.toFixed(2)}:1, needs ${need}:1`,
      ).toBeGreaterThanOrEqual(need);
    }
  });

  it("puts readable text on every filled brand and signal surface", () => {
    const pairs: [string, string][] = [
      ["--brand-contrast", "--brand"],
      ["--text-inverse", "--surface-inverse"],
    ];
    for (const [fg, bg] of pairs) {
      const ratio = contrast(tokens[fg]!, tokens[bg]!);
      expect(
        ratio,
        `${fg} on ${bg} is ${ratio.toFixed(2)}:1`,
      ).toBeGreaterThanOrEqual(AA_NORMAL);
    }
  });

  /**
   * Each `--x-foreground` on its `--x`, derived from the block itself rather
   * than from a hand-kept list — so a shadcn token added tomorrow is covered
   * without anyone remembering to add it here. `--foreground` pairs with
   * `--background`, which is the one name that does not follow the pattern.
   */
  it.each(
    Object.keys(aliases().refs)
      .filter((name) => name.endsWith("-foreground"))
      .map((fg): [string, string] => [
        fg,
        fg === "--foreground"
          ? "--background"
          : fg.slice(0, -"-foreground".length),
      ]),
  )("puts readable text on %s / %s", (fg, bg) => {
    const { refs } = aliases();
    const resolve = (alias: string) => {
      const target = refs[alias];
      expect(target, `${alias} is not a var() alias`).toBeDefined();
      const colour = tokens[target!];
      expect(
        colour,
        `${alias} -> ${target} is not a literal in the ${name} scheme`,
      ).toBeDefined();
      return colour!;
    };
    const ratio = contrast(resolve(fg), resolve(bg));
    expect(
      ratio,
      `${fg} on ${bg} is ${ratio.toFixed(2)}:1 in the ${name} scheme`,
    ).toBeGreaterThanOrEqual(AA_NORMAL);
  });

  it("stays inside the sRGB gamut", () => {
    // An out-of-gamut oklch value is silently clipped by the browser, which
    // changes both the hue and the contrast — so a ratio computed from the
    // written numbers would be a ratio nobody ever sees.
    for (const [token, colour] of Object.entries(tokens)) {
      expect(inGamut(colour), `${token} clips outside sRGB`).toBe(true);
    }
  });
});

describe("the shadcn alias block", () => {
  it("pins no colour of its own", () => {
    // The block is scheme-independent by design: it maps shadcn's names onto
    // tokens that already flip. A literal here is a colour that does not flip,
    // which is exactly how --destructive-foreground stayed near-white on a
    // mid-red in dark mode at 2.72:1. It is also invisible to `scheme()`, so
    // the block that most needs checking would be the block nothing checks.
    expect(aliases().literals).toEqual([]);
  });

  it("aliases nothing that is itself an alias", () => {
    // `resolve()` above follows exactly one hop. A two-hop alias would resolve
    // to undefined and fail with a confusing message, so it fails here with a
    // clear one instead.
    const { refs } = aliases();
    const light = scheme(":root {");
    const dark = scheme(".dark {");
    for (const [alias, target] of Object.entries(refs)) {
      expect(
        light[target] !== undefined && dark[target] !== undefined,
        `${alias} -> ${target}, which is not a literal in both schemes`,
      ).toBe(true);
    }
  });
});

describe("the brand hazard specifically", () => {
  it("does not use the site's bright green as light-mode text", () => {
    const light = scheme(":root {");
    const dark = scheme(".dark {");

    // The site's value, verbatim. If light mode ever adopts it for --brand,
    // this fails with the number that makes the problem obvious.
    expect(dark["--brand"]!.L).toBeCloseTo(0.8627, 3);
    expect(light["--brand"]!.L).toBeLessThan(0.6);

    const asText = contrast(dark["--brand"]!, light["--surface-raised"]!);
    expect(asText).toBeLessThan(2); // documents *why* the two differ
  });

  it("keeps the bright green available for fills in both schemes", () => {
    const light = scheme(":root {");
    const dark = scheme(".dark {");
    expect(light["--brand-fill"]!.L).toBeCloseTo(0.8627, 3);
    expect(dark["--brand-fill"]!.L).toBeCloseTo(0.8627, 3);

    // And that a fill is usable: dark text on it, in both schemes.
    expect(
      contrast(light["--surface-inverse"]!, light["--brand-fill"]!),
    ).toBeGreaterThanOrEqual(AA_NORMAL);
  });
});
