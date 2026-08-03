import { createHash, randomUUID } from "node:crypto";
import type { Pool, QueryResultRow } from "pg";
import type { ActorContext } from "../../../shared/identity.js";
import { atlasEventTypes } from "../../../shared/events.js";
import {
  audienceProfileVersion,
  audienceProfiles,
  reportTemplateVersion,
  resolveSections,
  templateDefinitions,
  type AudienceRole,
  type ReportTemplateKey,
  type SectionDecision,
} from "../../../shared/reports.js";
import { ApiError } from "../../platform/http/api-error.js";
import type { DbClient } from "../../platform/db/client.js";
import { mutateIdempotentlyWithAuditAndEvent } from "../events/outbox.service.js";
import { renderPdf, type PdfBlock } from "./pdf.js";

type Input = Record<string, unknown>;
type Result = Record<string, unknown>;
type Row = QueryResultRow & Record<string, unknown>;

function camelize(row: Row): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase()),
      value instanceof Date ? value.toISOString() : value,
    ]),
  );
}

const notFound = () => new ApiError(404, "NOT_FOUND", "Resource not found.");
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function requiredId(input: Input, field: string): string {
  const value = input[field];
  if (typeof value !== "string" || !uuidPattern.test(value)) {
    throw new ApiError(400, "INVALID_INPUT", `A valid ${field} is required.`);
  }
  return value;
}

function requestHash(operation: string, input: Input): string {
  return createHash("sha256").update(JSON.stringify({ operation, input })).digest("hex");
}

export interface SnapshotContent {
  title: string;
  templateKey: ReportTemplateKey;
  templateVersion: number;
  audienceRole: AudienceRole;
  audienceLabel: string;
  profileVersion: number;
  sourceCutoff: string;
  generatedForOrganization: string;
  projectName: string | null;
  sections: Array<{ section: string; heading: string; lines: string[] }>;
}

export interface ReportPort {
  query(actor: ActorContext, operation: string, input: Input): Promise<Result>;
  mutate(actor: ActorContext, operation: string, input: Input, key: string): Promise<Result>;
}

export class ReportService implements ReportPort {
  constructor(private readonly pool: Pool) {}

  async query(actor: ActorContext, operation: string, input: Input): Promise<Result> {
    switch (operation) {
      case "report.list":
        return this.listReports(actor, input);
      case "report.get":
        return this.getReport(actor, requiredId(input, "reportId"));
      default:
        throw notFound();
    }
  }

  async mutate(actor: ActorContext, operation: string, input: Input, key: string): Promise<Result> {
    return mutateIdempotentlyWithAuditAndEvent(
      this.pool,
      actor,
      { operation: `${operation}.v1`, key, requestHash: requestHash(operation, input) },
      (client) => this.performMutation(client, actor, operation, input),
    );
  }

  private async performMutation(client: DbClient, actor: ActorContext, operation: string, input: Input) {
    switch (operation) {
      case "report.prepare":
        return this.prepare(client, actor, input);
      case "report.revise":
        return this.revise(client, actor, input);
      case "report.approve":
        return this.approve(client, actor, input);
      case "report.render":
        return this.render(client, actor, input);
      case "report.deliver":
        return this.deliver(client, actor, input);
      default:
        throw notFound();
    }
  }

  // -------------------------------------------------------------- prepare --

