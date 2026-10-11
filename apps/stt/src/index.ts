import { basename } from "node:path";
import { loadConfig } from "./config.ts";
import { log } from "./log.ts";
import { loadVadSegmenter } from "./segmenter.ts";
import { createSttServer } from "./server.ts";
import { loadParakeet } from "./transcriber.ts";

const config = loadConfig();
const model = basename(config.modelDir);
const loadStart = Date.now();
const transcriber = await loadParakeet(config.modelDir, config.threads);
const segmenter = config.vadModel ? await loadVadSegmenter(config.vadModel) : undefined;
log("info", "Model loaded", {
  model,
  threads: config.threads,
  segments: segmenter ? "utterances" : "30 s chunks",
  ms: Date.now() - loadStart,
});

const server = createSttServer({
  transcriber,
  model,
  maxSessions: config.maxSessions,
  segmenter,
  limits: { maxSeconds: config.maxSeconds, idleMs: 60_000 },
});
server.listen(config.port, config.host, () => {
  log("info", "Speech service listening", { host: config.host, port: config.port });
});

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
