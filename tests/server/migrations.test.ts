import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Pool, PoolClient } from "pg";
import { describe, expect, it, type TestContext } from "vitest";
import { createPool } from "../../src/server/platform/db/client.js";
import {
  readMigrationDatabaseUrl,
  runMigrations,
} from "../../src/server/platform/db/migrate.js";
import {
  createTemporaryDatabase,
  isPostgreSqlUnreachable,
  PostgreSqlUnavailableError,
} from "../helpers/database.js";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");

const expectedRelations = [
  "schema_migrations",
  "organizations",
  "users",
  "actors",
  "organization_memberships",
  "audit_events",
  "outbox_events",
  "api_idempotency_keys",
];

type MigrationFile = {
  filename: string;
  sql: string;
};

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
    await operation(pool);
  } finally {
    await pool.end();
    await temporaryDatabase.cleanup();
  }
}

async function createMigrationsDirectory(files: MigrationFile[]): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "atlas-migrations-"));
  await Promise.all(files.map((file) => writeFile(path.join(directory, file.filename), file.sql)));
  return directory;
}

function checksum(sql: string): string {
  return createHash("sha256").update(sql).digest("hex");
}

function fakePoolWithAppliedMigrations(
  applied: Array<{ filename: string; checksum: string }>,
  queries: string[] = [],
): Pool {
  const client = {
    query: async (sql: string) => {
      queries.push(sql.trim());
      if (sql.includes("SELECT filename, checksum FROM schema_migrations")) {
        return { rows: applied };
      }
      return { rows: [] };
    },
    release: () => undefined,
  } as unknown as PoolClient;

  return { connect: async () => client } as unknown as Pool;
}

