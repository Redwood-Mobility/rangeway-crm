import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import "dotenv/config";
import type { Pool } from "pg";
import { validateProductionPostgresUrl } from "../../../shared/postgres-url.js";
import { createPool, withTransaction } from "./client.js";

const defaultMigrationsDirectory = path.resolve(process.cwd(), "db", "migrations");

type AppliedMigration = {
  filename: string;
  checksum: string;
};

type Migration = AppliedMigration & {
  sql: string;
};

function validateAppliedMigrationPrefix(
  migrations: Migration[],
  appliedMigrations: AppliedMigration[],
): void {
  const currentFilenames = new Set(migrations.map((migration) => migration.filename));

  for (let index = 0; index < appliedMigrations.length; index += 1) {
    const applied = appliedMigrations[index];
    const current = migrations[index];

    if (!currentFilenames.has(applied.filename)) {
      throw new Error(
        `Applied migration ${applied.filename} is missing from the current migration set.`,
      );
    }

    if (!current || applied.filename !== current.filename) {
      throw new Error(
        `Migration history is not an immutable prefix: expected ${current?.filename ?? "no migration"} at position ${index + 1}, received ${applied.filename}.`,
      );
    }

    const recordedChecksum = applied.checksum.trim();
    if (recordedChecksum !== current.checksum) {
      throw new Error(
        `Migration checksum mismatch for ${current.filename}: expected ${recordedChecksum}, received ${current.checksum}.`,
      );
    }
  }
}

export async function runMigrations(
  pool: Pool,
  migrationsDirectory = defaultMigrationsDirectory,
): Promise<void> {
  const filenames = (await readdir(migrationsDirectory))
    // Only real migration files. A stray sidecar — macOS writes `._name.sql`
    // AppleDouble files when archiving — would otherwise be read as SQL and
    // sent to PostgreSQL as binary, failing with an opaque protocol error.
    .filter((filename) => filename.endsWith(".sql") && !filename.startsWith("."))
    .sort();

  const migrations = await Promise.all(
    filenames.map(async (filename) => {
      const sql = await readFile(path.join(migrationsDirectory, filename), "utf8");
      return {
        filename,
        sql,
        checksum: createHash("sha256").update(sql).digest("hex"),
      };
    }),
  );

  await withTransaction(pool, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('atlas_schema_migrations'))");
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename TEXT PRIMARY KEY,
        checksum CHAR(64) NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    const applied = await client.query<AppliedMigration>(
      "SELECT filename, checksum FROM schema_migrations ORDER BY applied_at, filename",
    );
    validateAppliedMigrationPrefix(migrations, applied.rows);

    for (const migration of migrations.slice(applied.rows.length)) {
      await client.query(migration.sql);
      await client.query(
        "INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)",
        [migration.filename, migration.checksum],
      );
    }
  });
}

export function readMigrationDatabaseUrl(env: NodeJS.ProcessEnv): string {
  const databaseUrl = env.DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error("DATABASE_URL is required to run migrations.");
  if (env.NODE_ENV === "production") {
    const issue = validateProductionPostgresUrl(databaseUrl, {
      username: "atlas_migrator",
      hostname: "db",
      database: "atlas",
    });
    if (issue) throw new Error(`Production migration DATABASE_URL ${issue}.`);
  }
  return databaseUrl;
}

async function main(): Promise<void> {
  const databaseUrl = readMigrationDatabaseUrl(process.env);
  const pool = createPool(databaseUrl);
  try {
    await runMigrations(pool);
  } finally {
    await pool.end();
  }
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
