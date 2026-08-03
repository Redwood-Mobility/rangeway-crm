const urlSafePasswordPattern = /^[A-Za-z0-9_-]{24,128}$/;

export interface ProductionPostgresUrlContract {
  username: string;
  hostname?: string;
  database?: string;
}

export function validateProductionPostgresUrl(
  value: string,
  contract: ProductionPostgresUrlContract,
): string | null {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return "must be a valid PostgreSQL URL";
  }

  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    return "must use the postgres or postgresql protocol";
  }
  if (parsed.username !== contract.username) {
    return `must use the least-privilege ${contract.username} role`;
  }
  if (!parsed.password || !urlSafePasswordPattern.test(parsed.password)) {
    return "must use a 24-128 character URL-safe password containing only letters, numbers, underscore, or hyphen";
  }
  if (contract.hostname && parsed.hostname !== contract.hostname) {
    return `must use the ${contract.hostname} database host`;
  }
  if (contract.database && parsed.pathname !== `/${contract.database}`) {
    return `must use the ${contract.database} database`;
  }
  if (parsed.port && parsed.port !== "5432") {
    return "must use PostgreSQL port 5432";
  }
  if (parsed.search || parsed.hash) {
    return "must not include query parameters or a fragment";
  }
  return null;
}

export const productionDatabasePasswordPattern = urlSafePasswordPattern;
