import crypto from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { config } from "./config.js";

const cookieName = "rw_session";
const maxAgeMs = 1000 * 60 * 60 * 12;

export type SessionUser = {
  id: string;
  email: string;
  name: string;
  picture: string;
};

function sign(payload: string) {
  return crypto.createHmac("sha256", config.sessionSecret).update(payload).digest("base64url");
}

export function constantTimeEqual(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

export function setSessionCookie(res: Response, user: SessionUser) {
  const payload = Buffer.from(JSON.stringify({ ...user, exp: Date.now() + maxAgeMs })).toString("base64url");
  const token = `${payload}.${sign(payload)}`;
  res.cookie(cookieName, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: config.isProduction,
    maxAge: maxAgeMs,
    path: "/"
  });
}

export function clearSessionCookie(res: Response) {
  res.clearCookie(cookieName, { path: "/" });
}

export function currentUser(req: Request) {
  const raw = req.cookies?.[cookieName];
  if (!raw || typeof raw !== "string") return null;
  const [payload, signature] = raw.split(".");
  if (!payload || !signature || !constantTimeEqual(signature, sign(payload))) return null;

  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Partial<SessionUser> & { exp?: number };
    if (!parsed.id || !parsed.email || !parsed.exp || parsed.exp < Date.now()) return null;
    return {
      id: parsed.id,
      email: parsed.email,
      name: parsed.name || parsed.email,
      picture: parsed.picture || ""
    };
  } catch {
    return null;
  }
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const user = currentUser(req);
  if (!user) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  res.locals.user = user;
  next();
}
