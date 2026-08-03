import React, { useState, type FormEvent } from "react";
import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { apiRequest, newIdempotencyKey } from "../api/client.js";
import { keys } from "../api/queries.js";
import { publishMutationError, publishToast } from "../components/toast.js";
import {
  Badge,
  Dialog,
  EmptyState,
  ErrorState,
  Field,
  Panel,
  SkeletonRows,
  formatDate,
  formatDateTime,
} from "../components/primitives.js";

const requirementStates = [
  "unknown",
  "investigating",
  "in_progress",
  "evidenced",
  "blocked",
  "waived",
  "not_applicable",
] as const;
type RequirementState = (typeof requirementStates)[number];

const pursuitPhases = [
  "identified",
  "qualifying",
  "diligence",
  "negotiation",
  "committed",
  "construction",
  "operating",
  "released",
] as const;
type PursuitPhase = (typeof pursuitPhases)[number];

const stateLabels: Record<RequirementState, string> = {
  unknown: "Unknown",
  investigating: "Investigating",
  in_progress: "In progress",
  evidenced: "Evidenced",
  blocked: "Blocked",
  waived: "Waived",
  not_applicable: "Not applicable",
};

const stateTone: Record<RequirementState, "neutral" | "positive" | "caution" | "critical" | "active"> = {
  unknown: "neutral",
  investigating: "active",
  in_progress: "active",
  evidenced: "positive",
  blocked: "critical",
  waived: "caution",
  not_applicable: "neutral",
};

interface Requirement {
  requirementId: string;
  definitionKey: string;
  name: string;
  description: string;
  requiredByPhase: PursuitPhase;
  state: RequirementState;
  notes: string;
  waiverRationale: string;
  waivedAt: string | null;
  evidenceCount: number;
}

interface DevelopmentArea {
  key: string;
  name: string;
  requirements: Requirement[];
  satisfied: number;
  total: number;
}

interface Readiness {
  enabled: boolean;
  templateType?: string;
  profile?: { id: string; phase: PursuitPhase; targetOpenOn: string | null };
  developmentAreas?: DevelopmentArea[];
  unmetForCurrentPhase?: Array<{ requirementId: string; name: string }>;
  phaseHistory?: Array<{
    id: string;
    fromPhase: string | null;
    toPhase: string;
    rationale: string;
    overrideRationale: string;
    unmetRequirementIds: string[];
    createdAt: string;
  }>;
}

function useReadiness(projectId: string) {
  return useQuery({
    queryKey: ["pursuit", projectId],
    queryFn: () => apiRequest<Readiness>(`/projects/${projectId}/pursuit`),
  });
}

