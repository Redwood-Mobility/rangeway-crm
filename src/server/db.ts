import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { nanoid } from "nanoid";
import { config } from "./config.js";

fs.mkdirSync(path.dirname(config.databasePath), { recursive: true });

export const db = new Database(config.databasePath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

export function migrate() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS contacts (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      company TEXT DEFAULT '',
      role TEXT DEFAULT '',
      email TEXT DEFAULT '',
      phone TEXT DEFAULT '',
      location TEXT DEFAULT '',
      stage TEXT NOT NULL DEFAULT 'New',
      category TEXT NOT NULL DEFAULT 'Real Estate',
      notes TEXT DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      picture TEXT DEFAULT '',
      role TEXT NOT NULL DEFAULT 'member',
      provider TEXT NOT NULL DEFAULT 'google',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_login_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      format TEXT NOT NULL DEFAULT 'Waystation',
      status TEXT NOT NULL DEFAULT 'Scouting',
      priority TEXT NOT NULL DEFAULT 'Medium',
      location TEXT DEFAULT '',
      owner TEXT DEFAULT '',
      target_date TEXT DEFAULT '',
      estimated_value INTEGER,
      notes TEXT DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS contact_projects (
      contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      relationship TEXT NOT NULL DEFAULT 'Stakeholder',
      notes TEXT DEFAULT '',
      created_at TEXT NOT NULL,
      PRIMARY KEY (contact_id, project_id)
    );

    CREATE TABLE IF NOT EXISTS documents (
      id TEXT PRIMARY KEY,
      original_name TEXT NOT NULL,
      stored_name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size INTEGER NOT NULL,
      notes TEXT DEFAULT '',
      uploaded_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS document_contacts (
      document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
      PRIMARY KEY (document_id, contact_id)
    );

    CREATE TABLE IF NOT EXISTS document_projects (
      document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      PRIMARY KEY (document_id, project_id)
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'Open',
      priority TEXT NOT NULL DEFAULT 'Medium',
      due_date TEXT DEFAULT '',
      contact_id TEXT REFERENCES contacts(id) ON DELETE SET NULL,
      project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
      notes TEXT DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS activities (
      id TEXT PRIMARY KEY,
      subject_type TEXT NOT NULL CHECK (subject_type IN ('contact', 'project')),
      subject_id TEXT NOT NULL,
      activity_type TEXT NOT NULL DEFAULT 'Note',
      body TEXT NOT NULL,
      created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_contacts_name ON contacts(name);
    CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status);
    CREATE INDEX IF NOT EXISTS idx_tasks_due ON tasks(due_date);
    CREATE INDEX IF NOT EXISTS idx_documents_uploaded ON documents(uploaded_at);
    CREATE INDEX IF NOT EXISTS idx_activities_subject ON activities(subject_type, subject_id, created_at);
  `);

  addColumn("projects", "corridor", "TEXT DEFAULT ''");
  addColumn("projects", "site_fit", "TEXT DEFAULT ''");
  addColumn("projects", "land_status", "TEXT DEFAULT ''");
  addColumn("projects", "utility_status", "TEXT DEFAULT ''");
  addColumn("projects", "power_strategy", "TEXT DEFAULT ''");
  addColumn("projects", "hospitality_scope", "TEXT DEFAULT ''");
  addColumn("projects", "next_milestone", "TEXT DEFAULT ''");
  addColumn("projects", "risk_level", "TEXT DEFAULT 'Medium'");
  addColumn("documents", "document_category", "TEXT DEFAULT 'General'");
  addColumn("documents", "phase", "TEXT DEFAULT 'General'");
  addColumn("contacts", "created_by_user_id", "TEXT REFERENCES users(id) ON DELETE SET NULL");
  addColumn("projects", "created_by_user_id", "TEXT REFERENCES users(id) ON DELETE SET NULL");
  addColumn("documents", "uploaded_by_user_id", "TEXT REFERENCES users(id) ON DELETE SET NULL");
  addColumn("tasks", "assigned_to_user_id", "TEXT REFERENCES users(id) ON DELETE SET NULL");
  addColumn("tasks", "created_by_user_id", "TEXT REFERENCES users(id) ON DELETE SET NULL");
}

export function now() {
  return new Date().toISOString();
}

function addColumn(table: string, column: string, definition: string) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!columns.some((item) => item.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

export type UserRecord = {
  id: string;
  email: string;
  name: string;
  picture: string;
  role: string;
  provider: string;
  created_at: string;
  updated_at: string;
  last_login_at: string;
};

export function upsertUser(input: { email: string; name: string; picture?: string; provider?: string }) {
  const timestamp = now();
  const existing = db.prepare("SELECT * FROM users WHERE lower(email) = lower(?)").get(input.email) as UserRecord | undefined;
  if (existing) {
    db.prepare(
      `UPDATE users
       SET name = ?, picture = ?, provider = ?, updated_at = ?, last_login_at = ?
       WHERE id = ?`
    ).run(input.name, input.picture || "", input.provider || existing.provider || "google", timestamp, timestamp, existing.id);
    return db.prepare("SELECT * FROM users WHERE id = ?").get(existing.id) as UserRecord;
  }

  const user = {
    id: nanoid(12),
    email: input.email.toLowerCase(),
    name: input.name || input.email,
    picture: input.picture || "",
    provider: input.provider || "google",
    createdAt: timestamp,
    updatedAt: timestamp,
    lastLoginAt: timestamp
  };
  db.prepare(
    `INSERT INTO users (id, email, name, picture, provider, created_at, updated_at, last_login_at)
     VALUES (@id, @email, @name, @picture, @provider, @createdAt, @updatedAt, @lastLoginAt)`
  ).run(user);
  return db.prepare("SELECT * FROM users WHERE id = ?").get(user.id) as UserRecord;
}
