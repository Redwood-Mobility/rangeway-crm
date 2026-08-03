import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { describe, expect, it, type TestContext } from "vitest";
import { createPool } from "../../src/server/platform/db/client.js";
import { runMigrations } from "../../src/server/platform/db/migrate.js";
import {
  createProductionOutboxHandlers,
  runWorkerRuntime,
  type OutboxRuntimeWorker,
  type WorkerLifecycle,
  type WorkerPool,
} from "../../src/worker/index.js";
import { OutboxWorker } from "../../src/worker/outbox-worker.js";
import { parseWorkerConfig } from "../../src/worker/config.js";
import {
  createTemporaryDatabase,
  PostgreSqlUnavailableError,
} from "../helpers/database.js";

type Signal = "SIGINT" | "SIGTERM";

class TestLifecycle implements WorkerLifecycle {
  readonly exitCodes: number[] = [];
  readonly addedSignals: Signal[] = [];
  readonly removedSignals: Signal[] = [];
  private readonly listeners = new Map<Signal, Set<() => void>>();

  on(signal: Signal, listener: () => void): void {
    this.addedSignals.push(signal);
    const signalListeners = this.listeners.get(signal) ?? new Set();
    signalListeners.add(listener);
    this.listeners.set(signal, signalListeners);
  }

  off(signal: Signal, listener: () => void): void {
    this.removedSignals.push(signal);
    this.listeners.get(signal)?.delete(listener);
  }

  exit(code: number): void {
    this.exitCodes.push(code);
  }

  emit(signal: Signal): void {
    for (const listener of this.listeners.get(signal) ?? []) listener();
  }
}

class TestPool implements WorkerPool {
  endCalls = 0;
  endPromise: Promise<void> = Promise.resolve();

  end(): Promise<void> {
    this.endCalls += 1;
    return this.endPromise;
  }
}

class TestWorker implements OutboxRuntimeWorker {
  stopCalls = 0;
  waitCalls = 0;
  runPromise: Promise<void>;
  currentBatch: Promise<void> = Promise.resolve();
  private finishRun: (() => void) | undefined;

  constructor(runImmediately = false) {
    this.runPromise = runImmediately
      ? Promise.resolve()
      : new Promise<void>((resolve) => {
          this.finishRun = resolve;
        });
  }

  run(_pollMilliseconds: number): Promise<void> {
    return this.runPromise;
  }

  stopClaiming(): void {
    this.stopCalls += 1;
    this.finishRun?.();
  }

  async waitForCurrentBatch(): Promise<void> {
    this.waitCalls += 1;
    await this.currentBatch;
  }
}

function runtime(
  worker: TestWorker,
  pool: TestPool,
  lifecycle: TestLifecycle,
  shutdownTimeoutMilliseconds = 100,
): Promise<void> {
  return runWorkerRuntime({
    databaseUrl: "postgres://atlas:atlas@localhost:5432/atlas",
    workerPollMilliseconds: 1,
    shutdownTimeoutMilliseconds,
    createPool: () => pool,
    createWorker: () => worker,
    lifecycle,
  });
}

