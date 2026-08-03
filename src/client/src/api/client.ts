/**
 * The single transport for every Atlas request.
 *
 * Features must not hand-roll fetch calls: request IDs, idempotency keys,
 * pagination and error mapping all live here so behaviour stays identical
 * across every screen.
 */

export type ApiErrorCode =
  | "INVALID_INPUT"
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "RATE_LIMITED"
  | "INTERNAL"
  | "OFFLINE";

export class AtlasApiError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode;
  readonly requestId?: string;
  readonly details?: unknown;

  constructor(
    status: number,
    code: ApiErrorCode,
    message: string,
    requestId?: string,
    details?: unknown,
  ) {
    super(message);
    this.name = "AtlasApiError";
    this.status = status;
    this.code = code;
    this.requestId = requestId;
    this.details = details;
  }

  /** True when the caller may not see this record — or it does not exist. */
  get isMissingOrForbidden(): boolean {
    return this.code === "NOT_FOUND" || this.code === "FORBIDDEN";
  }
}

const apiBase = "/api/v2";

export type QueryValue = string | number | boolean | null | undefined;

function buildQuery(params?: Record<string, QueryValue>): string {
  if (!params) return "";
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    search.set(key, String(value));
  }
  const serialized = search.toString();
  return serialized ? `?${serialized}` : "";
}

async function parseError(response: Response): Promise<AtlasApiError> {
  let code: ApiErrorCode = "INTERNAL";
  let message = "Something went wrong.";
  let requestId: string | undefined = response.headers.get("x-request-id") ?? undefined;
  let details: unknown;

  try {
    const body = (await response.json()) as {
      error?: { code?: ApiErrorCode; message?: string; requestId?: string; details?: unknown };
    };
    if (body.error) {
      code = body.error.code ?? code;
      message = body.error.message ?? message;
      requestId = body.error.requestId ?? requestId;
      details = body.error.details;
    }
  } catch {
    // A non-JSON body (proxy error page, gateway timeout) keeps the defaults.
  }

  if (response.status === 401) code = "UNAUTHENTICATED";
  return new AtlasApiError(response.status, code, message, requestId, details);
}

export interface RequestOptions {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  query?: Record<string, QueryValue>;
  body?: unknown;
  /**
   * Every material mutation requires one. Callers pass a stable key so a retry
   * of the same intent replays rather than duplicating.
   */
  idempotencyKey?: string;
  signal?: AbortSignal;
}

export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = "GET", query, body, idempotencyKey, signal } = options;
  const headers: Record<string, string> = { Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;

  let response: Response;
  try {
    response = await fetch(`${apiBase}${path}${buildQuery(query)}`, {
      method,
      headers,
      credentials: "same-origin",
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new AtlasApiError(
      0,
      "OFFLINE",
      "Atlas could not be reached. Check your connection and retry.",
    );
  }

  if (!response.ok) throw await parseError(response);
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

/**
 * Idempotency keys must be stable for one user intent and distinct across
 * intents. A per-attempt UUID satisfies both: React Query retries reuse the key
 * created when the mutation was invoked.
 */
export function newIdempotencyKey(operation: string): string {
  const unique =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${operation}-${unique}`.slice(0, 128);
}

export interface Page {
  nextCursor: string | null;
}
