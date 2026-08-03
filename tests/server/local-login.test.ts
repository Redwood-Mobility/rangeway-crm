import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../../src/server/app.js";
import { config } from "../../src/server/config.js";

describe("POST /api/login", () => {
  it.each([
    ["Google authentication is configured", { ...config, authMode: "google" as const }],
    ["the process is production", { ...config, isProduction: true }]
  ])("does not expose local sign-in when %s", async (_scenario, runtimeConfig) => {
    const response = await request(createApp({ config: runtimeConfig }))
      .post("/api/login")
      .send({});

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: "Not found" });
  });
});
