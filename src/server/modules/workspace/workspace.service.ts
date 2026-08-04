import { createHash, randomUUID } from "node:crypto";
import type { Pool, QueryResultRow } from "pg";
import type { ActorContext } from "../../../shared/identity.js";
import { atlasEventTypes } from "../../../shared/events.js";
import { ApiError } from "../../platform/http/api-error.js";
import type { DbClient } from "../../platform/db/client.js";
import { mutateIdempotentlyWithAuditAndEvent } from "../events/outbox.service.js";

type Input = Record<string, unknown>;
type Result = Record<string, unknown>;
type Row = QueryResultRow & Record<string, unknown>;

function camelize(row: Row): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase()),
      value instanceof Date ? value.toISOString() : value,
    ]),
  );
}

const notFound = () => new ApiError(404, "NOT_FOUND", "Resource not found.");
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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

/** One Gmail thread, Drive file or Calendar event as returned by the provider. */
export interface GoogleFixture {
  threads?: Array<{
    providerThreadId: string;
    subject: string;
    snippet: string;
    participantEmails: string[];
    labelIds: string[];
    lastMessageAt: string;
    messages: Array<{
      providerMessageId: string;
      fromEmail: string;
      toEmails: string[];
      subject: string;
      bodyText: string;
      sentAt: string;
      attachments?: unknown[];
    }>;
  }>;
  driveItems?: Array<{
    providerFileId: string;
    name: string;
    mimeType: string;
    webViewLink: string;
    modifiedAt: string;
    permissions?: unknown[];
  }>;
  calendarEvents?: Array<{
    providerEventId: string;
    /** Google's recurring event ID, or the event ID for a one-off. */
    seriesKey?: string;
    calendarId: string;
    summary: string;
    description?: string;
    location?: string;
    startsAt: string;
    endsAt: string;
    timeZone: string;
    attendees?: unknown[];
  }>;
  gmailHistoryId?: string;
  drivePageToken?: string;
  calendarSyncToken?: string;
  /** Anything the sync could not complete, surfaced instead of swallowed. */
  warnings?: string[];
}

/**
 * The provider boundary. Tests supply recorded fixtures so nothing in CI needs a
 * live mailbox; production supplies a real Google client.
 */
export interface GoogleGateway {
  fetchIncremental(input: {
    credentialReference: string;
    gmailHistoryId: string;
    drivePageToken: string;
    calendarSyncToken: string;
  }): Promise<GoogleFixture>;
}

/**
 * The live client needs to know whose credential it is using, which is only
 * known per request, so the service resolves a gateway per sync rather than
 * holding one. Tests pass a plain gateway and it is used as-is.
 */
export type GoogleGatewayResolver =
  | GoogleGateway
  | ((context: { organizationId: string; ownerUserId: string }) => GoogleGateway);

export class RecordedGoogleGateway implements GoogleGateway {
  constructor(private readonly fixture: GoogleFixture) {}
  async fetchIncremental(): Promise<GoogleFixture> {
    return this.fixture;
  }
}

export interface WorkspacePort {
  query(actor: ActorContext, operation: string, input: Input): Promise<Result>;
  mutate(actor: ActorContext, operation: string, input: Input, key: string): Promise<Result>;
}

export class WorkspaceService implements WorkspacePort {
  constructor(
    private readonly pool: Pool,
    private readonly gateway?: GoogleGatewayResolver,
  ) {}

  private resolveGateway(organizationId: string, ownerUserId: string): GoogleGateway | undefined {
    if (!this.gateway) return undefined;
    return typeof this.gateway === "function"
      ? this.gateway({ organizationId, ownerUserId })
      : this.gateway;
  }

  async query(actor: ActorContext, operation: string, input: Input): Promise<Result> {
    switch (operation) {
      case "workspace.connections":
        return this.listConnections(actor);
      case "workspace.search":
        return this.search(actor, input);
      case "workspace.suggestions":
        return this.listSuggestions(actor);
      case "workspace.shares":
        return this.listShares(actor, input);
      case "workspace.calendar":
        return this.listCalendar(actor, input);
      default:
        throw notFound();
    }
  }

