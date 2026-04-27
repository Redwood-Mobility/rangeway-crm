import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import cookieParser from "cookie-parser";
import cors from "cors";
import express from "express";
import multer from "multer";
import { nanoid } from "nanoid";
import { ZodError } from "zod";
import { config } from "./config.js";
import { clearSessionCookie, constantTimeEqual, currentUser, requireAuth, setSessionCookie } from "./auth.js";
import { db, migrate, now, upsertUser } from "./db.js";
import {
  contactSchema,
  activitySchema,
  documentPatchSchema,
  linkContactSchema,
  linkProjectSchema,
  loginSchema,
  projectSchema,
  taskSchema
} from "./schemas.js";

type Row = Record<string, unknown>;

const app = express();
const clientDir = path.join(process.cwd(), "dist", "client");
const documentDir = path.join(config.uploadDir, "documents");
const tempDir = path.join(config.uploadDir, "tmp");
const allowedExtensions = new Set([".pdf", ".doc", ".docx", ".xls", ".xlsx"]);
const allowedMimeTypes = new Set([
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
]);

fs.mkdirSync(documentDir, { recursive: true });
fs.mkdirSync(tempDir, { recursive: true });
migrate();

const upload = multer({
  dest: tempDir,
  limits: { fileSize: config.maxUploadBytes },
  fileFilter(_req, file, cb) {
    const extension = path.extname(file.originalname).toLowerCase();
    if (allowedExtensions.has(extension) && allowedMimeTypes.has(file.mimetype)) {
      cb(null, true);
      return;
    }
    cb(new Error("Only PDF, DOC, DOCX, XLS, and XLSX files are supported."));
  }
});

app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());

if (!config.isProduction) {
  app.use(cors({ origin: "http://localhost:5173", credentials: true }));
}

function normalizeRecord(row: Row) {
  const record: Row = {};
  for (const [key, value] of Object.entries(row)) {
    record[key.replace(/_([a-z])/g, (_match, char: string) => char.toUpperCase())] = value;
  }
  return record;
}

function normalizeRows(rows: Row[]) {
  return rows.map(normalizeRecord);
}

function parseIdList(value: unknown) {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string" && item.length > 0);
  if (typeof value !== "string" || value.length === 0) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (Array.isArray(parsed)) return parsed.filter((item): item is string => typeof item === "string" && item.length > 0);
  } catch {
    return [];
  }
  return [];
}

function safeUnlink(filePath: string) {
  try {
    fs.unlinkSync(filePath);
  } catch {
    // The database row is the source of truth; missing files should not block record cleanup.
  }
}

function redirectUri() {
  return `${config.publicUrl.replace(/\/$/, "")}/api/auth/google/callback`;
}

function decodeJwtPayload(token: string) {
  const payload = token.split(".")[1];
  if (!payload) return {};
  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Row;
  } catch {
    return {};
  }
}

function sessionUser(user: Row) {
  return {
    id: String(user.id),
    email: String(user.email),
    name: String(user.name || user.email),
    picture: String(user.picture || "")
  };
}

