import type { ApiErrorCode } from "../../../shared/api.js";

export class ApiError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode;
  readonly publicMessage: string;
  readonly details?: unknown;

  constructor(
    status: number,
    code: ApiErrorCode,
    publicMessage: string,
    details?: unknown,
  ) {
    super(publicMessage);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.publicMessage = publicMessage;
    this.details = details;
  }
}
