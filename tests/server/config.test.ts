import { describe, expect, it } from "vitest";
import { parseConfig } from "../../src/server/config.js";

const productionEnv = {
  NODE_ENV: "production",
  PORT: "8081",
  DATABASE_URL: "postgresql://atlas:atlas@db:5432/atlas",
  SESSION_SECRET: "a-secure-session-secret-that-is-at-least-32-characters",
  ATLAS_ORIGIN: "https://atlas.rangeway.app",
  ARTIFACT_DIR: "/var/lib/atlas/artifacts",
  AUTH_MODE: "google",
  GOOGLE_CLIENT_ID: "atlas-client-id",
  GOOGLE_CLIENT_SECRET: "atlas-client-secret",
  GOOGLE_REDIRECT_URI: "https://atlas.rangeway.app/api/auth/google/callback",
  WORKER_POLL_MS: "2500"
};

describe("parseConfig", () => {
  it("uses development defaults", () => {
    const config = parseConfig({ NODE_ENV: "development" });

    expect(config.port).toBe(8080);
    expect(config.authMode).toBe("local");
    expect(config.artifactDir).toBe("./artifacts");
  });

  it("rejects local authentication in production", () => {
    expect(() => parseConfig({ ...productionEnv, AUTH_MODE: "local" })).toThrow();
  });

  it.each(["DATABASE_URL", "SESSION_SECRET", "ATLAS_ORIGIN", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REDIRECT_URI"])(
    "rejects a production configuration missing %s",
    (name) => {
      const env = { ...productionEnv };
      delete env[name as keyof typeof env];

      expect(() => parseConfig(env)).toThrow();
    }
  );

  it("requires session secrets to be at least 32 characters", () => {
    expect(() => parseConfig({ NODE_ENV: "development", SESSION_SECRET: "too-short" })).toThrow();
  });

  it("requires an HTTPS Atlas origin in production", () => {
    expect(() => parseConfig({ ...productionEnv, ATLAS_ORIGIN: "http://atlas.rangeway.app" })).toThrow();
  });
});
