-- Atlas artifacts, evidence, and the Location Pursuit gate engine.
-- Additive. Migrations 0001 through 0009 are unchanged.

CREATE TYPE artifact_mode AS ENUM ('native', 'linked', 'snapshot');
CREATE TYPE artifact_visibility AS ENUM ('project', 'private');
CREATE TYPE requirement_state AS ENUM (
  'unknown', 'investigating', 'in_progress', 'evidenced', 'blocked', 'waived', 'not_applicable'
);
CREATE TYPE evidence_target_type AS ENUM (
  'requirement', 'decision', 'risk', 'blocker', 'milestone', 'report_statement'
);
CREATE TYPE pursuit_phase AS ENUM (
  'identified', 'qualifying', 'diligence', 'negotiation', 'committed', 'construction', 'operating', 'released'
);

-- ------------------------------------------------------------- artifacts --

CREATE TABLE artifacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  mode artifact_mode NOT NULL,
  title TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 300),
  description TEXT NOT NULL DEFAULT '',
  -- Native and snapshot artifacts hold a storage key; linked artifacts hold a
  -- canonical URL to the system that remains authoritative for them.
  storage_key TEXT NOT NULL DEFAULT '',
  canonical_url TEXT NOT NULL DEFAULT '',
  mime_type TEXT NOT NULL DEFAULT '',
  byte_size BIGINT NOT NULL DEFAULT 0 CHECK (byte_size >= 0),
  checksum TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  visibility artifact_visibility NOT NULL DEFAULT 'project',
  source_system TEXT NOT NULL DEFAULT 'atlas',
  source_owner_user_id UUID REFERENCES users(id) ON DELETE RESTRICT,
  -- A snapshot is an immutable copy taken to preserve what supported a claim.
  snapshot_of_artifact_id UUID,
  snapshot_taken_at TIMESTAMPTZ,
  provenance JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by_actor_id UUID NOT NULL,
  updated_by_actor_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at TIMESTAMPTZ,
  archived_by_actor_id UUID,
  CONSTRAINT artifacts_organization_id_id_unique UNIQUE (organization_id, id),
  CONSTRAINT artifacts_creator_fk FOREIGN KEY (organization_id, created_by_actor_id)
    REFERENCES actors (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT artifacts_updater_fk FOREIGN KEY (organization_id, updated_by_actor_id)
    REFERENCES actors (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT artifacts_snapshot_source_fk FOREIGN KEY (organization_id, snapshot_of_artifact_id)
    REFERENCES artifacts (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT artifacts_native_storage_check CHECK (
    (mode = 'linked' AND canonical_url <> '')
    OR (mode <> 'linked' AND storage_key <> '' AND checksum <> '')
  ),
  CONSTRAINT artifacts_snapshot_metadata_check CHECK (
    (mode = 'snapshot' AND snapshot_taken_at IS NOT NULL)
    OR (mode <> 'snapshot' AND snapshot_taken_at IS NULL)
  )
);

CREATE INDEX artifacts_organization_id_created_at_idx
  ON artifacts (organization_id, created_at DESC, id DESC);

CREATE TABLE artifact_projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  artifact_id UUID NOT NULL,
  project_id UUID NOT NULL,
  created_by_actor_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT artifact_projects_organization_id_id_unique UNIQUE (organization_id, id),
  CONSTRAINT artifact_projects_pair_unique UNIQUE (organization_id, artifact_id, project_id),
  CONSTRAINT artifact_projects_artifact_fk FOREIGN KEY (organization_id, artifact_id)
    REFERENCES artifacts (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT artifact_projects_project_fk FOREIGN KEY (organization_id, project_id)
    REFERENCES project_rooms (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT artifact_projects_creator_fk FOREIGN KEY (organization_id, created_by_actor_id)
    REFERENCES actors (organization_id, id) ON DELETE RESTRICT
);

CREATE INDEX artifact_projects_organization_id_project_id_idx
  ON artifact_projects (organization_id, project_id);

-- -------------------------------------------------- location pursuit gates --

CREATE TABLE pursuit_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  key TEXT NOT NULL CHECK (char_length(key) BETWEEN 1 AND 100),
  version INTEGER NOT NULL CHECK (version >= 1),
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT pursuit_templates_organization_id_id_unique UNIQUE (organization_id, id),
  CONSTRAINT pursuit_templates_key_version_unique UNIQUE (organization_id, key, version)
);

CREATE TABLE pursuit_development_areas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  template_id UUID NOT NULL,
  key TEXT NOT NULL,
  name TEXT NOT NULL,
  position INTEGER NOT NULL,
  CONSTRAINT pursuit_development_areas_organization_id_id_unique UNIQUE (organization_id, id),
  CONSTRAINT pursuit_development_areas_key_unique UNIQUE (organization_id, template_id, key),
  CONSTRAINT pursuit_development_areas_template_fk FOREIGN KEY (organization_id, template_id)
    REFERENCES pursuit_templates (organization_id, id) ON DELETE RESTRICT
);

CREATE TABLE pursuit_requirement_definitions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  development_area_id UUID NOT NULL,
  key TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  position INTEGER NOT NULL,
  -- The phase this requirement must be satisfied by. A project cannot enter a
  -- phase at or beyond this one while the requirement is unmet.
  required_by_phase pursuit_phase NOT NULL,
  CONSTRAINT pursuit_requirement_definitions_organization_id_id_unique UNIQUE (organization_id, id),
  CONSTRAINT pursuit_requirement_definitions_key_unique UNIQUE (organization_id, development_area_id, key),
  CONSTRAINT pursuit_requirement_definitions_area_fk FOREIGN KEY (organization_id, development_area_id)
    REFERENCES pursuit_development_areas (organization_id, id) ON DELETE RESTRICT
);