describe("outbox worker entrypoint lifecycle", () => {
  it("requires the production worker database credential to use atlas_worker", () => {
    expect(parseWorkerConfig({
      NODE_ENV: "production",
      DATABASE_URL: "postgresql://atlas_worker:worker-password-0123456789@db:5432/atlas",
      WORKER_POLL_MS: "2500",
    })).toEqual({
      databaseUrl: "postgresql://atlas_worker:worker-password-0123456789@db:5432/atlas",
      workerPollMilliseconds: 2500,
    });
    expect(() => parseWorkerConfig({
      NODE_ENV: "production",
      DATABASE_URL: "postgresql://atlas_migrator:migrator-password-0123456789@db:5432/atlas",
    })).toThrow(/atlas_worker/);
  });

  it.each([
    "http://atlas_worker:safe-password@db:5432/atlas",
    "postgresql://atlas_worker:safe-password-0123456789@postgres:5432/atlas",
    "postgresql://atlas_worker:safe-password-0123456789@db:5432/postgres",
    "postgresql://atlas_worker:too-short@db:5432/atlas",
    "postgresql://atlas_worker:p%40ssword@db:5432/atlas",
    "postgresql://atlas_worker:safe-password-0123456789@db/atlas",
    "postgresql://atlas_worker:safe-password-0123456789@db:6432/atlas",
  ])("rejects an unsafe production worker database URL without exposing it", (databaseUrl) => {
    expect(() =>
      parseWorkerConfig({ NODE_ENV: "production", DATABASE_URL: databaseUrl }),
    ).toThrow(/Production worker DATABASE_URL/);
    try {
      parseWorkerConfig({ NODE_ENV: "production", DATABASE_URL: databaseUrl });
    } catch (error) {
      expect(JSON.stringify(error)).not.toContain(databaseUrl);
    }
  });

  it("registers an explicit production handler for every event the foundation emits", async () => {
    const handlers = createProductionOutboxHandlers();
    expect(Object.keys(handlers).sort()).toEqual([
      "activity.recorded.v1",
      "blocker.changed.v1",
      "counterparty.changed.v1",
      "decision.changed.v1",
      "identity.google-linked.v1",
      "identity.google-profile-updated.v1",
      "identity.owner-provisioned.v1",
      "identity.service-actor-created.v1",
      "identity.service-actor-disabled.v1",
      "label.changed.v1",
      "milestone.changed.v1",
      "organization.updated.v1",
      "person.changed.v1",
      "project.changed.v1",
      "project.health-changed.v1",
      "project.membership-changed.v1",
      "project.relationship-changed.v1",
      "risk.changed.v1",
      "saved-view.changed.v1",
      "work-item.changed.v1",
      "work-item.dependency-changed.v1",
      "workstream.changed.v1",
    ]);
    for (const eventType of Object.keys(handlers)) {
      await expect(handlers[eventType as keyof typeof handlers]!(
        {
        id: "10000000-0000-4000-8000-000000000001",
        organizationId: "00000000-0000-4000-8000-000000000001",
        actorId: "20000000-0000-4000-8000-000000000001",
        requestId: "30000000-0000-4000-8000-000000000001",
        eventType,
        aggregateType: "organization",
        aggregateId: "00000000-0000-4000-8000-000000000001",
        schemaVersion: 1,
        payload: { name: "Rangeway" },
        availableAt: new Date(),
        attemptCount: 0,
        processingStartedAt: new Date(),
        processingToken: randomUUID(),
        createdAt: new Date(),
        },
        { idempotencyKey: "10000000-0000-4000-8000-000000000001" },
      )).resolves.toBeUndefined();
    }
  });

  it("publishes a foundation event through the actual production registry", async (context: TestContext) => {
    let temporaryDatabase;
    try {
      temporaryDatabase = await createTemporaryDatabase();
    } catch (error) {
      if (error instanceof PostgreSqlUnavailableError) {
        context.skip(error.message);
        return;
      }
      throw error;
    }

    const pool = createPool(temporaryDatabase.databaseUrl);
    try {
      await runMigrations(pool);
      const actorId = randomUUID();
      const eventId = randomUUID();
      const organizationId = "00000000-0000-4000-8000-000000000001";
      await pool.query(
        `INSERT INTO actors
           (id, organization_id, type, role, service_key_prefix, service_key_hash, display_name)
         VALUES ($1, $2, 'automation', 'member', $3, $4, 'Registry test')`,
        [actorId, organizationId, randomUUID().replaceAll("-", "").slice(0, 12), "a".repeat(64)],
      );
      await pool.query(
        `INSERT INTO outbox_events
           (id, organization_id, actor_id, request_id, event_type, aggregate_type,
            aggregate_id, schema_version, payload)
         VALUES ($1, $2, $3, $4, 'organization.updated.v1', 'organization', $2, 1, $5)`,
        [eventId, organizationId, actorId, randomUUID(), { organizationId, name: "Rangeway" }],
      );

      await new OutboxWorker({
        pool: pool as Pool,
        handlers: createProductionOutboxHandlers(),
      }).runOnce();

      const event = await pool.query<{ published_at: Date | null; terminal_at: Date | null }>(
        "SELECT published_at, terminal_at FROM outbox_events WHERE id = $1",
        [eventId],
      );
      expect(event.rows[0].published_at).toBeInstanceOf(Date);
      expect(event.rows[0].terminal_at).toBeNull();
    } finally {
      await pool.end();
      await temporaryDatabase.cleanup();
    }
  });

  it("wires both signals and performs one clean shutdown for repeated signals", async () => {
    const lifecycle = new TestLifecycle();
    const pool = new TestPool();
    const worker = new TestWorker();
    let releaseBatch: (() => void) | undefined;
    worker.currentBatch = new Promise<void>((resolve) => {
      releaseBatch = resolve;
    });

    const running = runtime(worker, pool, lifecycle);
    await Promise.resolve();
    lifecycle.emit("SIGTERM");
    lifecycle.emit("SIGINT");
    releaseBatch?.();
    await running;

    expect(lifecycle.addedSignals).toEqual(["SIGTERM", "SIGINT"]);
    expect(lifecycle.removedSignals).toEqual(["SIGTERM", "SIGINT"]);
    expect(worker.stopCalls).toBe(1);
    expect(worker.waitCalls).toBe(1);
    expect(pool.endCalls).toBe(1);
    expect(lifecycle.exitCodes).toEqual([]);
  });

  it("bounds batch drain and pool close with one deadline and forces exit 1", async () => {
    const lifecycle = new TestLifecycle();
    const pool = new TestPool();
    const worker = new TestWorker();
    worker.currentBatch = new Promise<void>(() => undefined);

    const running = runtime(worker, pool, lifecycle, 5);
    await Promise.resolve();
    lifecycle.emit("SIGTERM");
    await running;

    expect(worker.stopCalls).toBe(1);
    expect(worker.waitCalls).toBe(1);
    expect(pool.endCalls).toBe(0);
    expect(lifecycle.exitCodes).toEqual([1]);
  });

  it("includes a hanging pool drain in the same forced-exit deadline", async () => {
    const lifecycle = new TestLifecycle();
    const pool = new TestPool();
    pool.endPromise = new Promise<void>(() => undefined);
    const worker = new TestWorker();

    const running = runtime(worker, pool, lifecycle, 5);
    await Promise.resolve();
    lifecycle.emit("SIGINT");
    await running;

    expect(worker.waitCalls).toBe(1);
    expect(pool.endCalls).toBe(1);
    expect(lifecycle.exitCodes).toEqual([1]);
  });

  it("still closes the pool when the settled batch reports a failure", async () => {
    const lifecycle = new TestLifecycle();
    const pool = new TestPool();
    const worker = new TestWorker();
    worker.currentBatch = Promise.reject(new AggregateError([], "batch failed"));
    void worker.currentBatch.catch(() => undefined);

    const running = runtime(worker, pool, lifecycle);
    await Promise.resolve();
    lifecycle.emit("SIGTERM");

    await expect(running).rejects.toThrow("batch failed");
    expect(pool.endCalls).toBe(1);
    expect(lifecycle.exitCodes).toEqual([]);
  });

  it("stops, drains, and closes cleanly when the worker loop completes normally", async () => {
    const lifecycle = new TestLifecycle();
    const pool = new TestPool();
    const worker = new TestWorker(true);

    await runtime(worker, pool, lifecycle);

    expect(worker.stopCalls).toBe(1);
    expect(worker.waitCalls).toBe(1);
    expect(pool.endCalls).toBe(1);
    expect(lifecycle.exitCodes).toEqual([]);
    expect(lifecycle.removedSignals).toEqual(["SIGTERM", "SIGINT"]);
  });
});
