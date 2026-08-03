import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryOptions,
} from "@tanstack/react-query";
import { apiRequest, newIdempotencyKey, type Page, type QueryValue } from "./client.js";
import { publishMutationError, publishToast } from "../components/toast.js";
import type {
  Actor,
  Counterparty,
  Person,
  PortfolioProject,
  Project,
  ProjectContext,
  SearchResult,
  TodayBriefing,
  WorkItem,
  WorkItemStatus,
} from "./types.js";

/**
 * Query keys are structured so a mutation can invalidate every projection of a
 * record at once. Board, list, calendar, Today, portfolio and the Project Room
 * all read from `work`-prefixed keys, so one invalidation keeps them consistent.
 */
export const keys = {
  me: ["me"] as const,
  projects: (filters?: unknown) => ["projects", filters ?? null] as const,
  project: (id: string) => ["project", id] as const,
  projectContext: (id: string) => ["project", id, "context"] as const,
  work: (filters?: unknown) => ["work", filters ?? null] as const,
  workItem: (id: string) => ["work", "item", id] as const,
  today: (date?: string) => ["today", date ?? null] as const,
  portfolio: (filters?: unknown) => ["portfolio", filters ?? null] as const,
  portfolioHealth: ["portfolio", "health"] as const,
  people: (filters?: unknown) => ["people", filters ?? null] as const,
  counterparties: (filters?: unknown) => ["counterparties", filters ?? null] as const,
  search: (query: string, types?: string) => ["search", query, types ?? null] as const,
};

type Filters = Record<string, QueryValue>;

export function useMe() {
  return useQuery({
    queryKey: keys.me,
    queryFn: () => apiRequest<{ actor: Actor }>("/me"),
    retry: false,
    staleTime: 60_000,
  });
}

export function useProjects(filters: Filters = {}) {
  return useQuery({
    queryKey: keys.projects(filters),
    queryFn: () =>
      apiRequest<{ projects: Project[]; page: Page }>("/projects", { query: filters }),
  });
}

export function useProject(projectId: string | undefined) {
  return useQuery({
    queryKey: keys.project(projectId ?? ""),
    queryFn: () => apiRequest<{ project: Project }>(`/projects/${projectId}`),
    enabled: Boolean(projectId),
  });
}

export function useProjectContext(projectId: string | undefined) {
  return useQuery({
    queryKey: keys.projectContext(projectId ?? ""),
    queryFn: () => apiRequest<ProjectContext>(`/projects/${projectId}/context-bundle`),
    enabled: Boolean(projectId),
  });
}

/**
 * One work query serves the board, list and calendar. The projections differ
 * only in presentation, so they never diverge into separate stores.
 */
export function useWork(filters: Filters = {}, options?: Partial<UseQueryOptions<{ items: WorkItem[]; page: Page }>>) {
  return useQuery({
    queryKey: keys.work(filters),
    queryFn: () => apiRequest<{ items: WorkItem[]; page: Page }>("/work-items", { query: filters }),
    ...options,
  });
}

export function useToday(date?: string) {
  return useQuery({
    queryKey: keys.today(date),
    queryFn: () => apiRequest<TodayBriefing>("/today", { query: date ? { date } : undefined }),
  });
}

export function usePortfolio(filters: Filters = {}) {
  return useQuery({
    queryKey: keys.portfolio(filters),
    queryFn: () =>
      apiRequest<{ projects: PortfolioProject[]; page: Page }>("/portfolio", { query: filters }),
  });
}

export function usePortfolioHealth() {
  return useQuery({
    queryKey: keys.portfolioHealth,
    queryFn: () =>
      apiRequest<{ health: Array<{ health: string; projectCount: number }> }>("/portfolio/health"),
  });
}

export function usePeople(filters: Filters = {}) {
  return useQuery({
    queryKey: keys.people(filters),
    queryFn: () => apiRequest<{ people: Person[]; page: Page }>("/people", { query: filters }),
  });
}

export function useCounterparties(filters: Filters = {}) {
  return useQuery({
    queryKey: keys.counterparties(filters),
    queryFn: () =>
      apiRequest<{ counterparties: Counterparty[]; page: Page }>("/counterparties", {
        query: filters,
      }),
  });
}

export function useSearch(query: string, types?: string) {
  return useQuery({
    queryKey: keys.search(query, types),
    queryFn: () =>
      apiRequest<{ results: SearchResult[]; page: Page }>("/search", {
        query: { q: query, types },
      }),
    enabled: query.trim().length >= 2,
    staleTime: 15_000,
  });
}