export function Gates({ projectId, templateType }: { projectId: string; templateType: string }) {
  const client = useQueryClient();
  const { data, isPending, error, refetch } = useReadiness(projectId);
  const [editing, setEditing] = useState<Requirement | null>(null);
  const [changingPhase, setChangingPhase] = useState(false);

  const enable = useMutation({
    mutationFn: () =>
      apiRequest(`/projects/${projectId}/pursuit`, {
        method: "POST",
        body: {},
        idempotencyKey: newIdempotencyKey("pursuit-enable"),
      }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["pursuit", projectId] });
      publishToast("Location Pursuit gates enabled.");
    },
    onError: (mutationError) => publishMutationError(mutationError, "Gates could not be enabled."),
  });

  if (templateType !== "location_pursuit") {
    return (
      <EmptyState
        title="This project does not use the Location Pursuit template"
        description="Only Location Pursuit projects carry development-area gates."
      />
    );
  }
  if (error) return <ErrorState error={error} onRetry={() => void refetch()} />;
  if (isPending) return <SkeletonRows rows={6} />;

  if (!data.enabled) {
    return (
      <EmptyState
        title="Gates are not set up for this pursuit yet"
        description="Enabling creates the eight development areas with every requirement in the Unknown state. Nothing is assumed to be true."
        action={
          <button
            type="button"
            className="button button--primary"
            onClick={() => enable.mutate()}
            disabled={enable.isPending}
          >
            {enable.isPending ? "Enabling…" : "Enable Location Pursuit gates"}
          </button>
        }
      />
    );
  }

  const areas = data.developmentAreas ?? [];
  const satisfied = areas.reduce((total, area) => total + area.satisfied, 0);
  const total = areas.reduce((sum, area) => sum + area.total, 0);
  const unmet = data.unmetForCurrentPhase ?? [];

  return (
    <>
      <div className="panel" style={{ marginBottom: "var(--section-gap)" }}>
        <div className="panel__body">
          <div style={{ display: "flex", flexWrap: "wrap", gap: "1rem", alignItems: "center", justifyContent: "space-between" }}>
            <div>
              <span className="field-label">Development phase</span>
              <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", marginTop: "0.25rem" }}>
                <strong style={{ fontFamily: "var(--font-display)", fontSize: "var(--text-xl)", textTransform: "uppercase" }}>
                  {data.profile?.phase}
                </strong>
                <Badge tone={unmet.length === 0 ? "positive" : "caution"}>
                  {satisfied} of {total} requirements satisfied
                </Badge>
              </div>
            </div>
            <button type="button" className="button" onClick={() => setChangingPhase(true)}>
              Change phase
            </button>
          </div>

          {unmet.length > 0 ? (
            <p style={{ marginTop: "0.75rem", color: "var(--status-caution-fg)" }}>
              {unmet.length} requirement{unmet.length === 1 ? "" : "s"} due by the current phase{" "}
              {unmet.length === 1 ? "is" : "are"} still unmet.
            </p>
          ) : null}
        </div>
      </div>

      <div className="panel-grid">
        {areas.map((area) => (
          <Panel
            key={area.key}
            title={area.name}
            actions={
              <Badge tone={area.satisfied === area.total ? "positive" : "neutral"}>
                {area.satisfied}/{area.total}
              </Badge>
            }
          >
            <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
              {area.requirements.map((requirement) => (
                <li
                  key={requirement.requirementId}
                  style={{ padding: "0.5rem 0", borderBottom: "1px solid var(--border-subtle)" }}
                >
                  <button
                    type="button"
                    onClick={() => setEditing(requirement)}
                    style={{
                      background: "none",
                      border: "none",
                      padding: 0,
                      font: "inherit",
                      fontWeight: 500,
                      color: "inherit",
                      cursor: "pointer",
                      textAlign: "left",
                    }}
                  >
                    {requirement.name}
                  </button>
                  <div className="meta-row" style={{ marginTop: "0.25rem" }}>
                    <Badge tone={stateTone[requirement.state]}>{stateLabels[requirement.state]}</Badge>
                    <span>due by {requirement.requiredByPhase}</span>
                    {requirement.evidenceCount > 0 ? (
                      <span>
                        {requirement.evidenceCount} evidence item
                        {requirement.evidenceCount === 1 ? "" : "s"}
                      </span>
                    ) : null}
                  </div>
                  {requirement.waiverRationale ? (
                    <p style={{ marginTop: "0.25rem", color: "var(--text-muted)", fontSize: "var(--text-sm)" }}>
                      Waived {formatDate(requirement.waivedAt)}: {requirement.waiverRationale}
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
          </Panel>
        ))}
      </div>

      {(data.phaseHistory ?? []).length > 0 ? (
        <div style={{ marginTop: "var(--section-gap)" }}>
          <Panel title="Phase history">
            <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
              {data.phaseHistory?.map((entry) => (
                <li key={entry.id} style={{ padding: "0.5rem 0", borderBottom: "1px solid var(--border-subtle)" }}>
                  <div>
                    <strong>
                      {entry.fromPhase ?? "—"} → {entry.toPhase}
                    </strong>
                    {entry.unmetRequirementIds.length > 0 ? (
                      <Badge tone="caution">
                        {entry.unmetRequirementIds.length} gate
                        {entry.unmetRequirementIds.length === 1 ? "" : "s"} overridden
                      </Badge>
                    ) : null}
                  </div>
                  {entry.rationale ? <p style={{ marginTop: "0.25rem" }}>{entry.rationale}</p> : null}
                  {entry.overrideRationale ? (
                    <p style={{ marginTop: "0.25rem", color: "var(--status-caution-fg)" }}>
                      Override: {entry.overrideRationale}
                    </p>
                  ) : null}
                  <time className="mono">{formatDateTime(entry.createdAt)}</time>
                </li>
              ))}
            </ul>
          </Panel>
        </div>
      ) : null}

      {editing ? (
        <RequirementDialog
          projectId={projectId}
          requirement={editing}
          onClose={() => setEditing(null)}
        />
      ) : null}
      {changingPhase ? (
        <PhaseDialog
          projectId={projectId}
          currentPhase={data.profile!.phase}
          onClose={() => setChangingPhase(false)}
        />
      ) : null}
    </>
  );
}

function RequirementDialog({
  projectId,
  requirement,
  onClose,
}: {
  projectId: string;
  requirement: Requirement;
  onClose: () => void;
}) {
  const client = useQueryClient();
  const [state, setState] = useState<RequirementState>(requirement.state);
  const [notes, setNotes] = useState(requirement.notes);
  const [waiverRationale, setWaiverRationale] = useState(requirement.waiverRationale);

  const update = useMutation({
    mutationFn: () =>
      apiRequest(`/pursuit-requirements/${requirement.requirementId}`, {
        method: "PATCH",
        body: { state, notes, waiverRationale },
        idempotencyKey: newIdempotencyKey("requirement-update"),
      }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["pursuit", projectId] });
      void client.invalidateQueries({ queryKey: keys.projectContext(projectId) });
      publishToast(`${requirement.name} set to ${stateLabels[state]}.`);
      onClose();
    },
    onError: (error) => publishMutationError(error, "That requirement was not updated."),
  });

  const requiresRationale = state === "waived" || state === "not_applicable";
  const needsEvidence = state === "evidenced" && requirement.evidenceCount === 0;

  return (
    <Dialog
      title={requirement.name}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="button" onClick={onClose}>
            Cancel
          </button>
          <button
            type="submit"
            form="requirement-form"
            className="button button--primary"
            disabled={
              update.isPending ||
              (requiresRationale && waiverRationale.trim().length === 0) ||
              needsEvidence
            }
          >
            {update.isPending ? "Saving…" : "Save"}
          </button>
        </>
      }
    >
      <form
        id="requirement-form"
        style={{ display: "contents" }}
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          update.mutate();
        }}
      >
        <p style={{ color: "var(--text-muted)" }}>{requirement.description}</p>
        <p className="meta-row">
          <span>Due by phase: {requirement.requiredByPhase}</span>
          <span>· Evidence linked: {requirement.evidenceCount}</span>
        </p>

        <Field label="State" htmlFor="requirement-state">
          <select
            id="requirement-state"
            className="select"
            value={state}
            onChange={(event) => setState(event.target.value as RequirementState)}
          >
            {requirementStates.map((value) => (
              <option key={value} value={value}>
                {stateLabels[value]}
              </option>
            ))}
          </select>
        </Field>

        {needsEvidence ? (
          <p className="field-error">
            Evidenced requires linked evidence. Attach an artifact to this requirement first.
          </p>
        ) : null}

        {requiresRationale ? (
          <Field label="Rationale (required)" htmlFor="requirement-rationale">
            <textarea
              id="requirement-rationale"
              className="textarea"
              required
              value={waiverRationale}
              onChange={(event) => setWaiverRationale(event.target.value)}
            />
          </Field>
        ) : null}

        <Field label="Notes" htmlFor="requirement-notes">
          <textarea
            id="requirement-notes"
            className="textarea"
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
          />
        </Field>
      </form>
    </Dialog>
  );
}