describe("PostgreSQL platform migrations", () => {
  it("accepts only the exact least-privilege production migrator database contract", () => {
    const valid = "postgresql://atlas_migrator:migrator-password-0123456789@db:5432/atlas";
    expect(readMigrationDatabaseUrl({ NODE_ENV: "production", DATABASE_URL: valid })).toBe(valid);

    for (const databaseUrl of [
      "postgresql://atlas:bootstrap-password-0123456789@db:5432/atlas",
      "postgresql://atlas_web:web-password-01234567890123@db:5432/atlas",
      "postgresql://atlas_worker:worker-password-0123456789@db:5432/atlas",
      "http://atlas_migrator:migrator-password-0123456789@db:5432/atlas",
      "postgresql://atlas_migrator:migrator-password-0123456789@postgres:5432/atlas",
      "postgresql://atlas_migrator:migrator-password-0123456789@db:5432/postgres",
      "postgresql://atlas_migrator:migrator-password-0123456789@db:5432/atlas?sslmode=disable",
      "postgresql://atlas_migrator:p%40ssword-with-reserved-chars@db:5432/atlas",
    ]) {
      expect(() =>
        readMigrationDatabaseUrl({ NODE_ENV: "production", DATABASE_URL: databaseUrl }),
      ).toThrow(/Production migration DATABASE_URL/);
      try {
        readMigrationDatabaseUrl({ NODE_ENV: "production", DATABASE_URL: databaseUrl });
      } catch (error) {
        expect(JSON.stringify(error)).not.toContain(databaseUrl);
      }
    }
  });

  it("loads DATABASE_URL from a fresh-shell .env while preserving an explicit environment value", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "atlas-migrate-env-"));
    const migrationEntrypoint = path.join(
      repositoryRoot,
      "src/server/platform/db/migrate.ts",
    );
    const tsxEntrypoint = path.join(
      repositoryRoot,
      "node_modules/tsx/dist/cli.mjs",
    );
    const environment = { ...process.env };
    delete environment.DATABASE_URL;
    delete environment.DOTENV_CONFIG_PATH;
    delete environment.DOTENV_CONFIG_OVERRIDE;

    try {
      await writeFile(
        path.join(directory, ".env"),
        "DATABASE_URL=postgresql://atlas@127.0.0.1:5432/atlas_env_probe\n",
      );
      const loadedFromFile = spawnSync(
        process.execPath,
        [tsxEntrypoint, migrationEntrypoint],
        { cwd: directory, encoding: "utf8", env: environment },
      );
      const loadedOutput = `${loadedFromFile.stdout}${loadedFromFile.stderr}`;

      expect(loadedFromFile.status).not.toBe(0);
      expect(loadedOutput).toMatch(/ENOENT|no such file or directory/i);
      expect(loadedOutput).not.toContain("DATABASE_URL is required");
      expect(loadedOutput).not.toContain("atlas_env_probe");

      const explicitEmpty = spawnSync(
        process.execPath,
        [tsxEntrypoint, migrationEntrypoint],
        {
          cwd: directory,
          encoding: "utf8",
          env: { ...environment, DATABASE_URL: "" },
        },
      );
      expect(`${explicitEmpty.stdout}${explicitEmpty.stderr}`).toContain(
        "DATABASE_URL is required to run migrations.",
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("applies all migrations idempotently", async (context) => {
    await withTemporaryPostgreSql(context, async (pool) => {
      await runMigrations(pool);
      await runMigrations(pool);

      const relations = await pool.query<{ relname: string; count: string }>(
        `SELECT c.relname, COUNT(*)::text AS count
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relname = ANY($1::text[])
         GROUP BY c.relname
         ORDER BY c.relname`,
        [expectedRelations],
      );

      expect(relations.rows).toEqual(
        [...expectedRelations]
          .sort()
          .map((relname) => ({ relname, count: "1" })),
      );

      const organization = await pool.query<{ id: string }>(
        "SELECT id FROM organizations WHERE id = $1",
        ["00000000-0000-4000-8000-000000000001"],
      );
      expect(organization.rows).toEqual([{ id: "00000000-0000-4000-8000-000000000001" }]);
    });
  });

  it("rejects a changed checksum for an applied migration", async (context) => {
    await withTemporaryPostgreSql(context, async (pool) => {
      const filename = "0001_checksum.sql";
      const directory = await createMigrationsDirectory([
        { filename, sql: "CREATE TABLE checksum_probe (id INTEGER PRIMARY KEY);" },
      ]);
      try {
        await runMigrations(pool, directory);
        await writeFile(
          path.join(directory, filename),
          "CREATE TABLE checksum_probe (id INTEGER PRIMARY KEY); -- changed",
        );

        await expect(runMigrations(pool, directory)).rejects.toThrow(
          "Migration checksum mismatch for 0001_checksum.sql",
        );
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });
  });

  it("rejects an applied migration that is missing from disk", async (context) => {
    await withTemporaryPostgreSql(context, async (pool) => {
      const directory = await createMigrationsDirectory([
        { filename: "0001_first.sql", sql: "CREATE TABLE first_probe (id INTEGER PRIMARY KEY);" },
        { filename: "0002_second.sql", sql: "CREATE TABLE second_probe (id INTEGER PRIMARY KEY);" },
      ]);
      try {
        await runMigrations(pool, directory);
        await unlink(path.join(directory, "0002_second.sql"));

        await expect(runMigrations(pool, directory)).rejects.toThrow(
          "Applied migration 0002_second.sql is missing from the current migration set",
        );
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });
  });

  it("rejects a retroactively inserted lower migration filename", async (context) => {
    await withTemporaryPostgreSql(context, async (pool) => {
      const directory = await createMigrationsDirectory([
        { filename: "0001_first.sql", sql: "CREATE TABLE first_probe (id INTEGER PRIMARY KEY);" },
        { filename: "0003_third.sql", sql: "CREATE TABLE third_probe (id INTEGER PRIMARY KEY);" },
      ]);
      try {
        await runMigrations(pool, directory);
        await writeFile(
          path.join(directory, "0002_inserted.sql"),
          "CREATE TABLE inserted_probe (id INTEGER PRIMARY KEY);",
        );

        await expect(runMigrations(pool, directory)).rejects.toThrow(
          "Migration history is not an immutable prefix",
        );
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });
  });

  it("rolls back the migration history and schema when SQL is invalid", async (context) => {
    await withTemporaryPostgreSql(context, async (pool) => {
      const directory = await createMigrationsDirectory([
        { filename: "0001_valid.sql", sql: "CREATE TABLE rollback_probe (id INTEGER PRIMARY KEY);" },
        { filename: "0002_invalid.sql", sql: "CREATE TABLE never_committed (id INTEGER); INVALID SQL;" },
      ]);
      try {
        await expect(runMigrations(pool, directory)).rejects.toThrow();
        const relations = await pool.query<{ migration_table: string | null; probe_table: string | null }>(
          `SELECT
             to_regclass('public.schema_migrations')::text AS migration_table,
             to_regclass('public.rollback_probe')::text AS probe_table`,
        );
        expect(relations.rows).toEqual([{ migration_table: null, probe_table: null }]);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });
  });

  it("rejects cross-organization audit and outbox actor attribution", async (context) => {
    await withTemporaryPostgreSql(context, async (pool) => {
      await runMigrations(pool);
      const rangewayOrganizationId = "00000000-0000-4000-8000-000000000001";
      const otherOrganizationId = randomUUID();
      const rangewayActorId = randomUUID();
      await pool.query("INSERT INTO organizations (id, slug, name) VALUES ($1, $2, $3)", [
        otherOrganizationId,
        `other-${otherOrganizationId}`,
        "Other organization",
      ]);
      await pool.query(
        `INSERT INTO actors
           (id, organization_id, type, role, service_key_prefix, service_key_hash, display_name)
         VALUES ($1, $2, 'automation', 'member', $3, $4, $5)`,
        [rangewayActorId, rangewayOrganizationId, "crossorgtest", "a".repeat(64), "Test automation"],
      );

      await expect(
        pool.query(
          `INSERT INTO audit_events
             (organization_id, actor_id, request_id, action, resource_type, resource_id)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [otherOrganizationId, rangewayActorId, randomUUID(), "test", "organization", otherOrganizationId],
        ),
      ).rejects.toMatchObject({ code: "23503" });

      await expect(
        pool.query(
          `INSERT INTO outbox_events
             (organization_id, actor_id, request_id, event_type, aggregate_type, aggregate_id, schema_version, payload)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            otherOrganizationId,
            rangewayActorId,
            randomUUID(),
            "organization.updated.v1",
            "organization",
            otherOrganizationId,
            1,
            {},
          ],
        ),
      ).rejects.toMatchObject({ code: "23503" });
    });
  });

  it("treats mixed AggregateError causes as reachable failures", () => {
    const error = new AggregateError([
      Object.assign(new Error("refused"), { code: "ECONNREFUSED" }),
      Object.assign(new Error("authentication failed"), { code: "28P01" }),
    ]);

    expect(isPostgreSqlUnreachable(error)).toBe(false);
  });

  it("rejects applied migration history that is not a prefix", async () => {
    const first = { filename: "0001_first.sql", sql: "SELECT 1;" };
    const third = { filename: "0003_third.sql", sql: "SELECT 3;" };
    const directory = await createMigrationsDirectory([first, third]);
    try {
      const pool = fakePoolWithAppliedMigrations([
        { filename: third.filename, checksum: checksum(third.sql) },
      ]);

      await expect(runMigrations(pool, directory)).rejects.toThrow(
        "Migration history is not an immutable prefix",
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects applied migrations absent from the current set", async () => {
    const first = { filename: "0001_first.sql", sql: "SELECT 1;" };
    const directory = await createMigrationsDirectory([first]);
    try {
      const pool = fakePoolWithAppliedMigrations([
        { filename: first.filename, checksum: checksum(first.sql) },
        { filename: "0002_missing.sql", checksum: checksum("SELECT 2;") },
      ]);

      await expect(runMigrations(pool, directory)).rejects.toThrow(
        "Applied migration 0002_missing.sql is missing from the current migration set",
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects reordered applied migration history", async () => {
    const first = { filename: "0001_first.sql", sql: "SELECT 1;" };
    const second = { filename: "0002_second.sql", sql: "SELECT 2;" };
    const directory = await createMigrationsDirectory([first, second]);
    try {
      const pool = fakePoolWithAppliedMigrations([
        { filename: second.filename, checksum: checksum(second.sql) },
        { filename: first.filename, checksum: checksum(first.sql) },
      ]);

      await expect(runMigrations(pool, directory)).rejects.toThrow(
        "Migration history is not an immutable prefix",
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("serializes bootstrap before creating schema_migrations", async () => {
    const directory = await createMigrationsDirectory([]);
    const queries: string[] = [];
    try {
      await runMigrations(fakePoolWithAppliedMigrations([], queries), directory);
      expect(queries.findIndex((query) => query.includes("pg_advisory_xact_lock"))).toBeLessThan(
        queries.findIndex((query) => query.includes("CREATE TABLE IF NOT EXISTS schema_migrations")),
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
