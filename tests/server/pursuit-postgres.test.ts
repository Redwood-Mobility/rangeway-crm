import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { describe, expect, it, type TestContext } from "vitest";
import type { ActorContext } from "../../src/shared/identity.js";
import {
  locationPursuitDevelopmentAreas,
  unmetRequirementsForPhase,
} from "../../src/shared/location-pursuit.js";
import { OperatingCoreService } from "../../src/server/modules/operating-core/operating-core.service.js";
import { PursuitService } from "../../src/server/modules/pursuit/pursuit.service.js";
import { createPool } from "../../src/server/platform/db/client.js";
import { runMigrations } from "../../src/server/platform/db/migrate.js";
import { createTemporaryDatabase, PostgreSqlUnavailableError } from "../helpers/database.js";

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

async function createActor(pool: Pool, role: "owner" | "member" = "owner"): Promise<ActorContext> {
  const userId = randomUUID();
  const actorId = randomUUID();
  await pool.query("BEGIN");
  await pool.query("SET CONSTRAINTS ALL DEFERRED");
  await pool.query("INSERT INTO users (id, email, display_name) VALUES ($1, $2, 'Pursuit tester')", [
    userId,
    `${userId}@rangeway.energy`,
  ]);
  await pool.query(
    `INSERT INTO actors (id, organization_id, type, role, user_id, display_name)
     VALUES ($1, $2, 'human', $3, $4, 'Pursuit tester')`,
    [actorId, organizationId, role, userId],
  );
  await pool.query(
    "INSERT INTO organization_memberships (organization_id, user_id, role) VALUES ($1, $2, $3)",
    [organizationId, userId, role],
  );
  await pool.query("COMMIT");
  return {
    actorId,
    actorType: "human",
    actorName: "Pursuit tester",
    organizationId,
    role,
    userId,
    requestId: randomUUID(),
  };
}

const key = (prefix: string) => `${prefix}-${randomUUID()}`;

async function createPursuitProject(pool: Pool, actor: ActorContext, name: string) {
  const core = new OperatingCoreService(pool);
  const pursuit = new PursuitService(pool);
  const created = await core.mutate(
    actor,
    "project.create",
    { name, ownerUserId: actor.userId, templateType: "location_pursuit", status: "active" },
    key("project"),
  );
  const projectId = String((created.project as { id: string }).id);
  await pursuit.mutate(actor, "pursuit.enable", { projectId }, key("enable"));
  return { pursuit, projectId };
}

