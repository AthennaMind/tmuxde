import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { buildInfo } from "../build-info.js";
import { cliVersion } from "../update-check.js";

const exec = promisify(execFile);

export async function version() {
  // Deliberately not resolved from this file's own path: esbuild bundles every
  // command into `dist/bin.js`, so at runtime the source layout is gone and
  // `package.json` is one level up, not two. `cliVersion` already knows that
  // and is tested on it.
  const version = await cliVersion();
  let tmux = "not found";
  try {
    tmux = (await exec("tmux", ["-V"])).stdout.trim();
  } catch {
    // tmux not installed
  }
  const build = buildInfo();
  console.log(`mtmux     ${version}`);
  console.log(
    `build     ${build.sha}${build.builtAt ? ` (${build.builtAt})` : ""}`,
  );
  console.log(`node      ${process.versions.node}`);
  console.log(`tmux      ${tmux}`);
  console.log(`platform  ${process.platform}/${process.arch}`);
}
