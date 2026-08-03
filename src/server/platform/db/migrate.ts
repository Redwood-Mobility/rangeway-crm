import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import type { Pool } from "pg";
import { createPool, withTransaction } from "./client.js";

const defaultMigrationsDirectory = path.resolve(process.cwd(), "db", "migrations");

type AppliedMigration = {
  filename: string;
  checksum: string;
};

export async function runMigrations(
  pool: Pool,
  migrationsDirectory = defaultMigrationsDirectory,
): Promise<void> {
  const filenames = (await readdir(migrationsDirectory))
    .filter((filename) => filename.endsWith(".sql"))
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
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename TEXT PRIMARY KEY,
        checksum CHAR(64) NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await client.query("SELECT pg_advisory_xact_lock(hashtext('atlas_schema_migrations'))");

    const applied = await client.query<AppliedMigration>(
      "SELECT filename, checksum FROM schema_migrations",
    );
    const appliedByFilename = new Map(
      applied.rows.map((migration) => [migration.filename, migration.checksum.trim()]),
    );

    for (const migration of migrations) {
      const recordedChecksum = appliedByFilename.get(migration.filename);
      if (recordedChecksum !== undefined) {
        if (recordedChecksum !== migration.checksum) {
          throw new Error(
            `Migration checksum mismatch for ${migration.filename}: expected ${recordedChecksum}, received ${migration.checksum}.`,
          );
        }
        continue;
      }

      await client.query(migration.sql);
      await client.query(
        "INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)",
        [migration.filename, migration.checksum],
      );
    }
  });
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required to run migrations.");

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
