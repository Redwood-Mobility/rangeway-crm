import { Router, type RequestHandler } from "express";
import { z } from "zod";
import type { ActorContext } from "../../../shared/identity.js";
import {
  blockerTargetTypes,
  decisionStates,
  isWellFormedCursor,
  milestoneStates,
  priorityValues,
  projectHealthValues,
  projectRoles,
  projectStatuses,
  relationshipInfluences,
  relationshipSentiments,
  riskImpacts,
  riskLikelihoods,
  riskStates,
  searchRecordTypes,
  workItemStatuses,
  workItemTypes,
} from "../../../shared/operating-core.js";
import { requireActor } from "../../platform/http/request-context.js";

type CoreResult = Record<string, unknown>;
type CoreInput = Record<string, unknown>;

export interface OperatingCorePort {
  query(actor: ActorContext, operation: string, input: CoreInput): Promise<CoreResult>;
  mutate(
    actor: ActorContext,
    operation: string,
    input: CoreInput,
    idempotencyKey: string,
  ): Promise<CoreResult>;
}

const uuid = z.uuid();
const optionalUuid = uuid.optional();
const nullableUuid = uuid.nullable().optional();
const shortText = z.string().trim().min(1).max(200);
const longText = z.string().trim().max(10_000);
const idempotencyKeySchema = z
  .string()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/);
// Structural validation happens here so a malformed cursor never reaches a
// handler. Binding the cursor to its specific listing and sort type is the
// service's `decodeCursor`. Both layers reject with 400 INVALID_INPUT.
const cursorSchema = z
  .string()
  .min(1)
  .max(512)
  .refine(isWellFormedCursor, "Invalid pagination cursor.");
