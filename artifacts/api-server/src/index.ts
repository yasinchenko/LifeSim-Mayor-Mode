import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Server } from "node:http";
import app from "./app";
import { logger } from "./lib/logger";
import { simulationEngine } from "./lib/simulation-engine";

export interface StartApiServerOptions {
  port?: number;
  host?: string;
}

export interface StartedApiServer {
  server: Server;
  port: number;
  host: string;
  url: string;
}

let initPromise: Promise<void> | null = null;

function parsePort(value: string | undefined, fallback: number): number {
  if (!value) return fallback;

  const port = Number(value);
  if (Number.isNaN(port) || port < 0) {
    throw new Error(`Invalid PORT value: "${value}"`);
  }

  return port;
}

async function initializeSimulation(): Promise<void> {
  initPromise ??= simulationEngine.initialize();
  await initPromise;
}

export async function startApiServer(options: StartApiServerOptions = {}): Promise<StartedApiServer> {
  const host = options.host ?? process.env.HOST ?? "127.0.0.1";
  const port = options.port ?? parsePort(process.env.PORT, 4123);

  await initializeSimulation();

  return new Promise((resolve, reject) => {
    const server = app.listen(port, host);

    server.once("error", (err) => {
      logger.error({ err }, "Error listening on port");
      reject(err);
    });

    server.once("listening", () => {
      const address = server.address();
      const actualPort = typeof address === "object" && address ? address.port : port;
      const url = `http://${host}:${actualPort}`;
      logger.info({ port: actualPort, host }, "Server listening");
      resolve({ server, port: actualPort, host, url });
    });
  });
}

const isDirectRun =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  startApiServer().catch((err) => {
    logger.error({ err }, "Failed to start API server");
    process.exit(1);
  });
}