async function verifyGoogleIdToken(idToken: string) {
  const response = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`);
  if (!response.ok) throw new Error("Google sign-in could not be verified.");
  const tokenInfo = (await response.json()) as Row;
  const tokenPayload = decodeJwtPayload(idToken);
  const email = String(tokenInfo.email || "").toLowerCase();
  const hostedDomain = String(tokenInfo.hd || "").toLowerCase();
  const allowedDomain = config.googleAllowedDomain.toLowerCase();
  const emailVerified = tokenInfo.email_verified === true || tokenInfo.email_verified === "true";

  if (String(tokenInfo.aud) !== config.googleClientId) throw new Error("Google sign-in audience mismatch.");
  if (!emailVerified) throw new Error("Google account email is not verified.");
  if (hostedDomain !== allowedDomain || !email.endsWith(`@${allowedDomain}`)) {
    throw new Error(`Atlas is limited to ${allowedDomain} accounts.`);
  }

  return {
    email,
    name: String(tokenPayload.name || tokenInfo.name || email),
    picture: String(tokenPayload.picture || tokenInfo.picture || "")
  };
}

function attachDocumentRelations(documentId: string, contactIds: string[], projectIds: string[]) {
  const addContact = db.prepare("INSERT OR IGNORE INTO document_contacts (document_id, contact_id) VALUES (?, ?)");
  const addProject = db.prepare("INSERT OR IGNORE INTO document_projects (document_id, project_id) VALUES (?, ?)");
  for (const contactId of contactIds) addContact.run(documentId, contactId);
  for (const projectId of projectIds) addProject.run(documentId, projectId);
}

function addActivity(subjectType: "contact" | "project", subjectId: string, input: { activityType?: string; body: string }, userId: string) {
  const id = nanoid(12);
  db.prepare(
    `INSERT INTO activities (id, subject_type, subject_id, activity_type, body, created_by_user_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(id, subjectType, subjectId, input.activityType || "Note", input.body, userId, now());
  return id;
}

function getActivities(subjectType: "contact" | "project", subjectId: string) {
  return normalizeRows(
    db
      .prepare(
        `SELECT a.*, u.name AS created_by_name, u.email AS created_by_email
         FROM activities a
         LEFT JOIN users u ON u.id = a.created_by_user_id
         WHERE a.subject_type = ? AND a.subject_id = ?
         ORDER BY a.created_at DESC`
      )
      .all(subjectType, subjectId) as Row[]
  );
}

function csvCell(value: unknown) {
  if (value === null || value === undefined) return "";
  let text = String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

const CSV_ROW_CAP = 50000;

function sendCsv(res: express.Response, filename: string, rows: Row[], headers: string[]) {
  const truncated = rows.length > CSV_ROW_CAP;
  const visibleRows = truncated ? rows.slice(0, CSV_ROW_CAP) : rows;
  const csv = [headers.join(","), ...visibleRows.map((row) => headers.map((header) => csvCell(row[header])).join(","))].join("\n");
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  if (truncated) res.setHeader("X-Atlas-Truncated", "true");
  res.send(csv);
}

function getContact(id: string) {
  const contact = db.prepare("SELECT * FROM contacts WHERE id = ?").get(id) as Row | undefined;
  if (!contact) return null;
  return {
    ...normalizeRecord(contact),
    projects: normalizeRows(
      db
        .prepare(
          `SELECT p.*, cp.relationship, cp.notes AS relationship_notes
           FROM projects p
           JOIN contact_projects cp ON cp.project_id = p.id
           WHERE cp.contact_id = ?
           ORDER BY p.updated_at DESC`
        )
        .all(id) as Row[]
    ),
    documents: normalizeRows(
      db
        .prepare(
          `SELECT d.*
           FROM documents d
           JOIN document_contacts dc ON dc.document_id = d.id
           WHERE dc.contact_id = ?
           ORDER BY d.uploaded_at DESC`
        )
        .all(id) as Row[]
    ),
    activities: getActivities("contact", id),
    tasks: normalizeRows(db.prepare("SELECT * FROM tasks WHERE contact_id = ? ORDER BY due_date = '', due_date ASC, created_at DESC").all(id) as Row[])
  };
}

function getProject(id: string) {
  const project = db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as Row | undefined;
  if (!project) return null;
  return {
    ...normalizeRecord(project),
    contacts: normalizeRows(
      db
        .prepare(
          `SELECT c.*, cp.relationship, cp.notes AS relationship_notes
           FROM contacts c
           JOIN contact_projects cp ON cp.contact_id = c.id
           WHERE cp.project_id = ?
           ORDER BY c.name ASC`
        )
        .all(id) as Row[]
    ),
    documents: normalizeRows(
      db
        .prepare(
          `SELECT d.*
           FROM documents d
           JOIN document_projects dp ON dp.document_id = d.id
           WHERE dp.project_id = ?
           ORDER BY d.uploaded_at DESC`
        )
        .all(id) as Row[]
    ),
    activities: getActivities("project", id),
    tasks: normalizeRows(db.prepare("SELECT * FROM tasks WHERE project_id = ? ORDER BY due_date = '', due_date ASC, created_at DESC").all(id) as Row[])
  };
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, time: now() });
});

app.get("/api/me", (req, res) => {
  res.json({ user: currentUser(req) });
});

app.get("/api/auth/google", (_req, res) => {
  if (!config.googleClientId || !config.googleClientSecret) {
    res.status(503).send("Google SSO is not configured.");
    return;
  }

  const state = crypto.randomBytes(24).toString("base64url");
  res.cookie("rw_oauth_state", state, {
    httpOnly: true,
    sameSite: "lax",
    secure: config.isProduction,
    maxAge: 1000 * 60 * 10,
    path: "/api/auth/google"
  });

  const params = new URLSearchParams({
    client_id: config.googleClientId,
    redirect_uri: redirectUri(),
    response_type: "code",
    scope: "openid email profile",
    state,
    hd: config.googleAllowedDomain
  });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
});

