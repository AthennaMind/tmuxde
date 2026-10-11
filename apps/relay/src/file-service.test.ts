import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// file-service reads config.allowedPaths at import time from ALLOWED_PATHS, so
// we create the fixture tree, point ALLOWED_PATHS at it, then dynamically import
// the module under test. realpath is resolved so the tmp dir may itself be a
// symlink (as on some platforms) without affecting the assertions.
let files: typeof import("./file-service.js");

let base: string; // real temp base
let allowedDir: string; // the single allowed root (base/user)
let siblingDir: string; // base/userdata — shares a string prefix with the root
let subDir: string; // base/user/sub — a legitimate subpath
let outsideDir: string; // base/outside — symlink escape target
let escapeLink: string; // base/user/escape -> base/outside
let deniedDir: string; // base/user/.tmuxde — holds AUTH_TOKEN, never readable
let sshDir: string; // base/user/.ssh
let denySiblingDir: string; // base/user/.tmuxdefoo — prefix-only, still allowed
let denyLink: string; // base/user/shortcut -> base/user/.ssh
let realHome: string | undefined;
let realConfigDir: string | undefined;
let serviceConfigDir: string;

beforeAll(async () => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-fs-")));
  allowedDir = path.join(base, "user");
  siblingDir = path.join(base, "userdata");
  subDir = path.join(allowedDir, "sub");
  outsideDir = path.join(base, "outside");

  fs.mkdirSync(allowedDir);
  fs.mkdirSync(siblingDir);
  fs.mkdirSync(subDir);
  fs.mkdirSync(outsideDir);
  fs.writeFileSync(path.join(outsideDir, "secret.txt"), "top secret");

  escapeLink = path.join(allowedDir, "escape");
  fs.symlinkSync(outsideDir, escapeLink, "dir");

  // The escalation this guards is that the allowed root IS $HOME, so point
  // $HOME at the fixture and let the deny-list resolve exactly as it does in
  // production rather than hand-feeding it paths.
  realHome = process.env.HOME;
  process.env.HOME = allowedDir;
  realConfigDir = process.env.TMUXDE_CONFIG_DIR;
  serviceConfigDir = path.join(allowedDir, "service-state");
  fs.mkdirSync(serviceConfigDir);
  process.env.TMUXDE_CONFIG_DIR = serviceConfigDir;

  deniedDir = path.join(allowedDir, ".tmuxde");
  sshDir = path.join(allowedDir, ".ssh");
  denySiblingDir = path.join(allowedDir, ".tmuxdefoo");
  fs.mkdirSync(deniedDir);
  fs.mkdirSync(sshDir);
  fs.mkdirSync(denySiblingDir);
  fs.writeFileSync(path.join(deniedDir, "config.json"), "{}");
  fs.writeFileSync(path.join(sshDir, "id_rsa"), "-----BEGIN-----");
  fs.writeFileSync(path.join(denySiblingDir, "notes.txt"), "harmless");

  denyLink = path.join(allowedDir, "shortcut");
  fs.symlinkSync(sshDir, denyLink, "dir");

  process.env.ALLOWED_PATHS = allowedDir;
  files = await import("./file-service.js");
});

afterAll(() => {
  if (realHome === undefined) delete process.env.HOME;
  else process.env.HOME = realHome;
  if (realConfigDir === undefined) delete process.env.TMUXDE_CONFIG_DIR;
  else process.env.TMUXDE_CONFIG_DIR = realConfigDir;
  fs.rmSync(base, { recursive: true, force: true });
});

describe("the credential deny-list", () => {
  it("refuses host config even when relay state uses another directory", () => {
    expect(files.isPathAllowed(serviceConfigDir)).toBe(false);
    expect(files.isPathAllowed(deniedDir)).toBe(false);
    expect(files.isPathAllowed(path.join(deniedDir, "config.json"))).toBe(
      false,
    );
  });

  it("refuses the neighbouring credential directories", () => {
    expect(files.isPathAllowed(sshDir)).toBe(false);
    expect(files.isPathAllowed(path.join(sshDir, "id_rsa"))).toBe(false);
  });

  it("refuses a symlink inside the allowed root pointing at a denied one", () => {
    expect(files.isPathAllowed(denyLink)).toBe(false);
    expect(files.isPathAllowed(path.join(denyLink, "id_rsa"))).toBe(false);
  });

  it("still allows a sibling that merely shares the prefix", () => {
    expect(files.isPathAllowed(denySiblingDir)).toBe(true);
    expect(files.isPathAllowed(path.join(denySiblingDir, "notes.txt"))).toBe(
      true,
    );
  });

  it("reports the denial directly too", () => {
    expect(files.isPathDenied(path.join(deniedDir, "config.json"))).toBe(true);
    expect(files.isPathDenied(denySiblingDir)).toBe(false);
  });
});

describe("isPathAllowed", () => {
  it("allows the exact allowed root", () => {
    expect(files.isPathAllowed(allowedDir)).toBe(true);
  });

  it("allows a subpath of the allowed root", () => {
    expect(files.isPathAllowed(subDir)).toBe(true);
    expect(files.isPathAllowed(path.join(subDir, "deep", "nested"))).toBe(true);
  });

  it("allows a not-yet-existing file inside the allowed root", () => {
    expect(files.isPathAllowed(path.join(allowedDir, "new-file.txt"))).toBe(
      true,
    );
  });

  it("rejects a sibling directory that merely shares a string prefix", () => {
    // /home/userdata must NOT match allowed /home/user
    expect(files.isPathAllowed(siblingDir)).toBe(false);
    expect(files.isPathAllowed(path.join(siblingDir, "file.txt"))).toBe(false);
  });

  it("rejects `..` traversal that escapes the allowed root", () => {
    expect(files.isPathAllowed(path.join(allowedDir, "..", ".."))).toBe(false);
    expect(files.isPathAllowed(path.join(allowedDir, "..", "outside"))).toBe(
      false,
    );
  });

  it("rejects a symlink inside the allowed root that points outside it", () => {
    // The symlink itself resolves outside the root.
    expect(files.isPathAllowed(escapeLink)).toBe(false);
    // And any path accessed *through* the symlink is rejected too.
    expect(files.isPathAllowed(path.join(escapeLink, "secret.txt"))).toBe(
      false,
    );
  });
});
