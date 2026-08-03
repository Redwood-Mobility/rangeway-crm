import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { checkWorkerReadiness } from "../../src/worker/readiness.js";

describe("worker readiness", () => {
  it("proves the exact worker role and outbox delivery permission path", async () => {
    const query = vi.fn(async () => ({
      rows: [{ role_ok: true, database_ok: true, permissions_ok: true }],
      rowCount: 1,
    }));

    await expect(checkWorkerReadiness({ query } as unknown as Pool, true)).resolves.toEqual({
      status: "ready",
      service: "atlas-worker",
      contractVersion: "atlas-v2-foundation-v1",
    });
    expect(query).toHaveBeenCalledWith(expect.objectContaining({ query_timeout: 2000 }));
    const readinessSql = String(query.mock.calls[0]?.[0]?.text);
    expect(readinessSql).toContain("current_user = 'atlas_worker'");
    expect(readinessSql).toContain("outbox_events");
    for (const requiredUpdateColumn of [
      "attempt_count",
      "available_at",
      "processing_started_at",
      "processing_token",
      "published_at",
      "terminal_at",
      "last_error",
      "updated_at",
    ]) {
      expect(readinessSql).toContain(requiredUpdateColumn);
    }
    for (const forbiddenColumn of [
      "organization_id",
      "actor_id",
      "request_id",
      "event_type",
      "aggregate_type",
      "aggregate_id",
      "schema_version",
      "payload",
      "created_at",
    ]) {
      expect(readinessSql).toContain(forbiddenColumn);
    }
    expect(readinessSql).toContain("has_any_column_privilege");
    expect(readinessSql).toContain("audit_events");
    expect(readinessSql).toContain("schema_migrations");
  });

  it("fails closed when the role or permissions do not match", async () => {
    const query = vi.fn(async () => ({
      rows: [{ role_ok: false, database_ok: true, permissions_ok: true }],
      rowCount: 1,
    }));

    await expect(checkWorkerReadiness({ query } as unknown as Pool, true))
      .rejects.toThrow(/worker is not ready/i);
  });
});
