import { onBeforeLock } from "@/features/lock/lock-controller";
import { create } from "zustand";
import type { AgentComment } from "./comment-context";
export const empty: AgentComment[] = [];
export const useComments = create<{
  batches: Record<string, AgentComment[]>;
  lastPrompt: Record<string, string>;
}>(() => ({ batches: {}, lastPrompt: {} }));

onBeforeLock(() => useComments.setState({ batches: {}, lastPrompt: {} }));
