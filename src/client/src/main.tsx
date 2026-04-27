import React, { FormEvent, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  BriefcaseBusiness,
  CalendarClock,
  Check,
  Download,
  FileText,
  Link2,
  LogOut,
  PanelsTopLeft,
  Paperclip,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  Upload,
  UserRound,
  UsersRound
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

function App() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [screen, setScreen] = useState<Screen>("dashboard");
  const [error, setError] = useState("");

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
      setScreen={setScreen}
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

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    await onLogin(email, password);
    setBusy(false);
  }

  return (
    <main className="loginPage">
      <section className="loginPanel">
        <div className="brandMark">R</div>
        <h1>Atlas</h1>
        <a className="primaryButton googleButton" href="/api/auth/google">
          <UserRound size={16} /> Sign in with Google
        </a>
        <div className="loginDivider">Development fallback</div>
        <form onSubmit={submit} className="stack">
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
      </section>
    </main>
  );
}

function Shell({ screen, setScreen, user, onLogout }: { screen: Screen; setScreen: (screen: Screen) => void; user: User; onLogout: () => void }) {
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
        <div className="sidebarBrand">
          <div className="brandMark">R</div>
          <div>
            <strong>Rangeway</strong>
            <span>Atlas</span>
          </div>
        </div>
        <nav>
          {nav.map(([id, Icon, label]) => (
            <button key={id} className={screen === id ? "active" : ""} onClick={() => setScreen(id)}>
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
        {screen === "contacts" && <ContactsView />}
        {screen === "projects" && <ProjectsView />}
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
      <Header eyebrow="Network Development" title="Rangeway command center" />
      <div className="metricGrid">
        <Metric label="Site pursuits" value={dashboard.totals.projects} icon={<BriefcaseBusiness size={18} />} />
        <Metric label="Active early-stage" value={dashboard.totals.activePursuits} icon={<PanelsTopLeft size={18} />} />
        <Metric label="Stakeholders" value={dashboard.totals.contacts} icon={<UsersRound size={18} />} />
        <Metric label="High-risk items" value={dashboard.totals.highRisk} icon={<Paperclip size={18} />} />
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

function ContactsView() {
  const { contacts, projects, busy, error, refresh } = useCrmData();
  const [query, setQuery] = useState("");
  const [stageFilter, setStageFilter] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
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
    setSelectedId(null);
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

  return (
    <section className="view">
      <Header eyebrow="Relationship Map" title="Stakeholders" />
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
              <button key={contact.id} className={selectedId === contact.id ? "record active" : "record"} onClick={() => setSelectedId(contact.id)}>
                <span className="recordIcon"><UserRound size={17} /></span>
                <span>
                  <strong>{contact.name}</strong>
                  <small>{[contact.company, contact.role].filter(Boolean).join(" · ") || contact.category}</small>
                </span>
                <em>{contact.stage}</em>
              </button>
            ))}
            {!busy && filtered.length === 0 && <Empty label="No stakeholders found" />}
          </div>
        </Panel>
        <div className="stack">
          <Panel title="New Stakeholder">
            <ContactForm form={form} setForm={setForm} onSubmit={saveContact} buttonLabel="Add Stakeholder" />
          </Panel>
          {selected && (
            <Panel title={selected.name} action={<button className="iconButton danger" title="Delete stakeholder" onClick={deleteContact}><Trash2 size={16} /></button>}>
              <ContactForm form={editForm} setForm={setEditForm} onSubmit={updateContact} buttonLabel="Save Stakeholder" />
              <h3>Related Locations</h3>
              <MiniList items={(selected.projects || []).map((project) => `${project.name} · ${project.relationship || project.status}`)} empty="No related locations" />
              <form className="inlineForm" onSubmit={linkProject}>
                <select value={link.projectId} onChange={(event) => setLink({ ...link, projectId: event.target.value })}>
                  <option value="">Location</option>
                  {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
                </select>
                <input value={link.relationship} onChange={(event) => setLink({ ...link, relationship: event.target.value })} placeholder="Relationship" />
                <button className="iconButton" title="Link location"><Link2 size={17} /></button>
              </form>
              <h3>Diligence</h3>
              <DocumentList documents={selected.documents || []} />
              <h3>Activity</h3>
              <ActivityPanel activities={selected.activities || []} onAdd={addContactActivity} />
            </Panel>
          )}
        </div>
      </div>
    </section>
  );
}

function ProjectsView() {
  const { contacts, projects, busy, error, refresh } = useCrmData();
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [formatFilter, setFormatFilter] = useState("");
  const [riskFilter, setRiskFilter] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
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
    setSelectedId(null);
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

  return (
    <section className="view">
      <Header eyebrow="Network Map" title="Location Pursuits" />
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
              <button key={project.id} className={selectedId === project.id ? "record active" : "record"} onClick={() => setSelectedId(project.id)}>
                <span className="recordIcon"><BriefcaseBusiness size={17} /></span>
                <span>
                  <strong>{project.name}</strong>
                  <small>{[project.format, project.corridor || project.location, project.siteFit].filter(Boolean).join(" · ")}</small>
                </span>
                <em>{project.status}</em>
              </button>
            ))}
            {!busy && filtered.length === 0 && <Empty label="No location pursuits found" />}
          </div>
        </Panel>
        <div className="stack">
          <Panel title="New Location Pursuit">
            <ProjectForm form={form} setForm={setForm} onSubmit={saveProject} buttonLabel="Add Location" />
          </Panel>
          {selected && (
            <Panel title={selected.name} action={<button className="iconButton danger" title="Delete location" onClick={deleteProject}><Trash2 size={16} /></button>}>
              <ProjectForm form={editForm} setForm={setEditForm} onSubmit={updateProject} buttonLabel="Save Location" />
              {money(selected.estimatedValue) && <p className="notes">Estimated value: {money(selected.estimatedValue)}</p>}
              <h3>Stakeholders</h3>
              <MiniList items={(selected.contacts || []).map((contact) => `${contact.name} · ${contact.relationship || contact.category}`)} empty="No related stakeholders" />
              <form className="inlineForm" onSubmit={linkContact}>
                <select value={link.contactId} onChange={(event) => setLink({ ...link, contactId: event.target.value })}>
                  <option value="">Stakeholder</option>
                  {contacts.map((contact) => <option key={contact.id} value={contact.id}>{contact.name}</option>)}
                </select>
                <input value={link.relationship} onChange={(event) => setLink({ ...link, relationship: event.target.value })} placeholder="Relationship" />
                <button className="iconButton" title="Link stakeholder"><Link2 size={17} /></button>
              </form>
              <h3>Next Steps</h3>
              <TaskList tasks={selected.tasks || []} compact />
              <h3>Diligence</h3>
              <DocumentList documents={selected.documents || []} />
              <h3>Activity</h3>
              <ActivityPanel activities={selected.activities || []} onAdd={addProjectActivity} />
            </Panel>
          )}
        </div>
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
      <Header eyebrow="Diligence Room" title="Documents" />
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
      <Header eyebrow="Follow Through" title="Next Steps" />
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
    <form className="formGrid" onSubmit={onSubmit}>
      <label className="wide">Location or Corridor Name<input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} required /></label>
      <label>Format Fit<select value={form.format} onChange={(event) => setForm({ ...form, format: event.target.value })}>{formats.map((option) => <option key={option}>{option}</option>)}</select></label>
      <label>Development Phase<select value={form.status} onChange={(event) => setForm({ ...form, status: event.target.value })}>{locationStatuses.map((option) => <option key={option}>{option}</option>)}</select></label>
      <label>Priority<select value={form.priority} onChange={(event) => setForm({ ...form, priority: event.target.value })}>{["Low", "Medium", "High", "Critical"].map((option) => <option key={option}>{option}</option>)}</select></label>
      <label>Owner<input value={form.owner} onChange={(event) => setForm({ ...form, owner: event.target.value })} /></label>
      <label>Location<input value={form.location} onChange={(event) => setForm({ ...form, location: event.target.value })} /></label>
      <label>Corridor<input value={form.corridor} onChange={(event) => setForm({ ...form, corridor: event.target.value })} placeholder="I-15, Highway 101, etc." /></label>
      <label>Road Context<select value={form.siteFit} onChange={(event) => setForm({ ...form, siteFit: event.target.value })}>{siteFits.map((option) => <option key={option}>{option}</option>)}</select></label>
      <label>Land Status<select value={form.landStatus} onChange={(event) => setForm({ ...form, landStatus: event.target.value })}>{landStatuses.map((option) => <option key={option}>{option}</option>)}</select></label>
      <label>Utility Status<select value={form.utilityStatus} onChange={(event) => setForm({ ...form, utilityStatus: event.target.value })}>{utilityStatuses.map((option) => <option key={option}>{option}</option>)}</select></label>
      <label>Power Strategy<select value={form.powerStrategy} onChange={(event) => setForm({ ...form, powerStrategy: event.target.value })}>{powerStrategies.map((option) => <option key={option}>{option}</option>)}</select></label>
      <label>Hospitality Scope<select value={form.hospitalityScope} onChange={(event) => setForm({ ...form, hospitalityScope: event.target.value })}>{hospitalityScopes.map((option) => <option key={option}>{option}</option>)}</select></label>
      <label>Target<input type="date" value={form.targetDate} onChange={(event) => setForm({ ...form, targetDate: event.target.value })} /></label>
      <label>Value<input type="number" min="0" value={form.estimatedValue || ""} onChange={(event) => setForm({ ...form, estimatedValue: event.target.value ? Number(event.target.value) : null })} /></label>
      <label>Next Milestone<input value={form.nextMilestone} onChange={(event) => setForm({ ...form, nextMilestone: event.target.value })} placeholder="Owner intro, utility screen, LOI review" /></label>
      <label>Risk Level<select value={form.riskLevel} onChange={(event) => setForm({ ...form, riskLevel: event.target.value })}>{riskLevels.map((option) => <option key={option}>{option}</option>)}</select></label>
      <label className="wide">Notes<textarea value={form.notes} onChange={(event) => setForm({ ...form, notes: event.target.value })} rows={3} /></label>
      <button className="primaryButton wide">{buttonLabel.startsWith("Save") ? <Check size={16} /> : <Plus size={16} />} {buttonLabel}</button>
    </form>
  );
}

function Header({ eyebrow, title }: { eyebrow: string; title: string }) {
  return (
    <header className="viewHeader">
      <span>{eyebrow}</span>
      <h1>{title}</h1>
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

function Metric({ label, value, icon }: { label: string; value: number; icon: React.ReactNode }) {
  return (
    <div className="metric">
      {icon}
      <span>{label}</span>
      <strong>{value}</strong>
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
        {activities.length === 0 && <Empty label="No activity yet" />}
        {activities.map((activity) => (
          <article key={activity.id} className="activityItem">
            <div>
              <strong>{activity.activityType}</strong>
              <small>{[activity.createdByName || activity.createdByEmail, new Date(activity.createdAt).toLocaleString()].filter(Boolean).join(" · ")}</small>
            </div>
            <p>{activity.body}</p>
          </article>
        ))}
      </div>
    </div>
  );
}

function MiniList({ items, empty }: { items: string[]; empty: string }) {
  if (items.length === 0) return <Empty label={empty} />;
  return <ul className="miniList">{items.map((item) => <li key={item}>{item}</li>)}</ul>;
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
