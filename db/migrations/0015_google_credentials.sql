-- Encrypted storage for Google Workspace tokens.
-- Additive. Migrations 0001 through 0014 are unchanged.
--
-- `google_connections.credential_reference` is an opaque pointer. This is what
-- it points at. Tokens are encrypted with AES-256-GCM before they reach the
-- database, so a database dump alone never yields a usable Google credential.

CREATE TABLE google_credentials (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  credential_reference TEXT NOT NULL,
  owner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  -- Ciphertext, initialisation vector and authentication tag, all base64. The
  -- key never enters the database; it comes from the runtime environment.
  refresh_token_ciphertext TEXT NOT NULL,
  refresh_token_iv TEXT NOT NULL,
  refresh_token_tag TEXT NOT NULL,
  access_token_ciphertext TEXT NOT NULL DEFAULT '',
  access_token_iv TEXT NOT NULL DEFAULT '',
  access_token_tag TEXT NOT NULL DEFAULT '',
  access_token_expires_at TIMESTAMPTZ,
  key_version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT google_credentials_organization_id_id_unique UNIQUE (organization_id, id),
  CONSTRAINT google_credentials_reference_unique UNIQUE (organization_id, credential_reference),
  CONSTRAINT google_credentials_reference_check CHECK (credential_reference <> ''),
  CONSTRAINT google_credentials_refresh_present_check CHECK (
    refresh_token_ciphertext <> '' AND refresh_token_iv <> '' AND refresh_token_tag <> ''
  )
);

CREATE INDEX google_credentials_owner_idx
  ON google_credentials (organization_id, owner_user_id);

DO $permissions$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'atlas_web')
     AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'atlas_worker') THEN
    GRANT SELECT, INSERT ON google_credentials TO atlas_web;
    GRANT UPDATE (
      refresh_token_ciphertext, refresh_token_iv, refresh_token_tag,
      access_token_ciphertext, access_token_iv, access_token_tag,
      access_token_expires_at, key_version, updated_at
    ) ON google_credentials TO atlas_web;
    GRANT DELETE ON google_credentials TO atlas_web;

    REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM atlas_worker;
    GRANT SELECT ON outbox_events TO atlas_worker;
    GRANT UPDATE (
      attempt_count, available_at, processing_started_at, processing_token,
      published_at, terminal_at, last_error, updated_at
    ) ON outbox_events TO atlas_worker;
  END IF;
END
$permissions$;
