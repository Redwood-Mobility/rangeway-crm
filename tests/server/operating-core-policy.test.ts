import { describe, expect, it } from "vitest";
import {
  blockerTargetTypes,
  decodeCursor,
  encodeCursor,
  searchRecordTypes,
  workItemStatuses,
  workItemTypes,
} from "../../src/shared/operating-core.js";
import {
  assertAcyclicDependencyGraph,
  assertPrivilegedMergeActor,
  assertStatusTransition,
  canMutateProjectRelationship,
} from "../../src/server/modules/operating-core/operating-core.policy.js";
import { ApiError } from "../../src/server/platform/http/api-error.js";
import type { ActorContext } from "../../src/shared/identity.js";

const actorContext: ActorContext = {
  actorId: "00000000-0000-4000-8000-000000000401",
  actorType: "human",
  actorName: "Atlas Operator",
  organizationId: "00000000-0000-4000-8000-000000000001",
  role: "member",
  userId: "00000000-0000-4000-8000-000000000101",
  requestId: "00000000-0000-4000-8000-000000000501",
};

describe("Operating Core domain policy", () => {
  it("defines the five approved work types and six approved statuses once", () => {
    expect(workItemTypes).toEqual([
      "action",
      "deliverable",
      "follow_up",
      "approval",
      "research",
    ]);
    expect(workItemStatuses).toEqual([
      "inbox",
      "next",
      "in_progress",
      "waiting",
      "done",
      "canceled",
    ]);
    expect(blockerTargetTypes).toEqual(["project", "workstream", "work_item"]);
    expect(searchRecordTypes).toEqual(["project", "work_item", "person", "counterparty"]);
  });

  it("permits an approved status transition and rejects a skipped transition", () => {
    expect(() => assertStatusTransition("next", "in_progress")).not.toThrow();
    expect(() => assertStatusTransition("inbox", "done")).toThrowError(
      expect.objectContaining<ApiError>({
        status: 409,
        code: "CONFLICT",
        publicMessage: "Invalid work item status transition.",
      }),
    );
  });

  it("round-trips an opaque stable cursor and rejects malformed pagination", () => {
    const cursor = encodeCursor({
      purpose: "project.list",
      sortType: "timestamp",
      sortValue: "2026-08-03T12:00:00.000Z",
      id: "00000000-0000-4000-8000-000000000111",
    });
    expect(decodeCursor(cursor, { purpose: "project.list", sortType: "timestamp" })).toEqual({
      purpose: "project.list",
      sortType: "timestamp",
      sortValue: "2026-08-03T12:00:00.000Z",
      id: "00000000-0000-4000-8000-000000000111",
    });
    for (const invalid of [
      "not-a-valid-cursor",
      encodeCursor({
        purpose: "work.list",
        sortType: "timestamp",
        sortValue: "2026-08-03T12:00:00.000Z",
        id: "00000000-0000-4000-8000-000000000111",
      }),
      Buffer.from(JSON.stringify({
        purpose: "project.list",
        sortType: "timestamp",
        sortValue: "not-a-timestamp",
        id: "00000000-0000-4000-8000-000000000111",
      })).toString("base64url"),
    ]) {
      expect(() => decodeCursor(invalid, { purpose: "project.list", sortType: "timestamp" })).toThrowError(
        expect.objectContaining<ApiError>({
          status: 400,
          code: "INVALID_INPUT",
          publicMessage: "Invalid pagination cursor.",
        }),
      );
    }

    const invalidNumber = encodeCursor({
      purpose: "workstream.list",
      sortType: "text",
      sortValue: "NaN",
      id: "00000000-0000-4000-8000-000000000111",
    });
    expect(() => decodeCursor(invalidNumber, {
      purpose: "workstream.list",
      sortType: "numeric",
    })).toThrowError(expect.objectContaining({ code: "INVALID_INPUT" }));
  });

  it("limits merges and private relationship mutation to documented principals", () => {
    expect(() => assertPrivilegedMergeActor({ ...actorContext, role: "member" })).toThrowError(
      expect.objectContaining({ status: 403, code: "FORBIDDEN" }),
    );
    expect(() => assertPrivilegedMergeActor({ ...actorContext, role: "owner" })).not.toThrow();
    expect(canMutateProjectRelationship({ ...actorContext, role: "member" }, {
      visibility: "private",
      createdByActorId: actorContext.actorId,
    })).toBe(true);
    expect(canMutateProjectRelationship({ ...actorContext, role: "member" }, {
      visibility: "private",
      createdByActorId: "00000000-0000-4000-8000-000000000999",
    })).toBe(false);
    expect(canMutateProjectRelationship({ ...actorContext, role: "admin" }, {
      visibility: "private",
      createdByActorId: "00000000-0000-4000-8000-000000000999",
    })).toBe(true);
  });

  it("rejects self, direct, and transitive work dependency cycles", () => {
    const edges: ReadonlyArray<readonly [string, string]> = [
      ["a", "b"],
      ["b", "c"],
    ];
    expect(() => assertAcyclicDependencyGraph(edges, "d", "a")).not.toThrow();
    expect(() => assertAcyclicDependencyGraph(edges, "a", "a")).toThrowError(
      "Work item dependencies cannot contain a cycle.",
    );
    expect(() => assertAcyclicDependencyGraph(edges, "c", "a")).toThrowError(
      "Work item dependencies cannot contain a cycle.",
    );
  });
});
