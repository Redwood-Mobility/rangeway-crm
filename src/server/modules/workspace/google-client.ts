import type { Pool } from "pg";
import { ApiError } from "../../platform/http/api-error.js";
import { loadGoogleTokens, storeGoogleTokens, type GoogleTokens } from "./credential-store.js";
import type { GoogleFixture, GoogleGateway } from "./workspace.service.js";

/**
 * The real Google client.
 *
 * It sits behind the same `GoogleGateway` port the recorded fixtures implement,
 * so nothing downstream — indexing, privacy, sharing — can tell the difference,
 * and no test needs a live mailbox.
 */

export const workspaceScopes = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/drive.metadata.readonly",
  "https://www.googleapis.com/auth/calendar.readonly",
] as const;

export interface GoogleOAuthConfig {
  clientId: string;
  clientSecret: string;
  /** The Workspace consent callback, distinct from the sign-in callback. */
  redirectUri: string;
  allowedDomain: string;
}

export function buildConsentUrl(config: GoogleOAuthConfig, state: string, loginHint?: string): string {
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: "code",
    scope: ["openid", "email", ...workspaceScopes].join(" "),
    // A refresh token only arrives with offline access, and Google withholds it
    // on re-consent unless explicitly prompted.
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state,
    hd: config.allowedDomain,
  });
  if (loginHint) params.set("login_hint", loginHint);
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  id_token?: string;
  error?: string;
  error_description?: string;
}

interface TokenInfo {
  aud?: string;
  email?: string;
  email_verified?: boolean | string;
  hd?: string;
}

/**
 * Establishes which Google account was actually connected.
 *
 * The address is asked of Google and checked, never derived from the signed-in
 * Atlas user or from a query parameter. A connection labelled with an address
 * nobody authorized is worse than no label: it is displayed as fact, and it is
 * part of the key that decides whether a later consent updates this connection
 * or silently creates a second one.
 */
async function verifiedConsentEmail(
  config: GoogleOAuthConfig,
  idToken: string,
  fetchImplementation: typeof fetch,
): Promise<string> {
  if (!idToken) {
    throw new ApiError(
      409,
      "CONFLICT",
      "Google did not identify the connected account. Connect again.",
    );
  }
  const response = await fetchImplementation(
    `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`,
  );
  if (!response.ok) {
    throw new ApiError(409, "CONFLICT", "That Google authorization could not be verified.");
  }
  const info = (await response.json()) as TokenInfo;
  const email = String(info.email ?? "").toLowerCase();
  const hostedDomain = String(info.hd ?? "").toLowerCase();
  const allowedDomain = config.allowedDomain.toLowerCase();

  if (info.aud !== config.clientId) {
    throw new ApiError(409, "CONFLICT", "That Google authorization was issued for another application.");
  }
  if (info.email_verified !== true && info.email_verified !== "true") {
    throw new ApiError(409, "CONFLICT", "That Google account has no verified email address.");
  }
  if (hostedDomain !== allowedDomain || !email.endsWith(`@${allowedDomain}`)) {
    throw new ApiError(409, "CONFLICT", `Atlas connects ${allowedDomain} accounts only.`);
  }
  return email;
}

async function requestTokens(
  config: GoogleOAuthConfig,
  body: Record<string, string>,
  fetchImplementation: typeof fetch,
): Promise<TokenResponse> {
  const response = await fetchImplementation("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      ...body,
    }),
  });
  const payload = (await response.json()) as TokenResponse;
  if (!response.ok || payload.error) {
    // The description can echo request detail, so it is not surfaced verbatim.
    throw new ApiError(409, "CONFLICT", "Google rejected the authorization request.");
  }
  return payload;
}

export async function exchangeConsentCode(
  config: GoogleOAuthConfig,
  code: string,
  fetchImplementation: typeof fetch = fetch,
): Promise<GoogleTokens & { grantedScopes: string[]; googleEmail: string }> {
  const payload = await requestTokens(
    config,
    { code, grant_type: "authorization_code", redirect_uri: config.redirectUri },
    fetchImplementation,
  );
  if (!payload.refresh_token) {
    throw new ApiError(
      409,
      "CONFLICT",
      "Google did not return a refresh token. Remove Atlas from your Google account permissions and connect again.",
    );
  }
  return {
    googleEmail: await verifiedConsentEmail(config, payload.id_token ?? "", fetchImplementation),
    refreshToken: payload.refresh_token,
    accessToken: payload.access_token ?? "",
    accessTokenExpiresAt: payload.expires_in
      ? new Date(Date.now() + payload.expires_in * 1000)
      : null,
    grantedScopes: (payload.scope ?? "").split(" ").filter(Boolean),
  };
}

