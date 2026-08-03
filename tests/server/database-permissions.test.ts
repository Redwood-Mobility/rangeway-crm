import { readFile } from "node:fs/promises";
import type { Pool } from "pg";
import { describe, expect, it, type TestContext } from "vitest";
import { createPool } from "../../src/server/platform/db/client.js";
import { runMigrations } from "../../src/server/platform/db/migrate.js";
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
});
