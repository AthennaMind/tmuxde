import { beforeEach, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ disconnect: () => {} }));
vi.mock("@/lib/relay-registry", () => ({
  onDisconnectAll: (fn: () => void) => {
    fixture.disconnect = fn;
  },
}));
import {
  closePalette,
  confirmAfterPalette,
  openPalette,
  promptInPalette,
  togglePalette,
  usePaletteStore,
} from "./palette-store";

beforeEach(() =>
  usePaletteStore.setState({ open: false, mode: "commands", prompt: null, confirm: null }),
);

it("toggles a mode shortcut and switches between modes while open", () => {
  togglePalette("files");
  expect(usePaletteStore.getState()).toMatchObject({ open: true, mode: "files" });
  togglePalette("commands");
  expect(usePaletteStore.getState()).toMatchObject({ open: true, mode: "commands" });
  togglePalette("commands");
  expect(usePaletteStore.getState().open).toBe(false);
});

it("leaves a prompt for a fresh mode and clears prompts on close", () => {
  openPalette("commands");
  promptInPalette({ label: "Rename", placeholder: "", hint: "", submit: () => {} });
  togglePalette("commands");
  expect(usePaletteStore.getState()).toMatchObject({ open: true, prompt: null });
  promptInPalette({ label: "Rename", placeholder: "", hint: "", submit: () => {} });
  closePalette();
  expect(usePaletteStore.getState()).toMatchObject({ open: false, prompt: null });
});

it("closes before confirming and drops everything on lock or sign out", () => {
  openPalette("commands");
  const run = vi.fn();
  confirmAfterPalette({ title: "Kill?", description: "", label: "Kill", run });
  expect(usePaletteStore.getState()).toMatchObject({ open: false, confirm: { title: "Kill?" } });
  openPalette("terminals");
  fixture.disconnect();
  expect(usePaletteStore.getState()).toMatchObject({ open: false, prompt: null, confirm: null });
  expect(run).not.toHaveBeenCalled();
});
