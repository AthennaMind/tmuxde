import { useEffect, useEffectEvent, useRef } from "react";
import type { RepositoryClient } from "@/features/repository/repository-request";
import { useVisibleInterval } from "@/shared/use-visible-interval";
import { holdDirectoryWatch } from "./directory-watch";

/** Watch only listed folders. Poll catches refused watches and missed events. */
export function useDirectoryWatch(
  client: RepositoryClient,
  path: string | null,
  refresh: () => void,
) {
  const changed = useEffectEvent(refresh);
  const watch = useRef<ReturnType<typeof holdDirectoryWatch> | null>(null);
  useEffect(() => {
    if (!path) return;
    const held = holdDirectoryWatch(client, path, () => changed());
    watch.current = held;
    return () => {
      held.release();
      watch.current = null;
    };
  }, [client, path]);
  useVisibleInterval(
    () => {
      if (client.status !== "connected") return;
      watch.current?.renew();
      refresh();
    },
    10_000,
    { enabled: !!path, debounceMs: 1_000 },
  );
}
