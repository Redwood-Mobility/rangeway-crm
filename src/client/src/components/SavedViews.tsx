import React, { useState } from "react";
import { useSearchParams } from "react-router";
import { Bookmark, X } from "lucide-react";
import { useArchiveSavedView, useCreateSavedView, useSavedViews } from "../api/queries.js";

/**
 * Saves the current URL filters under a name and restores them on demand. The
 * URL stays the source of truth, so a saved view is just a stored filter set.
 */
export function SavedViews({ surface }: { surface: "projects" | "work" | "people" | "portfolio" }) {
  const [params, setParams] = useSearchParams();
  const { data } = useSavedViews(surface);
  const createView = useCreateSavedView();
  const archiveView = useArchiveSavedView();
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");

  const currentFilters: Record<string, string> = {};
  for (const [key, value] of params.entries()) {
    if (key === "selected" || key === "compose") continue;
    currentFilters[key] = value;
  }
  const hasFilters = Object.keys(currentFilters).length > 0;

  function applyView(filters: Record<string, string>) {
    setParams(new URLSearchParams(filters), { replace: false });
  }

  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: "0.375rem", alignItems: "center", marginBottom: "1rem" }}>
      <span className="field-label" style={{ marginRight: "0.25rem" }}>
        Saved views
      </span>

      {(data?.savedViews ?? []).length === 0 ? (
        <span style={{ color: "var(--text-muted)", fontSize: "var(--text-sm)" }}>None yet</span>
      ) : (
        data?.savedViews.map((view) => (
          <span key={view.id} className="chip" style={{ paddingRight: "0.125rem" }}>
            <button
              type="button"
              onClick={() => applyView(view.filters)}
              style={{ background: "none", border: "none", padding: 0, font: "inherit", color: "inherit", cursor: "pointer" }}
            >
              {view.name}
            </button>
            <button
              type="button"
              className="icon-button"
              style={{ width: "1.25rem", height: "1.25rem" }}
              aria-label={`Remove saved view ${view.name}`}
              onClick={() => archiveView.mutate({ savedViewId: view.id, surface })}
            >
              <X aria-hidden="true" style={{ width: "0.75rem", height: "0.75rem" }} />
            </button>
          </span>
        ))
      )}

      {naming ? (
        <form
          style={{ display: "flex", gap: "0.375rem", alignItems: "center" }}
          onSubmit={(event) => {
            event.preventDefault();
            createView.mutate(
              { name, surface, filters: currentFilters },
              {
                onSuccess: () => {
                  setNaming(false);
                  setName("");
                },
              },
            );
          }}
        >
          <label className="visually-hidden" htmlFor="saved-view-name">
            Name for this view
          </label>
          <input
            id="saved-view-name"
            className="input"
            style={{ width: "12rem" }}
            value={name}
            onChange={(event) => setName(event.target.value)}
            required
            autoFocus
          />
          <button type="submit" className="button button--primary" disabled={createView.isPending}>
            Save
          </button>
          <button type="button" className="button button--quiet" onClick={() => setNaming(false)}>
            Cancel
          </button>
        </form>
      ) : (
        <button
          type="button"
          className="button button--quiet"
          onClick={() => setNaming(true)}
          disabled={!hasFilters}
          title={hasFilters ? undefined : "Apply a filter first"}
        >
          <Bookmark aria-hidden="true" />
          Save current filters
        </button>
      )}
    </div>
  );
}