  async mutate(actor: ActorContext, operation: string, input: Input, key: string): Promise<Result> {
    // Fetching from Google happens before the transaction opens. Network I/O
    // inside a transaction would hold row locks across a remote call, and a
    // failure could not record that the connection needs reconnecting because
    // its own write would roll back with it.
    const enriched = operation === "workspace.sync" ? await this.prefetchSync(actor, input) : input;
    return mutateIdempotentlyWithAuditAndEvent(
      this.pool,
      actor,
      { operation: `${operation}.v1`, key, requestHash: requestHash(operation, input) },
      (client) => this.performMutation(client, actor, operation, enriched),
    );
  }

  private async prefetchSync(actor: ActorContext, input: Input): Promise<Input> {
    const userId = this.requireUser(actor);
    const connectionId = requiredId(input, "connectionId");
    const connectionResult = await this.pool.query<Row>(
      `SELECT * FROM google_connections
        WHERE organization_id = $1 AND id = $2 AND owner_user_id = $3`,
      [actor.organizationId, connectionId, userId],
    );
    const connection = connectionResult.rows[0];
    if (!connection) throw notFound();
    if (connection.status === "revoked" || connection.disconnected_at) {
      throw new ApiError(409, "CONFLICT", "That connection is disconnected.");
    }
    const gateway = this.resolveGateway(actor.organizationId, userId);
    if (!gateway) {
      throw new ApiError(503, "SERVICE_UNAVAILABLE", "No Google gateway is configured.");
    }

    try {
      const fixture = await gateway.fetchIncremental({
        credentialReference: String(connection.credential_reference),
        gmailHistoryId: String(connection.gmail_history_id),
        drivePageToken: String(connection.drive_page_token),
        calendarSyncToken: String(connection.calendar_sync_token),
      });
      return { ...input, fixture };
    } catch (error) {
      // Only this owner's connection pauses; everyone else keeps syncing.
      await this.pool.query(
        `UPDATE google_connections
            SET status = 'expired', last_error = $3, updated_at = now()
          WHERE organization_id = $1 AND id = $2`,
        [actor.organizationId, connectionId, error instanceof Error ? error.message : "sync failed"],
      );
      throw new ApiError(409, "CONFLICT", "Google authorization needs to be renewed.");
    }
  }

  private async performMutation(
    client: DbClient,
    actor: ActorContext,
    operation: string,
    input: Input,
  ) {
    switch (operation) {
      case "workspace.connect":
        return this.connect(client, actor, input);
      case "workspace.disconnect":
        return this.disconnect(client, actor, input);
      case "workspace.sync":
        return this.sync(client, actor, input);
      case "workspace.share":
        return this.share(client, actor, input);
      case "workspace.share.revoke":
        return this.revokeShare(client, actor, input);
      case "workspace.suggestion.review":
        return this.reviewSuggestion(client, actor, input);
      default:
        throw notFound();
    }
  }

  private requireUser(actor: ActorContext): string {
    if (!actor.userId) {
      throw new ApiError(403, "FORBIDDEN", "A Workspace connection belongs to a person.");
    }
    return actor.userId;
  }

  // ----------------------------------------------------------- connections --

  private async connect(client: DbClient, actor: ActorContext, input: Input) {
    const userId = this.requireUser(actor);
    const id = randomUUID();
    const result = await client.query<Row>(
      `INSERT INTO google_connections
         (id, organization_id, owner_user_id, google_email, scopes, credential_reference)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (organization_id, owner_user_id, google_email)
       DO UPDATE SET scopes = EXCLUDED.scopes,
                     credential_reference = EXCLUDED.credential_reference,
                     status = 'connected', last_error = '', disconnected_at = NULL,
                     updated_at = now()
       RETURNING *`,
      [
        id,
        actor.organizationId,
        userId,
        input.googleEmail,
        input.scopes ?? [],
        input.credentialReference,
      ],
    );
    const connection = this.publicConnection(result.rows[0]);
    return this.record(actor, "workspace.connected", "google_connection", String(result.rows[0].id), { connection }, null, connection);
  }

