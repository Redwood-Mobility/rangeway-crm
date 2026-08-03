import { createHash, randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import type { Pool } from "pg";
import { withTransaction } from "../db/client.js";

/**
 * Imports the preserved V1 SQLite application into Atlas.
 *
 * Two rules shape this:
 *
 * 1. The V1 database is read-only here. Nothing in this module writes to it, so
 *    the preserved application survives the import untouched.
 * 2. A V1 row is a *source*, not a verified fact. Everything it produces carries
 *    provenance back to the exact row, and anything V1 did not record stays
 *    empty rather than being invented — an unknown remains unknown.
 */

export interface ImportPlanEntry {
  sourceTable: string;
  sourceId: string;
  targetTable: string;
  action: "create" | "skip_already_imported" | "skip_conflict";
  label: string;
  note?: string;
}

export interface ImportPlan {
  entries: ImportPlanEntry[];
  counts: Record<string, number>;
  conflicts: ImportPlanEntry[];
  warnings: string[];
}

export interface ImportOptions {
  sqlitePath: string;
  organizationId: string;
  actorId: string;
  ownerUserId: string;
  /** When false, nothing is written and the plan is returned for review. */
  apply: boolean;
}

interface V1Row {
  [column: string]: unknown;
}

function digest(row: V1Row): string {
  return createHash("sha256").update(JSON.stringify(row)).digest("hex");
}

function text(value: unknown): string {
  return typeof value === "string" ? value : value === null || value === undefined ? "" : String(value);
}

function readTable(database: Database.Database, table: string): V1Row[] {
  try {
    return database.prepare(`SELECT * FROM ${table}`).all() as V1Row[];
  } catch {
    return [];
  }
}

/** V1 task status vocabulary mapped onto the universal work statuses. */
const workStatusByV1Status: Record<string, string> = {
  todo: "next",
  "to do": "next",
  open: "next",
  doing: "in_progress",
  in_progress: "in_progress",
  "in progress": "in_progress",
  waiting: "waiting",
  blocked: "waiting",
  done: "done",
  complete: "done",
  completed: "done",
  cancelled: "canceled",
  canceled: "canceled",
};

const projectStatusByV1Stage: Record<string, string> = {
  prospect: "planned",
  qualifying: "active",
  diligence: "active",
  negotiation: "active",
  committed: "active",
  construction: "active",
  operating: "completed",
  lost: "canceled",
  paused: "on_hold",
};

export async function importV1(pool: Pool, options: ImportOptions): Promise<ImportPlan> {
  const database = new Database(options.sqlitePath, { readonly: true, fileMustExist: true });
  try {
    const contacts = readTable(database, "contacts");
    const projects = readTable(database, "projects");
    const tasks = readTable(database, "tasks");
    const documents = readTable(database, "documents");
    const activities = readTable(database, "activities");

    const alreadyImported = await pool.query<{ source_table: string; source_id: string; target_id: string }>(
      "SELECT source_table, source_id, target_id FROM v1_import_records WHERE organization_id = $1",
      [options.organizationId],
    );
    const seen = new Map(
      alreadyImported.rows.map((row) => [`${row.source_table}:${row.source_id}`, row.target_id]),
    );

    const entries: ImportPlanEntry[] = [];
    const warnings: string[] = [];

    const plan = (
      sourceTable: string,
      sourceId: string,
      targetTable: string,
      label: string,
      note?: string,
    ): ImportPlanEntry => {
      const entry: ImportPlanEntry = {
        sourceTable,
        sourceId,
        targetTable,
        label,
        action: seen.has(`${sourceTable}:${sourceId}`) ? "skip_already_imported" : "create",
        note,
      };
      entries.push(entry);
      return entry;
    };

    for (const contact of contacts) {
      plan("contacts", text(contact.id), "people", text(contact.name) || "Unnamed contact");
    }
    for (const project of projects) {
      const stage = text(project.stage).toLowerCase();
      if (stage && !projectStatusByV1Stage[stage]) {
        warnings.push(`Project ${text(project.id)} has unmapped stage "${stage}"; imported as planned.`);
      }
      plan("projects", text(project.id), "project_rooms", text(project.name) || "Unnamed project");
    }
    for (const task of tasks) {
      const status = text(task.status).toLowerCase();
      if (status && !workStatusByV1Status[status]) {
        warnings.push(`Task ${text(task.id)} has unmapped status "${status}"; imported to Inbox.`);
      }
      if (!task.project_id) {
        // Work must belong to a project; an orphan cannot be placed.
        entries.push({
          sourceTable: "tasks",
          sourceId: text(task.id),
          targetTable: "work_items",
          action: "skip_conflict",
          label: text(task.title) || "Untitled task",
          note: "no_project_reference",
        });
        continue;
      }
      plan("tasks", text(task.id), "work_items", text(task.title) || "Untitled task");
    }
    for (const document of documents) {
      plan("documents", text(document.id), "artifacts", text(document.title) || text(document.filename) || "Document");
    }
    for (const activity of activities) {
      if (!activity.project_id) {
        entries.push({
          sourceTable: "activities",
          sourceId: text(activity.id),
          targetTable: "activities",
          action: "skip_conflict",
          label: text(activity.summary) || "Activity",
          note: "no_project_reference",
        });
        continue;
      }
      plan("activities", text(activity.id), "activities", text(activity.summary) || "Activity");
    }

    const counts: Record<string, number> = {};
    for (const entry of entries) {
      const bucket = `${entry.targetTable}:${entry.action}`;
      counts[bucket] = (counts[bucket] ?? 0) + 1;
    }
    const conflicts = entries.filter((entry) => entry.action === "skip_conflict");
    const result: ImportPlan = { entries, counts, conflicts, warnings };

    if (!options.apply) return result;

    await withTransaction(pool, async (client) => {
      const record = async (
        sourceTable: string,
        sourceId: string,
        targetTable: string,
        targetId: string,
        row: V1Row,
      ) => {
        await client.query(
          `INSERT INTO v1_import_records
             (id, organization_id, source_table, source_id, target_table, target_id,
              source_digest, imported_by_actor_id)
           VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7)`,
          [options.organizationId, sourceTable, sourceId, targetTable, targetId, digest(row), options.actorId],
        );
      };

      const projectTargets = new Map<string, string>();
      for (const [pointer, targetId] of seen) {
        if (pointer.startsWith("projects:")) projectTargets.set(pointer.slice("projects:".length), targetId);
      }

      for (const project of projects) {
        const sourceId = text(project.id);
        if (seen.has(`projects:${sourceId}`)) continue;
        const id = randomUUID();
        const stage = text(project.stage).toLowerCase();
        await client.query(
          `INSERT INTO project_rooms
             (id, organization_id, name, objective, template_type, status, health,
              priority, strategic_area, owner_user_id, current_focus, next_action,
              created_by_actor_id, updated_by_actor_id)
           VALUES ($1, $2, $3, $4, 'location_pursuit', $5::project_status, 'unknown',
                   'medium', $6, $7, $8, $9, $10, $10)`,
          [
            id,
            options.organizationId,
            text(project.name) || "Imported project",
            text(project.summary) || text(project.notes),
            projectStatusByV1Stage[stage] ?? "planned",
            text(project.region) || text(project.market),
            options.ownerUserId,
            // V1 had no notion of current focus or next action. They stay empty
            // rather than being fabricated from adjacent fields.
            "",
            "",
            options.actorId,
          ],
        );
        projectTargets.set(sourceId, id);
        await record("projects", sourceId, "project_rooms", id, project);
      }

      for (const contact of contacts) {
        const sourceId = text(contact.id);
        if (seen.has(`contacts:${sourceId}`)) continue;
        const id = randomUUID();
        const name = text(contact.name) || "Imported contact";
        const [given, ...rest] = name.split(/\s+/);
        await client.query(
          `INSERT INTO people
             (id, organization_id, display_name, given_name, family_name, email, phone,
              title, notes, provenance, created_by_actor_id, updated_by_actor_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11)`,
          [
            id,
            options.organizationId,
            name,
            given ?? "",
            rest.join(" "),
            text(contact.email) || null,
            text(contact.phone),
            text(contact.role) || text(contact.title),
            text(contact.notes),
            JSON.stringify({ source: "atlas-v1", sourceTable: "contacts", sourceId, verified: false }),
            options.actorId,
          ],
        );
        await record("contacts", sourceId, "people", id, contact);
      }

      for (const task of tasks) {
        const sourceId = text(task.id);
        if (seen.has(`tasks:${sourceId}`) || !task.project_id) continue;
        const projectId = projectTargets.get(text(task.project_id));
        if (!projectId) continue;
        const id = randomUUID();
        await client.query(
          `INSERT INTO work_items
             (id, organization_id, project_id, type, title, description, status,
              priority, due_at, position, created_by_actor_id, updated_by_actor_id)
           VALUES ($1, $2, $3, 'action', $4, $5, $6::work_item_status, 'medium', $7, $8, $9, $9)`,
          [
            id,
            options.organizationId,
            projectId,
            text(task.title) || "Imported task",
            text(task.notes) || text(task.description),
            workStatusByV1Status[text(task.status).toLowerCase()] ?? "inbox",
            task.due_date ? new Date(text(task.due_date)) : null,
            1000,
            options.actorId,
          ],
        );
        await record("tasks", sourceId, "work_items", id, task);
      }

      for (const document of documents) {
        const sourceId = text(document.id);
        if (seen.has(`documents:${sourceId}`)) continue;
        const id = randomUUID();
        const storageKey = text(document.stored_name) || text(document.filename) || `v1/${sourceId}`;
        await client.query(
          `INSERT INTO artifacts
             (id, organization_id, mode, title, description, storage_key, mime_type,
              byte_size, checksum, visibility, source_system, provenance,
              created_by_actor_id, updated_by_actor_id)
           VALUES ($1, $2, 'native', $3, $4, $5, $6, $7, $8, 'project', 'atlas-v1', $9, $10, $10)`,
          [
            id,
            options.organizationId,
            text(document.title) || text(document.filename) || "Imported document",
            text(document.notes),
            storageKey,
            text(document.mime_type),
            Number(document.size_bytes ?? 0) || 0,
            // The file itself is not re-hashed here; the digest identifies the
            // V1 row it came from, and is marked as such.
            createHash("sha256").update(`v1:${sourceId}:${storageKey}`).digest("hex"),
            JSON.stringify({ source: "atlas-v1", sourceTable: "documents", sourceId, checksumBasis: "v1-row" }),
            options.actorId,
          ],
        );
        const projectId = document.project_id ? projectTargets.get(text(document.project_id)) : null;
        if (projectId) {
          await client.query(
            `INSERT INTO artifact_projects (id, organization_id, artifact_id, project_id, created_by_actor_id)
             VALUES (gen_random_uuid(), $1, $2, $3, $4)
             ON CONFLICT (organization_id, artifact_id, project_id) DO NOTHING`,
            [options.organizationId, id, projectId, options.actorId],
          );
        }
        await record("documents", sourceId, "artifacts", id, document);
      }

      for (const activity of activities) {
        const sourceId = text(activity.id);
        if (seen.has(`activities:${sourceId}`) || !activity.project_id) continue;
        const projectId = projectTargets.get(text(activity.project_id));
        if (!projectId) continue;
        const id = randomUUID();
        await client.query(
          `INSERT INTO activities
             (id, organization_id, project_id, activity_type, body, occurred_at, created_by_actor_id)
           VALUES ($1, $2, $3, 'note', $4, $5, $6)`,
          [
            id,
            options.organizationId,
            projectId,
            text(activity.summary) || text(activity.note) || "Imported activity",
            activity.occurred_at ? new Date(text(activity.occurred_at)) : new Date(),
            options.actorId,
          ],
        );
        await record("activities", sourceId, "activities", id, activity);
      }
    });

    return result;
  } finally {
    database.close();
  }
}
