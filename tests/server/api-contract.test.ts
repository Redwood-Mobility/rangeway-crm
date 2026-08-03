import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
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
const openApiContract = readFileSync(
  path.resolve(import.meta.dirname, "../../openapi/atlas-v2.yaml"),
  "utf8",
);

class ContractIdentity {
  async authenticateHumanSession(scopedOrganizationId: string, userId: string) {
    if (scopedOrganizationId !== organizationId || userId !== humanIdentity.userId) {
      throw new ApiError(401, "UNAUTHENTICATED", "Authentication required.");
    }
    return humanIdentity;
  }

  async authenticateGoogle(
    scopedOrganizationId: string,
    subject: string,
    email: string,
  ) {
    if (
      scopedOrganizationId !== organizationId ||
      subject !== "google-subject-001" ||
      email !== "admin@rangeway.energy"
    ) {
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
  afterEach(() => {
    vi.useRealTimers();
  });

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
    expect(setCookie).toContain("Max-Age=43200");
    expect(setCookie).not.toContain("correct-horse-battery-staple");

    const cookie = setCookie.split(";")[0];
    const me = await request(app).get("/api/v2/me").set("Cookie", cookie);
    const meRequestId = expectRequestId(me);
    expect(me.status).toBe(200);
    expect(me.body).toEqual({ actor: { ...humanIdentity, requestId: meRequestId } });

    const legacyMe = await request(app).get("/api/me").set("Cookie", cookie);
    expect(legacyMe.status).toBe(200);
    expect(legacyMe.body).toEqual({
      user: {
        id: expect.any(String),
        email: "admin@rangeway.energy",
        name: "Atlas Admin",
        picture: "",
      },
    });
  });

