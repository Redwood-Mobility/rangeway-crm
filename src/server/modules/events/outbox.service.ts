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
import {
  claimIdempotencyKey,
  completeIdempotencyKey,
  type IdempotencyInput,
} from "../idempotency/idempotency.repository.js";

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

export type MutationIdempotency = Omit<
  IdempotencyInput,
  "organizationId" | "actorId" | "requestId"
>;

export async function mutateIdempotentlyWithAuditAndEvent<
  T extends Record<string, unknown>,
>(
  pool: Pool,
  actor: ActorContext,
  idempotency: MutationIdempotency,
  mutate: BusinessMutation<T>,
  testOnlyPrecommitHook?: TestOnlyPrecommitHook,
): Promise<T> {
  return withTransaction(pool, async (client) => {
    const input: IdempotencyInput = {
      ...idempotency,
      organizationId: actor.organizationId,
      actorId: actor.actorId,
      requestId: actor.requestId,
    };
    const claim = await claimIdempotencyKey(input, client);
    if (claim.kind === "replay") return claim.responseBody as T;

    const result = await mutate(client);
    assertConsistentAttribution(actor, result.audit, result.event);
    await recordAudit(result.audit, client);
    await enqueueEvent(result.event, client);
    await completeIdempotencyKey(input, result.value, client);
    await testOnlyPrecommitHook?.(client);
    return result.value;
  });
}
