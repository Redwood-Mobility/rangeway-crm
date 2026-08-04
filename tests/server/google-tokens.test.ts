import { randomBytes, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it, type TestContext } from "vitest";
import {
  CredentialKeyMissingError,
  loadGoogleTokens,
  newCredentialReference,
  storeGoogleTokens,
} from "../../src/server/modules/workspace/credential-store.js";
import {
  LiveGoogleGateway,
  buildConsentUrl,
  exchangeConsentCode,
  workspaceScopes,
} from "../../src/server/modules/workspace/google-client.js";
import { createPool } from "../../src/server/platform/db/client.js";
import { runMigrations } from "../../src/server/platform/db/migrate.js";
import { createTemporaryDatabase, PostgreSqlUnavailableError } from "../helpers/database.js";

const organizationId = "00000000-0000-4000-8000-000000000001";
const oauth = {
  clientId: "client.apps.googleusercontent.com",
  clientSecret: "secret",
  redirectUri: "https://atlas.rangeway.app/api/v2/workspace/google/callback",
  allowedDomain: "rangeway.co",
};

let previousKey: string | undefined;
beforeEach(() => {
  previousKey = process.env.ATLAS_CREDENTIAL_KEY;
  process.env.ATLAS_CREDENTIAL_KEY = randomBytes(32).toString("base64");
});
afterEach(() => {
  if (previousKey === undefined) delete process.env.ATLAS_CREDENTIAL_KEY;
  else process.env.ATLAS_CREDENTIAL_KEY = previousKey;
});

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

async function seedUser(pool: Pool): Promise<string> {
  const userId = randomUUID();
  await pool.query("INSERT INTO users (id, email, display_name) VALUES ($1, $2, 'Person')", [
    userId,
    `${userId}@rangeway.co`,
  ]);
  return userId;
}

function jsonFetch(payload: unknown, ok = true): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(payload), {
      status: ok ? 200 : 400,
      headers: { "Content-Type": "application/json" },
    })) as unknown as typeof fetch;
}

describe("Google consent request", () => {
  it("asks for offline access and the three read scopes", () => {
    const url = new URL(buildConsentUrl(oauth, "state-value", "zak@rangeway.co"));
    const scope = (url.searchParams.get("scope") ?? "").split(" ");
    for (const required of workspaceScopes) expect(scope).toContain(required);

    // Without offline access and an explicit prompt Google withholds the
    // refresh token, and the connection would die at the first expiry.
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("hd")).toBe("rangeway.co");
    expect(url.searchParams.get("state")).toBe("state-value");
    expect(url.searchParams.get("login_hint")).toBe("zak@rangeway.co");
  });

  it("requests only read scopes, never write or send", () => {
    const scope = new URL(buildConsentUrl(oauth, "s")).searchParams.get("scope") ?? "";
    expect(scope).not.toMatch(/gmail\.send|gmail\.modify|drive\.file\b|drive$|calendar\.events/);
    expect(scope).toContain("gmail.readonly");
  });

  it("refuses an exchange that returns no refresh token", async () => {
    await expect(
      exchangeConsentCode(oauth, "code", jsonFetch({ access_token: "a", expires_in: 3600 })),
    ).rejects.toMatchObject({ status: 409, code: "CONFLICT" });
  });

  it("does not echo Google's error description back to the caller", async () => {
    await expect(
      exchangeConsentCode(
        oauth,
        "code",
        jsonFetch({ error: "invalid_grant", error_description: "code was for client 12345" }, false),
      ),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      publicMessage: "Google rejected the authorization request.",
    });
  });
});

