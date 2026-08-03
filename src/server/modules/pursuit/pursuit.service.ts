import { createHash, randomUUID } from "node:crypto";
import type { Pool, QueryResultRow } from "pg";
import type { ActorContext } from "../../../shared/identity.js";
import { atlasEventTypes } from "../../../shared/events.js";
import {
  locationPursuitDevelopmentAreas,
  locationPursuitTemplateKey,
  locationPursuitTemplateVersion,
  phaseIndex,
  satisfyingRequirementStates,
  unmetRequirementsForPhase,
  waiverRequirementStates,
  type PursuitPhase,
  type RequirementState,
} from "../../../shared/location-pursuit.js";
import { ApiError } from "../../platform/http/api-error.js";
import type { DbClient } from "../../platform/db/client.js";
import { mutateIdempotentlyWithAuditAndEvent } from "../events/outbox.service.js";

type Input = Record<string, unknown>;
type Result = Record<string, unknown>;
type Row = QueryResultRow & Record<string, unknown>;

function camelize(row: Row): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key.replace(/_([a-z])/g, (_match, character: string) => character.toUpperCase()),
      value instanceof Date ? value.toISOString() : value,
    ]),
  );
}

function notFound(): ApiError {
  return new ApiError(404, "NOT_FOUND", "Resource not found.");
}