app.get("/api/auth/google/callback", async (req, res, next) => {
  try {
    const code = typeof req.query.code === "string" ? req.query.code : "";
    const state = typeof req.query.state === "string" ? req.query.state : "";
    const expectedState = typeof req.cookies?.rw_oauth_state === "string" ? req.cookies.rw_oauth_state : "";
    res.clearCookie("rw_oauth_state", { path: "/api/auth/google" });

    if (!code || !state || !expectedState || !constantTimeEqual(state, expectedState)) {
      res.status(400).send("Invalid Google sign-in state.");
      return;
    }

    const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: config.googleClientId,
        client_secret: config.googleClientSecret,
        redirect_uri: redirectUri(),
        grant_type: "authorization_code"
      })
    });

    const tokenData = (await tokenResponse.json()) as { id_token?: string; error_description?: string };
    if (!tokenResponse.ok || !tokenData.id_token) {
      throw new Error(tokenData.error_description || "Google sign-in failed.");
    }

    const googleUser = await verifyGoogleIdToken(tokenData.id_token);
    const user = upsertUser({ ...googleUser, provider: "google" });
    setSessionCookie(res, sessionUser(user));
    res.redirect(config.publicUrl);
  } catch (error) {
    next(error);
  }
});

app.post("/api/login", (req, res) => {
  const input = loginSchema.parse(req.body);
  if (!constantTimeEqual(input.email.toLowerCase(), config.adminEmail.toLowerCase()) || !constantTimeEqual(input.password, config.adminPassword)) {
    res.status(401).json({ error: "Invalid email or password" });
    return;
  }
  const user = upsertUser({ email: config.adminEmail, name: "Atlas Admin", provider: "local" });
  const payload = sessionUser(user);
  setSessionCookie(res, payload);
  res.json({ user: payload });
});