/** Refreshes when the access token is missing or within a minute of expiry. */
async function accessTokenFor(
  pool: Pool,
  config: GoogleOAuthConfig,
  organizationId: string,
  ownerUserId: string,
  credentialReference: string,
  fetchImplementation: typeof fetch,
): Promise<string> {
  const tokens = await loadGoogleTokens(pool, organizationId, credentialReference);
  if (!tokens) throw new ApiError(409, "CONFLICT", "No stored Google credential for this connection.");

  const stillValid =
    tokens.accessToken &&
    tokens.accessTokenExpiresAt &&
    tokens.accessTokenExpiresAt.getTime() - Date.now() > 60_000;
  if (stillValid) return tokens.accessToken;

  const refreshed = await requestTokens(
    config,
    { refresh_token: tokens.refreshToken, grant_type: "refresh_token" },
    fetchImplementation,
  );
  const accessToken = refreshed.access_token ?? "";
  await storeGoogleTokens(pool, {
    organizationId,
    ownerUserId,
    credentialReference,
    tokens: {
      // Google omits the refresh token on refresh; the stored one stays valid.
      refreshToken: refreshed.refresh_token ?? tokens.refreshToken,
      accessToken,
      accessTokenExpiresAt: refreshed.expires_in
        ? new Date(Date.now() + refreshed.expires_in * 1000)
        : null,
    },
  });
  return accessToken;
}

/** Bounds any single sync so one enormous mailbox cannot run without end. */
const maxSyncPages = 10;

interface GmailListResponse {
  messages?: Array<{ id: string; threadId: string }>;
  nextPageToken?: string;
}

/** `users.messages.list` carries no history ID; the profile is where it lives. */
interface GmailProfile {
  emailAddress?: string;
  historyId?: string;
}

interface GmailHistoryResponse {
  history?: Array<{ messagesAdded?: Array<{ message: { id: string; threadId: string } }> }>;
  historyId?: string;
  nextPageToken?: string;
}

interface GmailMessage {
  id: string;
  threadId: string;
  snippet?: string;
  internalDate?: string;
  labelIds?: string[];
  payload?: {
    headers?: Array<{ name: string; value: string }>;
    parts?: Array<{ mimeType?: string; body?: { data?: string }; filename?: string }>;
    body?: { data?: string };
  };
}

function header(message: GmailMessage, name: string): string {
  const found = message.payload?.headers?.find(
    (candidate) => candidate.name.toLowerCase() === name.toLowerCase(),
  );
  return found?.value ?? "";
}

function decodeBody(message: GmailMessage): string {
  const encoded =
    message.payload?.body?.data ??
    message.payload?.parts?.find((part) => part.mimeType === "text/plain")?.body?.data ??
    "";
  if (!encoded) return message.snippet ?? "";
  try {
    return Buffer.from(encoded, "base64url").toString("utf8");
  } catch {
    return message.snippet ?? "";
  }
}

function addresses(value: string): string[] {
  return value
    .split(",")
    .map((entry) => {
      const match = /<([^>]+)>/.exec(entry);
      return (match?.[1] ?? entry).trim().toLowerCase();
    })
    .filter(Boolean);
}

export class LiveGoogleGateway implements GoogleGateway {
  constructor(
    private readonly pool: Pool,
    private readonly config: GoogleOAuthConfig,
    private readonly context: { organizationId: string; ownerUserId: string },
    private readonly fetchImplementation: typeof fetch = fetch,
  ) {}

