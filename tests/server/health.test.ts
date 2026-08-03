import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../../src/server/app.js";

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
