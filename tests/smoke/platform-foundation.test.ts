import { randomUUID } from "node:crypto";
import argon2 from "argon2";
import type { Pool } from "pg";
import request from "supertest";
import { describe, expect, it, type TestContext } from "vitest";
import { createApp } from "../../src/server/app.js";
import { parseConfig } from "../../src/server/config.js";
import { IdentityService } from "../../src/server/modules/identity/identity.service.js";
import { createPool } from "../../src/server/platform/db/client.js";
import { runMigrations } from "../../src/server/platform/db/migrate.js";
import { OutboxWorker } from "../../src/worker/outbox-worker.js";
import {
  createTemporaryDatabase,
  PostgreSqlUnavailableError,
} from "../helpers/database.js";

const rangewayOrganizationId = "00000000-0000-4000-8000-000000000001";

function expectSafeError(
  response: request.Response,
  status: number,
  code: "UNAUTHENTICATED" | "NOT_FOUND",
  message: string,
): void {
  expect(response.status).toBe(status);
  expect(response.headers["x-request-id"]).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  );
  expect(response.body).toEqual({
    error: {
      code,
      message,
      requestId: response.headers["x-request-id"],
    },
  });
}

async function withTemporaryPostgreSql(
  context: TestContext,
  operation: (pool: Pool, databaseUrl: string) => Promise<void>,
): Promise<void> {
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
    await operation(pool, temporaryDatabase.databaseUrl);
  } finally {
    await pool.end();
    await temporaryDatabase.cleanup();
  }
}

