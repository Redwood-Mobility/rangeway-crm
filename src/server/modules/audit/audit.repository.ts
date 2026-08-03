import type { DbClient } from "../../platform/db/client.js";

export interface AuditInput {
  organizationId: string;
  actorId: string;
  requestId: string;
  action: string;
  resourceType: string;
  resourceId: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  metadata?: Record<string, unknown>;
}

export async function recordAudit(
  input: AuditInput,
  client: DbClient,
): Promise<void> {
  await client.query(
    `INSERT INTO audit_events
       (organization_id, actor_id, request_id, action, resource_type, resource_id,
        before, after, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      input.organizationId,
      input.actorId,
      input.requestId,
      input.action,
      input.resourceType,
      input.resourceId,
      input.before,
      input.after,
      input.metadata ?? {},
    ],
  );
}
