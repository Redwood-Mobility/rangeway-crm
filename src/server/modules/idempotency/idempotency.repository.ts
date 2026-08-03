import type { QueryResultRow } from "pg";
import type { DbClient } from "../../platform/db/client.js";
import { ApiError } from "../../platform/http/api-error.js";

export interface IdempotencyInput {
  organizationId: string;
  actorId: string;
  operation: string;
  key: string;
  requestHash: string;
  requestId: string;
}

export type IdempotencyClaim =
  | { kind: "claimed" }
  | { kind: "replay"; responseBody: Record<string, unknown> };

interface StoredIdempotencyRow extends QueryResultRow {
  request_hash: string;
  response_body: Record<string, unknown> | null;
  completed_at: Date | null;
}

function unexpectedState(): ApiError {
  return new ApiError(500, "INTERNAL_ERROR", "Unexpected server error.");
}

export async function claimIdempotencyKey(
  input: IdempotencyInput,
  client: DbClient,
): Promise<IdempotencyClaim> {
  const inserted = await client.query(
    `INSERT INTO api_idempotency_keys
       (organization_id, actor_id, operation, idempotency_key, request_hash, request_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (organization_id, actor_id, operation, idempotency_key)
     DO NOTHING
     RETURNING request_id`,
    [
      input.organizationId,
      input.actorId,
      input.operation,
      input.key,
      input.requestHash,
      input.requestId,
    ],
  );
  if (inserted.rows.length === 1) return { kind: "claimed" };

  const existing = await client.query<StoredIdempotencyRow>(
    `SELECT request_hash, response_body, completed_at
       FROM api_idempotency_keys
      WHERE organization_id = $1
        AND actor_id = $2
        AND operation = $3
        AND idempotency_key = $4
      FOR UPDATE`,
    [input.organizationId, input.actorId, input.operation, input.key],
  );
  const record = existing.rows[0];
  if (!record) throw unexpectedState();
  if (record.request_hash !== input.requestHash) {
    throw new ApiError(
      409,
      "CONFLICT",
      "Idempotency key was already used with a different request.",
    );
  }
  if (!record.response_body || !record.completed_at) throw unexpectedState();
  return { kind: "replay", responseBody: record.response_body };
}

export async function completeIdempotencyKey(
  input: IdempotencyInput,
  responseBody: Record<string, unknown>,
  client: DbClient,
): Promise<void> {
  const completed = await client.query(
    `UPDATE api_idempotency_keys
        SET response_body = $6,
            completed_at = now()
      WHERE organization_id = $1
        AND actor_id = $2
        AND operation = $3
        AND idempotency_key = $4
        AND request_hash = $5
        AND completed_at IS NULL
      RETURNING idempotency_key`,
    [
      input.organizationId,
      input.actorId,
      input.operation,
      input.key,
      input.requestHash,
      responseBody,
    ],
  );
  if (completed.rows.length !== 1) throw unexpectedState();
}