  private async disconnect(client: DbClient, actor: ActorContext, input: Input) {
    const userId = this.requireUser(actor);
    const connectionId = requiredId(input, "connectionId");
    const before = await client.query<Row>(
      `SELECT * FROM google_connections
        WHERE organization_id = $1 AND id = $2 AND owner_user_id = $3 FOR UPDATE`,
      [actor.organizationId, connectionId, userId],
    );
    if (!before.rows[0]) throw notFound();
    const result = await client.query<Row>(
      `UPDATE google_connections
          SET status = 'revoked', disconnected_at = now(), credential_reference = 'revoked',
              updated_at = now()
        WHERE organization_id = $1 AND id = $2 RETURNING *`,
      [actor.organizationId, connectionId],
    );
    const connection = this.publicConnection(result.rows[0]);
    return this.record(actor, "workspace.disconnected", "google_connection", connectionId, { connection }, this.publicConnection(before.rows[0]), connection);
  }

  /** The credential reference is never returned to a client. */
  private publicConnection(row: Row): Record<string, unknown> {
    const { credential_reference, ...rest } = row;
    void credential_reference;
    return camelize(rest as Row);
  }

  private async listConnections(actor: ActorContext): Promise<Result> {
    const userId = this.requireUser(actor);
    // A connection is listed only to the person who owns it.
    const result = await this.pool.query<Row>(
      `SELECT * FROM google_connections
        WHERE organization_id = $1 AND owner_user_id = $2
        ORDER BY created_at DESC`,
      [actor.organizationId, userId],
    );
    return { connections: result.rows.map((row) => this.publicConnection(row)) };
  }

  // ------------------------------------------------------------------ sync --

