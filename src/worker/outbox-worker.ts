import { randomUUID } from "node:crypto";
import type { Pool, QueryResultRow } from "pg";
import {
  withTransaction,
  type DbClient,
} from "../server/platform/db/client.js";

const maximumBatchSize = 25;
const maximumAttempts = 10;
const maximumErrorLength = 2_000;
const maximumRetryDelayMs = 15 * 60_000;

interface OutboxEventRow extends QueryResultRow {
  id: string;
  organization_id: string;
  actor_id: string;
  request_id: string;
  event_type: string;
  aggregate_type: string;
  aggregate_id: string;
  schema_version: number;
  payload: Record<string, unknown>;
  available_at: Date;
  attempt_count: number;
  processing_started_at: Date | null;
  processing_token: string | null;
  published_at: Date | null;
  terminal_at: Date | null;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface OutboxEvent {
  id: string;
  organizationId: string;
  actorId: string;
  requestId: string;
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  schemaVersion: number;
  payload: Record<string, unknown>;
  availableAt: Date;
  attemptCount: number;
  processingStartedAt: Date;
  processingToken: string;
  createdAt: Date;
}

export interface OutboxHandlerContext {
  idempotencyKey: string;
}

export type OutboxHandler = (
  event: OutboxEvent,
  context: OutboxHandlerContext,
) => Promise<void>;

export type VersionedEventType = `${string}.v${number}`;
export type OutboxHandlerRegistry = Readonly<
  Partial<Record<VersionedEventType, OutboxHandler>>
>;

export interface OutboxWorkerOptions {
  pool: Pool;
  handlers: OutboxHandlerRegistry;
  clock?: () => Date;
  createToken?: () => string;
}

export function calculateRetryDelayMs(attempts: number): number {
  return Math.min(2 ** attempts * 5_000, maximumRetryDelayMs);
}

function toEvent(
  row: OutboxEventRow,
  processingStartedAt: Date,
  processingToken: string,
): OutboxEvent {
  return {
    id: row.id,
    organizationId: row.organization_id,
    actorId: row.actor_id,
    requestId: row.request_id,
    eventType: row.event_type,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    schemaVersion: row.schema_version,
    payload: row.payload,
    availableAt: row.available_at,
    attemptCount: row.attempt_count,
    processingStartedAt,
    processingToken,
    createdAt: row.created_at,
  };
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, maximumErrorLength);
}

async function withClient<T>(
  pool: Pool,
  operation: (client: DbClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    return await operation(client);
  } finally {
    client.release();
  }
}

export class OutboxWorker {
  private readonly pool: Pool;
  private readonly handlers: OutboxHandlerRegistry;
  private readonly clock: () => Date;
  private readonly createToken: () => string;
  private acceptingClaims = true;
  private currentBatch: Promise<number> | null = null;
  private wakePoll: (() => void) | null = null;

  constructor(options: OutboxWorkerOptions) {
    this.pool = options.pool;
    this.handlers = options.handlers;
    this.clock = options.clock ?? (() => new Date());
    this.createToken = options.createToken ?? randomUUID;
  }

  runOnce(): Promise<number> {
    if (!this.acceptingClaims) return Promise.resolve(0);

    const batch = this.claimAndProcess();
    this.currentBatch = batch;
    return batch.finally(() => {
      if (this.currentBatch === batch) this.currentBatch = null;
    });
  }

  async run(pollMilliseconds: number): Promise<void> {
    while (this.acceptingClaims) {
      await this.runOnce();
      if (this.acceptingClaims) await this.waitForNextPoll(pollMilliseconds);
    }
  }

  stopClaiming(): void {
    this.acceptingClaims = false;
    this.wakePoll?.();
  }

  async waitForCurrentBatch(timeoutMilliseconds: number): Promise<void> {
    const batch = this.currentBatch;
    if (!batch) return;

    let timeout: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        batch.then(() => undefined),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(
            () => reject(new Error("Outbox worker shutdown timed out.")),
            timeoutMilliseconds,
          );
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  private async claimAndProcess(): Promise<number> {
    const events = await this.claimBatch();
    await Promise.all(events.map((event) => this.processEvent(event)));
    return events.length;
  }

  private async claimBatch(): Promise<OutboxEvent[]> {
    return withTransaction(this.pool, async (client) => {
      const result = await client.query<OutboxEventRow>(
        `SELECT *
         FROM outbox_events
         WHERE published_at IS NULL
           AND terminal_at IS NULL
           AND available_at <= now()
           AND (processing_started_at IS NULL OR processing_started_at < now() - interval '5 minutes')
         ORDER BY available_at, created_at
         FOR UPDATE SKIP LOCKED
         LIMIT $1`,
        [maximumBatchSize],
      );

      const processingStartedAt = this.clock();
      const claimed: OutboxEvent[] = [];
      for (const row of result.rows) {
        const processingToken = this.createToken();
        const updated = await client.query(
          `UPDATE outbox_events
              SET processing_started_at = $1,
                  processing_token = $2,
                  updated_at = $1
            WHERE id = $3
              AND published_at IS NULL
              AND terminal_at IS NULL`,
          [processingStartedAt, processingToken, row.id],
        );
        if (updated.rowCount === 1) {
          claimed.push(toEvent(row, processingStartedAt, processingToken));
        }
      }
      return claimed;
    });
  }

  private async processEvent(event: OutboxEvent): Promise<void> {
    try {
      if (!Object.hasOwn(this.handlers, event.eventType)) {
        throw new Error(`No handler registered for ${event.eventType}.`);
      }
      const handler = this.handlers[event.eventType as VersionedEventType];
      if (!handler) throw new Error(`No handler registered for ${event.eventType}.`);
      await handler(event, { idempotencyKey: event.id });
      await this.complete(event);
    } catch (error) {
      await this.fail(event, error);
    }
  }

  private async complete(event: OutboxEvent): Promise<void> {
    const completedAt = this.clock();
    await withClient(this.pool, async (client) => {
      await client.query(
        `UPDATE outbox_events
            SET published_at = $3,
                processing_started_at = NULL,
                processing_token = NULL,
                last_error = NULL,
                updated_at = $3
          WHERE id = $1
            AND processing_token = $2
            AND published_at IS NULL
            AND terminal_at IS NULL`,
        [event.id, event.processingToken, completedAt],
      );
    });
  }

  private async fail(event: OutboxEvent, error: unknown): Promise<void> {
    const failedAt = this.clock();
    const attempts = event.attemptCount + 1;
    const terminalAt = attempts >= maximumAttempts ? failedAt : null;
    const availableAt = new Date(failedAt.getTime() + calculateRetryDelayMs(attempts));

    await withClient(this.pool, async (client) => {
      await client.query(
        `UPDATE outbox_events
            SET attempt_count = attempt_count + 1,
                last_error = $3,
                available_at = $4,
                terminal_at = $5,
                processing_started_at = NULL,
                processing_token = NULL,
                updated_at = $6
          WHERE id = $1
            AND processing_token = $2
            AND published_at IS NULL
            AND terminal_at IS NULL`,
        [
          event.id,
          event.processingToken,
          errorMessage(error),
          availableAt,
          terminalAt,
          failedAt,
        ],
      );
    });
  }

  private waitForNextPoll(milliseconds: number): Promise<void> {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.wakePoll = null;
        resolve();
      }, milliseconds);
      this.wakePoll = () => {
        clearTimeout(timeout);
        this.wakePoll = null;
        resolve();
      };
    });
  }
}
