export type AtlasRuntimeRole = "atlas_web" | "atlas_worker";

type RelationContract = {
  relation: string;
  select: boolean;
  insert: boolean;
  delete: boolean;
};

const platformRelations = [
  "schema_migrations",
  "organizations",
  "users",
  "actors",
  "organization_memberships",
  "audit_events",
  "outbox_events",
  "api_idempotency_keys",
] as const;

/** Every Operating Core relation created by migration 0007. */
const operatingCoreRelations = [
  "project_rooms",
  "project_memberships",
  "project_health_updates",
  "workstreams",
  "work_items",
  "work_item_dependencies",
  "labels",
  "work_item_labels",
  "decisions",
  "decision_projects",
  "risks",
  "blockers",
  "milestones",
  "activities",
  "people",
  "counterparty_organizations",
  "person_organization_affiliations",
  "project_people",
  "project_counterparties",
  "saved_views",
] as const;

export const atlasRuntimeRelations = [
  ...platformRelations,
  ...operatingCoreRelations,
] as const;

/** Link rows are removed outright; every other relation archives in place. */
const webDeleteRelations = new Set<string>([
  "project_memberships",
  "work_item_dependencies",
  "work_item_labels",
  "decision_projects",
]);

export const webUpdateColumns = {
  organizations: ["name", "updated_at"],
  users: ["email", "display_name", "google_subject", "updated_at"],
  actors: ["display_name", "updated_at", "disabled_at"],
  api_idempotency_keys: ["response_body", "completed_at"],
  project_rooms: [
    "name", "objective", "template_type", "status", "health", "priority",
    "strategic_area", "owner_user_id", "current_focus", "blocker_summary",
    "next_decision", "next_action", "updated_by_actor_id", "updated_at",
    "archived_at", "archived_by_actor_id",
  ],
  project_memberships: ["role", "updated_at"],
  workstreams: [
    "name", "description", "owner_user_id", "status", "position",
    "updated_by_actor_id", "updated_at", "archived_at", "archived_by_actor_id",
  ],
  work_items: [
    "workstream_id", "parent_id", "type", "title", "description", "owner_user_id",
    "status", "priority", "due_at", "position", "completed_at",
    "completed_by_actor_id", "updated_by_actor_id", "updated_at", "archived_at",
    "archived_by_actor_id",
  ],
  decisions: [
    "question", "state", "outcome", "rationale", "owner_user_id", "decision_at",
    "updated_by_actor_id", "updated_at", "archived_at", "merged_into_id",
  ],
  risks: [
    "workstream_id", "title", "description", "likelihood", "impact",
    "owner_user_id", "mitigation", "state", "updated_by_actor_id", "updated_at",
    "archived_at",
  ],
  blockers: [
    "condition", "target_type", "target_id", "owner_user_id", "resolved_at",
    "updated_by_actor_id", "updated_at", "archived_at",
  ],
  milestones: [
    "workstream_id", "outcome", "owner_user_id", "target_at", "state",
    "completed_at", "calendar_event_id", "updated_by_actor_id", "updated_at",
    "archived_at",
  ],
  people: [
    "display_name", "given_name", "family_name", "email", "phone", "title",
    "notes", "provenance", "updated_by_actor_id", "updated_at", "archived_at",
    "merged_into_id", "merged_at",
  ],
  counterparty_organizations: [
    "name", "kind", "website", "notes", "provenance", "updated_by_actor_id",
    "updated_at", "archived_at", "merged_into_id", "merged_at",
  ],
  person_organization_affiliations: ["person_id", "counterparty_id", "archived_at"],
  project_people: [
    "person_id", "role", "influence", "sentiment", "relevance", "notes",
    "visibility", "updated_by_actor_id", "updated_at", "archived_at",
  ],
  project_counterparties: [
    "counterparty_id", "role", "influence", "sentiment", "relevance", "notes",
    "visibility", "updated_by_actor_id", "updated_at", "archived_at",
  ],
  saved_views: [
    "name", "surface", "filters", "is_default", "updated_by_actor_id",
    "updated_at", "archived_at",
  ],
} as const;

export const workerUpdateColumns = {
  outbox_events: [
    "attempt_count",
    "available_at",
    "processing_started_at",
    "processing_token",
    "published_at",
    "terminal_at",
    "last_error",
    "updated_at",
  ],
} as const;

const auditImmutableColumns = [
  "id",
  "organization_id",
  "actor_id",
  "request_id",
  "action",
  "resource_type",
  "resource_id",
  "before",
  "after",
  "metadata",
  "created_at",
] as const;

const outboxImmutableColumns = [
  "id",
  "organization_id",
  "actor_id",
  "request_id",
  "event_type",
  "aggregate_type",
  "aggregate_id",
  "schema_version",
  "payload",
  "created_at",
] as const;

const webRelations: readonly RelationContract[] = [
  { relation: "schema_migrations", select: false, insert: false, delete: false },
  { relation: "organizations", select: true, insert: false, delete: false },
  { relation: "users", select: true, insert: true, delete: false },
  { relation: "actors", select: true, insert: true, delete: false },
  { relation: "organization_memberships", select: true, insert: true, delete: false },
  { relation: "audit_events", select: false, insert: true, delete: false },
  { relation: "outbox_events", select: false, insert: true, delete: false },
  { relation: "api_idempotency_keys", select: true, insert: true, delete: false },
  ...operatingCoreRelations.map((relation) => ({
    relation,
    select: true,
    insert: true,
    delete: webDeleteRelations.has(relation),
  })),
];

const workerRelations: readonly RelationContract[] = atlasRuntimeRelations.map((relation) => ({
  relation,
  select: relation === "outbox_events",
  insert: false,
  delete: false,
}));