  private async sync(client: DbClient, actor: ActorContext, input: Input) {
    const userId = this.requireUser(actor);
    const connectionId = requiredId(input, "connectionId");
    const connectionResult = await client.query<Row>(
      `SELECT * FROM google_connections
        WHERE organization_id = $1 AND id = $2 AND owner_user_id = $3 FOR UPDATE`,
      [actor.organizationId, connectionId, userId],
    );
    if (!connectionResult.rows[0]) throw notFound();
    const fixture = input.fixture as GoogleFixture;

    let threads = 0;
    let messages = 0;
    for (const thread of fixture.threads ?? []) {
      const threadResult = await client.query<Row>(
        `INSERT INTO gmail_threads
           (id, organization_id, connection_id, owner_user_id, provider_thread_id,
            subject, snippet, participant_emails, label_ids, message_count, last_message_at)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (organization_id, connection_id, provider_thread_id)
         DO UPDATE SET subject = EXCLUDED.subject, snippet = EXCLUDED.snippet,
                       participant_emails = EXCLUDED.participant_emails,
                       label_ids = EXCLUDED.label_ids,
                       message_count = EXCLUDED.message_count,
                       last_message_at = EXCLUDED.last_message_at,
                       indexed_at = now()
         RETURNING id`,
        [
          actor.organizationId,
          connectionId,
          userId,
          thread.providerThreadId,
          thread.subject,
          thread.snippet,
          thread.participantEmails,
          thread.labelIds,
          thread.messages.length,
          thread.lastMessageAt,
        ],
      );
      threads += 1;
      const threadId = String(threadResult.rows[0].id);
      for (const message of thread.messages) {
        await client.query(
          `INSERT INTO gmail_messages
             (id, organization_id, thread_id, owner_user_id, provider_message_id,
              from_email, to_emails, subject, body_text, sent_at, attachments)
           VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           ON CONFLICT (organization_id, thread_id, provider_message_id)
           DO UPDATE SET body_text = EXCLUDED.body_text, subject = EXCLUDED.subject,
                         sent_at = EXCLUDED.sent_at, attachments = EXCLUDED.attachments`,
          [
            actor.organizationId,
            threadId,
            userId,
            message.providerMessageId,
            message.fromEmail,
            message.toEmails,
            message.subject,
            message.bodyText,
            message.sentAt,
            JSON.stringify(message.attachments ?? []),
          ],
        );
        messages += 1;
      }
    }

    let driveItems = 0;
    for (const item of fixture.driveItems ?? []) {
      await client.query(
        `INSERT INTO drive_items
           (id, organization_id, connection_id, owner_user_id, provider_file_id,
            name, mime_type, web_view_link, modified_at, permissions)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (organization_id, connection_id, provider_file_id)
         DO UPDATE SET name = EXCLUDED.name, mime_type = EXCLUDED.mime_type,
                       web_view_link = EXCLUDED.web_view_link,
                       modified_at = EXCLUDED.modified_at,
                       permissions = EXCLUDED.permissions, indexed_at = now()`,
        [
          actor.organizationId,
          connectionId,
          userId,
          item.providerFileId,
          item.name,
          item.mimeType,
          item.webViewLink,
          item.modifiedAt,
          JSON.stringify(item.permissions ?? []),
        ],
      );
      driveItems += 1;
    }

    let events = 0;
    for (const event of fixture.calendarEvents ?? []) {
      await client.query(
        // Keyed on the series so a recurring event stays one row and moves to
        // its nearest occurrence, rather than accumulating one row per day.
        `INSERT INTO calendar_events
           (id, organization_id, connection_id, owner_user_id, provider_event_id, series_key,
            calendar_id, summary, description, location, starts_at, ends_at, time_zone, attendees)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         ON CONFLICT (organization_id, connection_id, series_key)
         DO UPDATE SET provider_event_id = EXCLUDED.provider_event_id,
                       summary = EXCLUDED.summary, description = EXCLUDED.description,
                       location = EXCLUDED.location, starts_at = EXCLUDED.starts_at,
                       ends_at = EXCLUDED.ends_at, time_zone = EXCLUDED.time_zone,
                       attendees = EXCLUDED.attendees, indexed_at = now()`,
        [
          actor.organizationId,
          connectionId,
          userId,
          event.providerEventId,
          event.seriesKey || event.providerEventId,
          event.calendarId,
          event.summary,
          event.description ?? "",
          event.location ?? "",
          event.startsAt,
          event.endsAt,
          event.timeZone,
          JSON.stringify(event.attendees ?? []),
        ],
      );
      events += 1;
    }

    await client.query(
      `UPDATE google_connections
          SET gmail_history_id = COALESCE(NULLIF($3, ''), gmail_history_id),
              drive_page_token = COALESCE(NULLIF($4, ''), drive_page_token),
              calendar_sync_token = COALESCE(NULLIF($5, ''), calendar_sync_token),
              last_synced_at = now(), status = 'connected', last_error = '', updated_at = now()
        WHERE organization_id = $1 AND id = $2`,
      [
        actor.organizationId,
        connectionId,
        fixture.gmailHistoryId ?? "",
        fixture.drivePageToken ?? "",
        fixture.calendarSyncToken ?? "",
      ],
    );

    // Warnings ride along with the counts. A partial sync that reports only
    // totals reads as a complete one.
    const summary = { threads, messages, driveItems, events, warnings: fixture.warnings ?? [] };
    return this.record(actor, "workspace.synced", "google_connection", connectionId, { summary }, null, summary);
  }

  // ---------------------------------------------------------------- search --

