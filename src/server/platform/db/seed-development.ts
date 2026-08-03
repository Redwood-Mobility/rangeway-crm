import process from "node:process";
import { pathToFileURL } from "node:url";
import argon2 from "argon2";
import "dotenv/config";
import { z } from "zod";
import { IdentityService } from "../../modules/identity/identity.service.js";
import { ApiError } from "../http/api-error.js";
import { createPool } from "./client.js";
import { runMigrations } from "./migrate.js";

const rangewayOrganizationId = "00000000-0000-4000-8000-000000000001";

export interface DevelopmentSeedInput {
  databaseUrl: string;
  email: string;
  displayName: string;
  password: string;
}

export function readDevelopmentSeedInput(
  env: NodeJS.ProcessEnv,
): DevelopmentSeedInput {
  if (env.NODE_ENV !== "development") {
    throw new Error("Development owner seed requires NODE_ENV=development.");
  }
  if (env.AUTH_MODE !== "local") {
    throw new Error("Development owner seed requires AUTH_MODE=local.");
  }

  const required = (
    field:
      | "DATABASE_URL"
      | "ATLAS_DEV_OWNER_EMAIL"
      | "ATLAS_DEV_OWNER_NAME"
      | "ATLAS_DEV_OWNER_PASSWORD",
  ): string => {
    const value = env[field]?.trim();
    if (!value) throw new Error(`Development owner seed requires explicit ${field}.`);
    return value;
  };

  const databaseUrl = required("DATABASE_URL");
  let databaseProtocol: string;
  try {
    databaseProtocol = new URL(databaseUrl).protocol;
  } catch {
    throw new Error("Development owner seed requires a valid PostgreSQL DATABASE_URL.");
  }
  if (databaseProtocol !== "postgres:" && databaseProtocol !== "postgresql:") {
    throw new Error("Development owner seed requires a PostgreSQL DATABASE_URL.");
  }

  const email = required("ATLAS_DEV_OWNER_EMAIL").toLowerCase();
  if (!z.email().safeParse(email).success) {
    throw new Error("Development owner seed requires a valid ATLAS_DEV_OWNER_EMAIL.");
  }
  const displayName = required("ATLAS_DEV_OWNER_NAME");
  const password = required("ATLAS_DEV_OWNER_PASSWORD");
  if (password.length < 12) {
    throw new Error("ATLAS_DEV_OWNER_PASSWORD must be at least 12 characters.");
  }

  return { databaseUrl, email, displayName, password };
}

export async function seedDevelopmentOwner(
  input: DevelopmentSeedInput,
): Promise<"created" | "existing"> {
  const pool = createPool(input.databaseUrl);
  try {
    await runMigrations(pool);
    const identity = new IdentityService(pool);
    const localPasswordHash = await argon2.hash(input.password, {
      type: argon2.argon2id,
    });

    try {
      await identity.createHumanUser({
        organizationId: rangewayOrganizationId,
        email: input.email,
        displayName: input.displayName,
        localPasswordHash,
        role: "owner",
      });
      return "created";
    } catch (error) {
      if (!(error instanceof ApiError) || error.code !== "CONFLICT") throw error;

      try {
        const existing = await identity.authenticateLocal(
          rangewayOrganizationId,
          input.email,
          input.password,
        );
        if (existing.actorType === "human" && existing.role === "owner") {
          return "existing";
        }
      } catch {
        // Convert all conflicts to one non-secret operator message below.
      }
      throw new Error(
        "Development owner already exists with different credentials or role.",
      );
    }
  } finally {
    await pool.end();
  }
}

async function main(): Promise<void> {
  const result = await seedDevelopmentOwner(readDevelopmentSeedInput(process.env));
  console.log(
    result === "created"
      ? "Atlas development owner created."
      : "Atlas development owner already exists; no changes made.",
  );
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  main().catch((error: unknown) => {
    console.error(
      error instanceof Error
        ? error.message
        : "Atlas development owner seed failed.",
    );
    process.exitCode = 1;
  });
}
