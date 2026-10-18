let selectedMachine: string | null = null;

/** Active workspace changes only after its previous views unmount. */
export function setMachineId(id: string | null): void {
  selectedMachine = id;
}

export function machineId(): string {
  if (selectedMachine) return selectedMachine;
  if (typeof window === "undefined") return "local";
  const match = /^\/m\/([a-zA-Z0-9_-]+)(?:\/|$)/.exec(window.location?.pathname ?? "");
  return match?.[1] ?? "local";
}

/** Existing local storage remains compatible. Remote state gets its own key. */
export function machineStorageKey(key: string): string {
  const id = machineId();
  return id === "local" ? key : `${key}:machine:${id}`;
}

export function machineBasePath(): string {
  const id = machineId();
  return id === "local" ? "" : `/m/${id}`;
}

export function machinePath(id: string): string {
  return id === "local" ? "/" : `/m/${encodeURIComponent(id)}/`;
}

/** Remove saved workspace data for every machine on device erasure. */
export function clearMachineStorage(): void {
  if (typeof window === "undefined") return;
  for (const name of ["localStorage", "sessionStorage"] as const) {
    try {
      const storage = window[name];
      if (!storage) continue;
      const keys: string[] = [];
      for (let i = 0; i < storage.length; i++) {
        const key = storage.key(i);
        if (
          key?.startsWith("tmuxde-main-tabs") ||
          key === "tmuxde-terminal-tabs" ||
          key?.startsWith("tmuxde-commands") ||
          key?.startsWith("tmuxde-last-session") ||
          key === "ccremote-commands" ||
          key === "ccremote-last-session"
        ) {
          keys.push(key);
        }
      }
      for (const key of keys) storage.removeItem(key);
    } catch {
      // Storage can be unavailable under browser privacy settings.
    }
  }
}
