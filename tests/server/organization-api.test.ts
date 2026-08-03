import { readFileSync } from "node:fs";
import path from "node:path";
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
  it("keeps organization transport outside the identity router", () => {
    const repositoryRoot = path.resolve(import.meta.dirname, "../..");
    const identityRoutes = readFileSync(
      path.join(repositoryRoot, "src/server/modules/identity/identity.routes.ts"),
      "utf8",
    );
    const organizationRoutesPath = path.join(
      repositoryRoot,
      "src/server/modules/organizations/organization.routes.ts",
    );
    const organizationRoutes = (() => {
      try {
        return readFileSync(organizationRoutesPath, "utf8");
      } catch {
        return "";
      }
    })();
    const app = readFileSync(path.join(repositoryRoot, "src/server/app.ts"), "utf8");

    expect(identityRoutes).not.toMatch(/OrganizationMutationPort|organizations\/:organizationId/);
    expect(organizationRoutes).toContain("createOrganizationRouter");
    expect(organizationRoutes).toContain('router.patch("/organizations/:organizationId"');
    expect(app).toContain("createOrganizationRouter(v2Organizations)");
  });

  it("passes the authenticated actor and request attribution to the name mutation", async () => {
    const calls: unknown[][] = [];
    const app = createApp({
      config,
      v2Identity: {
        authenticateHumanSession: async () => serviceIdentity,
        authenticateGoogle: async () => serviceIdentity,
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
      .set("Idempotency-Key", "rename-rangeway-20260802")
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
        "rename-rangeway-20260802",
      ],
    ]);
  });

  it.each([
    ["a missing key", undefined],
    ["a key shorter than eight characters", "short"],
    ["a key longer than 128 characters", "a".repeat(129)],
    ["a key with whitespace", "rename rangeway"],
  ])("rejects %s with the stable invalid-input envelope", async (_label, key) => {
    let called = false;
    let mutation = request(createApp({
      config,
      v2Identity: {
        authenticateHumanSession: async () => serviceIdentity,
        authenticateGoogle: async () => serviceIdentity,
        authenticateLocal: async () => serviceIdentity,
        authenticateServiceKey: async () => serviceIdentity,
      },
      v2Organizations: {
        rename: async () => {
          called = true;
          return { id: organizationId, name: "Must not run" };
        },
      },
      logger: { error: () => undefined },
    }))
      .patch(`/api/v2/organizations/${organizationId}`)
      .set("Authorization", `Bearer ${serviceKey}`)
      .send({ name: "Rangeway Energy" });
    if (key !== undefined) mutation = mutation.set("Idempotency-Key", key);

    const response = await mutation;

    expect(response.status).toBe(400);
    expect(response.body.error).toMatchObject({
      code: "INVALID_INPUT",
      message: "Invalid input.",
    });
    expect(called).toBe(false);
  });
});