function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function updateRows(columns: Readonly<Record<string, readonly string[]>>): string {
  return Object.entries(columns)
    .flatMap(([relation, names]) => names.map((column) => `(${sqlLiteral(relation)}, ${sqlLiteral(column)})`))
    .join(",\n        ");
}

function forbiddenRows(role: AtlasRuntimeRole): string {
  const entries: Array<readonly [string, string]> = [];
  if (role === "atlas_web") {
    entries.push(...auditImmutableColumns.map((column) => ["audit_events", column] as const));
    entries.push(...outboxImmutableColumns.map((column) => ["outbox_events", column] as const));
  } else {
    entries.push(...outboxImmutableColumns.map((column) => ["outbox_events", column] as const));
  }
  return entries
    .map(([relation, column]) => `(${sqlLiteral(relation)}, ${sqlLiteral(column)})`)
    .join(",\n        ");
}

export function buildPermissionContractSql(role: AtlasRuntimeRole): string {
  const relations = role === "atlas_web" ? webRelations : workerRelations;
  const columns = role === "atlas_web" ? webUpdateColumns : workerUpdateColumns;
  const relationRows = relations
    .map(({ relation, select, insert, delete: allowDelete }) =>
      `(${sqlLiteral(relation)}, ${select ? "true" : "false"}, ${insert ? "true" : "false"}, ${allowDelete ? "true" : "false"})`)
    .join(",\n        ");

  return `WITH relation_contract(table_name, allow_select, allow_insert, allow_delete) AS (
      VALUES
        ${relationRows}
    ),
    update_contract(table_name, column_name) AS (
      VALUES
        ${updateRows(columns)}
    ),
    forbidden_update_contract(table_name, column_name) AS (
      VALUES
        ${forbiddenRows(role)}
    ),
    database_privilege_check AS (
      SELECT has_database_privilege(${sqlLiteral(role)}, current_database(), 'CONNECT')
        AND NOT has_database_privilege(${sqlLiteral(role)}, current_database(), 'CREATE')
        AND NOT has_database_privilege(${sqlLiteral(role)}, current_database(), 'TEMPORARY') AS ok
    ),
    schema_check AS (
      SELECT has_schema_privilege(${sqlLiteral(role)}, 'public', 'USAGE')
        AND NOT has_schema_privilege(${sqlLiteral(role)}, 'public', 'CREATE') AS ok
    ),
    role_attribute_check AS (
      SELECT COALESCE(bool_and(
        rolcanlogin
        AND NOT rolsuper
        AND NOT rolinherit
        AND NOT rolcreaterole
        AND NOT rolcreatedb
        AND NOT rolreplication
        AND NOT rolbypassrls
      ), false) AS ok
      FROM pg_roles
      WHERE rolname = ${sqlLiteral(role)}
    ),
    membership_check AS (
      SELECT NOT EXISTS (
        SELECT 1
        FROM pg_auth_members membership
        JOIN pg_roles member_role ON member_role.oid = membership.member
        WHERE member_role.rolname = ${sqlLiteral(role)}
      ) AS ok
    ),
    relation_checks AS (
      SELECT bool_and(
        has_table_privilege(${sqlLiteral(role)}, format('public.%I', table_name), 'SELECT') = allow_select
        AND has_table_privilege(${sqlLiteral(role)}, format('public.%I', table_name), 'INSERT') = allow_insert
        AND NOT has_table_privilege(${sqlLiteral(role)}, format('public.%I', table_name), 'UPDATE')
        AND has_table_privilege(${sqlLiteral(role)}, format('public.%I', table_name), 'DELETE') = allow_delete
        AND NOT has_table_privilege(${sqlLiteral(role)}, format('public.%I', table_name), 'TRUNCATE')
        AND NOT has_table_privilege(${sqlLiteral(role)}, format('public.%I', table_name), 'REFERENCES')
        AND NOT has_table_privilege(${sqlLiteral(role)}, format('public.%I', table_name), 'TRIGGER')
        AND has_any_column_privilege(${sqlLiteral(role)}, format('public.%I', table_name), 'UPDATE') =
          EXISTS (SELECT 1 FROM update_contract u WHERE u.table_name = relation_contract.table_name)
      ) AS ok
      FROM relation_contract
    ),
    column_checks AS (
      SELECT bool_and(
        has_column_privilege(${sqlLiteral(role)}, format('public.%I', c.table_name), c.column_name, 'UPDATE') =
          EXISTS (
            SELECT 1
              FROM update_contract u
             WHERE u.table_name = c.table_name
               AND u.column_name = c.column_name
          )
      ) AS ok
      FROM information_schema.columns c
      WHERE c.table_schema = 'public'
        AND c.table_name IN (SELECT table_name FROM relation_contract)
    ),
    forbidden_column_checks AS (
      SELECT bool_and(
        NOT has_column_privilege(${sqlLiteral(role)}, format('public.%I', table_name), column_name, 'UPDATE')
      ) AS ok
      FROM forbidden_update_contract
    )
    SELECT
      current_user = ${sqlLiteral(role)} AS role_ok,
      current_database() = 'atlas' AS database_ok,
      COALESCE((SELECT ok FROM database_privilege_check), false)
        AND COALESCE((SELECT ok FROM schema_check), false)
        AND COALESCE((SELECT ok FROM role_attribute_check), false)
        AND COALESCE((SELECT ok FROM membership_check), false)
        AND COALESCE((SELECT ok FROM relation_checks), false)
        AND COALESCE((SELECT ok FROM column_checks), false)
        AND COALESCE((SELECT ok FROM forbidden_column_checks), false) AS permissions_ok`;
}

export const webPermissionContractSql = buildPermissionContractSql("atlas_web");
export const workerPermissionContractSql = buildPermissionContractSql("atlas_worker");
