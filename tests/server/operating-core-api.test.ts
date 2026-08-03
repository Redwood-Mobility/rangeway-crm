import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../../src/server/app.js";
import { parseConfig } from "../../src/server/config.js";
import type { ActorIdentity } from "../../src/server/modules/identity/identity.service.js";

const organizationId = "00000000-0000-4000-8000-000000000001";
const userId = "00000000-0000-4000-8000-000000000101";
const projectId = "00000000-0000-4000-8000-000000000201";
const workItemId = "00000000-0000-4000-8000-000000000301";
const serviceKey = "atlas_abcdefghijkl.operating-core-api-key";
const identity: ActorIdentity = {
  actorId: "00000000-0000-4000-8000-000000000401",
  actorType: "human",
  actorName: "Atlas Operator",
  organizationId,
  role: "member",
  userId,
};
const config = parseConfig({
  NODE_ENV: "test",
  AUTH_MODE: "local",
  SESSION_SECRET: "operating-core-api-secret-at-least-32-characters",
  ATLAS_ORIGIN: "http://localhost:5173",
});

function testApp(calls: unknown[][]) {
  return createApp({
    config,
    v2Identity: {
      authenticateHumanSession: async () => identity,
      authenticateGoogle: async () => identity,
      authenticateLocal: async () => identity,
      authenticateServiceKey: async () => identity,
    },
    v2OperatingCore: {
      query: async (...args: unknown[]) => {
        calls.push(["query", ...args]);
        return { items: [{ id: workItemId }], page: { nextCursor: null } };
      },
      mutate: async (...args: unknown[]) => {
        calls.push(["mutate", ...args]);
        return { project: { id: projectId, name: "Mojave" } };
      },
    },
    logger: { error: () => undefined },
  });
}

function auth(requestBuilder: request.Test): request.Test {
  return requestBuilder.set("Authorization", `Bearer ${serviceKey}`);
}

describe("Operating Core API", () => {
  it("creates a Project Room through the authenticated idempotent domain port", async () => {
    const calls: unknown[][] = [];
    const response = await auth(request(testApp(calls)).post("/api/v2/projects"))
      .set("X-Request-Id", "00000000-0000-4000-8000-000000000501")
      .set("Idempotency-Key", "create-mojave-20260803")
      .send({
        name: "Mojave",
        objective: "Qualify a hospitality-led charging location.",
        ownerUserId: userId,
        templateType: "location_pursuit",
        status: "active",
        health: "unknown",
        priority: "high",
        strategicArea: "Site Development",
        currentFocus: "Validate control path",
        blockerSummary: "",
        nextDecision: "Select diligence path",
        nextAction: "Confirm site contacts",
      });

    expect(response.status).toBe(201);
    expect(response.body.project).toEqual({ id: projectId, name: "Mojave" });
    expect(calls).toEqual([
      [
        "mutate",
        { ...identity, requestId: "00000000-0000-4000-8000-000000000501" },
        "project.create",
        {
          name: "Mojave",
          objective: "Qualify a hospitality-led charging location.",
          ownerUserId: userId,
          templateType: "location_pursuit",
          status: "active",
          health: "unknown",
          priority: "high",
          strategicArea: "Site Development",
          currentFocus: "Validate control path",
          blockerSummary: "",
          nextDecision: "Select diligence path",
          nextAction: "Confirm site contacts",
        },
        "create-mojave-20260803",
      ],
    ]);
  });

  it("dispatches canonical board/list/calendar reads through one work projection operation", async () => {
    for (const view of ["board", "list", "calendar"]) {
      const calls: unknown[][] = [];
      const response = await auth(
        request(testApp(calls)).get(
          `/api/v2/work-views/${view}?projectId=${projectId}&status=in_progress&limit=25`,
        ),
      );
      expect(response.status).toBe(200);
      expect(calls[0]).toEqual([
        "query",
        expect.objectContaining({ organizationId, userId }),
        "work.view",
        {
          view,
          projectId,
          status: "in_progress",
          limit: 25,
        },
      ]);
    }
  });

  it("routes the complete Operating Core endpoint families before the safe catch-all", async () => {
    const queryPaths = [
      "/api/v2/projects",
      `/api/v2/projects/${projectId}`,
      `/api/v2/projects/${projectId}/members`,
      `/api/v2/projects/${projectId}/health-updates`,
      `/api/v2/projects/${projectId}/context-bundle`,
      "/api/v2/portfolio",
      "/api/v2/portfolio/health",
      `/api/v2/projects/${projectId}/workstreams`,
      "/api/v2/work-items",
      `/api/v2/work-items/${workItemId}`,
      "/api/v2/today",
      `/api/v2/projects/${projectId}/decisions`,
      `/api/v2/projects/${projectId}/risks`,
      `/api/v2/projects/${projectId}/blockers`,
      `/api/v2/projects/${projectId}/milestones`,
      `/api/v2/projects/${projectId}/activity`,
      "/api/v2/people",
      "/api/v2/counterparties",
      `/api/v2/projects/${projectId}/people`,
      `/api/v2/projects/${projectId}/counterparties`,
      "/api/v2/saved-views",
      "/api/v2/search?q=Mojave",
    ];

    for (const path of queryPaths) {
      const response = await auth(request(testApp([])).get(path));
      expect(response.status, path).toBe(200);
    }
  });

  it("rejects malformed pagination and invalid blocker targets before the service runs", async () => {
    const calls: unknown[][] = [];
    const app = testApp(calls);
    const malformedCursor = await auth(
      request(app).get("/api/v2/projects?cursor=not-a-cursor"),
    );
    const invalidBlocker = await auth(
      request(app).post(`/api/v2/projects/${projectId}/blockers`),
    )
      .set("Idempotency-Key", "bad-blocker-20260803")
      .send({ condition: "Cannot progress", targetType: "email", targetId: workItemId });

    for (const response of [malformedCursor, invalidBlocker]) {
      expect(response.status).toBe(400);
      expect(response.body.error).toMatchObject({
        code: "INVALID_INPUT",
        message: "Invalid input.",
      });
    }
    expect(calls).toEqual([]);
  });

  it("requires a valid idempotency key for every material mutation", async () => {
    const calls: unknown[][] = [];
    const response = await auth(
      request(testApp(calls)).post(`/api/v2/work-items/${workItemId}/move`),
    ).send({ status: "in_progress", position: 100 });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("INVALID_INPUT");
    expect(calls).toEqual([]);
  });
});
