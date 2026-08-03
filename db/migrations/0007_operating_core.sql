CREATE TYPE project_status AS ENUM ('planned', 'active', 'on_hold', 'completed', 'canceled');
CREATE TYPE project_health AS ENUM ('unknown', 'on_track', 'at_risk', 'off_track');
CREATE TYPE atlas_priority AS ENUM ('low', 'medium', 'high', 'urgent');
CREATE TYPE project_role AS ENUM ('owner', 'editor', 'viewer');
CREATE TYPE workstream_status AS ENUM ('planned', 'active', 'completed', 'canceled');
CREATE TYPE work_item_type AS ENUM ('action', 'deliverable', 'follow_up', 'approval', 'research');
CREATE TYPE work_item_status AS ENUM ('inbox', 'next', 'in_progress', 'waiting', 'done', 'canceled');
CREATE TYPE decision_state AS ENUM ('proposed', 'final');
CREATE TYPE risk_likelihood AS ENUM ('low', 'medium', 'high');
CREATE TYPE risk_impact AS ENUM ('low', 'medium', 'high', 'critical');
CREATE TYPE risk_state AS ENUM ('open', 'mitigating', 'accepted', 'closed');
CREATE TYPE blocker_target_type AS ENUM ('project', 'workstream', 'work_item', 'requirement');
CREATE TYPE milestone_state AS ENUM ('planned', 'completed', 'canceled');
CREATE TYPE relationship_influence AS ENUM ('low', 'medium', 'high');
CREATE TYPE relationship_sentiment AS ENUM ('negative', 'neutral', 'positive', 'unknown');

