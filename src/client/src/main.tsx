import React, { FormEvent, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ArrowLeft,
  BriefcaseBusiness,
  CalendarClock,
  Check,
  Download,
  FileText,
  Link2,
  LogOut,
  PanelsTopLeft,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  Upload,
  UserRound,
  UsersRound,
  X as XIcon
} from "lucide-react";
import "./styles.css";

type User = { id: string; email: string; name: string; picture: string };
type Screen = "dashboard" | "contacts" | "projects" | "documents" | "tasks";

const contactStages = ["New", "Researching", "Intro Made", "Active Conversation", "Diligence", "Partnered", "On Hold", "Closed"];
const contactCategories = ["Hotel Operator", "Real Estate", "Landowner", "Utility", "Energy Partner", "Charging Partner", "Investor", "Public Agency", "Vendor", "Team", "Community", "Other"];
const locationStatuses = ["Scouting", "Outreach", "Discovery", "Site Control", "Utility Study", "Design", "Permitting", "Capital Stack", "Pre-Construction", "Construction", "Live", "Paused", "Closed"];
const formats = ["Trailhead", "Waystation", "Basecamp", "Summit", "Other"];
const siteFits = ["Unknown", "Quiet Corridor", "Regional Route", "High-Traffic Run", "Destination Stay"];
const landStatuses = ["Unknown", "Identified", "Owner Contacted", "LOI", "Under Control", "Not Viable"];
const utilityStatuses = ["Unknown", "Needs Review", "Interconnect Requested", "Utility Study", "Upgrade Required", "Ready", "Off-Grid Path"];
const powerStrategies = ["Grid", "Grid + Storage", "Solar + Storage", "Off-Grid", "Partner-Funded Infrastructure", "Unknown"];
const hospitalityScopes = ["Restrooms Nearby", "Staffed Cafe", "Clubhouse + Lookouts", "Partner Amenity", "Unknown"];
const riskLevels = ["Low", "Medium", "High", "Blocked"];
const documentCategories = ["Site Diligence", "Land Control", "Utility", "Design", "Permitting", "Capital", "Partner", "Operations", "General"];
const documentPhases = ["Scouting", "Discovery", "Site Control", "Design", "Permitting", "Capital Stack", "Construction", "Operations", "General"];
const activityTypes = ["Note", "Call", "Meeting", "Email", "Site Visit", "Decision", "Risk", "Milestone"];

type Activity = {
  id: string;
  subjectType: "contact" | "project";
  subjectId: string;
  activityType: string;
  body: string;
  createdByUserId: string | null;
  createdByName?: string;
  createdByEmail?: string;
  createdAt: string;
};

type Contact = {
  id: string;
  name: string;
  company: string;
  role: string;
  email: string;
  phone: string;
  location: string;
  stage: string;
  category: string;
  notes: string;
  projectCount?: number;
  documentCount?: number;
  relationship?: string;
  relationshipNotes?: string;
  projects?: Project[];
  documents?: DocumentRecord[];
  tasks?: Task[];
  activities?: Activity[];
};

type Project = {
  id: string;
  name: string;
  format: string;
  status: string;
  priority: string;
  location: string;
  owner: string;
  targetDate: string;
  estimatedValue: number | null;
  corridor: string;
  siteFit: string;
  landStatus: string;
  utilityStatus: string;
  powerStrategy: string;
  hospitalityScope: string;
  nextMilestone: string;
  riskLevel: string;
  notes: string;
  contactCount?: number;
  documentCount?: number;
  taskCount?: number;
  relationship?: string;
  relationshipNotes?: string;
  contacts?: Contact[];
  documents?: DocumentRecord[];
  tasks?: Task[];
  activities?: Activity[];
};

type DocumentRecord = {
  id: string;
  originalName: string;
  mimeType: string;
  size: number;
  notes: string;
  documentCategory: string;
  phase: string;
  uploadedAt: string;
  contactCount?: number;
  projectCount?: number;
};

type Task = {
  id: string;
  title: string;
  status: string;
  priority: string;
  dueDate: string;
  contactId: string | null;
  projectId: string | null;
  contactName?: string;
  projectName?: string;
  assignedToUserId: string | null;
  assignedToName?: string;
  assignedToEmail?: string;
  notes: string;
};

type Dashboard = {
  totals: { contacts: number; projects: number; documents: number; openTasks: number; activePursuits: number; highRisk: number };
  projectStatus: { status: string; count: number }[];
  formatMix: { format: string; count: number }[];
  upcomingTasks: Task[];
  recentDocuments: DocumentRecord[];
};

const emptyContact = {
  name: "",
  company: "",
  role: "",
  email: "",
  phone: "",
  location: "",
  stage: "New",
  category: "Real Estate",
  notes: ""
};

const emptyProject = {
  name: "",
  format: "Waystation",
  status: "Scouting",
  priority: "Medium",
  location: "",
  owner: "",
  targetDate: "",
  estimatedValue: null as number | null,
  corridor: "",
  siteFit: "Unknown",
  landStatus: "Unknown",
  utilityStatus: "Unknown",
  powerStrategy: "Unknown",
  hospitalityScope: "Unknown",
  nextMilestone: "",
  riskLevel: "Medium",
  notes: ""
};

const emptyTask = {
  title: "",
  status: "Open",
  priority: "Medium",
  dueDate: "",
  contactId: null as string | null,
  projectId: null as string | null,
  assignedToUserId: null as string | null,
  notes: ""
};

class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function api<T>(path: string, options: RequestInit = {}) {
  const response = await fetch(path, {
    credentials: "include",
    headers: options.body instanceof FormData ? undefined : { "Content-Type": "application/json" },
    ...options
  });
  const text = await response.text();
  const data = text ? (JSON.parse(text) as T & { error?: string }) : ({} as T & { error?: string });
  if (!response.ok) {
    if (response.status === 401 && path !== "/api/me" && path !== "/api/login") {
      window.dispatchEvent(new CustomEvent("atlas:unauthorized"));
    }
    throw new ApiError(data.error || "Request failed", response.status);
  }
  return data;
}

function money(value: number | null | undefined) {
  if (!value) return "";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(value);
}

