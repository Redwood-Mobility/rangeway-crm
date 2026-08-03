import { createHash, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { describe, expect, it, type TestContext } from "vitest";
import type { ActorContext } from "../../src/shared/identity.js";
import {
  audienceProfiles,
  audienceRoles,
  reportTemplates,
  resolveSections,
  templateDefinitions,
} from "../../src/shared/reports.js";
import { OperatingCoreService } from "../../src/server/modules/operating-core/operating-core.service.js";
import { PursuitService } from "../../src/server/modules/pursuit/pursuit.service.js";
import { ReportService } from "../../src/server/modules/reports/report.service.js";
import { renderPdf } from "../../src/server/modules/reports/pdf.js";
import { createPool } from "../../src/server/platform/db/client.js";
import { runMigrations } from "../../src/server/platform/db/migrate.js";
import { createTemporaryDatabase, PostgreSqlUnavailableError } from "../helpers/database.js";

const organizationId = "00000000-0000-4000-8000-000000000001";
const key = (prefix: string) => `${prefix}-${randomUUID()}`;

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

async function createOwner(pool: Pool): Promise<ActorContext> {
  const userId = randomUUID();
  const actorId = randomUUID();
  await pool.query("BEGIN");
  await pool.query("SET CONSTRAINTS ALL DEFERRED");
  await pool.query("INSERT INTO users (id, email, display_name) VALUES ($1, $2, 'Owner')", [
    userId,
    `${userId}@rangeway.energy`,
  ]);
  await pool.query(
    `INSERT INTO actors (id, organization_id, type, role, user_id, display_name)
     VALUES ($1, $2, 'human', 'owner', $3, 'Owner')`,
    [actorId, organizationId, userId],
  );
  await pool.query(
    "INSERT INTO organization_memberships (organization_id, user_id, role) VALUES ($1, $2, 'owner')",
    [organizationId, userId],
  );
  await pool.query("COMMIT");
  return {
    actorId,
    actorType: "human",
    actorName: "Owner",
    organizationId,
    role: "owner",
    userId,
    requestId: randomUUID(),
  };
}

async function seedProject(pool: Pool, actor: ActorContext) {
  const core = new OperatingCoreService(pool);
  const created = await core.mutate(
    actor,
    "project.create",
    {
      name: "Mojave",
      objective: "Qualify a Location Pursuit.",
      ownerUserId: actor.userId,
      templateType: "location_pursuit",
      status: "active",
      currentFocus: "Utility capacity",
      nextAction: "Confirm serving utility",
    },
    key("project"),
  );
  const projectId = String((created.project as { id: string }).id);
  await core.mutate(
    actor,
    "work.create",
    {
      projectId,
      type: "action",
      title: "Confirm serving utility",
      status: "next",
      priority: "high",
      position: 100,
      labelIds: [],
    },
    key("work"),
  );
  await core.mutate(
    actor,
    "risk.create",
    {
      projectId,
      title: "Interconnection timeline",
      description: "Queue position may slip.",
      likelihood: "medium",
      impact: "high",
      mitigation: "Early application",
      state: "open",
    },
    key("risk"),
  );
  return projectId;
}

describe("report templates and audience profiles", () => {
  it("defines the seven approved templates and seven audience roles", () => {
    expect(reportTemplates).toHaveLength(7);
    expect(audienceRoles).toHaveLength(7);
    for (const template of reportTemplates) {
      expect(templateDefinitions[template].sections.length).toBeGreaterThan(0);
    }
  });

  it("names roles, never people", () => {
    // A profile keyed or labelled for an individual would leak person-specific
    // disclosure logic into every report built from it.
    for (const role of audienceRoles) {
      const profile = audienceProfiles[role];
      expect(profile.label).not.toMatch(/zak|winnick|@/i);
      expect(role).not.toMatch(/zak|winnick/i);
    }
  });

  it("withholds economics and risk detail per audience with a recorded reason", () => {
    const decisions = resolveSections(
      templateDefinitions.investor_portfolio_update,
      audienceProfiles.community_public,
    );
    const economics = decisions.find((decision) => decision.section === "economics");
    expect(economics).toMatchObject({ included: false });
    expect(economics?.reason).toMatch(/excluded_for_community_public|economics_withheld/);

    const investor = resolveSections(
      templateDefinitions.investor_portfolio_update,
      audienceProfiles.capital_investor,
    );
    expect(investor.find((decision) => decision.section === "economics")?.included).toBe(true);
  });
});

describe("deterministic PDF rendering", () => {
  it("produces byte-identical output for identical input", () => {
    const document = {
      title: "Location Pursuit snapshot",
      blocks: [
        { text: "RANGEWAY", font: "Helvetica-Bold" as const, size: 10 },
        { text: "Mojave", font: "Helvetica-Bold" as const, size: 20 },
        { text: "Utility capacity confirmed with the serving utility.", font: "Helvetica" as const, size: 11 },
      ],
    };
    const first = renderPdf(document);
    const second = renderPdf(document);
    expect(first.equals(second)).toBe(true);
    expect(createHash("sha256").update(first).digest("hex")).toBe(
      createHash("sha256").update(second).digest("hex"),
    );
    expect(first.subarray(0, 8).toString("latin1")).toBe("%PDF-1.4");
    expect(first.toString("latin1")).toContain("%%EOF");
  });

  it("contains no timestamp or random identifier that could vary between runs", () => {
    const pdf = renderPdf({
      title: "T",
      blocks: [{ text: "Body", font: "Helvetica", size: 11 }],
    }).toString("latin1");
    expect(pdf).not.toContain("/CreationDate");
    expect(pdf).not.toContain("/ModDate");
    // The file identifier is derived from content, so the same content repeats it.
    const identifier = /\/ID \[<([0-9A-F]+)>/.exec(pdf)?.[1];
    const repeat = /\/ID \[<([0-9A-F]+)>/.exec(
      renderPdf({ title: "T", blocks: [{ text: "Body", font: "Helvetica", size: 11 }] }).toString("latin1"),
    )?.[1];
    expect(identifier).toBe(repeat);
  });

  it("substitutes characters outside Latin-1 rather than corrupting the file", () => {
    const pdf = renderPdf({
      title: "Hawaii",
      blocks: [{ text: "Hawaiʻi — St. Louis “The Landing”", font: "Helvetica", size: 11 }],
    }).toString("latin1");
    expect(pdf).toContain("Hawai'i - St. Louis \\\"The Landing\\\"".replace(/\\"/g, '"'));
  });
});

describe("governed reports", () => {
  it("freezes a snapshot and renders the same bytes twice", async (context) => {
    await withPostgreSql(context, async (pool) => {
      const actor = await createOwner(pool);
      const projectId = await seedProject(pool, actor);
      const reports = new ReportService(pool);

      const prepared = await reports.mutate(
        actor,
        "report.prepare",
        {
          templateKey: "location_pursuit_snapshot",
          audienceRole: "development_partner",
          projectId,
          sourceCutoff: "2026-08-03T00:00:00.000Z",
        },
        key("prepare"),
      );
      const reportId = String((prepared.report as { id: string }).id);

      await reports.mutate(actor, "report.approve", { reportId }, key("approve"));
      const firstRender = await reports.mutate(actor, "report.render", { reportId }, key("render"));
      const firstChecksum = String((firstRender.report as { checksum: string }).checksum);

      // Re-rendering the same approved snapshot reproduces the same bytes.
      const bytesA = await reports.renderBytes(actor, reportId);
      const bytesB = await reports.renderBytes(actor, reportId);
      expect(bytesA.equals(bytesB)).toBe(true);
      expect(createHash("sha256").update(bytesA).digest("hex")).toBe(firstChecksum);
    });
  });

  it("refuses to render before approval", async (context) => {
    await withPostgreSql(context, async (pool) => {
      const actor = await createOwner(pool);
      const projectId = await seedProject(pool, actor);
      const reports = new ReportService(pool);
      const prepared = await reports.mutate(
        actor,
        "report.prepare",
        { templateKey: "partner_briefing", audienceRole: "development_partner", projectId },
        key("prepare"),
      );
      await expect(
        reports.mutate(
          actor,
          "report.render",
          { reportId: String((prepared.report as { id: string }).id) },
          key("render"),
        ),
      ).rejects.toMatchObject({ status: 409, code: "CONFLICT" });
    });
  });

  it("records why every excluded section was left out", async (context) => {
    await withPostgreSql(context, async (pool) => {
      const actor = await createOwner(pool);
      const projectId = await seedProject(pool, actor);
      const reports = new ReportService(pool);

      const prepared = await reports.mutate(
        actor,
        "report.prepare",
        { templateKey: "project_development_update", audienceRole: "public_agency", projectId },
        key("prepare"),
      );
      const reportId = String((prepared.report as { id: string }).id);
      const stored = await reports.query(actor, "report.get", { reportId });
      const decisions = (stored.report as { sectionDecisions: Array<{ section: string; included: boolean; reason: string }> })
        .sectionDecisions;

      const withheld = decisions.filter((decision) => !decision.included);
      expect(withheld.length).toBeGreaterThan(0);
      for (const decision of withheld) {
        expect(decision.reason.length).toBeGreaterThan(0);
      }
      // A public agency does not receive decision content.
      expect(withheld.map((decision) => decision.section)).toContain("decisions");
    });
  });

  it("excludes private artifacts from report evidence", async (context) => {
    await withPostgreSql(context, async (pool) => {
      const actor = await createOwner(pool);
      const projectId = await seedProject(pool, actor);
      const pursuit = new PursuitService(pool);

      await pursuit.mutate(
        actor,
        "artifact.create",
        {
          mode: "native",
          title: "Confidential appraisal",
          storageKey: "documents/appraisal.pdf",
          visibility: "private",
          projectId,
        },
        key("artifact"),
      );
      await pursuit.mutate(actor, "pursuit.enable", { projectId }, key("enable"));
      const readiness = await pursuit.query(actor, "pursuit.readiness", { projectId });
      const requirementId = (
        (readiness.developmentAreas as Array<{ requirements: Array<{ requirementId: string }> }>)[0]
          .requirements[0]
      ).requirementId;
      const privateArtifact = await pool.query<{ id: string }>(
        "SELECT id FROM artifacts WHERE visibility = 'private'",
      );
      await pursuit.mutate(
        actor,
        "evidence.link",
        {
          artifactId: privateArtifact.rows[0].id,
          targetType: "requirement",
          targetId: requirementId,
        },
        key("evidence"),
      );

      const reports = new ReportService(pool);
      const prepared = await reports.mutate(
        actor,
        "report.prepare",
        { templateKey: "diligence_evidence_summary", audienceRole: "development_partner", projectId },
        key("prepare"),
      );
      const stored = await reports.query(actor, "report.get", {
        reportId: String((prepared.report as { id: string }).id),
      });
      const serialized = JSON.stringify(stored);
      expect(serialized).not.toContain("Confidential appraisal");
      expect(serialized).toContain("private_artifacts_excluded");
    });
  });

  it("prepares a draft delivery without authority and records provider acceptance with it", async (context) => {
    await withPostgreSql(context, async (pool) => {
      const actor = await createOwner(pool);
      const projectId = await seedProject(pool, actor);
      const reports = new ReportService(pool);

      const prepared = await reports.mutate(
        actor,
        "report.prepare",
        { templateKey: "partner_briefing", audienceRole: "development_partner", projectId },
        key("prepare"),
      );
      const reportId = String((prepared.report as { id: string }).id);
      await reports.mutate(actor, "report.approve", { reportId }, key("approve"));
      await reports.mutate(actor, "report.render", { reportId }, key("render"));

      // Without explicit authority the delivery is prepared, not sent.
      const draft = await reports.mutate(
        actor,
        "report.deliver",
        {
          reportId,
          channel: "email",
          sender: "zak@rangeway.energy",
          recipient: "partner@example.com",
          deliveryIdempotencyKey: "delivery-partner-0001",
        },
        key("deliver"),
      );
      expect((draft.delivery as { state: string }).state).toBe("prepared");
      expect((draft.delivery as { sentAt: string | null }).sentAt).toBeNull();

      // Replaying the same delivery key does not create a second delivery.
      await reports.mutate(
        actor,
        "report.deliver",
        { reportId, deliveryIdempotencyKey: "delivery-partner-0001" },
        key("deliver2"),
      );
      const count = await pool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM report_deliveries",
      );
      expect(count.rows[0].count).toBe("1");

      const sent = await reports.mutate(
        actor,
        "report.deliver",
        {
          reportId,
          channel: "email",
          sender: "zak@rangeway.energy",
          recipient: "partner@example.com",
          deliveryIdempotencyKey: "delivery-partner-0002",
          externalDeliveryAuthorized: true,
          providerAcceptance: "smtp-250-ok",
        },
        key("deliver3"),
      );
      const delivery = sent.delivery as {
        state: string;
        recipient: string;
        sender: string;
        channel: string;
        providerAcceptance: string;
        idempotencyKey: string;
      };
      expect(delivery).toMatchObject({
        state: "sent",
        recipient: "partner@example.com",
        sender: "zak@rangeway.energy",
        channel: "email",
        providerAcceptance: "smtp-250-ok",
        idempotencyKey: "delivery-partner-0002",
      });
    });
  });
});
