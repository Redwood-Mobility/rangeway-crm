import { readFile } from "node:fs/promises";
import type { Pool } from "pg";
import { describe, expect, it, type TestContext } from "vitest";
import { createPool } from "../../src/server/platform/db/client.js";
import { runMigrations } from "../../src/server/platform/db/migrate.js";
import { IdentityService } from "../../src/server/modules/identity/identity.service.js";
import { provisionProductionOwnerWithPool } from "../../src/server/platform/db/provision-production-owner.js";
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
