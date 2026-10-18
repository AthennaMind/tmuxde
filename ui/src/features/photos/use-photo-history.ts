import { useSyncExternalStore } from "react";
import { useRelayClient } from "@/features/connection/use-websocket";
import { photoHistory } from "./photo-history";

export function usePhotoHistory() {
  const client = useRelayClient();
  const paths = useSyncExternalStore(
    photoHistory.subscribe,
    () => photoHistory.get(client),
    () => photoHistory.get(null),
  );
  return { client, paths, scope: photoHistory.scope(client) };
}