describe("encrypted credential storage", () => {
  it("stores no plaintext token and round-trips through the key", async (context) => {
    await withPostgreSql(context, async (pool) => {
      const userId = await seedUser(pool);
      const reference = newCredentialReference();
      await storeGoogleTokens(pool, {
        organizationId,
        ownerUserId: userId,
        credentialReference: reference,
        tokens: {
          refreshToken: "1//refresh-secret-value",
          accessToken: "ya29.access-secret-value",
          accessTokenExpiresAt: new Date(Date.now() + 3_600_000),
        },
      });

      const raw = await pool.query<{ row: string }>(
        "SELECT google_credentials::text AS row FROM google_credentials",
      );
      expect(raw.rows[0].row).not.toContain("1//refresh-secret-value");
      expect(raw.rows[0].row).not.toContain("ya29.access-secret-value");

      const loaded = await loadGoogleTokens(pool, organizationId, reference);
      expect(loaded?.refreshToken).toBe("1//refresh-secret-value");
      expect(loaded?.accessToken).toBe("ya29.access-secret-value");
    });
  });

  it("cannot be read with a different key", async (context) => {
    await withPostgreSql(context, async (pool) => {
      const userId = await seedUser(pool);
      const reference = newCredentialReference();
      await storeGoogleTokens(pool, {
        organizationId,
        ownerUserId: userId,
        credentialReference: reference,
        tokens: { refreshToken: "1//secret", accessToken: "", accessTokenExpiresAt: null },
      });

      process.env.ATLAS_CREDENTIAL_KEY = randomBytes(32).toString("base64");
      await expect(loadGoogleTokens(pool, organizationId, reference)).rejects.toThrow();
    });
  });

  it("refuses to operate without a key rather than storing in the clear", async (context) => {
    await withPostgreSql(context, async (pool) => {
      const userId = await seedUser(pool);
      delete process.env.ATLAS_CREDENTIAL_KEY;
      await expect(
        storeGoogleTokens(pool, {
          organizationId,
          ownerUserId: userId,
          credentialReference: newCredentialReference(),
          tokens: { refreshToken: "1//secret", accessToken: "", accessTokenExpiresAt: null },
        }),
      ).rejects.toBeInstanceOf(CredentialKeyMissingError);

      const stored = await pool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM google_credentials",
      );
      expect(stored.rows[0].count).toBe("0");
    });
  });
});

