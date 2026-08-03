import type { Pool } from "pg";
import type { ActorContext } from "../../../shared/identity.js";
import type { AuditInput } from "../audit/audit.repository.js";
import { recordAudit } from "../audit/audit.repository.js";
import {
  enqueueEvent,
  type OutboxInput,
} from "./outbox.repository.js";
import {
  withTransaction,
  type DbClient,
} from "../../platform/db/client.js";
import { ApiError } from "../../platform/http/api-error.js";

export interface MutationResult<T> {
  value: T;
  audit: AuditInput;
  event: OutboxInput;
}

export type BusinessMutation<T> = (
  client: DbClient,
) => Promise<MutationResult<T>>;

export type TestOnlyPrecommitHook = (
  client: DbClient,
) => void | Promise<void>;

function assertConsistentAttribution(
  actor: ActorContext,
  audit: AuditInput,
  event: OutboxInput,
): void {
  const organizationsMatch =
    audit.organizationId === actor.organizationId &&
    event.organizationId === actor.organizationId;
  const actorsMatch =
    audit.actorId === actor.actorId && event.actorId === actor.actorId;
  const requestsMatch =
    audit.requestId === actor.requestId && event.requestId === actor.requestId;

  if (!organizationsMatch || !actorsMatch || !requestsMatch) {
    throw new ApiError(500, "INTERNAL_ERROR", "Unexpected server error.");
  }
}

export async function mutateWithAuditAndEvent<T>(
  pool: Pool,
  actor: ActorContext,
  mutate: BusinessMutation<T>,
  testOnlyPrecommitHook?: TestOnlyPrecommitHook,
): Promise<T> {
  return withTransaction(pool, async (client) => {
    const result = await mutate(client);
    assertConsistentAttribution(actor, result.audit, result.event);
    await recordAudit(result.audit, client);
    await enqueueEvent(result.event, client);
    await testOnlyPrecommitHook?.(client);
    return result.value;
  });
}
