"use client";

import { useSyncExternalStore } from "react";
import { useRelayClient } from "@/hooks/use-websocket";
import { photoHistory } from "@/lib/photo-history.js";

export function usePhotoHistory() {
  const client = useRelayClient();
  const paths = useSyncExternalStore(
    photoHistory.subscribe,
    () => photoHistory.get(client),
    () => photoHistory.get(null),
  );
  return { client, paths, scope: photoHistory.scope(client) };
}
