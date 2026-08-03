import { randomUUID } from "node:crypto";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import { describe, expect, it, type TestContext } from "vitest";
import { createPool } from "../../src/server/platform/db/client.js";
import { runMigrations } from "../../src/server/platform/db/migrate.js";
import {
  OutboxWorker,
  calculateRetryDelayMs,
  type OutboxEvent,
  type OutboxHandler,
} from "../../src/worker/outbox-worker.js";
import {
  createTemporaryDatabase,
  PostgreSqlUnavailableError,
} from "../helpers/database.js";

const now = new Date("2026-08-02T19:00:00.000Z");
const organizationId = "00000000-0000-4000-8000-000000000001";

type StoredEvent = {
  id: string;
  organization_id: string;
  actor_id: string;
  request_id: string;
  event_type: string;
  aggregate_type: string;
  aggregate_id: string;
  schema_version: number;
  payload: Record<string, unknown>;
  available_at: Date;
  attempt_count: number;
  processing_started_at: Date | null;
  processing_token: string | null;
  published_at: Date | null;
  terminal_at: Date | null;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
};

function storedEvent(overrides: Partial<StoredEvent> = {}): StoredEvent {
  return {
    id: "10000000-0000-4000-8000-000000000001",
    organization_id: organizationId,
    actor_id: "20000000-0000-4000-8000-000000000001",
    request_id: "30000000-0000-4000-8000-000000000001",
    event_type: "location-pursuit.updated.v1",
    aggregate_type: "location-pursuit",
    aggregate_id: "40000000-0000-4000-8000-000000000001",
    schema_version: 1,
    payload: { name: "Beverly Hills" },
    available_at: new Date(now.getTime() - 1_000),
    attempt_count: 0,
    processing_started_at: null,
    processing_token: null,
    published_at: null,
    terminal_at: null,
    last_error: null,
    created_at: new Date(now.getTime() - 2_000),
    updated_at: new Date(now.getTime() - 2_000),
    ...overrides,
  };
}

function cloneEvents(events: StoredEvent[]): StoredEvent[] {
  return structuredClone(events);
}

class TransactionalOutboxDatabase {
  readonly statements: string[] = [];
  private committed: StoredEvent[];
  private transaction: StoredEvent[] | null = null;
  private readonly failureRejections = new Map<
    string,
    { error: Error; observed: () => void }
  >();

  constructor(events: StoredEvent[]) {
    this.committed = cloneEvents(events);
  }

