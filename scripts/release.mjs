/**
 * Bump, commit and tag the CLI.
 *
 * `pnpm release [patch|minor|major|prerelease|<exact version>]`
 *
 * Two things this deliberately does *not* do. It does not run the tests —
 * `.github/workflows/release.yml` runs the full CI suite on the tagged tree
 * before anything is published, and duplicating that here would only teach
 * people that a local pass means it is safe to push. And it does not write
 * release notes: `CHANGELOG.md` is written by hand, by whoever made the
 * change, and this only renames the `[Unreleased]` heading they wrote under.
 */
import { execSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

/**
 * The next version, including pre-releases.
 *
 * The old two-line arithmetic here `NaN`d on any suffix — `0.7.0-rc.1` split
 * to `["0","7","0-rc","1"]` — which meant a release candidate was not
 * expressible at all, and a hosted beta needs one.
 */
export function nextVersion(current, bump) {
  if (SEMVER.test(bump)) return bump; // an exact version, stated outright
  const match = SEMVER.exec(current);
  if (!match)
    throw new Error(`apps/cli/package.json has no semver: ${current}`);
  const [, maj, min, pat, pre] = match;
  const [major, minor, patch] = [Number(maj), Number(min), Number(pat)];

  switch (bump) {
    case "major":
      return `${major + 1}.0.0`;
    case "minor":
      return `${major}.${minor + 1}.0`;
    case "patch":
      // Leaving a pre-release is a *release* of the version it prefixes:
      // 0.7.0-rc.2 patches to 0.7.0, not 0.7.1. Anything else publishes a
      // version nobody tested and skips the one everybody did.
      return pre
        ? `${major}.${minor}.${patch}`
        : `${major}.${minor}.${patch + 1}`;
    case "prerelease": {
      if (!pre) return `${major}.${minor}.${patch + 1}-rc.1`;
      const tail = /^(.*?)(\d+)$/.exec(pre);
      return tail
        ? `${major}.${minor}.${patch}-${tail[1]}${Number(tail[2]) + 1}`
        : `${major}.${minor}.${patch}-${pre}.1`;
    }
    default:
      throw new Error(
        `unknown bump "${bump}" — use patch, minor, major, prerelease, or an exact version`,
      );
  }
}

/** Rename the `[Unreleased]` heading, leaving a fresh empty one above it. */
function releaseChangelog(text, version, date) {
  if (!text.includes("## [Unreleased]")) return text;
  return text.replace(
    "## [Unreleased]",
    `## [Unreleased]\n\n## [${version}] — ${date}`,
  );
}

// Nothing runs when this file is imported, so `nextVersion` can be exercised
// on its own.
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const bump = process.argv[2] || "patch";
  const cliPkg = path.resolve("apps/cli/package.json");
  const changelog = path.resolve("CHANGELOG.md");

  const pkg = JSON.parse(await readFile(cliPkg, "utf8"));
  const next = nextVersion(pkg.version, bump);

  pkg.version = next;
  await writeFile(cliPkg, JSON.stringify(pkg, null, 2) + "\n");

  const date = new Date().toISOString().slice(0, 10);
  const notes = await readFile(changelog, "utf8").catch(() => null);
  if (notes !== null) {
    await writeFile(changelog, releaseChangelog(notes, next, date));
  }

  execSync(`git add ${cliPkg} ${changelog}`, { stdio: "inherit" });
  execSync(`git commit -m "chore(cli): release v${next}"`, {
    stdio: "inherit",
  });
  // Annotated, and that is not a style preference.
  //
  // `git tag v0.7.0` makes a *lightweight* tag, and `git push --follow-tags` —
  // the command printed two lines below, and the only one anybody runs — pushes
  // annotated tags only. So the release flow's own instruction silently failed
  // to push the tag it had just made, `.github/workflows/release.yml` never
  // fired, and nothing reached npm. That is how this repo ended up with
  // `MIN_PAIR_CLI_VERSION = "0.7.0"` in main while 0.6.3 was the newest thing
  // published: every attempt to cut it looked like it worked.
  execSync(`git tag -a v${next} -m "mtmux v${next}"`, { stdio: "inherit" });
  console.log(
    `tagged v${next}${next.includes("-") ? " (pre-release — publishes under the npm 'next' tag)" : ""}.`,
  );
  console.log("push with: git push --follow-tags");
}

export { releaseChangelog };
