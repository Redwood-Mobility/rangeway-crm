import React, { useEffect, useId, useRef } from "react";
import { AlertTriangle, Inbox, Loader2, X } from "lucide-react";
import { AtlasApiError } from "../api/client.js";
import {
  priorityLabels,
  projectHealthLabels,
  workItemStatusLabels,
  type Priority,
  type ProjectHealth,
  type WorkItemStatus,
} from "../api/types.js";

type Tone = "neutral" | "positive" | "caution" | "critical" | "active";

/**
 * Status is never expressed by colour alone — each tone carries its own marker
 * shape, and the label text is always present.
 */
export function Badge({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  return <span className={`badge badge--${tone}`}>{children}</span>;
}

const healthTone: Record<ProjectHealth, Tone> = {
  unknown: "neutral",
  on_track: "positive",
  at_risk: "caution",
  off_track: "critical",
};

export function HealthBadge({ health }: { health: ProjectHealth }) {
  return <Badge tone={healthTone[health]}>{projectHealthLabels[health]}</Badge>;
}

const statusTone: Record<WorkItemStatus, Tone> = {
  inbox: "neutral",
  next: "neutral",
  in_progress: "active",
  waiting: "caution",
  done: "positive",
  canceled: "neutral",
};

export function StatusBadge({ status }: { status: WorkItemStatus }) {
  return <Badge tone={statusTone[status]}>{workItemStatusLabels[status]}</Badge>;
}

const priorityTone: Record<Priority, Tone> = {
  low: "neutral",
  medium: "neutral",
  high: "caution",
  urgent: "critical",
};

export function PriorityBadge({ priority }: { priority: Priority }) {
  return <Badge tone={priorityTone[priority]}>{priorityLabels[priority]}</Badge>;
}

export function ActorChip({ name, label }: { name: string; label?: string }) {
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
  return (
    <span className="chip">
      <span className="chip__initials" aria-hidden="true">
        {initials || "?"}
      </span>
      <span>{label ? `${label}: ${name}` : name}</span>
    </span>
  );
}

/** Visibility is stated in words, never signalled by a lock icon alone. */
export function VisibilityChip({ visibility }: { visibility: string }) {
  return <span className="chip">{visibility === "private" ? "Private to you" : "Project-visible"}</span>;
}

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow?: string;
  title: string;
  description?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <header className="page-header">
      <div>
        {eyebrow ? <span className="eyebrow">{eyebrow}</span> : null}
        <h1>{title}</h1>
        {description ? <p>{description}</p> : null}
      </div>
      {actions ? <div className="header-actions">{actions}</div> : null}
    </header>
  );
}

export function Panel({
  title,
  actions,
  flush,
  children,
}: {
  title?: React.ReactNode;
  actions?: React.ReactNode;
  flush?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section className="panel">
      {title ? (
        <div className="panel__header">
          <h2>{title}</h2>
          {actions}
        </div>
      ) : null}
      <div className={flush ? "panel__body panel__body--flush" : "panel__body"}>{children}</div>
    </section>
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="state">
      <Inbox aria-hidden="true" />
      <h2>{title}</h2>
      {description ? <p>{description}</p> : null}
      {action}
    </div>
  );
}

export function LoadingState({ label = "Loading" }: { label?: string }) {
  return (
    <div className="state" role="status">
      <Loader2 aria-hidden="true" className="spin" />
      <p>{label}…</p>
    </div>
  );
}

export function SkeletonRows({ rows = 5 }: { rows?: number }) {
  return (
    <div className="skeleton-stack" aria-hidden="true">
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="skeleton" style={{ height: "2.5rem" }} />
      ))}
    </div>
  );
}

/**
 * Errors are shown honestly and distinguish "you cannot see this" from "this
 * broke" — without disclosing whether a hidden record exists.
 */
export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const apiError = error instanceof AtlasApiError ? error : null;
  const isMissing = apiError?.isMissingOrForbidden ?? false;
  const isOffline = apiError?.code === "OFFLINE";

  return (
    <div className="state state--error" role="alert">
      <AlertTriangle aria-hidden="true" />
      <h2>
        {isMissing ? "Not available" : isOffline ? "Atlas is unreachable" : "Something went wrong"}
      </h2>
      <p>
        {isMissing
          ? "This record does not exist, or your account cannot open it."
          : apiError?.message ?? "An unexpected error occurred."}
      </p>
      {apiError?.requestId ? (
        <p className="mono">Request {apiError.requestId}</p>
      ) : null}
      {onRetry && !isMissing ? (
        <button type="button" className="button" onClick={onRetry}>
          Retry
        </button>
      ) : null}
    </div>
  );
}

/**
 * A modal dialog that traps focus, closes on Escape, restores focus to the
 * control that opened it, and does not close from a stray backdrop click.
 */
export function Dialog({
  title,
  onClose,
  footer,
  wide,
  children,
}: {
  title: string;
  onClose: () => void;
  footer?: React.ReactNode;
  wide?: boolean;
  children: React.ReactNode;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const previouslyFocused = useRef<HTMLElement | null>(null);

  useEffect(() => {
    previouslyFocused.current = document.activeElement as HTMLElement | null;
    const focusable = dialogRef.current?.querySelector<HTMLElement>(
      'input, textarea, select, button, [href], [tabindex]:not([tabindex="-1"])',
    );
    focusable?.focus();
    return () => previouslyFocused.current?.focus();
  }, []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>(
          'input, textarea, select, button, [href], [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((element) => !element.hasAttribute("disabled"));
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [onClose]);

  return (
    <div className="overlay-backdrop">
      <div
        className={wide ? "dialog dialog--wide" : "dialog"}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        ref={dialogRef}
      >
        <div className="dialog__header">
          <h2 id={titleId}>{title}</h2>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close dialog">
            <X aria-hidden="true" />
          </button>
        </div>
        <div className="dialog__body">{children}</div>
        {footer ? <div className="dialog__footer">{footer}</div> : null}
      </div>
    </div>
  );
}

export function Field({
  label,
  htmlFor,
  error,
  children,
}: {
  label: string;
  htmlFor: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="field">
      <label htmlFor={htmlFor}>{label}</label>
      {children}
      {error ? (
        <span className="field-error" id={`${htmlFor}-error`}>
          {error}
        </span>
      ) : null}
    </div>
  );
}

export function formatDate(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function relativeDueLabel(dueAt: string | null): { label: string; overdue: boolean } {
  if (!dueAt) return { label: "No due date", overdue: false };
  const due = new Date(dueAt);
  const now = new Date();
  const days = Math.round((due.getTime() - now.getTime()) / 86_400_000);
  if (days < 0) return { label: `Overdue by ${Math.abs(days)}d`, overdue: true };
  if (days === 0) return { label: "Due today", overdue: false };
  if (days === 1) return { label: "Due tomorrow", overdue: false };
  return { label: `Due in ${days}d`, overdue: false };
}
