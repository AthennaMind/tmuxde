import { photoPathText } from "./photo-upload-client";

const EMPTY: readonly string[] = Object.freeze([]);

export function createPhotoHistory() {
  // Client identity prevents equal paths on different hosts from sharing previews.
  const histories = new WeakMap<object, readonly string[]>();
  const scopes = new WeakMap<object, number>();
  let nextScope = 0;
  const listeners = new Set<() => void>();
  return {
    get(client: object | null) {
      return (client && histories.get(client)) || EMPTY;
    },
    scope(client: object | null) {
      return (client && scopes.get(client)) || 0;
    },
    add(client: object, path: string) {
      photoPathText(path);
      if (!scopes.has(client)) scopes.set(client, ++nextScope);
      const previous = histories.get(client) || EMPTY;
      histories.set(client, [path, ...previous.filter((p) => p !== path)].slice(0, 8));
      for (const listener of listeners) listener();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export const photoHistory = createPhotoHistory();

export async function reusePhotoPath(
  path: string,
  context: {
    load: (path: string) => Promise<string>;
    release: (url: string) => void;
    isCurrent: () => boolean;
    paste: (text: string) => void;
    resetInput: () => void;
  },
) {
  const text = photoPathText(path);
  const changed = () => new Error("Terminal changed. Select photo again.");
  if (!context.isCurrent()) throw changed();
  let url: string;
  try {
    // Recheck even if a thumbnail was already loaded. File may have been removed.
    url = await context.load(path);
  } catch (error) {
    const reason = error instanceof Error ? ` ${error.message}` : "";
    throw new Error(`Photo unavailable. Choose Photo to upload it again.${reason}`, {
      cause: error,
    });
  }
  try {
    if (!context.isCurrent()) throw changed();
    context.resetInput();
    context.paste(text);
  } finally {
    context.release(url);
  }
}
