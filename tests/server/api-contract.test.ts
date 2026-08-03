import { randomUUID } from "node:crypto";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../../src/server/app.js";
import { config } from "../../src/server/config.js";
import { ApiError } from "../../src/server/platform/http/api-error.js";

const organizationId = "00000000-0000-4000-8000-000000000001";
const humanIdentity = {
  actorId: "10000000-0000-4000-8000-000000000001",
  actorType: "human" as const,
  actorName: "Atlas Admin",
  organizationId,
  role: "owner" as const,
  userId: "20000000-0000-4000-8000-000000000001",
};
const serviceIdentity = {
  actorId: "30000000-0000-4000-8000-000000000001",
  actorType: "agent" as const,
  actorName: "Contract test agent",
  organizationId,
  role: "viewer" as const,
};
const serviceKey = "atlas_abcdefghijkl.ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopq";
const disabledServiceKey = "atlas_disabledkey1.ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopq";
const internalFailureKey = "atlas_internalerr1.ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopq";

class ContractIdentity {
  async authenticateHuman(scopedOrganizationId: string, email: string) {
    if (scopedOrganizationId !== organizationId || email !== "admin@rangeway.energy") {
      throw new ApiError(401, "UNAUTHENTICATED", "Authentication required.");
    }
    return humanIdentity;
  }

  async authenticateServiceKey(presentedKey?: string) {
    if (presentedKey === disabledServiceKey) {
      throw new ApiError(401, "UNAUTHENTICATED", "Authentication required.");
    }
    if (presentedKey === internalFailureKey) {
      throw Object.assign(new Error("SELECT local_password_hash FROM users"), {
        code: "42P01",
      });
    }
    if (presentedKey !== serviceKey) {
      throw new ApiError(401, "UNAUTHENTICATED", "Authentication required.");
    }
    return serviceIdentity;
  }

  async authenticateLocal(
    scopedOrganizationId: string,
    email: string,
    password: string,
  ) {
    if (
      scopedOrganizationId !== organizationId ||
      email !== "admin@rangeway.energy" ||
      password !== "correct-horse-battery-staple"
    ) {
      throw new ApiError(401, "UNAUTHENTICATED", "Authentication required.");
    }
    return humanIdentity;
  }
}

function testApp(overrides: Partial<typeof config> = {}) {
  return createApp({
    config: {
      ...config,
      nodeEnv: "test",
      authMode: "local",
      isProduction: false,
      sessionSecret: "contract-test-session-secret-at-least-32-characters",
      ...overrides,
    },
    v2Identity: new ContractIdentity(),
    logger: { error: () => undefined },
  });
}

function expectRequestId(response: request.Response): string {
  const requestId = response.headers["x-request-id"];
  expect(requestId).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  );
  return requestId;
}

