import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createLogger } from "@repo/logger";
import { config } from "./config.js";
import { createHttpServer, startHttpServer } from "./server.js";
import { createWsServer } from "./ws-server.js";
import { wireConnections } from "./wire-connections.js";

const execFileAsync = promisify(execFile);
const logger = createLogger("relay");

const SERVER_VERSION = "1.0.0";

async function main() {
  try {
    await execFileAsync("tmux", ["-V"]);
  } catch {
    logger.error(
      "tmux is not installed or not found in PATH. Please install tmux 3.0+ to use tmuxde.",
    );
    process.exit(1);
  }

  const httpServer = createHttpServer();
  const wss = createWsServer(httpServer);
  const { shutdown: shutdownConnections } = wireConnections(wss);

  await startHttpServer(httpServer);

  logger.info(
    `tmuxde relay v${SERVER_VERSION} ready on ${config.host}:${config.port}`,
  );

  const shutdown = () => {
    logger.info("Shutting down...");
    shutdownConnections();
    httpServer.close();
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  logger.error({ err }, "Failed to start relay server");
  process.exit(1);
});
