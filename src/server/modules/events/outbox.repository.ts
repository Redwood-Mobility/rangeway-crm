import type { DbClient } from "../../platform/db/client.js";

export interface OutboxInput {
  organizationId: string;
  actorId: string;
  requestId: string;
  eventType: `${string}.v${number}`;
  aggregateType: string;
  aggregateId: string;
  schemaVersion: number;
  payload: Record<string, unknown>;
}

export async function enqueueEvent(
  input: OutboxInput,
  client: DbClient,
): Promise<void> {
  await client.query(
    `INSERT INTO outbox_events
       (organization_id, actor_id, request_id, event_type, aggregate_type,
        aggregate_id, schema_version, payload)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      input.organizationId,
      input.actorId,
      input.requestId,
      input.eventType,
      input.aggregateType,
      input.aggregateId,
      input.schemaVersion,
      input.payload,
    ],
  );
}