  readonly client = {
    query: async <Row extends QueryResultRow = QueryResultRow>(
      sql: string,
      values: unknown[] = [],
    ) => {
      const normalized = sql.replace(/\s+/g, " ").trim();
      this.statements.push(normalized);

      if (normalized === "BEGIN") {
        this.transaction = cloneEvents(this.committed);
        return { rows: [], rowCount: null };
      }
      if (normalized === "COMMIT") {
        if (!this.transaction) throw new Error("No active transaction");
        this.committed = this.transaction;
        this.transaction = null;
        return { rows: [], rowCount: null };
      }
      if (normalized === "ROLLBACK") {
        this.transaction = null;
        return { rows: [], rowCount: null };
      }

      const events = this.transaction ?? this.committed;
      if (normalized.startsWith("SELECT * FROM outbox_events")) {
        expect(normalized).toBe(
          "SELECT * FROM outbox_events WHERE published_at IS NULL AND terminal_at IS NULL AND available_at <= now() AND (processing_started_at IS NULL OR processing_started_at < now() - interval '5 minutes') ORDER BY available_at, created_at FOR UPDATE SKIP LOCKED LIMIT $1",
        );
        const [limit] = values as [number];
        const rows = events
          .filter(
            (event) =>
              event.published_at === null &&
              event.terminal_at === null &&
              event.available_at <= now &&
              (event.processing_started_at === null ||
                event.processing_started_at.getTime() < now.getTime() - 5 * 60_000),
          )
          .sort(
            (left, right) =>
              left.available_at.getTime() - right.available_at.getTime() ||
              left.created_at.getTime() - right.created_at.getTime(),
          )
          .slice(0, limit);
        return { rows: cloneEvents(rows) as Row[], rowCount: rows.length };
      }
      if (normalized.startsWith("UPDATE outbox_events SET processing_started_at")) {
        const [startedAt, token, id] = values as [Date, string, string];
        const event = events.find((candidate) => candidate.id === id);
        if (!event) return { rows: [], rowCount: 0 };
        event.processing_started_at = startedAt;
        event.processing_token = token;
        event.updated_at = startedAt;
        return { rows: [], rowCount: 1 };
      }
      if (normalized.includes("SET published_at = $3")) {
        const [id, token, publishedAt] = values as [string, string, Date];
        const event = events.find(
          (candidate) =>
            candidate.id === id &&
            candidate.processing_token === token &&
            candidate.published_at === null &&
            candidate.terminal_at === null,
        );
        if (!event) return { rows: [], rowCount: 0 };
        event.published_at = publishedAt;
        event.processing_started_at = null;
        event.processing_token = null;
        event.last_error = null;
        event.updated_at = publishedAt;
        return { rows: [], rowCount: 1 };
      }
      if (normalized.includes("SET attempt_count = attempt_count + 1")) {
        const [id, token, error, availableAt, terminalAt, updatedAt] = values as [
          string,
          string,
          string,
          Date,
          Date | null,
          Date,
        ];
        const rejection = this.failureRejections.get(id);
        if (rejection) {
          rejection.observed();
          throw rejection.error;
        }
        const event = events.find(
          (candidate) =>
            candidate.id === id &&
            candidate.processing_token === token &&
            candidate.published_at === null &&
            candidate.terminal_at === null,
        );
        if (!event) return { rows: [], rowCount: 0 };
        event.attempt_count += 1;
        event.last_error = error;
        event.available_at = availableAt;
        event.terminal_at = terminalAt;
        event.processing_started_at = null;
        event.processing_token = null;
        event.updated_at = updatedAt;
        return { rows: [], rowCount: 1 };
      }

      throw new Error(`Unexpected query: ${normalized}`);
    },
    release: () => undefined,
  } as unknown as PoolClient;

  readonly pool = {
    connect: async () => this.client,
  } as unknown as Pool;

  event(id = this.committed[0]?.id): StoredEvent {
    const event = this.committed.find((candidate) => candidate.id === id);
    if (!event) throw new Error(`Missing event ${id}`);
    return event;
  }

  replaceLease(id: string, token: string): void {
    const event = this.event(id);
    event.processing_token = token;
    event.processing_started_at = now;
  }

  rejectFailurePersistence(
    id: string,
    error: Error,
    observed: () => void,
  ): void {
    this.failureRejections.set(id, { error, observed });
  }
}

function worker(
  database: TransactionalOutboxDatabase,
  handlers: Record<string, OutboxHandler>,
  tokens = ["50000000-0000-4000-8000-000000000001"],
): OutboxWorker {
  let tokenIndex = 0;
  return new OutboxWorker({
    pool: database.pool,
    handlers,
    clock: () => new Date(now),
    createToken: () => tokens[tokenIndex++] ?? randomUUID(),
  });
}