function fileSize(size: number) {
  if (size < 1024 * 1024) return `${Math.max(1, Math.round(size / 1024))} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

const projectStatusVariant: Record<string, "sage" | "warm" | "charcoal" | "muted" | "alert"> = {
  Scouting: "sage",
  Outreach: "sage",
  Discovery: "sage",
  "Site Control": "warm",
  "Utility Study": "warm",
  Design: "warm",
  Permitting: "warm",
  "Capital Stack": "warm",
  "Pre-Construction": "warm",
  Construction: "charcoal",
  Live: "charcoal",
  Paused: "muted",
  Closed: "muted"
};

const contactStageVariant: Record<string, "sage" | "warm" | "charcoal" | "muted" | "alert"> = {
  New: "muted",
  Researching: "muted",
  "Intro Made": "warm",
  "Active Conversation": "warm",
  Diligence: "warm",
  Partnered: "sage",
  "On Hold": "muted",
  Closed: "charcoal"
};

const activityVerb: Record<string, string> = {
  Note: "noted",
  Call: "called",
  Meeting: "met",
  Email: "emailed",
  "Site Visit": "visited",
  Decision: "decided",
  Risk: "flagged",
  Milestone: "reached"
};

function statusVariantClass(value: string, map: Record<string, string>) {
  return map[value] || "muted";
}

function dayKey(iso: string) {
  const date = new Date(iso);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).toISOString();
}

function formatDayLabel(iso: string) {
  const date = new Date(iso);
  const today = new Date();
  const dayMs = 24 * 60 * 60 * 1000;
  const diffDays = Math.round((new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime() - new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()) / dayMs);
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" }).toUpperCase();
}

function formatActivityTime(iso: string) {
  return new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function RangewayMark({ size = 38 }: { size?: number }) {
  const width = Math.round((size * 96) / 112);
  return (
    <svg width={width} height={size} viewBox="0 0 96 112" aria-hidden="true" focusable="false">
      <rect width="96" height="112" fill="#2D2D2D" rx="16" />
      <path
        d="M20 100 L20 16 C20 10 24 6 30 6 L56 6 C72 6 80 16 80 32 C80 46 72 54 58 56 L82 100"
        stroke="#F5F1EB"
        strokeWidth="10"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="58" cy="32" r="10" fill="#F4A855" />
    </svg>
  );
}

function App() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [screen, setScreen] = useState<Screen>("dashboard");
  const [contactSelectedId, setContactSelectedId] = useState<string | null>(null);
  const [projectSelectedId, setProjectSelectedId] = useState<string | null>(null);
  const [error, setError] = useState("");

  function navigate(target: Screen, recordId?: string | null) {
    if (target === "contacts") setContactSelectedId(recordId ?? null);
    else if (target === "projects") setProjectSelectedId(recordId ?? null);
    setScreen(target);
  }

  useEffect(() => {
    let cancelled = false;
    api<{ user: User | null }>("/api/me")
      .then((data) => {
        if (!cancelled) setUser(data.user);
      })
      .catch(() => {
        if (!cancelled) setUser(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    function handleUnauthorized() {
      setUser(null);
      setError("Your session has expired. Please sign in again.");
    }
    window.addEventListener("atlas:unauthorized", handleUnauthorized);
    return () => window.removeEventListener("atlas:unauthorized", handleUnauthorized);
  }, []);

  if (loading) return <div className="boot">Atlas</div>;

  if (!user) {
    return (
      <Login
        error={error}
        onLogin={async (email, password) => {
          setError("");
          try {
            const data = await api<{ user: User }>("/api/login", { method: "POST", body: JSON.stringify({ email, password }) });
            setUser(data.user);
          } catch (loginError) {
            setError(loginError instanceof Error ? loginError.message : "Unable to sign in");
          }
        }}
      />
    );
  }

  return (
    <Shell
      screen={screen}
      navigate={navigate}
      contactSelectedId={contactSelectedId}
      projectSelectedId={projectSelectedId}
      user={user}
      onLogout={async () => {
        await api("/api/logout", { method: "POST" });
        setUser(null);
      }}
    />
  );
}

function Login({ error, onLogin }: { error: string; onLogin: (email: string, password: string) => Promise<void> }) {
  const [email, setEmail] = useState("admin@rangeway.energy");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    await onLogin(email, password);
    setBusy(false);
  }

  return (
    <main className="loginPage">
      <section className="loginPanel">
        <div className="loginBrand">
          <strong>Rangeway</strong>
          <span>Atlas</span>
        </div>
        <h1>Sign in</h1>
        <a className="primaryButton googleButton" href="/api/auth/google">
          <UserRound size={16} /> Continue with Google
        </a>
        {error && !showPassword && <p className="error" style={{ marginTop: 12 }}>{error}</p>}
        {!showPassword && (
          <button type="button" className="passwordToggle" onClick={() => setShowPassword(true)}>
            Sign in with email instead
          </button>
        )}
        {showPassword && (
          <form onSubmit={submit} className="stack" style={{ marginTop: 14 }}>
            <label>
              Email
              <input value={email} onChange={(event) => setEmail(event.target.value)} type="email" autoComplete="username" required />
            </label>
            <label>
              Password
              <input value={password} onChange={(event) => setPassword(event.target.value)} type="password" autoComplete="current-password" required />
            </label>
            {error && <p className="error">{error}</p>}
            <button className="primaryButton" disabled={busy}>
              {busy ? <RefreshCw className="spin" size={16} /> : <Check size={16} />} Sign in
            </button>
          </form>
        )}
      </section>
    </main>
  );
}

function Shell({
  screen,
  navigate,
  contactSelectedId,
  projectSelectedId,
  user,
  onLogout
}: {
  screen: Screen;
  navigate: (screen: Screen, recordId?: string | null) => void;
  contactSelectedId: string | null;
  projectSelectedId: string | null;
  user: User;
  onLogout: () => void;
}) {
  const nav = [
    ["dashboard", PanelsTopLeft, "Dashboard"],
    ["contacts", UsersRound, "Stakeholders"],
    ["projects", BriefcaseBusiness, "Locations"],
    ["documents", FileText, "Diligence"],
    ["tasks", CalendarClock, "Next Steps"]
  ] as const;

  return (
    <div className="appShell">
      <aside className="sidebar">
        <button type="button" className="sidebarBrand" onClick={() => navigate("dashboard")} aria-label="Go to Command Center">
          <RangewayMark size={40} />
          <strong>Rangeway</strong>
          <span>Atlas</span>
        </button>
        <nav>
          {nav.map(([id, Icon, label]) => (
            <button key={id} className={screen === id ? "active" : ""} onClick={() => navigate(id)}>
              <Icon size={18} /> {label}
            </button>
          ))}
        </nav>
        <div className="sidebarFoot">
          <span>{user.name || user.email}</span>
          <button title="Sign out" onClick={onLogout}>
            <LogOut size={17} />
          </button>
        </div>
      </aside>
      <main className="workspace">
        {screen === "dashboard" && <DashboardView />}
        {screen === "contacts" && (
          <ContactsView
            selectedId={contactSelectedId}
            onSelect={(id) => navigate("contacts", id)}
            navigate={navigate}
          />
        )}
        {screen === "projects" && (
          <ProjectsView
            selectedId={projectSelectedId}
            onSelect={(id) => navigate("projects", id)}
            navigate={navigate}
          />
        )}
        {screen === "documents" && <DocumentsView />}
        {screen === "tasks" && <TasksView user={user} />}
      </main>
    </div>
  );
}

function useCrmData() {
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [documents, setDocuments] = useState<DocumentRecord[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");

  async function refresh() {
    setBusy(true);
    setError("");
    try {
      const [contactData, projectData, taskData, documentData, userData] = await Promise.all([
        api<{ contacts: Contact[] }>("/api/contacts"),
        api<{ projects: Project[] }>("/api/projects"),
        api<{ tasks: Task[] }>("/api/tasks"),
        api<{ documents: DocumentRecord[] }>("/api/documents"),
        api<{ users: User[] }>("/api/users")
      ]);
      setContacts(contactData.contacts);
      setProjects(projectData.projects);
      setTasks(taskData.tasks);
      setDocuments(documentData.documents);
      setUsers(userData.users);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Unable to load Atlas data");
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    setBusy(true);
    setError("");
    Promise.all([
      api<{ contacts: Contact[] }>("/api/contacts"),
      api<{ projects: Project[] }>("/api/projects"),
      api<{ tasks: Task[] }>("/api/tasks"),
      api<{ documents: DocumentRecord[] }>("/api/documents"),
      api<{ users: User[] }>("/api/users")
    ])
      .then(([contactData, projectData, taskData, documentData, userData]) => {
        if (cancelled) return;
        setContacts(contactData.contacts);
        setProjects(projectData.projects);
        setTasks(taskData.tasks);
        setDocuments(documentData.documents);
        setUsers(userData.users);
      })
      .catch((loadError) => {
        if (cancelled) return;
        setError(loadError instanceof Error ? loadError.message : "Unable to load Atlas data");
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return { contacts, projects, tasks, documents, users, busy, error, refresh };
}

function DashboardView() {
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    api<Dashboard>("/api/dashboard")
      .then((data) => {
        if (!cancelled) setDashboard(data);
      })
      .catch((loadError) => {
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : "Unable to load dashboard");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) return <Notice type="error">{error}</Notice>;
  if (!dashboard) return <Notice>Loading dashboard</Notice>;

  return (
    <section className="view">
      <Header
        eyebrow="Network Development"
        title="Command Center"
        subhead="Active site pursuits, early-stage development, risk, and what's coming up next across the Rangeway network."
      />
      <div className="metricGrid">
        <Metric label="Site Pursuits" value={dashboard.totals.projects} />
        <Metric label="Active Early-Stage" value={dashboard.totals.activePursuits} />
        <Metric label="Stakeholders" value={dashboard.totals.contacts} />
        <Metric label="High-Risk Items" value={dashboard.totals.highRisk} />
      </div>
      <div className="splitGrid">
        <Panel title="Development Phase">
          <div className="statusRows">
            {dashboard.projectStatus.length === 0 && <Empty label="No location pursuits yet" />}
            {dashboard.projectStatus.map((row) => (
              <div key={row.status} className="statusRow">
                <span>{row.status}</span>
                <strong>{row.count}</strong>
              </div>
            ))}
          </div>
        </Panel>
        <Panel title="Format Mix">
          <div className="statusRows">
            {dashboard.formatMix.length === 0 && <Empty label="No formats selected yet" />}
            {dashboard.formatMix.map((row) => (
              <div key={row.format} className="statusRow">
                <span>{row.format}</span>
                <strong>{row.count}</strong>
              </div>
            ))}
          </div>
        </Panel>
      </div>
      <div className="splitGrid">
        <Panel title="Next Steps">
          <TaskList tasks={dashboard.upcomingTasks} compact />
        </Panel>
        <Panel title="Recent Diligence">
          <DocumentList documents={dashboard.recentDocuments} />
        </Panel>
      </div>
    </section>
  );
}

function ContactsView({
  selectedId,
  onSelect,
  navigate
}: {
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  navigate: (screen: Screen, recordId?: string | null) => void;
}) {
  const { contacts, projects, busy, error, refresh } = useCrmData();
  const [query, setQuery] = useState("");
  const [stageFilter, setStageFilter] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("");
  const [selected, setSelected] = useState<Contact | null>(null);
  const [form, setForm] = useState(emptyContact);
  const [editForm, setEditForm] = useState(emptyContact);
  const [link, setLink] = useState({ projectId: "", relationship: "Stakeholder", notes: "" });

  const filtered = useMemo(() => {
    const needle = query.toLowerCase();
    return contacts.filter((contact) => {
      const matchesQuery = [contact.name, contact.company, contact.email, contact.location, contact.category, contact.stage].join(" ").toLowerCase().includes(needle);
      const matchesStage = !stageFilter || contact.stage === stageFilter;
      const matchesCategory = !categoryFilter || contact.category === categoryFilter;
      return matchesQuery && matchesStage && matchesCategory;
    });
  }, [contacts, query, stageFilter, categoryFilter]);

  useEffect(() => {
    if (!selectedId) {
      setSelected(null);
      return;
    }
    let cancelled = false;
    api<{ contact: Contact }>(`/api/contacts/${selectedId}`).then((data) => {
      if (cancelled) return;
      setSelected(data.contact);
      setEditForm({
        name: data.contact.name,
        company: data.contact.company,
        role: data.contact.role,
        email: data.contact.email,
        phone: data.contact.phone,
        location: data.contact.location,
        stage: contactStages.includes(data.contact.stage) ? data.contact.stage : "New",
        category: contactCategories.includes(data.contact.category) ? data.contact.category : "Real Estate",
        notes: data.contact.notes
      });
    });
    return () => {
      cancelled = true;
    };
  }, [selectedId, contacts]);

  async function saveContact(event: FormEvent) {
    event.preventDefault();
    await api("/api/contacts", { method: "POST", body: JSON.stringify(form) });
    setForm(emptyContact);
    await refresh();
  }

  async function updateContact(event: FormEvent) {
    event.preventDefault();
    if (!selected) return;
    const data = await api<{ contact: Contact }>(`/api/contacts/${selected.id}`, { method: "PATCH", body: JSON.stringify(editForm) });
    setSelected(data.contact);
    await refresh();
  }

  async function deleteContact() {
    if (!selected) return;
    if (!window.confirm(`Delete stakeholder "${selected.name}"? This permanently removes their record, links, and activity history.`)) return;
    await api(`/api/contacts/${selected.id}`, { method: "DELETE" });
    onSelect(null);
    setSelected(null);
    await refresh();
  }

  async function linkProject(event: FormEvent) {
    event.preventDefault();
    if (!selected || !link.projectId) return;
    await api(`/api/contacts/${selected.id}/projects`, { method: "POST", body: JSON.stringify(link) });
    setLink({ projectId: "", relationship: "Stakeholder", notes: "" });
    const data = await api<{ contact: Contact }>(`/api/contacts/${selected.id}`);
    setSelected(data.contact);
    await refresh();
  }

  async function addContactActivity(activity: { activityType: string; body: string }) {
    if (!selected) return;
    const data = await api<{ activities: Activity[] }>(`/api/contacts/${selected.id}/activities`, { method: "POST", body: JSON.stringify(activity) });
    setSelected({ ...selected, activities: data.activities });
  }

  if (selected) {
    return (
      <ContactDetail
        contact={selected}
        form={editForm}
        setForm={setEditForm}
        onSubmit={updateContact}
        onDelete={deleteContact}
        onBack={() => onSelect(null)}
        projects={projects}
        link={link}
        setLink={setLink}
        onLinkProject={linkProject}
        onAddActivity={addContactActivity}
        onOpenProject={(id) => navigate("projects", id)}
      />
    );
  }

  return (
    <section className="view">
      <Header
        eyebrow="Relationship Map"
        title="Stakeholders"
        subhead="People and organizations who can unlock, fund, power, permit, build, operate, or support a Rangeway site."
      />
      {error && <Notice type="error">{error}</Notice>}
      <div className="twoColumn">
        <Panel
          title="Stakeholder Directory"
          action={
            <div className="toolbar">
              <a className="textButton" href="/api/export/contacts.csv"><Download size={15} /> Export</a>
              <SearchBox value={query} onChange={setQuery} />
            </div>
          }
        >
          <div className="filterBar">
            <select value={stageFilter} onChange={(event) => setStageFilter(event.target.value)}>
              <option value="">All stages</option>
              {contactStages.map((option) => <option key={option}>{option}</option>)}
            </select>
            <select value={categoryFilter} onChange={(event) => setCategoryFilter(event.target.value)}>
              <option value="">All types</option>
              {contactCategories.map((option) => <option key={option}>{option}</option>)}
            </select>
          </div>
          {busy && <Notice>Loading stakeholders</Notice>}
          <div className="recordList">
            {filtered.map((contact) => (
              <button key={contact.id} className="record" onClick={() => onSelect(contact.id)}>
                <span className="recordIcon"><UserRound size={17} /></span>
                <span className="recordBody">
                  <span className="recordEyebrow">{contact.category}</span>
                  <strong>{contact.name}</strong>
                  <small>{[contact.company, contact.role, contact.location].filter(Boolean).join(" · ") || "—"}</small>
                </span>
                <span className="statusPill" data-variant={statusVariantClass(contact.stage, contactStageVariant)}>{contact.stage}</span>
              </button>
            ))}
            {!busy && filtered.length === 0 && <Empty label="No stakeholders found" />}
          </div>
        </Panel>
        <Panel title="New Stakeholder">
          <ContactForm form={form} setForm={setForm} onSubmit={saveContact} buttonLabel="Add Stakeholder" />
        </Panel>
      </div>
    </section>
  );
}

function ProjectsView({
  selectedId,
  onSelect,
  navigate
}: {
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  navigate: (screen: Screen, recordId?: string | null) => void;
}) {
  const { contacts, projects, busy, error, refresh } = useCrmData();
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [formatFilter, setFormatFilter] = useState("");
  const [riskFilter, setRiskFilter] = useState("");
  const [selected, setSelected] = useState<Project | null>(null);
  const [form, setForm] = useState(emptyProject);
  const [editForm, setEditForm] = useState(emptyProject);
  const [link, setLink] = useState({ contactId: "", relationship: "Stakeholder", notes: "" });

  const filtered = useMemo(() => {
    const needle = query.toLowerCase();
    return projects.filter((project) => {
      const matchesQuery = [project.name, project.status, project.location, project.owner, project.corridor, project.siteFit, project.landStatus, project.utilityStatus].join(" ").toLowerCase().includes(needle);
      const matchesStatus = !statusFilter || project.status === statusFilter;
      const matchesFormat = !formatFilter || project.format === formatFilter;
      const matchesRisk = !riskFilter || project.riskLevel === riskFilter;
      return matchesQuery && matchesStatus && matchesFormat && matchesRisk;
    });
  }, [projects, query, statusFilter, formatFilter, riskFilter]);

  useEffect(() => {
    if (!selectedId) {
      setSelected(null);
      return;
    }
    let cancelled = false;
    api<{ project: Project }>(`/api/projects/${selectedId}`).then((data) => {
      if (cancelled) return;
      setSelected(data.project);
      setEditForm({
        name: data.project.name,
        format: data.project.format,
        status: locationStatuses.includes(data.project.status) ? data.project.status : "Scouting",
        priority: data.project.priority,
        location: data.project.location,
        owner: data.project.owner,
        targetDate: data.project.targetDate,
        estimatedValue: data.project.estimatedValue,
        corridor: data.project.corridor || "",
        siteFit: data.project.siteFit || "Unknown",
        landStatus: data.project.landStatus || "Unknown",
        utilityStatus: data.project.utilityStatus || "Unknown",
        powerStrategy: data.project.powerStrategy || "Unknown",
        hospitalityScope: data.project.hospitalityScope || "Unknown",
        nextMilestone: data.project.nextMilestone || "",
        riskLevel: data.project.riskLevel || "Medium",
        notes: data.project.notes
      });
    });
    return () => {
      cancelled = true;
    };
  }, [selectedId, projects]);

  async function saveProject(event: FormEvent) {
    event.preventDefault();
    await api("/api/projects", { method: "POST", body: JSON.stringify(form) });
    setForm(emptyProject);
    await refresh();
  }

  async function updateProject(event: FormEvent) {
    event.preventDefault();
    if (!selected) return;
    const data = await api<{ project: Project }>(`/api/projects/${selected.id}`, { method: "PATCH", body: JSON.stringify(editForm) });
    setSelected(data.project);
    await refresh();
  }

  async function deleteProject() {
    if (!selected) return;
    if (!window.confirm(`Delete location pursuit "${selected.name}"? This permanently removes the project, links, and activity history.`)) return;
    await api(`/api/projects/${selected.id}`, { method: "DELETE" });
    onSelect(null);
    setSelected(null);
    await refresh();
  }

  async function linkContact(event: FormEvent) {
    event.preventDefault();
    if (!selected || !link.contactId) return;
    await api(`/api/projects/${selected.id}/contacts`, { method: "POST", body: JSON.stringify(link) });
    setLink({ contactId: "", relationship: "Stakeholder", notes: "" });
    const data = await api<{ project: Project }>(`/api/projects/${selected.id}`);
    setSelected(data.project);
    await refresh();
  }

  async function addProjectActivity(activity: { activityType: string; body: string }) {
    if (!selected) return;
    const data = await api<{ activities: Activity[] }>(`/api/projects/${selected.id}/activities`, { method: "POST", body: JSON.stringify(activity) });
    setSelected({ ...selected, activities: data.activities });
  }

  if (selected) {
    return (
      <ProjectDetail
        project={selected}
        form={editForm}
        setForm={setEditForm}
        onSubmit={updateProject}
        onDelete={deleteProject}
        onBack={() => onSelect(null)}
        contacts={contacts}
        link={link}
        setLink={setLink}
        onLinkContact={linkContact}
        onAddActivity={addProjectActivity}
        onOpenContact={(id) => navigate("contacts", id)}
      />
    );
  }

  return (
    <section className="view">
      <Header
        eyebrow="Network Map"
        title="Location Pursuits"
        subhead="Prospective sites and corridors — format fit, development phase, land, utility, power, and risk."
      />
      {error && <Notice type="error">{error}</Notice>}
      <div className="twoColumn">
        <Panel
          title="Site Development Tracker"
          action={
            <div className="toolbar">
              <a className="textButton" href="/api/export/projects.csv"><Download size={15} /> Export</a>
              <SearchBox value={query} onChange={setQuery} />
            </div>
          }
        >
          <div className="filterBar">
            <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
              <option value="">All phases</option>
              {locationStatuses.map((option) => <option key={option}>{option}</option>)}
            </select>
            <select value={formatFilter} onChange={(event) => setFormatFilter(event.target.value)}>
              <option value="">All formats</option>
              {formats.map((option) => <option key={option}>{option}</option>)}
            </select>
            <select value={riskFilter} onChange={(event) => setRiskFilter(event.target.value)}>
              <option value="">All risk</option>
              {riskLevels.map((option) => <option key={option}>{option}</option>)}
            </select>
          </div>
          {busy && <Notice>Loading locations</Notice>}
          <div className="recordList">
            {filtered.map((project) => (
              <button key={project.id} className="record" onClick={() => onSelect(project.id)}>
                <span className="recordIcon"><BriefcaseBusiness size={17} /></span>
                <span className="recordBody">
                  <span className="recordEyebrow">{project.format}</span>
                  <strong>{project.name}</strong>
                  <small>{[project.corridor || project.location, project.siteFit].filter(Boolean).join(" · ") || "—"}</small>
                </span>
                <span className="statusPill" data-variant={statusVariantClass(project.status, projectStatusVariant)}>{project.status}</span>
              </button>
            ))}
            {!busy && filtered.length === 0 && <Empty label="No location pursuits found" />}
          </div>
        </Panel>
        <Panel title="New Location Pursuit">
          <ProjectForm form={form} setForm={setForm} onSubmit={saveProject} buttonLabel="Add Location" />
        </Panel>
      </div>
    </section>
  );
}

function DocumentsView() {
  const { contacts, projects, documents, busy, error, refresh } = useCrmData();
  const [file, setFile] = useState<File | null>(null);
  const [notes, setNotes] = useState("");
  const [documentCategory, setDocumentCategory] = useState("Site Diligence");
  const [phase, setPhase] = useState("Discovery");
  const [contactIds, setContactIds] = useState<string[]>([]);
  const [projectIds, setProjectIds] = useState<string[]>([]);

  async function uploadDocument(event: FormEvent) {
    event.preventDefault();
    if (!file) return;
    const body = new FormData();
    body.append("file", file);
    body.append("notes", notes);
    body.append("documentCategory", documentCategory);
    body.append("phase", phase);
    body.append("contactIds", JSON.stringify(contactIds));
    body.append("projectIds", JSON.stringify(projectIds));
    await api("/api/documents", { method: "POST", body });
    setFile(null);
    setNotes("");
    setDocumentCategory("Site Diligence");
    setPhase("Discovery");
    setContactIds([]);
    setProjectIds([]);
    await refresh();
  }

  async function deleteDocument(id: string) {
    const target = documents.find((doc) => doc.id === id);
    const name = target?.originalName ? `"${target.originalName}"` : "this diligence document";
    if (!window.confirm(`Delete ${name}? The file is removed from disk and cannot be recovered.`)) return;
    await api(`/api/documents/${id}`, { method: "DELETE" });
    await refresh();
  }

  return (
    <section className="view">
      <Header
        eyebrow="Diligence Room"
        title="Documents"
        subhead="Controlled storage for site, land, utility, design, permitting, capital, partner, and operations files."
      />
      {error && <Notice type="error">{error}</Notice>}
      <div className="twoColumn">
        <Panel title="Upload">
          <form className="stack" onSubmit={uploadDocument}>
            <label className="fileDrop">
              <Upload size={24} />
              <span>{file ? file.name : "Choose PDF, DOCX, or XLSX"}</span>
              <input type="file" accept=".pdf,.doc,.docx,.xls,.xlsx" onChange={(event) => setFile(event.target.files?.[0] || null)} />
            </label>
            <label>
              Notes
              <textarea value={notes} onChange={(event) => setNotes(event.target.value)} rows={3} />
            </label>
            <label>
              Document Type
              <select value={documentCategory} onChange={(event) => setDocumentCategory(event.target.value)}>
                {documentCategories.map((option) => <option key={option}>{option}</option>)}
              </select>
            </label>
            <label>
              Phase
              <select value={phase} onChange={(event) => setPhase(event.target.value)}>
                {documentPhases.map((option) => <option key={option}>{option}</option>)}
              </select>
            </label>
            <Picker label="Attach Stakeholders" values={contactIds} setValues={setContactIds} options={contacts.map((contact) => ({ id: contact.id, name: contact.name }))} />
            <Picker label="Attach Locations" values={projectIds} setValues={setProjectIds} options={projects.map((project) => ({ id: project.id, name: project.name }))} />
            <button className="primaryButton" disabled={!file}><Upload size={16} /> Upload</button>
          </form>
        </Panel>
        <Panel title="Diligence Library">
          {busy && <Notice>Loading diligence</Notice>}
          <DocumentList documents={documents} onDelete={deleteDocument} />
        </Panel>
      </div>
    </section>
  );
}

function TasksView({ user }: { user: User }) {
  const { contacts, projects, tasks, users, busy, error, refresh } = useCrmData();
  const [scope, setScope] = useState<"mine" | "all">("mine");
  const [form, setForm] = useState<typeof emptyTask>({ ...emptyTask, assignedToUserId: user.id });
  const visibleTasks = scope === "mine" ? tasks.filter((task) => task.assignedToUserId === user.id || task.assignedToEmail === user.email) : tasks;

  async function saveTask(event: FormEvent) {
    event.preventDefault();
    await api("/api/tasks", { method: "POST", body: JSON.stringify(form) });
    setForm({ ...emptyTask, assignedToUserId: user.id });
    await refresh();
  }

  async function completeTask(task: Task) {
    await api(`/api/tasks/${task.id}`, { method: "PATCH", body: JSON.stringify({ ...task, status: "Done" }) });
    await refresh();
  }

  async function deleteTask(id: string) {
    const target = tasks.find((task) => task.id === id);
    const title = target?.title ? `"${target.title}"` : "this next step";
    if (!window.confirm(`Delete ${title}?`)) return;
    await api(`/api/tasks/${id}`, { method: "DELETE" });
    await refresh();
  }

  return (
    <section className="view">
      <Header
        eyebrow="Follow Through"
        title="Next Steps"
        subhead="Practical follow-through — introductions, LOIs, utility screens, partner reviews, permitting items, and internal action items."
      />
      {error && <Notice type="error">{error}</Notice>}
      <div className="twoColumn">
        <Panel title="New Next Step">
          <form className="formGrid" onSubmit={saveTask}>
            <label className="wide">
              Title
              <input value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} required />
            </label>
            <label>
              Status
              <select value={form.status} onChange={(event) => setForm({ ...form, status: event.target.value })}>
                {["Open", "In Progress", "Waiting", "Done"].map((option) => <option key={option}>{option}</option>)}
              </select>
            </label>
            <label>
              Priority
              <select value={form.priority} onChange={(event) => setForm({ ...form, priority: event.target.value })}>
                {["Low", "Medium", "High", "Critical"].map((option) => <option key={option}>{option}</option>)}
              </select>
            </label>
            <label>
              Due
              <input type="date" value={form.dueDate} onChange={(event) => setForm({ ...form, dueDate: event.target.value })} />
            </label>
            <label>
              Stakeholder
              <select value={form.contactId || ""} onChange={(event) => setForm({ ...form, contactId: event.target.value || null })}>
                <option value="">None</option>
                {contacts.map((contact) => <option key={contact.id} value={contact.id}>{contact.name}</option>)}
              </select>
            </label>
            <label>
              Location
              <select value={form.projectId || ""} onChange={(event) => setForm({ ...form, projectId: event.target.value || null })}>
                <option value="">None</option>
                {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
              </select>
            </label>
            <label>
              Owner
              <select value={form.assignedToUserId || ""} onChange={(event) => setForm({ ...form, assignedToUserId: event.target.value || null })}>
                <option value="">Unassigned</option>
                {users.map((atlasUser) => <option key={atlasUser.id} value={atlasUser.id}>{atlasUser.name || atlasUser.email}</option>)}
              </select>
            </label>
            <label className="wide">
              Notes
              <textarea value={form.notes} onChange={(event) => setForm({ ...form, notes: event.target.value })} rows={3} />
            </label>
            <button className="primaryButton wide"><Plus size={16} /> Add Next Step</button>
          </form>
        </Panel>
        <Panel
          title="Next Step List"
          action={
            <div className="toolbar">
              <a className="textButton" href="/api/export/tasks.csv"><Download size={15} /> Export</a>
              <div className="segmented">
                <button className={scope === "mine" ? "active" : ""} onClick={() => setScope("mine")}>Mine</button>
                <button className={scope === "all" ? "active" : ""} onClick={() => setScope("all")}>All</button>
              </div>
            </div>
          }
        >
          {busy && <Notice>Loading next steps</Notice>}
          <TaskList tasks={visibleTasks} onComplete={completeTask} onDelete={deleteTask} />
        </Panel>
      </div>
    </section>
  );
}

function ContactForm({ form, setForm, onSubmit, buttonLabel }: { form: typeof emptyContact; setForm: (form: typeof emptyContact) => void; onSubmit: (event: FormEvent) => void; buttonLabel: string }) {
  return (
    <form className="formGrid" onSubmit={onSubmit}>
      <label className="wide">Name<input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} required /></label>
      <label>Company<input value={form.company} onChange={(event) => setForm({ ...form, company: event.target.value })} /></label>
      <label>Role<input value={form.role} onChange={(event) => setForm({ ...form, role: event.target.value })} /></label>
      <label>Email<input type="email" value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} /></label>
      <label>Phone<input value={form.phone} onChange={(event) => setForm({ ...form, phone: event.target.value })} /></label>
      <label>Location<input value={form.location} onChange={(event) => setForm({ ...form, location: event.target.value })} /></label>
      <label>Relationship Stage<select value={form.stage} onChange={(event) => setForm({ ...form, stage: event.target.value })}>{contactStages.map((option) => <option key={option}>{option}</option>)}</select></label>
      <label>Stakeholder Type<select value={form.category} onChange={(event) => setForm({ ...form, category: event.target.value })}>{contactCategories.map((option) => <option key={option}>{option}</option>)}</select></label>
      <label className="wide">Notes<textarea value={form.notes} onChange={(event) => setForm({ ...form, notes: event.target.value })} rows={3} /></label>
      <button className="primaryButton wide">{buttonLabel.startsWith("Save") ? <Check size={16} /> : <Plus size={16} />} {buttonLabel}</button>
    </form>
  );
}

function ProjectForm({ form, setForm, onSubmit, buttonLabel }: { form: typeof emptyProject; setForm: (form: typeof emptyProject) => void; onSubmit: (event: FormEvent) => void; buttonLabel: string }) {
  return (
    <form onSubmit={onSubmit}>
      <fieldset className="formGrid">
        <legend>Site</legend>
        <label className="wide">Location or Corridor Name<input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} required /></label>
        <label>Format Fit<select value={form.format} onChange={(event) => setForm({ ...form, format: event.target.value })}>{formats.map((option) => <option key={option}>{option}</option>)}</select></label>
        <label>Owner<input value={form.owner} onChange={(event) => setForm({ ...form, owner: event.target.value })} /></label>
        <label>Location<input value={form.location} onChange={(event) => setForm({ ...form, location: event.target.value })} /></label>
        <label>Corridor<input value={form.corridor} onChange={(event) => setForm({ ...form, corridor: event.target.value })} placeholder="I-15, Highway 101, etc." /></label>
        <label className="wide">Road Context<select value={form.siteFit} onChange={(event) => setForm({ ...form, siteFit: event.target.value })}>{siteFits.map((option) => <option key={option}>{option}</option>)}</select></label>
      </fieldset>
      <fieldset className="formGrid">
        <legend>Land &amp; Utility</legend>
        <label>Land Status<select value={form.landStatus} onChange={(event) => setForm({ ...form, landStatus: event.target.value })}>{landStatuses.map((option) => <option key={option}>{option}</option>)}</select></label>
        <label>Utility Status<select value={form.utilityStatus} onChange={(event) => setForm({ ...form, utilityStatus: event.target.value })}>{utilityStatuses.map((option) => <option key={option}>{option}</option>)}</select></label>
      </fieldset>
      <fieldset className="formGrid">
        <legend>Power &amp; Hospitality</legend>
        <label>Power Strategy<select value={form.powerStrategy} onChange={(event) => setForm({ ...form, powerStrategy: event.target.value })}>{powerStrategies.map((option) => <option key={option}>{option}</option>)}</select></label>
        <label>Hospitality Scope<select value={form.hospitalityScope} onChange={(event) => setForm({ ...form, hospitalityScope: event.target.value })}>{hospitalityScopes.map((option) => <option key={option}>{option}</option>)}</select></label>
      </fieldset>
      <fieldset className="formGrid">
        <legend>Risk &amp; Milestone</legend>
        <label>Development Phase<select value={form.status} onChange={(event) => setForm({ ...form, status: event.target.value })}>{locationStatuses.map((option) => <option key={option}>{option}</option>)}</select></label>
        <label>Priority<select value={form.priority} onChange={(event) => setForm({ ...form, priority: event.target.value })}>{["Low", "Medium", "High", "Critical"].map((option) => <option key={option}>{option}</option>)}</select></label>
        <label>Target<input type="date" value={form.targetDate} onChange={(event) => setForm({ ...form, targetDate: event.target.value })} /></label>
        <label>Value<input type="number" min="0" value={form.estimatedValue || ""} onChange={(event) => setForm({ ...form, estimatedValue: event.target.value ? Number(event.target.value) : null })} /></label>
        <label>Next Milestone<input value={form.nextMilestone} onChange={(event) => setForm({ ...form, nextMilestone: event.target.value })} placeholder="Owner intro, utility screen, LOI review" /></label>
        <label>Risk Level<select value={form.riskLevel} onChange={(event) => setForm({ ...form, riskLevel: event.target.value })}>{riskLevels.map((option) => <option key={option}>{option}</option>)}</select></label>
        <label className="wide">Notes<textarea value={form.notes} onChange={(event) => setForm({ ...form, notes: event.target.value })} rows={3} /></label>
      </fieldset>
      <button className="primaryButton wide">{buttonLabel.startsWith("Save") ? <Check size={16} /> : <Plus size={16} />} {buttonLabel}</button>
    </form>
  );
}

function DetailHeader({
  backLabel,
  onBack,
  eyebrow,
  title,
  caption,
  status,
  statusVariant,
  onDelete,
  onEdit,
  onCancel,
  editLabel,
  mode
}: {
  backLabel: string;
  onBack: () => void;
  eyebrow: string;
  title: string;
  caption?: string;
  status?: string;
  statusVariant?: string;
  onDelete?: () => void;
  onEdit?: () => void;
  onCancel?: () => void;
  editLabel?: string;
  mode?: "view" | "edit";
}) {
  return (
    <header className="detailHeader">
      <div className="detailHeaderTop">
        <button type="button" className="backButton" onClick={onBack}>
          <ArrowLeft size={15} /> {backLabel}
        </button>
        <div className="detailHeaderActions">
          {mode === "edit" && onCancel && (
            <button type="button" className="textButton" onClick={onCancel}>
              <XIcon size={14} /> Cancel
            </button>
          )}
          {mode !== "edit" && onEdit && (
            <button type="button" className="primaryButton" onClick={onEdit}>
              <Pencil size={15} /> {editLabel || "Edit"}
            </button>
          )}
          {mode !== "edit" && onDelete && (
            <button className="iconButton danger" title="Delete" onClick={onDelete}>
              <Trash2 size={16} />
            </button>
          )}
        </div>
      </div>
      <div className="detailHeaderBody">
        <span className="eyebrow">{eyebrow}</span>
        {status && <span className="statusPill" data-variant={statusVariant || "muted"}>{status}</span>}
      </div>
      <h1>{title}</h1>
      {caption && <p className="detailCaption">{caption}</p>}
    </header>
  );
}

type DataField = { label: string; value: React.ReactNode };
type DataSection = { heading: string; fields: DataField[] };

function isEmptyValue(value: React.ReactNode) {
  return value === null || value === undefined || value === "" || value === "Unknown";
}

function DataView({ sections, notes }: { sections: DataSection[]; notes?: string }) {
  return (
    <div className="dataView">
      {sections.map((section) => {
        const fields = section.fields.filter((field) => !isEmptyValue(field.value));
        if (fields.length === 0) return null;
        return (
          <div key={section.heading} className="dataSection">
            <h3 className="dataSectionHeading">{section.heading}</h3>
            <div className="dataFields">
              {fields.map((field) => (
                <div key={field.label} className="dataField">
                  <span className="dataLabel">{field.label}</span>
                  <span className="dataValue">{field.value}</span>
                </div>
              ))}
            </div>
          </div>
        );
      })}
      {notes && notes.trim() && (
        <div className="dataSection">
          <h3 className="dataSectionHeading">Notes</h3>
          <p className="dataNotes">{notes}</p>
        </div>
      )}
    </div>
  );
}

function formatDate(value: string) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function ContactDetail({
  contact,
  form,
  setForm,
  onSubmit,
  onDelete,
  onBack,
  projects,
  link,
  setLink,
  onLinkProject,
  onAddActivity,
  onOpenProject
}: {
  contact: Contact;
  form: typeof emptyContact;
  setForm: (form: typeof emptyContact) => void;
  onSubmit: (event: FormEvent) => void;
  onDelete: () => void;
  onBack: () => void;
  projects: Project[];
  link: { projectId: string; relationship: string; notes: string };
  setLink: (link: { projectId: string; relationship: string; notes: string }) => void;
  onLinkProject: (event: FormEvent) => void;
  onAddActivity: (activity: { activityType: string; body: string }) => Promise<void>;
  onOpenProject: (id: string) => void;
}) {
  const [mode, setMode] = useState<"view" | "edit">("view");
  const [snapshot, setSnapshot] = useState(form);

  useEffect(() => {
    setMode("view");
  }, [contact.id]);

  useEffect(() => {
    function handler(event: KeyboardEvent) {
      if (event.key === "Escape") {
        if (mode === "edit") {
          setForm(snapshot);
          setMode("view");
        } else {
          onBack();
        }
      }
    }
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onBack, mode, snapshot, setForm]);

  function startEdit() {
    setSnapshot(form);
    setMode("edit");
  }

  function cancelEdit() {
    setForm(snapshot);
    setMode("view");
  }

  async function handleSubmit(event: FormEvent) {
    await onSubmit(event);
    setMode("view");
  }

  const caption = [contact.company, contact.role, contact.location].filter(Boolean).join(" · ");

  const sections: DataSection[] = [
    {
      heading: "Identity",
      fields: [
        { label: "Company", value: contact.company },
        { label: "Role", value: contact.role }
      ]
    },
    {
      heading: "Contact",
      fields: [
        { label: "Email", value: contact.email ? <a href={`mailto:${contact.email}`}>{contact.email}</a> : "" },
        { label: "Phone", value: contact.phone ? <a href={`tel:${contact.phone}`}>{contact.phone}</a> : "" },
        { label: "Location", value: contact.location }
      ]
    },
    {
      heading: "Classification",
      fields: [
        { label: "Type", value: contact.category },
        { label: "Stage", value: contact.stage }
      ]
    }
  ];

  return (
    <section className="view detailPage">
      <DetailHeader
        backLabel="Back to Stakeholders"
        onBack={onBack}
        eyebrow={contact.category}
        title={contact.name}
        caption={caption || undefined}
        status={contact.stage}
        statusVariant={statusVariantClass(contact.stage, contactStageVariant)}
        mode={mode}
        onEdit={startEdit}
        onCancel={cancelEdit}
        editLabel="Edit Stakeholder"
        onDelete={onDelete}
      />
      <Panel title="Details">
        {mode === "edit" ? (
          <ContactForm form={form} setForm={setForm} onSubmit={handleSubmit} buttonLabel="Save Stakeholder" />
        ) : (
          <DataView sections={sections} notes={contact.notes} />
        )}
      </Panel>
      <Panel title="Related Locations">
        <RelatedRecordList
          items={(contact.projects || []).map((project) => ({
            id: project.id,
            name: project.name,
            eyebrow: project.relationship || undefined,
            caption: [project.format, project.corridor || project.location].filter(Boolean).join(" · ") || undefined,
            status: project.status,
            statusVariant: statusVariantClass(project.status, projectStatusVariant)
          }))}
          empty="No related locations"
          onOpen={onOpenProject}
        />
        <form className="inlineForm" onSubmit={onLinkProject}>
          <select value={link.projectId} onChange={(event) => setLink({ ...link, projectId: event.target.value })}>
            <option value="">Location</option>
            {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
          </select>
          <input value={link.relationship} onChange={(event) => setLink({ ...link, relationship: event.target.value })} placeholder="Relationship" />
          <button className="iconButton" title="Link location"><Link2 size={17} /></button>
        </form>
      </Panel>
      <Panel title="Diligence">
        <DocumentList documents={contact.documents || []} />
      </Panel>
      <Panel title="Activity">
        <ActivityPanel activities={contact.activities || []} onAdd={onAddActivity} />
      </Panel>
    </section>
  );
}

function ProjectDetail({
  project,
  form,
  setForm,
  onSubmit,
  onDelete,
  onBack,
  contacts,
  link,
  setLink,
  onLinkContact,
  onAddActivity,
  onOpenContact
}: {
  project: Project;
  form: typeof emptyProject;
  setForm: (form: typeof emptyProject) => void;
  onSubmit: (event: FormEvent) => void;
  onDelete: () => void;
  onBack: () => void;
  contacts: Contact[];
  link: { contactId: string; relationship: string; notes: string };
  setLink: (link: { contactId: string; relationship: string; notes: string }) => void;
  onLinkContact: (event: FormEvent) => void;
  onAddActivity: (activity: { activityType: string; body: string }) => Promise<void>;
  onOpenContact: (id: string) => void;
}) {
  const [mode, setMode] = useState<"view" | "edit">("view");
  const [snapshot, setSnapshot] = useState(form);

  useEffect(() => {
    setMode("view");
  }, [project.id]);

  useEffect(() => {
    function handler(event: KeyboardEvent) {
      if (event.key === "Escape") {
        if (mode === "edit") {
          setForm(snapshot);
          setMode("view");
        } else {
          onBack();
        }
      }
    }
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onBack, mode, snapshot, setForm]);

  function startEdit() {
    setSnapshot(form);
    setMode("edit");
  }

  function cancelEdit() {
    setForm(snapshot);
    setMode("view");
  }

  async function handleSubmit(event: FormEvent) {
    await onSubmit(event);
    setMode("view");
  }

  const caption = [project.corridor || project.location, project.siteFit].filter(Boolean).join(" · ");

  const sections: DataSection[] = [
    {
      heading: "Site",
      fields: [
        { label: "Format", value: project.format },
        { label: "Owner", value: project.owner },
        { label: "Location", value: project.location },
        { label: "Corridor", value: project.corridor },
        { label: "Road Context", value: project.siteFit }
      ]
    },
    {
      heading: "Land & Utility",
      fields: [
        { label: "Land Status", value: project.landStatus },
        { label: "Utility Status", value: project.utilityStatus }
      ]
    },
    {
      heading: "Power & Hospitality",
      fields: [
        { label: "Power Strategy", value: project.powerStrategy },
        { label: "Hospitality Scope", value: project.hospitalityScope }
      ]
    },
    {
      heading: "Risk & Milestone",
      fields: [
        { label: "Phase", value: project.status },
        { label: "Priority", value: project.priority },
        { label: "Target Date", value: formatDate(project.targetDate) },
        { label: "Estimated Value", value: money(project.estimatedValue) },
        { label: "Next Milestone", value: project.nextMilestone },
        { label: "Risk Level", value: project.riskLevel }
      ]
    }
  ];

  return (
    <section className="view detailPage">
      <DetailHeader
        backLabel="Back to Location Pursuits"
        onBack={onBack}
        eyebrow={project.format}
        title={project.name}
        caption={caption || undefined}
        status={project.status}
        statusVariant={statusVariantClass(project.status, projectStatusVariant)}
        mode={mode}
        onEdit={startEdit}
        onCancel={cancelEdit}
        editLabel="Edit Location"
        onDelete={onDelete}
      />
      <Panel title="Details">
        {mode === "edit" ? (
          <ProjectForm form={form} setForm={setForm} onSubmit={handleSubmit} buttonLabel="Save Location" />
        ) : (
          <DataView sections={sections} notes={project.notes} />
        )}
      </Panel>
      <div className="splitGrid detailRelated">
        <Panel title="Stakeholders">
          <RelatedRecordList
            items={(project.contacts || []).map((contact) => ({
              id: contact.id,
              name: contact.name,
              eyebrow: contact.relationship || undefined,
              caption: [contact.category, contact.company, contact.role].filter(Boolean).join(" · ") || undefined,
              status: contact.stage,
              statusVariant: statusVariantClass(contact.stage, contactStageVariant)
            }))}
            empty="No related stakeholders"
            onOpen={onOpenContact}
          />
          <form className="inlineForm" onSubmit={onLinkContact}>
            <select value={link.contactId} onChange={(event) => setLink({ ...link, contactId: event.target.value })}>
              <option value="">Stakeholder</option>
              {contacts.map((contact) => <option key={contact.id} value={contact.id}>{contact.name}</option>)}
            </select>
            <input value={link.relationship} onChange={(event) => setLink({ ...link, relationship: event.target.value })} placeholder="Relationship" />
            <button className="iconButton" title="Link stakeholder"><Link2 size={17} /></button>
          </form>
        </Panel>
        <Panel title="Next Steps">
          <TaskList tasks={project.tasks || []} compact />
        </Panel>
      </div>
      <Panel title="Diligence">
        <DocumentList documents={project.documents || []} />
      </Panel>
      <Panel title="Activity">
        <ActivityPanel activities={project.activities || []} onAdd={onAddActivity} />
      </Panel>
    </section>
  );
}

function Header({ eyebrow, title, subhead }: { eyebrow: string; title: string; subhead?: string }) {
  return (
    <header className="viewHeader">
      <span>{eyebrow}</span>
      <h1>{title}</h1>
      {subhead && <p className="viewSubhead">{subhead}</p>}
    </header>
  );
}

function Panel({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="panel">
      <div className="panelHead">
        <h2>{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="metric">
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

function SearchBox({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return (
    <label className="searchBox">
      <Search size={16} />
      <input value={value} onChange={(event) => onChange(event.target.value)} placeholder="Search" />
    </label>
  );
}

function Picker({ label, values, setValues, options }: { label: string; values: string[]; setValues: (values: string[]) => void; options: { id: string; name: string }[] }) {
  return (
    <label>
      {label}
      <select
        value=""
        onChange={(event) => {
          const value = event.target.value;
          if (value && !values.includes(value)) setValues([...values, value]);
        }}
      >
        <option value="">Select</option>
        {options.map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}
      </select>
      <div className="chips">
        {values.map((id) => {
          const option = options.find((item) => item.id === id);
          return (
            <button type="button" key={id} onClick={() => setValues(values.filter((value) => value !== id))}>
              {option?.name || id}
            </button>
          );
        })}
      </div>
    </label>
  );
}

function ActivityPanel({ activities, onAdd }: { activities: Activity[]; onAdd: (activity: { activityType: string; body: string }) => Promise<void> }) {
  const [activityType, setActivityType] = useState("Note");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!body.trim()) return;
    setBusy(true);
    await onAdd({ activityType, body });
    setBody("");
    setActivityType("Note");
    setBusy(false);
  }

  const grouped = useMemo(() => {
    const buckets = new Map<string, Activity[]>();
    for (const activity of activities) {
      const key = dayKey(activity.createdAt);
      const list = buckets.get(key) || [];
      list.push(activity);
      buckets.set(key, list);
    }
    return Array.from(buckets.entries()).map(([key, items]) => ({ key, items }));
  }, [activities]);

  return (
    <div className="activityPanel">
      <form className="activityForm" onSubmit={submit}>
        <select value={activityType} onChange={(event) => setActivityType(event.target.value)}>
          {activityTypes.map((option) => <option key={option}>{option}</option>)}
        </select>
        <textarea value={body} onChange={(event) => setBody(event.target.value)} rows={3} placeholder="Add the latest context, decision, risk, or follow-up." />
        <button className="primaryButton" disabled={busy || !body.trim()}><Plus size={16} /> Add Activity</button>
      </form>
      <div className="activityList">
        {grouped.length === 0 && <Empty label="No activity yet" />}
        {grouped.map((day) => (
          <div key={day.key} className="activityDay">
            <div className="activityDayLabel">{formatDayLabel(day.key)}</div>
            <div className="activityDayItems">
              {day.items.map((activity) => {
                const verb = activityVerb[activity.activityType] || activity.activityType.toLowerCase();
                const who = activity.createdByName || activity.createdByEmail || "Someone";
                return (
                  <article key={activity.id} className="activityItem">
                    <div className="activityMeta">
                      {who} <em>{verb}</em> · {formatActivityTime(activity.createdAt)}
                    </div>
                    <p>{activity.body}</p>
                  </article>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function MiniList({ items, empty }: { items: string[]; empty: string }) {
  if (items.length === 0) return <Empty label={empty} />;
  return <ul className="miniList">{items.map((item) => <li key={item}>{item}</li>)}</ul>;
}

type RelatedRow = {
  id: string;
  name: string;
  eyebrow?: string;
  caption?: string;
  status?: string;
  statusVariant?: string;
};

function RelatedRecordList({ items, empty, onOpen }: { items: RelatedRow[]; empty: string; onOpen: (id: string) => void }) {
  if (items.length === 0) return <Empty label={empty} />;
  return (
    <div className="relatedList">
      {items.map((row) => (
        <button key={row.id} type="button" className="relatedRow" onClick={() => onOpen(row.id)}>
          <span className="relatedBody">
            {row.eyebrow && <span className="relatedEyebrow">{row.eyebrow}</span>}
            <strong>{row.name}</strong>
            {row.caption && <small>{row.caption}</small>}
          </span>
          {row.status && (
            <span className="statusPill" data-variant={row.statusVariant || "muted"}>{row.status}</span>
          )}
          <span className="relatedChevron" aria-hidden="true">→</span>
        </button>
      ))}
    </div>
  );
}

function DocumentList({ documents, onDelete }: { documents: DocumentRecord[]; onDelete?: (id: string) => void }) {
  if (documents.length === 0) return <Empty label="No diligence documents" />;
  return (
    <div className="documentList">
      {documents.map((document) => (
        <div key={document.id} className="documentRow">
          <FileText size={18} />
          <div>
            <strong>{document.originalName}</strong>
            <small>{[document.documentCategory, document.phase, fileSize(document.size), new Date(document.uploadedAt).toLocaleDateString()].filter(Boolean).join(" · ")}</small>
          </div>
          <a className="iconButton" title="Download" href={`/documents/${document.id}/download`}><Download size={16} /></a>
          {onDelete && <button className="iconButton danger" title="Delete" onClick={() => onDelete(document.id)}><Trash2 size={16} /></button>}
        </div>
      ))}
    </div>
  );
}

function TaskList({ tasks, compact, onComplete, onDelete }: { tasks: Task[]; compact?: boolean; onComplete?: (task: Task) => void; onDelete?: (id: string) => void }) {
  if (tasks.length === 0) return <Empty label="No next steps" />;
  return (
    <div className={compact ? "taskList compact" : "taskList"}>
      {tasks.map((task) => (
        <div key={task.id} className={`taskRow ${task.status === "Done" ? "done" : ""}`}>
          <span className="statusDot" data-priority={task.priority} />
          <div>
            <strong>{task.title}</strong>
            <small>{[task.status, task.dueDate, task.projectName || task.contactName, task.assignedToName].filter(Boolean).join(" · ")}</small>
          </div>
          {onComplete && task.status !== "Done" && <button className="iconButton" title="Complete" onClick={() => onComplete(task)}><Check size={16} /></button>}
          {onDelete && <button className="iconButton danger" title="Delete" onClick={() => onDelete(task.id)}><Trash2 size={16} /></button>}
        </div>
      ))}
    </div>
  );
}

function Empty({ label }: { label: string }) {
  return <div className="empty">{label}</div>;
}

function Notice({ children, type = "info" }: { children: React.ReactNode; type?: "info" | "error" }) {
  return <div className={`notice ${type}`}>{children}</div>;
}

createRoot(document.getElementById("root")!).render(<App />);
