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

/** Routes the token exchange and the identity check to separate payloads. */
function consentFetch(token: unknown, tokenInfo: unknown, tokenInfoOk = true): typeof fetch {
  return (async (input: string | URL) => {
    const url = String(input);
    const forTokenInfo = url.includes("tokeninfo");
    return new Response(JSON.stringify(forTokenInfo ? tokenInfo : token), {
      status: forTokenInfo && !tokenInfoOk ? 400 : 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

const grantedTokens = {
  access_token: "ya29.access",
  refresh_token: "1//refresh",
  expires_in: 3600,
  scope: workspaceScopes.join(" "),
  id_token: "header.payload.signature",
};

const verifiedIdentity = {
  aud: oauth.clientId,
  email: "Zak@Rangeway.co",
  email_verified: true,
  hd: "rangeway.co",
};

describe("connected account identity", () => {
  it("takes the address from Google rather than inventing one", async () => {
    const result = await exchangeConsentCode(
      oauth,
      "code",
      consentFetch(grantedTokens, verifiedIdentity),
    );

    expect(result.googleEmail).toBe("zak@rangeway.co");
    expect(result.refreshToken).toBe("1//refresh");
  });

  it("refuses an exchange that identifies no account", async () => {
    // Storing a placeholder here would display an address nobody authorized.
    const { id_token, ...withoutIdentity } = grantedTokens;
    await expect(
      exchangeConsentCode(oauth, "code", consentFetch(withoutIdentity, verifiedIdentity)),
    ).rejects.toMatchObject({ status: 409, code: "CONFLICT" });
  });

  it.each([
    ["issued for another application", { ...verifiedIdentity, aud: "other.apps.googleusercontent.com" }],
    ["email is unverified", { ...verifiedIdentity, email_verified: false }],
    ["hosted domain does not match", { ...verifiedIdentity, hd: "example.com" }],
    ["address is outside the domain", { ...verifiedIdentity, email: "someone@example.com" }],
  ])("refuses a consent whose %s", async (_label, identity) => {
    await expect(
      exchangeConsentCode(oauth, "code", consentFetch(grantedTokens, identity)),
    ).rejects.toMatchObject({ status: 409, code: "CONFLICT" });
  });

  it("refuses when Google will not verify the identity token", async () => {
    await expect(
      exchangeConsentCode(oauth, "code", consentFetch(grantedTokens, {}, false)),
    ).rejects.toMatchObject({ status: 409, code: "CONFLICT" });
  });
});

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

/**
 * A stand-in Google that records every URL requested, so a test can assert how
 * a sync resumes rather than only what it returns.
 */
function googleApi(pages: {
  historyStatus?: number;
  history?: unknown;
  calendar?: unknown[];
}): { fetch: typeof fetch; urls: string[] } {
  const urls: string[] = [];
  const calendarPages = pages.calendar ?? [{ items: [], nextSyncToken: "cal-sync-1" }];
  let calendarIndex = 0;

  const respond = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

  const implementation = async (input: string | URL) => {
    const url = String(input);
    urls.push(url);

    if (url.includes("gmail/v1/users/me/history")) {
      if (pages.historyStatus && pages.historyStatus !== 200) {
        return respond({ error: "not found" }, pages.historyStatus);
      }
      return respond(pages.history ?? { history: [], historyId: "history-next" });
    }
    if (url.includes("gmail/v1/users/me/profile")) {
      return respond({ emailAddress: "zak@rangeway.co", historyId: "profile-history" });
    }
    if (url.includes("gmail/v1/users/me/messages/")) {
      return respond({ id: "m1", threadId: "t1", snippet: "hello", internalDate: "1700000000000" });
    }
    if (url.includes("gmail/v1/users/me/messages")) {
      return respond({ messages: [{ id: "m1", threadId: "t1" }] });
    }
    if (url.includes("drive/v3/files")) {
      return respond({ files: [] });
    }
    if (url.includes("calendar/v3")) {
      return respond(calendarPages[Math.min(calendarIndex++, calendarPages.length - 1)]);
    }
    return respond({}, 404);
  };

  return { fetch: implementation as unknown as typeof fetch, urls };
}

async function seedCredential(pool: Pool): Promise<{ userId: string; reference: string }> {
  const userId = await seedUser(pool);
  const reference = newCredentialReference();
  await storeGoogleTokens(pool, {
    organizationId,
    ownerUserId: userId,
    credentialReference: reference,
    // Valid for an hour, so no refresh call is involved.
    tokens: {
      refreshToken: "1//refresh",
      accessToken: "ya29.access",
      accessTokenExpiresAt: new Date(Date.now() + 3_600_000),
    },
  });
  return { userId, reference };
}

describe("sync continuation", () => {
  it("records a resumable Gmail checkpoint on the first sync", async (context) => {
    await withPostgreSql(context, async (pool) => {
      const { userId, reference } = await seedCredential(pool);
      const google = googleApi({});
      const gateway = new LiveGoogleGateway(
        pool,
        oauth,
        { organizationId, ownerUserId: userId },
        google.fetch,
      );

      const fixture = await gateway.fetchIncremental({
        credentialReference: reference,
        gmailHistoryId: "",
        drivePageToken: "",
        calendarSyncToken: "",
      });

      // The message list carries no history ID, so without reading the profile
      // there is nothing to resume from and every sync repeats the same window.
      expect(google.urls.some((url) => url.includes("users/me/profile"))).toBe(true);
      expect(fixture.gmailHistoryId).toBe("profile-history");
    });
  });

  it("asks only for what changed once a checkpoint exists", async (context) => {
    await withPostgreSql(context, async (pool) => {
      const { userId, reference } = await seedCredential(pool);
      const google = googleApi({
        history: {
          history: [{ messagesAdded: [{ message: { id: "m1", threadId: "t1" } }] }],
          historyId: "history-next",
        },
      });
      const gateway = new LiveGoogleGateway(
        pool,
        oauth,
        { organizationId, ownerUserId: userId },
        google.fetch,
      );

      const fixture = await gateway.fetchIncremental({
        credentialReference: reference,
        gmailHistoryId: "history-1",
        drivePageToken: "",
        calendarSyncToken: "",
      });

      const history = google.urls.find((url) => url.includes("users/me/history"));
      expect(history).toContain("startHistoryId=history-1");
      expect(google.urls.some((url) => url.endsWith("users/me/messages?maxResults=50"))).toBe(false);
      expect(fixture.gmailHistoryId).toBe("history-next");
      expect(fixture.threads?.[0]?.providerThreadId).toBe("t1");
    });
  });

  it("falls back to a full read when the checkpoint has expired", async (context) => {
    await withPostgreSql(context, async (pool) => {
      const { userId, reference } = await seedCredential(pool);
      // Google discards history older than about a week. Failing the sync would
      // strand the connection permanently.
      const google = googleApi({ historyStatus: 404 });
      const gateway = new LiveGoogleGateway(
        pool,
        oauth,
        { organizationId, ownerUserId: userId },
        google.fetch,
      );

      const fixture = await gateway.fetchIncremental({
        credentialReference: reference,
        gmailHistoryId: "far-too-old",
        drivePageToken: "",
        calendarSyncToken: "",
      });

      expect(google.urls.some((url) => url.includes("users/me/profile"))).toBe(true);
      expect(fixture.gmailHistoryId).toBe("profile-history");
    });
  });

  it("pages calendar to the end so the sync token is captured", async (context) => {
    await withPostgreSql(context, async (pool) => {
      const { userId, reference } = await seedCredential(pool);
      // A sync token arrives only on the final page; stopping at the first left
      // the window frozen.
      const google = googleApi({
        calendar: [
          { items: [], nextPageToken: "cal-page-2" },
          { items: [], nextSyncToken: "cal-sync-final" },
        ],
      });
      const gateway = new LiveGoogleGateway(
        pool,
        oauth,
        { organizationId, ownerUserId: userId },
        google.fetch,
      );

      const fixture = await gateway.fetchIncremental({
        credentialReference: reference,
        gmailHistoryId: "",
        drivePageToken: "",
        calendarSyncToken: "existing-sync-token",
      });

      expect(fixture.calendarSyncToken).toBe("cal-sync-final");

      const calendarUrls = google.urls.filter((url) => url.includes("calendar/v3"));
      expect(calendarUrls).toHaveLength(2);
      expect(calendarUrls[0]).toContain("syncToken=existing-sync-token");
      // Google rejects a page token sent alongside a sync token.
      expect(calendarUrls[1]).toContain("pageToken=cal-page-2");
      expect(calendarUrls[1]).not.toContain("syncToken");
    });
  });
});

describe("recurring calendar events", () => {
  /** A standing weekly block, expanded into one instance per week. */
  function recurringInstances(count: number) {
    const base = Date.UTC(2026, 7, 4, 16, 0, 0);
    return Array.from({ length: count }, (_, index) => ({
      id: `office_${index}`,
      recurringEventId: "office_series",
      summary: "Office",
      start: { dateTime: new Date(base + index * 7 * 86_400_000).toISOString() },
      end: { dateTime: new Date(base + index * 7 * 86_400_000 + 3_600_000).toISOString() },
    }));
  }

  it("collapses a recurring series to a single indexed entry", async (context) => {
    await withPostgreSql(context, async (pool) => {
      const { userId, reference } = await seedCredential(pool);
      const google = googleApi({
        calendar: [{ items: recurringInstances(200), nextSyncToken: "cal-sync" }],
      });
      const gateway = new LiveGoogleGateway(
        pool,
        oauth,
        { organizationId, ownerUserId: userId },
        google.fetch,
      );

      const fixture = await gateway.fetchIncremental({
        credentialReference: reference,
        gmailHistoryId: "",
        drivePageToken: "",
        calendarSyncToken: "",
      });

      // 200 occurrences of one standing meeting is one thing worth finding.
      expect(fixture.calendarEvents).toHaveLength(1);
      expect(fixture.calendarEvents?.[0].seriesKey).toBe("office_series");
      expect(fixture.calendarEvents?.[0].summary).toBe("Office");
    });
  });

  it("keeps one-off events distinct from each other", async (context) => {
    await withPostgreSql(context, async (pool) => {
      const { userId, reference } = await seedCredential(pool);
      const google = googleApi({
        calendar: [
          {
            items: [
              { id: "a", summary: "Landowner call", start: { dateTime: "2026-08-05T17:00:00Z" }, end: { dateTime: "2026-08-05T18:00:00Z" } },
              { id: "b", summary: "Site walk", start: { dateTime: "2026-08-06T17:00:00Z" }, end: { dateTime: "2026-08-06T18:00:00Z" } },
            ],
            nextSyncToken: "cal-sync",
          },
        ],
      });
      const gateway = new LiveGoogleGateway(
        pool,
        oauth,
        { organizationId, ownerUserId: userId },
        google.fetch,
      );

      const fixture = await gateway.fetchIncremental({
        credentialReference: reference,
        gmailHistoryId: "",
        drivePageToken: "",
        calendarSyncToken: "",
      });

      expect(fixture.calendarEvents).toHaveLength(2);
    });
  });

  it("bounds the requested window at both ends", async (context) => {
    await withPostgreSql(context, async (pool) => {
      const { userId, reference } = await seedCredential(pool);
      const google = googleApi({});
      const gateway = new LiveGoogleGateway(
        pool,
        oauth,
        { organizationId, ownerUserId: userId },
        google.fetch,
      );

      await gateway.fetchIncremental({
        credentialReference: reference,
        gmailHistoryId: "",
        drivePageToken: "",
        calendarSyncToken: "",
      });

      // Without timeMax, singleEvents expands a recurring event indefinitely.
      const calendarUrl = google.urls.find((url) => url.includes("calendar/v3"));
      expect(calendarUrl).toContain("timeMin=");
      expect(calendarUrl).toContain("timeMax=");
    });
  });

  it("reports a truncated sync rather than reporting a clean one", async (context) => {
    await withPostgreSql(context, async (pool) => {
      const { userId, reference } = await seedCredential(pool);
      // Every page offers another; the bound stops it and no sync token arrives.
      const google = googleApi({
        calendar: [{ items: recurringInstances(1), nextPageToken: "always-more" }],
      });
      const gateway = new LiveGoogleGateway(
        pool,
        oauth,
        { organizationId, ownerUserId: userId },
        google.fetch,
      );

      const fixture = await gateway.fetchIncremental({
        credentialReference: reference,
        gmailHistoryId: "",
        drivePageToken: "",
        calendarSyncToken: "",
      });

      expect(fixture.calendarSyncToken).toBeUndefined();
      expect(fixture.warnings?.join(" ")).toContain("only part of the window");
    });
  });
});
