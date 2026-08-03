import React, { useEffect, useState } from "react";
import { AtlasApiError } from "../api/client.js";

export interface Toast {
  id: number;
  tone: "info" | "error";
  message: string;
}

type Listener = (toast: Toast) => void;

const listeners = new Set<Listener>();
let nextId = 1;

/**
 * A module-level bus rather than React context, so mutation hooks in
 * `api/queries.ts` can report outcomes without every call site threading a
 * callback through.
 */
export function publishToast(message: string, tone: Toast["tone"] = "info"): void {
  const toast: Toast = { id: nextId++, tone, message };
  for (const listener of listeners) listener(toast);
}

export function publishMutationError(error: unknown, fallback: string): void {
  if (error instanceof AtlasApiError) {
    if (error.code === "CONFLICT") {
      publishToast(error.message, "error");
      return;
    }
    if (error.isMissingOrForbidden) {
      publishToast("That record is not available to your account.", "error");
      return;
    }
    publishToast(error.message || fallback, "error");
    return;
  }
  publishToast(fallback, "error");
}

/**
 * Results are announced politely for successes and assertively for failures, so
 * a rejected board move is never silent.
 */
export function ToastRegion() {
  const [toasts, setToasts] = useState<Toast[]>([]);

  useEffect(() => {
    const listener: Listener = (toast) => {
      setToasts((current) => [...current, toast]);
      window.setTimeout(
        () => setToasts((current) => current.filter((item) => item.id !== toast.id)),
        toast.tone === "error" ? 9000 : 5000,
      );
    };
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);

  return (
    <>
      <div className="visually-hidden" role="status" aria-live="polite">
        {toasts.filter((toast) => toast.tone === "info").map((toast) => (
          <p key={toast.id}>{toast.message}</p>
        ))}
      </div>
      <div className="visually-hidden" role="alert" aria-live="assertive">
        {toasts.filter((toast) => toast.tone === "error").map((toast) => (
          <p key={toast.id}>{toast.message}</p>
        ))}
      </div>
      {toasts.length > 0 ? (
        <div className="toast-region">
          {toasts.map((toast) => (
            <div key={toast.id} className="toast" data-tone={toast.tone}>
              <span>{toast.message}</span>
              <button
                type="button"
                className="icon-button"
                aria-label="Dismiss notification"
                onClick={() => setToasts((current) => current.filter((item) => item.id !== toast.id))}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      ) : null}
    </>
  );
}
