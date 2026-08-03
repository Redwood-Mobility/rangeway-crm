import process from "node:process";
import { pathToFileURL } from "node:url";
import type { Pool } from "pg";
import { createPool as createPostgreSqlPool } from "../server/platform/db/client.js";
import {
  atlasEventTypes,
  type AtlasEventType,
} from "../shared/events.js";
import {
  OutboxWorker,
  type OutboxHandler,
  type OutboxHandlerRegistry,
} from "./outbox-worker.js";
import { parseWorkerConfig } from "./config.js";

const defaultShutdownTimeoutMilliseconds = 25_000;
type WorkerSignal = "SIGINT" | "SIGTERM";

// Foundation organization events have no external side effect yet. Explicitly
// acknowledging them is intentional: the audit event and durable outbox row
// remain the record, while later plans can replace this handler atomically.
const acknowledgeFoundationEvent: OutboxHandler = async () => undefined;

export function createProductionOutboxHandlers(): OutboxHandlerRegistry {
  return {
    [atlasEventTypes.organizationUpdated]: acknowledgeFoundationEvent,
    [atlasEventTypes.identityOwnerProvisioned]: acknowledgeFoundationEvent,
    [atlasEventTypes.identityGoogleLinked]: acknowledgeFoundationEvent,
    [atlasEventTypes.identityGoogleProfileUpdated]: acknowledgeFoundationEvent,
    [atlasEventTypes.identityServiceActorCreated]: acknowledgeFoundationEvent,
    [atlasEventTypes.identityServiceActorDisabled]: acknowledgeFoundationEvent,
  } satisfies Record<AtlasEventType, OutboxHandler>;
}

export interface WorkerPool {
  end(): Promise<void>;
}

export interface OutboxRuntimeWorker {
  run(pollMilliseconds: number): Promise<void>;
  stopClaiming(): void;
  waitForCurrentBatch(timeoutMilliseconds?: number): Promise<void>;
}

export interface WorkerLifecycle {
  on(signal: WorkerSignal, listener: () => void): void;
  off(signal: WorkerSignal, listener: () => void): void;
  exit(code: number): void;
}

export interface WorkerRuntimeOptions {
  databaseUrl: string;
  workerPollMilliseconds: number;
  createPool: (databaseUrl: string) => WorkerPool;
  createWorker: (pool: WorkerPool) => OutboxRuntimeWorker;
  lifecycle: WorkerLifecycle;
  shutdownTimeoutMilliseconds?: number;
}

class ShutdownDeadlineError extends Error {
  constructor() {
    super("Outbox worker exceeded its shutdown deadline.");
    this.name = "ShutdownDeadlineError";
  }
}

async function withinDeadline<T>(
  operation: Promise<T>,
  timeoutMilliseconds: number,
): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new ShutdownDeadlineError()),
          timeoutMilliseconds,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export async function runWorkerRuntime(options: WorkerRuntimeOptions): Promise<void> {
  if (!options.databaseUrl) {
    throw new Error("DATABASE_URL is required to run the outbox worker.");
  }

  const pool = options.createPool(options.databaseUrl);
  const worker = options.createWorker(pool);
  const shutdownTimeoutMilliseconds =
    options.shutdownTimeoutMilliseconds ?? defaultShutdownTimeoutMilliseconds;
  let shutdownPromise: Promise<void> | null = null;
  let poolClose: Promise<void> | null = null;
  let announceShutdown: (() => void) | undefined;
  const shutdownRequested = new Promise<void>((resolve) => {
    announceShutdown = resolve;
  });

  const closePool = (): Promise<void> => {
    poolClose ??= pool.end();
    return poolClose;
  };

  const beginShutdown = (): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;

    worker.stopClaiming();
    const gracefulShutdown = (async () => {
      const failures: unknown[] = [];
      try {
        await worker.waitForCurrentBatch();
      } catch (error) {
        failures.push(error);
      }
      try {
        await closePool();
      } catch (error) {
        failures.push(error);
      }

      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) {
        throw new AggregateError(failures, "Outbox worker shutdown failed.");
      }
    })();
    shutdownPromise = withinDeadline(
      gracefulShutdown,
      shutdownTimeoutMilliseconds,
    ).catch((error: unknown) => {
      if (error instanceof ShutdownDeadlineError) {
        options.lifecycle.exit(1);
        return;
      }
      throw error;
    });
    announceShutdown?.();
    return shutdownPromise;
  };

  const requestShutdown = () => {
    void beginShutdown().catch(() => undefined);
  };
  const removeSignalHandlers = () => {
    options.lifecycle.off("SIGTERM", requestShutdown);
    options.lifecycle.off("SIGINT", requestShutdown);
  };

  options.lifecycle.on("SIGTERM", requestShutdown);
  options.lifecycle.on("SIGINT", requestShutdown);

  const runResult = worker.run(options.workerPollMilliseconds).then(
    () => ({ status: "completed" as const }),
    (error: unknown) => ({ status: "failed" as const, error }),
  );

  try {
    const outcome = await Promise.race([
      runResult,
      shutdownRequested.then(() => ({ status: "shutdown" as const })),
    ]);
    if (outcome.status === "failed") {
      await beginShutdown();
      throw outcome.error;
    }
    await beginShutdown();
  } finally {
    removeSignalHandlers();
  }
}

export function main(): Promise<void> {
  const workerConfig = parseWorkerConfig(process.env);
  const lifecycle: WorkerLifecycle = {
    on: (signal, listener) => process.on(signal, listener),
    off: (signal, listener) => process.off(signal, listener),
    exit: (code) => process.exit(code),
  };

  return runWorkerRuntime({
    databaseUrl: workerConfig.databaseUrl,
    workerPollMilliseconds: workerConfig.workerPollMilliseconds,
    createPool: createPostgreSqlPool,
    createWorker: (pool) =>
      new OutboxWorker({
        pool: pool as Pool,
        handlers: createProductionOutboxHandlers(),
      }),
    lifecycle,
  });
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
