import { randomUUID } from "node:crypto";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import { describe, expect, it, type TestContext } from "vitest";
import type { ActorContext } from "../../src/shared/identity.js";
import type { DbClient } from "../../src/server/platform/db/client.js";
import { createPool } from "../../src/server/platform/db/client.js";
import { runMigrations } from "../../src/server/platform/db/migrate.js";
import {
  mutateIdempotentlyWithAuditAndEvent,
} from "../../src/server/modules/events/outbox.service.js";
import { OrganizationService } from "../../src/server/modules/organizations/organization.service.js";
import {
  createTemporaryDatabase,
  PostgreSqlUnavailableError,
} from "../helpers/database.js";

type StoredKey = {
  organizationId: string;
  actorId: string;
  operation: string;
  key: string;
  requestHash: string;
  responseBody: Record<string, unknown> | null;
  completedAt: Date | null;
};

type State = {
  keys: Map<string, StoredKey>;
  businessWrites: number;
  audits: number;
  events: number;
};

function cloneState(state: State): State {
  return {
    keys: new Map([...state.keys].map(([key, value]) => [key, structuredClone(value)])),
    businessWrites: state.businessWrites,
    audits: state.audits,
    events: state.events,
  };
}

class IdempotencyDatabase {
  private committed: State = {
    keys: new Map(),
    businessWrites: 0,
    audits: 0,
    events: 0,
  };
  private transaction: State | null = null;

  readonly client = {
    query: async <Row extends QueryResultRow = QueryResultRow>(
      sql: string,
      values: unknown[] = [],
    ) => {
      const normalized = sql.replace(/\s+/g, " ").trim();
      if (normalized === "BEGIN") {
        this.transaction = cloneState(this.committed);
        return { rows: [], rowCount: null };
      }
      if (normalized === "COMMIT") {
        if (!this.transaction) throw new Error("No transaction");
        this.committed = this.transaction;
        this.transaction = null;
        return { rows: [], rowCount: null };
      }
      if (normalized === "ROLLBACK") {
        this.transaction = null;
        return { rows: [], rowCount: null };
      }
      if (!this.transaction) throw new Error("Query outside transaction");

      if (normalized.startsWith("INSERT INTO api_idempotency_keys")) {
        const [organizationId, actorId, operation, key, requestHash, requestId] = values as string[];
        const scope = [organizationId, actorId, operation, key].join("|");
        if (this.transaction.keys.has(scope)) return { rows: [], rowCount: 0 };
        this.transaction.keys.set(scope, {
          organizationId,
          actorId,
          operation,
          key,
          requestHash,
          responseBody: null,
          completedAt: null,
        });
        return { rows: [{ request_id: requestId }] as Row[], rowCount: 1 };
      }
      if (normalized.startsWith("SELECT request_hash, response_body, completed_at FROM api_idempotency_keys")) {
        const [organizationId, actorId, operation, key] = values as string[];
        const record = this.transaction.keys.get([organizationId, actorId, operation, key].join("|"));
        const rows = record ? [{
          request_hash: record.requestHash,
          response_body: record.responseBody,
          completed_at: record.completedAt,
        }] : [];
        return { rows: rows as Row[], rowCount: rows.length };
      }
      if (normalized.startsWith("UPDATE api_idempotency_keys")) {
        const [organizationId, actorId, operation, key, requestHash, responseBody] = values as [
          string,
          string,
          string,
          string,
          string,
          Record<string, unknown>,
        ];
        const record = this.transaction.keys.get([organizationId, actorId, operation, key].join("|"));
        if (!record || record.requestHash !== requestHash || record.completedAt) {
          return { rows: [], rowCount: 0 };
        }
        record.responseBody = structuredClone(responseBody);
        record.completedAt = new Date();
        return { rows: [{ idempotency_key: key }] as Row[], rowCount: 1 };
      }
      if (normalized === "UPDATE business_probe SET writes = writes + 1") {
        this.transaction.businessWrites += 1;
        return { rows: [], rowCount: 1 };
      }
      if (normalized.startsWith("INSERT INTO audit_events")) {
        this.transaction.audits += 1;
        return { rows: [], rowCount: 1 };
      }
      if (normalized.startsWith("INSERT INTO outbox_events")) {
        this.transaction.events += 1;
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`Unexpected query: ${normalized}`);
    },
    release: () => undefined,
  } as unknown as PoolClient;

  readonly pool = { connect: async () => this.client } as unknown as Pool;

  counts() {
    return {
      keys: this.committed.keys.size,
      businessWrites: this.committed.businessWrites,
      audits: this.committed.audits,
      events: this.committed.events,
    };
  }
}

function actor(overrides: Partial<ActorContext> = {}): ActorContext {
  return {
    actorId: "10000000-0000-4000-8000-000000000001",
    actorType: "human",
    actorName: "Zak Winnick",
    organizationId: "00000000-0000-4000-8000-000000000001",
    role: "owner",
    requestId: randomUUID(),
    userId: "20000000-0000-4000-8000-000000000001",
    ...overrides,
  };
}

function mutation(context: ActorContext, value: string) {
  return async (client: DbClient) => {
    await client.query("UPDATE business_probe SET writes = writes + 1");
    return {
      value: { value },
      audit: {
        organizationId: context.organizationId,
        actorId: context.actorId,
        requestId: context.requestId,
        action: "probe.updated",
        resourceType: "organization",
        resourceId: context.organizationId,
        before: null,
        after: { value },
      },
      event: {
        organizationId: context.organizationId,
        actorId: context.actorId,
        requestId: context.requestId,
        eventType: "organization.updated.v1" as const,
        aggregateType: "organization",
        aggregateId: context.organizationId,
        schemaVersion: 1,
        payload: { value },
      },
    };
  };
}

