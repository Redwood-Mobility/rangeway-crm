import React, { useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router";
import { Plus } from "lucide-react";
import { useCreateProject, useMe, useProjects } from "../api/queries.js";
import {
  priorityValues,
  projectHealthValues,
  projectStatusLabels,
  projectStatuses,
  type ProjectHealth,
  type ProjectStatus,
} from "../api/types.js";
import {
  Dialog,
  EmptyState,
  ErrorState,
  Field,
  HealthBadge,
  PageHeader,
  SkeletonRows,
  formatDate,
} from "../components/primitives.js";

/**
 * Filters live in the URL so every view is a restorable, shareable link and the
 * back button returns to the previous filter set.
 */
export function Projects() {
  const [params, setParams] = useSearchParams();
  const [composing, setComposing] = useState(false);

  const filters = {
    q: params.get("q") ?? "",
    status: params.get("status") ?? "",
    health: params.get("health") ?? "",
    templateType: params.get("templateType") ?? "",
  };

  const { data, isPending, error, refetch } = useProjects({
    q: filters.q || undefined,
    status: filters.status || undefined,
    health: filters.health || undefined,
    templateType: filters.templateType || undefined,
    limit: 100,
  });

  function setFilter(key: string, value: string) {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  }

  return (
    <>
      <PageHeader
        eyebrow="Portfolio"
        title="Projects"
        description="Every Project Room you can open, with its current health and focus."
        actions={
          <button type="button" className="button button--primary" onClick={() => setComposing(true)}>
            <Plus aria-hidden="true" />
            New project
          </button>
        }
      />

      <div className="filter-bar" role="search">
        <div className="field">
          <label htmlFor="project-search">Search</label>
          <input
            id="project-search"
            className="input"
            type="search"
            placeholder="Name or objective"
            value={filters.q}
            onChange={(event) => setFilter("q", event.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="project-status">Status</label>
          <select
            id="project-status"
            className="select"
            value={filters.status}
            onChange={(event) => setFilter("status", event.target.value)}
          >
            <option value="">All statuses</option>
            {projectStatuses.map((status) => (
              <option key={status} value={status}>
                {projectStatusLabels[status]}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="project-health">Health</label>
          <select
            id="project-health"
            className="select"
            value={filters.health}
            onChange={(event) => setFilter("health", event.target.value)}
          >
            <option value="">All health</option>
            {projectHealthValues.map((health) => (
              <option key={health} value={health}>
                {health.replace("_", " ")}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="project-template">Template</label>
          <select
            id="project-template"
            className="select"
            value={filters.templateType}
            onChange={(event) => setFilter("templateType", event.target.value)}
          >
            <option value="">All templates</option>
            <option value="general">General</option>
            <option value="location_pursuit">Location Pursuit</option>
          </select>
        </div>
      </div>

      {error ? (
        <ErrorState error={error} onRetry={() => void refetch()} />
      ) : isPending ? (
        <SkeletonRows rows={6} />
      ) : data.projects.length === 0 ? (
        <EmptyState
          title="No projects match"
          description="Adjust the filters, or create the first Project Room."
          action={
            <button type="button" className="button button--primary" onClick={() => setComposing(true)}>
              New project
            </button>
          }
        />
      ) : (
        <div className="panel table-scroll">
          <table className="data-table">
            <caption className="visually-hidden">
              Projects with health, status, focus and next action
            </caption>
            <thead>
              <tr>
                <th scope="col">Project</th>
                <th scope="col">Health</th>
                <th scope="col">Status</th>
                <th scope="col">Current focus</th>
                <th scope="col">Next action</th>
                <th scope="col">Updated</th>
              </tr>
            </thead>
            <tbody>
              {data.projects.map((project) => (
                <tr key={project.id}>
                  <td className="wrap">
                    <Link to={`/projects/${project.id}`} style={{ fontWeight: 600 }}>
                      {project.name}
                    </Link>
                    {project.strategicArea ? (
                      <div style={{ color: "var(--text-muted)", fontSize: "var(--text-xs)" }}>
                        {project.strategicArea}
                      </div>
                    ) : null}
                  </td>
                  <td>
                    <HealthBadge health={project.health as ProjectHealth} />
                  </td>
                  <td>{projectStatusLabels[project.status as ProjectStatus]}</td>
                  <td className="wrap">{project.currentFocus || "—"}</td>
                  <td className="wrap">{project.nextAction || "—"}</td>
                  <td>
                    <time className="mono">{formatDate(project.updatedAt)}</time>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {composing ? <CreateProjectDialog onClose={() => setComposing(false)} /> : null}
    </>
  );
}

function CreateProjectDialog({ onClose }: { onClose: () => void }) {
  const { data: me } = useMe();
  const createProject = useCreateProject();
  const [name, setName] = useState("");
  const [objective, setObjective] = useState("");
  const [templateType, setTemplateType] = useState("general");
  const [status, setStatus] = useState<ProjectStatus>("planned");
  const [priority, setPriority] = useState("medium");
  const [strategicArea, setStrategicArea] = useState("");

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!me?.actor.userId) return;
    createProject.mutate(
      {
        name,
        objective,
        templateType,
        status,
        priority: priority as never,
        strategicArea,
        ownerUserId: me.actor.userId,
      },
      { onSuccess: onClose },
    );
  }

  return (
    <Dialog
      title="New project"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="button" onClick={onClose}>
            Cancel
          </button>
          <button
            type="submit"
            form="create-project"
            className="button button--primary"
            disabled={createProject.isPending || name.trim().length === 0}
          >
            {createProject.isPending ? "Creating…" : "Create project"}
          </button>
        </>
      }
    >
      <form id="create-project" onSubmit={onSubmit} style={{ display: "contents" }}>
        {createProject.error ? (
          <p className="field-error" role="alert">
            {(createProject.error as Error).message}
          </p>
        ) : null}
        <Field label="Name" htmlFor="new-project-name">
          <input
            id="new-project-name"
            className="input"
            required
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </Field>
        <Field label="Objective" htmlFor="new-project-objective">
          <textarea
            id="new-project-objective"
            className="textarea"
            value={objective}
            onChange={(event) => setObjective(event.target.value)}
          />
        </Field>
        <Field label="Template" htmlFor="new-project-template">
          <select
            id="new-project-template"
            className="select"
            value={templateType}
            onChange={(event) => setTemplateType(event.target.value)}
          >
            <option value="general">General</option>
            <option value="location_pursuit">Location Pursuit</option>
          </select>
        </Field>
        <Field label="Status" htmlFor="new-project-status">
          <select
            id="new-project-status"
            className="select"
            value={status}
            onChange={(event) => setStatus(event.target.value as ProjectStatus)}
          >
            {projectStatuses.map((value) => (
              <option key={value} value={value}>
                {projectStatusLabels[value]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Priority" htmlFor="new-project-priority">
          <select
            id="new-project-priority"
            className="select"
            value={priority}
            onChange={(event) => setPriority(event.target.value)}
          >
            {priorityValues.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Strategic area" htmlFor="new-project-area">
          <input
            id="new-project-area"
            className="input"
            value={strategicArea}
            onChange={(event) => setStrategicArea(event.target.value)}
          />
        </Field>
      </form>
    </Dialog>
  );
}
