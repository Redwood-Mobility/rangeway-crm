import { describe, expect, it } from "vitest";
import { createPool } from "../../src/server/platform/db/client.js";
import { runMigrations } from "../../src/server/platform/db/migrate.js";
import {
  createTemporaryDatabase,
  PostgreSqlUnavailableError,
} from "../helpers/database.js";

const expectedRelations = [
  "schema_migrations",
  "organizations",
  "users",
  "actors",
  "organization_memberships",
  "audit_events",
  "outbox_events",
];

describe("PostgreSQL platform migrations", () => {
  it("applies all migrations idempotently", async (context) => {
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
    } finally {
      await pool.end();
      await temporaryDatabase.cleanup();
    }
  });
});
