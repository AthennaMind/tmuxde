import { fileHunks } from "./file-diff";

self.onmessage = ({ data }: MessageEvent<{ original: string; current: string }>) => {
  self.postMessage(fileHunks(data.original, data.current));
};
