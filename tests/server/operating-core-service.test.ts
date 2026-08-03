import type { Pool, QueryResultRow } from "pg";
import { describe, expect, it } from "vitest";
import type { ActorContext } from "../../src/shared/identity.js";
import { OperatingCoreService } from "../../src/server/modules/operating-core/operating-core.service.js";

const actor: ActorContext = {
  actorId: "00000000-0000-4000-8000-000000000401",
  actorType: "human",
  actorName: "Atlas Operator",
  organizationId: "00000000-0000-4000-8000-000000000001",
  role: "member",
  userId: "00000000-0000-4000-8000-000000000101",
  requestId: "00000000-0000-4000-8000-000000000501",
};

class RecordingPool {
  readonly calls: Array<{ sql: string; values: unknown[] }> = [];
  constructor(private readonly rows: QueryResultRow[]) {}
  async query(sql: string, values: unknown[] = []) {
    this.calls.push({ sql: sql.replace(/\s+/g, " ").trim(), values });
    return { rows: this.rows, rowCount: this.rows.length };
  }
}

describe("OperatingCoreService reads", () => {
  it("lists only organization-scoped Project Rooms visible to the actor with a stable cursor", async () => {
    const pool = new RecordingPool([
      {
        id: "00000000-0000-4000-8000-000000000201",
        organization_id: actor.organizationId,
        name: "Mojave",
        status: "active",
        health: "at_risk",
        created_at: new Date("2026-08-03T12:00:00.000Z"),
      },
      {
        id: "00000000-0000-4000-8000-000000000202",
        organization_id: actor.organizationId,
        name: "Hawaiʻi",
        status: "active",
        health: "on_track",
        created_at: new Date("2026-08-03T11:00:00.000Z"),
      },
    ]);
    const result = await new OperatingCoreService(pool as unknown as Pool).query(
      actor,
      "project.list",
      { limit: 1, status: "active" },
    );

    expect(result).toMatchObject({
      projects: [
        expect.objectContaining({
          id: "00000000-0000-4000-8000-000000000201",
          organizationId: actor.organizationId,
          name: "Mojave",
        }),
      ],
      page: { nextCursor: expect.any(String) },
    });
    expect(pool.calls[0].sql).toContain("p.organization_id = $1");
    expect(pool.calls[0].sql).toContain("project_memberships");
    expect(pool.calls[0].values).toContain(actor.organizationId);
    expect(pool.calls[0].values).toContain(actor.userId);
  });

  it("returns the same canonical work rows through list, board, and calendar projections", async () => {
    const rows = [
      {
        id: "00000000-0000-4000-8000-000000000301",
        organization_id: actor.organizationId,
        project_id: "00000000-0000-4000-8000-000000000201",
        title: "Confirm site control",
        status: "in_progress",
        due_at: new Date("2026-08-04T17:00:00.000Z"),
        position: "100.00000000",
        created_at: new Date("2026-08-03T12:00:00.000Z"),
        labels: [],
        dependencies: [],
      },
    ];
    for (const view of ["list", "board", "calendar"] as const) {
      const pool = new RecordingPool(rows);
      const result = await new OperatingCoreService(pool as unknown as Pool).query(
        actor,
        "work.view",
        { view, limit: 50 },
      );
      expect(result).toMatchObject({
        view,
        items: [expect.objectContaining({ id: rows[0].id, status: "in_progress" })],
      });
      expect(pool.calls[0].sql).toContain("FROM work_items w");
      expect(pool.calls[0].sql).toContain("project_memberships");
    }
  });

  it("uses the same safe NOT_FOUND for an unknown or unauthorized project", async () => {
    const pool = new RecordingPool([]);
    await expect(
      new OperatingCoreService(pool as unknown as Pool).query(actor, "project.get", {
        projectId: "00000000-0000-4000-8000-000000000999",
      }),
    ).rejects.toMatchObject({
      status: 404,
      code: "NOT_FOUND",
      publicMessage: "Resource not found.",
    });
    expect(pool.calls[0].sql).toContain("p.organization_id = $1");
    expect(pool.calls[0].sql).toContain("project_memberships");
  });
});
