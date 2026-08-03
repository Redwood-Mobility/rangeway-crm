import { randomUUID } from "node:crypto";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import { describe, expect, it, type TestContext } from "vitest";
import type { ActorContext } from "../../src/shared/identity.js";
import {
  createPool,
  type DbClient,
} from "../../src/server/platform/db/client.js";
import { runMigrations } from "../../src/server/platform/db/migrate.js";
import { ApiError } from "../../src/server/platform/http/api-error.js";
import type { AuditInput } from "../../src/server/modules/audit/audit.repository.js";
import type { OutboxInput } from "../../src/server/modules/events/outbox.repository.js";
import { mutateWithAuditAndEvent } from "../../src/server/modules/events/outbox.service.js";
import {
  createTemporaryDatabase,
  PostgreSqlUnavailableError,
} from "../helpers/database.js";

interface OrganizationRecord {
  id: string;
  name: string;
  serviceKeyHash: string;
  localPasswordHash: string;
}

interface TransactionState {
  organizations: Map<string, OrganizationRecord>;
  auditEvents: AuditInput[];
  outboxEvents: OutboxInput[];
}

const rangewayOrganizationId = "00000000-0000-4000-8000-000000000001";
const otherOrganizationId = "00000000-0000-4000-8000-000000000002";

function cloneState(state: TransactionState): TransactionState {
  return {
    organizations: new Map(
      [...state.organizations].map(([id, organization]) => [
        id,
        { ...organization },
      ]),
    ),
    auditEvents: state.auditEvents.map((event) => structuredClone(event)),
    outboxEvents: state.outboxEvents.map((event) => structuredClone(event)),
  };
}

class TransactionalAtlasDatabase {
  readonly statements: string[] = [];
  private committed: TransactionState;
  private transaction: TransactionState | null = null;

  constructor() {
    this.committed = {
      organizations: new Map([
        [
          rangewayOrganizationId,
          {
            id: rangewayOrganizationId,
            name: "Rangeway",
            serviceKeyHash: "service-key-secret",
            localPasswordHash: "password-secret",
          },
        ],
        [
          otherOrganizationId,
          {
            id: otherOrganizationId,
            name: "Other organization",
            serviceKeyHash: "other-service-key-secret",
            localPasswordHash: "other-password-secret",
          },
        ],
      ]),
      auditEvents: [],
      outboxEvents: [],
    };
  }