describe("Atlas V2 API contract", () => {
  it("adds a request UUID to every response and retains only a valid supplied UUID", async () => {
    const generated = await request(testApp()).get("/api/v2/health");
    const suppliedRequestId = randomUUID();
    const retained = await request(testApp())
      .get("/api/v2/health")
      .set("X-Request-Id", suppliedRequestId);
    const replaced = await request(testApp())
      .get("/api/v2/health")
      .set("X-Request-Id", "not-a-uuid");

    expectRequestId(generated);
    expect(retained.headers["x-request-id"]).toBe(suppliedRequestId);
    expect(replaced.headers["x-request-id"]).not.toBe("not-a-uuid");
    expectRequestId(replaced);
  });

  it("returns the stable unauthenticated envelope when GET /me has no credentials", async () => {
    const response = await request(testApp()).get("/api/v2/me");
    const requestId = expectRequestId(response);

    expect(response.status).toBe(401);
    expect(response.body).toEqual({
      error: {
        code: "UNAUTHENTICATED",
        message: "Authentication required.",
        requestId,
      },
    });
  });

  it.each([
    ["a malformed bearer credential", { authorization: "Bearer malformed" }],
    ["an invalid signed session", { cookie: "rw_session=invalid.signature" }],
    [
      "a disabled service credential",
      { authorization: `Bearer ${disabledServiceKey}` },
    ],
  ])("uses the same safe 401 for %s", async (_scenario, headers) => {
    const response = await request(testApp()).get("/api/v2/me").set(headers);
    const requestId = expectRequestId(response);

    expect(response.status).toBe(401);
    expect(response.body).toEqual({
      error: {
        code: "UNAUTHENTICATED",
        message: "Authentication required.",
        requestId,
      },
    });
  });

  it("rejects simultaneous cookie and bearer credentials", async () => {
    const login = await request(testApp()).post("/api/v2/auth/local/login").send({
      email: "admin@rangeway.energy",
      password: "correct-horse-battery-staple",
    });
    const cookie = login.headers["set-cookie"][0].split(";")[0];
    const response = await request(testApp())
      .get("/api/v2/me")
      .set("Cookie", cookie)
      .set("Authorization", `Bearer ${serviceKey}`);

    expect(response.status).toBe(401);
    expect(response.body.error).toMatchObject({
      code: "UNAUTHENTICATED",
      message: "Authentication required.",
    });
  });

  it("returns the same safe 404 for an unknown resource and a known hidden route", async () => {
    const runtimeConfig = { authMode: "google" as const };
    const authenticated = (path: string) =>
      request(testApp(runtimeConfig))
        .post(path)
        .set("Authorization", `Bearer ${serviceKey}`);
    const unknown = await authenticated("/api/v2/not-a-resource");
    const hidden = await authenticated("/api/v2/auth/local/login").send({
      email: "admin@rangeway.energy",
      password: "correct-horse-battery-staple",
    });

    for (const response of [unknown, hidden]) {
      expect(response.status).toBe(404);
      expect(response.body.error).toMatchObject({
        code: "NOT_FOUND",
        message: "Resource not found.",
      });
      expect(response.body.error.requestId).toBe(response.headers["x-request-id"]);
    }
  });

  it("establishes a Secure, HTTP-only signed session and returns actor context", async () => {
    const app = testApp();
    const login = await request(app).post("/api/v2/auth/local/login").send({
      email: "admin@rangeway.energy",
      password: "correct-horse-battery-staple",
    });
    const requestId = expectRequestId(login);
    const setCookie = login.headers["set-cookie"]?.[0];

    expect(login.status).toBe(200);
    expect(login.body).toEqual({ actor: { ...humanIdentity, requestId } });
    expect(setCookie).toContain("rw_session=");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("SameSite=Lax");
    expect(setCookie).not.toContain("correct-horse-battery-staple");

    const cookie = setCookie.split(";")[0];
    const me = await request(app).get("/api/v2/me").set("Cookie", cookie);
    const meRequestId = expectRequestId(me);
    expect(me.status).toBe(200);
    expect(me.body).toEqual({ actor: { ...humanIdentity, requestId: meRequestId } });
  });

  it("never creates a human session for a non-human local identity", async () => {
    const identity = new ContractIdentity();
    const response = await request(
      createApp({
        config: {
          ...config,
          nodeEnv: "test",
          authMode: "local",
          isProduction: false,
          sessionSecret: "contract-test-session-secret-at-least-32-characters",
        },
        v2Identity: {
          authenticateHuman: identity.authenticateHuman.bind(identity),
          authenticateServiceKey: identity.authenticateServiceKey.bind(identity),
          authenticateLocal: async () => serviceIdentity,
        },
        logger: { error: () => undefined },
      }),
    )
      .post("/api/v2/auth/local/login")
      .send({
        email: "admin@rangeway.energy",
        password: "correct-horse-battery-staple",
      });

    expect(response.status).toBe(401);
    expect(response.body.error).toMatchObject({
      code: "UNAUTHENTICATED",
      message: "Authentication required.",
    });
    expect(response.headers["set-cookie"]).toBeUndefined();
  });

  it("authenticates a service actor with the Atlas bearer format", async () => {
    const response = await request(testApp())
      .get("/api/v2/me")
      .set("Authorization", `Bearer ${serviceKey}`);
    const requestId = expectRequestId(response);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ actor: { ...serviceIdentity, requestId } });
  });

  it("does not expose local login outside local non-production mode", async () => {
    for (const runtimeConfig of [
      { authMode: "google" as const },
      { authMode: "local" as const, isProduction: true },
    ]) {
      const response = await request(testApp(runtimeConfig))
        .post("/api/v2/auth/local/login")
        .send({ email: "admin@rangeway.energy", password: "anything" });

      expect(response.status).toBe(404);
      expect(response.body.error).toMatchObject({
        code: "NOT_FOUND",
        message: "Resource not found.",
      });
    }
  });

  it("validates login input with the stable invalid-input envelope", async () => {
    const response = await request(testApp())
      .post("/api/v2/auth/local/login")
      .send({ email: "not-an-email", password: "" });
    const requestId = expectRequestId(response);

    expect(response.status).toBe(400);
    expect(response.body.error).toMatchObject({
      code: "INVALID_INPUT",
      message: "Invalid input.",
      requestId,
    });
    expect(response.body.error.details).toBeDefined();
  });

  it("logs internal failures with request context without exposing stack or SQL details", async () => {
    const logged: Array<{ message: string; context: Record<string, unknown> }> = [];
    const app = createApp({
      config: {
        ...config,
        nodeEnv: "test",
        authMode: "local",
        isProduction: false,
        sessionSecret: "contract-test-session-secret-at-least-32-characters",
      },
      v2Identity: new ContractIdentity(),
      logger: {
        error(message, context) {
          logged.push({ message, context });
        },
      },
    });
    const response = await request(app)
      .get("/api/v2/me")
      .set("Authorization", `Bearer ${internalFailureKey}`);
    const requestId = expectRequestId(response);

    expect(response.status).toBe(500);
    expect(response.body).toEqual({
      error: {
        code: "INTERNAL_ERROR",
        message: "Unexpected server error.",
        requestId,
      },
    });
    expect(JSON.stringify(response.body)).not.toMatch(/SELECT|local_password_hash|42P01|stack/i);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({
      message: "Atlas API request failed.",
      context: {
        requestId,
        method: "GET",
        path: "/api/v2/me",
      },
    });
    expect(logged[0].context.error).toBeInstanceOf(Error);
  });

  it("clears the signed session without requiring an active credential", async () => {
    const response = await request(testApp()).post("/api/v2/auth/logout");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true });
    expect(response.headers["set-cookie"]?.[0]).toContain("rw_session=");
  });
});
