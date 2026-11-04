import type { RepositoryClient } from "@/features/repository/repository-request";
import { trimSlash } from "@/features/repository/repo-change";

// Matches server's per-connection cap. Extra open folders keep polling.
const MAX_WATCHES = 32;
const BATCH_MS = 75;

interface Entry {
  listeners: Set<() => void>;
  watching: boolean;
  timer?: ReturnType<typeof setTimeout>;
}
interface Watches {
  entries: Map<string, Entry>;
  stop: () => void;
  fill: () => void;
}

const clients = new WeakMap<RepositoryClient, Watches>();

function notify(entry: Entry) {
  // A bounded window also flushes during continuous output.
  if (entry.timer !== undefined) return;
  entry.timer = setTimeout(() => {
    entry.timer = undefined;
    for (const listener of entry.listeners) listener();
  }, BATCH_MS);
}

function watchesFor(client: RepositoryClient): Watches {
  const existing = clients.get(client);
  if (existing) return existing;
  const entries = new Map<string, Entry>();
  const fill = () => {
    if (client.status !== "connected") return;
    let active = [...entries.values()].filter((entry) => entry.watching).length;
    for (const [path, entry] of entries) {
      if (active >= MAX_WATCHES) break;
      if (entry.watching) continue;
      entry.watching = true;
      active++;
      client.send({ type: "file:watch", path });
      // Cover changes while this folder waited for a slot.
      notify(entry);
    }
  };
  const offMessage = client.onMessage((message) => {
    if (message.type !== "file:changed") return;
    const path = trimSlash(message.path);
    const parent = path.slice(0, path.lastIndexOf("/")) || "/";
    for (const [folder, entry] of entries) {
      if (path !== folder && parent !== folder) continue;
      if (entry.watching && path === folder && client.status === "connected") {
        // A removed directory leaves a dead server watch. Drop it so a
        // recreated directory can be watched again by its parent or poll.
        if (message.event === "unlinkDir") client.send({ type: "file:unwatch", path: folder });
        if (message.event === "addDir") client.send({ type: "file:watch", path: folder });
      }
      notify(entry);
    }
  });
  const offStatus = client.onStatusChange((status) => {
    for (const entry of entries.values()) {
      entry.watching = false;
      clearTimeout(entry.timer);
      entry.timer = undefined;
    }
    if (status === "connected") {
      fill();
      for (const entry of entries.values()) notify(entry);
    }
  });
  const watches = {
    entries,
    fill,
    stop: () => {
      offMessage();
      offStatus();
    },
  };
  clients.set(client, watches);
  return watches;
}

/** Share one directory watch per connection, including editor and tree holders. */
export function holdDirectoryWatch(client: RepositoryClient, path: string, onChange: () => void) {
  const folder = trimSlash(path);
  const watches = watchesFor(client);
  let entry = watches.entries.get(folder);
  if (!entry) {
    entry = { listeners: new Set(), watching: false };
    watches.entries.set(folder, entry);
  }
  // Unique token even if callers pass the same callback.
  const listener = () => onChange();
  entry.listeners.add(listener);
  watches.fill();
  let released = false;
  return {
    renew: () => {
      // Active watches deduplicate on server. Refused or removed ones retry.
      if (!released && entry.watching && client.status === "connected")
        client.send({ type: "file:watch", path: folder });
    },
    release: () => {
      if (released) return;
      released = true;
      entry.listeners.delete(listener);
      if (entry.listeners.size) return;
      clearTimeout(entry.timer);
      watches.entries.delete(folder);
      if (entry.watching && client.status === "connected")
        client.send({ type: "file:unwatch", path: folder });
      watches.fill();
      if (!watches.entries.size) {
        watches.stop();
        clients.delete(client);
      }
    },
  };
}