describe("outbox worker", () => {
  it("claims no more than 25 events in one batch", async () => {
    const events = Array.from({ length: 26 }, (_unused, index) =>
      storedEvent({
        id: `10000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
        created_at: new Date(now.getTime() - 30_000 + index),
      }),
    );
    const database = new TransactionalOutboxDatabase(events);
    const handled: string[] = [];
    const subject = worker(database, {
      "location-pursuit.updated.v1": async (event) => {
        handled.push(event.id);
      },
    });

    await expect(subject.runOnce()).resolves.toBe(25);
    expect(handled).toEqual(events.slice(0, 25).map((event) => event.id));
    expect(database.event(events[25]!.id).published_at).toBeNull();
  });

  it("claims with the bounded SKIP LOCKED query and publishes a successful event", async () => {
    const database = new TransactionalOutboxDatabase([storedEvent()]);
    const received: Array<{ event: OutboxEvent; idempotencyKey: string }> = [];
    const subject = worker(database, {
      "location-pursuit.updated.v1": async (event, context) => {
        received.push({ event, idempotencyKey: context.idempotencyKey });
      },
    });

    await expect(subject.runOnce()).resolves.toBe(1);

    expect(received).toHaveLength(1);
    expect(received[0]?.event.id).toBe(database.event().id);
    expect(received[0]?.idempotencyKey).toBe(database.event().id);
    expect(database.event()).toMatchObject({
      published_at: now,
      processing_started_at: null,
      processing_token: null,
      last_error: null,
    });
    expect(database.statements.some((statement) => statement.includes("LIMIT $1"))).toBe(true);
  });

  it("records a bounded failure and schedules exact exponential backoff", async () => {
    const database = new TransactionalOutboxDatabase([storedEvent()]);
    const subject = worker(database, {
      "location-pursuit.updated.v1": async () => {
        throw new Error("x".repeat(2_500));
      },
    });

    await expect(subject.runOnce()).resolves.toBe(1);

    expect(database.event()).toMatchObject({
      attempt_count: 1,
      available_at: new Date(now.getTime() + 10_000),
      processing_started_at: null,
      processing_token: null,
      published_at: null,
      terminal_at: null,
    });
    expect(database.event().last_error).toHaveLength(2_000);
    expect(calculateRetryDelayMs(1)).toBe(10_000);
    expect(calculateRetryDelayMs(9)).toBe(15 * 60_000);
  });

  it.each([
    ["hostile proxy", new Proxy({}, {
      getPrototypeOf: () => {
        throw new Error("getPrototypeOf exploded");
      },
      get: () => {
        throw new Error("property access exploded");
      },
    })],
    ["throwing toString", { toString: () => { throw new Error("toString exploded"); } }],
    ["non-string Error.message", Object.assign(new Error(), { message: { secret: true } })],
    ["symbol", Symbol("handler failure")],
    ["null", null],
    ["undefined", undefined],
  ])("normalizes %s failures and always clears the lease", async (_label, thrown) => {
    const database = new TransactionalOutboxDatabase([storedEvent()]);
    const subject = worker(database, {
      "location-pursuit.updated.v1": async () => {
        throw thrown;
      },
    });

    await expect(subject.runOnce()).resolves.toBe(1);

    expect(database.event()).toMatchObject({
      attempt_count: 1,
      last_error: "Unknown outbox processing error.",
      processing_started_at: null,
      processing_token: null,
      published_at: null,
    });
    expect(database.event().last_error!.length).toBeLessThanOrEqual(2_000);
  });

  it("keeps the batch pending until every claimed event settles", async () => {
    const failingEvent = storedEvent({
      id: "10000000-0000-4000-8000-000000000010",
      created_at: new Date(now.getTime() - 3_000),
    });
    const blockedEvent = storedEvent({
      id: "10000000-0000-4000-8000-000000000011",
      created_at: new Date(now.getTime() - 2_000),
    });
    const database = new TransactionalOutboxDatabase([failingEvent, blockedEvent]);
    let observePersistenceFailure: (() => void) | undefined;
    const persistenceFailed = new Promise<void>((resolve) => {
      observePersistenceFailure = resolve;
    });
    database.rejectFailurePersistence(
      failingEvent.id,
      new Error("failure write unavailable"),
      () => observePersistenceFailure?.(),
    );
    let releaseSibling: (() => void) | undefined;
    const siblingCanFinish = new Promise<void>((resolve) => {
      releaseSibling = resolve;
    });
    const subject = worker(database, {
      "location-pursuit.updated.v1": async (event) => {
        if (event.id === failingEvent.id) throw new Error("handler failed");
        await siblingCanFinish;
      },
    });

    let batchSettled = false;
    const batch = subject.runOnce().finally(() => {
      batchSettled = true;
    });
    let shutdownSettled = false;
    const shutdownWait = subject.waitForCurrentBatch(1_000).then(
      () => {
        shutdownSettled = true;
        return undefined;
      },
      (error: unknown) => {
        shutdownSettled = true;
        throw error;
      },
    );
    await persistenceFailed;
    await Promise.resolve();

    try {
      expect(batchSettled).toBe(false);
      expect(shutdownSettled).toBe(false);
    } finally {
      releaseSibling?.();
    }
    await expect(batch).rejects.toBeInstanceOf(AggregateError);
    await expect(shutdownWait).rejects.toBeInstanceOf(AggregateError);
    expect(database.event(blockedEvent.id).published_at).toEqual(now);
  });

  it("marks the tenth failure terminal and never selects it again", async () => {
    const database = new TransactionalOutboxDatabase([
      storedEvent({ attempt_count: 9 }),
    ]);
    const subject = worker(database, {
      "location-pursuit.updated.v1": async () => {
        throw new Error("permanent failure");
      },
    });

    await expect(subject.runOnce()).resolves.toBe(1);
    expect(database.event()).toMatchObject({
      attempt_count: 10,
      terminal_at: now,
      processing_started_at: null,
      processing_token: null,
    });
    await expect(subject.runOnce()).resolves.toBe(0);
  });

  it("retries an expired lease but leaves a current lease alone", async () => {
    const expired = storedEvent({
      id: "10000000-0000-4000-8000-000000000002",
      processing_started_at: new Date(now.getTime() - 5 * 60_000 - 1),
      processing_token: "50000000-0000-4000-8000-000000000002",
    });
    const current = storedEvent({
      id: "10000000-0000-4000-8000-000000000003",
      processing_started_at: new Date(now.getTime() - 5 * 60_000),
      processing_token: "50000000-0000-4000-8000-000000000003",
    });
    const database = new TransactionalOutboxDatabase([expired, current]);
    const handled: string[] = [];
    const subject = worker(database, {
      "location-pursuit.updated.v1": async (event) => {
        handled.push(event.id);
      },
    });

    await expect(subject.runOnce()).resolves.toBe(1);
    expect(handled).toEqual([expired.id]);
    expect(database.event(expired.id).published_at).toEqual(now);
    expect(database.event(current.id).published_at).toBeNull();
  });

  it("treats an unknown versioned event type as a retryable failure", async () => {
    const database = new TransactionalOutboxDatabase([
      storedEvent({ event_type: "unknown.event.v1" }),
    ]);

    await expect(worker(database, {}).runOnce()).resolves.toBe(1);

    expect(database.event().attempt_count).toBe(1);
    expect(database.event().published_at).toBeNull();
    expect(database.event().last_error).toContain("No handler registered for unknown.event.v1");
  });

  it("does not dispatch event types inherited from the handler registry prototype", async () => {
    const database = new TransactionalOutboxDatabase([
      storedEvent({ event_type: "toString" }),
    ]);

    await expect(worker(database, {}).runOnce()).resolves.toBe(1);

    expect(database.event().attempt_count).toBe(1);
    expect(database.event().published_at).toBeNull();
    expect(database.event().last_error).toContain("No handler registered for toString");
  });

  it("does not let a stale worker finish a lease reclaimed with a new token", async () => {
    const event = storedEvent();
    const database = new TransactionalOutboxDatabase([event]);
    const subject = worker(database, {
      "location-pursuit.updated.v1": async () => {
        database.replaceLease(event.id, "60000000-0000-4000-8000-000000000001");
      },
    });

    await expect(subject.runOnce()).resolves.toBe(1);

    expect(database.event().published_at).toBeNull();
    expect(database.event().processing_token).toBe(
      "60000000-0000-4000-8000-000000000001",
    );
  });

  it("stops new claims while allowing the current batch to finish", async () => {
    const database = new TransactionalOutboxDatabase([storedEvent()]);
    let releaseHandler: (() => void) | undefined;
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const handlerCanFinish = new Promise<void>((resolve) => {
      releaseHandler = resolve;
    });
    const subject = worker(database, {
      "location-pursuit.updated.v1": async () => {
        markStarted?.();
        await handlerCanFinish;
      },
    });

    const batch = subject.runOnce();
    await started;
    subject.stopClaiming();

    await expect(subject.runOnce()).resolves.toBe(0);
    const idle = subject.waitForCurrentBatch(100);
    releaseHandler?.();
    await expect(Promise.all([batch, idle])).resolves.toEqual([1, undefined]);
    expect(database.event().published_at).toEqual(now);
  });
});

async function withTemporaryPostgreSql(
  context: TestContext,
  operation: (pool: Pool) => Promise<void>,
): Promise<void> {
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
    await operation(pool);
  } finally {
    await pool.end();
    await temporaryDatabase.cleanup();
  }
}

async function seedPostgreSqlEvent(pool: Pool): Promise<string> {
  const actorId = randomUUID();
  const eventId = randomUUID();
  await pool.query(
    `INSERT INTO actors
       (id, organization_id, type, role, service_key_prefix, service_key_hash, display_name)
     VALUES ($1, $2, 'automation', 'member', $3, $4, 'Worker test')`,
    [actorId, organizationId, randomUUID().replaceAll("-", "").slice(0, 12), "a".repeat(64)],
  );
  await pool.query(
    `INSERT INTO outbox_events
       (id, organization_id, actor_id, request_id, event_type, aggregate_type,
        aggregate_id, schema_version, payload)
     VALUES ($1, $2, $3, $4, 'location-pursuit.updated.v1',
             'location-pursuit', $5, 1, '{}'::jsonb)`,
    [eventId, organizationId, actorId, randomUUID(), randomUUID()],
  );
  return eventId;
}

function withClaimInterceptor(
  pool: Pool,
  intercept: <Row extends QueryResultRow>(
    next: () => Promise<{ rows: Row[]; rowCount: number | null }>,
  ) => Promise<{ rows: Row[]; rowCount: number | null }>,
): Pool {
  return {
    connect: async () => {
      const client = await pool.connect();
      return new Proxy(client, {
        get(target, property, receiver) {
          if (property === "query") {
            return async <Row extends QueryResultRow = QueryResultRow>(
              sql: string,
              values: unknown[] = [],
            ) => {
              const next = () => target.query<Row>(sql, values);
              return sql.includes("FOR UPDATE SKIP LOCKED")
                ? intercept(next)
                : next();
            };
          }
          const value = Reflect.get(target, property, receiver) as unknown;
          return typeof value === "function"
            ? value.bind(target)
            : value;
        },
      });
    },
  } as unknown as Pool;
}

describe("outbox worker PostgreSQL concurrency", () => {
  it("allows only one of two workers to claim and handle a pending event", async (context) => {
    await withTemporaryPostgreSql(context, async (pool) => {
      const eventId = await seedPostgreSqlEvent(pool);
      const handled: string[] = [];
      const handler: OutboxHandler = async (event, handlerContext) => {
        handled.push(`${event.id}:${handlerContext.idempotencyKey}`);
      };
      let markFirstLocked: (() => void) | undefined;
      const firstLocked = new Promise<void>((resolve) => {
        markFirstLocked = resolve;
      });
      let markSecondSelected: (() => void) | undefined;
      const secondSelected = new Promise<void>((resolve) => {
        markSecondSelected = resolve;
      });
      const firstPool = withClaimInterceptor(pool, async (next) => {
        const result = await next();
        markFirstLocked?.();
        await secondSelected;
        return result;
      });
      const secondPool = withClaimInterceptor(pool, async (next) => {
        const result = await next();
        markSecondSelected?.();
        return result;
      });
      const createSubject = (workerPool: Pool) =>
        new OutboxWorker({
          pool: workerPool,
          handlers: { "location-pursuit.updated.v1": handler },
        });

      const firstRun = createSubject(firstPool).runOnce();
      await firstLocked;
      const secondRun = createSubject(secondPool).runOnce();
      const results = await Promise.all([firstRun, secondRun]);

      expect(results.reduce((sum, count) => sum + count, 0)).toBe(1);
      expect(handled).toEqual([`${eventId}:${eventId}`]);
      const persisted = await pool.query<{
        published_at: Date | null;
        processing_started_at: Date | null;
        processing_token: string | null;
      }>(
        `SELECT published_at, processing_started_at, processing_token
           FROM outbox_events
          WHERE id = $1`,
        [eventId],
      );
      expect(persisted.rows[0]?.published_at).toBeInstanceOf(Date);
      expect(persisted.rows[0]?.processing_started_at).toBeNull();
      expect(persisted.rows[0]?.processing_token).toBeNull();
    });
  });
});