/** Everything a work record appears in, invalidated together. */
function invalidateWorkSurfaces(client: ReturnType<typeof useQueryClient>, projectId?: string) {
  void client.invalidateQueries({ queryKey: ["work"] });
  void client.invalidateQueries({ queryKey: ["today"] });
  void client.invalidateQueries({ queryKey: ["portfolio"] });
  if (projectId) void client.invalidateQueries({ queryKey: keys.projectContext(projectId) });
}

export interface MoveWorkInput {
  workItemId: string;
  status: WorkItemStatus;
  position: number;
  projectId?: string;
}

/**
 * Board and list movement applies immediately and restores the previous state
 * if the server rejects it, so a failed move never leaves a card in a lane the
 * server does not agree with.
 */
export function useMoveWorkItem() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: MoveWorkInput) =>
      apiRequest<{ workItem: WorkItem }>(`/work-items/${input.workItemId}/move`, {
        method: "POST",
        body: { status: input.status, position: input.position },
        idempotencyKey: newIdempotencyKey("work-move"),
      }),
    onMutate: async (input) => {
      await client.cancelQueries({ queryKey: ["work"] });
      const snapshot = client.getQueriesData<{ items: WorkItem[]; page: Page }>({
        queryKey: ["work"],
      });
      for (const [queryKey, data] of snapshot) {
        if (!data?.items) continue;
        client.setQueryData(queryKey, {
          ...data,
          items: data.items.map((item) =>
            item.id === input.workItemId ? { ...item, status: input.status } : item,
          ),
        });
      }
      return { snapshot };
    },
    onError: (error, _input, context) => {
      for (const [queryKey, data] of context?.snapshot ?? []) {
        client.setQueryData(queryKey, data);
      }
      // The card visibly snaps back, so the reason must be stated rather than
      // left for the user to infer from a reverting UI.
      publishMutationError(error, "That move was rejected. The previous status has been restored.");
    },
    onSuccess: (result) =>
      publishToast(`Moved “${result.workItem.title}” to ${result.workItem.status.replace("_", " ")}.`),
    onSettled: (_data, _error, input) => invalidateWorkSurfaces(client, input.projectId),
  });
}

export interface CreateWorkInput {
  projectId: string;
  title: string;
  type: WorkItem["type"];
  status: WorkItemStatus;
  priority: WorkItem["priority"];
  description?: string;
  ownerUserId?: string | null;
  dueAt?: string | null;
  position?: number;
}

export function useCreateWorkItem() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateWorkInput) =>
      apiRequest<{ workItem: WorkItem }>("/work-items", {
        method: "POST",
        body: {
          projectId: input.projectId,
          title: input.title,
          type: input.type,
          status: input.status,
          priority: input.priority,
          description: input.description ?? "",
          ownerUserId: input.ownerUserId ?? undefined,
          dueAt: input.dueAt ?? undefined,
          position: input.position ?? 1000,
          labelIds: [],
        },
        idempotencyKey: newIdempotencyKey("work-create"),
      }),
    onSuccess: (_result, input) => invalidateWorkSurfaces(client, input.projectId),
  });
}

export function useUpdateWorkItem() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ workItemId, ...patch }: { workItemId: string } & Partial<WorkItem>) =>
      apiRequest<{ workItem: WorkItem }>(`/work-items/${workItemId}`, {
        method: "PATCH",
        body: patch,
        idempotencyKey: newIdempotencyKey("work-update"),
      }),
    onSuccess: (result) => invalidateWorkSurfaces(client, result.workItem.projectId),
    onError: (error) => publishMutationError(error, "That change was not saved."),
  });
}

export interface CreateProjectInput {
  name: string;
  objective: string;
  ownerUserId: string;
  templateType: string;
  status: Project["status"];
  priority: Project["priority"];
  strategicArea: string;
}

export function useCreateProject() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateProjectInput) =>
      apiRequest<{ project: Project }>("/projects", {
        method: "POST",
        body: input,
        idempotencyKey: newIdempotencyKey("project-create"),
      }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["projects"] });
      void client.invalidateQueries({ queryKey: ["portfolio"] });
    },
  });
}

