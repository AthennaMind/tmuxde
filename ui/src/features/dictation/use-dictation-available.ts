import { isReadOnly, useConnectionStore } from "@/features/connection/connection-store";

/** Whether this connection is offered dictation at all. */
export function useDictationAvailable(): boolean {
  return useConnectionStore((s) => s.features.has("dictation") && !isReadOnly(s.capabilities));
}
