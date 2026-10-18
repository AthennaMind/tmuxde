import { create } from "zustand";
import { machineId } from "@/features/connection/machine-context";
import { downloadFile, getStoredToken } from "./file-url";
import {
  uploadFileChunks,
  uploadPath,
  uploadReply,
  uploadLimit,
  MAX_UPLOAD_SIZE,
} from "./file-upload";
import { onDisconnectAll } from "@/features/connection/relay-registry";
import { resolveRelayWsUrl } from "@/features/connection/relay-url";
import { RelayClient } from "@/features/connection/ws-client";
import { useMachineStore } from "@/features/connection/machine-store";

export interface Transfer {
  id: number;
  machineId: string;
  machineName: string;
  path: string;
  direction: "upload" | "download";
  state: "queued" | "running" | "done" | "failed" | "cancelled";
  bytes: number;
  total: number;
  error?: string;
}

export const useTransferStore = create<{
  transfers: Transfer[];
  revisions: Record<string, number>;
}>(() => ({ transfers: [], revisions: {} }));

let nextId = 0;
let running = 0;
const controllers = new Map<number, AbortController>();
const queue: (() => Promise<void>)[] = [];

function update(id: number, change: Partial<Transfer>) {
  useTransferStore.setState((state) => ({
    transfers: state.transfers.map((item) => (item.id === id ? { ...item, ...change } : item)),
  }));
}

function pump() {
  while (running < 2 && queue.length) {
    const work = queue.shift()!;
    running++;
    void work().finally(() => {
      running--;
      pump();
    });
  }
}

function start(
  target: string,
  path: string,
  direction: Transfer["direction"],
  total: number,
  work: (signal: AbortSignal, progress: (bytes: number, total?: number) => void) => Promise<void>,
) {
  const id = ++nextId;
  const controller = new AbortController();
  controllers.set(id, controller);
  const machineName =
    useMachineStore.getState().machines.find((item) => item.id === target)?.name ?? target;
  useTransferStore.setState((state) => ({
    transfers: [
      ...state.transfers.filter(
        (item) => item.state === "queued" || item.state === "running" || item.id > id - 8,
      ),
      { id, machineId: target, machineName, path, direction, total, bytes: 0, state: "queued" },
    ],
  }));
  queue.push(async () => {
    const signal = controller.signal;
    try {
      signal.throwIfAborted();
      update(id, { state: "running" });
      await work(signal, (bytes, size) =>
        update(id, { bytes, ...(size !== undefined ? { total: size } : {}) }),
      );
      update(id, { state: "done" });
      if (direction === "upload") {
        useTransferStore.setState((state) => ({
          revisions: {
            ...state.revisions,
            [target]: (state.revisions[target] ?? 0) + 1,
          },
        }));
      }
    } catch (error) {
      update(id, {
        state: signal.aborted ? "cancelled" : "failed",
        error: error instanceof Error ? error.message : "Transfer failed",
      });
    } finally {
      controllers.delete(id);
    }
  });
  pump();
}

export function cancelTransfer(id: number) {
  controllers.get(id)?.abort();
  update(id, { state: "cancelled" });
}

export function clearFinishedTransfers() {
  useTransferStore.setState((state) => ({
    transfers: state.transfers.filter(
      (item) => item.state === "running" || item.state === "queued",
    ),
  }));
}

onDisconnectAll(() => {
  for (const controller of controllers.values()) controller.abort();
  useTransferStore.setState({ transfers: [], revisions: {} });
});

export function startUploads(files: File[], directory: string, target = machineId()) {
  const token = getStoredToken();
  const url = resolveRelayWsUrl(target);
  for (const file of files) {
    const path = uploadPath(directory, file.name);
    // Two writes to one path must never run concurrently.
    if (
      useTransferStore
        .getState()
        .transfers.some(
          (item) =>
            item.machineId === target &&
            item.path === path &&
            item.direction === "upload" &&
            (item.state === "queued" || item.state === "running"),
        )
    )
      continue;
    start(target, path, "upload", file.size, async (signal, progress) => {
      if (!token) throw new Error("Sign in to upload files");
      if (file.size > MAX_UPLOAD_SIZE) throw new Error("Upload limit is 1 GiB per file");
      const client = new RelayClient({ url, token, reconnect: false });
      // Abort also covers time spent reading slices between acknowledgements.
      const abort = () => client.disconnect();
      signal.addEventListener("abort", abort, { once: true });
      try {
        const auth = await uploadReply(
          client,
          (msg) => msg.type === "auth:success",
          signal,
          () => client.connect(),
        );
        if (auth.type !== "auth:success" || !auth.features?.includes("file:upload:ack"))
          throw new Error("Update this machine to upload files");
        if (file.size > uploadLimit(auth.features ?? [])) {
          throw new Error(
            "This machine accepts files up to 10 MiB. Update agent for larger uploads.",
          );
        }
        if (
          auth.capabilities &&
          (auth.capabilities.readOnly || auth.capabilities.files !== "write")
        )
          throw new Error("File uploads are disabled");
        await uploadFileChunks(client, file, path, signal, progress);
      } finally {
        signal.removeEventListener("abort", abort);
        client.disconnect();
      }
    });
  }
}

export function startDownload(path: string, target = machineId()) {
  start(target, path, "download", 0, (signal, progress) =>
    downloadFile(path, path.split("/").pop() || "download", {
      machineId: target,
      signal,
      progress,
    }),
  );
}
