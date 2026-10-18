import { describe, expect, it } from "vitest";
import { migrateTerminalStore } from "./terminal-store";

describe("migrateTerminalStore", () => {
  it("moves the old default theme to tmuxde", () => {
    expect(migrateTerminalStore({ themeName: "dracula" }, 1).themeName).toBe("tmuxde");
  });

  it("keeps any other theme someone picked", () => {
    expect(migrateTerminalStore({ themeName: "nord" }, 1).themeName).toBe("nord");
  });

  it("leaves a current store alone", () => {
    expect(migrateTerminalStore({ themeName: "dracula" }, 2).themeName).toBe("dracula");
  });

  it("still turns GPU rendering off from version 0", () => {
    expect(migrateTerminalStore({ gpuRendering: true }, 0).gpuRendering).toBe(false);
  });
});

describe("terminal weight", () => {
  it("starts at the weight already chosen for code", () => {
    expect(migrateTerminalStore({ codeWeight: 500 }, 2).terminalWeight).toBe(500);
  });

  it("keeps a terminal weight set after the split", () => {
    expect(migrateTerminalStore({ codeWeight: 500, terminalWeight: 700 }, 3).terminalWeight).toBe(
      700,
    );
  });
});
