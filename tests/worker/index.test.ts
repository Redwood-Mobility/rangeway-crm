import { describe, expect, it } from "vitest";
import {
  runWorkerRuntime,
  type OutboxRuntimeWorker,
  type WorkerLifecycle,
  type WorkerPool,
} from "../../src/worker/index.js";

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
