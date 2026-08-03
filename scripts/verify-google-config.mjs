#!/usr/bin/env node
/**
 * Validates Google OAuth configuration against the exact contract Atlas
 * enforces at boot, before a deploy discovers it the hard way.
 *
 * Run it where the values live. It reads them from the environment, reports
 * pass or fail per rule, and prints no secret — the client secret is only ever
 * checked for presence and shape.
 *
 *   set -a; . ./.env.production; set +a; node scripts/verify-google-config.mjs
 */

const results = [];
const record = (ok, label, detail = "") => results.push({ ok, label, detail });

const {
  ATLAS_ORIGIN = "",
  GOOGLE_CLIENT_ID = "",
  GOOGLE_CLIENT_SECRET = "",
  GOOGLE_REDIRECT_URI = "",
  GOOGLE_ALLOWED_DOMAIN = "rangeway.energy",
} = process.env;

const callbackPath = "/api/auth/google/callback";

let origin;
try {
  origin = new URL(ATLAS_ORIGIN);
  record(origin.protocol === "https:", "ATLAS_ORIGIN uses HTTPS", ATLAS_ORIGIN);
  record(
    ATLAS_ORIGIN === origin.origin,
    "ATLAS_ORIGIN is an origin only, with no path or trailing slash",
    ATLAS_ORIGIN,
  );
} catch {
  record(false, "ATLAS_ORIGIN is a valid URL", ATLAS_ORIGIN || "(missing)");
}

record(GOOGLE_CLIENT_ID.length > 0, "GOOGLE_CLIENT_ID is set");
record(
  GOOGLE_CLIENT_ID.endsWith(".apps.googleusercontent.com"),
  "GOOGLE_CLIENT_ID looks like a Google client id",
  GOOGLE_CLIENT_ID ? `…${GOOGLE_CLIENT_ID.slice(-30)}` : "(missing)",
);

// Presence and shape only. The value is never printed.
record(GOOGLE_CLIENT_SECRET.length > 0, "GOOGLE_CLIENT_SECRET is set");
record(
  GOOGLE_CLIENT_SECRET.length >= 24 && !/\s/.test(GOOGLE_CLIENT_SECRET),
  "GOOGLE_CLIENT_SECRET has no stray whitespace and is long enough",
);

try {
  const redirect = new URL(GOOGLE_REDIRECT_URI);
  record(redirect.protocol === "https:", "GOOGLE_REDIRECT_URI uses HTTPS");
  record(
    origin ? redirect.origin === origin.origin : false,
    "GOOGLE_REDIRECT_URI shares the ATLAS_ORIGIN origin",
    redirect.origin,
  );
  record(
    redirect.pathname === callbackPath && !redirect.search && !redirect.hash,
    `GOOGLE_REDIRECT_URI path is exactly ${callbackPath} with no query or fragment`,
    redirect.pathname,
  );
} catch {
  record(false, "GOOGLE_REDIRECT_URI is a valid URL", GOOGLE_REDIRECT_URI || "(missing)");
}

record(
  GOOGLE_ALLOWED_DOMAIN.length > 0 && !GOOGLE_ALLOWED_DOMAIN.includes("@"),
  "GOOGLE_ALLOWED_DOMAIN is a bare domain",
  GOOGLE_ALLOWED_DOMAIN,
);

const failures = results.filter((result) => !result.ok);
for (const result of results) {
  const mark = result.ok ? "pass" : "FAIL";
  console.log(`${mark}  ${result.label}${result.detail ? `  (${result.detail})` : ""}`);
}

console.log("");
if (failures.length === 0) {
  console.log("All Google configuration rules pass.");
  console.log("");
  console.log("In Google Cloud Console the OAuth client must list, exactly:");
  console.log(`  Authorized JavaScript origin:  ${ATLAS_ORIGIN}`);
  console.log(`  Authorized redirect URI:       ${GOOGLE_REDIRECT_URI}`);
  process.exit(0);
}

console.log(`${failures.length} rule(s) failed. Atlas will refuse to boot in production until they pass.`);
process.exit(1);
