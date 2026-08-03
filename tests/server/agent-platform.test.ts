import { createHash, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { describe, expect, it, type TestContext } from "vitest";
import type { ActorContext } from "../../src/shared/identity.js";
import {
  decideAuthority,
  guardedOperations,
  type CredentialAuthority,
  type DelegationAuthority,
} from "../../src/shared/agent-authority.js";
import { AgentService } from "../../src/server/modules/agents/agent.service.js";
import { createPool } from "../../src/server/platform/db/client.js";
import { runMigrations } from "../../src/server/platform/db/migrate.js";
import { createTemporaryDatabase, PostgreSqlUnavailableError } from "../helpers/database.js";

const organizationId = "00000000-0000-4000-8000-000000000001";
const key = (prefix: string) => `${prefix}-${randomUUID()}`;
const hour = 3_600_000;

const credential = (overrides: Partial<CredentialAuthority> = {}): CredentialAuthority => ({
  scopes: ["read", "work.write"],
  externalDeliveryAuthorized: false,
  expiresAt: null,
  disabledAt: null,
  ...overrides,
});

const delegation = (overrides: Partial<DelegationAuthority> = {}): DelegationAuthority => ({
  permittedScopes: ["read", "work.write"],
  projectId: null,
  expiresAt: new Date(Date.now() + hour).toISOString(),
  revokedAt: null,
  ...overrides,
});

async function withPostgreSql(
  context: TestContext,
  operation: (pool: Pool) => Promise<void>,
): Promise<void> {
  let database;
  try {
    database = await createTemporaryDatabase();
  } catch (error) {
    if (error instanceof PostgreSqlUnavailableError) {
      context.skip(`EQUIPPED_POSTGRESQL_SKIP: ${error.message}`);
      return;
    }
    throw error;
  }
  const pool = createPool(database.databaseUrl);
  try {
    await runMigrations(pool);
    await operation(pool);
  } finally {
    await pool.end();
    await database.cleanup();
  }
}

async function createActor(
  pool: Pool,
  type: "human" | "agent",
  role: "owner" | "admin" | "member" = "member",
): Promise<ActorContext> {
  const actorId = randomUUID();
  const userId = type === "human" ? randomUUID() : null;
  await pool.query("BEGIN");
  await pool.query("SET CONSTRAINTS ALL DEFERRED");
  if (userId) {
    await pool.query("INSERT INTO users (id, email, display_name) VALUES ($1, $2, 'Person')", [
      userId,
      `${userId}@rangeway.energy`,
    ]);
    await pool.query(
      "INSERT INTO organization_memberships (organization_id, user_id, role) VALUES ($1, $2, $3)",
      [organizationId, userId, role],
    );
    await pool.query(
      `INSERT INTO actors (id, organization_id, type, role, user_id, display_name)
       VALUES ($1, $2, 'human', $3, $4, 'Person')`,
      [actorId, organizationId, role, userId],
    );
  } else {
    await pool.query(
      `INSERT INTO actors (id, organization_id, type, role, display_name, service_key_prefix, service_key_hash)
       VALUES ($1, $2, 'agent', $3, 'Codex', $4, $5)`,
      [actorId, organizationId, role, randomUUID().replaceAll("-", "").slice(0, 12), createHash("sha256").update(actorId).digest("hex")],
    );
  }
  await pool.query("COMMIT");
  return {
    actorId,
    actorType: type,
    actorName: type === "human" ? "Person" : "Codex",
    organizationId,
    role,
    userId,
    requestId: randomUUID(),
  };
}

describe("agent authority", () => {
  it("grants only the intersection of credential scopes and task delegation", () => {
    const decision = decideAuthority(
      credential({ scopes: ["read", "work.write", "admin"] }),
      delegation({ permittedScopes: ["read", "work.write"] }),
      { requiredScope: "work.write" },
      new Date(),
    );
    expect(decision.allowed).toBe(true);
    expect(decision.effectiveScopes).toEqual(["read", "work.write"]);

    // A broad credential does not widen a narrow task...
    expect(
      decideAuthority(
        credential({ scopes: ["read", "work.write", "admin"] }),
        delegation({ permittedScopes: ["read"] }),
        { requiredScope: "work.write" },
        new Date(),
      ),
    ).toMatchObject({ allowed: false, reason: "scope_not_granted" });

    // ...and a broad task does not widen a narrow credential.
    expect(
      decideAuthority(
        credential({ scopes: ["read"] }),
        delegation({ permittedScopes: ["read", "work.write", "admin"] }),
        { requiredScope: "work.write" },
        new Date(),
      ),
    ).toMatchObject({ allowed: false, reason: "scope_not_granted" });
  });

  it("refuses expired, disabled, revoked and missing authority", () => {
    const past = new Date(Date.now() - hour).toISOString();
    const cases: Array<[CredentialAuthority, DelegationAuthority | null, string]> = [
      [credential({ disabledAt: past }), delegation(), "credential_disabled"],
      [credential({ expiresAt: past }), delegation(), "credential_expired"],
      [credential(), null, "no_active_delegation"],
      [credential(), delegation({ revokedAt: past }), "delegation_revoked"],
      [credential(), delegation({ expiresAt: past }), "delegation_expired"],
    ];
    for (const [cred, deleg, reason] of cases) {
      expect(
        decideAuthority(cred, deleg, { requiredScope: "read" }, new Date()),
      ).toMatchObject({ allowed: false, requiresApproval: false, reason });
    }
  });

  it("keeps a project-scoped delegation inside its project", () => {
    const projectId = randomUUID();
    expect(
      decideAuthority(
        credential(),
        delegation({ projectId }),
        { requiredScope: "work.write", projectId: randomUUID() },
        new Date(),
      ),
    ).toMatchObject({ allowed: false, reason: "outside_delegated_project" });

    expect(
      decideAuthority(
        credential(),
        delegation({ projectId }),
        { requiredScope: "work.write", projectId },
        new Date(),
      ),
    ).toMatchObject({ allowed: true });
  });

  it("routes destructive, credential-changing and unrequested external work to approval", () => {
    const authorized = credential({
      scopes: ["read", "work.write", "admin", "report.deliver"],
      externalDeliveryAuthorized: true,
    });
    const broad = delegation({
      permittedScopes: ["read", "work.write", "admin", "report.deliver"],
    });

    for (const [guarded, reason] of [
      [guardedOperations.permanentDeletion, "permanent_deletion_requires_approval"],
      [guardedOperations.credentialChange, "permission_change_requires_approval"],
      [guardedOperations.permissionChange, "permission_change_requires_approval"],
    ] as const) {
      expect(
        decideAuthority(authorized, broad, { requiredScope: "admin", guarded }, new Date()),
      ).toMatchObject({ allowed: false, requiresApproval: true, reason });
    }

    // External delivery the human did not ask for needs approval even when the
    // credential carries delivery authority.
    expect(
      decideAuthority(
        authorized,
        broad,
        { requiredScope: "report.deliver", guarded: guardedOperations.externalDelivery },
        new Date(),
      ),
    ).toMatchObject({ requiresApproval: true, reason: "unrequested_external_communication" });

    expect(
      decideAuthority(
        authorized,
        broad,
        {
          requiredScope: "report.deliver",
          guarded: guardedOperations.externalDelivery,
          requestedByHuman: true,
        },
        new Date(),
      ),
    ).toMatchObject({ allowed: true });

    // Without delivery authority it is refused regardless of who asked.
    expect(
      decideAuthority(
        credential({ scopes: ["report.deliver"], externalDeliveryAuthorized: false }),
        delegation({ permittedScopes: ["report.deliver"] }),
        {
          requiredScope: "report.deliver",
          guarded: guardedOperations.externalDelivery,
          requestedByHuman: true,
        },
        new Date(),
      ),
    ).toMatchObject({ allowed: false, requiresApproval: true, reason: "external_delivery_not_authorized" });
  });

  it("sends an unusually large bulk change to approval", () => {
    expect(
      decideAuthority(
        credential(),
        delegation(),
        { requiredScope: "work.write", affectedRecordCount: 500 },
        new Date(),
      ),
    ).toMatchObject({ allowed: false, requiresApproval: true, reason: "bulk_mutation_requires_approval" });

    expect(
      decideAuthority(
        credential(),
        delegation(),
        { requiredScope: "work.write", affectedRecordCount: 5 },
        new Date(),
      ),
    ).toMatchObject({ allowed: true });
  });
});

describe("agent platform", () => {
  it("reveals a service key once and never stores or returns it again", async (context) => {
    await withPostgreSql(context, async (pool) => {
      const owner = await createActor(pool, "human", "owner");
      const agent = await createActor(pool, "agent");
      const agents = new AgentService(pool);

      const issued = await agents.mutate(
        owner,
        "agent.credential.issue",
        { actorId: agent.actorId, scopes: ["read", "work.write"] },
        key("issue"),
      );
      const serviceKey = String(issued.serviceKey);
      expect(serviceKey).toMatch(/^atlas_[A-Za-z0-9_-]{12}\./);

      // The clear key is nowhere in the database.
      const stored = await pool.query<{ service_key_hash: string }>(
        "SELECT service_key_hash FROM agent_credentials",
      );
      expect(stored.rows[0].service_key_hash).not.toContain(serviceKey);

      const listed = await agents.query(owner, "agent.list", {});
      expect(JSON.stringify(listed)).not.toContain(serviceKey);
    });
  });

  it("rotates a credential without changing the actor identity", async (context) => {
    await withPostgreSql(context, async (pool) => {
      const owner = await createActor(pool, "human", "owner");
      const agent = await createActor(pool, "agent");
      const agents = new AgentService(pool);

      const issued = await agents.mutate(
        owner,
        "agent.credential.issue",
        { actorId: agent.actorId, scopes: ["read"] },
        key("issue"),
      );
      const credentialId = String((issued.credential as { id: string }).id);
      const firstKey = String(issued.serviceKey);

      const rotated = await agents.mutate(
        owner,
        "agent.credential.rotate",
        { credentialId },
        key("rotate"),
      );
      expect(String(rotated.serviceKey)).not.toBe(firstKey);
      expect((rotated.credential as { actorId: string }).actorId).toBe(agent.actorId);
      expect((rotated.credential as { id: string }).id).toBe(credentialId);
    });
  });

  it("refuses agent administration by a member or by an agent", async (context) => {
    await withPostgreSql(context, async (pool) => {
      const member = await createActor(pool, "human", "member");
      const agent = await createActor(pool, "agent");
      const agents = new AgentService(pool);

      for (const actor of [member, agent]) {
        await expect(
          agents.mutate(
            actor,
            "agent.credential.issue",
            { actorId: agent.actorId, scopes: ["admin"] },
            key("issue"),
          ),
        ).rejects.toMatchObject({ status: 403, code: "FORBIDDEN" });
      }

      // An agent cannot delegate authority to itself either.
      await expect(
        agents.mutate(
          agent,
          "agent.delegation.create",
          {
            actorId: agent.actorId,
            taskSource: "self",
            permittedScopes: ["admin"],
            expiresAt: new Date(Date.now() + hour).toISOString(),
          },
          key("delegate"),
        ),
      ).rejects.toMatchObject({ status: 403, code: "FORBIDDEN" });
    });
  });

  it("attributes every attempt and opens an approval for guarded work", async (context) => {
    await withPostgreSql(context, async (pool) => {
      const owner = await createActor(pool, "human", "owner");
      const agent = await createActor(pool, "agent");
      const agents = new AgentService(pool);

      await agents.mutate(
        owner,
        "agent.credential.issue",
        { actorId: agent.actorId, scopes: ["read", "work.write", "admin"] },
        key("issue"),
      );
      const delegated = await agents.mutate(
        owner,
        "agent.delegation.create",
        {
          actorId: agent.actorId,
          taskSource: "chat:zak/2026-08-03",
          purpose: "Advance Mojave next actions",
          permittedScopes: ["read", "work.write", "admin"],
          expiresAt: new Date(Date.now() + hour).toISOString(),
        },
        key("delegate"),
      );
      const delegationId = String((delegated.delegation as { id: string }).id);

      // Routine authorized work proceeds and is attributed.
      const routine = await agents.authorize(agent, { requiredScope: "work.write" });
      expect(routine.allowed).toBe(true);

      // A destructive operation is refused and routed to a human.
      const destructive = await agents.authorize(agent, {
        requiredScope: "admin",
        guarded: guardedOperations.permanentDeletion,
      });
      expect(destructive).toMatchObject({ allowed: false, requiresApproval: true });

      const invocations = await agents.query(owner, "agent.invocations", {});
      const rows = invocations.invocations as Array<{
        outcome: string;
        actorId: string;
        delegationId: string;
        taskSource: string;
      }>;
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(row.actorId).toBe(agent.actorId);
        expect(row.delegationId).toBe(delegationId);
        expect(row.taskSource).toBe("chat:zak/2026-08-03");
      }
      expect(rows.map((row) => row.outcome).sort()).toEqual(["awaiting_approval", "succeeded"]);

      const approvals = await agents.query(owner, "agent.approvals", {});
      const pending = (approvals.approvals as Array<{ id: string; state: string; reason: string }>)[0];
      expect(pending.state).toBe("pending");
      expect(pending.reason).toBe("permanent_deletion_requires_approval");

      const decided = await agents.mutate(
        owner,
        "agent.approval.decide",
        { approvalId: pending.id, state: "rejected", rationale: "Not this run." },
        key("decide"),
      );
      expect((decided.approval as { state: string }).state).toBe("rejected");
    });
  });

  it("stops an agent whose delegation was revoked", async (context) => {
    await withPostgreSql(context, async (pool) => {
      const owner = await createActor(pool, "human", "owner");
      const agent = await createActor(pool, "agent");
      const agents = new AgentService(pool);

      await agents.mutate(
        owner,
        "agent.credential.issue",
        { actorId: agent.actorId, scopes: ["read", "work.write"] },
        key("issue"),
      );
      const delegated = await agents.mutate(
        owner,
        "agent.delegation.create",
        {
          actorId: agent.actorId,
          taskSource: "chat:zak",
          permittedScopes: ["read", "work.write"],
          expiresAt: new Date(Date.now() + hour).toISOString(),
        },
        key("delegate"),
      );
      expect((await agents.authorize(agent, { requiredScope: "work.write" })).allowed).toBe(true);

      await agents.mutate(
        owner,
        "agent.delegation.revoke",
        { delegationId: String((delegated.delegation as { id: string }).id) },
        key("revoke"),
      );
      expect(await agents.authorize(agent, { requiredScope: "work.write" })).toMatchObject({
        allowed: false,
        reason: "no_active_delegation",
      });
    });
  });
});