describe("Atlas V2 platform foundation smoke", () => {
  it("authenticates human and agent mutations through the real API and publishes their events", async (context) => {
    await withTemporaryPostgreSql(context, async (pool, databaseUrl) => {
      await runMigrations(pool);

      const ownerEmail = "owner@rangeway.energy";
      const ownerPassword = "foundation-owner-password";
      const identity = new IdentityService(pool);
      const owner = await identity.createHumanUser({
        organizationId: rangewayOrganizationId,
        email: ownerEmail,
        displayName: "Rangeway Owner",
        localPasswordHash: await argon2.hash(ownerPassword, {
          type: argon2.argon2id,
        }),
        role: "owner",
      });
      const agent = await identity.createServiceActor({
        organizationId: rangewayOrganizationId,
        actorType: "agent",
        displayName: "Foundation Agent",
        role: "admin",
      });

      const otherOrganizationId = randomUUID();
      await pool.query(
        "INSERT INTO organizations (id, slug, name) VALUES ($1, $2, $3)",
        [otherOrganizationId, `other-${randomUUID()}`, "Other organization"],
      );
      const otherAgent = await identity.createServiceActor({
        organizationId: otherOrganizationId,
        actorType: "agent",
        displayName: "Other Organization Agent",
        role: "admin",
      });

      const app = createApp({
        config: parseConfig({
          NODE_ENV: "test",
          AUTH_MODE: "local",
          DATABASE_URL: databaseUrl,
          SESSION_SECRET: "foundation-smoke-session-secret-at-least-32-characters",
          ATLAS_ORIGIN: "http://localhost:5173",
        }),
        v2Identity: identity,
        v2Pool: pool,
        logger: { error: () => undefined },
      });

      const humanClient = request.agent(app);
      const login = await humanClient
        .post("/api/v2/auth/local/login")
        .send({ email: ownerEmail, password: ownerPassword });
      expect(login.status).toBe(200);
      expect(login.body.actor).toMatchObject({
        actorId: owner.actorId,
        actorType: "human",
        organizationId: rangewayOrganizationId,
        role: "owner",
      });

      const humanMe = await humanClient.get("/api/v2/me");
      expect(humanMe.status).toBe(200);
      expect(humanMe.body.actor).toMatchObject({
        actorId: owner.actorId,
        actorType: "human",
        organizationId: rangewayOrganizationId,
      });

      const agentMe = await request(app)
        .get("/api/v2/me")
        .set("Authorization", `Bearer ${agent.serviceKey}`);
      expect(agentMe.status).toBe(200);
      expect(agentMe.body.actor).toMatchObject({
        actorId: agent.actorId,
        actorType: "agent",
        organizationId: rangewayOrganizationId,
      });

      const humanMutation = await humanClient
        .patch(`/api/v2/organizations/${rangewayOrganizationId}`)
        .set("Idempotency-Key", "smoke-human-organization-rename")
        .send({ name: "Rangeway Energy" });
      expect(humanMutation.status).toBe(200);
      expect(humanMutation.body).toEqual({
        organization: { id: rangewayOrganizationId, name: "Rangeway Energy" },
      });

      const agentMutation = await request(app)
        .patch(`/api/v2/organizations/${rangewayOrganizationId}`)
        .set("Authorization", `Bearer ${agent.serviceKey}`)
        .set("Idempotency-Key", "smoke-agent-organization-rename")
        .send({ name: "Rangeway" });
      expect(agentMutation.status).toBe(200);
      expect(agentMutation.body).toEqual({
        organization: { id: rangewayOrganizationId, name: "Rangeway" },
      });

      const unauthenticated = await request(app)
        .patch(`/api/v2/organizations/${rangewayOrganizationId}`)
        .send({ name: "Hidden mutation" });
      expectSafeError(
        unauthenticated,
        401,
        "UNAUTHENTICATED",
        "Authentication required.",
      );

      const wrongOrganization = await request(app)
        .patch(`/api/v2/organizations/${rangewayOrganizationId}`)
        .set("Authorization", `Bearer ${otherAgent.serviceKey}`)
        .set("Idempotency-Key", "smoke-cross-organization-rename")
        .send({ name: "Cross-organization mutation" });
      expectSafeError(
        wrongOrganization,
        404,
        "NOT_FOUND",
        "Resource not found.",
      );

      const audit = await pool.query<{
        actor_id: string;
        request_id: string;
        before: { name: string };
        after: { name: string };
      }>(
        `SELECT actor_id, request_id, before, after
           FROM audit_events
          WHERE organization_id = $1
          ORDER BY created_at, id`,
        [rangewayOrganizationId],
      );
      const outbox = await pool.query<{
        id: string;
        actor_id: string;
        request_id: string;
        event_type: string;
        published_at: Date | null;
      }>(
        `SELECT id, actor_id, request_id, event_type, published_at
           FROM outbox_events
          WHERE organization_id = $1
          ORDER BY created_at, id`,
        [rangewayOrganizationId],
      );

      expect(audit.rows).toEqual([
        {
          actor_id: owner.actorId,
          request_id: humanMutation.headers["x-request-id"],
          before: { name: "Rangeway" },
          after: { name: "Rangeway Energy" },
        },
        {
          actor_id: agent.actorId,
          request_id: agentMutation.headers["x-request-id"],
          before: { name: "Rangeway Energy" },
          after: { name: "Rangeway" },
        },
      ]);
      expect(outbox.rows).toHaveLength(2);
      expect(outbox.rows.map(({ actor_id, request_id, event_type, published_at }) => ({
        actor_id,
        request_id,
        event_type,
        published_at,
      }))).toEqual([
        {
          actor_id: owner.actorId,
          request_id: humanMutation.headers["x-request-id"],
          event_type: "organization.updated.v1",
          published_at: null,
        },
        {
          actor_id: agent.actorId,
          request_id: agentMutation.headers["x-request-id"],
          event_type: "organization.updated.v1",
          published_at: null,
        },
      ]);

      const handled: string[] = [];
      const worker = new OutboxWorker({
        pool,
        handlers: {
          "organization.updated.v1": async (event, handlerContext) => {
            handled.push(`${event.id}:${handlerContext.idempotencyKey}`);
          },
        },
      });
      await expect(worker.runOnce()).resolves.toBe(2);
      expect(handled.sort()).toEqual(
        outbox.rows.map((event) => `${event.id}:${event.id}`).sort(),
      );

      const published = await pool.query<{
        id: string;
        published_at: Date | null;
        last_error: string | null;
      }>(
        `SELECT id, published_at, last_error
           FROM outbox_events
          WHERE organization_id = $1
          ORDER BY created_at, id`,
        [rangewayOrganizationId],
      );
      expect(published.rows).toEqual(
        outbox.rows.map((event) => ({
          id: event.id,
          published_at: expect.any(Date),
          last_error: null,
        })),
      );
    });
  });
});