  readonly client = {
    query: async <Row extends QueryResultRow = QueryResultRow>(
      sql: string,
      values: unknown[] = [],
    ) => {
      const normalized = sql.replace(/\s+/g, " ").trim();

      if (normalized === "BEGIN") {
        this.statements.push("BEGIN");
        this.transaction = cloneState(this.committed);
        return { rows: [], rowCount: null };
      }
      if (normalized === "COMMIT") {
        this.statements.push("COMMIT");
        if (!this.transaction) throw new Error("No active transaction");
        this.committed = this.transaction;
        this.transaction = null;
        return { rows: [], rowCount: null };
      }
      if (normalized === "ROLLBACK") {
        this.statements.push("ROLLBACK");
        this.transaction = null;
        return { rows: [], rowCount: null };
      }

      const state = this.activeState();
      if (normalized.startsWith("SELECT id, name FROM organizations")) {
        this.statements.push("organization.select");
        const [targetId, scopedOrganizationId] = values as [string, string];
        const organization = state.organizations.get(targetId);
        const rows =
          organization && targetId === scopedOrganizationId
            ? [{ id: organization.id, name: organization.name }]
            : [];
        return { rows: rows as Row[], rowCount: rows.length };
      }
      if (normalized.startsWith("UPDATE organizations")) {
        this.statements.push("organization.update");
        const [name, targetId, scopedOrganizationId] = values as [
          string,
          string,
          string,
        ];
        const organization = state.organizations.get(targetId);
        if (!organization || targetId !== scopedOrganizationId) {
          return { rows: [], rowCount: 0 };
        }
        organization.name = name;
        return {
          rows: [{ id: organization.id, name: organization.name }] as Row[],
          rowCount: 1,
        };
      }
      if (normalized.startsWith("INSERT INTO audit_events")) {
        this.statements.push("audit.insert");
        const [
          organizationId,
          actorId,
          requestId,
          action,
          resourceType,
          resourceId,
          before,
          after,
          metadata,
        ] = values as [
          string,
          string,
          string,
          string,
          string,
          string,
          Record<string, unknown> | null,
          Record<string, unknown> | null,
          Record<string, unknown>,
        ];
        state.auditEvents.push({
          organizationId,
          actorId,
          requestId,
          action,
          resourceType,
          resourceId,
          before,
          after,
          metadata,
        });
        return { rows: [], rowCount: 1 };
      }
      if (normalized.startsWith("INSERT INTO outbox_events")) {
        this.statements.push("outbox.insert");
        const [
          organizationId,
          actorId,
          requestId,
          eventType,
          aggregateType,
          aggregateId,
          schemaVersion,
          payload,
        ] = values as [
          string,
          string,
          string,
          `${string}.v${number}`,
          string,
          string,
          number,
          Record<string, unknown>,
        ];
        state.outboxEvents.push({
          organizationId,
          actorId,
          requestId,
          eventType,
          aggregateType,
          aggregateId,
          schemaVersion,
          payload,
        });
        return { rows: [], rowCount: 1 };
      }

      throw new Error(`Unexpected query: ${normalized}`);
    },
    release: () => undefined,
  } as unknown as PoolClient;

  readonly pool = {
    connect: async () => this.client,
  } as unknown as Pool;

  organization(id: string): OrganizationRecord {
    const organization = this.committed.organizations.get(id);
    if (!organization) throw new Error(`Missing organization ${id}`);
    return organization;
  }

  auditEvents(): AuditInput[] {
    return this.committed.auditEvents;
  }

  outboxEvents(): OutboxInput[] {
    return this.committed.outboxEvents;
  }

  private activeState(): TransactionState {
    if (!this.transaction) throw new Error("Query executed outside a transaction");
    return this.transaction;
  }
}

function actorContext(
  overrides: Partial<ActorContext> = {},
): ActorContext {
  return {
    organizationId: rangewayOrganizationId,
    actorId: "10000000-0000-4000-8000-000000000001",
    actorType: "human",
    actorName: "Zak Winnick",
    role: "owner",
    userId: "20000000-0000-4000-8000-000000000001",
    requestId: "30000000-0000-4000-8000-000000000001",
    ...overrides,
  };
}

function organizationNameMutation(
  actor: ActorContext,
  targetOrganizationId: string,
  name: string,
) {
  return async (client: DbClient) => {
    const beforeResult = await client.query<{ id: string; name: string }>(
      `SELECT id, name
         FROM organizations
        WHERE id = $1
          AND id = $2`,
      [targetOrganizationId, actor.organizationId],
    );
    const before = beforeResult.rows[0];
    if (!before) {
      throw new ApiError(404, "NOT_FOUND", "Organization not found.");
    }

    const updatedResult = await client.query<{ id: string; name: string }>(
      `UPDATE organizations
          SET name = $1, updated_at = now()
        WHERE id = $2
          AND id = $3
        RETURNING id, name`,
      [name, targetOrganizationId, actor.organizationId],
    );
    const updated = updatedResult.rows[0];
    if (!updated) {
      throw new ApiError(404, "NOT_FOUND", "Organization not found.");
    }

    return {
      value: { id: updated.id, name: updated.name },
      audit: {
        organizationId: actor.organizationId,
        actorId: actor.actorId,
        requestId: actor.requestId,
        action: "organization.updated",
        resourceType: "organization",
        resourceId: updated.id,
        before: { name: before.name },
        after: { name: updated.name },
      },
      event: {
        organizationId: actor.organizationId,
        actorId: actor.actorId,
        requestId: actor.requestId,
        eventType: "organization.updated.v1" as const,
        aggregateType: "organization",
        aggregateId: updated.id,
        schemaVersion: 1,
        payload: { organizationId: updated.id, name: updated.name },
      },
    };
  };
}

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

