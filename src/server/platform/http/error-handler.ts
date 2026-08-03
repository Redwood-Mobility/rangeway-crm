import { randomUUID } from "node:crypto";
import type { ErrorRequestHandler } from "express";
import { ZodError } from "zod";
import type { ApiErrorBody } from "../../../shared/api.js";
import { ApiError } from "./api-error.js";

export interface ErrorLogger {
  error(message: string, context: Record<string, unknown>): void;
}

const defaultLogger: ErrorLogger = {
  error(message, context) {
    console.error(message, context);
  },
};

export function isTrustedJsonParserError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "type" in error &&
    "status" in error &&
    ((error.type === "entity.parse.failed" && error.status === 400) ||
      (error.type === "entity.too.large" && error.status === 413))
  );
}

export function createApiErrorHandler(
  logger: ErrorLogger = defaultLogger,
): ErrorRequestHandler {
  return (error, req, res, _next) => {
    const requestId = req.requestId || randomUUID();
    res.setHeader("X-Request-Id", requestId);

    if (error instanceof ZodError) {
      const body: ApiErrorBody = {
        error: {
          code: "INVALID_INPUT",
          message: "Invalid input.",
          requestId,
          details: error.flatten(),
        },
      };
      res.status(400).json(body);
      return;
    }

    if (
      isTrustedJsonParserError(error) &&
      (error as { type: string }).type === "entity.parse.failed"
    ) {
      const body: ApiErrorBody = {
        error: {
          code: "INVALID_INPUT",
          message: "Malformed JSON body.",
          requestId,
        },
      };
      res.status(400).json(body);
      return;
    }

    if (isTrustedJsonParserError(error)) {
      const body: ApiErrorBody = {
        error: {
          code: "PAYLOAD_TOO_LARGE",
          message: "Request body is too large.",
          requestId,
        },
      };
      res.status(413).json(body);
      return;
    }

    if (error instanceof ApiError) {
      const body: ApiErrorBody = {
        error: {
          code: error.code,
          message: error.publicMessage,
          requestId,
          ...(error.details === undefined ? {} : { details: error.details }),
        },
      };
      res.status(error.status).json(body);
      return;
    }

    logger.error("Atlas API request failed.", {
      requestId,
      method: req.method,
      path: req.path,
      ...(req.actor
        ? {
            actorId: req.actor.actorId,
            actorType: req.actor.actorType,
            organizationId: req.actor.organizationId,
          }
        : {}),
      error,
    });

    const body: ApiErrorBody = {
      error: {
        code: "INTERNAL_ERROR",
        message: "Unexpected server error.",
        requestId,
      },
    };
    res.status(500).json(body);
  };
}