  private async prepare(client: DbClient, actor: ActorContext, input: Input) {
    const templateKey = String(input.templateKey) as ReportTemplateKey;
    const audienceRole = String(input.audienceRole) as AudienceRole;
    const template = templateDefinitions[templateKey];
    const profile = audienceProfiles[audienceRole];
    if (!template || !profile) {
      throw new ApiError(400, "INVALID_INPUT", "Unknown report template or audience role.");
    }

    const sourceCutoff = String(input.sourceCutoff ?? new Date().toISOString());
    const projectId = template.scope === "project" ? requiredId(input, "projectId") : null;

    let project: Row | null = null;
    if (projectId) {
      const result = await client.query<Row>(
        `SELECT p.* FROM project_rooms p
          WHERE p.organization_id = $1 AND p.id = $2
            AND ($3::text IN ('owner','admin') OR p.owner_user_id = $4::uuid
                 OR EXISTS (SELECT 1 FROM project_memberships pm
                             WHERE pm.organization_id = p.organization_id
                               AND pm.project_id = p.id AND pm.user_id = $4::uuid))`,
        [actor.organizationId, projectId, actor.role, actor.userId ?? null],
      );
      project = result.rows[0] ?? null;
      if (!project) throw notFound();
    }

    const decisions = resolveSections(template, profile);
    const { sections, sourceIds, visibilityNotes } = await this.collectSections(
      client,
      actor,
      decisions,
      project,
      sourceCutoff,
    );

    const title = `${template.title} — ${project ? String(project.name) : "Portfolio"}`;
    const content: SnapshotContent = {
      title,
      templateKey,
      templateVersion: reportTemplateVersion,
      audienceRole,
      audienceLabel: profile.label,
      profileVersion: audienceProfileVersion,
      sourceCutoff,
      generatedForOrganization: "Rangeway",
      projectName: project ? String(project.name) : null,
      sections,
    };

    const reportId = randomUUID();
    await client.query(
      `INSERT INTO reports
         (id, organization_id, project_id, template_key, template_version, audience_role,
          profile_version, title, source_cutoff, created_by_actor_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        reportId,
        actor.organizationId,
        projectId,
        templateKey,
        reportTemplateVersion,
        audienceRole,
        audienceProfileVersion,
        title,
        sourceCutoff,
        actor.actorId,
      ],
    );

    // The snapshot is hashed over its exact content so a later render can prove
    // it is rendering what was approved.
    const checksum = createHash("sha256").update(JSON.stringify(content)).digest("hex");
    await client.query(
      `INSERT INTO report_snapshots
         (id, organization_id, report_id, content, source_ids, section_decisions, visibility_notes, checksum)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7)`,
      [
        actor.organizationId,
        reportId,
        JSON.stringify(content),
        JSON.stringify(sourceIds),
        JSON.stringify(decisions),
        JSON.stringify(visibilityNotes),
        checksum,
      ],
    );

    const report = { id: reportId, title, state: "draft", checksum, sectionDecisions: decisions };
    return this.record(actor, "report.prepared", "report", reportId, { report, content }, null, report);
  }

  /**
   * Gathers section content from authorized records only, and records why any
   * section was left empty or withheld.
   */
  private async collectSections(
    client: DbClient,
    actor: ActorContext,
    decisions: SectionDecision[],
    project: Row | null,
    sourceCutoff: string,
  ): Promise<{
    sections: SnapshotContent["sections"];
    sourceIds: string[];
    visibilityNotes: Array<{ section: string; note: string }>;
  }> {
    const sections: SnapshotContent["sections"] = [];
    const sourceIds: string[] = [];
    const visibilityNotes: Array<{ section: string; note: string }> = [];

    for (const decision of decisions) {
      if (!decision.included) {
        visibilityNotes.push({ section: decision.section, note: decision.reason });
        continue;
      }

      if (decision.section === "summary") {
        sections.push({
          section: "summary",
          heading: "Summary",
          lines: project
            ? [
                `Project: ${String(project.name)}`,
                `Objective: ${String(project.objective) || "Not stated"}`,
                `Status: ${String(project.status)}`,
              ]
            : ["Organization-wide operating summary."],
        });
        if (project) sourceIds.push(`project:${String(project.id)}`);
        continue;
      }

      if (decision.section === "health" && project) {
        sections.push({
          section: "health",
          heading: "Health",
          lines: [`Current health: ${String(project.health).replaceAll("_", " ")}`],
        });
        continue;
      }

      if (decision.section === "focus" && project) {
        sections.push({
          section: "focus",
          heading: "Current focus",
          lines: [
            `Focus: ${String(project.current_focus) || "Not stated"}`,
            `Blocker: ${String(project.blocker_summary) || "None recorded"}`,
            `Next decision: ${String(project.next_decision) || "None recorded"}`,
            `Next action: ${String(project.next_action) || "None recorded"}`,
          ],
        });
        continue;
      }

      if (decision.section === "work" && project) {
        const work = await client.query<Row>(
          `SELECT id, title, status FROM work_items
            WHERE organization_id = $1 AND project_id = $2 AND archived_at IS NULL
              AND created_at <= $3::timestamptz
            ORDER BY created_at LIMIT 50`,
          [actor.organizationId, project.id, sourceCutoff],
        );
        for (const row of work.rows) sourceIds.push(`work_item:${String(row.id)}`);
        sections.push({
          section: "work",
          heading: "Work",
          lines:
            work.rows.length === 0
              ? ["No work recorded before the source cutoff."]
              : work.rows.map((row) => `${String(row.title)} — ${String(row.status).replaceAll("_", " ")}`),
        });
        continue;
      }

      if (decision.section === "milestones" && project) {
        const milestones = await client.query<Row>(
          `SELECT id, outcome, target_at, state FROM milestones
            WHERE organization_id = $1 AND project_id = $2 AND archived_at IS NULL
              AND created_at <= $3::timestamptz
            ORDER BY target_at NULLS LAST LIMIT 50`,
          [actor.organizationId, project.id, sourceCutoff],
        );
        for (const row of milestones.rows) sourceIds.push(`milestone:${String(row.id)}`);
        sections.push({
          section: "milestones",
          heading: "Milestones",
          lines:
            milestones.rows.length === 0
              ? ["No milestones recorded."]
              : milestones.rows.map(
                  (row) =>
                    `${String(row.outcome)} — ${
                      row.target_at instanceof Date ? row.target_at.toISOString().slice(0, 10) : "no date"
                    } (${String(row.state)})`,
                ),
        });
        continue;
      }

      if (decision.section === "decisions" && project) {
        const rows = await client.query<Row>(
          `SELECT id, question, state, outcome FROM decisions
            WHERE organization_id = $1 AND primary_project_id = $2 AND archived_at IS NULL
              AND created_at <= $3::timestamptz
            ORDER BY created_at LIMIT 50`,
          [actor.organizationId, project.id, sourceCutoff],
        );
        for (const row of rows.rows) sourceIds.push(`decision:${String(row.id)}`);
        sections.push({
          section: "decisions",
          heading: "Decisions",
          lines:
            rows.rows.length === 0
              ? ["No decisions recorded."]
              : rows.rows.map((row) => `${String(row.question)} — ${String(row.state)}`),
        });
        continue;
      }

      if (decision.section === "risks" && project) {
        const rows = await client.query<Row>(
          `SELECT id, title, likelihood, impact, state FROM risks
            WHERE organization_id = $1 AND project_id = $2 AND archived_at IS NULL
              AND created_at <= $3::timestamptz
            ORDER BY created_at LIMIT 50`,
          [actor.organizationId, project.id, sourceCutoff],
        );
        for (const row of rows.rows) sourceIds.push(`risk:${String(row.id)}`);
        sections.push({
          section: "risks",
          heading: "Risks",
          lines:
            rows.rows.length === 0
              ? ["No risks recorded."]
              : rows.rows.map(
                  (row) =>
                    `${String(row.title)} — ${String(row.likelihood)} likelihood, ${String(row.impact)} impact (${String(row.state)})`,
                ),
        });
        continue;
      }

      if (decision.section === "readiness" && project) {
        const rows = await client.query<Row>(
          `SELECT area.name AS area_name,
                  count(*) FILTER (WHERE r.state IN ('evidenced','waived','not_applicable'))::int AS satisfied,
                  count(*)::int AS total
             FROM pursuit_requirements r
             JOIN pursuit_requirement_definitions d
               ON d.organization_id = r.organization_id AND d.id = r.definition_id
             JOIN pursuit_development_areas area
               ON area.organization_id = d.organization_id AND area.id = d.development_area_id
            WHERE r.organization_id = $1 AND r.project_id = $2
            GROUP BY area.name, area.position ORDER BY area.position`,
          [actor.organizationId, project.id],
        );
        sections.push({
          section: "readiness",
          heading: "Development readiness",
          lines:
            rows.rows.length === 0
              ? ["Location Pursuit gates are not enabled for this project."]
              : rows.rows.map(
                  (row) => `${String(row.area_name)}: ${String(row.satisfied)} of ${String(row.total)} satisfied`,
                ),
        });
        continue;
      }

      if (decision.section === "evidence" && project) {
        const rows = await client.query<Row>(
          `SELECT e.id, a.title, a.checksum, a.mode
             FROM evidence_links e
             JOIN artifacts a ON a.organization_id = e.organization_id AND a.id = e.artifact_id
            WHERE e.organization_id = $1 AND e.archived_at IS NULL
              AND a.visibility = 'project'
              AND EXISTS (
                SELECT 1 FROM artifact_projects link
                 WHERE link.organization_id = a.organization_id
                   AND link.artifact_id = a.id AND link.project_id = $2
              )
            ORDER BY e.created_at LIMIT 50`,
          [actor.organizationId, project.id],
        );
        for (const row of rows.rows) sourceIds.push(`evidence:${String(row.id)}`);
        // Private artifacts are never eligible as report evidence.
        visibilityNotes.push({
          section: "evidence",
          note: "private_artifacts_excluded",
        });
        sections.push({
          section: "evidence",
          heading: "Evidence",
          lines:
            rows.rows.length === 0
              ? ["No project-visible evidence linked."]
              : rows.rows.map(
                  (row) => `${String(row.title)} (${String(row.mode)}, checksum ${String(row.checksum).slice(0, 12)}…)`,
                ),
        });
        continue;
      }

      if (decision.section === "portfolio") {
        const rows = await client.query<Row>(
          `SELECT p.id, p.name, p.health, p.status FROM project_rooms p
            WHERE p.organization_id = $1 AND p.archived_at IS NULL
              AND ($2::text IN ('owner','admin') OR p.owner_user_id = $3::uuid
                   OR EXISTS (SELECT 1 FROM project_memberships pm
                               WHERE pm.organization_id = p.organization_id
                                 AND pm.project_id = p.id AND pm.user_id = $3::uuid))
            ORDER BY p.name LIMIT 100`,
          [actor.organizationId, actor.role, actor.userId ?? null],
        );
        for (const row of rows.rows) sourceIds.push(`project:${String(row.id)}`);
        sections.push({
          section: "portfolio",
          heading: "Portfolio",
          lines:
            rows.rows.length === 0
              ? ["No active projects."]
              : rows.rows.map(
                  (row) => `${String(row.name)} — ${String(row.health).replaceAll("_", " ")} (${String(row.status)})`,
                ),
        });
        continue;
      }

      // A section with no available source is stated rather than dropped.
      sections.push({
        section: decision.section,
        heading: decision.section,
        lines: ["No supporting data available for this section."],
      });
    }

    return { sections, sourceIds, visibilityNotes };
  }

  // ---------------------------------------------------- revise and approve --

  private async revise(client: DbClient, actor: ActorContext, input: Input) {
    const reportId = requiredId(input, "reportId");
    const before = await client.query<Row>(
      "SELECT * FROM reports WHERE organization_id = $1 AND id = $2 FOR UPDATE",
      [actor.organizationId, reportId],
    );
    if (!before.rows[0]) throw notFound();
    if (before.rows[0].state !== "draft") {
      throw new ApiError(409, "CONFLICT", "Only a draft report can be revised.");
    }
    const updated = await client.query<Row>(
      `UPDATE reports SET narrative = $3, updated_at = now()
        WHERE organization_id = $1 AND id = $2 RETURNING *`,
      [actor.organizationId, reportId, String(input.narrative ?? "")],
    );
    const report = camelize(updated.rows[0]);
    return this.record(actor, "report.revised", "report", reportId, { report }, camelize(before.rows[0]), report);
  }

  private async approve(client: DbClient, actor: ActorContext, input: Input) {
    if (actor.actorType !== "human") {
      throw new ApiError(403, "FORBIDDEN", "A report is approved by a person.");
    }
    const reportId = requiredId(input, "reportId");
    const updated = await client.query<Row>(
      `UPDATE reports
          SET state = 'approved', approved_by_actor_id = $3, approved_at = now(), updated_at = now()
        WHERE organization_id = $1 AND id = $2 AND state = 'draft'
        RETURNING *`,
      [actor.organizationId, reportId, actor.actorId],
    );
    if (!updated.rows[0]) throw notFound();
    const report = camelize(updated.rows[0]);
    return this.record(actor, "report.approved", "report", reportId, { report }, null, report);
  }

  // --------------------------------------------------------------- render --

  private async render(client: DbClient, actor: ActorContext, input: Input) {
    const reportId = requiredId(input, "reportId");
    const reportResult = await client.query<Row>(
      "SELECT * FROM reports WHERE organization_id = $1 AND id = $2 FOR UPDATE",
      [actor.organizationId, reportId],
    );
    const report = reportResult.rows[0];
    if (!report) throw notFound();
    if (report.state === "draft") {
      throw new ApiError(409, "CONFLICT", "A report must be approved before it is rendered.");
    }

    const snapshotResult = await client.query<Row>(
      "SELECT * FROM report_snapshots WHERE organization_id = $1 AND report_id = $2",
      [actor.organizationId, reportId],
    );
    const snapshot = snapshotResult.rows[0];
    if (!snapshot) throw notFound();

    const content = snapshot.content as SnapshotContent;
    // The render is a pure function of the frozen snapshot and the narrative
    // approved with it, which is what makes two renders identical.
    const pdf = renderPdf({
      title: content.title,
      blocks: buildBlocks(content, String(report.narrative ?? "")),
    });
    const checksum = createHash("sha256").update(pdf).digest("hex");

    const artifactId = randomUUID();
    await client.query(
      `INSERT INTO artifacts
         (id, organization_id, mode, title, description, storage_key, mime_type,
          byte_size, checksum, visibility, source_system, snapshot_taken_at,
          provenance, created_by_actor_id, updated_by_actor_id)
       VALUES ($1, $2, 'snapshot', $3, $4, $5, 'application/pdf', $6, $7,
               'project', 'atlas-reports', now(), $8, $9, $9)`,
      [
        artifactId,
        actor.organizationId,
        content.title,
        `${content.audienceLabel} report rendered from an approved snapshot.`,
        `reports/${reportId}/${checksum}.pdf`,
        pdf.byteLength,
        checksum,
        JSON.stringify({
          reportId,
          snapshotChecksum: snapshot.checksum,
          templateKey: content.templateKey,
          templateVersion: content.templateVersion,
          audienceRole: content.audienceRole,
          profileVersion: content.profileVersion,
          sourceCutoff: content.sourceCutoff,
        }),
        actor.actorId,
      ],
    );
    if (report.project_id) {
      await client.query(
        `INSERT INTO artifact_projects (id, organization_id, artifact_id, project_id, created_by_actor_id)
         VALUES (gen_random_uuid(), $1, $2, $3, $4)
         ON CONFLICT (organization_id, artifact_id, project_id) DO NOTHING`,
        [actor.organizationId, artifactId, report.project_id, actor.actorId],
      );
    }

    const updated = await client.query<Row>(
      `UPDATE reports SET state = 'rendered', rendered_artifact_id = $3, render_error = '', updated_at = now()
        WHERE organization_id = $1 AND id = $2 RETURNING *`,
      [actor.organizationId, reportId, artifactId],
    );

    const rendered = {
      ...camelize(updated.rows[0]),
      artifactId,
      checksum,
      byteSize: pdf.byteLength,
    };
    return this.record(actor, "report.rendered", "report", reportId, { report: rendered }, null, rendered);
  }

  /** Produces the exact PDF bytes for a stored snapshot without persisting. */
  async renderBytes(actor: ActorContext, reportId: string): Promise<Buffer> {
    const result = await this.pool.query<Row>(
      `SELECT s.content, r.narrative FROM report_snapshots s
         JOIN reports r ON r.organization_id = s.organization_id AND r.id = s.report_id
        WHERE s.organization_id = $1 AND s.report_id = $2`,
      [actor.organizationId, reportId],
    );
    if (!result.rows[0]) throw notFound();
    const content = result.rows[0].content as SnapshotContent;
    return renderPdf({ title: content.title, blocks: buildBlocks(content, String(result.rows[0].narrative ?? "")) });
  }

  // -------------------------------------------------------------- deliver --

  private async deliver(client: DbClient, actor: ActorContext, input: Input) {
    const reportId = requiredId(input, "reportId");
    const reportResult = await client.query<Row>(
      "SELECT * FROM reports WHERE organization_id = $1 AND id = $2 FOR UPDATE",
      [actor.organizationId, reportId],
    );
    const report = reportResult.rows[0];
    if (!report) throw notFound();
    if (report.state !== "rendered" && report.state !== "delivered") {
      throw new ApiError(409, "CONFLICT", "A report must be rendered before it is delivered.");
    }
    if (!report.rendered_artifact_id) throw new ApiError(409, "CONFLICT", "No rendered artifact.");

    // Sending is an outward action. Without explicit authority Atlas prepares
    // the delivery and stops, leaving a ready-to-send draft.
    const authorized = input.externalDeliveryAuthorized === true && actor.actorType === "human";
    const deliveryId = randomUUID();
    const deliveryKey = String(input.deliveryIdempotencyKey ?? deliveryId);

    const existing = await client.query<Row>(
      "SELECT * FROM report_deliveries WHERE organization_id = $1 AND idempotency_key = $2",
      [actor.organizationId, deliveryKey],
    );
    if (existing.rows[0]) {
      const delivery = camelize(existing.rows[0]);
      return this.record(actor, "report.delivery-replayed", "report_delivery", String(existing.rows[0].id), { delivery }, null, delivery);
    }

    const created = await client.query<Row>(
      `INSERT INTO report_deliveries
         (id, organization_id, report_id, artifact_id, channel, sender, recipient,
          idempotency_key, state, provider_acceptance, authorized_by_actor_id, sent_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::delivery_state, $10, $11, $12)
       RETURNING *`,
      [
        deliveryId,
        actor.organizationId,
        reportId,
        report.rendered_artifact_id,
        String(input.channel ?? "email"),
        String(input.sender ?? ""),
        String(input.recipient ?? ""),
        deliveryKey,
        authorized ? "sent" : "prepared",
        authorized ? String(input.providerAcceptance ?? `accepted-${deliveryKey}`) : "",
        actor.actorId,
        authorized ? new Date() : null,
      ],
    );

    if (authorized) {
      await client.query(
        "UPDATE reports SET state = 'delivered', updated_at = now() WHERE organization_id = $1 AND id = $2",
        [actor.organizationId, reportId],
      );
    }

    const delivery = camelize(created.rows[0]);
    return this.record(
      actor,
      authorized ? "report.delivered" : "report.delivery-prepared",
      "report_delivery",
      deliveryId,
      { delivery },
      null,
      delivery,
    );
  }

  // ---------------------------------------------------------------- reads --

  private async listReports(actor: ActorContext, input: Input): Promise<Result> {
    const result = await this.pool.query<Row>(
      `SELECT r.* FROM reports r
        LEFT JOIN project_rooms p
          ON p.organization_id = r.organization_id AND p.id = r.project_id
       WHERE r.organization_id = $1 AND r.archived_at IS NULL
         AND ($4::uuid IS NULL OR r.project_id = $4::uuid)
         AND (r.project_id IS NULL
              OR $2::text IN ('owner','admin') OR p.owner_user_id = $3::uuid
              OR EXISTS (SELECT 1 FROM project_memberships pm
                          WHERE pm.organization_id = p.organization_id
                            AND pm.project_id = p.id AND pm.user_id = $3::uuid))
       ORDER BY r.created_at DESC LIMIT 100`,
      [actor.organizationId, actor.role, actor.userId ?? null, input.projectId ?? null],
    );
    return { reports: result.rows.map(camelize) };
  }

  private async getReport(actor: ActorContext, reportId: string): Promise<Result> {
    const result = await this.pool.query<Row>(
      `SELECT r.*, s.content, s.checksum AS snapshot_checksum,
              s.section_decisions, s.visibility_notes, s.source_ids
         FROM reports r
         JOIN report_snapshots s ON s.organization_id = r.organization_id AND s.report_id = r.id
        WHERE r.organization_id = $1 AND r.id = $2`,
      [actor.organizationId, reportId],
    );
    if (!result.rows[0]) throw notFound();
    const deliveries = await this.pool.query<Row>(
      "SELECT * FROM report_deliveries WHERE organization_id = $1 AND report_id = $2 ORDER BY created_at",
      [actor.organizationId, reportId],
    );
    return { report: camelize(result.rows[0]), deliveries: deliveries.rows.map(camelize) };
  }

  private record(
    actor: ActorContext,
    operation: string,
    resourceType: string,
    resourceId: string,
    value: Result,
    before: Record<string, unknown> | null,
    after: Record<string, unknown> | null,
  ) {
    return {
      value,
      audit: {
        organizationId: actor.organizationId,
        actorId: actor.actorId,
        requestId: actor.requestId,
        action: operation,
        resourceType,
        resourceId,
        before,
        after,
      },
      event: {
        organizationId: actor.organizationId,
        actorId: actor.actorId,
        requestId: actor.requestId,
        eventType: atlasEventTypes.reportChanged,
        aggregateType: resourceType,
        aggregateId: resourceId,
        schemaVersion: 1,
        payload: { operation, resourceId },
      },
    };
  }
}

/** Lays the snapshot out as ordered typographic blocks. */
export function buildBlocks(content: SnapshotContent, narrative: string): PdfBlock[] {
  const blocks: PdfBlock[] = [
    { text: "RANGEWAY", font: "Helvetica-Bold", size: 10 },
    { text: content.title, font: "Helvetica-Bold", size: 20, spaceBefore: 6 },
    {
      text: `Prepared for: ${content.audienceLabel}`,
      font: "Helvetica",
      size: 10,
      spaceBefore: 6,
    },
    {
      text:
        `Source cutoff: ${content.sourceCutoff}    ` +
        `Template ${content.templateKey} v${content.templateVersion}    ` +
        `Profile v${content.profileVersion}`,
      font: "Helvetica",
      size: 9,
    },
  ];

  if (narrative.trim().length > 0) {
    blocks.push({ text: narrative, font: "Helvetica", size: 11, spaceBefore: 14 });
  }

  for (const section of content.sections) {
    blocks.push({ text: section.heading.toUpperCase(), font: "Helvetica-Bold", size: 12, spaceBefore: 16 });
    for (const line of section.lines) {
      blocks.push({ text: line, font: "Helvetica", size: 10.5, spaceBefore: 2 });
    }
  }

  return blocks;
}
