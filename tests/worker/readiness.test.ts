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
    expect(query).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringMatching(/current_user.*atlas_worker[\s\S]*outbox_events/s),
      query_timeout: 2000,
    }));
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
