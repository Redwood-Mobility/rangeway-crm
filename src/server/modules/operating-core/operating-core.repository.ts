import type { QueryResultRow } from "pg";
import type { ActorContext } from "../../../shared/identity.js";
import type { DbClient } from "../../platform/db/client.js";
import { ApiError } from "../../platform/http/api-error.js";

export type ProductRow = QueryResultRow & Record<string, unknown>;

export function safeNotFound(): ApiError {
  return new ApiError(404, "NOT_FOUND", "Resource not found.");
}

export function conflict(message: string): ApiError {
  return new ApiError(409, "CONFLICT", message);
}

export async function assertOrganizationUser(
  client: DbClient,
  organizationId: string,
  userId: string | undefined,
): Promise<void> {
  if (!userId) return;
  const result = await client.query(
    `SELECT 1
       FROM organization_memberships
      WHERE organization_id = $1
        AND user_id = $2`,
    [organizationId, userId],
  );
  if (result.rows.length === 0) throw safeNotFound();
}

export async function requireProject(
  client: DbClient,
  actor: ActorContext,
  projectId: string,
  options: { write?: boolean; lock?: boolean; allowArchived?: boolean } = {},
): Promise<ProductRow> {
  const membershipRoles = options.write ? ["owner", "editor"] : ["owner", "editor", "viewer"];
  const result = await client.query<ProductRow>(
    `SELECT p.*
       FROM project_rooms p
      WHERE p.organization_id = $1
        AND p.id = $2
        ${options.allowArchived ? "" : "AND p.archived_at IS NULL"}
        AND (
          $3::text IN ('owner', 'admin')
          OR p.owner_user_id = $4::uuid
          OR EXISTS (
            SELECT 1
              FROM project_memberships pm
             WHERE pm.organization_id = p.organization_id
               AND pm.project_id = p.id
               AND pm.user_id = $4::uuid
               AND pm.role = ANY($5::project_role[])
          )
        )
      ${options.lock ? "FOR UPDATE" : ""}`,
    [actor.organizationId, projectId, actor.role, actor.userId ?? null, membershipRoles],
  );
  const project = result.rows[0];
  if (!project) throw safeNotFound();
  return project;
}

export async function requireWorkItem(
  client: DbClient,
  actor: ActorContext,
  workItemId: string,
  options: { write?: boolean; lock?: boolean; allowArchived?: boolean } = {},
): Promise<ProductRow> {
  const result = await client.query<ProductRow>(
    `SELECT w.*
       FROM work_items w
      WHERE w.organization_id = $1
        AND w.id = $2
        ${options.allowArchived ? "" : "AND w.archived_at IS NULL"}
      ${options.lock ? "FOR UPDATE" : ""}`,
    [actor.organizationId, workItemId],
  );
  const workItem = result.rows[0];
  if (!workItem) throw safeNotFound();
  await requireProject(client, actor, String(workItem.project_id), {
    write: options.write,
    lock: false,
    allowArchived: options.allowArchived,
  });
  return workItem;
}

export async function assertWorkstreamInProject(
  client: DbClient,
  organizationId: string,
  projectId: string,
  workstreamId: string | undefined,
): Promise<void> {
  if (!workstreamId) return;
  const result = await client.query(
    `SELECT 1 FROM workstreams
      WHERE organization_id = $1 AND project_id = $2 AND id = $3 AND archived_at IS NULL`,
    [organizationId, projectId, workstreamId],
  );
  if (result.rows.length === 0) throw safeNotFound();
}

export async function assertParentAllowed(
  client: DbClient,
  organizationId: string,
  projectId: string,
  workItemId: string | undefined,
  parentId: string | undefined,
): Promise<void> {
  if (!parentId) return;
  const parent = await client.query<{ project_id: string }>(
    `SELECT project_id FROM work_items
      WHERE organization_id = $1 AND id = $2 AND archived_at IS NULL`,
    [organizationId, parentId],
  );
  if (!parent.rows[0] || parent.rows[0].project_id !== projectId) throw safeNotFound();
  if (!workItemId) return;
  const cycle = await client.query(
    `WITH RECURSIVE descendants AS (
       SELECT id FROM work_items
        WHERE organization_id = $1 AND parent_id = $2
       UNION ALL
       SELECT child.id
         FROM work_items child
         JOIN descendants d ON child.parent_id = d.id
        WHERE child.organization_id = $1
     )
     SELECT 1 FROM descendants WHERE id = $3 LIMIT 1`,
    [organizationId, workItemId, parentId],
  );
  if (parentId === workItemId || cycle.rows.length > 0) {
    throw conflict("Work item parents cannot contain a cycle.");
  }
}

export async function assertDependencyAllowed(
  client: DbClient,
  actor: ActorContext,
  blockedId: string,
  dependencyId: string,
): Promise<{ blocked: ProductRow; dependency: ProductRow }> {
  const blocked = await requireWorkItem(client, actor, blockedId, { write: true, lock: true });
  const dependency = await requireWorkItem(client, actor, dependencyId, { write: false, lock: true });
  if (blocked.project_id !== dependency.project_id) {
    throw conflict("Work item dependencies must belong to the same project.");
  }
  if (blockedId === dependencyId) {
    throw conflict("Work item dependencies cannot contain a cycle.");
  }
  const cycle = await client.query(
    `WITH RECURSIVE dependency_path AS (
       SELECT dependency_work_item_id AS id
         FROM work_item_dependencies
        WHERE organization_id = $1 AND blocked_work_item_id = $2
       UNION
       SELECT wid.dependency_work_item_id
         FROM work_item_dependencies wid
         JOIN dependency_path path ON wid.blocked_work_item_id = path.id
        WHERE wid.organization_id = $1
     )
     SELECT 1 FROM dependency_path WHERE id = $3 LIMIT 1`,
    [actor.organizationId, dependencyId, blockedId],
  );
  if (cycle.rows.length > 0) {
    throw conflict("Work item dependencies cannot contain a cycle.");
  }
  return { blocked, dependency };
}

export async function assertBlockerTarget(
  client: DbClient,
  organizationId: string,
  projectId: string,
  targetType: string,
  targetId: string,
): Promise<void> {
  let result;
  if (targetType === "project") {
    if (targetId !== projectId) throw conflict("Invalid blocker target.");
    return;
  }
  if (targetType === "workstream") {
    result = await client.query(
      "SELECT 1 FROM workstreams WHERE organization_id = $1 AND project_id = $2 AND id = $3 AND archived_at IS NULL",
      [organizationId, projectId, targetId],
    );
  } else if (targetType === "work_item") {
    result = await client.query(
      "SELECT 1 FROM work_items WHERE organization_id = $1 AND project_id = $2 AND id = $3 AND archived_at IS NULL",
      [organizationId, projectId, targetId],
    );
  } else {
    // Requirement targets become valid when the Location Pursuit module owns
    // their persistence. Until then, accepting an unvalidated UUID would create
    // a dangling blocker and is deliberately rejected.
    throw conflict("Invalid blocker target.");
  }
  if (result.rows.length === 0) throw conflict("Invalid blocker target.");
}
