CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE actor_type AS ENUM ('human', 'agent', 'automation');
CREATE TYPE organization_role AS ENUM ('owner', 'admin', 'member', 'viewer');

CREATE TABLE organizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at TIMESTAMPTZ
);

CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email CITEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  google_subject TEXT UNIQUE,
  local_password_hash TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  disabled_at TIMESTAMPTZ
);

CREATE TABLE actors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  type actor_type NOT NULL,
  user_id UUID REFERENCES users(id) ON DELETE RESTRICT,
  service_key_prefix TEXT UNIQUE,
  service_key_hash TEXT,
  display_name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  disabled_at TIMESTAMPTZ,
  CONSTRAINT actors_identity_shape_check CHECK (
    (
      type = 'human'
      AND user_id IS NOT NULL
      AND service_key_prefix IS NULL
      AND service_key_hash IS NULL
    ) OR (
      type IN ('agent', 'automation')
      AND user_id IS NULL
      AND service_key_prefix IS NOT NULL
      AND service_key_hash IS NOT NULL
    )
  )
);

CREATE UNIQUE INDEX actors_organization_user_unique
  ON actors (organization_id, user_id)
  WHERE user_id IS NOT NULL;
CREATE INDEX actors_organization_id_idx ON actors (organization_id);

CREATE TABLE organization_memberships (
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role organization_role NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, user_id)
);

CREATE INDEX organization_memberships_user_id_idx
  ON organization_memberships (user_id);

CREATE TABLE audit_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  actor_id UUID NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
  request_id UUID NOT NULL,
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id UUID NOT NULL,
  before JSONB,
  after JSONB,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT audit_events_before_object_check CHECK (
    before IS NULL OR jsonb_typeof(before) = 'object'
  ),
  CONSTRAINT audit_events_after_object_check CHECK (
    after IS NULL OR jsonb_typeof(after) = 'object'
  ),
  CONSTRAINT audit_events_metadata_object_check CHECK (
    jsonb_typeof(metadata) = 'object'
  )
);

CREATE INDEX audit_events_organization_created_at_idx
  ON audit_events (organization_id, created_at DESC);
CREATE INDEX audit_events_resource_idx
  ON audit_events (organization_id, resource_type, resource_id, created_at DESC);

CREATE TABLE outbox_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  actor_id UUID NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
  request_id UUID NOT NULL,
  event_type TEXT NOT NULL,
  aggregate_type TEXT NOT NULL,
  aggregate_id UUID NOT NULL,
  schema_version INTEGER NOT NULL,
  payload JSONB NOT NULL,
  available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  processing_started_at TIMESTAMPTZ,
  processing_token UUID,
  published_at TIMESTAMPTZ,
  terminal_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT outbox_events_schema_version_check CHECK (schema_version > 0),
  CONSTRAINT outbox_events_attempt_count_check CHECK (attempt_count >= 0),
  CONSTRAINT outbox_events_payload_object_check CHECK (jsonb_typeof(payload) = 'object'),
  CONSTRAINT outbox_events_processing_lease_check CHECK (
    (processing_started_at IS NULL AND processing_token IS NULL)
    OR (processing_started_at IS NOT NULL AND processing_token IS NOT NULL)
  )
);

CREATE INDEX outbox_events_organization_created_at_idx
  ON outbox_events (organization_id, created_at DESC);
CREATE INDEX outbox_events_pending_delivery_idx
  ON outbox_events (available_at, created_at)
  WHERE published_at IS NULL AND terminal_at IS NULL;

INSERT INTO organizations (id, slug, name)
VALUES ('00000000-0000-4000-8000-000000000001', 'rangeway', 'Rangeway')
ON CONFLICT (id) DO NOTHING;
