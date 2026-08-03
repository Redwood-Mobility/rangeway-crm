import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { describe, expect, it, type TestContext } from "vitest";
import type { ActorContext } from "../../src/shared/identity.js";
import { OperatingCoreService } from "../../src/server/modules/operating-core/operating-core.service.js";
import { createPool } from "../../src/server/platform/db/client.js";
import { runMigrations } from "../../src/server/platform/db/migrate.js";
import {
  createTemporaryDatabase,
  PostgreSqlUnavailableError,
} from "../helpers/database.js";

const organizationId = "00000000-0000-4000-8000-000000000001";

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

async function createHuman(
  pool: Pool,
  role: "owner" | "admin" | "member" | "viewer" = "member",
  scopedOrganizationId = organizationId,
): Promise<ActorContext> {
  const userId = randomUUID();
  const actorId = randomUUID();
  await pool.query("BEGIN");
  try {
    await pool.query("SET CONSTRAINTS ALL DEFERRED");
    await pool.query(
      "INSERT INTO users (id, email, display_name) VALUES ($1, $2, $3)",
      [userId, `${userId}@rangeway.energy`, "Operating Core test user"],
    );
    await pool.query(
      `INSERT INTO actors (id, organization_id, type, role, user_id, display_name)
       VALUES ($1, $2, 'human', $3, $4, 'Operating Core test user')`,
      [actorId, scopedOrganizationId, role, userId],
    );
    await pool.query(
      "INSERT INTO organization_memberships (organization_id, user_id, role) VALUES ($1, $2, $3)",
      [scopedOrganizationId, userId, role],
    );
    await pool.query("COMMIT");
  } catch (error) {
    await pool.query("ROLLBACK");
    throw error;
  }
  return {
    actorId,
    actorType: "human",
    actorName: "Operating Core test user",
    organizationId: scopedOrganizationId,
    role,
    userId,
    requestId: randomUUID(),
  };
}

function key(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}