CREATE TABLE pursuit_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  project_id UUID NOT NULL,
  template_id UUID NOT NULL,
  phase pursuit_phase NOT NULL DEFAULT 'identified',
  site_context TEXT NOT NULL DEFAULT '',
  corridor_context TEXT NOT NULL DEFAULT '',
  format_hypothesis TEXT NOT NULL DEFAULT '',
  strategic_thesis TEXT NOT NULL DEFAULT '',
  economics_summary TEXT NOT NULL DEFAULT '',
  target_open_on DATE,
  created_by_actor_id UUID NOT NULL,
  updated_by_actor_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT pursuit_profiles_organization_id_id_unique UNIQUE (organization_id, id),
  CONSTRAINT pursuit_profiles_project_unique UNIQUE (organization_id, project_id),
  CONSTRAINT pursuit_profiles_project_fk FOREIGN KEY (organization_id, project_id)
    REFERENCES project_rooms (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT pursuit_profiles_template_fk FOREIGN KEY (organization_id, template_id)
    REFERENCES pursuit_templates (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT pursuit_profiles_creator_fk FOREIGN KEY (organization_id, created_by_actor_id)
    REFERENCES actors (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT pursuit_profiles_updater_fk FOREIGN KEY (organization_id, updated_by_actor_id)
    REFERENCES actors (organization_id, id) ON DELETE RESTRICT
);

CREATE TABLE pursuit_requirements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  profile_id UUID NOT NULL,
  project_id UUID NOT NULL,
  definition_id UUID NOT NULL,
  state requirement_state NOT NULL DEFAULT 'unknown',
  notes TEXT NOT NULL DEFAULT '',
  -- Waived and Not Applicable require an actor and a rationale. The check below
  -- makes that structural rather than a convention.
  waiver_rationale TEXT NOT NULL DEFAULT '',
  waived_by_actor_id UUID,
  waived_at TIMESTAMPTZ,
  updated_by_actor_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT pursuit_requirements_organization_id_id_unique UNIQUE (organization_id, id),
  CONSTRAINT pursuit_requirements_definition_unique UNIQUE (organization_id, profile_id, definition_id),
  CONSTRAINT pursuit_requirements_profile_fk FOREIGN KEY (organization_id, profile_id)
    REFERENCES pursuit_profiles (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT pursuit_requirements_project_fk FOREIGN KEY (organization_id, project_id)
    REFERENCES project_rooms (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT pursuit_requirements_definition_fk FOREIGN KEY (organization_id, definition_id)
    REFERENCES pursuit_requirement_definitions (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT pursuit_requirements_updater_fk FOREIGN KEY (organization_id, updated_by_actor_id)
    REFERENCES actors (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT pursuit_requirements_waiver_check CHECK (
    (state IN ('waived', 'not_applicable')
      AND waiver_rationale <> '' AND waived_by_actor_id IS NOT NULL AND waived_at IS NOT NULL)
    OR (state NOT IN ('waived', 'not_applicable')
      AND waiver_rationale = '' AND waived_by_actor_id IS NULL AND waived_at IS NULL)
  )
);

CREATE INDEX pursuit_requirements_organization_id_project_id_idx
  ON pursuit_requirements (organization_id, project_id);

CREATE TABLE pursuit_phase_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  profile_id UUID NOT NULL,
  from_phase pursuit_phase,
  to_phase pursuit_phase NOT NULL,
  rationale TEXT NOT NULL DEFAULT '',
  -- Records that unmet requirements were consciously reconciled, and by whom.
  unmet_requirement_ids UUID[] NOT NULL DEFAULT '{}',
  override_rationale TEXT NOT NULL DEFAULT '',
  changed_by_actor_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT pursuit_phase_history_organization_id_id_unique UNIQUE (organization_id, id),
  CONSTRAINT pursuit_phase_history_profile_fk FOREIGN KEY (organization_id, profile_id)
    REFERENCES pursuit_profiles (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT pursuit_phase_history_actor_fk FOREIGN KEY (organization_id, changed_by_actor_id)
    REFERENCES actors (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT pursuit_phase_history_override_check CHECK (
    cardinality(unmet_requirement_ids) = 0 OR override_rationale <> ''
  )
);

CREATE INDEX pursuit_phase_history_organization_id_profile_id_idx
  ON pursuit_phase_history (organization_id, profile_id, created_at DESC);

-- -------------------------------------------------------------- evidence --

CREATE TABLE evidence_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  artifact_id UUID NOT NULL,
  target_type evidence_target_type NOT NULL,
  target_id UUID NOT NULL,
  claim TEXT NOT NULL DEFAULT '',
  created_by_actor_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at TIMESTAMPTZ,
  CONSTRAINT evidence_links_organization_id_id_unique UNIQUE (organization_id, id),
  CONSTRAINT evidence_links_pair_unique UNIQUE (organization_id, artifact_id, target_type, target_id),
  CONSTRAINT evidence_links_artifact_fk FOREIGN KEY (organization_id, artifact_id)
    REFERENCES artifacts (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT evidence_links_creator_fk FOREIGN KEY (organization_id, created_by_actor_id)
    REFERENCES actors (organization_id, id) ON DELETE RESTRICT
);

CREATE INDEX evidence_links_organization_id_target_idx
  ON evidence_links (organization_id, target_type, target_id);

-- ----------------------------------------------------------- privileges --

DO $permissions$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'atlas_web')
     AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'atlas_worker') THEN
    GRANT SELECT ON
      artifacts, artifact_projects, pursuit_templates, pursuit_development_areas,
      pursuit_requirement_definitions, pursuit_profiles, pursuit_requirements,
      pursuit_phase_history, evidence_links
    TO atlas_web;
    GRANT INSERT ON
      artifacts, artifact_projects, pursuit_templates, pursuit_development_areas,
      pursuit_requirement_definitions, pursuit_profiles, pursuit_requirements,
      pursuit_phase_history, evidence_links
    TO atlas_web;
    GRANT UPDATE (
      title, description, canonical_url, mime_type, byte_size, checksum, version,
      visibility, provenance, updated_by_actor_id, updated_at, archived_at,
      archived_by_actor_id
    ) ON artifacts TO atlas_web;
    GRANT UPDATE (
      phase, site_context, corridor_context, format_hypothesis, strategic_thesis,
      economics_summary, target_open_on, updated_by_actor_id, updated_at
    ) ON pursuit_profiles TO atlas_web;
    GRANT UPDATE (
      state, notes, waiver_rationale, waived_by_actor_id, waived_at,
      updated_by_actor_id, updated_at
    ) ON pursuit_requirements TO atlas_web;
    GRANT UPDATE (archived_at) ON evidence_links TO atlas_web;
    GRANT DELETE ON artifact_projects, evidence_links TO atlas_web;

    -- Phase history and template definitions are append-only evidence.
    REVOKE UPDATE, DELETE ON pursuit_phase_history FROM atlas_web;
    REVOKE UPDATE, DELETE ON pursuit_templates, pursuit_development_areas,
      pursuit_requirement_definitions FROM atlas_web;

    REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM atlas_worker;
    GRANT SELECT ON outbox_events TO atlas_worker;
    GRANT UPDATE (
      attempt_count, available_at, processing_started_at, processing_token,
      published_at, terminal_at, last_error, updated_at
    ) ON outbox_events TO atlas_worker;
  END IF;
END
$permissions$;