describe("Location Pursuit gate engine", () => {
  it("defines exactly the eight approved development areas once", () => {
    expect(locationPursuitDevelopmentAreas.map((area) => area.key)).toEqual([
      "site_and_land_control",
      "utility_and_power",
      "permitting_and_entitlement",
      "commercial_structure",
      "hospitality_program",
      "capital_and_economics",
      "design_and_construction",
      "partner_alignment",
    ]);
  });

  it("treats only evidenced, waived and not-applicable as satisfying a gate", () => {
    const base = {
      requirementId: "r",
      definitionKey: "k",
      name: "n",
      developmentAreaKey: "a",
      requiredByPhase: "qualifying" as const,
    };
    const unmet = unmetRequirementsForPhase(
      [
        { ...base, requirementId: "1", state: "evidenced" },
        { ...base, requirementId: "2", state: "waived" },
        { ...base, requirementId: "3", state: "not_applicable" },
        { ...base, requirementId: "4", state: "investigating" },
        { ...base, requirementId: "5", state: "blocked" },
        { ...base, requirementId: "6", state: "unknown" },
        // Due later than the target phase, so not yet required.
        { ...base, requirementId: "7", state: "unknown", requiredByPhase: "committed" },
      ],
      "qualifying",
    );
    expect(unmet.map((requirement) => requirement.requirementId)).toEqual(["4", "5", "6"]);
  });

  it("instantiates every requirement as unknown and exposes all eight areas", async (context) => {
    await withPostgreSql(context, async (pool) => {
      const actor = await createActor(pool);
      const { pursuit, projectId } = await createPursuitProject(pool, actor, "Mojave");

      const readiness = await pursuit.query(actor, "pursuit.readiness", { projectId });
      const areas = readiness.developmentAreas as Array<{ key: string; requirements: unknown[] }>;
      expect(readiness.enabled).toBe(true);
      expect(areas).toHaveLength(8);

      const states = new Set(
        areas.flatMap((area) =>
          (area.requirements as Array<{ state: string }>).map((requirement) => requirement.state),
        ),
      );
      expect([...states]).toEqual(["unknown"]);
    });
  });

  it("uses one identical template for Mojave, Hawaiʻi and The Landing", async (context) => {
    await withPostgreSql(context, async (pool) => {
      const actor = await createActor(pool);
      const signatures: string[] = [];
      for (const name of ["Mojave", "Hawaiʻi", "St. Louis — The Landing"]) {
        const { pursuit, projectId } = await createPursuitProject(pool, actor, name);
        const readiness = await pursuit.query(actor, "pursuit.readiness", { projectId });
        const areas = readiness.developmentAreas as Array<{
          key: string;
          requirements: Array<{ definitionKey: string }>;
        }>;
        signatures.push(
          JSON.stringify(
            areas.map((area) => [area.key, area.requirements.map((r) => r.definitionKey)]),
          ),
        );
      }
      expect(signatures[0]).toEqual(signatures[1]);
      expect(signatures[1]).toEqual(signatures[2]);

      // One template row, shared — not one per project.
      const templates = await pool.query("SELECT count(*)::int AS count FROM pursuit_templates");
      expect(templates.rows[0].count).toBe(1);
    });
  });

  it("refuses to mark a requirement evidenced without eligible evidence", async (context) => {
    await withPostgreSql(context, async (pool) => {
      const actor = await createActor(pool);
      const { pursuit, projectId } = await createPursuitProject(pool, actor, "Mojave");
      const readiness = await pursuit.query(actor, "pursuit.readiness", { projectId });
      const requirementId = (
        (readiness.developmentAreas as Array<{ requirements: Array<{ requirementId: string }> }>)[0]
          .requirements[0]
      ).requirementId;

      await expect(
        pursuit.mutate(actor, "pursuit.requirement.update", { requirementId, state: "evidenced" }, key("req")),
      ).rejects.toMatchObject({ status: 409, code: "CONFLICT" });

      const artifact = await pursuit.mutate(
        actor,
        "artifact.create",
        { mode: "native", title: "Parcel map", storageKey: "documents/parcel.pdf", projectId },
        key("artifact"),
      );
      const artifactId = String((artifact.artifact as { id: string }).id);
      await pursuit.mutate(
        actor,
        "evidence.link",
        { artifactId, targetType: "requirement", targetId: requirementId, claim: "Parcel boundary" },
        key("evidence"),
      );

      const updated = await pursuit.mutate(
        actor,
        "pursuit.requirement.update",
        { requirementId, state: "evidenced" },
        key("req2"),
      );
      expect((updated.requirement as { state: string }).state).toBe("evidenced");
    });
  });

  it("requires a rationale for waived and not-applicable states", async (context) => {
    await withPostgreSql(context, async (pool) => {
      const actor = await createActor(pool);
      const { pursuit, projectId } = await createPursuitProject(pool, actor, "Mojave");
      const readiness = await pursuit.query(actor, "pursuit.readiness", { projectId });
      const requirementId = (
        (readiness.developmentAreas as Array<{ requirements: Array<{ requirementId: string }> }>)[0]
          .requirements[0]
      ).requirementId;

      await expect(
        pursuit.mutate(actor, "pursuit.requirement.update", { requirementId, state: "waived" }, key("w1")),
      ).rejects.toMatchObject({ status: 400, code: "INVALID_INPUT" });

      const waived = await pursuit.mutate(
        actor,
        "pursuit.requirement.update",
        { requirementId, state: "waived", waiverRationale: "Superseded by the adjacent parcel." },
        key("w2"),
      );
      const requirement = waived.requirement as {
        state: string;
        waivedByActorId: string;
        waivedAt: string;
        waiverRationale: string;
      };
      expect(requirement.state).toBe("waived");
      expect(requirement.waivedByActorId).toBe(actor.actorId);
      expect(requirement.waivedAt).toBeTruthy();
      expect(requirement.waiverRationale).toContain("Superseded");
    });
  });

  it("cannot silently advance a phase past unmet gates", async (context) => {
    await withPostgreSql(context, async (pool) => {
      const actor = await createActor(pool);
      const { pursuit, projectId } = await createPursuitProject(pool, actor, "Mojave");

      // Everything is unknown, so qualifying is blocked.
      await expect(
        pursuit.mutate(actor, "pursuit.phase.change", { projectId, phase: "qualifying" }, key("phase")),
      ).rejects.toMatchObject({ status: 409, code: "CONFLICT" });

      // An explicit override is recorded with the exact requirements bypassed.
      const changed = await pursuit.mutate(
        actor,
        "pursuit.phase.change",
        {
          projectId,
          phase: "qualifying",
          rationale: "Board directed early qualification.",
          overrideRationale: "Proceeding at risk pending utility confirmation.",
        },
        key("phase2"),
      );
      expect((changed.profile as { phase: string }).phase).toBe("qualifying");

      const history = await pool.query<{
        to_phase: string;
        override_rationale: string;
        unmet_requirement_ids: string[];
      }>("SELECT to_phase, override_rationale, unmet_requirement_ids FROM pursuit_phase_history");
      expect(history.rows).toHaveLength(1);
      expect(history.rows[0].to_phase).toBe("qualifying");
      expect(history.rows[0].override_rationale).toContain("at risk");
      expect(history.rows[0].unmet_requirement_ids.length).toBeGreaterThan(0);
    });
  });

  it("reopens an evidenced requirement when its last evidence is removed", async (context) => {
    await withPostgreSql(context, async (pool) => {
      const actor = await createActor(pool);
      const { pursuit, projectId } = await createPursuitProject(pool, actor, "Mojave");
      const readiness = await pursuit.query(actor, "pursuit.readiness", { projectId });
      const requirementId = (
        (readiness.developmentAreas as Array<{ requirements: Array<{ requirementId: string }> }>)[0]
          .requirements[0]
      ).requirementId;

      const artifact = await pursuit.mutate(
        actor,
        "artifact.create",
        { mode: "native", title: "Deed", storageKey: "documents/deed.pdf", projectId },
        key("artifact"),
      );
      const linked = await pursuit.mutate(
        actor,
        "evidence.link",
        {
          artifactId: String((artifact.artifact as { id: string }).id),
          targetType: "requirement",
          targetId: requirementId,
        },
        key("evidence"),
      );
      await pursuit.mutate(actor, "pursuit.requirement.update", { requirementId, state: "evidenced" }, key("req"));

      await pursuit.mutate(
        actor,
        "evidence.unlink",
        { evidenceId: String((linked.evidence as { id: string }).id) },
        key("unlink"),
      );

      const after = await pool.query<{ state: string }>(
        "SELECT state FROM pursuit_requirements WHERE id = $1",
        [requirementId],
      );
      expect(after.rows[0].state).toBe("in_progress");
    });
  });

  it("keeps a private artifact invisible to another actor and to evidence linking", async (context) => {
    await withPostgreSql(context, async (pool) => {
      const owner = await createActor(pool);
      const other = await createActor(pool, "member");
      const { pursuit, projectId } = await createPursuitProject(pool, owner, "Mojave");

      const artifact = await pursuit.mutate(
        owner,
        "artifact.create",
        {
          mode: "native",
          title: "Private appraisal",
          storageKey: "documents/appraisal.pdf",
          visibility: "private",
          projectId,
        },
        key("artifact"),
      );
      const artifactId = String((artifact.artifact as { id: string }).id);

      const ownerView = await pursuit.query(owner, "artifact.list", { projectId });
      expect((ownerView.artifacts as unknown[]).length).toBe(1);

      // Membership grants project access but not another actor's private artifact.
      await pool.query(
        `INSERT INTO project_memberships (id, organization_id, project_id, user_id, role, created_by_actor_id)
         VALUES (gen_random_uuid(), $1, $2, $3, 'editor', $4)`,
        [organizationId, projectId, other.userId, owner.actorId],
      );
      const otherView = await pursuit.query(other, "artifact.list", { projectId });
      expect(otherView.artifacts).toEqual([]);

      await expect(
        pursuit.mutate(
          other,
          "evidence.link",
          { artifactId, targetType: "requirement", targetId: randomUUID() },
          key("evidence"),
        ),
      ).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });
    });
  });

  it("produces an immutable snapshot with its own checksum and provenance", async (context) => {
    await withPostgreSql(context, async (pool) => {
      const actor = await createActor(pool);
      const { pursuit, projectId } = await createPursuitProject(pool, actor, "Mojave");
      const artifact = await pursuit.mutate(
        actor,
        "artifact.create",
        { mode: "linked", title: "Drive term sheet", canonicalUrl: "https://drive.example.com/x", projectId },
        key("artifact"),
      );
      const sourceId = String((artifact.artifact as { id: string }).id);

      const snapshot = await pursuit.mutate(actor, "artifact.snapshot", { artifactId: sourceId }, key("snap"));
      const record = snapshot.artifact as {
        mode: string;
        checksum: string;
        snapshotOfArtifactId: string;
        snapshotTakenAt: string;
        canonicalUrl: string;
      };
      expect(record.mode).toBe("snapshot");
      expect(record.checksum).toMatch(/^[0-9a-f]{64}$/);
      expect(record.snapshotOfArtifactId).toBe(sourceId);
      expect(record.snapshotTakenAt).toBeTruthy();
      expect(record.canonicalUrl).toBe("https://drive.example.com/x");
    });
  });
});
