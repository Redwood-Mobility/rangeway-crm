import React, { useMemo, useState, type FormEvent } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import { Plus } from "lucide-react";
import {
  useCreateWorkItem,
  useMe,
  useMoveWorkItem,
  useProjects,
  useWork,
} from "../api/queries.js";
import {
  boardLanes,
  priorityValues,
  workItemStatusLabels,
  workItemStatuses,
  workItemTypeLabels,
  workItemTypes,
  type Priority,
  type WorkItem,
  type WorkItemStatus,
  type WorkItemType,
} from "../api/types.js";
import {
  Dialog,
  EmptyState,
  ErrorState,
  Field,
  PageHeader,
  PriorityBadge,
  SkeletonRows,
  StatusBadge,
  formatDate,
  relativeDueLabel,
} from "../components/primitives.js";

type View = "board" | "list" | "calendar";

const views: View[] = ["board", "list", "calendar"];

export function Work() {
  const { view: viewParam } = useParams();
  const [params, setParams] = useSearchParams();
  const view: View = views.includes(viewParam as View) ? (viewParam as View) : "board";
  const [composing, setComposing] = useState(params.get("compose") === "1");

  const filters = {
    projectId: params.get("projectId") ?? "",
    status: params.get("status") ?? "",
    type: params.get("type") ?? "",
    priority: params.get("priority") ?? "",
  };

  // Every view reads the same query, so a move in one is immediately reflected
  // in the others — they are projections, not separate stores.
  const { data, isPending, error, refetch } = useWork({
    projectId: filters.projectId || undefined,
    status: filters.status || undefined,
    type: filters.type || undefined,
    priority: filters.priority || undefined,
    limit: 100,
  });
  const { data: projectData } = useProjects({ limit: 100 });

  const selectedId = params.get("selected");
  const items = data?.items ?? [];
  const selected = items.find((item) => item.id === selectedId) ?? null;

  function setFilter(key: string, value: string) {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  }

  function select(id: string | null) {
    const next = new URLSearchParams(params);
    if (id) next.set("selected", id);
    else next.delete("selected");
    setParams(next);
  }

  return (
    <>
      <PageHeader
        eyebrow="Universal work"
        title="Work"
        description="One record set behind the board, the list and the calendar. Moving an item anywhere updates it everywhere."
        actions={
          <button type="button" className="button button--primary" onClick={() => setComposing(true)}>
            <Plus aria-hidden="true" />
            New work item
          </button>
        }
      />

      <nav aria-label="Work views" style={{ marginBottom: "1rem", display: "flex", gap: "0.375rem" }}>
        {views.map((candidate) => (
          <Link
            key={candidate}
            to={{ pathname: `/work/${candidate}`, search: params.toString() }}
            className="button"
            aria-current={candidate === view ? "page" : undefined}
            style={
              candidate === view
                ? { background: "var(--surface-selected)", borderColor: "var(--accent-strong)" }
                : undefined
            }
          >
            {candidate[0].toUpperCase() + candidate.slice(1)}
          </Link>
        ))}
      </nav>

      <div className="filter-bar">
        <div className="field">
          <label htmlFor="work-project">Project</label>
          <select
            id="work-project"
            className="select"
            value={filters.projectId}
            onChange={(event) => setFilter("projectId", event.target.value)}
          >
            <option value="">All projects</option>
            {(projectData?.projects ?? []).map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="work-status">Status</label>
          <select
            id="work-status"
            className="select"
            value={filters.status}
            onChange={(event) => setFilter("status", event.target.value)}
          >
            <option value="">All statuses</option>
            {workItemStatuses.map((status) => (
              <option key={status} value={status}>
                {workItemStatusLabels[status]}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="work-type">Type</label>
          <select
            id="work-type"
            className="select"
            value={filters.type}
            onChange={(event) => setFilter("type", event.target.value)}
          >
            <option value="">All types</option>
            {workItemTypes.map((type) => (
              <option key={type} value={type}>
                {workItemTypeLabels[type]}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="work-priority">Priority</label>
          <select
            id="work-priority"
            className="select"
            value={filters.priority}
            onChange={(event) => setFilter("priority", event.target.value)}
          >
            <option value="">All priorities</option>
            {priorityValues.map((priority) => (
              <option key={priority} value={priority}>
                {priority}
              </option>
            ))}
          </select>
        </div>
      </div>

      {error ? (
        <ErrorState error={error} onRetry={() => void refetch()} />
      ) : isPending ? (
        <SkeletonRows rows={6} />
      ) : items.length === 0 ? (
        <EmptyState
          title="No work matches these filters"
          description="Clear a filter, or capture the first item."
          action={
            <button type="button" className="button button--primary" onClick={() => setComposing(true)}>
              New work item
            </button>
          }
        />
      ) : view === "board" ? (
        <BoardView items={items} selectedId={selectedId} onSelect={select} />
      ) : view === "list" ? (
        <ListView items={items} onSelect={select} />
      ) : (
        <CalendarView items={items} onSelect={select} />
      )}

      {selected ? <WorkDrawer item={selected} onClose={() => select(null)} /> : null}
      {composing ? (
        <CreateWorkDialog
          projectId={filters.projectId}
          onClose={() => {
            setComposing(false);
            const next = new URLSearchParams(params);
            next.delete("compose");
            setParams(next, { replace: true });
          }}
        />
      ) : null}
    </>
  );
}

/**
 * Lane movement is a labelled select on every card, so the board is fully
 * operable by keyboard and touch. There is no pointer-drag-only affordance.
 */
function BoardView({
  items,
  selectedId,
  onSelect,
}: {
  items: WorkItem[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const move = useMoveWorkItem();

  return (
    <div className="board">
      {boardLanes.map((lane) => {
        const laneItems = items.filter((item) => item.status === lane);
        return (
          <section className="board-lane" key={lane} aria-label={workItemStatusLabels[lane]}>
            <div className="board-lane__header">
              <h2 className="board-lane__title">{workItemStatusLabels[lane]}</h2>
              <span className="board-lane__count">{laneItems.length}</span>
            </div>
            <ul className="board-lane__items">
              {laneItems.length === 0 ? (
                <li style={{ color: "var(--text-muted)", fontSize: "var(--text-sm)", padding: "0.25rem" }}>
                  Empty
                </li>
              ) : (
                laneItems.map((item) => {
                  const due = relativeDueLabel(item.dueAt);
                  return (
                    <li key={item.id}>
                      <div
                        className="work-card"
                        data-priority={item.priority}
                        data-selected={item.id === selectedId}
                      >
                        <button
                          type="button"
                          className="work-card__title"
                          onClick={() => onSelect(item.id)}
                          style={{
                            background: "none",
                            border: "none",
                            padding: 0,
                            font: "inherit",
                            textAlign: "left",
                            cursor: "pointer",
                            color: "inherit",
                            width: "100%",
                          }}
                        >
                          {item.title}
                        </button>
                        <div className="work-card__meta">
                          <PriorityBadge priority={item.priority} />
                          <span>{workItemTypeLabels[item.type]}</span>
                          {item.dueAt ? (
                            <span style={{ color: due.overdue ? "var(--status-critical-fg)" : undefined }}>
                              {due.label}
                            </span>
                          ) : null}
                        </div>
                        <label
                          className="visually-hidden"
                          htmlFor={`move-${item.id}`}
                        >{`Move ${item.title} to another status`}</label>
                        <select
                          id={`move-${item.id}`}
                          className="select"
                          value={item.status}
                          style={{ marginTop: "0.5rem", minHeight: "1.875rem", fontSize: "var(--text-xs)" }}
                          onChange={(event) =>
                            move.mutate({
                              workItemId: item.id,
                              status: event.target.value as WorkItemStatus,
                              position: Number(item.position) || 1000,
                              projectId: item.projectId,
                            })
                          }
                        >
                          {workItemStatuses.map((status) => (
                            <option key={status} value={status}>
                              {workItemStatusLabels[status]}
                            </option>
                          ))}
                        </select>
                      </div>
                    </li>
                  );
                })
              )}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

function ListView({ items, onSelect }: { items: WorkItem[]; onSelect: (id: string) => void }) {
  return (
    <div className="panel table-scroll">
      <table className="data-table">
        <caption className="visually-hidden">Work items with status, type, priority and due date</caption>
        <thead>
          <tr>
            <th scope="col">Title</th>
            <th scope="col">Status</th>
            <th scope="col">Type</th>
            <th scope="col">Priority</th>
            <th scope="col">Due</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={item.id}>
              <td className="wrap">
                <button
                  type="button"
                  onClick={() => onSelect(item.id)}
                  style={{
                    background: "none",
                    border: "none",
                    padding: 0,
                    font: "inherit",
                    fontWeight: 600,
                    color: "var(--text-accent)",
                    cursor: "pointer",
                    textAlign: "left",
                  }}
                >
                  {item.title}
                </button>
              </td>
              <td>
                <StatusBadge status={item.status} />
              </td>
              <td>{workItemTypeLabels[item.type]}</td>
              <td>
                <PriorityBadge priority={item.priority} />
              </td>
              <td>
                <time className="mono">{formatDate(item.dueAt)}</time>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Month grid on wide viewports, agenda on narrow ones. The agenda is not a
 * degraded fallback — it is the readable form of the same records.
 */
function CalendarView({ items, onSelect }: { items: WorkItem[]; onSelect: (id: string) => void }) {
  const dated = useMemo(
    () =>
      items
        .filter((item) => item.dueAt)
        .sort((a, b) => (a.dueAt ?? "").localeCompare(b.dueAt ?? "")),
    [items],
  );

  const cells = useMemo(() => {
    const today = new Date();
    const first = new Date(today.getFullYear(), today.getMonth(), 1);
    const start = new Date(first);
    start.setDate(first.getDate() - first.getDay());
    return Array.from({ length: 42 }, (_, index) => {
      const date = new Date(start);
      date.setDate(start.getDate() + index);
      return date;
    });
  }, []);

  if (dated.length === 0) {
    return (
      <EmptyState
        title="No dated work"
        description="Work items with a due date appear on the calendar."
      />
    );
  }

  const byDay = new Map<string, WorkItem[]>();
  for (const item of dated) {
    const key = new Date(item.dueAt!).toDateString();
    byDay.set(key, [...(byDay.get(key) ?? []), item]);
  }

  const month = new Date().getMonth();

  return (
    <>
      <div className="calendar-grid">
        {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((day) => (
          <div className="calendar-weekday" key={day}>
            {day}
          </div>
        ))}
        {cells.map((date) => {
          const dayItems = byDay.get(date.toDateString()) ?? [];
          return (
            <div
              className="calendar-cell"
              key={date.toISOString()}
              data-outside={date.getMonth() !== month}
              data-today={date.toDateString() === new Date().toDateString()}
            >
              <span className="calendar-cell__date">{date.getDate()}</span>
              {dayItems.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className="chip"
                  onClick={() => onSelect(item.id)}
                  style={{ cursor: "pointer", textAlign: "left", overflow: "hidden" }}
                >
                  {item.title.slice(0, 22)}
                </button>
              ))}
            </div>
          );
        })}
      </div>

      <div className="calendar-agenda-only">
        <ul className="agenda-list">
          {[...byDay.entries()].map(([day, dayItems]) => (
            <li key={day} className="agenda-day">
              <div className="agenda-day__label">{day}</div>
              <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: "0.375rem" }}>
                {dayItems.map((item) => (
                  <li key={item.id}>
                    <button
                      type="button"
                      onClick={() => onSelect(item.id)}
                      style={{
                        background: "none",
                        border: "none",
                        padding: 0,
                        font: "inherit",
                        color: "var(--text-accent)",
                        cursor: "pointer",
                      }}
                    >
                      {item.title}
                    </button>
                    <div className="meta-row">
                      <StatusBadge status={item.status} />
                    </div>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      </div>
    </>
  );
}

function WorkDrawer({ item, onClose }: { item: WorkItem; onClose: () => void }) {
  const move = useMoveWorkItem();
  const due = relativeDueLabel(item.dueAt);

  return (
    <Dialog title={item.title} onClose={onClose}>
      <dl className="definition-grid">
        <div>
          <dt>Status</dt>
          <dd>
            <StatusBadge status={item.status} />
          </dd>
        </div>
        <div>
          <dt>Type</dt>
          <dd>{workItemTypeLabels[item.type]}</dd>
        </div>
        <div>
          <dt>Priority</dt>
          <dd>
            <PriorityBadge priority={item.priority} />
          </dd>
        </div>
        <div>
          <dt>Due</dt>
          <dd>
            <time className="mono">{formatDate(item.dueAt)}</time>
            {item.dueAt ? ` · ${due.label}` : null}
          </dd>
        </div>
        <div>
          <dt>Project</dt>
          <dd>
            <Link to={`/projects/${item.projectId}`}>Open Project Room</Link>
          </dd>
        </div>
        <div>
          <dt>Identifier</dt>
          <dd className="mono">{item.id}</dd>
        </div>
      </dl>

      {item.description ? <p>{item.description}</p> : null}

      <Field label="Move to status" htmlFor="drawer-status">
        <select
          id="drawer-status"
          className="select"
          value={item.status}
          onChange={(event) =>
            move.mutate({
              workItemId: item.id,
              status: event.target.value as WorkItemStatus,
              position: Number(item.position) || 1000,
              projectId: item.projectId,
            })
          }
        >
          {workItemStatuses.map((status) => (
            <option key={status} value={status}>
              {workItemStatusLabels[status]}
            </option>
          ))}
        </select>
      </Field>
      {move.isError ? (
        <p className="field-error" role="alert">
          That move was rejected and the previous status has been restored.
        </p>
      ) : null}
    </Dialog>
  );
}

function CreateWorkDialog({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const { data: projectData } = useProjects({ limit: 100 });
  const { data: me } = useMe();
  const createWork = useCreateWorkItem();
  const [selectedProject, setSelectedProject] = useState(projectId);
  const [title, setTitle] = useState("");
  const [type, setType] = useState<WorkItemType>("action");
  const [status, setStatus] = useState<WorkItemStatus>("next");
  const [priority, setPriority] = useState<Priority>("medium");
  const [dueAt, setDueAt] = useState("");
  const [assignToMe, setAssignToMe] = useState(true);

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!selectedProject) return;
    createWork.mutate(
      {
        projectId: selectedProject,
        title,
        type,
        status,
        priority,
        ownerUserId: assignToMe ? me?.actor.userId ?? null : null,
        dueAt: dueAt ? new Date(`${dueAt}T17:00:00`).toISOString() : null,
      },
      { onSuccess: onClose },
    );
  }

  return (
    <Dialog
      title="New work item"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="button" onClick={onClose}>
            Cancel
          </button>
          <button
            type="submit"
            form="create-work"
            className="button button--primary"
            disabled={createWork.isPending || !selectedProject || title.trim().length === 0}
          >
            {createWork.isPending ? "Creating…" : "Create"}
          </button>
        </>
      }
    >
      <form id="create-work" onSubmit={onSubmit} style={{ display: "contents" }}>
        {createWork.error ? (
          <p className="field-error" role="alert">
            {(createWork.error as Error).message}
          </p>
        ) : null}
        <Field label="Project" htmlFor="work-new-project">
          <select
            id="work-new-project"
            className="select"
            required
            value={selectedProject}
            onChange={(event) => setSelectedProject(event.target.value)}
          >
            <option value="">Select a project</option>
            {(projectData?.projects ?? []).map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Title" htmlFor="work-new-title">
          <input
            id="work-new-title"
            className="input"
            required
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
        </Field>
        <Field label="Type" htmlFor="work-new-type">
          <select
            id="work-new-type"
            className="select"
            value={type}
            onChange={(event) => setType(event.target.value as WorkItemType)}
          >
            {workItemTypes.map((value) => (
              <option key={value} value={value}>
                {workItemTypeLabels[value]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Status" htmlFor="work-new-status">
          <select
            id="work-new-status"
            className="select"
            value={status}
            onChange={(event) => setStatus(event.target.value as WorkItemStatus)}
          >
            {workItemStatuses.map((value) => (
              <option key={value} value={value}>
                {workItemStatusLabels[value]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Priority" htmlFor="work-new-priority">
          <select
            id="work-new-priority"
            className="select"
            value={priority}
            onChange={(event) => setPriority(event.target.value as Priority)}
          >
            {priorityValues.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Due date" htmlFor="work-new-due">
          <input
            id="work-new-due"
            className="input"
            type="date"
            value={dueAt}
            onChange={(event) => setDueAt(event.target.value)}
          />
        </Field>
        <label style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
          <input
            type="checkbox"
            checked={assignToMe}
            onChange={(event) => setAssignToMe(event.target.checked)}
          />
          Assign to me so it appears on Today
        </label>
      </form>
    </Dialog>
  );
}
