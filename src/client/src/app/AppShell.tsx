import React, { useEffect, useState } from "react";
import { NavLink, Outlet, useLocation } from "react-router";
import {
  CalendarDays,
  Compass,
  FolderKanban,
  LayoutDashboard,
  LogOut,
  Menu,
  Moon,
  Rows3,
  Search,
  Sun,
  Sunrise,
  UsersRound,
} from "lucide-react";
import { useMe, useSignOut } from "../api/queries.js";
import { ToastRegion } from "../components/toast.js";
import { CommandPalette } from "./CommandPalette.js";

const navigation = [
  { to: "/today", label: "Today", icon: Sunrise },
  { to: "/command-center", label: "Command Center", icon: LayoutDashboard },
  { to: "/projects", label: "Projects", icon: Compass },
  { to: "/work", label: "Work", icon: FolderKanban },
  { to: "/work/calendar", label: "Calendar", icon: CalendarDays, end: true },
  { to: "/stakeholders", label: "Stakeholders", icon: UsersRound },
];

type Theme = "light" | "dark";

function usePersistentTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(() => {
    const stored = localStorage.getItem("atlas-theme");
    if (stored === "light" || stored === "dark") return stored;
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  });

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("atlas-theme", theme);
  }, [theme]);

  return [theme, () => setTheme((current) => (current === "dark" ? "light" : "dark"))];
}

function usePersistentDensity(): [string, () => void] {
  const [density, setDensity] = useState(() => localStorage.getItem("atlas-density") ?? "comfortable");

  useEffect(() => {
    document.documentElement.dataset.density = density;
    localStorage.setItem("atlas-density", density);
  }, [density]);

  return [density, () => setDensity((current) => (current === "compact" ? "comfortable" : "compact"))];
}

export function AppShell() {
  const { data } = useMe();
  const signOut = useSignOut();
  const location = useLocation();
  const [navOpen, setNavOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [theme, toggleTheme] = usePersistentTheme();
  const [density, toggleDensity] = usePersistentDensity();

  // Navigating closes the mobile drawer so it never covers the destination.
  useEffect(() => setNavOpen(false), [location.pathname]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen(true);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const actor = data?.actor;

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        Skip to main content
      </a>

      {navOpen ? (
        <div className="nav-scrim" onClick={() => setNavOpen(false)} aria-hidden="true" />
      ) : null}

      <nav className="app-nav" data-open={navOpen} aria-label="Primary">
        <div className="app-brand">
          <strong>Rangeway</strong>
          <span>Atlas</span>
        </div>

        <div>
          <p className="nav-section-label" id="nav-operate">
            Operate
          </p>
          <ul className="nav-list" aria-labelledby="nav-operate">
            {navigation.map((item) => (
              <li key={item.to}>
                <NavLink
                  to={item.to}
                  end={item.end}
                  className="nav-link"
                  aria-current={undefined}
                >
                  <item.icon aria-hidden="true" />
                  <span>{item.label}</span>
                </NavLink>
              </li>
            ))}
          </ul>
        </div>

        <div className="nav-footer">
          {actor ? (
            <div style={{ padding: "0 0.625rem" }}>
              <div style={{ fontWeight: 600 }}>{actor.actorName}</div>
              <div className="mono" style={{ color: "var(--text-muted)" }}>
                {actor.role}
              </div>
            </div>
          ) : null}
          <button type="button" className="button button--quiet" onClick={toggleTheme}>
            {theme === "dark" ? <Sun aria-hidden="true" /> : <Moon aria-hidden="true" />}
            <span>{theme === "dark" ? "Light theme" : "Dark theme"}</span>
          </button>
          <button type="button" className="button button--quiet" onClick={toggleDensity}>
            <Rows3 aria-hidden="true" />
            <span>{density === "compact" ? "Comfortable rows" : "Compact rows"}</span>
          </button>
          <button
            type="button"
            className="button button--quiet"
            onClick={() => signOut.mutate()}
            disabled={signOut.isPending}
          >
            <LogOut aria-hidden="true" />
            <span>Sign out</span>
          </button>
        </div>
      </nav>

      <div className="app-main">
        <div className="app-topbar">
          <button
            type="button"
            className="icon-button nav-toggle"
            onClick={() => setNavOpen((open) => !open)}
            aria-expanded={navOpen}
            aria-label={navOpen ? "Close navigation" : "Open navigation"}
          >
            <Menu aria-hidden="true" />
          </button>
          <button
            type="button"
            className="button"
            onClick={() => setPaletteOpen(true)}
            style={{ flex: "0 1 22rem", justifyContent: "flex-start", color: "var(--text-muted)" }}
          >
            <Search aria-hidden="true" />
            <span>Search Atlas</span>
            <kbd className="mono" style={{ marginLeft: "auto" }}>
              ⌘K
            </kbd>
          </button>
        </div>

        <main className="app-content" id="main-content">
          <Outlet />
        </main>
      </div>

      {paletteOpen ? <CommandPalette onClose={() => setPaletteOpen(false)} /> : null}
      <ToastRegion />
    </div>
  );
}