describe("transactional mutation idempotency", () => {
  it("replays the stored successful result without duplicate business, audit, or outbox effects", async () => {
    const database = new IdempotencyDatabase();
    const firstActor = actor();
    const replayActor = actor({ requestId: randomUUID() });
    const options = {
      operation: "organization.rename.v1",
      key: "rename-rangeway-20260802",
      requestHash: "a".repeat(64),
    };

    const first = await mutateIdempotentlyWithAuditAndEvent(
      database.pool,
      firstActor,
      options,
      mutation(firstActor, "first result"),
    );
    const replay = await mutateIdempotentlyWithAuditAndEvent(
      database.pool,
      replayActor,
      options,
      mutation(replayActor, "must not execute"),
    );

    expect(first).toEqual({ value: "first result" });
    expect(replay).toEqual(first);
    expect(database.counts()).toEqual({ keys: 1, businessWrites: 1, audits: 1, events: 1 });
  });

  it("serializes concurrent identical organization requests into one committed effect", async (context: TestContext) => {
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
      await pool.query(
        `INSERT INTO actors
           (id, organization_id, type, role, service_key_prefix, service_key_hash, display_name)
         VALUES ($1, $2, 'agent', 'admin', $3, $4, 'Concurrent agent')`,
        [
          actorId,
          "00000000-0000-4000-8000-000000000001",
          randomUUID().replaceAll("-", "").slice(0, 12),
          "a".repeat(64),
        ],
      );
      const firstActor = actor({ actorId, actorType: "agent", userId: undefined });
      const secondActor = { ...firstActor, requestId: randomUUID() };
      const service = new OrganizationService(pool);

      const results = await Promise.all([
        service.rename(firstActor, firstActor.organizationId, "Rangeway Energy", "concurrent-rename-20260802"),
        service.rename(secondActor, secondActor.organizationId, "Rangeway Energy", "concurrent-rename-20260802"),
      ]);
      expect(results).toEqual([
        { id: firstActor.organizationId, name: "Rangeway Energy" },
        { id: firstActor.organizationId, name: "Rangeway Energy" },
      ]);

      const counts = await pool.query<{
        key_count: string;
        audit_count: string;
        event_count: string;
      }>(
        `SELECT
           (SELECT count(*)::text FROM api_idempotency_keys) AS key_count,
           (SELECT count(*)::text FROM audit_events) AS audit_count,
           (SELECT count(*)::text FROM outbox_events) AS event_count`,
      );
      expect(counts.rows).toEqual([{ key_count: "1", audit_count: "1", event_count: "1" }]);
    } finally {
      await pool.end();
      await temporaryDatabase.cleanup();
    }
  });

  it("returns a stable conflict for the same key with a different canonical request", async () => {
    const database = new IdempotencyDatabase();
    const context = actor();
    await mutateIdempotentlyWithAuditAndEvent(
      database.pool,
      context,
      { operation: "organization.rename.v1", key: "rename-rangeway-20260802", requestHash: "a".repeat(64) },
      mutation(context, "first result"),
    );

    await expect(mutateIdempotentlyWithAuditAndEvent(
      database.pool,
      actor({ requestId: randomUUID() }),
      { operation: "organization.rename.v1", key: "rename-rangeway-20260802", requestHash: "b".repeat(64) },
      mutation(context, "must not execute"),
    )).rejects.toMatchObject({
      status: 409,
      code: "CONFLICT",
      message: "Idempotency key was already used with a different request.",
    });
    expect(database.counts()).toEqual({ keys: 1, businessWrites: 1, audits: 1, events: 1 });
  });

  it("scopes keys by organization, actor, and operation", async () => {
    const database = new IdempotencyDatabase();
    const first = actor();
    const second = actor({ actorId: randomUUID(), requestId: randomUUID() });
    const common = { key: "shared-key-20260802", requestHash: "a".repeat(64) };

    await mutateIdempotentlyWithAuditAndEvent(database.pool, first, { ...common, operation: "organization.rename.v1" }, mutation(first, "one"));
    await mutateIdempotentlyWithAuditAndEvent(database.pool, second, { ...common, operation: "organization.rename.v1" }, mutation(second, "two"));
    await mutateIdempotentlyWithAuditAndEvent(database.pool, first, { ...common, operation: "organization.archive.v1" }, mutation(first, "three"));

    expect(database.counts()).toEqual({ keys: 3, businessWrites: 3, audits: 3, events: 3 });
  });

  it("rolls back the key reservation with all effects and permits a clean retry", async () => {
    const database = new IdempotencyDatabase();
    const context = actor();
    const options = { operation: "organization.rename.v1", key: "retry-key-20260802", requestHash: "a".repeat(64) };

    await expect(mutateIdempotentlyWithAuditAndEvent(
      database.pool,
      context,
      options,
      mutation(context, "uncommitted"),
      () => { throw new Error("forced precommit failure"); },
    )).rejects.toThrow("forced precommit failure");
    expect(database.counts()).toEqual({ keys: 0, businessWrites: 0, audits: 0, events: 0 });

    const retryActor = actor({ requestId: randomUUID() });
    await expect(mutateIdempotentlyWithAuditAndEvent(
      database.pool,
      retryActor,
      options,
      mutation(retryActor, "committed"),
    )).resolves.toEqual({ value: "committed" });
    expect(database.counts()).toEqual({ keys: 1, businessWrites: 1, audits: 1, events: 1 });
  });
});
