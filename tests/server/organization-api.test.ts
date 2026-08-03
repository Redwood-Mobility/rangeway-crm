import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../../src/server/app.js";
import { parseConfig } from "../../src/server/config.js";
import type { ActorIdentity } from "../../src/server/modules/identity/identity.service.js";

const organizationId = "00000000-0000-4000-8000-000000000001";
const serviceKey = "atlas_abcdefghijkl.foundation-api-key";
const serviceIdentity: ActorIdentity = {
  actorId: "00000000-0000-4000-8000-000000000101",
  actorType: "agent",
  actorName: "Foundation Agent",
  organizationId,
  role: "admin",
};

const config = parseConfig({
  NODE_ENV: "test",
  AUTH_MODE: "local",
  SESSION_SECRET: "organization-api-test-secret-at-least-32-characters",
  ATLAS_ORIGIN: "http://localhost:5173",
});

describe("organization API", () => {
  it("passes the authenticated actor and request attribution to the name mutation", async () => {
    const calls: unknown[][] = [];
    const app = createApp({
      config,
      v2Identity: {
        authenticateHuman: async () => serviceIdentity,
        authenticateLocal: async () => serviceIdentity,
        authenticateServiceKey: async () => serviceIdentity,
      },
      v2Organizations: {
        rename: async (...args: unknown[]) => {
          calls.push(args);
          return { id: organizationId, name: "Rangeway Energy" };
        },
      },
      logger: { error: () => undefined },
    });

    const response = await request(app)
      .patch(`/api/v2/organizations/${organizationId}`)
      .set("Authorization", `Bearer ${serviceKey}`)
      .set("X-Request-Id", "00000000-0000-4000-8000-000000000501")
      .send({ name: "Rangeway Energy" });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      organization: { id: organizationId, name: "Rangeway Energy" },
    });
    expect(calls).toEqual([
      [
        { ...serviceIdentity, requestId: "00000000-0000-4000-8000-000000000501" },
        organizationId,
        "Rangeway Energy",
      ],
    ]);
  });
});