const paginationSchema = z.object({
  cursor: cursorSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

const projectCreateSchema = z.strictObject({
  name: shortText,
  objective: longText.default(""),
  templateType: z.string().trim().min(1).max(100).default("general"),
  status: z.enum(projectStatuses).default("planned"),
  health: z.enum(projectHealthValues).default("unknown"),
  priority: z.enum(priorityValues).default("medium"),
  strategicArea: z.string().trim().max(200).default(""),
  ownerUserId: uuid,
  currentFocus: longText.default(""),
  blockerSummary: longText.default(""),
  nextDecision: longText.default(""),
  nextAction: longText.default(""),
});
const projectPatchSchema = projectCreateSchema.partial().refine(
  (value) => Object.keys(value).length > 0,
  "At least one field is required.",
);
const archiveSchema = z.strictObject({ archived: z.boolean().default(true) }).default({ archived: true });
const memberSchema = z.strictObject({ userId: uuid, role: z.enum(projectRoles) });
const healthSchema = z.strictObject({
  health: z.enum(projectHealthValues),
  rationale: z.string().trim().min(1).max(5_000),
  reportingPeriodStart: z.iso.date().optional(),
  reportingPeriodEnd: z.iso.date().optional(),
  sourceCutoff: z.iso.datetime({ offset: true }).optional(),
});
const workstreamSchema = z.strictObject({
  name: shortText,
  description: longText.default(""),
  ownerUserId: nullableUuid,
  status: z.enum(["planned", "active", "completed", "canceled"]).default("planned"),
  position: z.number().finite().default(0),
});
const workstreamPatchSchema = workstreamSchema.partial().refine((value) => Object.keys(value).length > 0);
const workItemSchema = z.strictObject({
  projectId: uuid,
  workstreamId: nullableUuid,
  parentId: nullableUuid,
  type: z.enum(workItemTypes),
  title: z.string().trim().min(1).max(300),
  description: longText.default(""),
  ownerUserId: nullableUuid,
  status: z.enum(workItemStatuses).default("inbox"),
  priority: z.enum(priorityValues).default("medium"),
  dueAt: z.iso.datetime({ offset: true }).nullable().optional(),
  position: z.number().finite().default(0),
  labelIds: z.array(uuid).max(50).default([]),
});
const workItemPatchSchema = workItemSchema.omit({ projectId: true }).partial().refine(
  (value) => Object.keys(value).length > 0,
);
const moveSchema = z.strictObject({
  status: z.enum(workItemStatuses),
  position: z.number().finite(),
});
const decisionSchema = z.strictObject({
  question: z.string().trim().min(1).max(1_000),
  state: z.enum(decisionStates).default("proposed"),
  outcome: longText.default(""),
  rationale: longText.default(""),
  ownerUserId: nullableUuid,
  decisionAt: z.iso.datetime({ offset: true }).nullable().optional(),
  projectIds: z.array(uuid).max(50).default([]),
});
const decisionPatchSchema = decisionSchema.partial().refine((value) => Object.keys(value).length > 0);
const riskSchema = z.strictObject({
  workstreamId: nullableUuid,
  title: z.string().trim().min(1).max(300),
  description: longText.default(""),
  likelihood: z.enum(riskLikelihoods),
  impact: z.enum(riskImpacts),
  ownerUserId: nullableUuid,
  mitigation: longText.default(""),
  state: z.enum(riskStates).default("open"),
});
const riskPatchSchema = riskSchema.partial().refine((value) => Object.keys(value).length > 0);
const blockerSchema = z.strictObject({
  condition: z.string().trim().min(1).max(1_000),
  targetType: z.enum(blockerTargetTypes),
  targetId: uuid,
  ownerUserId: nullableUuid,
  resolved: z.boolean().default(false),
});
const blockerPatchSchema = blockerSchema.partial().refine((value) => Object.keys(value).length > 0);
const milestoneSchema = z.strictObject({
  workstreamId: nullableUuid,
  outcome: z.string().trim().min(1).max(500),
  ownerUserId: nullableUuid,
  targetAt: z.iso.datetime({ offset: true }),
  state: z.enum(milestoneStates).default("planned"),
  calendarEventId: z.string().trim().max(500).optional(),
});
const milestonePatchSchema = milestoneSchema.partial().refine((value) => Object.keys(value).length > 0);
const activitySchema = z.strictObject({
  activityType: z.string().trim().min(1).max(80).default("note"),
  body: z.string().trim().min(1).max(5_000),
  occurredAt: z.iso.datetime({ offset: true }).optional(),
});
const personSchema = z.strictObject({
  displayName: shortText,
  givenName: z.string().trim().max(100).default(""),
  familyName: z.string().trim().max(100).default(""),
  email: z.email().optional(),
  phone: z.string().trim().max(80).default(""),
  title: z.string().trim().max(200).default(""),
  notes: longText.default(""),
  provenance: z.record(z.string(), z.unknown()).default({}),
});
const personPatchSchema = personSchema.partial().refine((value) => Object.keys(value).length > 0);
const counterpartySchema = z.strictObject({
  name: shortText,
  kind: z.string().trim().min(1).max(80).default("other"),
  website: z.union([z.url(), z.literal("")]).default(""),
  notes: longText.default(""),
  provenance: z.record(z.string(), z.unknown()).default({}),
});
const counterpartyPatchSchema = counterpartySchema.partial().refine((value) => Object.keys(value).length > 0);
const relationshipSchema = z.strictObject({
  role: z.string().trim().max(200).default(""),
  influence: z.enum(relationshipInfluences).default("medium"),
  sentiment: z.enum(relationshipSentiments).default("unknown"),
  relevance: longText.default(""),
  notes: longText.default(""),
  visibility: z.enum(["project", "private"]).default("project"),
});
const projectPersonSchema = relationshipSchema.extend({ personId: uuid });
const projectCounterpartySchema = relationshipSchema.extend({ counterpartyId: uuid });
const affiliationSchema = z.strictObject({
  counterpartyId: uuid,
  title: z.string().trim().max(200).default(""),
  isPrimary: z.boolean().default(false),
  startsOn: z.iso.date().optional(),
  endsOn: z.iso.date().optional(),
  provenance: z.record(z.string(), z.unknown()).default({}),
});
const savedViewSchema = z.strictObject({
  name: z.string().trim().min(1).max(120),
  surface: z.enum(["projects", "work", "people", "portfolio"]),
  filters: z.record(z.string(), z.unknown()).default({}),
  isDefault: z.boolean().default(false),
});
const savedViewPatchSchema = savedViewSchema.partial().refine((value) => Object.keys(value).length > 0);
const labelSchema = z.strictObject({
  name: z.string().trim().min(1).max(80),
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).default("#64748b"),
});
const mergeSchema = z.strictObject({ intoId: uuid });
const emptyBodySchema = z.strictObject({}).default({});

function parseParams(req: Parameters<RequestHandler>[0], schema: z.ZodType): CoreInput {
  return schema.parse(req.params) as CoreInput;
}

function key(req: Parameters<RequestHandler>[0]): string {
  return idempotencyKeySchema.parse(req.get("Idempotency-Key"));
}

function queryRoute(core: OperatingCorePort, operation: string, schema: z.ZodType): RequestHandler {
  return async (req, res) => {
    const input = schema.parse({ ...req.params, ...req.query }) as CoreInput;
    res.json(await core.query(req.actor!, operation, input));
  };
}

function mutateRoute(
  core: OperatingCorePort,
  operation: string,
  bodySchema: z.ZodType,
  options: { status?: number; paramSchema?: z.ZodType } = {},
): RequestHandler {
  return async (req, res) => {
    const params = options.paramSchema ? parseParams(req, options.paramSchema) : {};
    const body = bodySchema.parse(req.body) as CoreInput;
    const result = await core.mutate(req.actor!, operation, { ...params, ...body }, key(req));
    res.status(options.status ?? 200).json(result);
  };
}

const idParam = (name: string) => z.object({ [name]: uuid });

export function createOperatingCoreRouter(core: OperatingCorePort): Router {
  const router = Router();
  router.use(requireActor);

  router.get("/projects", queryRoute(core, "project.list", paginationSchema.extend({
    status: z.enum(projectStatuses).optional(),
    health: z.enum(projectHealthValues).optional(),
    ownerUserId: optionalUuid,
    templateType: z.string().trim().max(100).optional(),
    strategicArea: z.string().trim().max(200).optional(),
    includeArchived: z.stringbool().optional(),
    q: z.string().trim().max(200).optional(),
  })));
  router.post("/projects", mutateRoute(core, "project.create", projectCreateSchema, { status: 201 }));
  router.get("/projects/:projectId", queryRoute(core, "project.get", idParam("projectId")));
  router.patch("/projects/:projectId", mutateRoute(core, "project.update", projectPatchSchema, { paramSchema: idParam("projectId") }));
  router.post("/projects/:projectId/archive", mutateRoute(core, "project.archive", archiveSchema, { paramSchema: idParam("projectId") }));

  router.get("/projects/:projectId/members", queryRoute(core, "project.members.list", paginationSchema.extend({ projectId: uuid })));
  router.post("/projects/:projectId/members", mutateRoute(core, "project.members.add", memberSchema, { status: 201, paramSchema: idParam("projectId") }));
  router.delete("/projects/:projectId/members/:userId", mutateRoute(core, "project.members.remove", emptyBodySchema, { paramSchema: z.object({ projectId: uuid, userId: uuid }) }));
  router.get("/projects/:projectId/health-updates", queryRoute(core, "project.health.list", paginationSchema.extend({ projectId: uuid })));
  router.post("/projects/:projectId/health-updates", mutateRoute(core, "project.health.add", healthSchema, { status: 201, paramSchema: idParam("projectId") }));
  router.get("/projects/:projectId/context-bundle", queryRoute(core, "project.context", idParam("projectId")));

  router.get("/portfolio", queryRoute(core, "portfolio.summary", paginationSchema.extend({ health: z.enum(projectHealthValues).optional() })));
  router.get("/portfolio/health", queryRoute(core, "portfolio.health", z.object({})));
  router.get("/today", queryRoute(core, "today.get", z.object({ date: z.iso.date().optional() })));
  router.get("/work-views/:view", queryRoute(core, "work.view", paginationSchema.extend({
    view: z.enum(["board", "list", "calendar"]),
    projectId: optionalUuid,
    workstreamId: optionalUuid,
    ownerUserId: optionalUuid,
    status: z.enum(workItemStatuses).optional(),
    priority: z.enum(priorityValues).optional(),
    labelId: optionalUuid,
    dueBefore: z.iso.datetime({ offset: true }).optional(),
    dueAfter: z.iso.datetime({ offset: true }).optional(),
    blocked: z.stringbool().optional(),
  })));

  router.get("/projects/:projectId/workstreams", queryRoute(core, "workstream.list", paginationSchema.extend({ projectId: uuid })));
  router.post("/projects/:projectId/workstreams", mutateRoute(core, "workstream.create", workstreamSchema, { status: 201, paramSchema: idParam("projectId") }));
  router.get("/workstreams/:workstreamId", queryRoute(core, "workstream.get", idParam("workstreamId")));
  router.patch("/workstreams/:workstreamId", mutateRoute(core, "workstream.update", workstreamPatchSchema, { paramSchema: idParam("workstreamId") }));

  router.get("/work-items", queryRoute(core, "work.list", paginationSchema.extend({
    projectId: optionalUuid,
    workstreamId: optionalUuid,
    ownerUserId: optionalUuid,
    status: z.enum(workItemStatuses).optional(),
    type: z.enum(workItemTypes).optional(),
    priority: z.enum(priorityValues).optional(),
    labelId: optionalUuid,
    includeArchived: z.stringbool().optional(),
  })));
  router.post("/work-items", mutateRoute(core, "work.create", workItemSchema, { status: 201 }));
  router.get("/work-items/:workItemId", queryRoute(core, "work.get", idParam("workItemId")));
  router.patch("/work-items/:workItemId", mutateRoute(core, "work.update", workItemPatchSchema, { paramSchema: idParam("workItemId") }));
  router.post("/work-items/:workItemId/move", mutateRoute(core, "work.move", moveSchema, { paramSchema: idParam("workItemId") }));
  router.post("/work-items/:workItemId/dependencies/:dependencyId", mutateRoute(core, "work.dependency.add", emptyBodySchema, { status: 201, paramSchema: z.object({ workItemId: uuid, dependencyId: uuid }) }));
  router.delete("/work-items/:workItemId/dependencies/:dependencyId", mutateRoute(core, "work.dependency.remove", emptyBodySchema, { paramSchema: z.object({ workItemId: uuid, dependencyId: uuid }) }));
  router.post("/work-items/:workItemId/archive", mutateRoute(core, "work.archive", archiveSchema, { paramSchema: idParam("workItemId") }));
  router.post("/work-items/:workItemId/labels/:labelId", mutateRoute(core, "work.label.add", emptyBodySchema, { status: 201, paramSchema: z.object({ workItemId: uuid, labelId: uuid }) }));
  router.delete("/work-items/:workItemId/labels/:labelId", mutateRoute(core, "work.label.remove", emptyBodySchema, { paramSchema: z.object({ workItemId: uuid, labelId: uuid }) }));
  router.get("/labels", queryRoute(core, "label.list", paginationSchema));
  router.post("/labels", mutateRoute(core, "label.create", labelSchema, { status: 201 }));

  for (const resource of ["decisions", "risks", "blockers", "milestones", "activity"] as const) {
    const singular = resource === "activity" ? "activity" : resource.slice(0, -1);
    const schema = resource === "decisions" ? decisionSchema : resource === "risks" ? riskSchema : resource === "blockers" ? blockerSchema : resource === "milestones" ? milestoneSchema : activitySchema;
    router.get(`/projects/:projectId/${resource}`, queryRoute(core, `${singular}.list`, paginationSchema.extend({ projectId: uuid })));
    router.post(`/projects/:projectId/${resource}`, mutateRoute(core, `${singular}.create`, schema, { status: 201, paramSchema: idParam("projectId") }));
  }
  router.get("/decisions/:decisionId", queryRoute(core, "decision.get", idParam("decisionId")));
  router.patch("/decisions/:decisionId", mutateRoute(core, "decision.update", decisionPatchSchema, { paramSchema: idParam("decisionId") }));
  router.get("/risks/:riskId", queryRoute(core, "risk.get", idParam("riskId")));
  router.patch("/risks/:riskId", mutateRoute(core, "risk.update", riskPatchSchema, { paramSchema: idParam("riskId") }));
  router.get("/blockers/:blockerId", queryRoute(core, "blocker.get", idParam("blockerId")));
  router.patch("/blockers/:blockerId", mutateRoute(core, "blocker.update", blockerPatchSchema, { paramSchema: idParam("blockerId") }));
  router.get("/milestones/:milestoneId", queryRoute(core, "milestone.get", idParam("milestoneId")));
  router.patch("/milestones/:milestoneId", mutateRoute(core, "milestone.update", milestonePatchSchema, { paramSchema: idParam("milestoneId") }));

  router.get("/people", queryRoute(core, "person.list", paginationSchema.extend({ q: z.string().trim().max(200).optional(), includeArchived: z.stringbool().optional() })));
  router.post("/people", mutateRoute(core, "person.create", personSchema, { status: 201 }));
  router.get("/people/:personId", queryRoute(core, "person.get", idParam("personId")));
  router.patch("/people/:personId", mutateRoute(core, "person.update", personPatchSchema, { paramSchema: idParam("personId") }));
  router.post("/people/:personId/merge", mutateRoute(core, "person.merge", mergeSchema, { paramSchema: idParam("personId") }));
  router.get("/people/:personId/affiliations", queryRoute(core, "affiliation.list", paginationSchema.extend({ personId: uuid })));
  router.post("/people/:personId/affiliations", mutateRoute(core, "affiliation.create", affiliationSchema, { status: 201, paramSchema: idParam("personId") }));

  router.get("/counterparties", queryRoute(core, "counterparty.list", paginationSchema.extend({ q: z.string().trim().max(200).optional(), includeArchived: z.stringbool().optional() })));
  router.post("/counterparties", mutateRoute(core, "counterparty.create", counterpartySchema, { status: 201 }));
  router.get("/counterparties/:counterpartyId", queryRoute(core, "counterparty.get", idParam("counterpartyId")));
  router.patch("/counterparties/:counterpartyId", mutateRoute(core, "counterparty.update", counterpartyPatchSchema, { paramSchema: idParam("counterpartyId") }));
  router.post("/counterparties/:counterpartyId/merge", mutateRoute(core, "counterparty.merge", mergeSchema, { paramSchema: idParam("counterpartyId") }));

  router.get("/projects/:projectId/people", queryRoute(core, "project.people.list", paginationSchema.extend({ projectId: uuid })));
  router.post("/projects/:projectId/people", mutateRoute(core, "project.people.add", projectPersonSchema, { status: 201, paramSchema: idParam("projectId") }));
  router.delete("/projects/:projectId/people/:personId", mutateRoute(core, "project.people.remove", emptyBodySchema, { paramSchema: z.object({ projectId: uuid, personId: uuid }) }));
  router.get("/projects/:projectId/counterparties", queryRoute(core, "project.counterparties.list", paginationSchema.extend({ projectId: uuid })));
  router.post("/projects/:projectId/counterparties", mutateRoute(core, "project.counterparties.add", projectCounterpartySchema, { status: 201, paramSchema: idParam("projectId") }));
  router.delete("/projects/:projectId/counterparties/:counterpartyId", mutateRoute(core, "project.counterparties.remove", emptyBodySchema, { paramSchema: z.object({ projectId: uuid, counterpartyId: uuid }) }));

  router.get("/saved-views", queryRoute(core, "saved-view.list", paginationSchema.extend({ surface: z.enum(["projects", "work", "people", "portfolio"]).optional() })));
  router.post("/saved-views", mutateRoute(core, "saved-view.create", savedViewSchema, { status: 201 }));
  router.patch("/saved-views/:savedViewId", mutateRoute(core, "saved-view.update", savedViewPatchSchema, { paramSchema: idParam("savedViewId") }));
  router.post("/saved-views/:savedViewId/archive", mutateRoute(core, "saved-view.archive", archiveSchema, { paramSchema: idParam("savedViewId") }));
  router.get("/search", queryRoute(core, "search.global", paginationSchema.extend({
    q: z.string().trim().min(2).max(200),
    types: z
      .string()
      .trim()
      .min(1)
      .transform((value) => value.split(",").map((type) => type.trim()))
      .pipe(z.array(z.enum(searchRecordTypes)).min(1).max(searchRecordTypes.length))
      .optional(),
  })));

  return router;
}
