import { createHash, randomUUID } from "node:crypto";
import type { Pool, QueryResultRow } from "pg";
import type { ActorContext } from "../../../shared/identity.js";
import { atlasEventTypes, type AtlasEventType } from "../../../shared/events.js";
import {
  decodeCursor,
  encodeCursor,
} from "../../../shared/operating-core.js";
import { ApiError } from "../../platform/http/api-error.js";
import type { DbClient } from "../../platform/db/client.js";
import { mutateIdempotentlyWithAuditAndEvent } from "../events/outbox.service.js";
import type { OperatingCorePort } from "./operating-core.routes.js";
import { assertStatusTransition } from "./operating-core.policy.js";
import {
  assertBlockerTarget,
  assertDependencyAllowed,
  assertOrganizationUser,
  assertParentAllowed,
  assertWorkstreamInProject,
  conflict,
  requireProject,
  requireWorkItem,
  safeNotFound,
  type ProductRow,
} from "./operating-core.repository.js";

type Input = Record<string, unknown>;
type Result = Record<string, unknown>;
type Row = QueryResultRow & Record<string, unknown>;

function notFound(): ApiError {
  return new ApiError(404, "NOT_FOUND", "Resource not found.");
}

function camelize(row: Row): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key.replace(/_([a-z])/g, (_match, character: string) => character.toUpperCase()),
      value,
    ]),
  );
}

function iso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function paginate(rows: Row[], limit: number, sortColumn = "created_at") {
  const hasNext = rows.length > limit;
  const visible = hasNext ? rows.slice(0, limit) : rows;
  const last = visible.at(-1);
  return {
    records: visible.map(camelize),
    page: {
      nextCursor:
        hasNext && last
          ? encodeCursor({ sortValue: iso(last[sortColumn]), id: String(last.id) })
          : null,
    },
  };
}

function requestHash(operation: string, input: Input): string {
  return createHash("sha256")
    .update(JSON.stringify({ operation, input }))
    .digest("hex");
}

function valueOr<T>(input: Input, key: string, fallback: T): T {
  return (input[key] === undefined ? fallback : input[key]) as T;
}

function mutationRecord(
  actor: ActorContext,
  operation: string,
  eventType: AtlasEventType,
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
      eventType,
      aggregateType: resourceType,
      aggregateId: resourceId,
      schemaVersion: 1,
      payload: { operation, resourceId, ...after },
    },
  };
}

const broadProjectAccessSql = `(
  $2::text IN ('owner', 'admin')
  OR p.owner_user_id = $3::uuid
  OR EXISTS (
    SELECT 1
      FROM project_memberships pm
     WHERE pm.organization_id = p.organization_id
       AND pm.project_id = p.id
       AND pm.user_id = $3::uuid
  )
)`;

export class OperatingCoreService implements OperatingCorePort {
  constructor(private readonly pool: Pool) {}

