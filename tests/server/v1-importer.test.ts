import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import type { Pool } from "pg";
import { describe, expect, it, type TestContext } from "vitest";
import { importV1 } from "../../src/server/platform/import/v1-importer.js";
import { createPool } from "../../src/server/platform/db/client.js";
import { runMigrations } from "../../src/server/platform/db/migrate.js";
import { createTemporaryDatabase, PostgreSqlUnavailableError } from "../helpers/database.js";

const organizationId = "00000000-0000-4000-8000-000000000001";

async function withPostgreSql(
  context: TestContext,
  operation: (pool: Pool) => Promise<void>,
): Promise<void> {
  let database;
  try {
    database = await createTemporaryDatabase();
  } catch (error) {
    if (error instanceof PostgreSqlUnavailableError) {
      context.skip(`EQUIPPED_POSTGRESQL_SKIP: ${error.message}`);
      return;
    }
    throw error;
  }
  const pool = createPool(database.databaseUrl);
  try {
    await runMigrations(pool);
    await operation(pool);
  } finally {
    await pool.end();
    await database.cleanup();
  }
}

/** Builds a synthetic V1 database shaped like the preserved application. */
function createV1Database(): { file: string; cleanup: () => void } {
  const directory = mkdtempSync(path.join(tmpdir(), "atlas-v1-"));
  const file = path.join(directory, "rangeway-crm.sqlite");
  const database = new Database(file);
  database.exec(`
    CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT, summary TEXT, stage TEXT, region TEXT);
    CREATE TABLE contacts (id TEXT PRIMARY KEY, name TEXT, email TEXT, phone TEXT, role TEXT, notes TEXT);
    CREATE TABLE tasks (id TEXT PRIMARY KEY, project_id TEXT, title TEXT, notes TEXT, status TEXT, due_date TEXT);
    CREATE TABLE documents (id TEXT PRIMARY KEY, project_id TEXT, title TEXT, filename TEXT, stored_name TEXT, mime_type TEXT, size_bytes INTEGER);
    CREATE TABLE activities (id TEXT PRIMARY KEY, project_id TEXT, summary TEXT, occurred_at TEXT);
  `);
  database.prepare("INSERT INTO projects VALUES (?,?,?,?,?)").run("p1", "Mojave", "Desert corridor site", "diligence", "California");
  database.prepare("INSERT INTO projects VALUES (?,?,?,?,?)").run("p2", "The Landing", "", "unknown_stage", "Missouri");
  database.prepare("INSERT INTO contacts VALUES (?,?,?,?,?,?)").run("c1", "Dana Reyes", "dana@example.com", "555-0100", "Landowner", "Met at site walk");
  database.prepare("INSERT INTO tasks VALUES (?,?,?,?,?,?)").run("t1", "p1", "Confirm utility capacity", "", "in progress", "2026-09-01");
  database.prepare("INSERT INTO tasks VALUES (?,?,?,?,?,?)").run("t2", "p1", "Odd status task", "", "sideways", null);
  // An orphan with no project cannot be placed and must be reported.
  database.prepare("INSERT INTO tasks VALUES (?,?,?,?,?,?)").run("t3", null, "Orphan task", "", "todo", null);
  database.prepare("INSERT INTO documents VALUES (?,?,?,?,?,?,?)").run("d1", "p1", "Term sheet", "term-sheet.pdf", "stored-1.pdf", "application/pdf", 1024);
  database.prepare("INSERT INTO activities VALUES (?,?,?,?)").run("a1", "p1", "Site walk completed", "2026-07-01T10:00:00.000Z");
  database.close();
  return { file, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}

async function createOwner(pool: Pool) {
  const userId = randomUUID();
  const actorId = randomUUID();
  await pool.query("BEGIN");
  await pool.query("SET CONSTRAINTS ALL DEFERRED");
  await pool.query("INSERT INTO users (id, email, display_name) VALUES ($1, $2, 'Owner')", [
    userId,
    `${userId}@rangeway.energy`,
  ]);
  await pool.query(
    `INSERT INTO actors (id, organization_id, type, role, user_id, display_name)
     VALUES ($1, $2, 'human', 'owner', $3, 'Owner')`,
    [actorId, organizationId, userId],
  );
  await pool.query(
    "INSERT INTO organization_memberships (organization_id, user_id, role) VALUES ($1, $2, 'owner')",
    [organizationId, userId],
  );
  await pool.query("COMMIT");
  return { actorId, userId };
}

describe("V1 importer", () => {
  it("produces a dry-run plan without writing anything", async (context) => {
    await withPostgreSql(context, async (pool) => {
      const { actorId, userId } = await createOwner(pool);
      const v1 = createV1Database();
      try {
        const plan = await importV1(pool, {
          sqlitePath: v1.file,
          organizationId,
          actorId,
          ownerUserId: userId,
          apply: false,
        });

        expect(plan.entries.length).toBeGreaterThan(0);
        expect(plan.counts["project_rooms:create"]).toBe(2);
        expect(plan.counts["people:create"]).toBe(1);

        // Nothing was written during a dry run.
        const projects = await pool.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM project_rooms",
        );
        expect(projects.rows[0].count).toBe("0");
        const records = await pool.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM v1_import_records",
        );
        expect(records.rows[0].count).toBe("0");
      } finally {
        v1.cleanup();
      }
    });
  });

  it("reports conflicts and unmapped vocabulary instead of guessing", async (context) => {
    await withPostgreSql(context, async (pool) => {
      const { actorId, userId } = await createOwner(pool);
      const v1 = createV1Database();
      try {
        const plan = await importV1(pool, {
          sqlitePath: v1.file,
          organizationId,
          actorId,
          ownerUserId: userId,
          apply: false,
        });

        // The orphan task is surfaced, not silently dropped or attached.
        expect(plan.conflicts.map((entry) => entry.sourceId)).toContain("t3");
        expect(plan.conflicts.find((entry) => entry.sourceId === "t3")?.note).toBe(
          "no_project_reference",
        );

        expect(plan.warnings.join(" ")).toContain("unmapped status");
        expect(plan.warnings.join(" ")).toContain("unmapped stage");
      } finally {
        v1.cleanup();
      }
    });
  });

  it("imports with provenance and leaves unknown facts unknown", async (context) => {
    await withPostgreSql(context, async (pool) => {
      const { actorId, userId } = await createOwner(pool);
      const v1 = createV1Database();
      try {
        await importV1(pool, {
          sqlitePath: v1.file,
          organizationId,
          actorId,
          ownerUserId: userId,
          apply: true,
        });

        const project = await pool.query<{
          name: string;
          health: string;
          current_focus: string;
          next_action: string;
        }>("SELECT name, health, current_focus, next_action FROM project_rooms WHERE name = 'Mojave'");
        expect(project.rows[0].health).toBe("unknown");
        // V1 never recorded these, so they stay empty rather than invented.
        expect(project.rows[0].current_focus).toBe("");
        expect(project.rows[0].next_action).toBe("");

        const person = await pool.query<{ provenance: { source: string; verified: boolean } }>(
          "SELECT provenance FROM people WHERE display_name = 'Dana Reyes'",
        );
        expect(person.rows[0].provenance).toMatchObject({ source: "atlas-v1", verified: false });

        const work = await pool.query<{ title: string; status: string }>(
          "SELECT title, status FROM work_items ORDER BY title",
        );
        // Ordered by title: "Confirm utility capacity" then "Odd status task".
        expect(work.rows.map((row) => row.status)).toEqual(["in_progress", "inbox"]);

        const records = await pool.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM v1_import_records",
        );
        expect(Number(records.rows[0].count)).toBeGreaterThan(0);
      } finally {
        v1.cleanup();
      }
    });
  });

  it("is repeatable: a second import creates nothing new", async (context) => {
    await withPostgreSql(context, async (pool) => {
      const { actorId, userId } = await createOwner(pool);
      const v1 = createV1Database();
      try {
        const options = {
          sqlitePath: v1.file,
          organizationId,
          actorId,
          ownerUserId: userId,
          apply: true,
        };
        await importV1(pool, options);
        const first = await pool.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM project_rooms",
        );

        const second = await importV1(pool, options);
        const after = await pool.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM project_rooms",
        );

        expect(after.rows[0].count).toBe(first.rows[0].count);
        expect(second.counts["project_rooms:skip_already_imported"]).toBe(2);
      } finally {
        v1.cleanup();
      }
    });
  });

  it("never writes to the preserved V1 database", async (context) => {
    await withPostgreSql(context, async (pool) => {
      const { actorId, userId } = await createOwner(pool);
      const v1 = createV1Database();
      try {
        const before = new Database(v1.file, { readonly: true });
        const beforeCounts = {
          projects: (before.prepare("SELECT count(*) c FROM projects").get() as { c: number }).c,
          tasks: (before.prepare("SELECT count(*) c FROM tasks").get() as { c: number }).c,
        };
        before.close();

        await importV1(pool, {
          sqlitePath: v1.file,
          organizationId,
          actorId,
          ownerUserId: userId,
          apply: true,
        });

        const after = new Database(v1.file, { readonly: true });
        const afterCounts = {
          projects: (after.prepare("SELECT count(*) c FROM projects").get() as { c: number }).c,
          tasks: (after.prepare("SELECT count(*) c FROM tasks").get() as { c: number }).c,
        };
        after.close();
        expect(afterCounts).toEqual(beforeCounts);
      } finally {
        v1.cleanup();
      }
    });
  });
});