  it("rejects unknown local-login fields to match the OpenAPI schema", async () => {
    const response = await request(testApp()).post("/api/v2/auth/local/login").send({
      email: "admin@rangeway.energy",
      password: "correct-horse-battery-staple",
      unexpected: "must-not-be-accepted",
    });
    const requestId = expectRequestId(response);

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      error: {
        code: "INVALID_INPUT",
        message: "Invalid input.",
        requestId,
      },
    });
  });

  it("expires a signed session after exactly the configured 12-hour lifetime", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-08-02T12:00:00.000Z"));
    const app = testApp();
    const login = await request(app).post("/api/v2/auth/local/login").send({
      email: "admin@rangeway.energy",
      password: "correct-horse-battery-staple",
    });
    const cookie = login.headers["set-cookie"][0].split(";")[0];

    vi.setSystemTime(new Date("2026-08-03T00:00:00.001Z"));
    const response = await request(app).get("/api/v2/me").set("Cookie", cookie);
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
          authenticateHumanSession: identity.authenticateHumanSession.bind(identity),
          authenticateGoogle: identity.authenticateGoogle.bind(identity),
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

  it("accepts the Bearer scheme case-insensitively with separating whitespace", async () => {
    const response = await request(testApp())
      .get("/api/v2/me")
      .set("Authorization", `bearer\t${serviceKey}`);
    const requestId = expectRequestId(response);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ actor: { ...serviceIdentity, requestId } });
  });

  it("uses the canonical human session for Google callback and V2 actor resolution", async () => {
    const identity = new ContractIdentity();
    const authenticateGoogle = vi.spyOn(identity, "authenticateGoogle");
    const googleOAuth = {
      exchangeCode: vi.fn(async () => "verified-google-id-token"),
      verifyIdToken: vi.fn(async () => ({
        subject: "google-subject-001",
        email: "ADMIN@RANGEWAY.ENERGY",
        name: "Atlas Admin",
        picture: "https://example.test/avatar.png",
      })),
    };
    const app = createApp({
      config: {
        ...config,
        nodeEnv: "test",
        authMode: "google",
        isProduction: false,
        sessionSecret: "contract-test-session-secret-at-least-32-characters",
        googleClientId: "google-client-id",
        googleClientSecret: "google-client-secret",
        googleRedirectUri: "https://atlas.rangeway.app/api/auth/google/callback",
        atlasOrigin: "https://atlas.rangeway.app",
      },
      v2Identity: identity,
      googleOAuth,
      logger: { error: () => undefined },
    });
    const begin = await request(app).get("/api/auth/google");
    const stateCookie = begin.headers["set-cookie"][0].split(";")[0];
    const state = new URL(begin.headers.location).searchParams.get("state");
    const callback = await request(app)
      .get("/api/auth/google/callback")
      .query({ code: "authorization-code", state })
      .set("Cookie", stateCookie);
    const sessionCookieHeader = callback.headers["set-cookie"].find((value: string) =>
      value.startsWith("rw_session="),
    );
    const sessionCookie = sessionCookieHeader.split(";")[0];

    expect(callback.status).toBe(302);
    expect(new URL(begin.headers.location).searchParams.get("redirect_uri")).toBe(
      "https://atlas.rangeway.app/api/auth/google/callback",
    );
    expect(callback.headers.location).toBe("https://atlas.rangeway.app");
    expect(googleOAuth.exchangeCode).toHaveBeenCalledWith("authorization-code");
    expect(googleOAuth.verifyIdToken).toHaveBeenCalledWith("verified-google-id-token");
    expect(authenticateGoogle).toHaveBeenCalledWith(
      organizationId,
      "google-subject-001",
      "admin@rangeway.energy",
      "Atlas Admin",
      callback.headers["x-request-id"],
    );

    const me = await request(app).get("/api/v2/me").set("Cookie", sessionCookie);
    const requestId = expectRequestId(me);
    expect(me.status).toBe(200);
    expect(me.body).toEqual({ actor: { ...humanIdentity, requestId } });
  });

  it("documents the public Google redirect and callback surfaces outside /api/v2", () => {
    expect(openApiContract).toMatch(/^  \/api\/auth\/google:$/m);
    expect(openApiContract).toMatch(/^  \/api\/auth\/google\/callback:$/m);
    expect(openApiContract).toContain("operationId: beginGoogleWorkspaceSignIn");
    expect(openApiContract).toContain("operationId: completeGoogleWorkspaceSignIn");
    expect(openApiContract.match(/url: https:\/\/atlas\.rangeway\.app$/gm)).toHaveLength(2);
    const googleSurface = openApiContract.slice(
      openApiContract.indexOf("  /api/auth/google:"),
      openApiContract.indexOf("  /health:"),
    );
    expect(googleSurface.match(/^      security: \[\]$/gm)).toHaveLength(2);
    expect(googleSurface).toContain('"302":');
    expect(googleSurface).toContain('"400":');
    expect(googleSurface).toContain('"503":');
    expect(googleSurface.match(/X-Request-Id:/g)?.length).toBeGreaterThanOrEqual(5);
    const callbackSurface = googleSurface.slice(
      googleSurface.indexOf("  /api/auth/google/callback:"),
    );
    for (const status of ['"400":', '"401":', '"500":']) {
      const response = callbackSurface.slice(callbackSurface.indexOf(status));
      expect(response.slice(0, response.indexOf("content:") + 8)).toContain("Set-Cookie:");
      expect(response.slice(0, response.indexOf("content:") + 8)).toContain("X-Request-Id:");
    }
  });

  it("does not issue a Google session when V2 actor validation rejects the human", async () => {
    const identity = new ContractIdentity();
    vi.spyOn(identity, "authenticateGoogle").mockRejectedValue(
      new ApiError(401, "UNAUTHENTICATED", "Authentication required."),
    );
    const app = createApp({
      config: {
        ...config,
        nodeEnv: "test",
        authMode: "google",
        isProduction: false,
        sessionSecret: "contract-test-session-secret-at-least-32-characters",
        googleClientId: "google-client-id",
        googleClientSecret: "google-client-secret",
      },
      v2Identity: identity,
      googleOAuth: {
        exchangeCode: async () => "verified-google-id-token",
        verifyIdToken: async () => ({
          subject: "google-subject-001",
          email: "admin@rangeway.energy",
          name: "Disabled Atlas Admin",
          picture: "",
        }),
      },
      logger: { error: () => undefined },
    });
    const response = await request(app)
      .get("/api/auth/google/callback")
      .query({ code: "authorization-code", state: "known-oauth-state" })
      .set("Cookie", "rw_oauth_state=known-oauth-state");

    const requestId = expectRequestId(response);
    expect(response.status).toBe(401);
    expect(response.body).toEqual({
      error: {
        code: "UNAUTHENTICATED",
        message: "Google sign-in could not be completed.",
        requestId,
      },
    });
    expect(response.headers["set-cookie"] ?? []).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/^rw_session=/)]),
    );
    expect(response.headers["set-cookie"]).toEqual(
      expect.arrayContaining([expect.stringMatching(/^rw_oauth_state=;/)]),
    );
  });

  it.each([
    ["provider", new Error("invalid_grant: provider diagnostic secret")],
    [
      "database",
      Object.assign(new Error("SELECT google_subject FROM users WHERE private_sql = true"), {
        code: "42P01",
        detail: "private database detail",
      }),
    ],
  ])("sanitizes %s failures on the public Google callback", async (_kind, failure) => {
    const logged: Array<{ message: string; context: Record<string, unknown> }> = [];
    const identity = new ContractIdentity();
    const app = createApp({
      config: {
        ...config,
        nodeEnv: "test",
        authMode: "google",
        isProduction: false,
        sessionSecret: "contract-test-session-secret-at-least-32-characters",
        googleClientId: "google-client-id",
        googleClientSecret: "google-client-secret",
      },
      v2Identity: identity,
      googleOAuth: {
        exchangeCode: async () => {
          throw failure;
        },
        verifyIdToken: async () => {
          throw new Error("unreachable");
        },
      },
      logger: {
        error(message, context) {
          logged.push({ message, context });
        },
      },
    });

    const response = await request(app)
      .get("/api/auth/google/callback")
      .query({ code: "authorization-code", state: "known-oauth-state" })
      .set("Cookie", "rw_oauth_state=known-oauth-state");
    const requestId = expectRequestId(response);

    expect(response.status).toBe(500);
    expect(response.body).toEqual({
      error: {
        code: "INTERNAL_ERROR",
        message: "Google sign-in could not be completed.",
        requestId,
      },
    });
    expect(response.headers["set-cookie"]).toEqual(
      expect.arrayContaining([expect.stringMatching(/^rw_oauth_state=;/)]),
    );
    expect(JSON.stringify(response.body)).not.toMatch(
      /invalid_grant|provider diagnostic|SELECT|google_subject|42P01|private database/i,
    );
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({
      message: "Atlas Google callback failed.",
      context: {
        requestId,
        path: "/api/auth/google/callback",
        error: failure,
      },
    });
    expect(JSON.stringify(logged)).not.toMatch(/authorization-code|known-oauth-state/);
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

  it("maps malformed JSON to a safe V2 envelope without logging the raw body", async () => {
    const secret = "query-secret-body-canary";
    const logged: Array<{ message: string; context: Record<string, unknown> }> = [];
    const response = await request(createApp({
      config: {
        ...config,
        nodeEnv: "test",
        authMode: "local",
        isProduction: false,
        sessionSecret: "contract-test-session-secret-at-least-32-characters",
      },
      v2Identity: new ContractIdentity(),
      logger: { error: (message, context) => logged.push({ message, context }) },
    }))
      .post(`/api/v2/auth/local/login?token=${secret}`)
      .set("Content-Type", "application/json")
      .send(`{"email":"admin@rangeway.energy","password":"${secret}"`);

    expect(response.status).toBe(400);
    expect(response.body.error).toEqual({
      code: "INVALID_INPUT",
      message: "Malformed JSON body.",
      requestId: response.headers["x-request-id"],
    });
    expect(JSON.stringify(response.body)).not.toContain(secret);
    expect(JSON.stringify(logged)).not.toContain(secret);
  });

  it("maps an oversized JSON body to a safe 413 envelope", async () => {
    const secret = "oversized-body-secret-canary";
    const response = await request(testApp())
      .post("/api/v2/auth/local/login")
      .set("Content-Type", "application/json")
      .send({ email: "admin@rangeway.energy", password: `${secret}${"x".repeat(1024 * 1024)}` });

    expect(response.status).toBe(413);
    expect(response.body.error).toEqual({
      code: "PAYLOAD_TOO_LARGE",
      message: "Request body is too large.",
      requestId: response.headers["x-request-id"],
    });
    expect(JSON.stringify(response.body)).not.toContain(secret);
  });

  it("treats a JSON-looking text body as invalid input without parsing or logging it", async () => {
    const secret = "text-content-secret-canary";
    const logged: Array<{ message: string; context: Record<string, unknown> }> = [];
    const response = await request(createApp({
      config: {
        ...config,
        nodeEnv: "test",
        authMode: "local",
        isProduction: false,
        sessionSecret: "contract-test-session-secret-at-least-32-characters",
      },
      v2Identity: new ContractIdentity(),
      logger: { error: (message, context) => logged.push({ message, context }) },
    }))
      .post("/api/v2/auth/local/login")
      .set("Content-Type", "text/plain")
      .send(`{"password":"${secret}"}`);

    expect(response.status).toBe(400);
    expect(response.body.error).toMatchObject({ code: "INVALID_INPUT" });
    expect(JSON.stringify(logged)).not.toContain(secret);
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

  it("logs only the path and allowlisted actor identifiers, never query secrets", async () => {
    const secret = "query-secret-canary";
    const logged: Array<{ message: string; context: Record<string, unknown> }> = [];
    const response = await request(createApp({
      config: {
        ...config,
        nodeEnv: "test",
        authMode: "local",
        isProduction: false,
        sessionSecret: "contract-test-session-secret-at-least-32-characters",
      },
      v2Identity: new ContractIdentity(),
      logger: { error: (message, context) => logged.push({ message, context }) },
    }))
      .get(`/api/v2/me?token=${secret}`)
      .set("Authorization", `Bearer ${internalFailureKey}`);

    expect(response.status).toBe(500);
    expect(logged[0]?.context).toMatchObject({ method: "GET", path: "/api/v2/me" });
    expect(logged[0]?.context).not.toHaveProperty("actor");
    expect(JSON.stringify(logged)).not.toContain(secret);
  });

  it("clears the signed session without requiring an active credential", async () => {
    const response = await request(testApp()).post("/api/v2/auth/logout");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true });
    expect(response.headers["set-cookie"]?.[0]).toContain("rw_session=");
  });
});
