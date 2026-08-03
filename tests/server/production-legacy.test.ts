import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/server/app.js";
import { config } from "../../src/server/config.js";

const organizationId = "00000000-0000-4000-8000-000000000001";
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temporaryDirectory(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "atlas-production-legacy-"));
  temporaryRoots.push(root);
  return root;
}

const identity = {
  async authenticateHuman() {
    return {
      actorId: "10000000-0000-4000-8000-000000000001",
      actorType: "human" as const,
      actorName: "Atlas Admin",
      organizationId,
      role: "owner" as const,
      userId: "20000000-0000-4000-8000-000000000001",
    };
  },
  async authenticateServiceKey() {
    throw new Error("not used");
  },
  async authenticateLocal() {
    throw new Error("not used");
  },
};

function productionApp(databasePath: string, uploadDir: string) {
  return createApp({
    config: {
      ...config,
      nodeEnv: "production",
      isProduction: true,
      authMode: "google",
      databasePath,
      uploadDir,
      googleClientId: "google-client",
      googleClientSecret: "google-secret",
      googleRedirectUri: "https://atlas.rangeway.app/api/auth/google/callback",
      publicUrl: "https://atlas.rangeway.app",
    },
    v2Identity: identity,
    logger: { error: () => undefined },
  });
}

describe("production legacy isolation", () => {
  it("returns a safe 404 before any legacy contact, project, task, document, or upload mutation", async () => {
    const root = temporaryDirectory();
    const databasePath = path.join(root, "data", "legacy.sqlite");
    const uploadDir = path.join(root, "uploads");
    const app = productionApp(databasePath, uploadDir);
    const responses = [
      await request(app).post("/api/contacts").send({ name: "Blocked" }),
      await request(app).patch("/api/contacts/contact-1").send({ name: "Blocked" }),
      await request(app).delete("/api/contacts/contact-1"),
      await request(app).post("/api/projects").send({ name: "Blocked" }),
      await request(app).patch("/api/projects/project-1").send({ name: "Blocked" }),
      await request(app).delete("/api/projects/project-1"),
      await request(app).post("/api/tasks").send({ title: "Blocked" }),
      await request(app).patch("/api/tasks/task-1").send({ title: "Blocked" }),
      await request(app).delete("/api/tasks/task-1"),
      await request(app).post("/api/documents").attach("file", Buffer.from("blocked"), {
        filename: "blocked.pdf",
        contentType: "application/pdf",
      }),
      await request(app).patch("/api/documents/document-1").send({ notes: "Blocked" }),
      await request(app).delete("/api/documents/document-1"),
      await request(app).get("/documents/document-1/download"),
    ];

    for (const [index, response] of responses.entries()) {
      expect(response.status, `legacy request ${index}: ${response.text}`).toBe(404);
      expect(response.body).toEqual({ error: "Not found" });
    }
    expect(existsSync(databasePath)).toBe(false);
    expect(existsSync(uploadDir)).toBe(false);
  });

  it("issues a production Google session from PostgreSQL actor identity without creating V1 persistence", async () => {
    const root = temporaryDirectory();
    const databasePath = path.join(root, "data", "legacy.sqlite");
    const uploadDir = path.join(root, "uploads");
    const app = createApp({
      config: {
        ...config,
        nodeEnv: "production",
        isProduction: true,
        authMode: "google",
        databasePath,
        uploadDir,
        googleClientId: "google-client",
        googleClientSecret: "google-secret",
        googleRedirectUri: "https://atlas.rangeway.app/api/auth/google/callback",
        publicUrl: "https://atlas.rangeway.app",
      },
      v2Identity: identity,
      googleOAuth: {
        exchangeCode: async () => "verified-token",
        verifyIdToken: async () => ({
          email: "ADMIN@RANGEWAY.ENERGY",
          name: "Atlas Admin",
          picture: "",
        }),
      },
      logger: { error: () => undefined },
    });
    const begin = await request(app).get("/api/auth/google");
    const stateCookie = begin.headers["set-cookie"][0].split(";")[0];
    const state = new URL(begin.headers.location).searchParams.get("state");
    const callback = await request(app)
      .get("/api/auth/google/callback")
      .query({ code: "authorization-code", state })
      .set("Cookie", stateCookie);

    expect(callback.status).toBe(302);
    expect(callback.headers["set-cookie"]).toEqual(
      expect.arrayContaining([expect.stringMatching(/^rw_session=/)]),
    );
    const sessionCookieHeader = callback.headers["set-cookie"].find((value: string) =>
      value.startsWith("rw_session="),
    );
    expect(sessionCookieHeader).toBeDefined();
    const sessionCookie = sessionCookieHeader!.split(";")[0];
    const me = await request(app).get("/api/me").set("Cookie", sessionCookie);
    expect(me.status).toBe(200);
    expect(me.body).toEqual({
      user: {
        id: "20000000-0000-4000-8000-000000000001",
        email: "admin@rangeway.energy",
        name: "Atlas Admin",
        picture: "",
      },
    });
    const logout = await request(app).post("/api/logout").set("Cookie", sessionCookie);
    expect(logout.status).toBe(200);
    expect(logout.body).toEqual({ ok: true });
    expect(existsSync(databasePath)).toBe(false);
    expect(existsSync(uploadDir)).toBe(false);
  });

  it("keeps development persistence lazy until a legacy operation uses it", () => {
    const root = temporaryDirectory();
    const databasePath = path.join(root, "data", "legacy.sqlite");
    const uploadDir = path.join(root, "uploads");
    const script = `
      import fs from "node:fs";
      import request from "supertest";
      const { createApp } = await import("./src/server/app.ts");
      const beforeApp = [fs.existsSync(process.env.DATABASE_PATH), fs.existsSync(process.env.UPLOAD_DIR)];
      const app = createApp();
      const afterApp = [fs.existsSync(process.env.DATABASE_PATH), fs.existsSync(process.env.UPLOAD_DIR)];
      await request(app).get("/api/health");
      const afterHealth = [fs.existsSync(process.env.DATABASE_PATH), fs.existsSync(process.env.UPLOAD_DIR)];
      const login = await request(app).post("/api/login").send({ email: "admin@rangeway.energy", password: "rangeway-dev" });
      const cookie = login.headers["set-cookie"][0].split(";")[0];
      const afterLogin = [fs.existsSync(process.env.DATABASE_PATH), fs.existsSync(process.env.UPLOAD_DIR)];
      await request(app).post("/api/documents").set("Cookie", cookie).attach("file", Buffer.from("pdf"), { filename: "test.pdf", contentType: "application/pdf" });
      const afterUpload = [fs.existsSync(process.env.DATABASE_PATH), fs.existsSync(process.env.UPLOAD_DIR)];
      console.log(JSON.stringify({ beforeApp, afterApp, afterHealth, afterLogin, afterUpload }));
    `;
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "--eval", script],
      {
        cwd: path.resolve(import.meta.dirname, "../.."),
        encoding: "utf8",
        env: {
          ...process.env,
          NODE_ENV: "development",
          DATABASE_PATH: databasePath,
          UPLOAD_DIR: uploadDir,
        },
      },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual({
      beforeApp: [false, false],
      afterApp: [false, false],
      afterHealth: [false, false],
      afterLogin: [true, false],
      afterUpload: [true, true],
    });
  });
});