describe("live Google gateway", () => {
  it("refreshes an expired access token and keeps the stored refresh token", async (context) => {
    await withPostgreSql(context, async (pool) => {
      const userId = await seedUser(pool);
      const reference = newCredentialReference();
      await storeGoogleTokens(pool, {
        organizationId,
        ownerUserId: userId,
        credentialReference: reference,
        tokens: {
          refreshToken: "1//long-lived",
          accessToken: "ya29.expired",
          // Already past, so a refresh is required.
          accessTokenExpiresAt: new Date(Date.now() - 60_000),
        },
      });

      const calls: string[] = [];
      const fetchImplementation = (async (url: string | URL | Request, init?: RequestInit) => {
        const target = String(url);
        calls.push(target);
        if (target.includes("oauth2.googleapis.com/token")) {
          expect(String(init?.body)).toContain("grant_type=refresh_token");
          return new Response(
            JSON.stringify({ access_token: "ya29.fresh", expires_in: 3600 }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        if (target.includes("gmail")) {
          return new Response(JSON.stringify({ messages: [], historyId: "99" }), { status: 200 });
        }
        if (target.includes("drive")) {
          return new Response(JSON.stringify({ files: [] }), { status: 200 });
        }
        return new Response(JSON.stringify({ items: [], nextSyncToken: "sync-2" }), { status: 200 });
      }) as unknown as typeof fetch;

      const gateway = new LiveGoogleGateway(
        pool,
        oauth,
        { organizationId, ownerUserId: userId },
        fetchImplementation,
      );
      const fixture = await gateway.fetchIncremental({
        credentialReference: reference,
        gmailHistoryId: "",
        drivePageToken: "",
        calendarSyncToken: "",
      });

      expect(calls[0]).toContain("oauth2.googleapis.com/token");
      expect(fixture.gmailHistoryId).toBe("99");
      expect(fixture.calendarSyncToken).toBe("sync-2");

      // Google omits the refresh token on refresh; the stored one must survive.
      const loaded = await loadGoogleTokens(pool, organizationId, reference);
      expect(loaded?.refreshToken).toBe("1//long-lived");
      expect(loaded?.accessToken).toBe("ya29.fresh");
    });
  });

  it("maps Gmail, Drive and Calendar into the same shape the fixtures use", async (context) => {
    await withPostgreSql(context, async (pool) => {
      const userId = await seedUser(pool);
      const reference = newCredentialReference();
      await storeGoogleTokens(pool, {
        organizationId,
        ownerUserId: userId,
        credentialReference: reference,
        tokens: {
          refreshToken: "1//r",
          accessToken: "ya29.valid",
          accessTokenExpiresAt: new Date(Date.now() + 3_600_000),
        },
      });

      const fetchImplementation = (async (url: string | URL) => {
        const target = String(url);
        if (target.includes("/messages/m1")) {
          return new Response(
            JSON.stringify({
              id: "m1",
              threadId: "t1",
              snippet: "Terms attached",
              internalDate: "1754179200000",
              labelIds: ["INBOX"],
              payload: {
                headers: [
                  { name: "Subject", value: "Mojave option" },
                  { name: "From", value: "Dana Reyes <dana@example.com>" },
                  { name: "To", value: "zak@rangeway.co" },
                ],
                parts: [
                  { mimeType: "text/plain", body: { data: Buffer.from("Full body").toString("base64url") } },
                  { filename: "terms.pdf", mimeType: "application/pdf", body: {} },
                ],
              },
            }),
            { status: 200 },
          );
        }
        if (target.includes("gmail")) {
          return new Response(
            JSON.stringify({ messages: [{ id: "m1", threadId: "t1" }], historyId: "7" }),
            { status: 200 },
          );
        }
        if (target.includes("drive")) {
          return new Response(
            JSON.stringify({
              files: [
                {
                  id: "f1",
                  name: "Term sheet",
                  mimeType: "application/pdf",
                  webViewLink: "https://drive.google.com/f1",
                  modifiedTime: "2026-08-01T09:00:00.000Z",
                  permissions: [{ id: "p1", type: "user", role: "reader" }],
                },
              ],
            }),
            { status: 200 },
          );
        }
        return new Response(
          JSON.stringify({
            items: [
              {
                id: "e1",
                summary: "Hawaii utility call",
                start: { dateTime: "2026-08-05T09:00:00-10:00", timeZone: "Pacific/Honolulu" },
                end: { dateTime: "2026-08-05T10:00:00-10:00", timeZone: "Pacific/Honolulu" },
              },
            ],
            nextSyncToken: "s1",
          }),
          { status: 200 },
        );
      }) as unknown as typeof fetch;

      const gateway = new LiveGoogleGateway(
        pool,
        oauth,
        { organizationId, ownerUserId: userId },
        fetchImplementation,
      );
      const fixture = await gateway.fetchIncremental({
        credentialReference: reference,
        gmailHistoryId: "",
        drivePageToken: "",
        calendarSyncToken: "",
      });

      const thread = fixture.threads![0];
      expect(thread.subject).toBe("Mojave option");
      expect(thread.participantEmails).toContain("dana@example.com");
      expect(thread.messages[0].bodyText).toBe("Full body");
      // Attachment metadata only; bytes are never pulled in.
      expect(thread.messages[0].attachments).toEqual([
        { filename: "terms.pdf", mimeType: "application/pdf" },
      ]);

      expect(fixture.driveItems![0].name).toBe("Term sheet");
      expect(fixture.calendarEvents![0].timeZone).toBe("Pacific/Honolulu");
    });
  });

  it("surfaces a declined Google request as a sync conflict", async (context) => {
    await withPostgreSql(context, async (pool) => {
      const userId = await seedUser(pool);
      const reference = newCredentialReference();
      await storeGoogleTokens(pool, {
        organizationId,
        ownerUserId: userId,
        credentialReference: reference,
        tokens: {
          refreshToken: "1//r",
          accessToken: "ya29.valid",
          accessTokenExpiresAt: new Date(Date.now() + 3_600_000),
        },
      });
      const gateway = new LiveGoogleGateway(
        pool,
        oauth,
        { organizationId, ownerUserId: userId },
        (async () => new Response("nope", { status: 403 })) as unknown as typeof fetch,
      );
      await expect(
        gateway.fetchIncremental({
          credentialReference: reference,
          gmailHistoryId: "",
          drivePageToken: "",
          calendarSyncToken: "",
        }),
      ).rejects.toMatchObject({ status: 409, code: "CONFLICT" });
    });
  });
});