describe("Operating Core PostgreSQL acceptance", () => {
  it("keeps one moved work item immediately consistent across every projection", async (context) => {
    await withPostgreSql(context, async (pool) => {
      const actor = await createHuman(pool);
      const core = new OperatingCoreService(pool);
      const created = await core.mutate(actor, "project.create", {
        name: "Mojave",
        objective: "Qualify a location.",
        ownerUserId: actor.userId,
        templateType: "location_pursuit",
        status: "active",
        health: "unknown",
        priority: "high",
        strategicArea: "Site Development",
        currentFocus: "Diligence",
        blockerSummary: "",
        nextDecision: "Select path",
        nextAction: "Confirm contacts",
      }, key("project"));
      const projectId = String((created.project as { id: string }).id);
      const work = await core.mutate(actor, "work.create", {
        projectId,
        type: "action",
        title: "Confirm site control",
        description: "",
        status: "next",
        priority: "high",
        position: 100,
        labelIds: [],
      }, key("work"));
      const workItemId = String((work.workItem as { id: string }).id);
      await core.mutate(actor, "work.move", {
        workItemId,
        status: "in_progress",
        position: 200,
      }, key("move"));

      for (const view of ["board", "list", "calendar"]) {
        const projection = await core.query(actor, "work.view", { view, projectId, limit: 50 });
        expect(projection.items).toEqual([
          expect.objectContaining({ id: workItemId, status: "in_progress" }),
        ]);
      }
      const today = await core.query(actor, "today.get", {});
      const portfolio = await core.query(actor, "portfolio.summary", { limit: 50 });
      const contextBundle = await core.query(actor, "project.context", { projectId });
      expect(today.workItems).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: workItemId, status: "in_progress" }),
      ]));
      expect(portfolio.projects).toEqual(expect.arrayContaining([
        expect.objectContaining({
          id: projectId,
          workStatusCounts: expect.objectContaining({ in_progress: 1 }),
        }),
      ]));
      expect((contextBundle.workItems as Array<{ id: string; status: string }>)).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: workItemId, status: "in_progress" })]),
      );
    });
  });

  it("returns safe NOT_FOUND for cross-organization and non-member project access", async (context) => {
    await withPostgreSql(context, async (pool) => {
      const owner = await createHuman(pool);
      const outsider = await createHuman(pool);
      const otherOrganizationId = randomUUID();
      await pool.query("INSERT INTO organizations (id, slug, name) VALUES ($1, $2, 'Other')", [
        otherOrganizationId,
        `other-${otherOrganizationId}`,
      ]);
      const crossOrganizationActor = await createHuman(pool, "member", otherOrganizationId);
      const core = new OperatingCoreService(pool);
      const created = await core.mutate(owner, "project.create", {
        name: "Private project",
        ownerUserId: owner.userId,
      }, key("project"));
      const projectId = String((created.project as { id: string }).id);

      for (const denied of [outsider, crossOrganizationActor]) {
        await expect(core.query(denied, "project.get", { projectId })).rejects.toMatchObject({
          status: 404,
          code: "NOT_FOUND",
          publicMessage: "Resource not found.",
        });
      }
    });
  });

  it("rejects invalid transitions, dependency cycles, and invalid blocker targets", async (context) => {
    await withPostgreSql(context, async (pool) => {
      const actor = await createHuman(pool);
      const core = new OperatingCoreService(pool);
      const created = await core.mutate(actor, "project.create", {
        name: "Rules project",
        ownerUserId: actor.userId,
      }, key("project"));
      const projectId = String((created.project as { id: string }).id);
      const workIds: string[] = [];
      for (const title of ["A", "B", "C"]) {
        const result = await core.mutate(actor, "work.create", {
          projectId,
          type: "action",
          title,
          status: "inbox",
          priority: "medium",
          position: workIds.length,
          labelIds: [],
        }, key("work"));
        workIds.push(String((result.workItem as { id: string }).id));
      }
      await expect(core.mutate(actor, "work.move", {
        workItemId: workIds[0], status: "done", position: 1,
      }, key("move"))).rejects.toMatchObject({ code: "CONFLICT" });
      await core.mutate(actor, "work.dependency.add", {
        workItemId: workIds[0], dependencyId: workIds[1],
      }, key("dependency"));
      await core.mutate(actor, "work.dependency.add", {
        workItemId: workIds[1], dependencyId: workIds[2],
      }, key("dependency"));
      await expect(core.mutate(actor, "work.dependency.add", {
        workItemId: workIds[2], dependencyId: workIds[0],
      }, key("dependency"))).rejects.toMatchObject({ code: "CONFLICT" });
      await expect(core.mutate(actor, "blocker.create", {
        projectId,
        condition: "Bad target",
        targetType: "work_item",
        targetId: randomUUID(),
        resolved: false,
      }, key("blocker"))).rejects.toMatchObject({ code: "CONFLICT" });
    });
  });

  it("replays identical mutations, conflicts on key reuse, and atomically rolls back all four records", async (context) => {
    await withPostgreSql(context, async (pool) => {
      const actor = await createHuman(pool);
      const core = new OperatingCoreService(pool);
      const idempotencyKey = key("replay");
      const input = { name: "Atomic project", ownerUserId: actor.userId };
      const first = await core.mutate(actor, "project.create", input, idempotencyKey);
      const replay = await core.mutate({ ...actor, requestId: randomUUID() }, "project.create", input, idempotencyKey);
      expect(replay).toEqual(first);
      await expect(core.mutate(actor, "project.create", {
        ...input,
        name: "Different request",
      }, idempotencyKey)).rejects.toMatchObject({ status: 409, code: "CONFLICT" });

      const before = await pool.query<{ projects: string; audits: string; events: string; keys: string }>(
        `SELECT
           (SELECT count(*)::text FROM project_rooms) AS projects,
           (SELECT count(*)::text FROM audit_events WHERE resource_type = 'project') AS audits,
           (SELECT count(*)::text FROM outbox_events WHERE aggregate_type = 'project') AS events,
           (SELECT count(*)::text FROM api_idempotency_keys WHERE operation = 'project.create.v1') AS keys`,
      );
      await pool.query(`CREATE FUNCTION reject_product_event() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'forced outbox failure'; END $$`);
      await pool.query(`CREATE TRIGGER reject_product_event BEFORE INSERT ON outbox_events
        FOR EACH ROW WHEN (NEW.aggregate_type = 'project') EXECUTE FUNCTION reject_product_event()`);
      await expect(core.mutate(actor, "project.create", {
        name: "Must roll back",
        ownerUserId: actor.userId,
      }, key("rollback"))).rejects.toThrow("forced outbox failure");
      const after = await pool.query<{ projects: string; audits: string; events: string; keys: string }>(
        `SELECT
           (SELECT count(*)::text FROM project_rooms) AS projects,
           (SELECT count(*)::text FROM audit_events WHERE resource_type = 'project') AS audits,
           (SELECT count(*)::text FROM outbox_events WHERE aggregate_type = 'project') AS events,
           (SELECT count(*)::text FROM api_idempotency_keys WHERE operation = 'project.create.v1') AS keys`,
      );
      expect(after.rows).toEqual(before.rows);
    });
  });
});
