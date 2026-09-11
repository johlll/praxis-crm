import { createServerSupabaseClient } from "@/server/supabase/server";
import type { Database } from "@/server/types/database";
import type { ACTIVITY_FILTERS } from "./schema";

export type ActivityFilter = (typeof ACTIVITY_FILTERS)[number];

export type ActivityType = Database["public"]["Enums"]["activity_type"];
export type ActivityStatus = Database["public"]["Enums"]["activity_status"];
export type ActivitySource = Database["public"]["Enums"]["activity_source"];
export type ActivityAssigneeRule = Database["public"]["Enums"]["activity_assignee_rule"];
export type ActivityPriority = Database["public"]["Enums"]["lead_priority"];

export type ActivityListItem = {
  id: string;
  leadId: string;
  opportunityId: string | null;
  contactName: string;
  legalArea: string;
  type: ActivityType;
  title: string;
  notes: string | null;
  assignedTo: string | null;
  assignedToName: string | null;
  priority: ActivityPriority;
  dueAt: string;
  hasTime: boolean;
  status: ActivityStatus;
  completedAt: string | null;
  source: ActivitySource;
  lockVersion: number;
  createdAt: string;
  updatedAt: string;
  /**
   * Calculado aqui, no servidor, no momento da busca — nunca com
   * `Date.now()` durante a renderização do Client Component (efeito
   * colateral impuro proibido pelo lint `react-hooks/purity`, além de
   * arriscar divergir do relógio real do servidor). Congelado como
   * qualquer outro dado da página: só muda numa nova busca (reload/
   * revalidação), mesmo comportamento do resto da tela.
   */
  isOverdue: boolean;
};

export type ActivityCounts = {
  overdue: number;
  today: number;
  tomorrow: number;
  week: number;
  unassigned: number;
};

const EMPTY_COUNTS: ActivityCounts = { overdue: 0, today: 0, tomorrow: 0, week: 0, unassigned: 0 };

function mapActivityRow(row: Record<string, unknown>): ActivityListItem {
  const status = row.status as ActivityStatus;
  const dueAt = row.due_at as string;
  return {
    id: row.id as string,
    leadId: row.lead_id as string,
    opportunityId: (row.opportunity_id as string | null) ?? null,
    contactName: row.contact_name as string,
    legalArea: row.legal_area as string,
    type: row.type as ActivityType,
    title: row.title as string,
    notes: (row.notes as string | null) ?? null,
    assignedTo: (row.assigned_to as string | null) ?? null,
    assignedToName: (row.assigned_to_name as string | null) ?? null,
    priority: row.priority as ActivityPriority,
    dueAt,
    hasTime: row.has_time as boolean,
    status,
    completedAt: (row.completed_at as string | null) ?? null,
    source: row.source as ActivitySource,
    lockVersion: row.lock_version as number,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    isOverdue: status === "pending" && new Date(dueAt).getTime() < Date.now(),
  };
}

function mapCounts(raw: unknown): ActivityCounts {
  if (!raw || typeof raw !== "object") return EMPTY_COUNTS;
  const c = raw as Record<string, unknown>;
  return {
    overdue: (c.overdue as number) ?? 0,
    today: (c.today as number) ?? 0,
    tomorrow: (c.tomorrow as number) ?? 0,
    week: (c.week as number) ?? 0,
    unassigned: (c.unassigned as number) ?? 0,
  };
}

