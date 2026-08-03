import { Pool, type PoolClient } from "pg";

export type DbClient = PoolClient;

export function createPool(databaseUrl: string): Pool {
  return new Pool({ connectionString: databaseUrl });
}

export async function withTransaction<T>(
  pool: Pool,
  operation: (client: DbClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      if (error instanceof Error) {
        Object.defineProperty(error, "rollbackError", { value: rollbackError });
      }
    }
    throw error;
  } finally {
    client.release();
  }
}
