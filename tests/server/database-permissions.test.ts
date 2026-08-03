import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import type { Pool } from "pg";
import { describe, expect, it, type TestContext } from "vitest";
import { createPool } from "../../src/server/platform/db/client.js";
import { runMigrations } from "../../src/server/platform/db/migrate.js";
import { IdentityService } from "../../src/server/modules/identity/identity.service.js";
import { provisionProductionOwnerWithPool } from "../../src/server/platform/db/provision-production-owner.js";
import {
  buildPermissionContractSql,
  webUpdateColumns,
  workerUpdateColumns,
} from "../../src/shared/database-permission-contract.js";
import {
  createTemporaryDatabase,
  PostgreSqlUnavailableError,
} from "../helpers/database.js";

async function source(relativePath: string): Promise<string> {
  return readFile(new URL(`../../${relativePath}`, import.meta.url), "utf8");
}

async function withTemporaryPostgreSql(
  context: TestContext,
  operation: (pool: Pool) => Promise<void>,
): Promise<void> {
  let temporaryDatabase;
  try {
    temporaryDatabase = await createTemporaryDatabase();
  } catch (error) {
    if (error instanceof PostgreSqlUnavailableError) {
      context.skip(error.message);
      return;
    }
    throw error;
  }
  const pool = createPool(temporaryDatabase.databaseUrl);
  try {
    await pool.query(`DO $roles$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'atlas_web') THEN
          CREATE ROLE atlas_web NOLOGIN;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'atlas_worker') THEN
          CREATE ROLE atlas_worker NOLOGIN;
        END IF;
      END
    $roles$`);
    await runMigrations(pool);
    await operation(pool);
  } finally {
    await pool.end();
    await temporaryDatabase.cleanup();
  }
}