async function createServiceActor(
  pool: Pool,
  organizationId: string,
): Promise<ActorContext> {
  const actorId = randomUUID();
  const requestId = randomUUID();
  await pool.query(
    `INSERT INTO actors
       (id, organization_id, type, role, service_key_prefix, service_key_hash,
        display_name)
     VALUES ($1, $2, 'automation', 'member', $3, $4, $5)`,
    [
      actorId,
      organizationId,
      randomUUID().replaceAll("-", "").slice(0, 12),
      "a".repeat(64),
      "Mutation test automation",
    ],
  );
  return {
    actorId,
    actorType: "automation",
    actorName: "Mutation test automation",
    organizationId,
    role: "member",
    requestId,
  };
}

describe("mutateWithAuditAndEvent", () => {
  it("commits one business mutation, audit event, and outbox event in order", async () => {
    const database = new TransactionalAtlasDatabase();
    const actor = actorContext();

    const result = await mutateWithAuditAndEvent(
      database.pool,
      actor,
      organizationNameMutation(actor, rangewayOrganizationId, "Rangeway Energy"),
    );

    expect(result).toEqual({
      id: rangewayOrganizationId,
      name: "Rangeway Energy",
    });
    expect(database.organization(rangewayOrganizationId).name).toBe(
      "Rangeway Energy",
    );
    expect(database.statements).toEqual([
      "BEGIN",
      "organization.select",
      "organization.update",
      "audit.insert",
      "outbox.insert",
      "COMMIT",
    ]);
    expect(database.auditEvents()).toEqual([
      {
        organizationId: rangewayOrganizationId,
        actorId: actor.actorId,
        requestId: actor.requestId,
        action: "organization.updated",
        resourceType: "organization",
        resourceId: rangewayOrganizationId,
        before: { name: "Rangeway" },
        after: { name: "Rangeway Energy" },
        metadata: {},
      },
    ]);
    expect(database.outboxEvents()).toEqual([
      {
        organizationId: rangewayOrganizationId,
        actorId: actor.actorId,
        requestId: actor.requestId,
        eventType: "organization.updated.v1",
        aggregateType: "organization",
        aggregateId: rangewayOrganizationId,
        schemaVersion: 1,
        payload: {
          organizationId: rangewayOrganizationId,
          name: "Rangeway Energy",
        },
      },
    ]);
  });

  it("persists only caller-selected business fields in before, after, and event payloads", async () => {
    const database = new TransactionalAtlasDatabase();
    const actor = actorContext();

    await mutateWithAuditAndEvent(
      database.pool,
      actor,
      organizationNameMutation(actor, rangewayOrganizationId, "Rangeway Energy"),
    );

    const persistedPayloads = JSON.stringify({
      audit: database.auditEvents(),
      outbox: database.outboxEvents(),
    });
    expect(database.auditEvents()[0]).toMatchObject({
      before: { name: "Rangeway" },
      after: { name: "Rangeway Energy" },
    });
    expect(persistedPayloads).not.toContain("service-key-secret");
    expect(persistedPayloads).not.toContain("password-secret");
    expect(persistedPayloads).not.toContain("serviceKeyHash");
    expect(persistedPayloads).not.toContain("localPasswordHash");
  });

  it("rolls back all three writes when the precommit test hook throws", async () => {
    const database = new TransactionalAtlasDatabase();
    const actor = actorContext();
    const forcedFailure = new Error("forced precommit failure");

    await expect(
      mutateWithAuditAndEvent(
        database.pool,
        actor,
        organizationNameMutation(actor, rangewayOrganizationId, "Uncommitted name"),
        () => {
          database.statements.push("precommit.hook");
          throw forcedFailure;
        },
      ),
    ).rejects.toBe(forcedFailure);

    expect(database.statements).toEqual([
      "BEGIN",
      "organization.select",
      "organization.update",
      "audit.insert",
      "outbox.insert",
      "precommit.hook",
      "ROLLBACK",
    ]);
    expect(database.organization(rangewayOrganizationId).name).toBe("Rangeway");
    expect(database.auditEvents()).toEqual([]);
    expect(database.outboxEvents()).toEqual([]);
  });

  it("returns safe NOT_FOUND and writes no events for another organization", async () => {
    const database = new TransactionalAtlasDatabase();
    const actor = actorContext({ organizationId: otherOrganizationId });

    await expect(
      mutateWithAuditAndEvent(
        database.pool,
        actor,
        organizationNameMutation(actor, rangewayOrganizationId, "Cross-org change"),
      ),
    ).rejects.toMatchObject({
      status: 404,
      code: "NOT_FOUND",
      message: "Organization not found.",
    });

    expect(database.statements).toEqual([
      "BEGIN",
      "organization.select",
      "ROLLBACK",
    ]);
    expect(database.organization(rangewayOrganizationId).name).toBe("Rangeway");
    expect(database.auditEvents()).toEqual([]);
    expect(database.outboxEvents()).toEqual([]);
  });

  it.each([
    ["audit organization", { audit: { organizationId: otherOrganizationId } }],
    ["event organization", { event: { organizationId: otherOrganizationId } }],
    ["audit actor", { audit: { actorId: randomUUID() } }],
    ["event actor", { event: { actorId: randomUUID() } }],
    ["audit request", { audit: { requestId: randomUUID() } }],
    ["event request", { event: { requestId: randomUUID() } }],
  ])("rejects mismatched %s attribution before event insertion", async (_label, mismatch) => {
    const database = new TransactionalAtlasDatabase();
    const actor = actorContext();
    const mutation = organizationNameMutation(
      actor,
      rangewayOrganizationId,
      "Invalid attribution",
    );

    await expect(
      mutateWithAuditAndEvent(database.pool, actor, async (client) => {
        const result = await mutation(client);
        return {
          ...result,
          audit: { ...result.audit, ...mismatch.audit },
          event: { ...result.event, ...mismatch.event },
        };
      }),
    ).rejects.toMatchObject({
      status: 500,
      code: "INTERNAL_ERROR",
      message: "Unexpected server error.",
    });

    expect(database.statements).toEqual([
      "BEGIN",
      "organization.select",
      "organization.update",
      "ROLLBACK",
    ]);
    expect(database.organization(rangewayOrganizationId).name).toBe("Rangeway");
    expect(database.auditEvents()).toEqual([]);
    expect(database.outboxEvents()).toEqual([]);
  });
});

