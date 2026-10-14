// @ts-check
import { photoPathText } from "./photo-upload.js";

/** @type {readonly string[]} */
const EMPTY = Object.freeze([]);

export function createPhotoHistory() {
  // Client identity prevents equal paths on different hosts from sharing previews.
  /** @type {WeakMap<object, readonly string[]>} */
  const histories = new WeakMap();
  /** @type {WeakMap<object, number>} */
  const scopes = new WeakMap();
  let nextScope = 0;
  /** @type {Set<() => void>} */
  const listeners = new Set();
  return {
    /** @param {object | null} client */
    get(client) {
      return (client && histories.get(client)) || EMPTY;
    },
    /** @param {object | null} client */
    scope(client) {
      return (client && scopes.get(client)) || 0;
    },
    /** @param {object} client @param {string} path */
    add(client, path) {
      photoPathText(path);
      if (!scopes.has(client)) scopes.set(client, ++nextScope);
      const previous = histories.get(client) || EMPTY;
      histories.set(
        client,
        [path, ...previous.filter((p) => p !== path)].slice(0, 8),
      );
      for (const listener of listeners) listener();
    },
    /** @param {() => void} listener */
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export const photoHistory = createPhotoHistory();

/**
 * @param {string} path
 * @param {{
 *   load: (path: string) => Promise<string>,
 *   release: (url: string) => void,
 *   isCurrent: () => boolean,
 *   paste: (text: string) => void,
 *   resetInput: () => void,
 * }} context
 */
export async function reusePhotoPath(path, context) {
  const text = photoPathText(path);
  const changed = () => new Error("Terminal changed. Select photo again.");
  if (!context.isCurrent()) throw changed();
  let url;
  try {
    // Recheck even if a thumbnail was already loaded. File may have been removed.
    url = await context.load(path);
  } catch (error) {
    const reason = error instanceof Error ? ` ${error.message}` : "";
    throw new Error(
      `Photo unavailable. Choose Photo to upload it again.${reason}`,
      { cause: error },
    );
  }
  try {
    if (!context.isCurrent()) throw changed();
    context.resetInput();
    context.paste(text);
  } finally {
    context.release(url);
  }
}
