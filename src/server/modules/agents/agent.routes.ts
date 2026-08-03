import { Router, type RequestHandler } from "express";
import { z } from "zod";
import { agentScopes } from "../../../shared/agent-authority.js";
import { requireActor } from "../../platform/http/request-context.js";
import type { AgentPort } from "./agent.service.js";

const uuid = z.uuid();
const idempotencyKeySchema = z.string().min(8).max(128).regex(/^[A-Za-z0-9._:-]+$/);

function queryRoute(core: AgentPort, operation: string, schema: z.ZodType): RequestHandler {
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
  core: AgentPort,
  operation: string,
  schema: z.ZodType,
  options: { status?: number; paramSchema?: z.ZodType } = {},
): RequestHandler {
  return async (req, res, next) => {
    try {
      const key = idempotencyKeySchema.parse(req.get("Idempotency-Key"));
      const params = options.paramSchema ? options.paramSchema.parse(req.params) : {};
      const body = schema.parse(req.body ?? {});
      res
        .status(options.status ?? 200)
        .json(
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

export function createAgentRouter(core: AgentPort): Router {
  const router = Router();
  router.use(requireActor);

  router.get("/agents", queryRoute(core, "agent.list", z.object({})));
  router.get(
    "/agents/invocations",
    queryRoute(core, "agent.invocations", z.object({ actorId: uuid.optional() })),
  );
  router.get("/agents/delegations", queryRoute(core, "agent.delegations", z.object({})));
  router.get("/agents/approvals", queryRoute(core, "agent.approvals", z.object({})));

  router.post(
    "/agents/credentials",
    mutateRoute(
      core,
      "agent.credential.issue",
      z.strictObject({
        actorId: uuid,
        scopes: z.array(z.enum(agentScopes)).default([]),
        externalDeliveryAuthorized: z.boolean().default(false),
        expiresAt: z.iso.datetime({ offset: true }).optional(),
      }),
      { status: 201 },
    ),
  );
  router.post(
    "/agents/credentials/:credentialId/rotate",
    mutateRoute(core, "agent.credential.rotate", z.strictObject({}).default({}), {
      paramSchema: z.object({ credentialId: uuid }),
    }),
  );
  router.delete(
    "/agents/credentials/:credentialId",
    mutateRoute(core, "agent.credential.disable", z.strictObject({}).default({}), {
      paramSchema: z.object({ credentialId: uuid }),
    }),
  );

  router.post(
    "/agents/delegations",
    mutateRoute(
      core,
      "agent.delegation.create",
      z.strictObject({
        actorId: uuid,
        taskSource: z.string().trim().min(1).max(500),
        purpose: z.string().trim().max(2_000).default(""),
        permittedScopes: z.array(z.enum(agentScopes)).default([]),
        projectId: uuid.optional(),
        expiresAt: z.iso.datetime({ offset: true }),
      }),
      { status: 201 },
    ),
  );
  router.delete(
    "/agents/delegations/:delegationId",
    mutateRoute(core, "agent.delegation.revoke", z.strictObject({}).default({}), {
      paramSchema: z.object({ delegationId: uuid }),
    }),
  );

  router.post(
    "/agents/approvals/:approvalId",
    mutateRoute(
      core,
      "agent.approval.decide",
      z.strictObject({
        state: z.enum(["approved", "rejected"]),
        rationale: z.string().trim().max(2_000).default(""),
      }),
      { paramSchema: z.object({ approvalId: uuid }) },
    ),
  );

  return router;
}
