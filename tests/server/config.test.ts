import { ZodError } from "zod";
import { describe, expect, it } from "vitest";
import { parseConfig } from "../../src/server/config.js";

const productionEnv = {
  NODE_ENV: "production",
  PORT: "8081",
  DATABASE_URL: "postgresql://atlas_web:web-password@db:5432/atlas",
  SESSION_SECRET: "a-secure-session-secret-that-is-at-least-32-characters",
  ATLAS_ORIGIN: "https://atlas.rangeway.app",
  ARTIFACT_DIR: "/var/lib/atlas/artifacts",
  AUTH_MODE: "google",
  GOOGLE_CLIENT_ID: "atlas-client-id",
  GOOGLE_CLIENT_SECRET: "atlas-client-secret",
  GOOGLE_REDIRECT_URI: "https://atlas.rangeway.app/api/auth/google/callback",
  WORKER_POLL_MS: "2500"
};

function expectConfigIssue(env: NodeJS.ProcessEnv, path: string[], message: string) {
  try {
    parseConfig(env);
    throw new Error("Expected configuration parsing to fail.");
  } catch (error) {
    expect(error).toBeInstanceOf(ZodError);
    expect((error as ZodError).issues).toContainEqual(expect.objectContaining({ path, message }));
  }
}

describe("parseConfig", () => {
  it("uses development defaults", () => {
    const config = parseConfig({ NODE_ENV: "development" });

    expect(config.port).toBe(8080);
    expect(config.authMode).toBe("local");
    expect(config.artifactDir).toBe("./artifacts");
  });

  it("rejects local authentication in production", () => {
    expectConfigIssue({ ...productionEnv, AUTH_MODE: "local" }, ["authMode"], "AUTH_MODE must be google in production.");
  });

  it.each(["atlas", "atlas_migrator", "atlas_worker", "postgres"])(
    "rejects the privileged %s database role for the production web process",
    (username) => {
      expectConfigIssue(
        { ...productionEnv, DATABASE_URL: `postgresql://${username}:secret@db:5432/atlas` },
        ["databaseUrl"],
        "DATABASE_URL must use the least-privilege atlas_web role in production.",
      );
    },
  );

  it.each(["DATABASE_URL", "SESSION_SECRET", "ATLAS_ORIGIN", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REDIRECT_URI"])(
    "rejects a production configuration missing %s",
    (name) => {
      const env = { ...productionEnv };
      delete env[name as keyof typeof env];

      expect(() => parseConfig(env)).toThrow();
    }
  );

  it("requires session secrets to be at least 32 characters", () => {
    expectConfigIssue(
      { NODE_ENV: "development", SESSION_SECRET: "too-short" },
      ["sessionSecret"],
      "Too small: expected string to have >=32 characters"
    );
  });

  it("requires an HTTPS Atlas origin in production", () => {
    expectConfigIssue(
      { ...productionEnv, ATLAS_ORIGIN: "http://atlas.rangeway.app" },
      ["atlasOrigin"],
      "ATLAS_ORIGIN must use HTTPS in production."
    );
  });

  it("requires the production Google callback to use HTTPS on the Atlas browser origin", () => {
    expectConfigIssue(
      { ...productionEnv, GOOGLE_REDIRECT_URI: "http://atlas.rangeway.app/api/auth/google/callback" },
      ["googleRedirectUri"],
      "GOOGLE_REDIRECT_URI must use HTTPS in production.",
    );
    expectConfigIssue(
      { ...productionEnv, GOOGLE_REDIRECT_URI: "https://oauth-proxy.example/api/auth/google/callback" },
      ["googleRedirectUri"],
      "GOOGLE_REDIRECT_URI must use the same origin as ATLAS_ORIGIN.",
    );
    expectConfigIssue(
      { ...productionEnv, GOOGLE_REDIRECT_URI: "https://atlas.rangeway.app/oauth/callback" },
      ["googleRedirectUri"],
      "GOOGLE_REDIRECT_URI must use the Atlas Google callback path.",
    );
    expectConfigIssue(
      { ...productionEnv, GOOGLE_REDIRECT_URI: "not-a-url" },
      ["googleRedirectUri"],
      "GOOGLE_REDIRECT_URI must be a valid URL.",
    );
  });

  it("requires ATLAS_ORIGIN to be an origin without path, query, or fragment", () => {
    expectConfigIssue(
      { ...productionEnv, ATLAS_ORIGIN: "https://atlas.rangeway.app/app" },
      ["atlasOrigin"],
      "ATLAS_ORIGIN must contain only the browser origin.",
    );
  });
});
