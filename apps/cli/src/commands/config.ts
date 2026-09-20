import kleur from "kleur";
import * as configStore from "../config-store.js";
import { DEFAULT_API_BASE, isBrokerUrl } from "../api.js";

/**
 * `mtmux config` — the settings that are not flags.
 *
 * Deliberately few keys, not a settings system. Everything else this CLI does
 * is either a per-run flag or a decision the product should make for you, and
 * the moment this becomes a generic key-value store it starts accumulating
 * options nobody chose.
 */

type Setting = {
  describe: () => Promise<string>;
  set: (value: string) => Promise<void>;
  /** What a valid value looks like, named in the error when one is not. */
  values: string[];
  help: string;
};

const SETTINGS: Record<string, Setting> = {
  reconnectPolicy: {
    describe: async () => configStore.getReconnectPolicy(),
    set: async (value) => {
      if (!configStore.isReconnectPolicy(value)) {
        throw new Error(`Not a reconnect policy: ${value}`);
      }
      await configStore.setReconnectPolicy(value);
    },
    values: ["trust", "confirm"],
    help: "Whether a previously paired device may reconnect without being asked.",
  },

  reach: {
    describe: async () => configStore.getReach(),
    set: async (value) => {
      if (!configStore.isReach(value)) {
        throw new Error(`Not a reach: ${value}`);
      }
      await configStore.setReach(value);
    },
    values: ["local", "hosted"],
    help: "Whether `mtmux start` opens a tunnel, or serves this network only.",
  },

  api: {
    describe: async () =>
      (await configStore.getApiBase()) ?? `${DEFAULT_API_BASE} (default)`,
    set: async (value) => {
      // `default` rather than an empty string: `config set api ""` is awkward
      // to type and easy to get wrong in a shell.
      if (value === "default" || value === "") {
        await configStore.setApiBase(null);
        return;
      }
      if (!isBrokerUrl(value)) throw new Error("not a broker URL");
      await configStore.setApiBase(value);
    },
    values: ["an http(s) URL", "default"],
    help: "The pairing broker this machine uses. --api and MTMUX_API_URL still win.",
  },
};

export async function configGet(key?: string): Promise<void> {
  console.log("");
  const keys = key ? [key] : Object.keys(SETTINGS);
  for (const name of keys) {
    const setting = SETTINGS[name];
    if (!setting) {
      console.log(kleur.red(`  Unknown setting: ${name}`));
      console.log(
        kleur.dim(`  Known settings: ${Object.keys(SETTINGS).join(", ")}`),
      );
      console.log("");
      process.exitCode = 1;
      return;
    }
    console.log(`  ${kleur.dim(name.padEnd(16))}  ${await setting.describe()}`);
    console.log(kleur.dim(`  ${" ".repeat(16)}  ${setting.help}`));
  }
  console.log("");
}

export async function configSet(key: string, value: string): Promise<void> {
  const setting = SETTINGS[key];
  console.log("");
  if (!setting) {
    console.log(kleur.red(`  Unknown setting: ${key}`));
    console.log(
      kleur.dim(`  Known settings: ${Object.keys(SETTINGS).join(", ")}`),
    );
    console.log("");
    process.exitCode = 1;
    return;
  }

  try {
    await setting.set(value);
  } catch {
    console.log(
      kleur.red(`  ${key} must be one of: ${setting.values.join(", ")}`),
    );
    console.log("");
    process.exitCode = 1;
    return;
  }

  console.log(kleur.green(`  ✓ ${key} = ${value}`));
  // Said out loud because the value is read at boot: changing it while a
  // server is running looks like it did nothing until you notice why.
  console.log(kleur.dim("    Takes effect the next time mtmux starts."));
  console.log("");
}
