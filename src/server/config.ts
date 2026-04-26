import path from "node:path";
import process from "node:process";
import "dotenv/config";

const root = process.cwd();
const isProduction = process.env.NODE_ENV === "production";

function required(name: string, fallback?: string) {
  const value = process.env[name] || fallback;
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

const hasGoogleSso = Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);

if (isProduction) {
  required("SESSION_SECRET");
  if (!hasGoogleSso) {
    required("ADMIN_EMAIL");
    required("ADMIN_PASSWORD");
  }
}

export const config = {
  isProduction,
  port: Number(process.env.PORT || 8080),
  publicUrl: process.env.PUBLIC_URL || "http://localhost:5173",
  adminEmail: process.env.ADMIN_EMAIL || "admin@rangeway.energy",
  adminPassword: process.env.ADMIN_PASSWORD || "rangeway-dev",
  sessionSecret: process.env.SESSION_SECRET || "dev-session-secret-change-me",
  googleClientId: process.env.GOOGLE_CLIENT_ID || "",
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET || "",
  googleAllowedDomain: process.env.GOOGLE_ALLOWED_DOMAIN || "rangeway.energy",
  databasePath: process.env.DATABASE_PATH || path.join(root, "data", "rangeway-crm.sqlite"),
  uploadDir: process.env.UPLOAD_DIR || path.join(root, "uploads"),
  maxUploadBytes: Number(process.env.MAX_UPLOAD_MB || 30) * 1024 * 1024
};
