# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project: Atlas

Atlas is Rangeway's internal relationship and site-development system. It is intentionally **not** a generic sales CRM — it tracks people, locations, diligence, and next steps for a hospitality-driven EV charging network. The README.md is the source of truth for product scope and the Rangeway workflow model.

## Commands

```bash
npm install                # First-time setup (compiles better-sqlite3 native bindings)
cp .env.example .env       # Required before first dev run
npm run dev                # Concurrent: tsx watch server (8080) + Vite client (5173)
npm run dev:server         # Server only
npm run dev:client         # Client only
npm run typecheck          # Runs BOTH tsconfigs (client + server)
npm run build              # tsc server → dist/server, vite build → dist/client
npm start                  # Run built server (serves dist/client in production)
```

There is no test suite, no linter, and no formatter configured. Treat `npm run typecheck` as the only correctness gate.

Local default credentials when Google SSO is unconfigured: `admin@rangeway.energy` / `rangeway-dev`.

## Architecture

Atlas is a single Express app that serves a JSON API and (in production) the built React SPA. Client and server share no code — types are duplicated by hand in `src/client/src/main.tsx`.

### The two TypeScript projects

The repo has **two separate tsconfigs** and you must respect the difference:

- `tsconfig.json` — client only (`src/client`), `moduleResolution: "Bundler"`, `noEmit`. Vite handles imports.
- `tsconfig.server.json` — server only (`src/server`), `moduleResolution: "NodeNext"`, emits to `dist/server`.

Because the server is NodeNext ESM, **all relative imports in `src/server/**` must include the `.js` extension** (e.g. `from "./auth.js"`, `from "./db.js"`), even though the source files are `.ts`. Omitting `.js` breaks the build at runtime.

### File layout — almost everything is in three files

- `src/server/index.ts` (~800 lines) — every route, every SQL query, file uploads, Google OAuth callback, CSV exports, SPA fallback. New endpoints go here.
- `src/server/db.ts` — schema, migrations, `upsertUser`. See "Adding a column" below.
- `src/server/schemas.ts` — Zod input validation; enum values here are the source of truth for stage/status/category vocabulary.
- `src/client/src/main.tsx` (~1100 lines) — the entire React UI as one component tree with screen-switching state.
- `src/client/src/styles.css` — all styles.

When adding features, follow the existing pattern: extend the single file rather than splitting it up, unless the change is clearly large enough to warrant a new module.

### Auth and route ordering

Session is an HMAC-signed cookie (`rw_session`) issued by `setSessionCookie` in `auth.ts`. Order in `index.ts` is load-bearing:

1. Public routes registered first: `/api/health`, `/api/me`, `/api/auth/google*`, `/api/login`, `/api/logout`.
2. **Then** `app.use("/api", requireAuth)` and `app.use("/documents", requireAuth)` gate everything below.
3. Then all data routes and the document download handler.
4. Production-only: `express.static(clientDir)` and a `/.*/` SPA fallback at the very end.

Adding a public endpoint? Register it **above** the `requireAuth` mounts. Adding a private one? Below.

The global error handler at the bottom of `index.ts` maps `ZodError` to `400 { error: "Invalid input", details: error.flatten() }`. Routes can call `schema.parse(req.body)` directly and let throws propagate — no per-route try/catch needed.

Google SSO restricts to `GOOGLE_ALLOWED_DOMAIN` (default `rangeway.energy`) and verifies `hd`, `aud`, and `email_verified` from the `tokeninfo` endpoint.

### Database conventions

SQLite via better-sqlite3, WAL mode, foreign keys on. Two non-obvious conventions:

1. **Migrations are additive only.** The `CREATE TABLE IF NOT EXISTS` block in `migrate()` only runs against fresh databases. New columns on existing tables MUST be added via the `addColumn(table, column, definition)` helper at the bottom of `migrate()` — it checks `PRAGMA table_info` and `ALTER TABLE` only if missing. Do **not** modify existing `CREATE TABLE` statements; production databases will skip the change.

2. **Snake_case in SQL ↔ camelCase in JSON.** All columns are snake_case; the API returns camelCase. The conversion happens in `normalizeRecord` / `normalizeRows` (`index.ts`). When you add a column, queries that select it will automatically expose a camelCase key — no manual mapping needed. The client and Zod schemas use camelCase (e.g. `targetDate`, `landStatus`, `assignedToUserId`).

### Adding a new field end-to-end

A typical "add `xField` to projects" change touches all of these:

1. `db.ts` — add `addColumn("projects", "x_field", "TEXT DEFAULT ''")` at the end of `migrate()`.
2. `schemas.ts` — extend `projectSchema` with `xField: ...`.
3. `index.ts` — update the relevant `INSERT` / `UPDATE` SQL and the CSV export column list (`/api/export/projects.csv`).
4. `main.tsx` — add the field to the TS type, form, and detail view.

The same pattern applies to contacts, tasks, documents, and activities. Enum vocabularies must match across `schemas.ts` (Zod), `main.tsx` (dropdown arrays at the top of the file), and any CSV/UI label.

### Domain naming (UI vs. code)

The product surfaces Rangeway terminology while the schema keeps generic names. Don't rename the database — rename only at the UI/CSV-filename layer:

| Code / DB    | UI / CSV label        |
|--------------|-----------------------|
| `contacts`   | Stakeholders          |
| `projects`   | Location Pursuits     |
| `tasks`      | Next Steps            |
| `documents`  | Diligence             |
| `activities` | Activity              |

CSV download filenames already follow this (`atlas-stakeholders.csv`, `atlas-location-pursuits.csv`, `atlas-next-steps.csv`).

### File uploads

`multer` writes to `uploads/tmp` then moves to `uploads/documents`. Both extension **and** mime type must be in the allowlists at the top of `index.ts` (PDF, DOC, DOCX, XLS, XLSX). Size cap is `MAX_UPLOAD_MB` (default 30). Downloads go through `/documents/:id/download` and are auth-gated — never link to files in `uploads/` directly.

### Dev proxy

Vite (5173) proxies `/api` and `/documents` to the Express server (8080). When adding a new top-level route prefix, update `vite.config.ts` or it will 404 in dev only.

## Deployment

VPS via `deploy/deploy.sh`: runs `typecheck` + `build` locally, rsyncs the repo (excluding `node_modules`, `dist`, `data`, `uploads`, `.env`, `.git`) to `${ATLAS_DIR:-/opt/atlas}`, copies `.env.production` to `.env` on the server, and runs `docker compose up -d --build`. Caddy (`deploy/Caddyfile`) terminates TLS for `atlas.rangeway.app`.

Persistent state lives in two named Docker volumes — `rangeway-crm_crm-data` (SQLite) and `rangeway-crm_crm-uploads` (files). Never bake either into the image; `Dockerfile` creates the dirs but the compose volumes mount over them.

`SESSION_SECRET` is required in production. If Google OAuth env vars are absent, `ADMIN_EMAIL` and `ADMIN_PASSWORD` become required instead — see `config.ts`.

## Workspace context

This repo lives in the `~/Documents/GitHub/` multi-repo workspace described by the parent `CLAUDE.md`. Atlas is a separate Node/TypeScript project — it does not share the Rangeway brand front-end stack with `rangeway-pages`/`rangeway-investors`/etc., though it targets the same organization and `rangeway.energy` Google Workspace.
