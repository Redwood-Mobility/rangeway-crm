import { randomBytes } from "node:crypto";
import { Pool } from "pg";

const defaultTestDatabaseUrl = "postgres://atlas:atlas@localhost:5432/postgres";

export class PostgreSqlUnavailableError extends Error {
  constructor(databaseUrl: string, options?: ErrorOptions) {
    const url = new URL(databaseUrl);
    super(`PostgreSQL is unavailable at ${url.hostname}:${url.port || "5432"}; migration integration test skipped.`, options);
    this.name = "PostgreSqlUnavailableError";
  }
}

export type TemporaryDatabase = {
  databaseUrl: string;
  cleanup: () => Promise<void>;
};

export function isPostgreSqlUnreachable(error: unknown): boolean {
  if (error instanceof AggregateError) {
    return error.errors.length > 0 && error.errors.every(isPostgreSqlUnreachable);
  }
  if (!(error instanceof Error) || !("code" in error)) return false;

  return ["ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH", "ENOTFOUND", "ETIMEDOUT"].includes(
    String(error.code),
  );
}

export async function createTemporaryDatabase(): Promise<TemporaryDatabase> {
  const administrationUrl = process.env.TEST_DATABASE_URL ?? defaultTestDatabaseUrl;
  const databaseName = `atlas_test_${randomBytes(12).toString("hex")}`;
  const pool = new Pool({ connectionString: administrationUrl, connectionTimeoutMillis: 2_000 });

  try {
    await pool.query(`CREATE DATABASE "${databaseName}"`);
  } catch (error) {
    await pool.end();
    if (isPostgreSqlUnreachable(error)) throw new PostgreSqlUnavailableError(administrationUrl, { cause: error });
    throw error;
  }

  const databaseUrl = new URL(administrationUrl);
  databaseUrl.pathname = `/${databaseName}`;

  return {
    databaseUrl: databaseUrl.toString(),
    cleanup: async () => {
      try {
        await pool.query(
          "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
          [databaseName],
        );
        await pool.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
      } finally {
        await pool.end();
      }
    },
  };
}