export function useUpdateProject() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ projectId, ...patch }: { projectId: string } & Partial<Project>) =>
      apiRequest<{ project: Project }>(`/projects/${projectId}`, {
        method: "PATCH",
        body: patch,
        idempotencyKey: newIdempotencyKey("project-update"),
      }),
    onSuccess: (result) => {
      void client.invalidateQueries({ queryKey: ["projects"] });
      void client.invalidateQueries({ queryKey: ["portfolio"] });
      void client.invalidateQueries({ queryKey: keys.project(result.project.id) });
      void client.invalidateQueries({ queryKey: keys.projectContext(result.project.id) });
    },
  });
}

export interface SavedView {
  id: string;
  name: string;
  surface: string;
  filters: Record<string, string>;
  isDefault: boolean;
}

export function useSavedViews(surface: string) {
  return useQuery({
    queryKey: ["saved-views", surface],
    queryFn: () =>
      apiRequest<{ savedViews: SavedView[]; page: Page }>("/saved-views", { query: { surface } }),
  });
}

export function useCreateSavedView() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { name: string; surface: string; filters: Record<string, string> }) =>
      apiRequest<{ savedView: SavedView }>("/saved-views", {
        method: "POST",
        body: { ...input, isDefault: false },
        idempotencyKey: newIdempotencyKey("saved-view-create"),
      }),
    onSuccess: (_result, input) => {
      void client.invalidateQueries({ queryKey: ["saved-views", input.surface] });
      publishToast(`Saved view “${input.name}”.`);
    },
    onError: (error) => publishMutationError(error, "That view could not be saved."),
  });
}

export function useArchiveSavedView() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { savedViewId: string; surface: string }) =>
      apiRequest<unknown>(`/saved-views/${input.savedViewId}/archive`, {
        method: "POST",
        body: { archived: true },
        idempotencyKey: newIdempotencyKey("saved-view-archive"),
      }),
    onSuccess: (_result, input) => {
      void client.invalidateQueries({ queryKey: ["saved-views", input.surface] });
      publishToast("Saved view removed.");
    },
    onError: (error) => publishMutationError(error, "That view could not be removed."),
  });
}

/** Applies one status change across a selection, reporting partial failures. */
export function useBulkMoveWorkItems() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (input: { ids: string[]; status: WorkItemStatus; items: WorkItem[] }) => {
      const outcomes = await Promise.allSettled(
        input.ids.map((id) => {
          const item = input.items.find((candidate) => candidate.id === id);
          return apiRequest<{ workItem: WorkItem }>(`/work-items/${id}/move`, {
            method: "POST",
            body: { status: input.status, position: Number(item?.position) || 1000 },
            idempotencyKey: newIdempotencyKey("work-bulk-move"),
          });
        }),
      );
      return {
        moved: outcomes.filter((outcome) => outcome.status === "fulfilled").length,
        rejected: outcomes.filter((outcome) => outcome.status === "rejected").length,
      };
    },
    onSuccess: ({ moved, rejected }) => {
      publishToast(
        rejected === 0
          ? `Moved ${moved} item${moved === 1 ? "" : "s"}.`
          : `Moved ${moved}; ${rejected} rejected because the transition is not allowed.`,
        rejected === 0 ? "info" : "error",
      );
    },
    onSettled: () => invalidateWorkSurfaces(client),
  });
}

export function useAddHealthUpdate() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { projectId: string; health: string; rationale: string }) =>
      apiRequest<unknown>(`/projects/${input.projectId}/health-updates`, {
        method: "POST",
        body: { health: input.health, rationale: input.rationale },
        idempotencyKey: newIdempotencyKey("health-add"),
      }),
    onSuccess: (_result, input) => {
      void client.invalidateQueries({ queryKey: keys.projectContext(input.projectId) });
      void client.invalidateQueries({ queryKey: ["projects"] });
      void client.invalidateQueries({ queryKey: ["portfolio"] });
      void client.invalidateQueries({ queryKey: ["today"] });
      publishToast("Health update recorded.");
    },
    onError: (error) => publishMutationError(error, "That health update was not recorded."),
  });
}

export function useSignIn() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { email: string; password: string }) =>
      apiRequest<{ actor: Actor }>("/auth/local/login", { method: "POST", body: input }),
    onSuccess: () => client.invalidateQueries(),
  });
}

export function useSignOut() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => apiRequest<void>("/auth/logout", { method: "POST" }),
    onSuccess: () => client.clear(),
  });
}