describe("mutateWithAuditAndEvent with PostgreSQL", () => {
  it("atomically persists the organization change and safe event records", async (context) => {
    await withTemporaryPostgreSql(context, async (pool) => {
      const actor = await createServiceActor(pool, rangewayOrganizationId);

      await expect(
        mutateWithAuditAndEvent(
          pool,
          actor,
          organizationNameMutation(
            actor,
            rangewayOrganizationId,
            "Rangeway Energy",
          ),
        ),
      ).resolves.toEqual({
        id: rangewayOrganizationId,
        name: "Rangeway Energy",
      });

      const organization = await pool.query<{ name: string }>(
        "SELECT name FROM organizations WHERE id = $1",
        [rangewayOrganizationId],
      );
      const audits = await pool.query<{
        organization_id: string;
        actor_id: string;
        request_id: string;
        resource_id: string;
        before: Record<string, unknown>;
        after: Record<string, unknown>;
        metadata: Record<string, unknown>;
      }>(
        `SELECT organization_id, actor_id, request_id, resource_id,
                before, after, metadata
           FROM audit_events
          WHERE request_id = $1`,
        [actor.requestId],
      );
      const events = await pool.query<{
        organization_id: string;
        actor_id: string;
        request_id: string;
        event_type: string;
        aggregate_id: string;
        schema_version: number;
        payload: Record<string, unknown>;
      }>(
        `SELECT organization_id, actor_id, request_id, event_type,
                aggregate_id, schema_version, payload
           FROM outbox_events
          WHERE request_id = $1`,
        [actor.requestId],
      );

      expect(organization.rows).toEqual([{ name: "Rangeway Energy" }]);
      expect(audits.rows).toEqual([
        {
          organization_id: rangewayOrganizationId,
          actor_id: actor.actorId,
          request_id: actor.requestId,
          resource_id: rangewayOrganizationId,
          before: { name: "Rangeway" },
          after: { name: "Rangeway Energy" },
          metadata: {},
        },
      ]);
      expect(events.rows).toEqual([
        {
          organization_id: rangewayOrganizationId,
          actor_id: actor.actorId,
          request_id: actor.requestId,
          event_type: "organization.updated.v1",
          aggregate_id: rangewayOrganizationId,
          schema_version: 1,
          payload: {
            organizationId: rangewayOrganizationId,
            name: "Rangeway Energy",
          },
        },
      ]);
      expect(JSON.stringify({ audits: audits.rows, events: events.rows })).not.toMatch(
        /service_key|serviceKey|password|a{64}/,
      );
    });
  });

  it("rolls back every write when the precommit hook fails", async (context) => {
    await withTemporaryPostgreSql(context, async (pool) => {
      const actor = await createServiceActor(pool, rangewayOrganizationId);
      const forcedFailure = new Error("forced precommit failure");

      await expect(
        mutateWithAuditAndEvent(
          pool,
          actor,
          organizationNameMutation(
            actor,
            rangewayOrganizationId,
            "Uncommitted name",
          ),
          () => {
            throw forcedFailure;
          },
        ),
      ).rejects.toBe(forcedFailure);

      const state = await pool.query<{
        name: string;
        audit_count: string;
        outbox_count: string;
      }>(
        `SELECT o.name,
                (SELECT COUNT(*)::text FROM audit_events WHERE request_id = $2)
                  AS audit_count,
                (SELECT COUNT(*)::text FROM outbox_events WHERE request_id = $2)
                  AS outbox_count
           FROM organizations o
          WHERE o.id = $1`,
        [rangewayOrganizationId, actor.requestId],
      );
      expect(state.rows).toEqual([
        { name: "Rangeway", audit_count: "0", outbox_count: "0" },
      ]);
    });
  });

  it("returns NOT_FOUND with no writes across the organization boundary", async (context) => {
    await withTemporaryPostgreSql(context, async (pool) => {
      await pool.query(
        "INSERT INTO organizations (id, slug, name) VALUES ($1, $2, $3)",
        [otherOrganizationId, "other-organization", "Other organization"],
      );
      const actor = await createServiceActor(pool, otherOrganizationId);

      await expect(
        mutateWithAuditAndEvent(
          pool,
          actor,
          organizationNameMutation(
            actor,
            rangewayOrganizationId,
            "Cross-org change",
          ),
        ),
      ).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });

      const state = await pool.query<{
        name: string;
        audit_count: string;
        outbox_count: string;
      }>(
        `SELECT o.name,
                (SELECT COUNT(*)::text FROM audit_events) AS audit_count,
                (SELECT COUNT(*)::text FROM outbox_events) AS outbox_count
           FROM organizations o
          WHERE o.id = $1`,
        [rangewayOrganizationId],
      );
      expect(state.rows).toEqual([
        { name: "Rangeway", audit_count: "0", outbox_count: "0" },
      ]);
    });
  });
});
