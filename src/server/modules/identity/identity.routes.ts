import { Router } from "express";
import { z } from "zod";
import type { SessionUser } from "../../auth.js";
import type { Config } from "../../config.js";
import type { ActorIdentity } from "./identity.service.js";
import {
  authenticateRequest,
  clearHumanSessionCookie,
  type IdentityAuthenticationPort,
  requireActor,
  setHumanSessionCookie,
} from "../../platform/http/request-context.js";
import { ApiError } from "../../platform/http/api-error.js";
import type { OrganizationMutationPort } from "../organizations/organization.service.js";

const rangewayOrganizationId = "00000000-0000-4000-8000-000000000001";

const localLoginSchema = z.object({
  email: z.email().transform((email) => email.toLowerCase()),
  password: z.string().min(1),
});

const organizationParamsSchema = z.object({
  organizationId: z.uuid(),
});

const organizationNameSchema = z.strictObject({
  name: z.string().trim().min(1).max(200),
});

export interface V2IdentityPort extends IdentityAuthenticationPort {
  authenticateLocal(
    organizationId: string,
    email: string,
    password: string,
  ): Promise<ActorIdentity>;
}

export type SessionUserResolver = (
  identity: ActorIdentity & { actorType: "human"; userId: string },
  email: string,
) => SessionUser;

function notFound(): ApiError {
  return new ApiError(404, "NOT_FOUND", "Resource not found.");
}

export function createIdentityRouter(
  config: Config,
  identity: V2IdentityPort,
  resolveSessionUser: SessionUserResolver,
  organizations?: OrganizationMutationPort,
): Router {
  const router = Router();

  router.get("/health", (_req, res) => {
    res.json({ status: "ok", service: "atlas-web", apiVersion: "v2" });
  });

  router.post("/auth/logout", (_req, res) => {
    clearHumanSessionCookie(res);
    res.json({ ok: true });
  });

  router.post("/auth/local/login", (_req, _res, next) => {
    if (config.authMode !== "local" || config.isProduction) {
      next(notFound());
      return;
    }
    next();
  });

  router.use(authenticateRequest(identity, config.sessionSecret));

  router.post("/auth/local/login", async (req, res) => {
    const input = localLoginSchema.parse(req.body);
    const identityContext = await identity.authenticateLocal(
      rangewayOrganizationId,
      input.email,
      input.password,
    );
    if (identityContext.actorType !== "human" || !identityContext.userId) {
      throw new ApiError(401, "UNAUTHENTICATED", "Authentication required.");
    }
    const sessionUser = resolveSessionUser(
      { ...identityContext, actorType: "human", userId: identityContext.userId },
      input.email,
    );
    req.actor = { ...identityContext, requestId: req.requestId };
    setHumanSessionCookie(
      res,
      config.sessionSecret,
      identityContext.organizationId,
      sessionUser,
    );
    res.json({ actor: req.actor });
  });

  router.get("/me", requireActor, (req, res) => {
    res.json({ actor: req.actor });
  });

  if (organizations) {
    router.patch("/organizations/:organizationId", requireActor, async (req, res) => {
      const { organizationId } = organizationParamsSchema.parse(req.params);
      const { name } = organizationNameSchema.parse(req.body);
      const organization = await organizations.rename(
        req.actor!,
        organizationId,
        name,
      );
      res.json({ organization });
    });
  }

  router.use(requireActor, (_req, _res, next) => {
    next(notFound());
  });

  return router;
}
