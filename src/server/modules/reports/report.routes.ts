import { Router, type RequestHandler } from "express";
import { z } from "zod";
import { audienceRoles, reportTemplates } from "../../../shared/reports.js";
import { requireActor } from "../../platform/http/request-context.js";
import type { ReportPort } from "./report.service.js";

const uuid = z.uuid();
const idempotencyKeySchema = z.string().min(8).max(128).regex(/^[A-Za-z0-9._:-]+$/);

function queryRoute(core: ReportPort, operation: string, schema: z.ZodType): RequestHandler {
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
  core: ReportPort,
  operation: string,
  schema: z.ZodType,
  options: { status?: number; paramSchema?: z.ZodType } = {},
): RequestHandler {
  return async (req, res, next) => {
    try {
      const key = idempotencyKeySchema.parse(req.get("Idempotency-Key"));
      const params = options.paramSchema ? options.paramSchema.parse(req.params) : {};
      const body = schema.parse(req.body ?? {});
      res.status(options.status ?? 200).json(
        await core.mutate(
          req.actor!,
          operation,
          { ...(params as object), ...(body as object) } as Record<string, unknown>,
          key,
        ),
      );
    } catch (error) {
      next(error);
    }
  };
}

const reportParam = z.object({ reportId: uuid });

export function createReportRouter(core: ReportPort): Router {
  const router = Router();
  router.use(requireActor);

  router.get("/reports", queryRoute(core, "report.list", z.object({ projectId: uuid.optional() })));
  router.get("/reports/:reportId", queryRoute(core, "report.get", reportParam));
  router.post(
    "/reports",
    mutateRoute(
      core,
      "report.prepare",
      z.strictObject({
        templateKey: z.enum(reportTemplates),
        audienceRole: z.enum(audienceRoles),
        projectId: uuid.optional(),
        sourceCutoff: z.iso.datetime({ offset: true }).optional(),
      }),
      { status: 201 },
    ),
  );
  router.patch(
    "/reports/:reportId",
    mutateRoute(core, "report.revise", z.strictObject({ narrative: z.string().max(20_000) }), {
      paramSchema: reportParam,
    }),
  );
  router.post(
    "/reports/:reportId/approve",
    mutateRoute(core, "report.approve", z.strictObject({}).default({}), { paramSchema: reportParam }),
  );
  router.post(
    "/reports/:reportId/render",
    mutateRoute(core, "report.render", z.strictObject({}).default({}), { paramSchema: reportParam }),
  );
  router.post(
    "/reports/:reportId/deliveries",
    mutateRoute(
      core,
      "report.deliver",
      z.strictObject({
        channel: z.enum(["email", "link"]).default("email"),
        sender: z.string().trim().max(320).default(""),
        recipient: z.string().trim().max(320).default(""),
        deliveryIdempotencyKey: z.string().trim().min(8).max(128).optional(),
        externalDeliveryAuthorized: z.boolean().default(false),
        providerAcceptance: z.string().trim().max(200).optional(),
      }),
      { status: 201, paramSchema: reportParam },
    ),
  );

  return router;
}