export async function listActivities(
  workspaceId: string,
  filters: {
    filter?: ActivityFilter | undefined;
    leadId?: string | undefined;
    opportunityId?: string | undefined;
    /** "all" pede pendentes + concluídas juntas (usado pela agenda semanal) — omitido, o RPC assume 'pending'. */
    status?: ActivityStatus | "all" | undefined;
    sort?: "due_at_asc" | "due_at_desc" | undefined;
    page?: number | undefined;
    pageSize?: number | undefined;
  } = {},
): Promise<{ items: ActivityListItem[]; total: number; page: number; pageSize: number; counts: ActivityCounts }> {
  const supabase = await createServerSupabaseClient();
  const page = Math.max(1, filters.page ?? 1);
  const pageSize = Math.max(1, Math.min(filters.pageSize ?? 20, 200));

  const { data, error } = await supabase.rpc("list_activities", {
    p_workspace_id: workspaceId,
    ...(filters.filter ? { p_filter: filters.filter } : {}),
    ...(filters.leadId ? { p_lead_id: filters.leadId } : {}),
    ...(filters.opportunityId ? { p_opportunity_id: filters.opportunityId } : {}),
    // "all" precisa mandar `null` de verdade pro RPC (bypassa o default
    // SQL 'pending') — o tipo gerado por `supabase gen types` não expressa
    // parâmetro nulável (só opcional/omitido), então o cast é só para o
    // TypeScript; o valor que trafega em runtime é o `null` real.
    p_status: (filters.status === "all" ? null : (filters.status ?? "pending")) as ActivityStatus,
    p_sort: filters.sort ?? "due_at_asc",
    p_page: page,
    p_page_size: pageSize,
  });

  if (error || !data || data.length === 0) {
    return { items: [], total: 0, page, pageSize, counts: EMPTY_COUNTS };
  }

  const row = data[0]!;
  const items = (row.items as unknown as Array<Record<string, unknown>> | null) ?? [];

  return {
    items: items.map(mapActivityRow),
    total: row.total_count,
    page,
    pageSize,
    counts: mapCounts(row.counts),
  };
}

/**
 * Busca TODAS as atividades que casam com o filtro, ignorando o teto de
 * página única do RPC (list_activities() limita p_page_size a 100 — ver
 * comentário na migration). Só aumentar o pageSize pedido não resolve:
 * qualquer teto fixo ainda pode ser ultrapassado por um workspace maior;
 * a Agenda semanal precisa mesmo de "todas as da semana", não de "até
 * N", então ela pagina até esgotar o total_count devolvido pelo próprio
 * RPC — nunca omite silenciosamente o que passar do primeiro lote.
 *
 * MAX_PAGES é só uma trava de segurança contra loop sem fim caso
 * total_count venha inconsistente; nunca esperado de fato bater nisso
 * (500 atividades numa mesma semana, mesmo workspace).
 */
const LIST_ALL_PAGE_SIZE = 100;
const LIST_ALL_MAX_PAGES = 50;

export async function listAllActivities(
  workspaceId: string,
  filters: Omit<Parameters<typeof listActivities>[1], "page" | "pageSize"> = {},
): Promise<{ items: ActivityListItem[]; total: number; counts: ActivityCounts }> {
  let items: ActivityListItem[] = [];
  let total = 0;
  let counts: ActivityCounts = EMPTY_COUNTS;

  for (let page = 1; page <= LIST_ALL_MAX_PAGES; page++) {
    const result = await listActivities(workspaceId, { ...filters, page, pageSize: LIST_ALL_PAGE_SIZE });
    if (page === 1) {
      total = result.total;
      counts = result.counts;
    }
    items = items.concat(result.items);
    if (result.items.length === 0 || items.length >= result.total) break;
  }

  return { items, total, counts };
}

export type ActivityDetail = ActivityListItem & { workspaceId: string };

export async function getActivity(activityId: string): Promise<ActivityDetail | null> {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("get_activity", { p_activity_id: activityId });
  if (error || !data) return null;

  const row = data as Record<string, unknown>;
  return { workspaceId: row.workspace_id as string, ...mapActivityRow(row) };
}

export async function getActivityCounts(workspaceId: string): Promise<ActivityCounts> {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("get_activity_counts", { p_workspace_id: workspaceId });
  if (error || !data) return EMPTY_COUNTS;
  return mapCounts(data);
}

export type NextAction = {
  id: string;
  type: ActivityType;
  title: string;
  dueAt: string;
  hasTime: boolean;
} | null;
