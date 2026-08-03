import { ApiError } from "../server/platform/http/api-error.js";

export const workItemTypes = [
  "action",
  "deliverable",
  "follow_up",
  "approval",
  "research",
] as const;
export type WorkItemType = (typeof workItemTypes)[number];

export const workItemStatuses = [
  "inbox",
  "next",
  "in_progress",
  "waiting",
  "done",
  "canceled",
] as const;
export type WorkItemStatus = (typeof workItemStatuses)[number];

export const projectStatuses = ["planned", "active", "on_hold", "completed", "canceled"] as const;
export type ProjectStatus = (typeof projectStatuses)[number];

export const projectHealthValues = ["unknown", "on_track", "at_risk", "off_track"] as const;
export type ProjectHealth = (typeof projectHealthValues)[number];

export const priorityValues = ["low", "medium", "high", "urgent"] as const;
export type Priority = (typeof priorityValues)[number];

export const projectRoles = ["owner", "editor", "viewer"] as const;
export type ProjectRole = (typeof projectRoles)[number];

export const decisionStates = ["proposed", "final"] as const;
export const riskLikelihoods = ["low", "medium", "high"] as const;
export const riskImpacts = ["low", "medium", "high", "critical"] as const;
export const riskStates = ["open", "mitigating", "accepted", "closed"] as const;
// `requirement` targets are deliberately absent until Task 3 introduces Location
// Pursuit requirement persistence. Accepting unvalidated requirement UUIDs now
// would create dangling blockers with no referential integrity.
export const blockerTargetTypes = ["project", "workstream", "work_item"] as const;
export type BlockerTargetType = (typeof blockerTargetTypes)[number];

export const searchRecordTypes = ["project", "work_item", "person", "counterparty"] as const;
export type SearchRecordType = (typeof searchRecordTypes)[number];
export const milestoneStates = ["planned", "completed", "canceled"] as const;
export const relationshipInfluences = ["low", "medium", "high"] as const;
export const relationshipSentiments = ["negative", "neutral", "positive", "unknown"] as const;

export const cursorSortTypes = ["timestamp", "numeric", "text"] as const;
export type CursorSortType = (typeof cursorSortTypes)[number];

/**
 * A cursor is only valid for the exact query that produced it. `purpose` binds
 * it to one listing and `sortType` binds it to that listing's ORDER BY column,
 * so a cursor can never be replayed against a different query or reach SQL with
 * a value the column cannot hold.
 */
export interface PageCursor {
  purpose: string;
  sortType: CursorSortType;
  sortValue: string;
  id: string;
}

export interface CursorContract {
  purpose: string;
  sortType: CursorSortType;
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function encodeCursor(cursor: PageCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function isSortValueValid(sortType: CursorSortType, sortValue: string): boolean {
  if (sortValue.length === 0) return false;
  if (sortType === "timestamp") return !Number.isNaN(Date.parse(sortValue));
  if (sortType === "numeric") return sortValue.trim().length > 0 && Number.isFinite(Number(sortValue));
  return true;
}

/**
 * Shape check for the transport layer, which does not know which listing is
 * being paged. Structurally invalid cursors are rejected before any handler
 * runs; binding a cursor to its listing and sort type is `decodeCursor`'s job.
 */
export function isWellFormedCursor(cursor: string): boolean {
  try {
    const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
    return (
      typeof decoded === "object" &&
      decoded !== null &&
      "purpose" in decoded &&
      typeof decoded.purpose === "string" &&
      decoded.purpose.length > 0 &&
      "sortType" in decoded &&
      typeof decoded.sortType === "string" &&
      (cursorSortTypes as readonly string[]).includes(decoded.sortType) &&
      "sortValue" in decoded &&
      typeof decoded.sortValue === "string" &&
      isSortValueValid(decoded.sortType as CursorSortType, decoded.sortValue) &&
      "id" in decoded &&
      typeof decoded.id === "string" &&
      uuidPattern.test(decoded.id)
    );
  } catch {
    return false;
  }
}

export function decodeCursor(cursor: string, contract: CursorContract): PageCursor {
  try {
    const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
    if (
      typeof decoded !== "object" ||
      decoded === null ||
      !("purpose" in decoded) ||
      decoded.purpose !== contract.purpose ||
      !("sortType" in decoded) ||
      decoded.sortType !== contract.sortType ||
      !("sortValue" in decoded) ||
      typeof decoded.sortValue !== "string" ||
      !isSortValueValid(contract.sortType, decoded.sortValue) ||
      !("id" in decoded) ||
      typeof decoded.id !== "string" ||
      !uuidPattern.test(decoded.id)
    ) {
      throw new Error("invalid cursor shape");
    }
    return {
      purpose: contract.purpose,
      sortType: contract.sortType,
      sortValue: decoded.sortValue,
      id: decoded.id,
    };
  } catch {
    throw new ApiError(400, "INVALID_INPUT", "Invalid pagination cursor.");
  }
}