  async query(actor: ActorContext, operation: string, input: Input): Promise<Result> {
    switch (operation) {
      case "project.list":
        return this.listProjects(actor, input);
      case "project.get":
        return { project: await this.getProject(actor, String(input.projectId)) };
      case "work.list":
        return this.listWork(actor, input, false);
      case "work.view":
        return this.listWork(actor, input, true);
      default:
        return this.queryRemaining(actor, operation, input);
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
  ): Promise<ReturnType<typeof mutationRecord>> {
    switch (operation) {
      case "project.create": return this.createProject(client, actor, input);
      case "project.update": return this.updateProject(client, actor, input);
      case "project.archive": return this.archiveProject(client, actor, input);
      case "project.members.add": return this.addProjectMember(client, actor, input);
      case "project.members.remove": return this.removeProjectMember(client, actor, input);
      case "project.health.add": return this.addProjectHealth(client, actor, input);
      case "workstream.create": return this.createWorkstream(client, actor, input);
      case "workstream.update": return this.updateWorkstream(client, actor, input);
      case "work.create": return this.createWorkItem(client, actor, input);
      case "work.update": return this.updateWorkItem(client, actor, input);
      case "work.move": return this.moveWorkItem(client, actor, input);
      case "work.archive": return this.archiveWorkItem(client, actor, input);
      case "work.dependency.add": return this.changeDependency(client, actor, input, true);
      case "work.dependency.remove": return this.changeDependency(client, actor, input, false);
      case "label.create": return this.createLabel(client, actor, input);
      case "work.label.add": return this.changeWorkLabel(client, actor, input, true);
      case "work.label.remove": return this.changeWorkLabel(client, actor, input, false);
      case "decision.create": return this.createDecision(client, actor, input);
      case "decision.update": return this.updateDecision(client, actor, input);
      case "risk.create": return this.createRisk(client, actor, input);
      case "risk.update": return this.updateRisk(client, actor, input);
      case "blocker.create": return this.createBlocker(client, actor, input);
      case "blocker.update": return this.updateBlocker(client, actor, input);
      case "milestone.create": return this.createMilestone(client, actor, input);
      case "milestone.update": return this.updateMilestone(client, actor, input);
      case "activity.create": return this.createActivity(client, actor, input);
      case "person.create": return this.createPerson(client, actor, input);
      case "person.update": return this.updatePerson(client, actor, input);
      case "person.merge": return this.mergePerson(client, actor, input);
      case "counterparty.create": return this.createCounterparty(client, actor, input);
      case "counterparty.update": return this.updateCounterparty(client, actor, input);
      case "counterparty.merge": return this.mergeCounterparty(client, actor, input);
      case "affiliation.create": return this.createAffiliation(client, actor, input);
      case "project.people.add": return this.changeProjectRelationship(client, actor, input, "person", true);
      case "project.people.remove": return this.changeProjectRelationship(client, actor, input, "person", false);
      case "project.counterparties.add": return this.changeProjectRelationship(client, actor, input, "counterparty", true);
      case "project.counterparties.remove": return this.changeProjectRelationship(client, actor, input, "counterparty", false);
      case "saved-view.create": return this.createSavedView(client, actor, input);
      case "saved-view.update": return this.updateSavedView(client, actor, input);
      case "saved-view.archive": return this.archiveSavedView(client, actor, input);
      default:
        throw new ApiError(501, "INTERNAL_ERROR", `Unsupported Operating Core mutation: ${operation}.`);
    }
  }

  private async createProject(client: DbClient, actor: ActorContext, input: Input) {
    const ownerUserId = String(input.ownerUserId);
    await assertOrganizationUser(client, actor.organizationId, ownerUserId);
    const id = randomUUID();
    const result = await client.query<ProductRow>(
      `INSERT INTO project_rooms
         (id, organization_id, name, objective, template_type, status, health,
          priority, strategic_area, owner_user_id, current_focus, blocker_summary,
          next_decision, next_action, created_by_actor_id, updated_by_actor_id)
       VALUES ($1, $2, $3, $4, $5, $6::project_status, $7::project_health,
               $8::atlas_priority, $9, $10, $11, $12, $13, $14, $15, $15)
       RETURNING *`,
      [
        id,
        actor.organizationId,
        input.name,
        valueOr(input, "objective", ""),
        valueOr(input, "templateType", "general"),
        valueOr(input, "status", "planned"),
        valueOr(input, "health", "unknown"),
        valueOr(input, "priority", "medium"),
        valueOr(input, "strategicArea", ""),
        ownerUserId,
        valueOr(input, "currentFocus", ""),
        valueOr(input, "blockerSummary", ""),
        valueOr(input, "nextDecision", ""),
        valueOr(input, "nextAction", ""),
        actor.actorId,
      ],
    );
    await client.query(
      `INSERT INTO project_memberships
         (organization_id, project_id, user_id, role, created_by_actor_id)
       VALUES ($1, $2, $3, 'owner', $4)`,
      [actor.organizationId, id, ownerUserId, actor.actorId],
    );
    const project = camelize(result.rows[0]);
    return mutationRecord(actor, "project.created", atlasEventTypes.projectChanged, "project", id, { project }, null, project);
  }

  private async updateProject(client: DbClient, actor: ActorContext, input: Input) {
    const projectId = String(input.projectId);
    const before = await requireProject(client, actor, projectId, { write: true, lock: true });
    if (input.ownerUserId !== undefined) {
      await assertOrganizationUser(client, actor.organizationId, String(input.ownerUserId));
    }
    const columns: Record<string, string> = {
      name: "name", objective: "objective", templateType: "template_type", status: "status",
      health: "health", priority: "priority", strategicArea: "strategic_area",
      ownerUserId: "owner_user_id", currentFocus: "current_focus",
      blockerSummary: "blocker_summary", nextDecision: "next_decision", nextAction: "next_action",
    };
    const values: unknown[] = [];
    const assignments: string[] = [];
    for (const [key, column] of Object.entries(columns)) {
      if (input[key] === undefined) continue;
      values.push(input[key]);
      assignments.push(`${column} = $${values.length}`);
    }
    values.push(actor.actorId, actor.organizationId, projectId);
    const result = await client.query<ProductRow>(
      `UPDATE project_rooms SET ${assignments.join(", ")}, updated_by_actor_id = $${values.length - 2}, updated_at = now()
        WHERE organization_id = $${values.length - 1} AND id = $${values.length}
        RETURNING *`,
      values,
    );
    const project = camelize(result.rows[0]);
    if (input.ownerUserId !== undefined) {
      await client.query(
        `INSERT INTO project_memberships (organization_id, project_id, user_id, role, created_by_actor_id)
         VALUES ($1, $2, $3, 'owner', $4)
         ON CONFLICT (organization_id, project_id, user_id)
         DO UPDATE SET role = 'owner', updated_at = now()`,
        [actor.organizationId, projectId, input.ownerUserId, actor.actorId],
      );
    }
    if (input.health !== undefined && input.health !== before.health) {
      await client.query(
        `INSERT INTO project_health_updates
           (organization_id, project_id, health, rationale, created_by_actor_id)
         VALUES ($1, $2, $3, 'Project health changed through project update.', $4)`,
        [actor.organizationId, projectId, input.health, actor.actorId],
      );
    }
    return mutationRecord(actor, "project.updated", atlasEventTypes.projectChanged, "project", projectId, { project }, camelize(before), project);
  }

  private async archiveProject(client: DbClient, actor: ActorContext, input: Input) {
    const projectId = String(input.projectId);
    const before = await requireProject(client, actor, projectId, { write: true, lock: true, allowArchived: true });
    const archived = Boolean(input.archived);
    const result = await client.query<ProductRow>(
      `UPDATE project_rooms
          SET archived_at = CASE WHEN $1 THEN now() ELSE NULL END,
              archived_by_actor_id = CASE WHEN $1 THEN $2::uuid ELSE NULL END,
              updated_by_actor_id = $2, updated_at = now()
        WHERE organization_id = $3 AND id = $4 RETURNING *`,
      [archived, actor.actorId, actor.organizationId, projectId],
    );
    const project = camelize(result.rows[0]);
    return mutationRecord(actor, archived ? "project.archived" : "project.recovered", atlasEventTypes.projectChanged, "project", projectId, { project }, camelize(before), project);
  }

  private async addProjectMember(client: DbClient, actor: ActorContext, input: Input) {
    const projectId = String(input.projectId);
    await requireProject(client, actor, projectId, { write: true, lock: true });
    await assertOrganizationUser(client, actor.organizationId, String(input.userId));
    const result = await client.query<ProductRow>(
      `INSERT INTO project_memberships (organization_id, project_id, user_id, role, created_by_actor_id)
       VALUES ($1, $2, $3, $4::project_role, $5)
       ON CONFLICT (organization_id, project_id, user_id)
       DO UPDATE SET role = EXCLUDED.role, updated_at = now()
       RETURNING *`,
      [actor.organizationId, projectId, input.userId, input.role, actor.actorId],
    );
    const membership = camelize(result.rows[0]);
    return mutationRecord(actor, "project.membership-added", atlasEventTypes.projectMembershipChanged, "project_membership", String(result.rows[0].id), { membership }, null, membership);
  }

  private async removeProjectMember(client: DbClient, actor: ActorContext, input: Input) {
    const projectId = String(input.projectId);
    const project = await requireProject(client, actor, projectId, { write: true, lock: true });
    if (project.owner_user_id === input.userId) throw conflict("The Project Room owner cannot be removed.");
    const result = await client.query<ProductRow>(
      `DELETE FROM project_memberships
        WHERE organization_id = $1 AND project_id = $2 AND user_id = $3
        RETURNING *`,
      [actor.organizationId, projectId, input.userId],
    );
    if (!result.rows[0]) throw safeNotFound();
    const membership = camelize(result.rows[0]);
    return mutationRecord(actor, "project.membership-removed", atlasEventTypes.projectMembershipChanged, "project_membership", String(result.rows[0].id), { removed: true, membership }, membership, null);
  }

  private async addProjectHealth(client: DbClient, actor: ActorContext, input: Input) {
    const projectId = String(input.projectId);
    const before = await requireProject(client, actor, projectId, { write: true, lock: true });
    const period = input.reportingPeriodStart || input.reportingPeriodEnd
      ? `[${String(input.reportingPeriodStart ?? "")},${String(input.reportingPeriodEnd ?? "")}]`
      : null;
    const result = await client.query<ProductRow>(
      `INSERT INTO project_health_updates
         (organization_id, project_id, health, rationale, reporting_period, source_cutoff, created_by_actor_id)
       VALUES ($1, $2, $3::project_health, $4, $5::daterange, $6, $7)
       RETURNING *`,
      [actor.organizationId, projectId, input.health, input.rationale, period, input.sourceCutoff ?? null, actor.actorId],
    );
    await client.query(
      `UPDATE project_rooms SET health = $1, updated_by_actor_id = $2, updated_at = now()
        WHERE organization_id = $3 AND id = $4`,
      [input.health, actor.actorId, actor.organizationId, projectId],
    );
    const healthUpdate = camelize(result.rows[0]);
    return mutationRecord(actor, "project.health-changed", atlasEventTypes.projectHealthChanged, "project", projectId, { healthUpdate }, { health: before.health }, { health: input.health, healthUpdateId: result.rows[0].id });
  }

  private async createWorkstream(client: DbClient, actor: ActorContext, input: Input) {
    const projectId = String(input.projectId);
    await requireProject(client, actor, projectId, { write: true });
    await assertOrganizationUser(client, actor.organizationId, input.ownerUserId as string | undefined);
    const id = randomUUID();
    const result = await client.query<ProductRow>(
      `INSERT INTO workstreams
         (id, organization_id, project_id, name, description, owner_user_id, status,
          position, created_by_actor_id, updated_by_actor_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7::workstream_status, $8, $9, $9)
       RETURNING *`,
      [id, actor.organizationId, projectId, input.name, valueOr(input, "description", ""), input.ownerUserId ?? null, valueOr(input, "status", "planned"), valueOr(input, "position", 0), actor.actorId],
    );
    const workstream = camelize(result.rows[0]);
    return mutationRecord(actor, "workstream.created", atlasEventTypes.workstreamChanged, "workstream", id, { workstream }, null, workstream);
  }

  private async updateWorkstream(client: DbClient, actor: ActorContext, input: Input) {
    const workstreamId = String(input.workstreamId);
    const existing = await client.query<ProductRow>(
      "SELECT * FROM workstreams WHERE organization_id = $1 AND id = $2 AND archived_at IS NULL FOR UPDATE",
      [actor.organizationId, workstreamId],
    );
    const before = existing.rows[0];
    if (!before) throw safeNotFound();
    await requireProject(client, actor, String(before.project_id), { write: true });
    await assertOrganizationUser(client, actor.organizationId, input.ownerUserId as string | undefined);
    const map: Record<string, string> = { name: "name", description: "description", ownerUserId: "owner_user_id", status: "status", position: "position" };
    const values: unknown[] = [];
    const assignments: string[] = [];
    for (const [key, column] of Object.entries(map)) {
      if (input[key] === undefined) continue;
      values.push(input[key]);
      assignments.push(`${column} = $${values.length}`);
    }
    values.push(actor.actorId, actor.organizationId, workstreamId);
    const result = await client.query<ProductRow>(
      `UPDATE workstreams SET ${assignments.join(", ")}, updated_by_actor_id = $${values.length - 2}, updated_at = now()
        WHERE organization_id = $${values.length - 1} AND id = $${values.length} RETURNING *`,
      values,
    );
    const workstream = camelize(result.rows[0]);
    return mutationRecord(actor, "workstream.updated", atlasEventTypes.workstreamChanged, "workstream", workstreamId, { workstream }, camelize(before), workstream);
  }

  private async createWorkItem(client: DbClient, actor: ActorContext, input: Input) {
    const projectId = String(input.projectId);
    await requireProject(client, actor, projectId, { write: true });
    await assertOrganizationUser(client, actor.organizationId, input.ownerUserId as string | undefined);
    await assertWorkstreamInProject(client, actor.organizationId, projectId, input.workstreamId as string | undefined);
    await assertParentAllowed(client, actor.organizationId, projectId, undefined, input.parentId as string | undefined);
    const id = randomUUID();
    const status = valueOr(input, "status", "inbox");
    const result = await client.query<ProductRow>(
      `INSERT INTO work_items
         (id, organization_id, project_id, workstream_id, parent_id, type, title,
          description, owner_user_id, status, priority, due_at, position,
          completed_at, completed_by_actor_id, created_by_actor_id, updated_by_actor_id)
       VALUES ($1, $2, $3, $4, $5, $6::work_item_type, $7, $8, $9,
               $10::work_item_status, $11::atlas_priority, $12, $13,
               CASE WHEN $10 = 'done' THEN now() ELSE NULL END,
               CASE WHEN $10 = 'done' THEN $14::uuid ELSE NULL END, $14, $14)
       RETURNING *`,
      [id, actor.organizationId, projectId, input.workstreamId ?? null, input.parentId ?? null, input.type, input.title, valueOr(input, "description", ""), input.ownerUserId ?? null, status, valueOr(input, "priority", "medium"), input.dueAt ?? null, valueOr(input, "position", 0), actor.actorId],
    );
    await this.replaceWorkLabels(client, actor, id, valueOr<string[]>(input, "labelIds", []));
    const workItem = camelize(result.rows[0]);
    return mutationRecord(actor, "work-item.created", atlasEventTypes.workItemChanged, "work_item", id, { workItem }, null, workItem);
  }

  private async updateWorkItem(client: DbClient, actor: ActorContext, input: Input) {
    const workItemId = String(input.workItemId);
    const before = await requireWorkItem(client, actor, workItemId, { write: true, lock: true });
    if (input.status !== undefined) assertStatusTransition(String(before.status) as never, String(input.status) as never);
    await assertOrganizationUser(client, actor.organizationId, input.ownerUserId as string | undefined);
    await assertWorkstreamInProject(client, actor.organizationId, String(before.project_id), input.workstreamId as string | undefined);
    await assertParentAllowed(client, actor.organizationId, String(before.project_id), workItemId, input.parentId as string | undefined);
    const map: Record<string, string> = {
      workstreamId: "workstream_id", parentId: "parent_id", type: "type", title: "title",
      description: "description", ownerUserId: "owner_user_id", status: "status",
      priority: "priority", dueAt: "due_at", position: "position",
    };
    const values: unknown[] = [];
    const assignments: string[] = [];
    for (const [key, column] of Object.entries(map)) {
      if (input[key] === undefined) continue;
      values.push(input[key]);
      assignments.push(`${column} = $${values.length}`);
    }
    values.push(actor.actorId, actor.organizationId, workItemId);
    const nextStatus = String(input.status ?? before.status);
    const result = await client.query<ProductRow>(
      `UPDATE work_items SET ${assignments.length > 0 ? `${assignments.join(", ")},` : ""}
              completed_at = CASE WHEN $${values.length + 1} = 'done' THEN COALESCE(completed_at, now()) ELSE NULL END,
              completed_by_actor_id = CASE WHEN $${values.length + 1} = 'done' THEN COALESCE(completed_by_actor_id, $${values.length - 2}::uuid) ELSE NULL END,
              updated_by_actor_id = $${values.length - 2}, updated_at = now()
        WHERE organization_id = $${values.length - 1} AND id = $${values.length}
        RETURNING *`,
      [...values, nextStatus],
    );
    if (input.labelIds !== undefined) {
      await this.replaceWorkLabels(client, actor, workItemId, input.labelIds as string[]);
    }
    const workItem = camelize(result.rows[0]);
    return mutationRecord(actor, "work-item.updated", atlasEventTypes.workItemChanged, "work_item", workItemId, { workItem }, camelize(before), workItem);
  }

  private async moveWorkItem(client: DbClient, actor: ActorContext, input: Input) {
    const workItemId = String(input.workItemId);
    const before = await requireWorkItem(client, actor, workItemId, { write: true, lock: true });
    assertStatusTransition(String(before.status) as never, String(input.status) as never);
    const result = await client.query<ProductRow>(
      `UPDATE work_items
          SET status = $1::work_item_status, position = $2,
              completed_at = CASE WHEN $1 = 'done' THEN COALESCE(completed_at, now()) ELSE NULL END,
              completed_by_actor_id = CASE WHEN $1 = 'done' THEN COALESCE(completed_by_actor_id, $3::uuid) ELSE NULL END,
              updated_by_actor_id = $3, updated_at = now()
        WHERE organization_id = $4 AND id = $5 RETURNING *`,
      [input.status, input.position, actor.actorId, actor.organizationId, workItemId],
    );
    const workItem = camelize(result.rows[0]);
    return mutationRecord(actor, "work-item.moved", atlasEventTypes.workItemChanged, "work_item", workItemId, { workItem }, camelize(before), workItem);
  }

  private async archiveWorkItem(client: DbClient, actor: ActorContext, input: Input) {
    const workItemId = String(input.workItemId);
    const before = await requireWorkItem(client, actor, workItemId, { write: true, lock: true, allowArchived: true });
    const archived = Boolean(input.archived);
    const result = await client.query<ProductRow>(
      `UPDATE work_items SET archived_at = CASE WHEN $1 THEN now() ELSE NULL END,
              archived_by_actor_id = CASE WHEN $1 THEN $2::uuid ELSE NULL END,
              updated_by_actor_id = $2, updated_at = now()
        WHERE organization_id = $3 AND id = $4 RETURNING *`,
      [archived, actor.actorId, actor.organizationId, workItemId],
    );
    const workItem = camelize(result.rows[0]);
    return mutationRecord(actor, archived ? "work-item.archived" : "work-item.recovered", atlasEventTypes.workItemChanged, "work_item", workItemId, { workItem }, camelize(before), workItem);
  }

  private async changeDependency(client: DbClient, actor: ActorContext, input: Input, add: boolean) {
    const workItemId = String(input.workItemId);
    const dependencyId = String(input.dependencyId);
    const { blocked } = await assertDependencyAllowed(client, actor, workItemId, dependencyId);
    let id: string = randomUUID();
    if (add) {
      const result = await client.query<ProductRow>(
        `INSERT INTO work_item_dependencies
           (id, organization_id, blocked_work_item_id, dependency_work_item_id, created_by_actor_id)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (organization_id, blocked_work_item_id, dependency_work_item_id)
         DO NOTHING
         RETURNING *`,
        [id, actor.organizationId, workItemId, dependencyId, actor.actorId],
      );
      if (result.rows[0]) {
        id = String(result.rows[0].id);
      } else {
        const existing = await client.query<ProductRow>(
          `SELECT * FROM work_item_dependencies
            WHERE organization_id = $1 AND blocked_work_item_id = $2 AND dependency_work_item_id = $3`,
          [actor.organizationId, workItemId, dependencyId],
        );
        id = String(existing.rows[0].id);
      }
    } else {
      const result = await client.query<ProductRow>(
        `DELETE FROM work_item_dependencies
          WHERE organization_id = $1 AND blocked_work_item_id = $2 AND dependency_work_item_id = $3
          RETURNING *`,
        [actor.organizationId, workItemId, dependencyId],
      );
      if (!result.rows[0]) throw safeNotFound();
      id = String(result.rows[0].id);
    }
    const dependency = { id, workItemId, dependencyId, removed: !add };
    return mutationRecord(actor, add ? "work-item.dependency-added" : "work-item.dependency-removed", atlasEventTypes.workItemDependencyChanged, "work_item", String(blocked.id), { dependency }, null, dependency);
  }

  private async createLabel(client: DbClient, actor: ActorContext, input: Input) {
    const id = randomUUID();
    const result = await client.query<ProductRow>(
      `INSERT INTO labels (id, organization_id, name, color, created_by_actor_id)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [id, actor.organizationId, input.name, valueOr(input, "color", "#64748b"), actor.actorId],
    );
    const label = camelize(result.rows[0]);
    return mutationRecord(actor, "label.created", atlasEventTypes.labelChanged, "label", id, { label }, null, label);
  }

  private async changeWorkLabel(client: DbClient, actor: ActorContext, input: Input, add: boolean) {
    const workItemId = String(input.workItemId);
    await requireWorkItem(client, actor, workItemId, { write: true });
    const labelId = String(input.labelId);
    const label = await client.query("SELECT 1 FROM labels WHERE organization_id = $1 AND id = $2 AND archived_at IS NULL", [actor.organizationId, labelId]);
    if (label.rows.length === 0) throw safeNotFound();
    let id: string = randomUUID();
    if (add) {
      const result = await client.query<ProductRow>(
        `INSERT INTO work_item_labels (id, organization_id, work_item_id, label_id, created_by_actor_id)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (organization_id, work_item_id, label_id)
         DO NOTHING RETURNING *`,
        [id, actor.organizationId, workItemId, labelId, actor.actorId],
      );
      if (result.rows[0]) {
        id = String(result.rows[0].id);
      } else {
        const existing = await client.query<ProductRow>(
          `SELECT * FROM work_item_labels
            WHERE organization_id = $1 AND work_item_id = $2 AND label_id = $3`,
          [actor.organizationId, workItemId, labelId],
        );
        id = String(existing.rows[0].id);
      }
    } else {
      const result = await client.query<ProductRow>(
        "DELETE FROM work_item_labels WHERE organization_id = $1 AND work_item_id = $2 AND label_id = $3 RETURNING *",
        [actor.organizationId, workItemId, labelId],
      );
      if (!result.rows[0]) throw safeNotFound();
      id = String(result.rows[0].id);
    }
    const workItemLabel = { id, workItemId, labelId, removed: !add };
    return mutationRecord(actor, add ? "work-item.label-added" : "work-item.label-removed", atlasEventTypes.workItemChanged, "work_item", workItemId, { workItemLabel }, null, workItemLabel);
  }

  private async replaceWorkLabels(client: DbClient, actor: ActorContext, workItemId: string, labelIds: string[]) {
    await client.query("DELETE FROM work_item_labels WHERE organization_id = $1 AND work_item_id = $2", [actor.organizationId, workItemId]);
    for (const labelId of [...new Set(labelIds)]) {
      const label = await client.query("SELECT 1 FROM labels WHERE organization_id = $1 AND id = $2 AND archived_at IS NULL", [actor.organizationId, labelId]);
      if (label.rows.length === 0) throw safeNotFound();
      await client.query(
        `INSERT INTO work_item_labels (organization_id, work_item_id, label_id, created_by_actor_id)
         VALUES ($1, $2, $3, $4)`,
        [actor.organizationId, workItemId, labelId, actor.actorId],
      );
    }
  }

  private async createDecision(client: DbClient, actor: ActorContext, input: Input) {
    const projectId = String(input.projectId);
    await requireProject(client, actor, projectId, { write: true });
    await assertOrganizationUser(client, actor.organizationId, input.ownerUserId as string | undefined);
    const projectIds = [...new Set([projectId, ...valueOr<string[]>(input, "projectIds", [])])];
    for (const affectedProjectId of projectIds) {
      await requireProject(client, actor, affectedProjectId, { write: true });
    }
    const id = randomUUID();
    const result = await client.query<ProductRow>(
      `INSERT INTO decisions
         (id, organization_id, primary_project_id, question, state, outcome, rationale,
          owner_user_id, decision_at, created_by_actor_id, updated_by_actor_id)
       VALUES ($1, $2, $3, $4, $5::decision_state, $6, $7, $8, $9, $10, $10)
       RETURNING *`,
      [id, actor.organizationId, projectId, input.question, valueOr(input, "state", "proposed"), valueOr(input, "outcome", ""), valueOr(input, "rationale", ""), input.ownerUserId ?? null, input.decisionAt ?? null, actor.actorId],
    );
    await this.replaceDecisionProjects(client, actor, id, projectIds);
    const decision = camelize(result.rows[0]);
    return mutationRecord(actor, "decision.created", atlasEventTypes.decisionChanged, "decision", id, { decision }, null, decision);
  }

  private async updateDecision(client: DbClient, actor: ActorContext, input: Input) {
    const decisionId = String(input.decisionId);
    const existing = await client.query<ProductRow>(
      "SELECT * FROM decisions WHERE organization_id = $1 AND id = $2 AND archived_at IS NULL FOR UPDATE",
      [actor.organizationId, decisionId],
    );
    const before = existing.rows[0];
    if (!before) throw safeNotFound();
    await requireProject(client, actor, String(before.primary_project_id), { write: true });
    await assertOrganizationUser(client, actor.organizationId, input.ownerUserId as string | undefined);
    const map: Record<string, string> = { question: "question", state: "state", outcome: "outcome", rationale: "rationale", ownerUserId: "owner_user_id", decisionAt: "decision_at" };
    const result = await this.updateMappedRecord(client, "decisions", decisionId, actor, input, map);
    if (input.projectIds !== undefined) {
      const projectIds = [...new Set([String(before.primary_project_id), ...(input.projectIds as string[])])];
      for (const projectId of projectIds) await requireProject(client, actor, projectId, { write: true });
      await this.replaceDecisionProjects(client, actor, decisionId, projectIds);
    }
    const decision = camelize(result);
    return mutationRecord(actor, "decision.updated", atlasEventTypes.decisionChanged, "decision", decisionId, { decision }, camelize(before), decision);
  }

  private async replaceDecisionProjects(client: DbClient, actor: ActorContext, decisionId: string, projectIds: string[]) {
    await client.query("DELETE FROM decision_projects WHERE organization_id = $1 AND decision_id = $2", [actor.organizationId, decisionId]);
    for (const projectId of projectIds) {
      await client.query(
        `INSERT INTO decision_projects (organization_id, decision_id, project_id, created_by_actor_id)
         VALUES ($1, $2, $3, $4)`,
        [actor.organizationId, decisionId, projectId, actor.actorId],
      );
    }
  }

  private async createRisk(client: DbClient, actor: ActorContext, input: Input) {
    const projectId = String(input.projectId);
    await requireProject(client, actor, projectId, { write: true });
    await assertWorkstreamInProject(client, actor.organizationId, projectId, input.workstreamId as string | undefined);
    await assertOrganizationUser(client, actor.organizationId, input.ownerUserId as string | undefined);
    const id = randomUUID();
    const result = await client.query<ProductRow>(
      `INSERT INTO risks
         (id, organization_id, project_id, workstream_id, title, description,
          likelihood, impact, owner_user_id, mitigation, state,
          created_by_actor_id, updated_by_actor_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7::risk_likelihood, $8::risk_impact,
               $9, $10, $11::risk_state, $12, $12) RETURNING *`,
      [id, actor.organizationId, projectId, input.workstreamId ?? null, input.title, valueOr(input, "description", ""), input.likelihood, input.impact, input.ownerUserId ?? null, valueOr(input, "mitigation", ""), valueOr(input, "state", "open"), actor.actorId],
    );
    const risk = camelize(result.rows[0]);
    return mutationRecord(actor, "risk.created", atlasEventTypes.riskChanged, "risk", id, { risk }, null, risk);
  }

  private async updateRisk(client: DbClient, actor: ActorContext, input: Input) {
    const riskId = String(input.riskId);
    const before = await this.lockProjectRecord(client, actor, "risks", riskId);
    await assertWorkstreamInProject(client, actor.organizationId, String(before.project_id), input.workstreamId as string | undefined);
    await assertOrganizationUser(client, actor.organizationId, input.ownerUserId as string | undefined);
    const result = await this.updateMappedRecord(client, "risks", riskId, actor, input, {
      workstreamId: "workstream_id", title: "title", description: "description",
      likelihood: "likelihood", impact: "impact", ownerUserId: "owner_user_id",
      mitigation: "mitigation", state: "state",
    });
    const risk = camelize(result);
    return mutationRecord(actor, "risk.updated", atlasEventTypes.riskChanged, "risk", riskId, { risk }, camelize(before), risk);
  }

  private async createBlocker(client: DbClient, actor: ActorContext, input: Input) {
    const projectId = String(input.projectId);
    await requireProject(client, actor, projectId, { write: true });
    await assertOrganizationUser(client, actor.organizationId, input.ownerUserId as string | undefined);
    await assertBlockerTarget(client, actor.organizationId, projectId, String(input.targetType), String(input.targetId));
    const id = randomUUID();
    const resolved = Boolean(input.resolved);
    const result = await client.query<ProductRow>(
      `INSERT INTO blockers
         (id, organization_id, project_id, condition, target_type, target_id,
          owner_user_id, resolved_at, created_by_actor_id, updated_by_actor_id)
       VALUES ($1, $2, $3, $4, $5::blocker_target_type, $6, $7,
               CASE WHEN $8 THEN now() ELSE NULL END, $9, $9) RETURNING *`,
      [id, actor.organizationId, projectId, input.condition, input.targetType, input.targetId, input.ownerUserId ?? null, resolved, actor.actorId],
    );
    const blocker = camelize(result.rows[0]);
    return mutationRecord(actor, "blocker.created", atlasEventTypes.blockerChanged, "blocker", id, { blocker }, null, blocker);
  }

  private async updateBlocker(client: DbClient, actor: ActorContext, input: Input) {
    const blockerId = String(input.blockerId);
    const before = await this.lockProjectRecord(client, actor, "blockers", blockerId);
    await assertOrganizationUser(client, actor.organizationId, input.ownerUserId as string | undefined);
    const targetType = String(input.targetType ?? before.target_type);
    const targetId = String(input.targetId ?? before.target_id);
    if (input.targetType !== undefined || input.targetId !== undefined) {
      await assertBlockerTarget(client, actor.organizationId, String(before.project_id), targetType, targetId);
    }
    const values: unknown[] = [];
    const assignments: string[] = [];
    const map: Record<string, string> = { condition: "condition", targetType: "target_type", targetId: "target_id", ownerUserId: "owner_user_id" };
    for (const [key, column] of Object.entries(map)) {
      if (input[key] === undefined) continue;
      values.push(input[key]);
      assignments.push(`${column} = $${values.length}`);
    }
    if (input.resolved !== undefined) {
      values.push(input.resolved);
      assignments.push(`resolved_at = CASE WHEN $${values.length} THEN now() ELSE NULL END`);
    }
    values.push(actor.actorId, actor.organizationId, blockerId);
    const result = await client.query<ProductRow>(
      `UPDATE blockers SET ${assignments.join(", ")}, updated_by_actor_id = $${values.length - 2}, updated_at = now()
        WHERE organization_id = $${values.length - 1} AND id = $${values.length} RETURNING *`,
      values,
    );
    const blocker = camelize(result.rows[0]);
    return mutationRecord(actor, "blocker.updated", atlasEventTypes.blockerChanged, "blocker", blockerId, { blocker }, camelize(before), blocker);
  }

  private async createMilestone(client: DbClient, actor: ActorContext, input: Input) {
    const projectId = String(input.projectId);
    await requireProject(client, actor, projectId, { write: true });
    await assertWorkstreamInProject(client, actor.organizationId, projectId, input.workstreamId as string | undefined);
    await assertOrganizationUser(client, actor.organizationId, input.ownerUserId as string | undefined);
    const id = randomUUID();
    const state = valueOr(input, "state", "planned");
    const result = await client.query<ProductRow>(
      `INSERT INTO milestones
         (id, organization_id, project_id, workstream_id, outcome, owner_user_id,
          target_at, state, completed_at, calendar_event_id, created_by_actor_id, updated_by_actor_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::milestone_state,
               CASE WHEN $8 = 'completed' THEN now() ELSE NULL END, $9, $10, $10)
       RETURNING *`,
      [id, actor.organizationId, projectId, input.workstreamId ?? null, input.outcome, input.ownerUserId ?? null, input.targetAt, state, input.calendarEventId ?? null, actor.actorId],
    );
    const milestone = camelize(result.rows[0]);
    return mutationRecord(actor, "milestone.created", atlasEventTypes.milestoneChanged, "milestone", id, { milestone }, null, milestone);
  }

  private async updateMilestone(client: DbClient, actor: ActorContext, input: Input) {
    const milestoneId = String(input.milestoneId);
    const before = await this.lockProjectRecord(client, actor, "milestones", milestoneId);
    await assertWorkstreamInProject(client, actor.organizationId, String(before.project_id), input.workstreamId as string | undefined);
    await assertOrganizationUser(client, actor.organizationId, input.ownerUserId as string | undefined);
    const map: Record<string, string> = { workstreamId: "workstream_id", outcome: "outcome", ownerUserId: "owner_user_id", targetAt: "target_at", state: "state", calendarEventId: "calendar_event_id" };
    const values: unknown[] = [];
    const assignments: string[] = [];
    for (const [key, column] of Object.entries(map)) {
      if (input[key] === undefined) continue;
      values.push(input[key]);
      assignments.push(`${column} = $${values.length}`);
    }
    const state = String(input.state ?? before.state);
    values.push(state, actor.actorId, actor.organizationId, milestoneId);
    const result = await client.query<ProductRow>(
      `UPDATE milestones SET ${assignments.join(", ")},
              completed_at = CASE WHEN $${values.length - 3} = 'completed' THEN COALESCE(completed_at, now()) ELSE NULL END,
              updated_by_actor_id = $${values.length - 2}, updated_at = now()
        WHERE organization_id = $${values.length - 1} AND id = $${values.length} RETURNING *`,
      values,
    );
    const milestone = camelize(result.rows[0]);
    return mutationRecord(actor, "milestone.updated", atlasEventTypes.milestoneChanged, "milestone", milestoneId, { milestone }, camelize(before), milestone);
  }

  private async createActivity(client: DbClient, actor: ActorContext, input: Input) {
    const projectId = String(input.projectId);
    await requireProject(client, actor, projectId, { write: true });
    const id = randomUUID();
    const result = await client.query<ProductRow>(
      `INSERT INTO activities
         (id, organization_id, project_id, activity_type, body, occurred_at, created_by_actor_id)
       VALUES ($1, $2, $3, $4, $5, COALESCE($6::timestamptz, now()), $7) RETURNING *`,
      [id, actor.organizationId, projectId, valueOr(input, "activityType", "note"), input.body, input.occurredAt ?? null, actor.actorId],
    );
    const activity = camelize(result.rows[0]);
    return mutationRecord(actor, "activity.recorded", atlasEventTypes.activityRecorded, "activity", id, { activity }, null, activity);
  }

  private async lockProjectRecord(
    client: DbClient,
    actor: ActorContext,
    table: "risks" | "blockers" | "milestones",
    id: string,
  ): Promise<ProductRow> {
    const result = await client.query<ProductRow>(
      `SELECT * FROM ${table} WHERE organization_id = $1 AND id = $2 AND archived_at IS NULL FOR UPDATE`,
      [actor.organizationId, id],
    );
    const row = result.rows[0];
    if (!row) throw safeNotFound();
    await requireProject(client, actor, String(row.project_id), { write: true });
    return row;
  }

  private async updateMappedRecord(
    client: DbClient,
    table: "decisions" | "risks",
    id: string,
    actor: ActorContext,
    input: Input,
    map: Record<string, string>,
  ): Promise<ProductRow> {
    const values: unknown[] = [];
    const assignments: string[] = [];
    for (const [key, column] of Object.entries(map)) {
      if (input[key] === undefined) continue;
      values.push(input[key]);
      assignments.push(`${column} = $${values.length}`);
    }
    if (assignments.length === 0) {
      const existing = await client.query<ProductRow>(
        `SELECT * FROM ${table} WHERE organization_id = $1 AND id = $2`,
        [actor.organizationId, id],
      );
      if (!existing.rows[0]) throw safeNotFound();
      return existing.rows[0];
    }
    values.push(actor.actorId, actor.organizationId, id);
    const result = await client.query<ProductRow>(
      `UPDATE ${table} SET ${assignments.join(", ")}, updated_by_actor_id = $${values.length - 2}, updated_at = now()
        WHERE organization_id = $${values.length - 1} AND id = $${values.length} RETURNING *`,
      values,
    );
    return result.rows[0];
  }

  private async createPerson(client: DbClient, actor: ActorContext, input: Input) {
    const id = randomUUID();
    const result = await client.query<ProductRow>(
      `INSERT INTO people
         (id, organization_id, display_name, given_name, family_name, email,
          phone, title, notes, provenance, created_by_actor_id, updated_by_actor_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11) RETURNING *`,
      [id, actor.organizationId, input.displayName, valueOr(input, "givenName", ""), valueOr(input, "familyName", ""), input.email ?? null, valueOr(input, "phone", ""), valueOr(input, "title", ""), valueOr(input, "notes", ""), valueOr(input, "provenance", {}), actor.actorId],
    );
    const person = camelize(result.rows[0]);
    return mutationRecord(actor, "person.created", atlasEventTypes.personChanged, "person", id, { person }, null, person);
  }

  private async updatePerson(client: DbClient, actor: ActorContext, input: Input) {
    const personId = String(input.personId);
    const before = await this.lockOrganizationRecord(client, actor, "people", personId);
    const result = await this.updateOrganizationRecord(client, "people", personId, actor, input, {
      displayName: "display_name", givenName: "given_name", familyName: "family_name",
      email: "email", phone: "phone", title: "title", notes: "notes", provenance: "provenance",
    });
    const person = camelize(result);
    return mutationRecord(actor, "person.updated", atlasEventTypes.personChanged, "person", personId, { person }, camelize(before), person);
  }

  private async mergePerson(client: DbClient, actor: ActorContext, input: Input) {
    const personId = String(input.personId);
    const intoId = String(input.intoId);
    if (personId === intoId) throw conflict("A person cannot be merged into itself.");
    const source = await this.lockOrganizationRecord(client, actor, "people", personId);
    await this.lockOrganizationRecord(client, actor, "people", intoId);
    await client.query(
      `UPDATE person_organization_affiliations
          SET person_id = $1
        WHERE organization_id = $2 AND person_id = $3 AND archived_at IS NULL`,
      [intoId, actor.organizationId, personId],
    );
    await client.query(
      `INSERT INTO project_people
         (organization_id, project_id, person_id, role, influence, sentiment,
          relevance, notes, visibility, created_by_actor_id, updated_by_actor_id)
       SELECT organization_id, project_id, $1, role, influence, sentiment,
              relevance, notes, visibility, $2, $2
         FROM project_people
        WHERE organization_id = $3 AND person_id = $4 AND archived_at IS NULL
       ON CONFLICT (organization_id, project_id, person_id)
       DO UPDATE SET role = EXCLUDED.role, influence = EXCLUDED.influence,
                     sentiment = EXCLUDED.sentiment, relevance = EXCLUDED.relevance,
                     notes = EXCLUDED.notes, visibility = EXCLUDED.visibility,
                     updated_by_actor_id = EXCLUDED.updated_by_actor_id, updated_at = now(),
                     archived_at = NULL`,
      [intoId, actor.actorId, actor.organizationId, personId],
    );
    await client.query(
      `UPDATE project_people SET archived_at = now(), updated_by_actor_id = $1, updated_at = now()
        WHERE organization_id = $2 AND person_id = $3 AND archived_at IS NULL`,
      [actor.actorId, actor.organizationId, personId],
    );
    const result = await client.query<ProductRow>(
      `UPDATE people SET merged_into_id = $1, merged_at = now(), archived_at = now(),
              updated_by_actor_id = $2, updated_at = now()
        WHERE organization_id = $3 AND id = $4 RETURNING *`,
      [intoId, actor.actorId, actor.organizationId, personId],
    );
    const person = camelize(result.rows[0]);
    return mutationRecord(actor, "person.merged", atlasEventTypes.personChanged, "person", personId, { person, intoId }, camelize(source), person);
  }

  private async createCounterparty(client: DbClient, actor: ActorContext, input: Input) {
    const id = randomUUID();
    const result = await client.query<ProductRow>(
      `INSERT INTO counterparty_organizations
         (id, organization_id, name, kind, website, notes, provenance,
          created_by_actor_id, updated_by_actor_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8) RETURNING *`,
      [id, actor.organizationId, input.name, valueOr(input, "kind", "other"), valueOr(input, "website", ""), valueOr(input, "notes", ""), valueOr(input, "provenance", {}), actor.actorId],
    );
    const counterparty = camelize(result.rows[0]);
    return mutationRecord(actor, "counterparty.created", atlasEventTypes.counterpartyChanged, "counterparty", id, { counterparty }, null, counterparty);
  }

  private async updateCounterparty(client: DbClient, actor: ActorContext, input: Input) {
    const counterpartyId = String(input.counterpartyId);
    const before = await this.lockOrganizationRecord(client, actor, "counterparty_organizations", counterpartyId);
    const result = await this.updateOrganizationRecord(client, "counterparty_organizations", counterpartyId, actor, input, {
      name: "name", kind: "kind", website: "website", notes: "notes", provenance: "provenance",
    });
    const counterparty = camelize(result);
    return mutationRecord(actor, "counterparty.updated", atlasEventTypes.counterpartyChanged, "counterparty", counterpartyId, { counterparty }, camelize(before), counterparty);
  }

  private async mergeCounterparty(client: DbClient, actor: ActorContext, input: Input) {
    const counterpartyId = String(input.counterpartyId);
    const intoId = String(input.intoId);
    if (counterpartyId === intoId) throw conflict("A counterparty cannot be merged into itself.");
    const source = await this.lockOrganizationRecord(client, actor, "counterparty_organizations", counterpartyId);
    await this.lockOrganizationRecord(client, actor, "counterparty_organizations", intoId);
    await client.query(
      `UPDATE person_organization_affiliations SET counterparty_id = $1
        WHERE organization_id = $2 AND counterparty_id = $3 AND archived_at IS NULL`,
      [intoId, actor.organizationId, counterpartyId],
    );
    await client.query(
      `INSERT INTO project_counterparties
         (organization_id, project_id, counterparty_id, role, influence, sentiment,
          relevance, notes, visibility, created_by_actor_id, updated_by_actor_id)
       SELECT organization_id, project_id, $1, role, influence, sentiment,
              relevance, notes, visibility, $2, $2
         FROM project_counterparties
        WHERE organization_id = $3 AND counterparty_id = $4 AND archived_at IS NULL
       ON CONFLICT (organization_id, project_id, counterparty_id)
       DO UPDATE SET role = EXCLUDED.role, influence = EXCLUDED.influence,
                     sentiment = EXCLUDED.sentiment, relevance = EXCLUDED.relevance,
                     notes = EXCLUDED.notes, visibility = EXCLUDED.visibility,
                     updated_by_actor_id = EXCLUDED.updated_by_actor_id, updated_at = now(),
                     archived_at = NULL`,
      [intoId, actor.actorId, actor.organizationId, counterpartyId],
    );
    await client.query(
      `UPDATE project_counterparties SET archived_at = now(), updated_by_actor_id = $1, updated_at = now()
        WHERE organization_id = $2 AND counterparty_id = $3 AND archived_at IS NULL`,
      [actor.actorId, actor.organizationId, counterpartyId],
    );
    const result = await client.query<ProductRow>(
      `UPDATE counterparty_organizations
          SET merged_into_id = $1, merged_at = now(), archived_at = now(),
              updated_by_actor_id = $2, updated_at = now()
        WHERE organization_id = $3 AND id = $4 RETURNING *`,
      [intoId, actor.actorId, actor.organizationId, counterpartyId],
    );
    const counterparty = camelize(result.rows[0]);
    return mutationRecord(actor, "counterparty.merged", atlasEventTypes.counterpartyChanged, "counterparty", counterpartyId, { counterparty, intoId }, camelize(source), counterparty);
  }

  private async createAffiliation(client: DbClient, actor: ActorContext, input: Input) {
    const personId = String(input.personId);
    await this.lockOrganizationRecord(client, actor, "people", personId, false);
    await this.lockOrganizationRecord(client, actor, "counterparty_organizations", String(input.counterpartyId), false);
    const id = randomUUID();
    const result = await client.query<ProductRow>(
      `INSERT INTO person_organization_affiliations
         (id, organization_id, person_id, counterparty_id, title, is_primary,
          starts_on, ends_on, provenance, created_by_actor_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
      [id, actor.organizationId, personId, input.counterpartyId, valueOr(input, "title", ""), valueOr(input, "isPrimary", false), input.startsOn ?? null, input.endsOn ?? null, valueOr(input, "provenance", {}), actor.actorId],
    );
    const affiliation = camelize(result.rows[0]);
    return mutationRecord(actor, "affiliation.created", atlasEventTypes.personChanged, "affiliation", id, { affiliation }, null, affiliation);
  }

  private async changeProjectRelationship(
    client: DbClient,
    actor: ActorContext,
    input: Input,
    kind: "person" | "counterparty",
    add: boolean,
  ) {
    const projectId = String(input.projectId);
    await requireProject(client, actor, projectId, { write: true });
    const targetId = String(kind === "person" ? input.personId : input.counterpartyId);
    const targetTable = kind === "person" ? "people" : "counterparty_organizations";
    await this.lockOrganizationRecord(client, actor, targetTable, targetId, false);
    const linkTable = kind === "person" ? "project_people" : "project_counterparties";
    const targetColumn = kind === "person" ? "person_id" : "counterparty_id";
    let row: ProductRow;
    if (add) {
      const result = await client.query<ProductRow>(
        `INSERT INTO ${linkTable}
           (organization_id, project_id, ${targetColumn}, role, influence, sentiment,
            relevance, notes, visibility, created_by_actor_id, updated_by_actor_id)
         VALUES ($1, $2, $3, $4, $5::relationship_influence,
                 $6::relationship_sentiment, $7, $8, $9, $10, $10)
         ON CONFLICT (organization_id, project_id, ${targetColumn})
         DO UPDATE SET role = EXCLUDED.role, influence = EXCLUDED.influence,
                       sentiment = EXCLUDED.sentiment, relevance = EXCLUDED.relevance,
                       notes = EXCLUDED.notes, visibility = EXCLUDED.visibility,
                       updated_by_actor_id = EXCLUDED.updated_by_actor_id,
                       updated_at = now(), archived_at = NULL
         RETURNING *`,
        [actor.organizationId, projectId, targetId, valueOr(input, "role", ""), valueOr(input, "influence", "medium"), valueOr(input, "sentiment", "unknown"), valueOr(input, "relevance", ""), valueOr(input, "notes", ""), valueOr(input, "visibility", "project"), actor.actorId],
      );
      row = result.rows[0];
    } else {
      const result = await client.query<ProductRow>(
        `UPDATE ${linkTable} SET archived_at = now(), updated_by_actor_id = $1, updated_at = now()
          WHERE organization_id = $2 AND project_id = $3 AND ${targetColumn} = $4
            AND archived_at IS NULL RETURNING *`,
        [actor.actorId, actor.organizationId, projectId, targetId],
      );
      row = result.rows[0];
      if (!row) throw safeNotFound();
    }
    const relationship = camelize(row);
    return mutationRecord(actor, add ? `project.${kind}-linked` : `project.${kind}-unlinked`, atlasEventTypes.projectRelationshipChanged, "project_relationship", String(row.id), { relationship, removed: !add }, null, relationship);
  }

  private async createSavedView(client: DbClient, actor: ActorContext, input: Input) {
    const id = randomUUID();
    if (input.isDefault) {
      await client.query(
        `UPDATE saved_views SET is_default = false, updated_by_actor_id = $1, updated_at = now()
          WHERE organization_id = $2 AND owner_actor_id = $1 AND surface = $3 AND archived_at IS NULL`,
        [actor.actorId, actor.organizationId, input.surface],
      );
    }
    const result = await client.query<ProductRow>(
      `INSERT INTO saved_views
         (id, organization_id, owner_actor_id, name, surface, filters, is_default,
          created_by_actor_id, updated_by_actor_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $3, $3) RETURNING *`,
      [id, actor.organizationId, actor.actorId, input.name, input.surface, valueOr(input, "filters", {}), valueOr(input, "isDefault", false)],
    );
    const savedView = camelize(result.rows[0]);
    return mutationRecord(actor, "saved-view.created", atlasEventTypes.savedViewChanged, "saved_view", id, { savedView }, null, savedView);
  }

  private async updateSavedView(client: DbClient, actor: ActorContext, input: Input) {
    const savedViewId = String(input.savedViewId);
    const existing = await client.query<ProductRow>(
      `SELECT * FROM saved_views
        WHERE organization_id = $1 AND id = $2 AND owner_actor_id = $3 AND archived_at IS NULL
        FOR UPDATE`,
      [actor.organizationId, savedViewId, actor.actorId],
    );
    const before = existing.rows[0];
    if (!before) throw safeNotFound();
    const surface = String(input.surface ?? before.surface);
    if (input.isDefault) {
      await client.query(
        `UPDATE saved_views SET is_default = false, updated_by_actor_id = $1, updated_at = now()
          WHERE organization_id = $2 AND owner_actor_id = $1 AND surface = $3
            AND id <> $4 AND archived_at IS NULL`,
        [actor.actorId, actor.organizationId, surface, savedViewId],
      );
    }
    const result = await this.updateOrganizationRecord(client, "saved_views", savedViewId, actor, input, {
      name: "name", surface: "surface", filters: "filters", isDefault: "is_default",
    }, "owner_actor_id");
    const savedView = camelize(result);
    return mutationRecord(actor, "saved-view.updated", atlasEventTypes.savedViewChanged, "saved_view", savedViewId, { savedView }, camelize(before), savedView);
  }

  private async archiveSavedView(client: DbClient, actor: ActorContext, input: Input) {
    const savedViewId = String(input.savedViewId);
    const before = await client.query<ProductRow>(
      "SELECT * FROM saved_views WHERE organization_id = $1 AND id = $2 AND owner_actor_id = $3 FOR UPDATE",
      [actor.organizationId, savedViewId, actor.actorId],
    );
    if (!before.rows[0]) throw safeNotFound();
    const archived = Boolean(input.archived);
    const result = await client.query<ProductRow>(
      `UPDATE saved_views SET archived_at = CASE WHEN $1 THEN now() ELSE NULL END,
              updated_by_actor_id = $2, updated_at = now()
        WHERE organization_id = $3 AND id = $4 AND owner_actor_id = $2 RETURNING *`,
      [archived, actor.actorId, actor.organizationId, savedViewId],
    );
    const savedView = camelize(result.rows[0]);
    return mutationRecord(actor, archived ? "saved-view.archived" : "saved-view.recovered", atlasEventTypes.savedViewChanged, "saved_view", savedViewId, { savedView }, camelize(before.rows[0]), savedView);
  }

  private async lockOrganizationRecord(
    client: DbClient,
    actor: ActorContext,
    table: "people" | "counterparty_organizations",
    id: string,
    lock = true,
  ): Promise<ProductRow> {
    const result = await client.query<ProductRow>(
      `SELECT * FROM ${table}
        WHERE organization_id = $1 AND id = $2 AND archived_at IS NULL AND merged_at IS NULL
        ${lock ? "FOR UPDATE" : ""}`,
      [actor.organizationId, id],
    );
    if (!result.rows[0]) throw safeNotFound();
    return result.rows[0];
  }

  private async updateOrganizationRecord(
    client: DbClient,
    table: "people" | "counterparty_organizations" | "saved_views",
    id: string,
    actor: ActorContext,
    input: Input,
    map: Record<string, string>,
    ownerColumn?: string,
  ): Promise<ProductRow> {
    const values: unknown[] = [];
    const assignments: string[] = [];
    for (const [key, column] of Object.entries(map)) {
      if (input[key] === undefined) continue;
      values.push(input[key]);
      assignments.push(`${column} = $${values.length}`);
    }
    values.push(actor.actorId, actor.organizationId, id);
    const result = await client.query<ProductRow>(
      `UPDATE ${table} SET ${assignments.join(", ")}, updated_by_actor_id = $${values.length - 2}, updated_at = now()
        WHERE organization_id = $${values.length - 1} AND id = $${values.length}
        ${ownerColumn ? `AND ${ownerColumn} = $${values.length - 2}` : ""}
        RETURNING *`,
      values,
    );
    if (!result.rows[0]) throw safeNotFound();
    return result.rows[0];
  }

  private async listProjects(actor: ActorContext, input: Input): Promise<Result> {
    const limit = Number(input.limit ?? 50);
    const values: unknown[] = [actor.organizationId, actor.role, actor.userId ?? null];
    const conditions = [`p.organization_id = $1`, broadProjectAccessSql];
    if (input.status) {
      values.push(input.status);
      conditions.push(`p.status = $${values.length}::project_status`);
    }
    if (input.health) {
      values.push(input.health);
      conditions.push(`p.health = $${values.length}::project_health`);
    }
    if (input.ownerUserId) {
      values.push(input.ownerUserId);
      conditions.push(`p.owner_user_id = $${values.length}::uuid`);
    }
    if (input.templateType) {
      values.push(input.templateType);
      conditions.push(`p.template_type = $${values.length}`);
    }
    if (input.strategicArea) {
      values.push(input.strategicArea);
      conditions.push(`p.strategic_area = $${values.length}`);
    }
    if (input.q) {
      values.push(`%${String(input.q).replaceAll("%", "\\%").replaceAll("_", "\\_")}%`);
      conditions.push(`(p.name ILIKE $${values.length} ESCAPE '\\' OR p.objective ILIKE $${values.length} ESCAPE '\\')`);
    }
    if (!input.includeArchived) conditions.push("p.archived_at IS NULL");
    if (input.cursor) {
      const cursor = decodeCursor(String(input.cursor));
      values.push(cursor.sortValue, cursor.id);
      conditions.push(`(p.created_at, p.id) < ($${values.length - 1}::timestamptz, $${values.length}::uuid)`);
    }
    values.push(limit + 1);
    const response = await this.pool.query<Row>(
      `SELECT p.*
         FROM project_rooms p
        WHERE ${conditions.join(" AND ")}
        ORDER BY p.created_at DESC, p.id DESC
        LIMIT $${values.length}`,
      values,
    );
    const page = paginate(response.rows, limit);
    return { projects: page.records, page: page.page };
  }

  private async getProject(actor: ActorContext, projectId: string): Promise<Record<string, unknown>> {
    const response = await this.pool.query<Row>(
      `SELECT p.*
         FROM project_rooms p
        WHERE p.organization_id = $1
          AND p.id = $4
          AND ${broadProjectAccessSql}`,
      [actor.organizationId, actor.role, actor.userId ?? null, projectId],
    );
    const project = response.rows[0];
    if (!project) throw notFound();
    return camelize(project);
  }

  private async listWork(actor: ActorContext, input: Input, projection: boolean): Promise<Result> {
    const limit = Number(input.limit ?? 50);
    const values: unknown[] = [actor.organizationId, actor.role, actor.userId ?? null];
    const conditions = [`w.organization_id = $1`, broadProjectAccessSql];
    if (!input.includeArchived) conditions.push("w.archived_at IS NULL");
    if (input.workItemId) {
      values.push(input.workItemId);
      conditions.push(`w.id = $${values.length}::uuid`);
    }
    for (const [field, column, cast] of [
      ["projectId", "w.project_id", "uuid"],
      ["workstreamId", "w.workstream_id", "uuid"],
      ["ownerUserId", "w.owner_user_id", "uuid"],
      ["status", "w.status", "work_item_status"],
      ["type", "w.type", "work_item_type"],
      ["priority", "w.priority", "atlas_priority"],
    ] as const) {
      if (input[field]) {
        values.push(input[field]);
        conditions.push(`${column} = $${values.length}::${cast}`);
      }
    }
    if (input.labelId) {
      values.push(input.labelId);
      conditions.push(`EXISTS (
        SELECT 1 FROM work_item_labels filter_label
         WHERE filter_label.organization_id = w.organization_id
           AND filter_label.work_item_id = w.id
           AND filter_label.label_id = $${values.length}::uuid
      )`);
    }
    if (input.dueBefore) {
      values.push(input.dueBefore);
      conditions.push(`w.due_at <= $${values.length}::timestamptz`);
    }
    if (input.dueAfter) {
      values.push(input.dueAfter);
      conditions.push(`w.due_at >= $${values.length}::timestamptz`);
    }
    if (input.blocked !== undefined) {
      conditions.push(`${input.blocked ? "" : "NOT "}EXISTS (
        SELECT 1 FROM blockers b
         WHERE b.organization_id = w.organization_id
           AND b.target_type = 'work_item'
           AND b.target_id = w.id
           AND b.resolved_at IS NULL
           AND b.archived_at IS NULL
      )`);
    }
    if (input.view === "calendar") conditions.push("w.due_at IS NOT NULL");
    if (input.cursor) {
      const cursor = decodeCursor(String(input.cursor));
      values.push(cursor.sortValue, cursor.id);
      conditions.push(`(w.created_at, w.id) < ($${values.length - 1}::timestamptz, $${values.length}::uuid)`);
    }
    values.push(limit + 1);
    const response = await this.pool.query<Row>(
      `SELECT w.*,
              COALESCE((
                SELECT jsonb_agg(jsonb_build_object('id', l.id, 'name', l.name, 'color', l.color) ORDER BY l.name)
                  FROM work_item_labels wil
                  JOIN labels l ON l.organization_id = wil.organization_id AND l.id = wil.label_id
                 WHERE wil.organization_id = w.organization_id AND wil.work_item_id = w.id
              ), '[]'::jsonb) AS labels,
              COALESCE((
                SELECT jsonb_agg(wid.dependency_work_item_id ORDER BY wid.created_at)
                  FROM work_item_dependencies wid
                 WHERE wid.organization_id = w.organization_id AND wid.blocked_work_item_id = w.id
              ), '[]'::jsonb) AS dependencies
         FROM work_items w
         JOIN project_rooms p ON p.organization_id = w.organization_id AND p.id = w.project_id
        WHERE ${conditions.join(" AND ")}
        ORDER BY w.created_at DESC, w.id DESC
        LIMIT $${values.length}`,
      values,
    );
    const page = paginate(response.rows, limit);
    const view = String(input.view ?? "list");
    const result: Result = { items: page.records, page: page.page };
    if (projection) result.view = view;
    if (projection && view === "board") {
      result.lanes = Object.fromEntries(
        ["inbox", "next", "in_progress", "waiting", "done", "canceled"].map((status) => [
          status,
          page.records.filter((item) => item.status === status),
        ]),
      );
    }
    return result;
  }

  private async queryRemaining(
    actor: ActorContext,
    operation: string,
    input: Input,
  ): Promise<Result> {
    switch (operation) {
      case "project.members.list": {
        await this.getProject(actor, String(input.projectId));
        const limit = Number(input.limit ?? 50);
        const values: unknown[] = [actor.organizationId, input.projectId];
        const cursorCondition = input.cursor
          ? (() => {
              const cursor = decodeCursor(String(input.cursor));
              values.push(cursor.sortValue, cursor.id);
              return `AND (pm.created_at, pm.id) > ($${values.length - 1}::timestamptz, $${values.length}::uuid)`;
            })()
          : "";
        values.push(limit + 1);
        const response = await this.pool.query<Row>(
          `SELECT pm.id, pm.project_id, pm.user_id, pm.role, pm.created_at, pm.updated_at,
                  u.email, u.display_name
             FROM project_memberships pm
             JOIN users u ON u.id = pm.user_id
            WHERE pm.organization_id = $1 AND pm.project_id = $2 ${cursorCondition}
            ORDER BY pm.created_at, pm.id LIMIT $${values.length}`,
          values,
        );
        const page = paginate(response.rows, limit);
        return { members: page.records, page: page.page };
      }
      case "project.health.list":
        return this.listProjectResource(actor, input, "project_health_updates", "healthUpdates");
      case "project.context":
        return this.projectContext(actor, String(input.projectId));
      case "portfolio.summary":
        return this.portfolio(actor, input);
      case "portfolio.health":
        return this.portfolioHealth(actor);
      case "today.get":
        return this.today(actor, input);
      case "workstream.list":
        return this.listProjectResource(actor, input, "workstreams", "workstreams", "position ASC, id ASC");
      case "workstream.get":
        return { workstream: await this.getProjectOwnedRecord(actor, "workstreams", String(input.workstreamId)) };
      case "work.get": {
        const result = await this.listWork(actor, { workItemId: input.workItemId, limit: 1 }, false);
        const workItem = (result.items as unknown[])[0];
        if (!workItem) throw notFound();
        return { workItem };
      }
      case "label.list":
        return this.listOrganizationResource(actor, input, "labels", "labels", "name ASC, id ASC");
      case "decision.list":
        return this.listProjectResource(actor, input, "decisions", "decisions");
      case "decision.get":
        return { decision: await this.getProjectOwnedRecord(actor, "decisions", String(input.decisionId), "primary_project_id") };
      case "risk.list":
        return this.listProjectResource(actor, input, "risks", "risks");
      case "risk.get":
        return { risk: await this.getProjectOwnedRecord(actor, "risks", String(input.riskId)) };
      case "blocker.list":
        return this.listProjectResource(actor, input, "blockers", "blockers");
      case "blocker.get":
        return { blocker: await this.getProjectOwnedRecord(actor, "blockers", String(input.blockerId)) };
      case "milestone.list":
        return this.listProjectResource(actor, input, "milestones", "milestones", "target_at ASC, id ASC");
      case "milestone.get":
        return { milestone: await this.getProjectOwnedRecord(actor, "milestones", String(input.milestoneId)) };
      case "activity.list":
        return this.listProjectResource(actor, input, "activities", "activities", "occurred_at DESC, id DESC");
      case "person.list":
        return this.listOrganizationResource(actor, input, "people", "people");
      case "person.get":
        return { person: await this.getOrganizationRecord(actor, "people", String(input.personId)) };
      case "counterparty.list":
        return this.listOrganizationResource(actor, input, "counterparty_organizations", "counterparties");
      case "counterparty.get":
        return { counterparty: await this.getOrganizationRecord(actor, "counterparty_organizations", String(input.counterpartyId)) };
      case "affiliation.list": {
        await this.getOrganizationRecord(actor, "people", String(input.personId));
        const limit = Number(input.limit ?? 50);
        const values: unknown[] = [actor.organizationId, input.personId];
        const cursorCondition = input.cursor
          ? (() => {
              const cursor = decodeCursor(String(input.cursor));
              values.push(cursor.sortValue, cursor.id);
              return `AND (a.created_at, a.id) < ($${values.length - 1}::timestamptz, $${values.length}::uuid)`;
            })()
          : "";
        values.push(limit + 1);
        const response = await this.pool.query<Row>(
          `SELECT a.*, c.name AS counterparty_name
             FROM person_organization_affiliations a
             JOIN counterparty_organizations c
               ON c.organization_id = a.organization_id AND c.id = a.counterparty_id
            WHERE a.organization_id = $1 AND a.person_id = $2 AND a.archived_at IS NULL ${cursorCondition}
            ORDER BY a.created_at DESC, a.id DESC LIMIT $${values.length}`,
          values,
        );
        const page = paginate(response.rows, limit);
        return { affiliations: page.records, page: page.page };
      }
      case "project.people.list":
        return this.listProjectRelationships(actor, input, "project_people", "people", "person_id", "people");
      case "project.counterparties.list":
        return this.listProjectRelationships(actor, input, "project_counterparties", "counterparty_organizations", "counterparty_id", "counterparties");
      case "saved-view.list":
        return this.listSavedViews(actor, input);
      case "search.global":
        return this.search(actor, input);
      default:
        throw new ApiError(501, "INTERNAL_ERROR", `Unsupported Operating Core query: ${operation}.`);
    }
  }

  private async listProjectResource(
    actor: ActorContext,
    input: Input,
    table: "project_health_updates" | "workstreams" | "decisions" | "risks" | "blockers" | "milestones" | "activities",
    responseKey: string,
    order = "created_at DESC, id DESC",
  ): Promise<Result> {
    const projectId = String(input.projectId);
    await this.getProject(actor, projectId);
    const limit = Number(input.limit ?? 50);
    const projectColumn = table === "decisions" ? "primary_project_id" : "project_id";
    const archive = ["project_health_updates"].includes(table) ? "" : "AND archived_at IS NULL";
    const sortColumn = order.startsWith("target_at") ? "target_at" : order.startsWith("occurred_at") ? "occurred_at" : order.startsWith("position") ? "position" : "created_at";
    const ascending = order.includes(" ASC");
    const values: unknown[] = [actor.organizationId, projectId];
    let cursorCondition = "";
    if (input.cursor) {
      const cursor = decodeCursor(String(input.cursor));
      values.push(cursor.sortValue, cursor.id);
      const cast = sortColumn === "position" ? "numeric" : "timestamptz";
      cursorCondition = `AND (${sortColumn}, id) ${ascending ? ">" : "<"} ($${values.length - 1}::${cast}, $${values.length}::uuid)`;
    }
    values.push(limit + 1);
    const response = await this.pool.query<Row>(
      `SELECT * FROM ${table}
        WHERE organization_id = $1 AND ${projectColumn} = $2 ${archive} ${cursorCondition}
        ORDER BY ${order}
        LIMIT $${values.length}`,
      values,
    );
    const page = paginate(response.rows, limit, sortColumn);
    return { [responseKey]: page.records, page: page.page };
  }

  private async getProjectOwnedRecord(
    actor: ActorContext,
    table: "workstreams" | "decisions" | "risks" | "blockers" | "milestones",
    id: string,
    projectColumn = "project_id",
  ): Promise<Record<string, unknown>> {
    const response = await this.pool.query<Row>(
      `SELECT * FROM ${table} WHERE organization_id = $1 AND id = $2 AND archived_at IS NULL`,
      [actor.organizationId, id],
    );
    const row = response.rows[0];
    if (!row) throw notFound();
    await this.getProject(actor, String(row[projectColumn]));
    return camelize(row);
  }

  private async listOrganizationResource(
    actor: ActorContext,
    input: Input,
    table: "labels" | "people" | "counterparty_organizations",
    responseKey: string,
    order = "created_at DESC, id DESC",
  ): Promise<Result> {
    const limit = Number(input.limit ?? 50);
    const values: unknown[] = [actor.organizationId];
    const conditions = ["organization_id = $1"];
    if (!input.includeArchived) conditions.push("archived_at IS NULL");
    if (table !== "labels") conditions.push("merged_at IS NULL");
    if (input.q && table !== "labels") {
      values.push(`%${String(input.q).replaceAll("%", "\\%").replaceAll("_", "\\_")}%`);
      const columns = table === "people" ? ["display_name", "email::text", "title"] : ["name", "kind", "website"];
      conditions.push(`(${columns.map((column) => `${column} ILIKE $${values.length} ESCAPE '\\'`).join(" OR ")})`);
    }
    const sortColumn = table === "labels" ? "name" : "created_at";
    if (input.cursor) {
      const cursor = decodeCursor(String(input.cursor));
      values.push(cursor.sortValue, cursor.id);
      conditions.push(`(${sortColumn}, id) ${table === "labels" ? ">" : "<"} ($${values.length - 1}${table === "labels" ? "" : "::timestamptz"}, $${values.length}::uuid)`);
    }
    values.push(limit + 1);
    const response = await this.pool.query<Row>(
      `SELECT * FROM ${table} WHERE ${conditions.join(" AND ")} ORDER BY ${order} LIMIT $${values.length}`,
      values,
    );
    const page = paginate(response.rows, limit, sortColumn);
    return { [responseKey]: page.records, page: page.page };
  }

  private async getOrganizationRecord(
    actor: ActorContext,
    table: "people" | "counterparty_organizations",
    id: string,
  ): Promise<Record<string, unknown>> {
    const response = await this.pool.query<Row>(
      `SELECT * FROM ${table} WHERE organization_id = $1 AND id = $2`,
      [actor.organizationId, id],
    );
    if (!response.rows[0]) throw notFound();
    return camelize(response.rows[0]);
  }

  private async listProjectRelationships(
    actor: ActorContext,
    input: Input,
    linkTable: "project_people" | "project_counterparties",
    targetTable: "people" | "counterparty_organizations",
    targetColumn: "person_id" | "counterparty_id",
    responseKey: string,
  ): Promise<Result> {
    await this.getProject(actor, String(input.projectId));
    const limit = Number(input.limit ?? 50);
    const values: unknown[] = [actor.organizationId, input.projectId, actor.actorId];
    let cursorCondition = "";
    if (input.cursor) {
      const cursor = decodeCursor(String(input.cursor));
      values.push(cursor.sortValue, cursor.id);
      cursorCondition = `AND (relation.created_at, relation.id) < ($${values.length - 1}::timestamptz, $${values.length}::uuid)`;
    }
    values.push(limit + 1);
    const response = await this.pool.query<Row>(
      `SELECT target.*, relation.role AS project_role, relation.influence,
              relation.sentiment, relation.relevance, relation.notes AS relationship_notes,
              relation.visibility, relation.created_at AS relationship_created_at
         FROM ${linkTable} relation
         JOIN ${targetTable} target
           ON target.organization_id = relation.organization_id AND target.id = relation.${targetColumn}
        WHERE relation.organization_id = $1 AND relation.project_id = $2
          AND relation.archived_at IS NULL
          AND (relation.visibility = 'project' OR relation.created_by_actor_id = $3)
          ${cursorCondition}
        ORDER BY relation.created_at DESC, relation.id DESC
        LIMIT $${values.length}`,
      values,
    );
    const page = paginate(response.rows, limit, "relationship_created_at");
    return { [responseKey]: page.records, page: page.page };
  }

  private async listSavedViews(actor: ActorContext, input: Input): Promise<Result> {
    const limit = Number(input.limit ?? 50);
    const values: unknown[] = [actor.organizationId, actor.actorId];
    const conditions = ["organization_id = $1", "owner_actor_id = $2", "archived_at IS NULL"];
    if (input.surface) {
      values.push(input.surface);
      conditions.push(`surface = $${values.length}`);
    }
    if (input.cursor) {
      const cursor = decodeCursor(String(input.cursor));
      values.push(cursor.sortValue, cursor.id);
      conditions.push(`(created_at, id) < ($${values.length - 1}::timestamptz, $${values.length}::uuid)`);
    }
    values.push(limit + 1);
    const response = await this.pool.query<Row>(
      `SELECT * FROM saved_views WHERE ${conditions.join(" AND ")}
       ORDER BY created_at DESC, id DESC LIMIT $${values.length}`,
      values,
    );
    const page = paginate(response.rows, limit);
    return { savedViews: page.records, page: page.page };
  }

  private async portfolio(actor: ActorContext, input: Input): Promise<Result> {
    const limit = Number(input.limit ?? 50);
    const values: unknown[] = [actor.organizationId, actor.role, actor.userId ?? null];
    const conditions = ["p.organization_id = $1", broadProjectAccessSql, "p.archived_at IS NULL"];
    if (input.health) {
      values.push(input.health);
      conditions.push(`p.health = $${values.length}::project_health`);
    }
    if (input.cursor) {
      const cursor = decodeCursor(String(input.cursor));
      values.push(cursor.sortValue, cursor.id);
      conditions.push(`(p.created_at, p.id) < ($${values.length - 1}::timestamptz, $${values.length}::uuid)`);
    }
    values.push(limit + 1);
    const response = await this.pool.query<Row>(
      `SELECT p.*,
              COALESCE((
                SELECT jsonb_object_agg(status, count)
                  FROM (SELECT status, count(*)::int AS count FROM work_items w
                         WHERE w.organization_id = p.organization_id AND w.project_id = p.id
                           AND w.archived_at IS NULL GROUP BY status) counts
              ), '{}'::jsonb) AS work_status_counts,
              (SELECT max(a.occurred_at) FROM activities a
                WHERE a.organization_id = p.organization_id AND a.project_id = p.id
                  AND a.archived_at IS NULL) AS recent_activity_at
         FROM project_rooms p
        WHERE ${conditions.join(" AND ")}
        ORDER BY p.created_at DESC, p.id DESC
        LIMIT $${values.length}`,
      values,
    );
    const page = paginate(response.rows, limit);
    return { projects: page.records, page: page.page };
  }

  private async portfolioHealth(actor: ActorContext): Promise<Result> {
    const response = await this.pool.query<Row>(
      `SELECT p.health, count(*)::int AS project_count
         FROM project_rooms p
        WHERE p.organization_id = $1 AND p.archived_at IS NULL AND ${broadProjectAccessSql}
        GROUP BY p.health ORDER BY p.health`,
      [actor.organizationId, actor.role, actor.userId ?? null],
    );
    return { health: response.rows.map(camelize) };
  }

  private async today(actor: ActorContext, input: Input): Promise<Result> {
    const day = input.date ? String(input.date) : new Date().toISOString().slice(0, 10);
    const work = await this.pool.query<Row>(
      `SELECT w.*
         FROM work_items w
         JOIN project_rooms p ON p.organization_id = w.organization_id AND p.id = w.project_id
        WHERE w.organization_id = $1 AND w.owner_user_id = $4
          AND w.status IN ('next', 'in_progress', 'waiting')
          AND w.archived_at IS NULL AND p.archived_at IS NULL AND ${broadProjectAccessSql}
        ORDER BY (w.due_at IS NULL), w.due_at, w.priority DESC, w.position, w.id`,
      [actor.organizationId, actor.role, actor.userId ?? null, actor.userId ?? null],
    );
    const decisions = await this.pool.query<Row>(
      `SELECT d.* FROM decisions d
         JOIN project_rooms p ON p.organization_id = d.organization_id AND p.id = d.primary_project_id
        WHERE d.organization_id = $1 AND d.state = 'proposed' AND d.archived_at IS NULL
          AND (d.owner_user_id = $3 OR d.owner_user_id IS NULL) AND ${broadProjectAccessSql}
        ORDER BY d.created_at DESC LIMIT 50`,
      [actor.organizationId, actor.role, actor.userId ?? null],
    );
    const health = await this.pool.query<Row>(
      `SELECT h.* FROM project_health_updates h
         JOIN project_rooms p ON p.organization_id = h.organization_id AND p.id = h.project_id
        WHERE h.organization_id = $1 AND h.created_at >= $4::date - interval '7 days'
          AND ${broadProjectAccessSql}
        ORDER BY h.created_at DESC LIMIT 50`,
      [actor.organizationId, actor.role, actor.userId ?? null, day],
    );
    const activities = await this.pool.query<Row>(
      `SELECT a.* FROM activities a
         JOIN project_rooms p ON p.organization_id = a.organization_id AND p.id = a.project_id
         JOIN actors creator ON creator.organization_id = a.organization_id AND creator.id = a.created_by_actor_id
        WHERE a.organization_id = $1 AND creator.type IN ('agent', 'automation')
          AND a.occurred_at >= $4::date - interval '7 days' AND ${broadProjectAccessSql}
        ORDER BY a.occurred_at DESC LIMIT 50`,
      [actor.organizationId, actor.role, actor.userId ?? null, day],
    );
    const milestones = await this.pool.query<Row>(
      `SELECT m.* FROM milestones m
         JOIN project_rooms p ON p.organization_id = m.organization_id AND p.id = m.project_id
        WHERE m.organization_id = $1 AND m.state = 'planned' AND m.archived_at IS NULL
          AND m.target_at >= $4::date AND m.target_at < $4::date + interval '31 days'
          AND ${broadProjectAccessSql}
        ORDER BY m.target_at, m.id LIMIT 50`,
      [actor.organizationId, actor.role, actor.userId ?? null, day],
    );
    return {
      date: day,
      workItems: work.rows.map(camelize),
      decisionsNeeded: decisions.rows.map(camelize),
      healthChanges: health.rows.map(camelize),
      agentActivity: activities.rows.map(camelize),
      upcomingMilestones: milestones.rows.map(camelize),
    };
  }

  private async projectContext(actor: ActorContext, projectId: string): Promise<Result> {
    const project = await this.getProject(actor, projectId);
    const [workstreams, work, decisions, risks, blockers, milestones, activities, people, counterparties, health] = await Promise.all([
      this.listProjectResource(actor, { projectId, limit: 100 }, "workstreams", "workstreams", "position ASC, id ASC"),
      this.listWork(actor, { projectId, limit: 100 }, false),
      this.listProjectResource(actor, { projectId, limit: 100 }, "decisions", "decisions"),
      this.listProjectResource(actor, { projectId, limit: 100 }, "risks", "risks"),
      this.listProjectResource(actor, { projectId, limit: 100 }, "blockers", "blockers"),
      this.listProjectResource(actor, { projectId, limit: 100 }, "milestones", "milestones", "target_at ASC, id ASC"),
      this.listProjectResource(actor, { projectId, limit: 100 }, "activities", "activities", "occurred_at DESC, id DESC"),
      this.listProjectRelationships(actor, { projectId, limit: 100 }, "project_people", "people", "person_id", "people"),
      this.listProjectRelationships(actor, { projectId, limit: 100 }, "project_counterparties", "counterparty_organizations", "counterparty_id", "counterparties"),
      this.listProjectResource(actor, { projectId, limit: 100 }, "project_health_updates", "healthUpdates"),
    ]);
    return {
      project,
      workstreams: workstreams.workstreams,
      workItems: work.items,
      decisions: decisions.decisions,
      risks: risks.risks,
      blockers: blockers.blockers,
      milestones: milestones.milestones,
      activities: activities.activities,
      people: people.people,
      counterparties: counterparties.counterparties,
      healthUpdates: health.healthUpdates,
    };
  }

  private async search(actor: ActorContext, input: Input): Promise<Result> {
    const limit = Number(input.limit ?? 50);
    const query = `%${String(input.q).replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
    const allowedTypes = input.types ? new Set(String(input.types).split(",")) : null;
    const response = await this.pool.query<Row>(
      `WITH authorized_projects AS (
         SELECT p.id FROM project_rooms p
          WHERE p.organization_id = $1 AND p.archived_at IS NULL AND ${broadProjectAccessSql}
       ), native_records AS (
         SELECT 'project'::text AS type, p.id, p.name AS title, p.objective AS summary, p.updated_at
           FROM project_rooms p JOIN authorized_projects ap ON ap.id = p.id
          WHERE (p.name ILIKE $4 ESCAPE '\\' OR p.objective ILIKE $4 ESCAPE '\\')
         UNION ALL
         SELECT 'work_item', w.id, w.title, w.description, w.updated_at
           FROM work_items w JOIN authorized_projects ap ON ap.id = w.project_id
          WHERE w.archived_at IS NULL AND (w.title ILIKE $4 ESCAPE '\\' OR w.description ILIKE $4 ESCAPE '\\')
         UNION ALL
         SELECT 'person', person.id, person.display_name, person.title, person.updated_at
           FROM people person WHERE person.organization_id = $1 AND person.archived_at IS NULL
             AND person.merged_at IS NULL AND (person.display_name ILIKE $4 ESCAPE '\\' OR person.title ILIKE $4 ESCAPE '\\')
         UNION ALL
         SELECT 'counterparty', c.id, c.name, c.kind, c.updated_at
           FROM counterparty_organizations c WHERE c.organization_id = $1 AND c.archived_at IS NULL
             AND c.merged_at IS NULL AND (c.name ILIKE $4 ESCAPE '\\' OR c.kind ILIKE $4 ESCAPE '\\')
       )
       SELECT * FROM native_records
        ${input.cursor ? "WHERE (updated_at, id) < ($5::timestamptz, $6::uuid)" : ""}
        ORDER BY updated_at DESC, id DESC LIMIT $${input.cursor ? 7 : 5}`,
      input.cursor
        ? [actor.organizationId, actor.role, actor.userId ?? null, query, decodeCursor(String(input.cursor)).sortValue, decodeCursor(String(input.cursor)).id, limit + 1]
        : [actor.organizationId, actor.role, actor.userId ?? null, query, limit + 1],
    );
    const filtered = allowedTypes ? response.rows.filter((row) => allowedTypes.has(String(row.type))) : response.rows;
    const page = paginate(filtered, limit, "updated_at");
    return { results: page.records, page: page.page };
  }
}
