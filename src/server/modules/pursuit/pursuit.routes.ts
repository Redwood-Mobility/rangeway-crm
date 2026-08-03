import { Router, type RequestHandler } from "express";
import { z } from "zod";
import {
  artifactModes,
  artifactVisibilities,
  evidenceTargetTypes,
  pursuitPhases,
  requirementStates,
} from "../../../shared/location-pursuit.js";
import { requireActor } from "../../platform/http/request-context.js";
import type { PursuitPort } from "./pursuit.service.js";

const uuid = z.uuid();
const idempotencyKeySchema = z
  .string()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/);

function queryRoute(core: PursuitPort, operation: string, schema: z.ZodType): RequestHandler {
  return async (req, res, next) => {
    try {
      const input = schema.parse({ ...req.params, ...req.query });
      res.json(await core.query(req.actor!, operation, input as Record<string, unknown>));
    } catch (error) {
      next(error);
    }
  };
}

function mutateRoute(
  core: PursuitPort,
  operation: string,
  schema: z.ZodType,
  options: { status?: number; paramSchema?: z.ZodType } = {},
): RequestHandler {
  return async (req, res, next) => {
    try {
      const key = idempotencyKeySchema.parse(req.get("Idempotency-Key"));
      const params = options.paramSchema ? options.paramSchema.parse(req.params) : {};
      const body = schema.parse(req.body ?? {});
      const result = await core.mutate(
        req.actor!,
        operation,
        { ...(params as object), ...(body as object) } as Record<string, unknown>,
        key,
      );
      res.status(options.status ?? 200).json(result);
    } catch (error) {
      next(error);
    }
  };
}

const projectParam = z.object({ projectId: uuid });

export function createPursuitRouter(core: PursuitPort): Router {
  const router = Router();
  router.use(requireActor);

  router.get(
    "/projects/:projectId/pursuit",
    queryRoute(core, "pursuit.readiness", projectParam),
  );
  router.post(
    "/projects/:projectId/pursuit",
    mutateRoute(core, "pursuit.enable", z.strictObject({}).default({}), {
      status: 201,
      paramSchema: projectParam,
    }),
  );
  router.patch(
    "/projects/:projectId/pursuit",
    mutateRoute(
      core,
      "pursuit.profile.update",
      z
        .strictObject({
          siteContext: z.string().trim().max(5_000).optional(),
          corridorContext: z.string().trim().max(5_000).optional(),
          formatHypothesis: z.string().trim().max(5_000).optional(),
          strategicThesis: z.string().trim().max(5_000).optional(),
          economicsSummary: z.string().trim().max(5_000).optional(),
          targetOpenOn: z.union([z.iso.date(), z.literal("")]).optional(),
        })
        .refine((value) => Object.keys(value).length > 0, "At least one field is required."),
      { paramSchema: projectParam },
    ),
  );
  router.post(
    "/projects/:projectId/pursuit/phase",
    mutateRoute(
      core,
      "pursuit.phase.change",
      z.strictObject({
        phase: z.enum(pursuitPhases),
        rationale: z.string().trim().max(5_000).default(""),
        overrideRationale: z.string().trim().max(5_000).default(""),
      }),
      { paramSchema: projectParam },
    ),
  );
  router.patch(
    "/pursuit-requirements/:requirementId",
    mutateRoute(
      core,
      "pursuit.requirement.update",
      z.strictObject({
        state: z.enum(requirementStates),
        notes: z.string().trim().max(5_000).optional(),
        waiverRationale: z.string().trim().max(5_000).default(""),
      }),
      { paramSchema: z.object({ requirementId: uuid }) },
    ),
  );

  router.get(
    "/artifacts",
    queryRoute(
      core,
      "artifact.list",
      z.object({
        projectId: uuid.optional(),
        limit: z.coerce.number().int().min(1).max(100).default(50),
      }),
    ),
  );
  router.post(
    "/artifacts",
    mutateRoute(
      core,
      "artifact.create",
      z
        .strictObject({
          mode: z.enum(artifactModes).exclude(["snapshot"]),
          title: z.string().trim().min(1).max(300),
          description: z.string().trim().max(5_000).default(""),
          projectId: uuid.optional(),
          storageKey: z.string().trim().max(500).default(""),
          canonicalUrl: z.union([z.url(), z.literal("")]).default(""),
          mimeType: z.string().trim().max(200).default(""),
          byteSize: z.number().int().min(0).default(0),
          checksum: z.string().trim().max(200).default(""),
          visibility: z.enum(artifactVisibilities).default("project"),
          sourceSystem: z.string().trim().max(100).default("atlas"),
          provenance: z.record(z.string(), z.unknown()).default({}),
        })
        .refine(
          (value) => (value.mode === "linked" ? value.canonicalUrl !== "" : value.storageKey !== ""),
          "Linked artifacts require a canonical URL; native artifacts require a storage key.",
        ),
      { status: 201 },
    ),
  );
  router.post(
    "/artifacts/:artifactId/snapshot",
    mutateRoute(core, "artifact.snapshot", z.strictObject({}).default({}), {
      status: 201,
      paramSchema: z.object({ artifactId: uuid }),
    }),
  );

  router.get(
    "/evidence",
    queryRoute(
      core,
      "evidence.list",
      z.object({ targetType: z.enum(evidenceTargetTypes), targetId: uuid }),
    ),
  );
  router.post(
    "/evidence",
    mutateRoute(
      core,
      "evidence.link",
      z.strictObject({
        artifactId: uuid,
        targetType: z.enum(evidenceTargetTypes),
        targetId: uuid,
        claim: z.string().trim().max(2_000).default(""),
      }),
      { status: 201 },
    ),
  );
  router.delete(
    "/evidence/:evidenceId",
    mutateRoute(core, "evidence.unlink", z.strictObject({}).default({}), {
      paramSchema: z.object({ evidenceId: uuid }),
    }),
  );

  return router;
}