/**
 * A phase change surfaces exactly which gates are unmet and refuses to proceed
 * without an explicit override rationale, which is then recorded in history.
 */
function PhaseDialog({
  projectId,
  currentPhase,
  onClose,
}: {
  projectId: string;
  currentPhase: PursuitPhase;
  onClose: () => void;
}) {
  const client = useQueryClient();
  const [phase, setPhase] = useState<PursuitPhase>(currentPhase);
  const [rationale, setRationale] = useState("");
  const [overrideRationale, setOverrideRationale] = useState("");
  const [unmet, setUnmet] = useState<Array<{ requirementId: string; name: string }> | null>(null);

  const change = useMutation({
    mutationFn: () =>
      apiRequest(`/projects/${projectId}/pursuit/phase`, {
        method: "POST",
        body: { phase, rationale, overrideRationale },
        idempotencyKey: newIdempotencyKey("phase-change"),
      }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["pursuit", projectId] });
      publishToast(`Phase changed to ${phase}.`);
      onClose();
    },
    onError: (error) => {
      const details = (error as { details?: { unmet?: Array<{ requirementId: string; name: string }> } })
        .details;
      if (details?.unmet) {
        setUnmet(details.unmet);
        return;
      }
      publishMutationError(error, "The phase was not changed.");
    },
  });

  return (
    <Dialog
      title="Change development phase"
      wide
      onClose={onClose}
      footer={
        <>
          <button type="button" className="button" onClick={onClose}>
            Cancel
          </button>
          <button
            type="submit"
            form="phase-form"
            className="button button--primary"
            disabled={change.isPending || phase === currentPhase || (unmet !== null && overrideRationale.trim().length === 0)}
          >
            {change.isPending ? "Changing…" : unmet ? "Advance with override" : "Change phase"}
          </button>
        </>
      }
    >
      <form
        id="phase-form"
        style={{ display: "contents" }}
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          change.mutate();
        }}
      >
        <Field label="Phase" htmlFor="phase-value">
          <select
            id="phase-value"
            className="select"
            value={phase}
            onChange={(event) => {
              setPhase(event.target.value as PursuitPhase);
              setUnmet(null);
            }}
          >
            {pursuitPhases.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Rationale" htmlFor="phase-rationale">
          <textarea
            id="phase-rationale"
            className="textarea"
            value={rationale}
            onChange={(event) => setRationale(event.target.value)}
          />
        </Field>

        {unmet ? (
          <div className="state state--error" role="alert" style={{ textAlign: "left", alignItems: "flex-start" }}>
            <h2>{unmet.length} unmet requirement{unmet.length === 1 ? "" : "s"}</h2>
            <ul style={{ margin: 0, paddingLeft: "1.25rem" }}>
              {unmet.map((requirement) => (
                <li key={requirement.requirementId}>{requirement.name}</li>
              ))}
            </ul>
            <p>
              Resolve these, or record why the pursuit is advancing anyway. The override and the
              exact requirements bypassed are kept in phase history.
            </p>
          </div>
        ) : null}

        {unmet ? (
          <Field label="Override rationale (required)" htmlFor="phase-override">
            <textarea
              id="phase-override"
              className="textarea"
              required
              value={overrideRationale}
              onChange={(event) => setOverrideRationale(event.target.value)}
            />
          </Field>
        ) : null}
      </form>
    </Dialog>
  );
}