  async fetchIncremental(input: {
    credentialReference: string;
    gmailHistoryId: string;
    drivePageToken: string;
    calendarSyncToken: string;
  }): Promise<GoogleFixture> {
    const accessToken = await accessTokenFor(
      this.pool,
      this.config,
      this.context.organizationId,
      this.context.ownerUserId,
      input.credentialReference,
      this.fetchImplementation,
    );
    /** Resolves to null on 404 when the caller can recover from absence. */
    const call = async <T>(url: string, tolerateMissing = false): Promise<T | null> => {
      const response = await this.fetchImplementation(url, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (response.status === 404 && tolerateMissing) return null;
      if (!response.ok) {
        // A revoked or expired grant surfaces as a sync failure, which pauses
        // only this owner's connection.
        throw new ApiError(409, "CONFLICT", "Google declined the request.");
      }
      return (await response.json()) as T;
    };
    const require = async <T>(url: string): Promise<T> => (await call<T>(url)) as T;

    const fixture: GoogleFixture = { threads: [], driveItems: [], calendarEvents: [] };

    // Gmail. The stored history ID is the checkpoint: with one, only what
    // changed since is fetched; without one, a bounded first page seeds the
    // index rather than pulling an entire mailbox in a single request.
    const messageIds = new Map<string, string>();
    let nextHistoryId = "";

    if (input.gmailHistoryId) {
      let pageToken = "";
      let pages = 0;
      do {
        const historyUrl = new URL("https://gmail.googleapis.com/gmail/v1/users/me/history");
        historyUrl.searchParams.set("startHistoryId", input.gmailHistoryId);
        historyUrl.searchParams.set("historyTypes", "messageAdded");
        if (pageToken) historyUrl.searchParams.set("pageToken", pageToken);
        // Google expires history older than about a week. A 404 means this
        // checkpoint is too old to resume from, not that the sync failed.
        const page = await call<GmailHistoryResponse>(historyUrl.toString(), true);
        if (!page) {
          messageIds.clear();
          nextHistoryId = "";
          break;
        }
        for (const entry of page.history ?? []) {
          for (const added of entry.messagesAdded ?? []) {
            messageIds.set(added.message.id, added.message.threadId);
          }
        }
        if (page.historyId) nextHistoryId = String(page.historyId);
        pageToken = page.nextPageToken ?? "";
      } while (pageToken && ++pages < maxSyncPages);
    }

    if (!nextHistoryId) {
      // Read the checkpoint before listing. Replaying a message that arrives
      // mid-pull is harmless because indexing upserts; missing one is not.
      const profile = await require<GmailProfile>(
        "https://gmail.googleapis.com/gmail/v1/users/me/profile",
      );
      nextHistoryId = String(profile.historyId ?? "");

      const listUrl = new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages");
      listUrl.searchParams.set("maxResults", "50");
      const list = await require<GmailListResponse>(listUrl.toString());
      for (const reference of list.messages ?? []) {
        messageIds.set(reference.id, reference.threadId);
      }
    }

    const byThread = new Map<string, GmailMessage[]>();
    for (const messageId of messageIds.keys()) {
      // A message deleted between listing and fetching is simply absent now.
      const message = await call<GmailMessage>(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}?format=full`,
        true,
      );
      if (!message) continue;
      byThread.set(message.threadId, [...(byThread.get(message.threadId) ?? []), message]);
    }
    for (const [threadId, messages] of byThread) {
      const latest = messages[messages.length - 1];
      fixture.threads!.push({
        providerThreadId: threadId,
        subject: header(latest, "Subject"),
        snippet: latest.snippet ?? "",
        participantEmails: [
          ...new Set(messages.flatMap((m) => [...addresses(header(m, "From")), ...addresses(header(m, "To"))])),
        ],
        labelIds: latest.labelIds ?? [],
        lastMessageAt: new Date(Number(latest.internalDate ?? Date.now())).toISOString(),
        messages: messages.map((message) => ({
          providerMessageId: message.id,
          fromEmail: addresses(header(message, "From"))[0] ?? "",
          toEmails: addresses(header(message, "To")),
          subject: header(message, "Subject"),
          bodyText: decodeBody(message),
          sentAt: new Date(Number(message.internalDate ?? Date.now())).toISOString(),
          attachments: (message.payload?.parts ?? [])
            .filter((part) => part.filename)
            // Metadata only. Attachment bytes are never pulled into Atlas.
            .map((part) => ({ filename: part.filename, mimeType: part.mimeType })),
        })),
      });
    }
    if (nextHistoryId) fixture.gmailHistoryId = nextHistoryId;

    // Drive: metadata and permissions only.
    const driveUrl = new URL("https://www.googleapis.com/drive/v3/files");
    driveUrl.searchParams.set("pageSize", "50");
    driveUrl.searchParams.set(
      "fields",
      "nextPageToken,files(id,name,mimeType,webViewLink,modifiedTime,permissions(id,type,role,emailAddress))",
    );
    if (input.drivePageToken) driveUrl.searchParams.set("pageToken", input.drivePageToken);
    const drive = await require<{
      files?: Array<{
        id: string;
        name: string;
        mimeType: string;
        webViewLink?: string;
        modifiedTime?: string;
        permissions?: unknown[];
      }>;
      nextPageToken?: string;
    }>(driveUrl.toString());
    for (const file of drive.files ?? []) {
      fixture.driveItems!.push({
        providerFileId: file.id,
        name: file.name,
        mimeType: file.mimeType,
        webViewLink: file.webViewLink ?? "",
        modifiedAt: file.modifiedTime ?? new Date().toISOString(),
        permissions: file.permissions ?? [],
      });
    }
    if (drive.nextPageToken) fixture.drivePageToken = drive.nextPageToken;

    // Calendar. Google returns `nextSyncToken` only on the final page, so a
    // single request leaves nothing to resume from and the same window is
    // re-read forever. Page to the end.
    // One entry per series, holding the occurrence nearest to now.
    const series = new Map<string, NonNullable<GoogleFixture["calendarEvents"]>[number]>();
    const now = Date.now();
    let calendarPageToken = "";
    let calendarPages = 0;
    let calendarTruncated = false;

    do {
      const calendarUrl = new URL(
        "https://www.googleapis.com/calendar/v3/calendars/primary/events",
      );
      calendarUrl.searchParams.set("maxResults", "100");
      calendarUrl.searchParams.set("singleEvents", "true");
      if (calendarPageToken) {
        // A page token already carries the original query; Google rejects it
        // alongside a sync token.
        calendarUrl.searchParams.set("pageToken", calendarPageToken);
      } else if (input.calendarSyncToken) {
        calendarUrl.searchParams.set("syncToken", input.calendarSyncToken);
      } else {
        // Both ends are bounded. Without `timeMax`, `singleEvents` expands a
        // recurring event forever — one standing block produced a thousand
        // rows reaching into 2039.
        calendarUrl.searchParams.set("timeMin", new Date(now - 30 * 86_400_000).toISOString());
        calendarUrl.searchParams.set("timeMax", new Date(now + 60 * 86_400_000).toISOString());
      }
      // An expired sync token is a 410 from Calendar; the sync then fails and
      // the owner reconnects. Only absence is tolerated here.
      const calendar = await require<{
        items?: Array<{
          id: string;
          recurringEventId?: string;
          summary?: string;
          description?: string;
          location?: string;
          start?: { dateTime?: string; date?: string; timeZone?: string };
          end?: { dateTime?: string; date?: string; timeZone?: string };
          attendees?: unknown[];
        }>;
        nextPageToken?: string;
        nextSyncToken?: string;
      }>(calendarUrl.toString());

      for (const event of calendar.items ?? []) {
        const startsAt = event.start?.dateTime ?? event.start?.date;
        const endsAt = event.end?.dateTime ?? event.end?.date;
        if (!startsAt || !endsAt) continue;
        const seriesKey = event.recurringEventId || event.id;
        const candidate = {
          providerEventId: event.id,
          seriesKey,
          calendarId: "primary",
          summary: event.summary ?? "",
          description: event.description ?? "",
          location: event.location ?? "",
          startsAt: new Date(startsAt).toISOString(),
          endsAt: new Date(endsAt).toISOString(),
          // Kept verbatim so a Hawaii event renders in Hawaii time.
          timeZone: event.start?.timeZone ?? "UTC",
          attendees: event.attendees ?? [],
        };

        // A weekly meeting is one thing to find, not one per week. Keep the
        // occurrence closest to now so the index answers "when is this next".
        const held = series.get(seriesKey);
        const distance = (value: string) => Math.abs(new Date(value).getTime() - now);
        if (!held || distance(candidate.startsAt) < distance(held.startsAt)) {
          series.set(seriesKey, candidate);
        }
      }
      if (calendar.nextSyncToken) fixture.calendarSyncToken = calendar.nextSyncToken;
      calendarPageToken = calendar.nextPageToken ?? "";
      if (calendarPageToken && ++calendarPages >= maxSyncPages) {
        // Stopping early also means no sync token, so the next sync would
        // re-read the same window. Say so rather than reporting a clean sync.
        calendarTruncated = true;
        break;
      }
    } while (calendarPageToken);

    fixture.calendarEvents = [...series.values()];
    if (calendarTruncated) {
      fixture.warnings = [
        ...(fixture.warnings ?? []),
        `Calendar returned more than ${maxSyncPages} pages; this sync covered only part of the window.`,
      ];
    }

    return fixture;
  }
}
