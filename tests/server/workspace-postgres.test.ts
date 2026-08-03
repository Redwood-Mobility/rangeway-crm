import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { describe, expect, it, type TestContext } from "vitest";
import type { ActorContext } from "../../src/shared/identity.js";
import { OperatingCoreService } from "../../src/server/modules/operating-core/operating-core.service.js";
import {
  RecordedGoogleGateway,
  WorkspaceService,
  type GoogleFixture,
} from "../../src/server/modules/workspace/workspace.service.js";
import { createPool } from "../../src/server/platform/db/client.js";
import { runMigrations } from "../../src/server/platform/db/migrate.js";
import { createTemporaryDatabase, PostgreSqlUnavailableError } from "../helpers/database.js";

const organizationId = "00000000-0000-4000-8000-000000000001";
const key = (prefix: string) => `${prefix}-${randomUUID()}`;

async function withPostgreSql(
  context: TestContext,
  operation: (pool: Pool) => Promise<void>,
): Promise<void> {
  let database;
  try {
    database = await createTemporaryDatabase();
  } catch (error) {
    if (error instanceof PostgreSqlUnavailableError) {
      context.skip(`EQUIPPED_POSTGRESQL_SKIP: ${error.message}`);
      return;
    }
    throw error;
  }
  const pool = createPool(database.databaseUrl);
  try {
    await runMigrations(pool);
    await operation(pool);
  } finally {
    await pool.end();
    await database.cleanup();
  }
}

async function createActor(pool: Pool, role: "owner" | "member" = "member"): Promise<ActorContext> {
  const userId = randomUUID();
  const actorId = randomUUID();
  await pool.query("BEGIN");
  await pool.query("SET CONSTRAINTS ALL DEFERRED");
  await pool.query("INSERT INTO users (id, email, display_name) VALUES ($1, $2, 'Person')", [
    userId,
    `${userId}@rangeway.energy`,
  ]);
  await pool.query(
    `INSERT INTO actors (id, organization_id, type, role, user_id, display_name)
     VALUES ($1, $2, 'human', $3, $4, 'Person')`,
    [actorId, organizationId, role, userId],
  );
  await pool.query(
    "INSERT INTO organization_memberships (organization_id, user_id, role) VALUES ($1, $2, $3)",
    [organizationId, userId, role],
  );
  await pool.query("COMMIT");
  return {
    actorId,
    actorType: "human",
    actorName: "Person",
    organizationId,
    role,
    userId,
    requestId: randomUUID(),
  };
}

const fixture: GoogleFixture = {
  gmailHistoryId: "history-2",
  threads: [
    {
      providerThreadId: "thread-1",
      subject: "Mojave land option terms",
      snippet: "Confidential negotiation position",
      participantEmails: ["landowner@example.com"],
      labelIds: ["INBOX"],
      lastMessageAt: "2026-08-01T10:00:00.000Z",
      messages: [
        {
          providerMessageId: "message-1",
          fromEmail: "landowner@example.com",
          toEmails: ["zak@rangeway.energy"],
          subject: "Mojave land option terms",
          bodyText: "We can proceed at the discussed rate.",
          sentAt: "2026-08-01T10:00:00.000Z",
        },
      ],
    },
  ],
  driveItems: [
    {
      providerFileId: "file-1",
      name: "Mojave term sheet",
      mimeType: "application/pdf",
      webViewLink: "https://drive.example.com/file-1",
      modifiedAt: "2026-08-01T09:00:00.000Z",
    },
  ],
  calendarEvents: [
    {
      providerEventId: "event-1",
      calendarId: "primary",
      summary: "Hawaiʻi utility call",
      startsAt: "2026-08-05T19:00:00.000Z",
      endsAt: "2026-08-05T20:00:00.000Z",
      // Retained verbatim rather than normalized to the viewer's zone.
      timeZone: "Pacific/Honolulu",
    },
  ],
};

async function connectAndSync(pool: Pool, actor: ActorContext) {
  const workspace = new WorkspaceService(pool, new RecordedGoogleGateway(fixture));
  const connected = await workspace.mutate(
    actor,
    "workspace.connect",
    {
      googleEmail: `${actor.userId}@rangeway.energy`,
      scopes: ["gmail.readonly"],
      credentialReference: "secret-store://atlas/1",
    },
    key("connect"),
  );
  const connectionId = String((connected.connection as { id: string }).id);
  await workspace.mutate(actor, "workspace.sync", { connectionId }, key("sync"));
  return { workspace, connectionId };
}

