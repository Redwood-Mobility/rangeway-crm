import request from "supertest";
import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/server/app.js";
import { config } from "../../src/server/config.js";

describe("GET /api/v2/health", () => {
  it("returns the V2 service identity", async () => {
    const response = await request(createApp()).get("/api/v2/health");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      status: "ok",
      service: "atlas-web",
      apiVersion: "v2",
    });
  });
});

describe("GET /api/v2/ready", () => {
  it("uses the web pool and returns the exact release contract only when the database role is ready", async () => {
    const query = vi.fn(async () => ({
      rows: [{ role_ok: true, database_ok: true, permissions_ok: true }],
      rowCount: 1,
    }));
    const response = await request(createApp({
      config: {
        ...config,
        nodeEnv: "production",
        isProduction: true,
        releaseSha: "a".repeat(40),
      },
      v2Pool: { query } as unknown as Pool,
    })).get("/api/v2/ready");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      status: "ready",
      service: "atlas-web",
      apiVersion: "v2",
      contractVersion: "atlas-v2-foundation-v1",
      release: "a".repeat(40),
    });
    expect(query).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringMatching(/current_user.*atlas_web[\s\S]*current_database.*atlas/s),
      query_timeout: 2000,
    }));
    const readinessSql = String(query.mock.calls[0]?.[0]?.text);
    for (const relation of [
      "organizations",
      "users",
      "actors",
      "organization_memberships",
      "audit_events",
      "outbox_events",
      "api_idempotency_keys",
      "schema_migrations",
    ]) {
      expect(readinessSql).toContain(relation);
    }
    for (const requiredUpdateColumn of [
      "name",
      "google_subject",
      "email",
      "display_name",
      "disabled_at",
      "response_body",
      "completed_at",
    ]) {
      expect(readinessSql).toContain(requiredUpdateColumn);
    }
    expect(readinessSql).toContain("has_any_column_privilege");
    expect(readinessSql).toMatch(/audit_events[\s\S]*(?:UPDATE|DELETE|TRUNCATE)/);
    expect(readinessSql).toMatch(/outbox_events[\s\S]*payload[\s\S]*UPDATE/);
  });

  it("fails closed without exposing database details when readiness fails", async () => {
    const response = await request(createApp({
      v2Pool: {
        query: async () => {
          throw new Error("password secret SELECT private_table");
        },
      } as unknown as Pool,
      logger: { error: () => undefined },
    })).get("/api/v2/ready");

    expect(response.status).toBe(503);
    expect(response.body.error).toMatchObject({
      code: "SERVICE_UNAVAILABLE",
      message: "Service is not ready.",
      requestId: response.headers["x-request-id"],
    });
    expect(JSON.stringify(response.body)).not.toMatch(/password|SELECT|private_table/i);
  });
});