  /**
   * Permission filtering happens in SQL, before ranking or snippets, so nothing
   * belonging to another person can reach the response at all.
   */
  private async search(actor: ActorContext, input: Input): Promise<Result> {
    const userId = actor.userId;
    if (!userId) return { results: [] };
    const query = `%${String(input.q ?? "").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
    const limit = Number(input.limit ?? 25);

    const result = await this.pool.query<Row>(
      `WITH owned AS (
         SELECT 'gmail_thread'::google_source_kind AS kind, t.id, t.subject AS title,
                t.snippet AS summary, t.last_message_at AS occurred_at
           FROM gmail_threads t
          WHERE t.organization_id = $1 AND t.owner_user_id = $2
            AND (t.subject ILIKE $3 ESCAPE '\\' OR t.snippet ILIKE $3 ESCAPE '\\')
         UNION ALL
         SELECT 'drive_item', d.id, d.name, d.mime_type, d.modified_at
           FROM drive_items d
          WHERE d.organization_id = $1 AND d.owner_user_id = $2 AND d.name ILIKE $3 ESCAPE '\\'
         UNION ALL
         SELECT 'calendar_event', c.id, c.summary, c.location, c.starts_at
           FROM calendar_events c
          WHERE c.organization_id = $1 AND c.owner_user_id = $2
            AND (c.summary ILIKE $3 ESCAPE '\\' OR c.description ILIKE $3 ESCAPE '\\')
       ),
       ranked AS (
         SELECT *, row_number() OVER (PARTITION BY kind ORDER BY occurred_at DESC NULLS LAST) AS rank
           FROM owned
       )
       -- Limited per source. A single global limit ordered by date let the
       -- busiest source consume every slot and hide the other two entirely.
       SELECT kind, id, title, summary, occurred_at FROM ranked
        WHERE rank <= $4
        ORDER BY occurred_at DESC NULLS LAST`,
      [actor.organizationId, userId, query, limit],
    );
    return { results: result.rows.map(camelize) };
  }

  private async listSuggestions(actor: ActorContext): Promise<Result> {
    const userId = this.requireUser(actor);
    const result = await this.pool.query<Row>(
      `SELECT * FROM workspace_suggestions
        WHERE organization_id = $1 AND owner_user_id = $2 AND review_state = 'pending'
        ORDER BY confidence DESC, created_at DESC LIMIT 100`,
      [actor.organizationId, userId],
    );
    return { suggestions: result.rows.map(camelize) };
  }

  private async listCalendar(actor: ActorContext, input: Input): Promise<Result> {
    const userId = actor.userId;
    if (!userId) return { events: [] };
    const result = await this.pool.query<Row>(
      `SELECT * FROM calendar_events
        WHERE organization_id = $1 AND owner_user_id = $2
          AND ($3::timestamptz IS NULL OR starts_at >= $3::timestamptz)
          AND ($4::timestamptz IS NULL OR starts_at < $4::timestamptz)
        ORDER BY starts_at LIMIT 200`,
      [actor.organizationId, userId, input.from ?? null, input.to ?? null],
    );
    return { events: result.rows.map(camelize) };
  }

  // ---------------------------------------------------------------- shares --

  private async share(client: DbClient, actor: ActorContext, input: Input) {
    const userId = this.requireUser(actor);
    const projectId = requiredId(input, "projectId");
    const sourceId = requiredId(input, "sourceId");
    const sourceKind = String(input.sourceKind);

    const project = await client.query<Row>(
      `SELECT p.id FROM project_rooms p
        WHERE p.organization_id = $1 AND p.id = $2
          AND ($3::text IN ('owner','admin') OR p.owner_user_id = $4::uuid
               OR EXISTS (SELECT 1 FROM project_memberships pm
                           WHERE pm.organization_id = p.organization_id
                             AND pm.project_id = p.id AND pm.user_id = $4::uuid))`,
      [actor.organizationId, projectId, actor.role, userId],
    );
    if (!project.rows[0]) throw notFound();

    // Only the owner of the source may share it, and only the selected item.
    const source = await this.loadOwnedSource(client, actor, userId, sourceKind, sourceId);

    const id = randomUUID();
    const result = await client.query<Row>(
      `INSERT INTO workspace_shares
         (id, organization_id, project_id, source_kind, source_id, owner_user_id,
          title, summary, occurred_at, shared_by_actor_id)
       VALUES ($1, $2, $3, $4::google_source_kind, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (organization_id, project_id, source_kind, source_id)
       DO UPDATE SET revoked_at = NULL, title = EXCLUDED.title, summary = EXCLUDED.summary
       RETURNING *`,
      [
        id,
        actor.organizationId,
        projectId,
        sourceKind,
        sourceId,
        userId,
        source.title,
        source.summary,
        source.occurredAt,
        actor.actorId,
      ],
    );
    const share = camelize(result.rows[0]);
    return this.record(actor, "workspace.shared", "workspace_share", String(result.rows[0].id), { share }, null, share);
  }

  private async loadOwnedSource(
    client: DbClient,
    actor: ActorContext,
    userId: string,
    kind: string,
    sourceId: string,
  ): Promise<{ title: string; summary: string; occurredAt: string | null }> {
    const table =
      kind === "gmail_thread"
        ? "gmail_threads"
        : kind === "drive_item"
          ? "drive_items"
          : kind === "calendar_event"
            ? "calendar_events"
            : null;
    if (!table) throw new ApiError(400, "INVALID_INPUT", "Unsupported source kind.");

    const result = await client.query<Row>(
      `SELECT * FROM ${table} WHERE organization_id = $1 AND id = $2 AND owner_user_id = $3`,
      [actor.organizationId, sourceId, userId],
    );
    const row = result.rows[0];
    if (!row) throw notFound();

    if (kind === "gmail_thread") {
      return {
        title: String(row.subject),
        summary: String(row.snippet),
        occurredAt: row.last_message_at instanceof Date ? row.last_message_at.toISOString() : null,
      };
    }
    if (kind === "drive_item") {
      return {
        title: String(row.name),
        summary: String(row.web_view_link),
        occurredAt: row.modified_at instanceof Date ? row.modified_at.toISOString() : null,
      };
    }
    return {
      title: String(row.summary),
      summary: String(row.location),
      occurredAt: row.starts_at instanceof Date ? row.starts_at.toISOString() : null,
    };
  }

  private async revokeShare(client: DbClient, actor: ActorContext, input: Input) {
    const userId = this.requireUser(actor);
    const shareId = requiredId(input, "shareId");
    const result = await client.query<Row>(
      `UPDATE workspace_shares SET revoked_at = now()
        WHERE organization_id = $1 AND id = $2 AND owner_user_id = $3 AND revoked_at IS NULL
        RETURNING *`,
      [actor.organizationId, shareId, userId],
    );
    if (!result.rows[0]) throw notFound();
    const share = camelize(result.rows[0]);
    return this.record(actor, "workspace.share-revoked", "workspace_share", shareId, { share }, null, share);
  }

  /** Shares are project-visible: any member of the project sees them. */
  private async listShares(actor: ActorContext, input: Input): Promise<Result> {
    const projectId = requiredId(input, "projectId");
    const project = await this.pool.query<Row>(
      `SELECT p.id FROM project_rooms p
        WHERE p.organization_id = $1 AND p.id = $2
          AND ($3::text IN ('owner','admin') OR p.owner_user_id = $4::uuid
               OR EXISTS (SELECT 1 FROM project_memberships pm
                           WHERE pm.organization_id = p.organization_id
                             AND pm.project_id = p.id AND pm.user_id = $4::uuid))`,
      [actor.organizationId, projectId, actor.role, actor.userId ?? null],
    );
    if (!project.rows[0]) throw notFound();

    const result = await this.pool.query<Row>(
      `SELECT s.*, u.display_name AS owner_display_name
         FROM workspace_shares s
         JOIN users u ON u.id = s.owner_user_id
        WHERE s.organization_id = $1 AND s.project_id = $2 AND s.revoked_at IS NULL
        ORDER BY s.occurred_at DESC NULLS LAST`,
      [actor.organizationId, projectId],
    );
    return { shares: result.rows.map(camelize) };
  }

  private async reviewSuggestion(client: DbClient, actor: ActorContext, input: Input) {
    const userId = this.requireUser(actor);
    const suggestionId = requiredId(input, "suggestionId");
    const state = String(input.reviewState);
    if (!["accepted", "rejected", "superseded"].includes(state)) {
      throw new ApiError(400, "INVALID_INPUT", "Unsupported review state.");
    }
    const result = await client.query<Row>(
      `UPDATE workspace_suggestions
          SET review_state = $4::suggestion_review_state,
              reviewed_by_actor_id = $5, reviewed_at = now()
        WHERE organization_id = $1 AND id = $2 AND owner_user_id = $3
          AND review_state = 'pending'
        RETURNING *`,
      [actor.organizationId, suggestionId, userId, state, actor.actorId],
    );
    if (!result.rows[0]) throw notFound();
    const suggestion = camelize(result.rows[0]);
    return this.record(actor, "workspace.suggestion-reviewed", "workspace_suggestion", suggestionId, { suggestion }, null, suggestion);
  }

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
        eventType: atlasEventTypes.workspaceChanged,
        aggregateType: resourceType,
        aggregateId: resourceId,
        schemaVersion: 1,
        // Private content never enters an event payload.
        payload: { operation, resourceId },
      },
    };
  }
}