describe("Google Workspace intelligence", () => {
  it("indexes threads, drive items and events against the owning user", async (context) => {
    await withPostgreSql(context, async (pool) => {
      const actor = await createActor(pool);
      await connectAndSync(pool, actor);

      const counts = await pool.query<{ threads: string; messages: string; drive: string; events: string }>(
        `SELECT (SELECT count(*)::text FROM gmail_threads) AS threads,
                (SELECT count(*)::text FROM gmail_messages) AS messages,
                (SELECT count(*)::text FROM drive_items) AS drive,
                (SELECT count(*)::text FROM calendar_events) AS events`,
      );
      expect(counts.rows[0]).toEqual({ threads: "1", messages: "1", drive: "1", events: "1" });

      const owner = await pool.query<{ owner_user_id: string }>(
        "SELECT owner_user_id FROM gmail_threads",
      );
      expect(owner.rows[0].owner_user_id).toBe(actor.userId);

      // The event keeps its own zone rather than the server's.
      const event = await pool.query<{ time_zone: string }>("SELECT time_zone FROM calendar_events");
      expect(event.rows[0].time_zone).toBe("Pacific/Honolulu");
    });
  });

  it("is incremental: a second sync updates rather than duplicates", async (context) => {
    await withPostgreSql(context, async (pool) => {
      const actor = await createActor(pool);
      const { workspace, connectionId } = await connectAndSync(pool, actor);
      await workspace.mutate(actor, "workspace.sync", { connectionId }, key("sync2"));

      const counts = await pool.query<{ threads: string; messages: string }>(
        `SELECT (SELECT count(*)::text FROM gmail_threads) AS threads,
                (SELECT count(*)::text FROM gmail_messages) AS messages`,
      );
      expect(counts.rows[0]).toEqual({ threads: "1", messages: "1" });
    });
  });

  it("keeps one person's mailbox invisible to another person and their search", async (context) => {
    await withPostgreSql(context, async (pool) => {
      const owner = await createActor(pool);
      const other = await createActor(pool);
      const administrator = await createActor(pool, "owner");
      await connectAndSync(pool, owner);

      const workspace = new WorkspaceService(pool, new RecordedGoogleGateway(fixture));

      const ownerResults = await workspace.query(owner, "workspace.search", { q: "Mojave" });
      expect((ownerResults.results as unknown[]).length).toBeGreaterThan(0);

      // Another member sees nothing of it — and neither does an organization
      // owner, because Workspace content is private to its person by default.
      for (const actor of [other, administrator]) {
        const results = await workspace.query(actor, "workspace.search", { q: "Mojave" });
        expect(results.results).toEqual([]);
        const connections = await workspace.query(actor, "workspace.connections", {});
        expect(connections.connections).toEqual([]);
      }
    });
  });

  it("never returns the credential reference to a caller", async (context) => {
    await withPostgreSql(context, async (pool) => {
      const actor = await createActor(pool);
      await connectAndSync(pool, actor);
      const workspace = new WorkspaceService(pool, new RecordedGoogleGateway(fixture));
      const listed = await workspace.query(actor, "workspace.connections", {});
      const serialized = JSON.stringify(listed);
      expect(serialized).not.toContain("secret-store://");
      expect(serialized).not.toContain("credentialReference");
    });
  });

  it("shares exactly one selected item into a project and nothing else", async (context) => {
    await withPostgreSql(context, async (pool) => {
      const owner = await createActor(pool, "owner");
      const teammate = await createActor(pool);
      await connectAndSync(pool, owner);

      const core = new OperatingCoreService(pool);
      const project = await core.mutate(
        owner,
        "project.create",
        { name: "Mojave", ownerUserId: owner.userId },
        key("project"),
      );
      const projectId = String((project.project as { id: string }).id);
      await core.mutate(
        owner,
        "project.members.add",
        { projectId, userId: teammate.userId, role: "editor" },
        key("member"),
      );

      const thread = await pool.query<{ id: string }>("SELECT id FROM gmail_threads");
      const driveItem = await pool.query<{ id: string }>("SELECT id FROM drive_items");

      const workspace = new WorkspaceService(pool, new RecordedGoogleGateway(fixture));
      await workspace.mutate(
        owner,
        "workspace.share",
        { projectId, sourceKind: "gmail_thread", sourceId: thread.rows[0].id },
        key("share"),
      );

      // The teammate sees the shared thread through the project...
      const shares = await workspace.query(teammate, "workspace.shares", { projectId });
      expect((shares.shares as Array<{ title: string }>).map((share) => share.title)).toEqual([
        "Mojave land option terms",
      ]);

      // ...but the mailbox itself, and the unshared Drive item, stay private.
      const teammateSearch = await workspace.query(teammate, "workspace.search", { q: "Mojave" });
      expect(teammateSearch.results).toEqual([]);

      await expect(
        workspace.mutate(
          teammate,
          "workspace.share",
          { projectId, sourceKind: "drive_item", sourceId: driveItem.rows[0].id },
          key("share2"),
        ),
      ).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });
    });
  });

  it("revoking a share removes it from the project", async (context) => {
    await withPostgreSql(context, async (pool) => {
      const owner = await createActor(pool, "owner");
      await connectAndSync(pool, owner);
      const core = new OperatingCoreService(pool);
      const project = await core.mutate(
        owner,
        "project.create",
        { name: "Mojave", ownerUserId: owner.userId },
        key("project"),
      );
      const projectId = String((project.project as { id: string }).id);
      const thread = await pool.query<{ id: string }>("SELECT id FROM gmail_threads");

      const workspace = new WorkspaceService(pool, new RecordedGoogleGateway(fixture));
      const shared = await workspace.mutate(
        owner,
        "workspace.share",
        { projectId, sourceKind: "gmail_thread", sourceId: thread.rows[0].id },
        key("share"),
      );
      await workspace.mutate(
        owner,
        "workspace.share.revoke",
        { shareId: String((shared.share as { id: string }).id) },
        key("revoke"),
      );
      const shares = await workspace.query(owner, "workspace.shares", { projectId });
      expect(shares.shares).toEqual([]);
    });
  });

  it("pauses only the failing owner's connection when authorization expires", async (context) => {
    await withPostgreSql(context, async (pool) => {
      const failing = await createActor(pool);
      const healthy = await createActor(pool);
      await connectAndSync(pool, healthy);

      const broken = new WorkspaceService(pool, {
        fetchIncremental: async () => {
          throw new Error("invalid_grant");
        },
      });
      const connected = await broken.mutate(
        failing,
        "workspace.connect",
        {
          googleEmail: `${failing.userId}@rangeway.energy`,
          scopes: [],
          credentialReference: "secret-store://atlas/2",
        },
        key("connect"),
      );
      const connectionId = String((connected.connection as { id: string }).id);

      await expect(
        broken.mutate(failing, "workspace.sync", { connectionId }, key("sync")),
      ).rejects.toMatchObject({ status: 409, code: "CONFLICT" });

      const statuses = await pool.query<{ owner_user_id: string; status: string }>(
        "SELECT owner_user_id, status FROM google_connections ORDER BY created_at",
      );
      const byOwner = Object.fromEntries(statuses.rows.map((row) => [row.owner_user_id, row.status]));
      expect(byOwner[healthy.userId!]).toBe("connected");
      expect(byOwner[failing.userId!]).toBe("expired");
    });
  });

  it("keeps low-confidence suggestions out of authoritative facts until reviewed", async (context) => {
    await withPostgreSql(context, async (pool) => {
      const actor = await createActor(pool);
      await connectAndSync(pool, actor);
      const thread = await pool.query<{ id: string }>("SELECT id FROM gmail_threads");

      await pool.query(
        `INSERT INTO workspace_suggestions
           (organization_id, owner_user_id, source_kind, source_id, kind, summary,
            confidence, extractor_version)
         VALUES ($1, $2, 'gmail_thread', $3, 'commitment', 'Landowner will send the survey', 0.42, 'extractor-v1')`,
        [organizationId, actor.userId, thread.rows[0].id],
      );

      const workspace = new WorkspaceService(pool, new RecordedGoogleGateway(fixture));
      const pending = await workspace.query(actor, "workspace.suggestions", {});
      const suggestion = (pending.suggestions as Array<{
        id: string;
        reviewState: string;
        confidence: string;
        extractorVersion: string;
      }>)[0];
      expect(suggestion.reviewState).toBe("pending");
      expect(suggestion.extractorVersion).toBe("extractor-v1");

      // Nothing was written into work items or decisions by the extractor.
      const work = await pool.query<{ count: string }>("SELECT count(*)::text AS count FROM work_items");
      expect(work.rows[0].count).toBe("0");

      await workspace.mutate(
        actor,
        "workspace.suggestion.review",
        { suggestionId: suggestion.id, reviewState: "rejected" },
        key("review"),
      );
      const after = await workspace.query(actor, "workspace.suggestions", {});
      expect(after.suggestions).toEqual([]);
    });
  });
});