app.post("/api/logout", (_req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

app.use("/api", requireAuth);
app.use("/documents", requireAuth);

app.get("/api/users", (_req, res) => {
  const users = db.prepare("SELECT id, email, name, picture, role, last_login_at FROM users ORDER BY name ASC").all() as Row[];
  res.json({ users: normalizeRows(users) });
});

app.get("/api/export/contacts.csv", (_req, res) => {
  const rows = db
    .prepare(
      `SELECT name, company, role, email, phone, location, stage, category, notes, created_at, updated_at
       FROM contacts
       ORDER BY updated_at DESC
       LIMIT ?`
    )
    .all(CSV_ROW_CAP + 1) as Row[];
  sendCsv(res, "atlas-stakeholders.csv", rows, ["name", "company", "role", "email", "phone", "location", "stage", "category", "notes", "created_at", "updated_at"]);
});

app.get("/api/export/projects.csv", (_req, res) => {
  const rows = db
    .prepare(
      `SELECT name, format, status, priority, location, corridor, site_fit, land_status, utility_status,
        power_strategy, hospitality_scope, next_milestone, risk_level, owner, target_date, estimated_value, notes, created_at, updated_at
       FROM projects
       ORDER BY updated_at DESC
       LIMIT ?`
    )
    .all(CSV_ROW_CAP + 1) as Row[];
  sendCsv(res, "atlas-location-pursuits.csv", rows, [
    "name",
    "format",
    "status",
    "priority",
    "location",
    "corridor",
    "site_fit",
    "land_status",
    "utility_status",
    "power_strategy",
    "hospitality_scope",
    "next_milestone",
    "risk_level",
    "owner",
    "target_date",
    "estimated_value",
    "notes",
    "created_at",
    "updated_at"
  ]);
});

app.get("/api/export/tasks.csv", (_req, res) => {
  const rows = db
    .prepare(
      `SELECT t.title, t.status, t.priority, t.due_date, c.name AS stakeholder, p.name AS location_pursuit,
        u.name AS assigned_to, t.notes, t.created_at, t.updated_at
       FROM tasks t
       LEFT JOIN contacts c ON c.id = t.contact_id
       LEFT JOIN projects p ON p.id = t.project_id
       LEFT JOIN users u ON u.id = t.assigned_to_user_id
       ORDER BY t.status = 'Done', t.due_date = '', t.due_date ASC
       LIMIT ?`
    )
    .all(CSV_ROW_CAP + 1) as Row[];
  sendCsv(res, "atlas-next-steps.csv", rows, ["title", "status", "priority", "due_date", "stakeholder", "location_pursuit", "assigned_to", "notes", "created_at", "updated_at"]);
});

app.get("/api/dashboard", (_req, res) => {
  const totals = db
    .prepare(
      `SELECT
        (SELECT COUNT(*) FROM contacts) AS contacts,
        (SELECT COUNT(*) FROM projects) AS projects,
        (SELECT COUNT(*) FROM documents) AS documents,
        (SELECT COUNT(*) FROM tasks WHERE status != 'Done') AS openTasks,
        (SELECT COUNT(*) FROM projects WHERE status IN ('Scouting', 'Outreach', 'Discovery', 'Site Control', 'Utility Study')) AS activePursuits,
        (SELECT COUNT(*) FROM projects WHERE risk_level IN ('High', 'Blocked')) AS highRisk`
    )
    .get() as Row;
  const projectStatus = db.prepare("SELECT status, COUNT(*) AS count FROM projects GROUP BY status ORDER BY count DESC").all() as Row[];
  const formatMix = db.prepare("SELECT format, COUNT(*) AS count FROM projects GROUP BY format ORDER BY count DESC").all() as Row[];
  const upcomingTasks = db
    .prepare(
      `SELECT t.*, c.name AS contact_name, p.name AS project_name, u.name AS assigned_to_name, u.email AS assigned_to_email
       FROM tasks t
       LEFT JOIN contacts c ON c.id = t.contact_id
       LEFT JOIN projects p ON p.id = t.project_id
       LEFT JOIN users u ON u.id = t.assigned_to_user_id
       WHERE t.status != 'Done'
       ORDER BY t.due_date = '', t.due_date ASC, t.created_at DESC
       LIMIT 8`
    )
    .all() as Row[];
  const recentDocuments = db.prepare("SELECT * FROM documents ORDER BY uploaded_at DESC LIMIT 6").all() as Row[];
  res.json({
    totals: normalizeRecord(totals),
    projectStatus: normalizeRows(projectStatus),
    formatMix: normalizeRows(formatMix),
    upcomingTasks: normalizeRows(upcomingTasks),
    recentDocuments: normalizeRows(recentDocuments)
  });
});

app.get("/api/contacts", (_req, res) => {
  const rows = db
    .prepare(
      `SELECT c.*,
        COUNT(DISTINCT cp.project_id) AS project_count,
        COUNT(DISTINCT dc.document_id) AS document_count
       FROM contacts c
       LEFT JOIN contact_projects cp ON cp.contact_id = c.id
       LEFT JOIN document_contacts dc ON dc.contact_id = c.id
       GROUP BY c.id
       ORDER BY c.updated_at DESC`
    )
    .all() as Row[];
  res.json({ contacts: normalizeRows(rows) });
});

app.post("/api/contacts", (req, res) => {
  const input = contactSchema.parse(req.body);
  const id = nanoid(12);
  const timestamp = now();
  const transaction = db.transaction(() => {
    db.prepare(
      `INSERT INTO contacts (id, name, company, role, email, phone, location, stage, category, notes, created_by_user_id, created_at, updated_at)
       VALUES (@id, @name, @company, @role, @email, @phone, @location, @stage, @category, @notes, @createdByUserId, @createdAt, @updatedAt)`
    ).run({ id, ...input, createdByUserId: res.locals.user.id, createdAt: timestamp, updatedAt: timestamp });
    addActivity("contact", id, { activityType: "Milestone", body: `Created stakeholder record for ${input.name}.` }, res.locals.user.id);
  });
  transaction();
  res.status(201).json({ contact: getContact(id) });
});

app.get("/api/contacts/:id", (req, res) => {
  const contact = getContact(req.params.id);
  if (!contact) {
    res.status(404).json({ error: "Contact not found" });
    return;
  }
  res.json({ contact });
});

app.patch("/api/contacts/:id", (req, res) => {
  if (!getContact(req.params.id)) {
    res.status(404).json({ error: "Contact not found" });
    return;
  }
  const input = contactSchema.parse(req.body);
  db.prepare(
    `UPDATE contacts SET
      name=@name, company=@company, role=@role, email=@email, phone=@phone, location=@location,
      stage=@stage, category=@category, notes=@notes, updated_at=@updatedAt
     WHERE id=@id`
  ).run({ id: req.params.id, ...input, updatedAt: now() });
  addActivity("contact", req.params.id, { activityType: "Note", body: "Updated stakeholder details." }, res.locals.user.id);
  res.json({ contact: getContact(req.params.id) });
});

app.post("/api/contacts/:id/activities", (req, res) => {
  if (!getContact(req.params.id)) {
    res.status(404).json({ error: "Contact not found" });
    return;
  }
  const input = activitySchema.parse(req.body);
  addActivity("contact", req.params.id, input, res.locals.user.id);
  res.status(201).json({ activities: getActivities("contact", req.params.id) });
});

app.delete("/api/contacts/:id", (req, res) => {
  const transaction = db.transaction(() => {
    db.prepare("DELETE FROM activities WHERE subject_type = 'contact' AND subject_id = ?").run(req.params.id);
    db.prepare("DELETE FROM contacts WHERE id = ?").run(req.params.id);
  });
  transaction();
  res.json({ ok: true });
});

app.post("/api/contacts/:id/projects", (req, res) => {
  if (!getContact(req.params.id)) {
    res.status(404).json({ error: "Contact not found" });
    return;
  }
  const input = linkProjectSchema.parse(req.body);
  if (!getProject(input.projectId)) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  db.prepare(
    `INSERT INTO contact_projects (contact_id, project_id, relationship, notes, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(contact_id, project_id) DO UPDATE SET relationship=excluded.relationship, notes=excluded.notes`
  ).run(req.params.id, input.projectId, input.relationship, input.notes, now());
  res.json({ contact: getContact(req.params.id) });
});

app.delete("/api/contacts/:contactId/projects/:projectId", (req, res) => {
  db.prepare("DELETE FROM contact_projects WHERE contact_id = ? AND project_id = ?").run(req.params.contactId, req.params.projectId);
  res.json({ ok: true });
});

app.get("/api/projects", (_req, res) => {
  const rows = db
    .prepare(
      `SELECT p.*,
        COUNT(DISTINCT cp.contact_id) AS contact_count,
        COUNT(DISTINCT dp.document_id) AS document_count,
        COUNT(DISTINCT t.id) AS task_count
       FROM projects p
       LEFT JOIN contact_projects cp ON cp.project_id = p.id
       LEFT JOIN document_projects dp ON dp.project_id = p.id
       LEFT JOIN tasks t ON t.project_id = p.id AND t.status != 'Done'
       GROUP BY p.id
       ORDER BY p.updated_at DESC`
    )
    .all() as Row[];
  res.json({ projects: normalizeRows(rows) });
});

app.post("/api/projects", (req, res) => {
  const input = projectSchema.parse(req.body);
  const id = nanoid(12);
  const timestamp = now();
  const transaction = db.transaction(() => {
    db.prepare(
      `INSERT INTO projects (
        id, name, format, status, priority, location, owner, target_date, estimated_value,
        corridor, site_fit, land_status, utility_status, power_strategy, hospitality_scope,
        next_milestone, risk_level, notes, created_by_user_id, created_at, updated_at
      )
     VALUES (
        @id, @name, @format, @status, @priority, @location, @owner, @targetDate, @estimatedValue,
        @corridor, @siteFit, @landStatus, @utilityStatus, @powerStrategy, @hospitalityScope,
        @nextMilestone, @riskLevel, @notes, @createdByUserId, @createdAt, @updatedAt
      )`
    ).run({ id, ...input, createdByUserId: res.locals.user.id, createdAt: timestamp, updatedAt: timestamp });
    addActivity("project", id, { activityType: "Milestone", body: `Created ${input.format} pursuit: ${input.name}.` }, res.locals.user.id);
  });
  transaction();
  res.status(201).json({ project: getProject(id) });
});

app.get("/api/projects/:id", (req, res) => {
  const project = getProject(req.params.id);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  res.json({ project });
});

app.patch("/api/projects/:id", (req, res) => {
  if (!getProject(req.params.id)) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  const input = projectSchema.parse(req.body);
  db.prepare(
    `UPDATE projects SET
      name=@name, format=@format, status=@status, priority=@priority, location=@location,
      owner=@owner, target_date=@targetDate, estimated_value=@estimatedValue,
      corridor=@corridor, site_fit=@siteFit, land_status=@landStatus, utility_status=@utilityStatus,
      power_strategy=@powerStrategy, hospitality_scope=@hospitalityScope, next_milestone=@nextMilestone,
      risk_level=@riskLevel, notes=@notes, updated_at=@updatedAt
     WHERE id=@id`
  ).run({ id: req.params.id, ...input, updatedAt: now() });
  addActivity("project", req.params.id, { activityType: "Note", body: "Updated location pursuit details." }, res.locals.user.id);
  res.json({ project: getProject(req.params.id) });
});

app.post("/api/projects/:id/activities", (req, res) => {
  if (!getProject(req.params.id)) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  const input = activitySchema.parse(req.body);
  addActivity("project", req.params.id, input, res.locals.user.id);
  res.status(201).json({ activities: getActivities("project", req.params.id) });
});

app.delete("/api/projects/:id", (req, res) => {
  const transaction = db.transaction(() => {
    db.prepare("DELETE FROM activities WHERE subject_type = 'project' AND subject_id = ?").run(req.params.id);
    db.prepare("DELETE FROM projects WHERE id = ?").run(req.params.id);
  });
  transaction();
  res.json({ ok: true });
});

app.post("/api/projects/:id/contacts", (req, res) => {
  if (!getProject(req.params.id)) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  const input = linkContactSchema.parse(req.body);
  if (!getContact(input.contactId)) {
    res.status(404).json({ error: "Contact not found" });
    return;
  }
  db.prepare(
    `INSERT INTO contact_projects (contact_id, project_id, relationship, notes, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(contact_id, project_id) DO UPDATE SET relationship=excluded.relationship, notes=excluded.notes`
  ).run(input.contactId, req.params.id, input.relationship, input.notes, now());
  res.json({ project: getProject(req.params.id) });
});

app.delete("/api/projects/:projectId/contacts/:contactId", (req, res) => {
  db.prepare("DELETE FROM contact_projects WHERE contact_id = ? AND project_id = ?").run(req.params.contactId, req.params.projectId);
  res.json({ ok: true });
});

app.get("/api/documents", (_req, res) => {
  const rows = db
    .prepare(
      `SELECT d.*,
        COUNT(DISTINCT dc.contact_id) AS contact_count,
        COUNT(DISTINCT dp.project_id) AS project_count
       FROM documents d
       LEFT JOIN document_contacts dc ON dc.document_id = d.id
       LEFT JOIN document_projects dp ON dp.document_id = d.id
       GROUP BY d.id
       ORDER BY d.uploaded_at DESC`
    )
    .all() as Row[];
  res.json({ documents: normalizeRows(rows) });
});

app.post("/api/documents", upload.single("file"), (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: "A document file is required" });
    return;
  }

  const id = nanoid(12);
  const extension = path.extname(req.file.originalname).toLowerCase();
  const storedName = `${id}${extension}`;
  const destination = path.join(documentDir, storedName);
  const contactIds = parseIdList(req.body.contactIds);
  const projectIds = parseIdList(req.body.projectIds);
  const notes = typeof req.body.notes === "string" ? req.body.notes.slice(0, 5000) : "";
  const documentCategory = typeof req.body.documentCategory === "string" ? req.body.documentCategory : "General";
  const phase = typeof req.body.phase === "string" ? req.body.phase : "General";

  const transaction = db.transaction(() => {
    fs.renameSync(req.file!.path, destination);
    db.prepare(
      `INSERT INTO documents (id, original_name, stored_name, mime_type, size, notes, document_category, phase, uploaded_by_user_id, uploaded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, req.file!.originalname, storedName, req.file!.mimetype, req.file!.size, notes, documentCategory, phase, res.locals.user.id, now());
    attachDocumentRelations(id, contactIds, projectIds);
  });

  try {
    transaction();
    res.status(201).json({ document: normalizeRecord(db.prepare("SELECT * FROM documents WHERE id = ?").get(id) as Row) });
  } catch (error) {
    safeUnlink(req.file.path);
    safeUnlink(destination);
    throw error;
  }
});

app.patch("/api/documents/:id", (req, res) => {
  const input = documentPatchSchema.parse(req.body);
  const document = db.prepare("SELECT * FROM documents WHERE id = ?").get(req.params.id) as Row | undefined;
  if (!document) {
    res.status(404).json({ error: "Document not found" });
    return;
  }
  const transaction = db.transaction(() => {
    db.prepare("UPDATE documents SET notes = ?, document_category = ?, phase = ? WHERE id = ?").run(input.notes, input.documentCategory, input.phase, req.params.id);
    db.prepare("DELETE FROM document_contacts WHERE document_id = ?").run(req.params.id);
    db.prepare("DELETE FROM document_projects WHERE document_id = ?").run(req.params.id);
    attachDocumentRelations(req.params.id, input.contactIds, input.projectIds);
  });
  transaction();
  res.json({ document: normalizeRecord(db.prepare("SELECT * FROM documents WHERE id = ?").get(req.params.id) as Row) });
});

app.delete("/api/documents/:id", (req, res) => {
  const document = db.prepare("SELECT * FROM documents WHERE id = ?").get(req.params.id) as Row | undefined;
  if (document?.stored_name) {
    safeUnlink(path.join(documentDir, String(document.stored_name)));
  }
  db.prepare("DELETE FROM documents WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

app.get("/documents/:id/download", (req, res) => {
  const document = db.prepare("SELECT * FROM documents WHERE id = ?").get(req.params.id) as Row | undefined;
  if (!document) {
    res.status(404).send("Document not found");
    return;
  }
  res.download(path.join(documentDir, String(document.stored_name)), String(document.original_name));
});

app.get("/api/tasks", (_req, res) => {
  const rows = db
    .prepare(
      `SELECT t.*, c.name AS contact_name, p.name AS project_name, u.name AS assigned_to_name, u.email AS assigned_to_email
       FROM tasks t
       LEFT JOIN contacts c ON c.id = t.contact_id
       LEFT JOIN projects p ON p.id = t.project_id
       LEFT JOIN users u ON u.id = t.assigned_to_user_id
       ORDER BY t.status = 'Done', t.due_date = '', t.due_date ASC, t.created_at DESC`
    )
    .all() as Row[];
  res.json({ tasks: normalizeRows(rows) });
});

app.post("/api/tasks", (req, res) => {
  const input = taskSchema.parse(req.body);
  const id = nanoid(12);
  const timestamp = now();
  const assignedToUserId = input.assignedToUserId || res.locals.user.id;
  db.prepare(
    `INSERT INTO tasks (id, title, status, priority, due_date, contact_id, project_id, assigned_to_user_id, created_by_user_id, notes, created_at, updated_at)
     VALUES (@id, @title, @status, @priority, @dueDate, @contactId, @projectId, @assignedToUserId, @createdByUserId, @notes, @createdAt, @updatedAt)`
  ).run({
    id,
    ...input,
    contactId: input.contactId || null,
    projectId: input.projectId || null,
    assignedToUserId,
    createdByUserId: res.locals.user.id,
    createdAt: timestamp,
    updatedAt: timestamp
  });
  res.status(201).json({ task: normalizeRecord(db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as Row) });
});

app.patch("/api/tasks/:id", (req, res) => {
  const existing = db.prepare("SELECT * FROM tasks WHERE id = ?").get(req.params.id) as Row | undefined;
  if (!existing) {
    res.status(404).json({ error: "Task not found" });
    return;
  }
  const input = taskSchema.parse(req.body);
  db.prepare(
    `UPDATE tasks SET
      title=@title, status=@status, priority=@priority, due_date=@dueDate,
      contact_id=@contactId, project_id=@projectId, assigned_to_user_id=@assignedToUserId, notes=@notes, updated_at=@updatedAt
     WHERE id=@id`
  ).run({ id: req.params.id, ...input, contactId: input.contactId || null, projectId: input.projectId || null, assignedToUserId: input.assignedToUserId || null, updatedAt: now() });
  res.json({ task: normalizeRecord(db.prepare("SELECT * FROM tasks WHERE id = ?").get(req.params.id) as Row) });
});

app.delete("/api/tasks/:id", (req, res) => {
  db.prepare("DELETE FROM tasks WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (error instanceof ZodError) {
    res.status(400).json({ error: "Invalid input", details: error.flatten() });
    return;
  }
  const status = error instanceof multer.MulterError ? 400 : 500;
  const message = error instanceof Error ? error.message : "Unexpected server error";
  res.status(status).json({ error: message });
});

if (config.isProduction && fs.existsSync(clientDir)) {
  app.use(express.static(clientDir));
  app.get(/.*/, (_req, res) => {
    res.sendFile(path.join(clientDir, "index.html"));
  });
}

app.listen(config.port, () => {
  console.log(`Atlas listening on port ${config.port}`);
});