describe("least-privilege PostgreSQL roles", () => {
  it("adds an exact runtime grant migration without changing prior migrations", async () => {
    const migration = await source("db/migrations/0005_exact_runtime_permissions.sql").catch(() => "");

    expect(migration).toContain("REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM atlas_web");
    expect(migration).toMatch(/GRANT SELECT ON\s+organizations,\s+users,\s+actors,\s+organization_memberships,\s+api_idempotency_keys\s+TO atlas_web/);
    expect(migration).toMatch(/GRANT INSERT ON\s+users,\s+actors,\s+organization_memberships,\s+audit_events,\s+outbox_events,\s+api_idempotency_keys\s+TO atlas_web/);
    expect(migration).toMatch(/GRANT UPDATE \(name, updated_at\) ON organizations TO atlas_web/);
    expect(migration).toMatch(/GRANT UPDATE \(email, display_name, google_subject, updated_at\) ON users TO atlas_web/);
    expect(migration).toMatch(/GRANT UPDATE \(display_name, updated_at, disabled_at\) ON actors TO atlas_web/);
    expect(migration).toMatch(/GRANT UPDATE \(response_body, completed_at\) ON api_idempotency_keys TO atlas_web/);
    expect(migration).toMatch(/GRANT SELECT ON outbox_events TO atlas_worker/);
    expect(migration).toMatch(/GRANT UPDATE\s*\([\s\S]*attempt_count[\s\S]*updated_at[\s\S]*\)\s*ON outbox_events TO atlas_worker/);
  });

  it("fails the shared readiness contract for drift in every required grant and critical forbidden surface", async (context) => {
    await withTemporaryPostgreSql(context, async (pool) => {
      const readiness = async (role: "atlas_web" | "atlas_worker") => {
        const client = await pool.connect();
        try {
          await client.query(`SET ROLE ${role}`);
          const result = await client.query<{ permissions_ok: boolean }>(
            buildPermissionContractSql(role),
          );
          return result.rows[0]?.permissions_ok === true;
        } finally {
          await client.query("RESET ROLE").catch(() => undefined);
          client.release();
        }
      };
      const driftRequiredTableGrant = async (
        role: "atlas_web" | "atlas_worker",
        privilege: "SELECT" | "INSERT",
        relation: string,
      ) => {
        await pool.query(`REVOKE ${privilege} ON ${relation} FROM ${role}`);
        await expect(readiness(role), `${role} ${privilege} ${relation}`).resolves.toBe(false);
        await pool.query(`GRANT ${privilege} ON ${relation} TO ${role}`);
      };
      const driftRequiredColumnGrant = async (
        role: "atlas_web" | "atlas_worker",
        relation: string,
        column: string,
      ) => {
        await pool.query(`REVOKE UPDATE (${column}) ON ${relation} FROM ${role}`);
        await expect(readiness(role), `${role} UPDATE ${relation}.${column}`).resolves.toBe(false);
        await pool.query(`GRANT UPDATE (${column}) ON ${relation} TO ${role}`);
      };

      for (const relation of [
        "organizations",
        "users",
        "actors",
        "organization_memberships",
        "api_idempotency_keys",
      ]) {
        await driftRequiredTableGrant("atlas_web", "SELECT", relation);
      }
      for (const relation of [
        "users",
        "actors",
        "organization_memberships",
        "audit_events",
        "outbox_events",
        "api_idempotency_keys",
      ]) {
        await driftRequiredTableGrant("atlas_web", "INSERT", relation);
      }
      for (const [relation, columns] of Object.entries(webUpdateColumns)) {
        for (const column of columns) {
          await driftRequiredColumnGrant("atlas_web", relation, column);
        }
      }
      await driftRequiredTableGrant("atlas_worker", "SELECT", "outbox_events");
      for (const column of workerUpdateColumns.outbox_events) {
        await driftRequiredColumnGrant("atlas_worker", "outbox_events", column);
      }

      for (const statement of [
        "GRANT SELECT ON schema_migrations TO atlas_web",
        "GRANT UPDATE (action) ON audit_events TO atlas_web",
        "GRANT UPDATE (payload) ON outbox_events TO atlas_web",
      ]) {
        await pool.query(statement);
        await expect(readiness("atlas_web"), statement).resolves.toBe(false);
        await pool.query(statement.replace("GRANT", "REVOKE").replace(" TO ", " FROM "));
      }
      for (const statement of [
        "GRANT SELECT ON audit_events TO atlas_worker",
        "GRANT UPDATE (payload) ON outbox_events TO atlas_worker",
        "GRANT UPDATE (organization_id) ON outbox_events TO atlas_worker",
      ]) {
        await pool.query(statement);
        await expect(readiness("atlas_worker"), statement).resolves.toBe(false);
        await pool.query(statement.replace("GRANT", "REVOKE").replace(" TO ", " FROM "));
      }
      await expect(readiness("atlas_web")).resolves.toBe(true);
      await expect(readiness("atlas_worker")).resolves.toBe(true);
    });
  });

  it("narrows worker outbox updates to worker-managed columns in an additive migration", async () => {
    const migration = await source("db/migrations/0004_worker_outbox_permissions.sql");
    expect(migration).toContain("REVOKE UPDATE ON outbox_events FROM atlas_worker");
    expect(migration).toMatch(/GRANT UPDATE\s*\([\s\S]*attempt_count[\s\S]*available_at[\s\S]*processing_started_at[\s\S]*processing_token[\s\S]*published_at[\s\S]*terminal_at[\s\S]*last_error[\s\S]*updated_at[\s\S]*\)\s*ON outbox_events TO atlas_worker/);
    for (const immutableColumn of [
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
    ]) {
      const grant = migration.slice(migration.indexOf("GRANT UPDATE"));
      expect(grant).not.toMatch(new RegExp(`\\b${immutableColumn}\\b`));
    }
  });

  it("defines separate bootstrap, migrator, web, and worker credentials without embedding secrets", async () => {
    const [compose, environment, bootstrap] = await Promise.all([
      source("docker-compose.yml"),
      source("deploy/env.production.example"),
      source("deploy/postgres/init-roles.sh").catch(() => ""),
    ]);

    for (const role of ["atlas", "atlas_migrator", "atlas_web", "atlas_worker"]) {
      expect(`${compose}\n${bootstrap}`).toContain(role);
    }
    expect(bootstrap).toContain("ALTER TABLE %I.%I OWNER TO atlas_migrator");
    expect(bootstrap).toContain("ALTER FUNCTION public.atlas_reject_audit_mutation() OWNER TO atlas_migrator");
    expect(bootstrap).toContain("CREATE EXTENSION IF NOT EXISTS citext");
    expect(bootstrap).toContain("CREATE EXTENSION IF NOT EXISTS pgcrypto");
    expect(bootstrap).toMatch(/citext[\s\S]*pgcrypto[\s\S]*bootstrap-owned|bootstrap-owned[\s\S]*citext[\s\S]*pgcrypto/i);
    for (const variable of [
      "POSTGRES_BOOTSTRAP_PASSWORD",
      "ATLAS_MIGRATOR_PASSWORD",
      "ATLAS_WEB_PASSWORD",
      "ATLAS_WORKER_PASSWORD",
    ]) {
      expect(environment).toContain(`${variable}=REPLACE_WITH_`);
    }
    expect(compose).not.toMatch(/REPLACE_WITH_|correct-horse|rangeway-dev/);
  });

  it("upgrades a bootstrap-owned 0001-0004 layout through the real role initializer", async (context) => {
    if (spawnSync("psql", ["--version"], { encoding: "utf8" }).status !== 0) {
      context.skip("psql is unavailable; equipped ownership-upgrade test skipped.");
      return;
    }
    let temporaryDatabase;
    try {
      temporaryDatabase = await createTemporaryDatabase();
    } catch (error) {
      if (error instanceof PostgreSqlUnavailableError) {
        context.skip(error.message);
        return;
      }
      throw error;
    }

    const databaseUrl = new URL(temporaryDatabase.databaseUrl);
    if (decodeURIComponent(databaseUrl.username) !== "atlas") {
      await temporaryDatabase.cleanup();
      context.skip("Equipped ownership-upgrade test requires the bootstrap atlas role.");
      return;
    }
    const pool = createPool(temporaryDatabase.databaseUrl);
    try {
      await runMigrations(pool);
      const initialized = spawnSync("bash", ["deploy/postgres/init-roles.sh"], {
        cwd: new URL("../..", import.meta.url),
        encoding: "utf8",
        env: {
          ...process.env,
          PGHOST: databaseUrl.hostname,
          PGPORT: databaseUrl.port || "5432",
          PGPASSWORD: decodeURIComponent(databaseUrl.password),
          POSTGRES_USER: "atlas",
          POSTGRES_DB: databaseUrl.pathname.slice(1),
          POSTGRES_BOOTSTRAP_PASSWORD: "bootstrap-upgrade-password-01",
          ATLAS_MIGRATOR_PASSWORD: "migrator-upgrade-password-02",
          ATLAS_WEB_PASSWORD: "web-upgrade-password-000003",
          ATLAS_WORKER_PASSWORD: "worker-upgrade-password-0004",
          PGAPPNAME: "atlas-deploy-10000000-0000-4000-8000-000000000001",
        },
      });
      expect(initialized.status, `${initialized.stdout}\n${initialized.stderr}`).toBe(0);

      const ownership = await pool.query<{ object_name: string; owner: string }>(`
        SELECT c.relname AS object_name, r.rolname AS owner
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
          JOIN pg_roles r ON r.oid = c.relowner
         WHERE n.nspname = 'public'
           AND c.relname IN ('organizations', 'schema_migrations', 'audit_events')
        UNION ALL
        SELECT p.proname, r.rolname
          FROM pg_proc p
          JOIN pg_namespace n ON n.oid = p.pronamespace
          JOIN pg_roles r ON r.oid = p.proowner
         WHERE n.nspname = 'public' AND p.proname = 'atlas_reject_audit_mutation'
        ORDER BY object_name
      `);
      expect(ownership.rows).toEqual([
        { object_name: "atlas_reject_audit_mutation", owner: "atlas_migrator" },
        { object_name: "audit_events", owner: "atlas_migrator" },
        { object_name: "organizations", owner: "atlas_migrator" },
        { object_name: "schema_migrations", owner: "atlas_migrator" },
      ]);
      const extensions = await pool.query<{ extname: string; owner: string }>(`
        SELECT e.extname, r.rolname AS owner
          FROM pg_extension e
          JOIN pg_roles r ON r.oid = e.extowner
         WHERE e.extname IN ('citext', 'pgcrypto')
         ORDER BY e.extname
      `);
      expect(extensions.rows).toEqual([
        { extname: "citext", owner: "atlas" },
        { extname: "pgcrypto", owner: "atlas" },
      ]);

      const client = await pool.connect();
      try {
        await client.query("SET ROLE atlas_migrator");
        await client.query("CREATE TABLE future_migration_probe (id integer PRIMARY KEY)");
        await client.query("CREATE FUNCTION future_migration_probe_fn() RETURNS integer LANGUAGE sql AS 'SELECT 1'");
        const futureOwner = await client.query<{ owner: string }>(`
          SELECT r.rolname AS owner
            FROM pg_class c
            JOIN pg_roles r ON r.oid = c.relowner
           WHERE c.relname = 'future_migration_probe'
        `);
        expect(futureOwner.rows).toEqual([{ owner: "atlas_migrator" }]);
      } finally {
        await client.query("RESET ROLE").catch(() => undefined);
        client.release();
      }
    } finally {
      await pool.end();
      await temporaryDatabase.cleanup();
    }
  });

  it("enforces audit append-only and denies application roles schema history access", async (context) => {
    await withTemporaryPostgreSql(context, async (pool) => {
      const actorId = "10000000-0000-4000-8000-000000000001";
      const organizationId = "00000000-0000-4000-8000-000000000001";
      await pool.query(
        `INSERT INTO actors
           (id, organization_id, type, role, service_key_prefix, service_key_hash, display_name)
         VALUES ($1, $2, 'automation', 'member', 'permission01', $3, 'Permission test')`,
        [actorId, organizationId, "a".repeat(64)],
      );
      const outboxId = "30000000-0000-4000-8000-000000000001";
      await pool.query(
        `INSERT INTO outbox_events
           (id, organization_id, actor_id, request_id, event_type, aggregate_type,
            aggregate_id, schema_version, payload)
         VALUES ($1, $2, $3, $4, 'permission.test.v1', 'organization', $2, 1, $5)`,
        [
          outboxId,
          organizationId,
          actorId,
          "40000000-0000-4000-8000-000000000001",
          { private: "immutable" },
        ],
      );
      await pool.query(
        `INSERT INTO audit_events
           (organization_id, actor_id, request_id, action, resource_type, resource_id)
         VALUES ($1, $2, $3, 'permission.test', 'organization', $1)`,
        [organizationId, actorId, "20000000-0000-4000-8000-000000000001"],
      );

      const client = await pool.connect();
      try {
        await client.query("SET ROLE atlas_web");
        await expect(client.query("SELECT id FROM organizations LIMIT 1")).resolves.toMatchObject({ rowCount: 1 });
        await expect(client.query("UPDATE audit_events SET action = 'tampered'"))
          .rejects.toMatchObject({ code: expect.stringMatching(/42501|P0001/) });
        await expect(client.query("DELETE FROM audit_events"))
          .rejects.toMatchObject({ code: expect.stringMatching(/42501|P0001/) });
        await expect(client.query(
          "INSERT INTO schema_migrations (filename, checksum) VALUES ('tamper.sql', 'x')",
        )).rejects.toMatchObject({ code: "42501" });
        await expect(client.query("CREATE TABLE forbidden_web_ddl (id integer)"))
          .rejects.toMatchObject({ code: "42501" });
        await expect(client.query("UPDATE outbox_events SET available_at = available_at"))
          .rejects.toMatchObject({ code: "42501" });
        await client.query("RESET ROLE");

        await client.query("SET ROLE atlas_worker");
        await expect(client.query("SELECT id FROM outbox_events LIMIT 1")).resolves.toBeDefined();
        await expect(client.query(
          `UPDATE outbox_events
              SET attempt_count = attempt_count + 1,
                  available_at = now(),
                  processing_started_at = now(),
                  processing_token = $2,
                  published_at = now(),
                  terminal_at = now(),
                  last_error = 'bounded',
                  updated_at = now()
            WHERE id = $1`,
          [outboxId, "50000000-0000-4000-8000-000000000001"],
        )).resolves.toMatchObject({ rowCount: 1 });
        await expect(client.query(
          "UPDATE outbox_events SET event_type = 'tampered.v1' WHERE id = $1",
          [outboxId],
        )).rejects.toMatchObject({ code: "42501" });
        await expect(client.query(
          "UPDATE outbox_events SET payload = '{}'::jsonb WHERE id = $1",
          [outboxId],
        )).rejects.toMatchObject({ code: "42501" });
        await expect(client.query(
          "UPDATE outbox_events SET organization_id = organization_id WHERE id = $1",
          [outboxId],
        )).rejects.toMatchObject({ code: "42501" });
        await expect(client.query("UPDATE organizations SET name = name"))
          .rejects.toMatchObject({ code: "42501" });
        await expect(client.query("SELECT * FROM schema_migrations"))
          .rejects.toMatchObject({ code: "42501" });
        await client.query("RESET ROLE");
      } finally {
        client.release();
      }

      await expect(pool.query("UPDATE audit_events SET action = 'tampered-owner'"))
        .rejects.toMatchObject({ code: "P0001" });
      await expect(pool.query("DELETE FROM audit_events"))
        .rejects.toMatchObject({ code: "P0001" });
      await expect(pool.query("TRUNCATE audit_events"))
        .rejects.toMatchObject({ code: "P0001" });
    });
  });

  it("runs owner provisioning and verified Google linking under SET ROLE atlas_web", async (context) => {
    await withTemporaryPostgreSql(context, async (pool) => {
      const client = await pool.connect();
      const rolePool = {
        connect: async () => ({
          query: client.query.bind(client),
          release() {},
        }),
      } as unknown as Pool;
      try {
        await client.query("SET ROLE atlas_web");
        await expect(provisionProductionOwnerWithPool(rolePool, {
          databaseUrl: "postgresql://atlas_web:redacted-for-equipped-test@db:5432/atlas",
          email: "owner@rangeway.energy",
          displayName: "Rangeway Owner",
          allowedDomain: "rangeway.energy",
        })).resolves.toBe("created");

        await expect(new IdentityService(rolePool).authenticateGoogle(
          "00000000-0000-4000-8000-000000000001",
          "google-subject-equipped-test",
          "owner@rangeway.energy",
          "Rangeway Owner",
          "60000000-0000-4000-8000-000000000001",
        )).resolves.toMatchObject({
          actorType: "human",
          actorName: "Rangeway Owner",
          role: "owner",
        });
        await client.query("RESET ROLE");

        const evidence = await pool.query<{ google_subject: string; count: string }>(
          `SELECT u.google_subject,
                  (SELECT count(*)::text FROM audit_events) AS count
             FROM users u
            WHERE u.email = 'owner@rangeway.energy'`,
        );
        expect(evidence.rows).toEqual([
          { google_subject: "google-subject-equipped-test", count: "2" },
        ]);
      } finally {
        await client.query("RESET ROLE").catch(() => undefined);
        client.release();
      }
    });
  });
});
