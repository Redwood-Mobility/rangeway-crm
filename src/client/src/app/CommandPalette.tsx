import React, { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { useSearch } from "../api/queries.js";
import type { SearchResult } from "../api/types.js";

const typeLabels: Record<SearchResult["type"], string> = {
  project: "Project",
  work_item: "Work",
  person: "Person",
  counterparty: "Organization",
};

function resultHref(result: SearchResult): string {
  switch (result.type) {
    case "project":
      return `/projects/${result.id}`;
    case "work_item":
      return `/work?selected=${result.id}`;
    case "person":
      return `/stakeholders/people/${result.id}`;
    case "counterparty":
      return `/stakeholders/organizations/${result.id}`;
  }
}

/**
 * Search results are whatever the API returns for this actor. The palette does
 * no client-side permission filtering — the server decides visibility before
 * anything reaches the browser.
 */
export function CommandPalette({ onClose }: { onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);
  const { data, isFetching } = useSearch(query);

  const results = useMemo(() => data?.results ?? [], [data]);

  useEffect(() => inputRef.current?.focus(), []);
  useEffect(() => setActiveIndex(0), [query]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onClose();
      } else if (event.key === "ArrowDown") {
        event.preventDefault();
        setActiveIndex((index) => Math.min(index + 1, Math.max(results.length - 1, 0)));
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        setActiveIndex((index) => Math.max(index - 1, 0));
      } else if (event.key === "Enter" && results[activeIndex]) {
        event.preventDefault();
        navigate(resultHref(results[activeIndex]));
        onClose();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [activeIndex, navigate, onClose, results]);

  return (
    <div className="overlay-backdrop" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <div className="dialog" role="dialog" aria-modal="true" aria-label="Search Atlas">
        <input
          ref={inputRef}
          className="palette-input"
          type="search"
          placeholder="Search projects, work, people and organizations…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          aria-controls="palette-results"
          aria-describedby="palette-hint"
        />
        <p id="palette-hint" className="visually-hidden">
          Type at least two characters. Use arrow keys to move between results and Enter to open one.
        </p>
        <ul className="palette-results" id="palette-results" role="listbox">
          {query.trim().length < 2 ? (
            <li style={{ padding: "0.75rem", color: "var(--text-muted)" }}>
              Type at least two characters to search.
            </li>
          ) : isFetching && results.length === 0 ? (
            <li style={{ padding: "0.75rem", color: "var(--text-muted)" }}>Searching…</li>
          ) : results.length === 0 ? (
            <li style={{ padding: "0.75rem", color: "var(--text-muted)" }}>
              No results you can access match “{query}”.
            </li>
          ) : (
            results.map((result, index) => (
              <li key={`${result.type}-${result.id}`} role="option" aria-selected={index === activeIndex}>
                <button
                  type="button"
                  className="palette-result"
                  data-active={index === activeIndex}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => {
                    navigate(resultHref(result));
                    onClose();
                  }}
                >
                  <span>
                    <span style={{ display: "block", fontWeight: 500 }}>{result.title}</span>
                    {result.summary ? (
                      <span style={{ color: "var(--text-muted)", fontSize: "var(--text-sm)" }}>
                        {result.summary.slice(0, 90)}
                      </span>
                    ) : null}
                  </span>
                  <span className="chip">{typeLabels[result.type]}</span>
                </button>
              </li>
            ))
          )}
        </ul>
      </div>
    </div>
  );
}