function conflict(message: string): ApiError {
  return new ApiError(409, "CONFLICT", message);
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Identifiers reach SQL only after they are known to be UUIDs, so a missing or
 * malformed value returns INVALID_INPUT instead of a database syntax error.
 */
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

/** Repeats the project access rule used across the Operating Core. */
const projectAccessSql = `(
  $2::text IN ('owner', 'admin')
  OR p.owner_user_id = $3::uuid
  OR EXISTS (
    SELECT 1 FROM project_memberships pm
     WHERE pm.organization_id = p.organization_id
       AND pm.project_id = p.id
       AND pm.user_id = $3::uuid
  )
)`;

export interface PursuitPort {
  query(actor: ActorContext, operation: string, input: Input): Promise<Result>;
  mutate(actor: ActorContext, operation: string, input: Input, idempotencyKey: string): Promise<Result>;
}

export class PursuitService implements PursuitPort {
  constructor(private readonly pool: Pool) {}

  async query(actor: ActorContext, operation: string, input: Input): Promise<Result> {
    switch (operation) {
      case "pursuit.readiness":
        return this.readiness(actor, requiredId(input, "projectId"));
      case "artifact.list":
        return this.listArtifacts(actor, input);
      case "evidence.list":
        return this.listEvidence(actor, input);
      default:
        throw notFound();
    }
  }

  async mutate(
    actor: ActorContext,
    operation: string,
    input: Input,
    idempotencyKey: string,
  ): Promise<Result> {
    return mutateIdempotentlyWithAuditAndEvent(
      this.pool,
      actor,
      {
        operation: `${operation}.v1`,
        key: idempotencyKey,
        requestHash: requestHash(operation, input),
      },
      (client) => this.performMutation(client, actor, operation, input),
    );
  }

  private async performMutation(
    client: DbClient,
    actor: ActorContext,
    operation: string,
    input: Input,
  ) {
    switch (operation) {
      case "pursuit.enable":
        return this.enablePursuit(client, actor, input);
      case "pursuit.profile.update":
        return this.updateProfile(client, actor, input);
      case "pursuit.requirement.update":
        return this.updateRequirement(client, actor, input);
      case "pursuit.phase.change":
        return this.changePhase(client, actor, input);
      case "artifact.create":
        return this.createArtifact(client, actor, input);
      case "artifact.snapshot":
        return this.snapshotArtifact(client, actor, input);
      case "evidence.link":
        return this.linkEvidence(client, actor, input);
      case "evidence.unlink":
        return this.unlinkEvidence(client, actor, input);
      default:
        throw notFound();
    }
  }

  // --------------------------------------------------------------- access --

  private async requireProject(
    client: DbClient,
    actor: ActorContext,
    projectId: string,
  ): Promise<Row> {
    const result = await client.query<Row>(
      `SELECT p.* FROM project_rooms p
        WHERE p.organization_id = $1 AND p.id = $4 AND ${projectAccessSql}`,
      [actor.organizationId, actor.role, actor.userId ?? null, projectId],
    );
    if (!result.rows[0]) throw notFound();
    return result.rows[0];
  }

  // ------------------------------------------------------------- template --

  /**
   * Resolves the single shared template, creating it on first use. Every
   * Location Pursuit binds to the same template and version.
   */
  private async resolveTemplate(client: DbClient, actor: ActorContext): Promise<string> {
    const existing = await client.query<Row>(
      `SELECT id FROM pursuit_templates
        WHERE organization_id = $1 AND key = $2 AND version = $3`,
      [actor.organizationId, locationPursuitTemplateKey, locationPursuitTemplateVersion],
    );
    if (existing.rows[0]) return String(existing.rows[0].id);

    const templateId = randomUUID();
    await client.query(
      `INSERT INTO pursuit_templates (id, organization_id, key, version, name)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        templateId,
        actor.organizationId,
        locationPursuitTemplateKey,
        locationPursuitTemplateVersion,
        "Location Pursuit",
      ],
    );

    for (const [areaPosition, area] of locationPursuitDevelopmentAreas.entries()) {
      const areaId = randomUUID();
      await client.query(
        `INSERT INTO pursuit_development_areas
           (id, organization_id, template_id, key, name, position)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [areaId, actor.organizationId, templateId, area.key, area.name, areaPosition],
      );
      for (const [position, requirement] of area.requirements.entries()) {
        await client.query(
          `INSERT INTO pursuit_requirement_definitions
             (id, organization_id, development_area_id, key, name, description, position, required_by_phase)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            randomUUID(),
            actor.organizationId,
            areaId,
            requirement.key,
            requirement.name,
            requirement.description,
            position,
            requirement.requiredByPhase,
          ],
        );
      }
    }
    return templateId;
  }

  private async enablePursuit(client: DbClient, actor: ActorContext, input: Input) {
    const projectId = requiredId(input, "projectId");
    const project = await this.requireProject(client, actor, projectId);
    if (project.template_type !== "location_pursuit") {
      throw conflict("Only Location Pursuit projects carry development-area gates.");
    }

    const existing = await client.query<Row>(
      "SELECT * FROM pursuit_profiles WHERE organization_id = $1 AND project_id = $2",
      [actor.organizationId, projectId],
    );
    if (existing.rows[0]) {
      const profile = camelize(existing.rows[0]);
      return this.record(actor, "pursuit.enabled", "pursuit_profile", String(existing.rows[0].id), { profile }, profile, profile);
    }

    const templateId = await this.resolveTemplate(client, actor);
    const profileId = randomUUID();
    const created = await client.query<Row>(
      `INSERT INTO pursuit_profiles
         (id, organization_id, project_id, template_id, created_by_actor_id, updated_by_actor_id)
       VALUES ($1, $2, $3, $4, $5, $5) RETURNING *`,
      [profileId, actor.organizationId, projectId, templateId, actor.actorId],
    );

    // Every requirement in the template is instantiated as `unknown`. Nothing is
    // assumed true about a new pursuit.
    await client.query(
      `INSERT INTO pursuit_requirements
         (id, organization_id, profile_id, project_id, definition_id, updated_by_actor_id)
       SELECT gen_random_uuid(), $1, $2, $3, definition.id, $4
         FROM pursuit_requirement_definitions definition
         JOIN pursuit_development_areas area
           ON area.organization_id = definition.organization_id
          AND area.id = definition.development_area_id
        WHERE definition.organization_id = $1 AND area.template_id = $5`,
      [actor.organizationId, profileId, projectId, actor.actorId, templateId],
    );

    const profile = camelize(created.rows[0]);
    return this.record(actor, "pursuit.enabled", "pursuit_profile", profileId, { profile }, null, profile);
  }

  private async updateProfile(client: DbClient, actor: ActorContext, input: Input) {
    const projectId = requiredId(input, "projectId");
    await this.requireProject(client, actor, projectId);
    const before = await client.query<Row>(
      "SELECT * FROM pursuit_profiles WHERE organization_id = $1 AND project_id = $2 FOR UPDATE",
      [actor.organizationId, projectId],
    );
    if (!before.rows[0]) throw notFound();

    const columns: Record<string, string> = {
      siteContext: "site_context",
      corridorContext: "corridor_context",
      formatHypothesis: "format_hypothesis",
      strategicThesis: "strategic_thesis",
      economicsSummary: "economics_summary",
      targetOpenOn: "target_open_on",
    };
    const assignments: string[] = [];
    const values: unknown[] = [actor.organizationId, projectId, actor.actorId];
    for (const [field, column] of Object.entries(columns)) {
      if (input[field] === undefined) continue;
      values.push(input[field] === "" && column === "target_open_on" ? null : input[field]);
      assignments.push(`${column} = $${values.length}`);
    }
    if (assignments.length === 0) throw new ApiError(400, "INVALID_INPUT", "At least one field is required.");

    const updated = await client.query<Row>(
      `UPDATE pursuit_profiles
          SET ${assignments.join(", ")}, updated_by_actor_id = $3, updated_at = now()
        WHERE organization_id = $1 AND project_id = $2 RETURNING *`,
      values,
    );
    const profile = camelize(updated.rows[0]);
    return this.record(
      actor,
      "pursuit.profile.updated",
      "pursuit_profile",
      String(updated.rows[0].id),
      { profile },
      camelize(before.rows[0]),
      profile,
    );
  }

  // --------------------------------------------------------- requirements --

  private async updateRequirement(client: DbClient, actor: ActorContext, input: Input) {
    const requirementId = requiredId(input, "requirementId");
    const before = await client.query<Row>(
      `SELECT r.*, p.template_type FROM pursuit_requirements r
         JOIN project_rooms p ON p.organization_id = r.organization_id AND p.id = r.project_id
        WHERE r.organization_id = $1 AND r.id = $2 FOR UPDATE OF r`,
      [actor.organizationId, requirementId],
    );
    if (!before.rows[0]) throw notFound();
    await this.requireProject(client, actor, String(before.rows[0].project_id));

    const state = String(input.state) as RequirementState;
    const rationale = typeof input.waiverRationale === "string" ? input.waiverRationale.trim() : "";
    const isWaiver = waiverRequirementStates.includes(state);

    if (isWaiver && rationale.length === 0) {
      throw new ApiError(
        400,
        "INVALID_INPUT",
        "Waived and Not Applicable require a rationale.",
      );
    }

    // `evidenced` is a claim about the world, so it must point at eligible
    // evidence rather than being asserted on its own.
    if (state === "evidenced") {
      const evidence = await client.query<Row>(
        `SELECT 1 FROM evidence_links
          WHERE organization_id = $1 AND target_type = 'requirement'
            AND target_id = $2 AND archived_at IS NULL LIMIT 1`,
        [actor.organizationId, requirementId],
      );
      if (!evidence.rows[0]) {
        throw conflict("A requirement can only be marked Evidenced once evidence is linked to it.");
      }
    }

    const updated = await client.query<Row>(
      `UPDATE pursuit_requirements
          SET state = $3::requirement_state,
              notes = COALESCE($4, notes),
              waiver_rationale = $5,
              waived_by_actor_id = $6,
              waived_at = $7,
              updated_by_actor_id = $8,
              updated_at = now()
        WHERE organization_id = $1 AND id = $2 RETURNING *`,
      [
        actor.organizationId,
        requirementId,
        state,
        typeof input.notes === "string" ? input.notes : null,
        isWaiver ? rationale : "",
        isWaiver ? actor.actorId : null,
        isWaiver ? new Date() : null,
        actor.actorId,
      ],
    );

    const requirement = camelize(updated.rows[0]);
    return this.record(
      actor,
      "pursuit.requirement.updated",
      "pursuit_requirement",
      requirementId,
      { requirement },
      camelize(before.rows[0]),
      requirement,
    );
  }

  // ---------------------------------------------------------------- phase --

  private async changePhase(client: DbClient, actor: ActorContext, input: Input) {
    const projectId = requiredId(input, "projectId");
    await this.requireProject(client, actor, projectId);
    const profileResult = await client.query<Row>(
      "SELECT * FROM pursuit_profiles WHERE organization_id = $1 AND project_id = $2 FOR UPDATE",
      [actor.organizationId, projectId],
    );
    const profile = profileResult.rows[0];
    if (!profile) throw notFound();

    const targetPhase = String(input.phase) as PursuitPhase;
    const currentPhase = String(profile.phase) as PursuitPhase;
    if (targetPhase === currentPhase) {
      throw conflict("The project is already in that phase.");
    }

    const requirements = await this.loadRequirementRows(client, actor, projectId);
    const unmet = unmetRequirementsForPhase(requirements, targetPhase);
    const overrideRationale =
      typeof input.overrideRationale === "string" ? input.overrideRationale.trim() : "";

    // Advancing past unmet gates is possible but never silent: it demands an
    // explicit rationale and is recorded with the exact requirements overridden.
    const advancing = phaseIndex(targetPhase) > phaseIndex(currentPhase);
    if (advancing && unmet.length > 0 && overrideRationale.length === 0) {
      throw new ApiError(
        409,
        "CONFLICT",
        `${unmet.length} requirement${unmet.length === 1 ? "" : "s"} due by ${targetPhase} ${unmet.length === 1 ? "is" : "are"} unmet. Resolve them, or record an explicit override rationale.`,
        { unmet },
      );
    }

    const updated = await client.query<Row>(
      `UPDATE pursuit_profiles
          SET phase = $3::pursuit_phase, updated_by_actor_id = $4, updated_at = now()
        WHERE organization_id = $1 AND project_id = $2 RETURNING *`,
      [actor.organizationId, projectId, targetPhase, actor.actorId],
    );

    const overriddenIds = advancing ? unmet.map((requirement) => requirement.requirementId) : [];
    await client.query(
      `INSERT INTO pursuit_phase_history
         (id, organization_id, profile_id, from_phase, to_phase, rationale,
          unmet_requirement_ids, override_rationale, changed_by_actor_id)
       VALUES ($1, $2, $3, $4::pursuit_phase, $5::pursuit_phase, $6, $7::uuid[], $8, $9)`,
      [
        randomUUID(),
        actor.organizationId,
        profile.id,
        currentPhase,
        targetPhase,
        typeof input.rationale === "string" ? input.rationale : "",
        overriddenIds,
        overriddenIds.length > 0 ? overrideRationale : "",
        actor.actorId,
      ],
    );

    const result = camelize(updated.rows[0]);
    return this.record(
      actor,
      "pursuit.phase.changed",
      "pursuit_profile",
      String(profile.id),
      { profile: result, overriddenRequirementIds: overriddenIds },
      camelize(profile),
      result,
    );
  }

  private async loadRequirementRows(
    client: DbClient | Pool,
    actor: ActorContext,
    projectId: string,
  ) {
    const result = await client.query<Row>(
      `SELECT r.id, r.state, definition.key AS definition_key, definition.name,
              definition.required_by_phase, area.key AS development_area_key
         FROM pursuit_requirements r
         JOIN pursuit_requirement_definitions definition
           ON definition.organization_id = r.organization_id AND definition.id = r.definition_id
         JOIN pursuit_development_areas area
           ON area.organization_id = definition.organization_id
          AND area.id = definition.development_area_id
        WHERE r.organization_id = $1 AND r.project_id = $2`,
      [actor.organizationId, projectId],
    );
    return result.rows.map((row) => ({
      requirementId: String(row.id),
      definitionKey: String(row.definition_key),
      name: String(row.name),
      developmentAreaKey: String(row.development_area_key),
      state: String(row.state) as RequirementState,
      requiredByPhase: String(row.required_by_phase) as PursuitPhase,
    }));
  }

  // ------------------------------------------------------------ readiness --

  private async readiness(actor: ActorContext, projectId: string): Promise<Result> {
    const project = await this.pool.query<Row>(
      `SELECT p.* FROM project_rooms p
        WHERE p.organization_id = $1 AND p.id = $4 AND ${projectAccessSql}`,
      [actor.organizationId, actor.role, actor.userId ?? null, projectId],
    );
    if (!project.rows[0]) throw notFound();

    const profileResult = await this.pool.query<Row>(
      "SELECT * FROM pursuit_profiles WHERE organization_id = $1 AND project_id = $2",
      [actor.organizationId, projectId],
    );
    if (!profileResult.rows[0]) {
      return { enabled: false, templateType: project.rows[0].template_type };
    }

    const rows = await this.pool.query<Row>(
      `SELECT area.key AS area_key, area.name AS area_name, area.position AS area_position,
              definition.id AS definition_id, definition.key AS definition_key,
              definition.name AS definition_name, definition.description,
              definition.position AS definition_position, definition.required_by_phase,
              r.id AS requirement_id, r.state, r.notes, r.waiver_rationale,
              r.waived_by_actor_id, r.waived_at, r.updated_at,
              (SELECT count(*)::int FROM evidence_links e
                WHERE e.organization_id = r.organization_id
                  AND e.target_type = 'requirement' AND e.target_id = r.id
                  AND e.archived_at IS NULL) AS evidence_count
         FROM pursuit_requirements r
         JOIN pursuit_requirement_definitions definition
           ON definition.organization_id = r.organization_id AND definition.id = r.definition_id
         JOIN pursuit_development_areas area
           ON area.organization_id = definition.organization_id
          AND area.id = definition.development_area_id
        WHERE r.organization_id = $1 AND r.project_id = $2
        ORDER BY area.position, definition.position`,
      [actor.organizationId, projectId],
    );

    const areas = new Map<string, Record<string, unknown>>();
    for (const row of rows.rows) {
      const key = String(row.area_key);
      if (!areas.has(key)) {
        areas.set(key, {
          key,
          name: row.area_name,
          position: row.area_position,
          requirements: [],
          satisfied: 0,
          total: 0,
        });
      }
      const area = areas.get(key)!;
      (area.requirements as unknown[]).push({
        requirementId: row.requirement_id,
        definitionKey: row.definition_key,
        name: row.definition_name,
        description: row.description,
        requiredByPhase: row.required_by_phase,
        state: row.state,
        notes: row.notes,
        waiverRationale: row.waiver_rationale,
        waivedAt: row.waived_at instanceof Date ? row.waived_at.toISOString() : row.waived_at,
        evidenceCount: row.evidence_count,
      });
      area.total = (area.total as number) + 1;
      if (satisfyingRequirementStates.includes(String(row.state) as RequirementState)) {
        area.satisfied = (area.satisfied as number) + 1;
      }
    }

    const profile = camelize(profileResult.rows[0]);
    const requirements = await this.loadRequirementRows(this.pool, actor, projectId);
    const history = await this.pool.query<Row>(
      `SELECT * FROM pursuit_phase_history
        WHERE organization_id = $1 AND profile_id = $2
        ORDER BY created_at DESC LIMIT 20`,
      [actor.organizationId, profileResult.rows[0].id],
    );

    return {
      enabled: true,
      profile,
      developmentAreas: [...areas.values()],
      // What blocks the *next* phase, so the room can state it plainly.
      unmetForCurrentPhase: unmetRequirementsForPhase(requirements, String(profile.phase) as PursuitPhase),
      phaseHistory: history.rows.map(camelize),
    };
  }

  // ------------------------------------------------------------ artifacts --

  private async createArtifact(client: DbClient, actor: ActorContext, input: Input) {
    const mode = String(input.mode);
    const projectId = input.projectId ? String(input.projectId) : null;
    if (projectId) await this.requireProject(client, actor, projectId);

    const id = randomUUID();
    const checksum =
      typeof input.checksum === "string" && input.checksum
        ? input.checksum
        : mode === "linked"
          ? ""
          : createHash("sha256").update(String(input.storageKey ?? id)).digest("hex");

    const created = await client.query<Row>(
      `INSERT INTO artifacts
         (id, organization_id, mode, title, description, storage_key, canonical_url,
          mime_type, byte_size, checksum, visibility, source_system,
          source_owner_user_id, provenance, created_by_actor_id, updated_by_actor_id)
       VALUES ($1, $2, $3::artifact_mode, $4, $5, $6, $7, $8, $9, $10,
               $11::artifact_visibility, $12, $13, $14, $15, $15)
       RETURNING *`,
      [
        id,
        actor.organizationId,
        mode,
        input.title,
        input.description ?? "",
        input.storageKey ?? "",
        input.canonicalUrl ?? "",
        input.mimeType ?? "",
        input.byteSize ?? 0,
        checksum,
        input.visibility ?? "project",
        input.sourceSystem ?? "atlas",
        mode === "linked" ? (actor.userId ?? null) : null,
        input.provenance ?? {},
        actor.actorId,
      ],
    );

    if (projectId) {
      await client.query(
        `INSERT INTO artifact_projects (id, organization_id, artifact_id, project_id, created_by_actor_id)
         VALUES ($1, $2, $3, $4, $5)`,
        [randomUUID(), actor.organizationId, id, projectId, actor.actorId],
      );
    }

    const artifact = camelize(created.rows[0]);
    return this.record(actor, "artifact.created", "artifact", id, { artifact }, null, artifact);
  }

  /**
   * Copies an artifact into an immutable snapshot so a claim keeps pointing at
   * what supported it, even after the source changes.
   */
  private async snapshotArtifact(client: DbClient, actor: ActorContext, input: Input) {
    const sourceId = requiredId(input, "artifactId");
    const source = await client.query<Row>(
      "SELECT * FROM artifacts WHERE organization_id = $1 AND id = $2",
      [actor.organizationId, sourceId],
    );
    if (!source.rows[0]) throw notFound();

    const row = source.rows[0];
    const id = randomUUID();
    const storageKey = `snapshots/${id}`;
    const checksum = createHash("sha256")
      .update(
        JSON.stringify({
          source: sourceId,
          storageKey: row.storage_key,
          canonicalUrl: row.canonical_url,
          version: row.version,
        }),
      )
      .digest("hex");

    const created = await client.query<Row>(
      `INSERT INTO artifacts
         (id, organization_id, mode, title, description, storage_key, canonical_url,
          mime_type, byte_size, checksum, visibility, source_system,
          snapshot_of_artifact_id, snapshot_taken_at, provenance,
          created_by_actor_id, updated_by_actor_id)
       VALUES ($1, $2, 'snapshot', $3, $4, $5, $6, $7, $8, $9,
               $10::artifact_visibility, $11, $12, now(), $13, $14, $14)
       RETURNING *`,
      [
        id,
        actor.organizationId,
        `${row.title} (snapshot)`,
        row.description,
        storageKey,
        row.canonical_url,
        row.mime_type,
        row.byte_size,
        checksum,
        row.visibility,
        row.source_system,
        sourceId,
        { snapshotOf: sourceId, sourceVersion: row.version },
        actor.actorId,
      ],
    );

    const artifact = camelize(created.rows[0]);
    return this.record(actor, "artifact.snapshotted", "artifact", id, { artifact }, null, artifact);
  }

  private async listArtifacts(actor: ActorContext, input: Input): Promise<Result> {
    const values: unknown[] = [actor.organizationId, actor.actorId];
    const conditions = [
      "a.organization_id = $1",
      "a.archived_at IS NULL",
      // A private artifact is visible only to the actor who created it.
      "(a.visibility = 'project' OR a.created_by_actor_id = $2)",
    ];
    if (input.projectId) {
      values.push(input.projectId);
      conditions.push(`EXISTS (
        SELECT 1 FROM artifact_projects link
         WHERE link.organization_id = a.organization_id
           AND link.artifact_id = a.id
           AND link.project_id = $${values.length}::uuid
      )`);
      const project = await this.pool.query<Row>(
        `SELECT p.id FROM project_rooms p
          WHERE p.organization_id = $1 AND p.id = $4 AND ${projectAccessSql}`,
        [actor.organizationId, actor.role, actor.userId ?? null, input.projectId],
      );
      if (!project.rows[0]) throw notFound();
    }
    values.push(Number(input.limit ?? 50));
    const result = await this.pool.query<Row>(
      `SELECT a.* FROM artifacts a
        WHERE ${conditions.join(" AND ")}
        ORDER BY a.created_at DESC, a.id DESC LIMIT $${values.length}`,
      values,
    );
    return { artifacts: result.rows.map(camelize) };
  }

  // ------------------------------------------------------------- evidence --

  private async linkEvidence(client: DbClient, actor: ActorContext, input: Input) {
    const artifactId = requiredId(input, "artifactId");
    const artifact = await client.query<Row>(
      "SELECT * FROM artifacts WHERE organization_id = $1 AND id = $2",
      [actor.organizationId, artifactId],
    );
    if (!artifact.rows[0]) throw notFound();
    // Linking evidence must not widen the source's permissions: an actor can
    // only cite an artifact they can already see.
    if (
      artifact.rows[0].visibility === "private" &&
      String(artifact.rows[0].created_by_actor_id) !== actor.actorId
    ) {
      throw notFound();
    }

    const id = randomUUID();
    const created = await client.query<Row>(
      `INSERT INTO evidence_links
         (id, organization_id, artifact_id, target_type, target_id, claim, created_by_actor_id)
       VALUES ($1, $2, $3, $4::evidence_target_type, $5, $6, $7)
       ON CONFLICT (organization_id, artifact_id, target_type, target_id)
       DO UPDATE SET archived_at = NULL, claim = EXCLUDED.claim
       RETURNING *`,
      [
        id,
        actor.organizationId,
        artifactId,
        input.targetType,
        input.targetId,
        input.claim ?? "",
        actor.actorId,
      ],
    );
    const link = camelize(created.rows[0]);
    return this.record(actor, "evidence.linked", "evidence_link", String(created.rows[0].id), { evidence: link }, null, link);
  }

  private async unlinkEvidence(client: DbClient, actor: ActorContext, input: Input) {
    const evidenceId = requiredId(input, "evidenceId");
    const before = await client.query<Row>(
      "SELECT * FROM evidence_links WHERE organization_id = $1 AND id = $2 FOR UPDATE",
      [actor.organizationId, evidenceId],
    );
    if (!before.rows[0] || before.rows[0].archived_at) throw notFound();

    // Removing the evidence behind an evidenced requirement would leave an
    // unsupported claim standing, so the requirement is reopened with it.
    if (before.rows[0].target_type === "requirement") {
      const remaining = await client.query<Row>(
        `SELECT 1 FROM evidence_links
          WHERE organization_id = $1 AND target_type = 'requirement' AND target_id = $2
            AND id <> $3 AND archived_at IS NULL LIMIT 1`,
        [actor.organizationId, before.rows[0].target_id, evidenceId],
      );
      if (!remaining.rows[0]) {
        await client.query(
          `UPDATE pursuit_requirements
              SET state = 'in_progress', updated_by_actor_id = $3, updated_at = now()
            WHERE organization_id = $1 AND id = $2 AND state = 'evidenced'`,
          [actor.organizationId, before.rows[0].target_id, actor.actorId],
        );
      }
    }

    const updated = await client.query<Row>(
      `UPDATE evidence_links SET archived_at = now()
        WHERE organization_id = $1 AND id = $2 RETURNING *`,
      [actor.organizationId, evidenceId],
    );
    const link = camelize(updated.rows[0]);
    return this.record(actor, "evidence.unlinked", "evidence_link", evidenceId, { evidence: link }, camelize(before.rows[0]), link);
  }

  private async listEvidence(actor: ActorContext, input: Input): Promise<Result> {
    const result = await this.pool.query<Row>(
      `SELECT e.*, a.title AS artifact_title, a.mode AS artifact_mode,
              a.checksum, a.visibility, a.snapshot_taken_at
         FROM evidence_links e
         JOIN artifacts a ON a.organization_id = e.organization_id AND a.id = e.artifact_id
        WHERE e.organization_id = $1 AND e.target_type = $2::evidence_target_type
          AND e.target_id = $3 AND e.archived_at IS NULL
          AND (a.visibility = 'project' OR a.created_by_actor_id = $4)
        ORDER BY e.created_at DESC`,
      [actor.organizationId, input.targetType, input.targetId, actor.actorId],
    );
    return { evidence: result.rows.map(camelize) };
  }

  // --------------------------------------------------------------- record --

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
        eventType: atlasEventTypes.pursuitChanged,
        aggregateType: resourceType,
        aggregateId: resourceId,
        schemaVersion: 1,
        payload: { operation, resourceId },
      },
    };
  }
}
