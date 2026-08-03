import crypto from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { config } from "./config.js";

export const sessionCookieName = "rw_session";
export const sessionMaxAgeMs = 1000 * 60 * 60 * 12;

export type SessionUser = {
  id: string;
  email: string;
  name: string;
  picture: string;
};

export type HumanSessionInput = SessionUser & {
  organizationId: string;
};

export type HumanSession = HumanSessionInput & {
  expiresAt: number;
};

function sign(payload: string, sessionSecret: string) {
  return crypto
    .createHmac("sha256", sessionSecret)
    .update(payload)
    .digest("base64url");
}

export function constantTimeEqual(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

export function setSessionCookie(
  res: Response,
  session: HumanSessionInput,
  sessionSecret: string,
) {
  const payload = Buffer.from(
    JSON.stringify({
      organizationId: session.organizationId,
      id: session.id,
      email: session.email.toLowerCase(),
      name: session.name || session.email,
      picture: session.picture || "",
      expiresAt: Date.now() + sessionMaxAgeMs,
    } satisfies HumanSession),
  ).toString("base64url");
  const token = `${payload}.${sign(payload, sessionSecret)}`;
  res.cookie(sessionCookieName, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: true,
    maxAge: sessionMaxAgeMs,
    path: "/"
  });
}

export function clearSessionCookie(res: Response) {
  res.clearCookie(sessionCookieName, {
    httpOnly: true,
    sameSite: "lax",
    secure: true,
    path: "/"
  });
}

export function readHumanSession(
  req: Request,
  sessionSecret: string,
): HumanSession | null {
  const raw = req.cookies?.[sessionCookieName];
  if (!raw || typeof raw !== "string") return null;
  const [payload, signature, extra] = raw.split(".");
  if (
    !payload ||
    !signature ||
    extra ||
    !constantTimeEqual(signature, sign(payload, sessionSecret))
  ) {
    return null;
  }

  try {
    const parsed = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    ) as Partial<HumanSession>;
    if (
      typeof parsed.organizationId !== "string" ||
      !parsed.organizationId ||
      typeof parsed.id !== "string" ||
      !parsed.id ||
      typeof parsed.email !== "string" ||
      !parsed.email ||
      typeof parsed.expiresAt !== "number" ||
      parsed.expiresAt <= Date.now()
    ) {
      return null;
    }
    return {
      organizationId: parsed.organizationId,
      id: parsed.id,
      email: parsed.email.toLowerCase(),
      name: parsed.name || parsed.email,
      picture: parsed.picture || "",
      expiresAt: parsed.expiresAt,
    };
  } catch {
    return null;
  }
}

export function currentUser(
  req: Request,
  sessionSecret = config.sessionSecret,
): SessionUser | null {
  const session = readHumanSession(req, sessionSecret);
  if (!session) return null;
  return {
    id: session.id,
    email: session.email,
    name: session.name,
    picture: session.picture,
  };
}

export function createRequireAuth(sessionSecret: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    const user = currentUser(req, sessionSecret);
    if (!user) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    res.locals.user = user;
    next();
  };
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  createRequireAuth(config.sessionSecret)(req, res, next);
}
