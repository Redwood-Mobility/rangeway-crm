import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import type { Pool, QueryResultRow } from "pg";
import { ApiError } from "../../platform/http/api-error.js";
import type { DbClient } from "../../platform/db/client.js";

/**
 * Encrypted Google token storage.
 *
 * Tokens are sealed with AES-256-GCM before they reach PostgreSQL, so a
 * database dump on its own yields nothing usable — the key lives only in the
 * runtime environment. `google_connections` stores an opaque reference; this
 * module is the only thing that can turn one into a real token.
 */

const algorithm = "aes-256-gcm";
const currentKeyVersion = 1;

export interface GoogleTokens {
  refreshToken: string;
  accessToken: string;
  accessTokenExpiresAt: Date | null;
}

interface Sealed {
  ciphertext: string;
  iv: string;
  tag: string;
}

export class CredentialKeyMissingError extends Error {
  constructor() {
    super("ATLAS_CREDENTIAL_KEY is required to store or read Google credentials.");
    this.name = "CredentialKeyMissingError";
  }
}

/**
 * The key is 32 bytes, base64. It is read per call rather than cached so a
 * rotation takes effect on restart without a stale copy lingering in memory.
 */
function credentialKey(): Buffer {
  const encoded = process.env.ATLAS_CREDENTIAL_KEY ?? "";
  if (!encoded) throw new CredentialKeyMissingError();
  const key = Buffer.from(encoded, "base64");
  if (key.byteLength !== 32) {
    throw new ApiError(
      500,
      "INTERNAL_ERROR",
      "ATLAS_CREDENTIAL_KEY must be exactly 32 bytes encoded as base64.",
    );
  }
  return key;
}

function seal(plaintext: string): Sealed {
  if (plaintext.length === 0) return { ciphertext: "", iv: "", tag: "" };
  const iv = randomBytes(12);
  const cipher = createCipheriv(algorithm, credentialKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
  };
}

function open(sealed: Sealed): string {
  if (!sealed.ciphertext) return "";
  const decipher = createDecipheriv(algorithm, credentialKey(), Buffer.from(sealed.iv, "base64"));
  decipher.setAuthTag(Buffer.from(sealed.tag, "base64"));
  // A tampered or wrong-key value fails here rather than returning garbage.
  return Buffer.concat([
    decipher.update(Buffer.from(sealed.ciphertext, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

type Row = QueryResultRow & Record<string, unknown>;

export function newCredentialReference(): string {
  return `atlas-google-${randomUUID()}`;
}

export async function storeGoogleTokens(
  client: DbClient | Pool,
  input: {
    organizationId: string;
    ownerUserId: string;
    credentialReference: string;
    tokens: GoogleTokens;
  },
): Promise<void> {
  const refresh = seal(input.tokens.refreshToken);
  const access = seal(input.tokens.accessToken);
  await client.query(
    `INSERT INTO google_credentials
       (id, organization_id, credential_reference, owner_user_id,
        refresh_token_ciphertext, refresh_token_iv, refresh_token_tag,
        access_token_ciphertext, access_token_iv, access_token_tag,
        access_token_expires_at, key_version)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (organization_id, credential_reference)
     DO UPDATE SET
       refresh_token_ciphertext = EXCLUDED.refresh_token_ciphertext,
       refresh_token_iv = EXCLUDED.refresh_token_iv,
       refresh_token_tag = EXCLUDED.refresh_token_tag,
       access_token_ciphertext = EXCLUDED.access_token_ciphertext,
       access_token_iv = EXCLUDED.access_token_iv,
       access_token_tag = EXCLUDED.access_token_tag,
       access_token_expires_at = EXCLUDED.access_token_expires_at,
       key_version = EXCLUDED.key_version,
       updated_at = now()`,
    [
      input.organizationId,
      input.credentialReference,
      input.ownerUserId,
      refresh.ciphertext,
      refresh.iv,
      refresh.tag,
      access.ciphertext,
      access.iv,
      access.tag,
      input.tokens.accessTokenExpiresAt,
      currentKeyVersion,
    ],
  );
}

export async function loadGoogleTokens(
  client: DbClient | Pool,
  organizationId: string,
  credentialReference: string,
): Promise<GoogleTokens | null> {
  const result = await client.query<Row>(
    `SELECT * FROM google_credentials
      WHERE organization_id = $1 AND credential_reference = $2`,
    [organizationId, credentialReference],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    refreshToken: open({
      ciphertext: String(row.refresh_token_ciphertext),
      iv: String(row.refresh_token_iv),
      tag: String(row.refresh_token_tag),
    }),
    accessToken: open({
      ciphertext: String(row.access_token_ciphertext),
      iv: String(row.access_token_iv),
      tag: String(row.access_token_tag),
    }),
    accessTokenExpiresAt:
      row.access_token_expires_at instanceof Date ? row.access_token_expires_at : null,
  };
}

export async function deleteGoogleTokens(
  client: DbClient | Pool,
  organizationId: string,
  credentialReference: string,
): Promise<void> {
  await client.query(
    "DELETE FROM google_credentials WHERE organization_id = $1 AND credential_reference = $2",
    [organizationId, credentialReference],
  );
}
