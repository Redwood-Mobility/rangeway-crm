export type AtlasRuntimeRole = "atlas_web" | "atlas_worker";

type RelationContract = {
  relation: string;
  select: boolean;
  insert: boolean;
};

export const atlasRuntimeRelations = [
  "schema_migrations",
  "organizations",
  "users",
  "actors",
  "organization_memberships",
  "audit_events",
  "outbox_events",
  "api_idempotency_keys",
] as const;

export const webUpdateColumns = {
  organizations: ["name", "updated_at"],
  users: ["email", "display_name", "google_subject", "updated_at"],
  actors: ["display_name", "updated_at", "disabled_at"],
  api_idempotency_keys: ["response_body", "completed_at"],
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
  { relation: "schema_migrations", select: false, insert: false },
  { relation: "organizations", select: true, insert: false },
  { relation: "users", select: true, insert: true },
  { relation: "actors", select: true, insert: true },
  { relation: "organization_memberships", select: true, insert: true },
  { relation: "audit_events", select: false, insert: true },
  { relation: "outbox_events", select: false, insert: true },
  { relation: "api_idempotency_keys", select: true, insert: true },
];

const workerRelations: readonly RelationContract[] = atlasRuntimeRelations.map((relation) => ({
  relation,
  select: relation === "outbox_events",
  insert: false,
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
    .map(({ relation, select, insert }) =>
      `(${sqlLiteral(relation)}, ${select ? "true" : "false"}, ${insert ? "true" : "false"})`)
    .join(",\n        ");

  return `WITH relation_contract(table_name, allow_select, allow_insert) AS (
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
        AND NOT has_table_privilege(${sqlLiteral(role)}, format('public.%I', table_name), 'DELETE')
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
