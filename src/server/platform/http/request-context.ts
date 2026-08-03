import { randomUUID } from "node:crypto";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { ActorContext } from "../../../shared/identity.js";
import {
  clearSessionCookie,
  readHumanSession,
  sessionCookieName,
  setSessionCookie,
  type SessionUser,
} from "../../auth.js";
import { ApiError } from "./api-error.js";

declare global {
  namespace Express {
    interface Request {
      requestId: string;
      actor?: ActorContext;
    }
  }
}

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const bearerPattern = /^Bearer[ \t]+(atlas_[A-Za-z0-9_-]{12}\.[A-Za-z0-9_-]+)$/i;

type ActorIdentity = Omit<ActorContext, "requestId">;

export interface IdentityAuthenticationPort {
  authenticateHumanSession(organizationId: string, userId: string): Promise<ActorIdentity>;
  authenticateServiceKey(serviceKey?: string): Promise<ActorIdentity>;
}

function unauthenticated(): ApiError {
  return new ApiError(401, "UNAUTHENTICATED", "Authentication required.");
}

export function setHumanSessionCookie(
  res: Response,
  sessionSecret: string,
  organizationId: string,
  user: SessionUser,
  actorUserId: string,
): void {
  setSessionCookie(res, { ...user, organizationId, actorUserId }, sessionSecret);
}

export function clearHumanSessionCookie(res: Response): void {
  clearSessionCookie(res);
}

export const assignRequestContext: RequestHandler = (req, res, next) => {
  const suppliedRequestId = req.get("X-Request-Id");
  req.requestId =
    suppliedRequestId && uuidPattern.test(suppliedRequestId)
      ? suppliedRequestId
      : randomUUID();
  res.setHeader("X-Request-Id", req.requestId);
  next();
};

export function authenticateRequest(
  identity: IdentityAuthenticationPort,
  sessionSecret: string,
): RequestHandler {
  return async (req, _res, next) => {
    const sessionToken = req.cookies?.[sessionCookieName];
    const authorization = req.get("Authorization");
    const hasSession = typeof sessionToken === "string" && sessionToken.length > 0;
    const hasAuthorization = authorization !== undefined;

    if (hasSession && hasAuthorization) {
      next(unauthenticated());
      return;
    }
    if (!hasSession && !hasAuthorization) {
      next();
      return;
    }

    try {
      let identityContext: ActorIdentity;
      if (hasSession) {
        const session = readHumanSession(req, sessionSecret);
        if (!session) throw unauthenticated();
        identityContext = await identity.authenticateHumanSession(
          session.organizationId,
          session.actorUserId,
        );
      } else {
        const match = authorization ? bearerPattern.exec(authorization) : null;
        if (!match) throw unauthenticated();
        identityContext = await identity.authenticateServiceKey(match[1]);
      }

      req.actor = { ...identityContext, requestId: req.requestId };
      next();
    } catch (error) {
      if (error instanceof ApiError && error.code === "UNAUTHENTICATED") {
        next(unauthenticated());
        return;
      }
      next(error);
    }
  };
}

export function requireActor(req: Request, _res: Response, next: NextFunction): void {
  if (!req.actor) {
    next(unauthenticated());
    return;
  }
  next();
}
