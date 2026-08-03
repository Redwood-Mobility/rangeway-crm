import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const contract = readFileSync(
  path.resolve(import.meta.dirname, "../../openapi/atlas-v2.yaml"),
  "utf8",
);

describe("Operating Core OpenAPI contract", () => {
  it("publishes every required endpoint family", () => {
    for (const pathName of [
      "/projects:",
      "/projects/{projectId}:",
      "/projects/{projectId}/archive:",
      "/projects/{projectId}/members:",
      "/projects/{projectId}/health-updates:",
      "/projects/{projectId}/context-bundle:",
      "/portfolio:",
      "/portfolio/health:",
      "/projects/{projectId}/workstreams:",
      "/workstreams/{workstreamId}:",
      "/work-items:",
      "/work-items/{workItemId}:",
      "/work-items/{workItemId}/move:",
      "/work-items/{workItemId}/dependencies/{dependencyId}:",
      "/work-items/{workItemId}/archive:",
      "/today:",
      "/work-views/{view}:",
      "/projects/{projectId}/decisions:",
      "/projects/{projectId}/risks:",
      "/projects/{projectId}/blockers:",
      "/projects/{projectId}/milestones:",
      "/projects/{projectId}/activity:",
      "/people:",
      "/counterparties:",
      "/projects/{projectId}/people:",
      "/projects/{projectId}/counterparties:",
      "/saved-views:",
      "/search:",
    ]) {
      expect(contract).toContain(`  ${pathName}`);
    }
  });

  it("documents canonical vocabularies, cursor pagination, and mutation idempotency", () => {
    expect(contract).toContain("enum: [action, deliverable, follow_up, approval, research]");
    expect(contract).toContain("enum: [inbox, next, in_progress, waiting, done, canceled]");
    expect(contract).toContain("name: cursor");
    expect(contract).toContain('name: Idempotency-Key');
    expect(contract).toContain("IdempotencyConflict");
    expect(contract).toContain("Private and unknown resources both use NOT_FOUND");
  });
});