CREATE TABLE project_rooms (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  objective TEXT NOT NULL DEFAULT '',
  template_type TEXT NOT NULL DEFAULT 'general' CHECK (char_length(template_type) BETWEEN 1 AND 100),
  status project_status NOT NULL DEFAULT 'planned',
  health project_health NOT NULL DEFAULT 'unknown',
  priority atlas_priority NOT NULL DEFAULT 'medium',
  strategic_area TEXT NOT NULL DEFAULT '',
  owner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  current_focus TEXT NOT NULL DEFAULT '',
  blocker_summary TEXT NOT NULL DEFAULT '',
  next_decision TEXT NOT NULL DEFAULT '',
  next_action TEXT NOT NULL DEFAULT '',
  created_by_actor_id UUID NOT NULL,
  updated_by_actor_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at TIMESTAMPTZ,
  archived_by_actor_id UUID,
  CONSTRAINT project_rooms_organization_id_id_unique UNIQUE (organization_id, id),
  CONSTRAINT project_rooms_organization_creator_fk FOREIGN KEY (organization_id, created_by_actor_id)
    REFERENCES actors (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT project_rooms_organization_updater_fk FOREIGN KEY (organization_id, updated_by_actor_id)
    REFERENCES actors (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT project_rooms_organization_archiver_fk FOREIGN KEY (organization_id, archived_by_actor_id)
    REFERENCES actors (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT project_rooms_owner_membership_fk FOREIGN KEY (organization_id, owner_user_id)
    REFERENCES organization_memberships (organization_id, user_id) ON DELETE RESTRICT
);
CREATE INDEX project_rooms_organization_id_created_at_idx
  ON project_rooms (organization_id, created_at DESC, id DESC);
CREATE INDEX project_rooms_organization_id_owner_idx
  ON project_rooms (organization_id, owner_user_id, status, health) WHERE archived_at IS NULL;
CREATE INDEX project_rooms_search_idx ON project_rooms USING GIN (
  to_tsvector('english', name || ' ' || objective || ' ' || strategic_area || ' ' || current_focus)
);

CREATE TABLE project_memberships (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  project_id UUID NOT NULL,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  role project_role NOT NULL,
  created_by_actor_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT project_memberships_organization_id_id_unique UNIQUE (organization_id, id),
  CONSTRAINT project_memberships_project_user_unique UNIQUE (organization_id, project_id, user_id),
  CONSTRAINT project_memberships_project_fk FOREIGN KEY (organization_id, project_id)
    REFERENCES project_rooms (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT project_memberships_creator_fk FOREIGN KEY (organization_id, created_by_actor_id)
    REFERENCES actors (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT project_memberships_organization_membership_fk FOREIGN KEY (organization_id, user_id)
    REFERENCES organization_memberships (organization_id, user_id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX project_memberships_organization_id_project_user_idx
  ON project_memberships (organization_id, project_id, user_id);

CREATE TABLE project_health_updates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  project_id UUID NOT NULL,
  health project_health NOT NULL,
  rationale TEXT NOT NULL,
  reporting_period DATERANGE,
  source_cutoff TIMESTAMPTZ,
  created_by_actor_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT project_health_updates_organization_id_id_unique UNIQUE (organization_id, id),
  CONSTRAINT project_health_updates_project_fk FOREIGN KEY (organization_id, project_id)
    REFERENCES project_rooms (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT project_health_updates_creator_fk FOREIGN KEY (organization_id, created_by_actor_id)
    REFERENCES actors (organization_id, id) ON DELETE RESTRICT
);
CREATE INDEX project_health_updates_organization_id_project_created_idx
  ON project_health_updates (organization_id, project_id, created_at DESC, id DESC);

CREATE TABLE workstreams (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  project_id UUID NOT NULL,
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  description TEXT NOT NULL DEFAULT '',
  owner_user_id UUID REFERENCES users(id) ON DELETE RESTRICT,
  status workstream_status NOT NULL DEFAULT 'planned',
  position NUMERIC(20, 8) NOT NULL DEFAULT 0,
  created_by_actor_id UUID NOT NULL,
  updated_by_actor_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at TIMESTAMPTZ,
  archived_by_actor_id UUID,
  CONSTRAINT workstreams_organization_id_id_unique UNIQUE (organization_id, id),
  CONSTRAINT workstreams_project_fk FOREIGN KEY (organization_id, project_id)
    REFERENCES project_rooms (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT workstreams_creator_fk FOREIGN KEY (organization_id, created_by_actor_id)
    REFERENCES actors (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT workstreams_updater_fk FOREIGN KEY (organization_id, updated_by_actor_id)
    REFERENCES actors (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT workstreams_archiver_fk FOREIGN KEY (organization_id, archived_by_actor_id)
    REFERENCES actors (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT workstreams_owner_membership_fk FOREIGN KEY (organization_id, owner_user_id)
    REFERENCES organization_memberships (organization_id, user_id) ON DELETE RESTRICT
);
CREATE INDEX workstreams_organization_id_project_position_idx
  ON workstreams (organization_id, project_id, position, id) WHERE archived_at IS NULL;

CREATE TABLE labels (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  color TEXT NOT NULL DEFAULT '#64748b' CHECK (color ~ '^#[0-9A-Fa-f]{6}$'),
  created_by_actor_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at TIMESTAMPTZ,
  CONSTRAINT labels_organization_id_id_unique UNIQUE (organization_id, id),
  CONSTRAINT labels_organization_name_unique UNIQUE (organization_id, name),
  CONSTRAINT labels_creator_fk FOREIGN KEY (organization_id, created_by_actor_id)
    REFERENCES actors (organization_id, id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX labels_organization_id_name_idx
  ON labels (organization_id, lower(name)) WHERE archived_at IS NULL;

CREATE TABLE work_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  project_id UUID NOT NULL,
  workstream_id UUID,
  parent_id UUID,
  type work_item_type NOT NULL,
  title TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 300),
  description TEXT NOT NULL DEFAULT '',
  owner_user_id UUID REFERENCES users(id) ON DELETE RESTRICT,
  status work_item_status NOT NULL DEFAULT 'inbox',
  priority atlas_priority NOT NULL DEFAULT 'medium',
  due_at TIMESTAMPTZ,
  position NUMERIC(20, 8) NOT NULL DEFAULT 0,
  completed_at TIMESTAMPTZ,
  completed_by_actor_id UUID,
  created_by_actor_id UUID NOT NULL,
  updated_by_actor_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at TIMESTAMPTZ,
  archived_by_actor_id UUID,
  CONSTRAINT work_items_organization_id_id_unique UNIQUE (organization_id, id),
  CONSTRAINT work_items_project_fk FOREIGN KEY (organization_id, project_id)
    REFERENCES project_rooms (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT work_items_workstream_fk FOREIGN KEY (organization_id, workstream_id)
    REFERENCES workstreams (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT work_items_parent_fk FOREIGN KEY (organization_id, parent_id)
    REFERENCES work_items (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT work_items_creator_fk FOREIGN KEY (organization_id, created_by_actor_id)
    REFERENCES actors (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT work_items_updater_fk FOREIGN KEY (organization_id, updated_by_actor_id)
    REFERENCES actors (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT work_items_completer_fk FOREIGN KEY (organization_id, completed_by_actor_id)
    REFERENCES actors (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT work_items_archiver_fk FOREIGN KEY (organization_id, archived_by_actor_id)
    REFERENCES actors (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT work_items_completion_shape_check CHECK (
    (status = 'done' AND completed_at IS NOT NULL AND completed_by_actor_id IS NOT NULL)
    OR (status <> 'done' AND completed_at IS NULL AND completed_by_actor_id IS NULL)
  ),
  CONSTRAINT work_items_not_self_parent_check CHECK (parent_id IS NULL OR parent_id <> id),
  CONSTRAINT work_items_owner_membership_fk FOREIGN KEY (organization_id, owner_user_id)
    REFERENCES organization_memberships (organization_id, user_id) ON DELETE RESTRICT
);
CREATE INDEX work_items_organization_id_project_status_position_idx
  ON work_items (organization_id, project_id, status, position, id) WHERE archived_at IS NULL;
CREATE INDEX work_items_organization_id_owner_due_idx
  ON work_items (organization_id, owner_user_id, due_at, id) WHERE archived_at IS NULL;
CREATE INDEX work_items_search_idx ON work_items USING GIN (
  to_tsvector('english', title || ' ' || description)
);

CREATE TABLE work_item_dependencies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  blocked_work_item_id UUID NOT NULL,
  dependency_work_item_id UUID NOT NULL,
  created_by_actor_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT work_item_dependencies_organization_id_id_unique UNIQUE (organization_id, id),
  CONSTRAINT work_item_dependencies_pair_unique UNIQUE (organization_id, blocked_work_item_id, dependency_work_item_id),
  CONSTRAINT work_item_dependencies_blocked_fk FOREIGN KEY (organization_id, blocked_work_item_id)
    REFERENCES work_items (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT work_item_dependencies_dependency_fk FOREIGN KEY (organization_id, dependency_work_item_id)
    REFERENCES work_items (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT work_item_dependencies_creator_fk FOREIGN KEY (organization_id, created_by_actor_id)
    REFERENCES actors (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT work_item_dependencies_not_self_check CHECK (blocked_work_item_id <> dependency_work_item_id)
);
CREATE UNIQUE INDEX work_item_dependencies_organization_id_pair_idx
  ON work_item_dependencies (organization_id, blocked_work_item_id, dependency_work_item_id);

CREATE TABLE work_item_labels (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  work_item_id UUID NOT NULL,
  label_id UUID NOT NULL,
  created_by_actor_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT work_item_labels_organization_id_id_unique UNIQUE (organization_id, id),
  CONSTRAINT work_item_labels_pair_unique UNIQUE (organization_id, work_item_id, label_id),
  CONSTRAINT work_item_labels_work_item_fk FOREIGN KEY (organization_id, work_item_id)
    REFERENCES work_items (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT work_item_labels_label_fk FOREIGN KEY (organization_id, label_id)
    REFERENCES labels (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT work_item_labels_creator_fk FOREIGN KEY (organization_id, created_by_actor_id)
    REFERENCES actors (organization_id, id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX work_item_labels_organization_id_pair_idx
  ON work_item_labels (organization_id, work_item_id, label_id);

CREATE TABLE decisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  primary_project_id UUID NOT NULL,
  question TEXT NOT NULL CHECK (char_length(question) BETWEEN 1 AND 1000),
  state decision_state NOT NULL DEFAULT 'proposed',
  outcome TEXT NOT NULL DEFAULT '',
  rationale TEXT NOT NULL DEFAULT '',
  owner_user_id UUID REFERENCES users(id) ON DELETE RESTRICT,
  decision_at TIMESTAMPTZ,
  created_by_actor_id UUID NOT NULL,
  updated_by_actor_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at TIMESTAMPTZ,
  merged_into_id UUID,
  CONSTRAINT decisions_organization_id_id_unique UNIQUE (organization_id, id),
  CONSTRAINT decisions_primary_project_fk FOREIGN KEY (organization_id, primary_project_id)
    REFERENCES project_rooms (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT decisions_creator_fk FOREIGN KEY (organization_id, created_by_actor_id)
    REFERENCES actors (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT decisions_updater_fk FOREIGN KEY (organization_id, updated_by_actor_id)
    REFERENCES actors (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT decisions_merge_fk FOREIGN KEY (organization_id, merged_into_id)
    REFERENCES decisions (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT decisions_owner_membership_fk FOREIGN KEY (organization_id, owner_user_id)
    REFERENCES organization_memberships (organization_id, user_id) ON DELETE RESTRICT
);
CREATE INDEX decisions_organization_id_project_created_idx
  ON decisions (organization_id, primary_project_id, created_at DESC, id DESC) WHERE archived_at IS NULL;

CREATE TABLE decision_projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  decision_id UUID NOT NULL,
  project_id UUID NOT NULL,
  created_by_actor_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT decision_projects_organization_id_id_unique UNIQUE (organization_id, id),
  CONSTRAINT decision_projects_pair_unique UNIQUE (organization_id, decision_id, project_id),
  CONSTRAINT decision_projects_decision_fk FOREIGN KEY (organization_id, decision_id)
    REFERENCES decisions (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT decision_projects_project_fk FOREIGN KEY (organization_id, project_id)
    REFERENCES project_rooms (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT decision_projects_creator_fk FOREIGN KEY (organization_id, created_by_actor_id)
    REFERENCES actors (organization_id, id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX decision_projects_organization_id_pair_idx
  ON decision_projects (organization_id, decision_id, project_id);

CREATE TABLE risks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  project_id UUID NOT NULL,
  workstream_id UUID,
  title TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 300),
  description TEXT NOT NULL DEFAULT '',
  likelihood risk_likelihood NOT NULL,
  impact risk_impact NOT NULL,
  owner_user_id UUID REFERENCES users(id) ON DELETE RESTRICT,
  mitigation TEXT NOT NULL DEFAULT '',
  state risk_state NOT NULL DEFAULT 'open',
  created_by_actor_id UUID NOT NULL,
  updated_by_actor_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at TIMESTAMPTZ,
  CONSTRAINT risks_organization_id_id_unique UNIQUE (organization_id, id),
  CONSTRAINT risks_project_fk FOREIGN KEY (organization_id, project_id)
    REFERENCES project_rooms (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT risks_workstream_fk FOREIGN KEY (organization_id, workstream_id)
    REFERENCES workstreams (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT risks_creator_fk FOREIGN KEY (organization_id, created_by_actor_id)
    REFERENCES actors (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT risks_updater_fk FOREIGN KEY (organization_id, updated_by_actor_id)
    REFERENCES actors (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT risks_owner_membership_fk FOREIGN KEY (organization_id, owner_user_id)
    REFERENCES organization_memberships (organization_id, user_id) ON DELETE RESTRICT
);
CREATE INDEX risks_organization_id_project_created_idx
  ON risks (organization_id, project_id, created_at DESC, id DESC) WHERE archived_at IS NULL;

CREATE TABLE blockers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  project_id UUID NOT NULL,
  condition TEXT NOT NULL CHECK (char_length(condition) BETWEEN 1 AND 1000),
  target_type blocker_target_type NOT NULL,
  target_id UUID NOT NULL,
  owner_user_id UUID REFERENCES users(id) ON DELETE RESTRICT,
  resolved_at TIMESTAMPTZ,
  created_by_actor_id UUID NOT NULL,
  updated_by_actor_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at TIMESTAMPTZ,
  CONSTRAINT blockers_organization_id_id_unique UNIQUE (organization_id, id),
  CONSTRAINT blockers_project_fk FOREIGN KEY (organization_id, project_id)
    REFERENCES project_rooms (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT blockers_creator_fk FOREIGN KEY (organization_id, created_by_actor_id)
    REFERENCES actors (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT blockers_updater_fk FOREIGN KEY (organization_id, updated_by_actor_id)
    REFERENCES actors (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT blockers_owner_membership_fk FOREIGN KEY (organization_id, owner_user_id)
    REFERENCES organization_memberships (organization_id, user_id) ON DELETE RESTRICT
);
CREATE INDEX blockers_organization_id_project_created_idx
  ON blockers (organization_id, project_id, created_at DESC, id DESC) WHERE archived_at IS NULL;
CREATE INDEX blockers_organization_id_target_idx
  ON blockers (organization_id, target_type, target_id) WHERE archived_at IS NULL AND resolved_at IS NULL;

CREATE TABLE milestones (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  project_id UUID NOT NULL,
  workstream_id UUID,
  outcome TEXT NOT NULL CHECK (char_length(outcome) BETWEEN 1 AND 500),
  owner_user_id UUID REFERENCES users(id) ON DELETE RESTRICT,
  target_at TIMESTAMPTZ NOT NULL,
  state milestone_state NOT NULL DEFAULT 'planned',
  completed_at TIMESTAMPTZ,
  calendar_event_id TEXT,
  created_by_actor_id UUID NOT NULL,
  updated_by_actor_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at TIMESTAMPTZ,
  CONSTRAINT milestones_organization_id_id_unique UNIQUE (organization_id, id),
  CONSTRAINT milestones_project_fk FOREIGN KEY (organization_id, project_id)
    REFERENCES project_rooms (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT milestones_workstream_fk FOREIGN KEY (organization_id, workstream_id)
    REFERENCES workstreams (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT milestones_creator_fk FOREIGN KEY (organization_id, created_by_actor_id)
    REFERENCES actors (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT milestones_updater_fk FOREIGN KEY (organization_id, updated_by_actor_id)
    REFERENCES actors (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT milestones_completion_shape_check CHECK (
    (state = 'completed' AND completed_at IS NOT NULL) OR (state <> 'completed' AND completed_at IS NULL)
  ),
  CONSTRAINT milestones_owner_membership_fk FOREIGN KEY (organization_id, owner_user_id)
    REFERENCES organization_memberships (organization_id, user_id) ON DELETE RESTRICT
);
CREATE INDEX milestones_organization_id_project_target_idx
  ON milestones (organization_id, project_id, target_at, id) WHERE archived_at IS NULL;

CREATE TABLE activities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  project_id UUID NOT NULL,
  activity_type TEXT NOT NULL DEFAULT 'note' CHECK (char_length(activity_type) BETWEEN 1 AND 80),
  body TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND 5000),
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by_actor_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at TIMESTAMPTZ,
  CONSTRAINT activities_organization_id_id_unique UNIQUE (organization_id, id),
  CONSTRAINT activities_project_fk FOREIGN KEY (organization_id, project_id)
    REFERENCES project_rooms (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT activities_creator_fk FOREIGN KEY (organization_id, created_by_actor_id)
    REFERENCES actors (organization_id, id) ON DELETE RESTRICT
);
CREATE INDEX activities_organization_id_project_occurred_idx
  ON activities (organization_id, project_id, occurred_at DESC, id DESC) WHERE archived_at IS NULL;

CREATE TABLE people (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  display_name TEXT NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 200),
  given_name TEXT NOT NULL DEFAULT '',
  family_name TEXT NOT NULL DEFAULT '',
  email CITEXT,
  phone TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  provenance JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(provenance) = 'object'),
  created_by_actor_id UUID NOT NULL,
  updated_by_actor_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at TIMESTAMPTZ,
  merged_into_id UUID,
  merged_at TIMESTAMPTZ,
  CONSTRAINT people_organization_id_id_unique UNIQUE (organization_id, id),
  CONSTRAINT people_creator_fk FOREIGN KEY (organization_id, created_by_actor_id)
    REFERENCES actors (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT people_updater_fk FOREIGN KEY (organization_id, updated_by_actor_id)
    REFERENCES actors (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT people_merge_fk FOREIGN KEY (organization_id, merged_into_id)
    REFERENCES people (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT people_merge_shape_check CHECK (
    (merged_into_id IS NULL AND merged_at IS NULL) OR (merged_into_id IS NOT NULL AND merged_at IS NOT NULL)
  )
);
CREATE INDEX people_organization_id_created_at_idx
  ON people (organization_id, created_at DESC, id DESC) WHERE archived_at IS NULL AND merged_at IS NULL;
CREATE INDEX people_search_idx ON people USING GIN (
  to_tsvector('english', display_name || ' ' || given_name || ' ' || family_name || ' ' || coalesce(email::text, '') || ' ' || title)
);

CREATE TABLE counterparty_organizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  kind TEXT NOT NULL DEFAULT 'other' CHECK (char_length(kind) BETWEEN 1 AND 80),
  website TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  provenance JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(provenance) = 'object'),
  created_by_actor_id UUID NOT NULL,
  updated_by_actor_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at TIMESTAMPTZ,
  merged_into_id UUID,
  merged_at TIMESTAMPTZ,
  CONSTRAINT counterparty_organizations_organization_id_id_unique UNIQUE (organization_id, id),
  CONSTRAINT counterparty_organizations_creator_fk FOREIGN KEY (organization_id, created_by_actor_id)
    REFERENCES actors (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT counterparty_organizations_updater_fk FOREIGN KEY (organization_id, updated_by_actor_id)
    REFERENCES actors (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT counterparty_organizations_merge_fk FOREIGN KEY (organization_id, merged_into_id)
    REFERENCES counterparty_organizations (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT counterparty_organizations_merge_shape_check CHECK (
    (merged_into_id IS NULL AND merged_at IS NULL) OR (merged_into_id IS NOT NULL AND merged_at IS NOT NULL)
  )
);
CREATE INDEX counterparty_organizations_organization_id_created_at_idx
  ON counterparty_organizations (organization_id, created_at DESC, id DESC) WHERE archived_at IS NULL AND merged_at IS NULL;
CREATE INDEX counterparty_organizations_search_idx ON counterparty_organizations USING GIN (
  to_tsvector('english', name || ' ' || kind || ' ' || website)
);

CREATE TABLE person_organization_affiliations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  person_id UUID NOT NULL,
  counterparty_id UUID NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  is_primary BOOLEAN NOT NULL DEFAULT false,
  starts_on DATE,
  ends_on DATE,
  provenance JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(provenance) = 'object'),
  created_by_actor_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at TIMESTAMPTZ,
  CONSTRAINT person_organization_affiliations_organization_id_id_unique UNIQUE (organization_id, id),
  CONSTRAINT person_organization_affiliations_person_fk FOREIGN KEY (organization_id, person_id)
    REFERENCES people (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT person_organization_affiliations_counterparty_fk FOREIGN KEY (organization_id, counterparty_id)
    REFERENCES counterparty_organizations (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT person_organization_affiliations_creator_fk FOREIGN KEY (organization_id, created_by_actor_id)
    REFERENCES actors (organization_id, id) ON DELETE RESTRICT
);
CREATE INDEX person_organization_affiliations_organization_id_person_idx
  ON person_organization_affiliations (organization_id, person_id, counterparty_id) WHERE archived_at IS NULL;

CREATE TABLE project_people (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  project_id UUID NOT NULL,
  person_id UUID NOT NULL,
  role TEXT NOT NULL DEFAULT '',
  influence relationship_influence NOT NULL DEFAULT 'medium',
  sentiment relationship_sentiment NOT NULL DEFAULT 'unknown',
  relevance TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  visibility TEXT NOT NULL DEFAULT 'project' CHECK (visibility IN ('project', 'private')),
  created_by_actor_id UUID NOT NULL,
  updated_by_actor_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at TIMESTAMPTZ,
  CONSTRAINT project_people_organization_id_id_unique UNIQUE (organization_id, id),
  CONSTRAINT project_people_pair_unique UNIQUE (organization_id, project_id, person_id),
  CONSTRAINT project_people_project_fk FOREIGN KEY (organization_id, project_id)
    REFERENCES project_rooms (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT project_people_person_fk FOREIGN KEY (organization_id, person_id)
    REFERENCES people (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT project_people_creator_fk FOREIGN KEY (organization_id, created_by_actor_id)
    REFERENCES actors (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT project_people_updater_fk FOREIGN KEY (organization_id, updated_by_actor_id)
    REFERENCES actors (organization_id, id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX project_people_organization_id_pair_idx
  ON project_people (organization_id, project_id, person_id) WHERE archived_at IS NULL;

CREATE TABLE project_counterparties (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  project_id UUID NOT NULL,
  counterparty_id UUID NOT NULL,
  role TEXT NOT NULL DEFAULT '',
  influence relationship_influence NOT NULL DEFAULT 'medium',
  sentiment relationship_sentiment NOT NULL DEFAULT 'unknown',
  relevance TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  visibility TEXT NOT NULL DEFAULT 'project' CHECK (visibility IN ('project', 'private')),
  created_by_actor_id UUID NOT NULL,
  updated_by_actor_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at TIMESTAMPTZ,
  CONSTRAINT project_counterparties_organization_id_id_unique UNIQUE (organization_id, id),
  CONSTRAINT project_counterparties_pair_unique UNIQUE (organization_id, project_id, counterparty_id),
  CONSTRAINT project_counterparties_project_fk FOREIGN KEY (organization_id, project_id)
    REFERENCES project_rooms (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT project_counterparties_counterparty_fk FOREIGN KEY (organization_id, counterparty_id)
    REFERENCES counterparty_organizations (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT project_counterparties_creator_fk FOREIGN KEY (organization_id, created_by_actor_id)
    REFERENCES actors (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT project_counterparties_updater_fk FOREIGN KEY (organization_id, updated_by_actor_id)
    REFERENCES actors (organization_id, id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX project_counterparties_organization_id_pair_idx
  ON project_counterparties (organization_id, project_id, counterparty_id) WHERE archived_at IS NULL;

CREATE TABLE saved_views (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  owner_actor_id UUID NOT NULL,
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  surface TEXT NOT NULL CHECK (surface IN ('projects', 'work', 'people', 'portfolio')),
  filters JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(filters) = 'object'),
  is_default BOOLEAN NOT NULL DEFAULT false,
  created_by_actor_id UUID NOT NULL,
  updated_by_actor_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at TIMESTAMPTZ,
  CONSTRAINT saved_views_organization_id_id_unique UNIQUE (organization_id, id),
  CONSTRAINT saved_views_owner_fk FOREIGN KEY (organization_id, owner_actor_id)
    REFERENCES actors (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT saved_views_creator_fk FOREIGN KEY (organization_id, created_by_actor_id)
    REFERENCES actors (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT saved_views_updater_fk FOREIGN KEY (organization_id, updated_by_actor_id)
    REFERENCES actors (organization_id, id) ON DELETE RESTRICT
);
CREATE INDEX saved_views_organization_id_owner_created_idx
  ON saved_views (organization_id, owner_actor_id, created_at DESC, id DESC) WHERE archived_at IS NULL;
