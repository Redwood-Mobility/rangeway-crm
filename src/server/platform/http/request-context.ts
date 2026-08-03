import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { ActorContext } from "../../../shared/identity.js";
import { ApiError } from "./api-error.js";

declare global {
  namespace Express {
    interface Request {
      requestId: string;
      actor?: ActorContext;
    }
  }
}

export const sessionCookieName = "rw_session";
const sessionMaxAgeMs = 12 * 60 * 60 * 1000;
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const bearerPattern = /^Bearer (atlas_[A-Za-z0-9_-]{12}\.[A-Za-z0-9_-]+)$/;

type HumanSession = {
  organizationId: string;
  email: string;
  expiresAt: number;
};

type ActorIdentity = Omit<ActorContext, "requestId">;

export interface IdentityAuthenticationPort {
  authenticateHuman(organizationId: string, email: string): Promise<ActorIdentity>;
  authenticateServiceKey(serviceKey?: string): Promise<ActorIdentity>;
}

function unauthenticated(): ApiError {
  return new ApiError(401, "UNAUTHENTICATED", "Authentication required.");
}

function signature(payload: string, secret: string): Buffer {
  return createHmac("sha256", secret).update(payload).digest();
}

function parseHumanSession(token: string, secret: string): HumanSession | null {
  const [payload, presentedSignature, extra] = token.split(".");
  if (!payload || !presentedSignature || extra) return null;

  let decodedSignature: Buffer;
  try {
    decodedSignature = Buffer.from(presentedSignature, "base64url");
  } catch {
    return null;
  }
  const expectedSignature = signature(payload, secret);
  if (
    decodedSignature.length !== expectedSignature.length ||
    !timingSafeEqual(decodedSignature, expectedSignature)
  ) {
    return null;
  }

  try {
    const session = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    ) as Partial<HumanSession>;
    if (
      typeof session.organizationId !== "string" ||
      typeof session.email !== "string" ||
      typeof session.expiresAt !== "number" ||
      session.expiresAt <= Date.now()
    ) {
      return null;
    }
    return session as HumanSession;
  } catch {
    return null;
  }
}

export function setHumanSessionCookie(
  res: Response,
  sessionSecret: string,
  organizationId: string,
  email: string,
): void {
  const payload = Buffer.from(
    JSON.stringify({
      organizationId,
      email: email.toLowerCase(),
      expiresAt: Date.now() + sessionMaxAgeMs,
    } satisfies HumanSession),
  ).toString("base64url");
  const token = `${payload}.${signature(payload, sessionSecret).toString("base64url")}`;

  res.cookie(sessionCookieName, token, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    maxAge: sessionMaxAgeMs,
    path: "/",
  });
}

export function clearHumanSessionCookie(res: Response): void {
  res.clearCookie(sessionCookieName, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
  });
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
        const session = parseHumanSession(sessionToken, sessionSecret);
        if (!session) throw unauthenticated();
        identityContext = await identity.authenticateHuman(
          session.organizationId,
          session.email,
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
