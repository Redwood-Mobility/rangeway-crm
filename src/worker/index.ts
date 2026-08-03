import process from "node:process";
import { config } from "../server/config.js";
import { createPool } from "../server/platform/db/client.js";
import { OutboxWorker } from "./outbox-worker.js";

const shutdownTimeoutMilliseconds = 25_000;

async function main(): Promise<void> {
  if (!config.databaseUrl) {
    throw new Error("DATABASE_URL is required to run the outbox worker.");
  }

  const pool = createPool(config.databaseUrl);
  const worker = new OutboxWorker({
    pool,
    // External integrations will register versioned handlers in a later task.
    handlers: {},
  });

  let shutdownStarted = false;
  let poolClose: Promise<void> | null = null;
  const closePool = (): Promise<void> => {
    poolClose ??= pool.end();
    return poolClose;
  };

  const run = worker.run(config.workerPollMs);

  const removeSignalHandlers = () => {
    process.off("SIGTERM", requestShutdown);
    process.off("SIGINT", requestShutdown);
  };

  const requestShutdown = () => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    worker.stopClaiming();

    void (async () => {
      let shutdownFailed = false;
      try {
        await worker.waitForCurrentBatch(shutdownTimeoutMilliseconds);
      } catch (error) {
        shutdownFailed = true;
        console.error(error);
      }

      try {
        await closePool();
      } catch (error) {
        shutdownFailed = true;
        console.error(error);
      } finally {
        removeSignalHandlers();
      }

      if (shutdownFailed) process.exitCode = 1;
    })();
  };

  process.on("SIGTERM", requestShutdown);
  process.on("SIGINT", requestShutdown);

  try {
    await run;
  } catch (error) {
    process.exitCode = 1;
    console.error(error);
  } finally {
    worker.stopClaiming();
    if (!shutdownStarted) {
      removeSignalHandlers();
      await closePool();
    }
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
