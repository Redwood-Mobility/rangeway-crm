import { createHash } from "node:crypto";
import type { Pool } from "pg";
import type { ActorContext } from "../../../shared/identity.js";
import { atlasEventTypes } from "../../../shared/events.js";
import { ApiError } from "../../platform/http/api-error.js";
import { mutateIdempotentlyWithAuditAndEvent } from "../events/outbox.service.js";
import { assertMinimumRole } from "../identity/identity.service.js";

export interface OrganizationSummary {
  id: string;
  name: string;
}

export interface OrganizationMutationPort {
  rename(
    actor: ActorContext,
    organizationId: string,
    name: string,
    idempotencyKey: string,
  ): Promise<OrganizationSummary>;
}

function notFound(): ApiError {
  return new ApiError(404, "NOT_FOUND", "Resource not found.");
}

export class OrganizationService implements OrganizationMutationPort {
  constructor(private readonly pool: Pool) {}

  async rename(
    actor: ActorContext,
    organizationId: string,
    name: string,
    idempotencyKey: string,
  ): Promise<OrganizationSummary> {
    if (organizationId !== actor.organizationId) throw notFound();
    assertMinimumRole(actor.role, "admin");

    const requestHash = createHash("sha256")
      .update(JSON.stringify({ name, organizationId }))
      .digest("hex");
    return mutateIdempotentlyWithAuditAndEvent(
      this.pool,
      actor,
      {
        operation: "organization.rename.v1",
        key: idempotencyKey,
        requestHash,
      },
      async (client) => {
        const existing = await client.query<{ id: string; name: string }>(
          `SELECT id, name
             FROM organizations
            WHERE id = $1
              AND id = $2
              AND archived_at IS NULL
            FOR UPDATE`,
          [organizationId, actor.organizationId],
        );
        const before = existing.rows[0];
        if (!before) throw notFound();

        const updated = await client.query<{ id: string; name: string }>(
          `UPDATE organizations
              SET name = $1,
                  updated_at = now()
            WHERE id = $2
              AND id = $3
              AND archived_at IS NULL
          RETURNING id, name`,
          [name, organizationId, actor.organizationId],
        );
        const organization = updated.rows[0];
        if (!organization) throw notFound();

        return {
          value: organization,
          audit: {
            organizationId: actor.organizationId,
            actorId: actor.actorId,
            requestId: actor.requestId,
            action: "organization.updated",
            resourceType: "organization",
            resourceId: organization.id,
            before: { name: before.name },
            after: { name: organization.name },
          },
          event: {
            organizationId: actor.organizationId,
            actorId: actor.actorId,
            requestId: actor.requestId,
            eventType: atlasEventTypes.organizationUpdated,
            aggregateType: "organization",
            aggregateId: organization.id,
            schemaVersion: 1,
            payload: {
              organizationId: organization.id,
              name: organization.name,
            },
          },
        };
      },
    );
  }
}
