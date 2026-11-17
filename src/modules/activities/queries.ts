import { createServerSupabaseClient } from "@/server/supabase/server";
import { DataLoadError, isExpectedAbsence } from "@/server/data/load-error";
import type { Database } from "@/server/types/database";
import type { ACTIVITY_FILTERS } from "./schema";
import { attachCalendarInfo } from "@/modules/calendar/activity-links";
import { dayKeyOf } from "@/lib/calendar-month";
import type { ActivityCalendarInfo } from "@/modules/calendar/types";

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
  /** Estado do vínculo com o Google Agenda (só quando a integração está ligada e há vínculo). */
  calendar?: ActivityCalendarInfo | null | undefined;
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

type ListActivitiesFilters = {
  filter?: ActivityFilter | undefined;
  leadId?: string | undefined;
  opportunityId?: string | undefined;
  /** "all" pede pendentes + concluídas juntas (usado pela agenda semanal) — omitido, o RPC assume 'pending'. */
  status?: ActivityStatus | "all" | undefined;
  sort?: "due_at_asc" | "due_at_desc" | undefined;
  page: number;
  pageSize: number;
};

type ActivitiesPage = { items: ActivityListItem[]; total: number; counts: ActivityCounts };

/** Mesmo teto do RPC (list_activities limita p_page_size a 100) — pedir mais
 * faria `hasMore` mentir, porque o banco devolveria só 100. */
const MAX_PAGE_SIZE = 100;

/**
 * Erro de carregamento de atividades — subclasse do contrato comum
 * (src/server/data/load-error.ts), mantida para quem já a referencia.
 */
export class ActivitiesLoadError extends DataLoadError {
  constructor(resource: string, cause?: unknown) {
    super(resource, cause);
    this.name = "ActivitiesLoadError";
  }
}

/** Uma página do RPC. Falha sempre lança — nunca vira página vazia. */
async function fetchActivitiesPage(workspaceId: string, filters: ListActivitiesFilters): Promise<ActivitiesPage> {
  const supabase = await createServerSupabaseClient();

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
    p_page: filters.page,
    p_page_size: filters.pageSize,
  });

  if (error) throw new ActivitiesLoadError(`a página ${filters.page} de atividades do workspace ${workspaceId}`, error);
  if (!data || data.length === 0) return { items: [], total: 0, counts: EMPTY_COUNTS };

  const row = data[0]!;
  const items = (row.items as unknown as Array<Record<string, unknown>> | null) ?? [];

  return {
    items: await attachCalendarInfo(items.map(mapActivityRow)),
    total: row.total_count,
    counts: mapCounts(row.counts),
  };
}

/**
 * Uma página de atividades. Falha lança ActivitiesLoadError — nunca lista
 * vazia (que a tela mostraria como "nenhuma atividade") nem `hasMore: false`
 * (que encerraria a paginação em silêncio).
 */
export async function listActivities(
  workspaceId: string,
  filters: Omit<ListActivitiesFilters, "page" | "pageSize"> & { page?: number | undefined; pageSize?: number | undefined } = {},
): Promise<{
  items: ActivityListItem[];
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
  counts: ActivityCounts;
}> {
  const page = Math.max(1, filters.page ?? 1);
  const pageSize = Math.max(1, Math.min(filters.pageSize ?? 20, MAX_PAGE_SIZE));

  const result = await fetchActivitiesPage(workspaceId, { ...filters, page, pageSize });
  return { ...result, page, pageSize, hasMore: page * pageSize < result.total };
}

/**
 * Busca TODAS as atividades que casam com o filtro, ignorando o teto de
 * página única do RPC (list_activities() limita p_page_size a 100 — ver
 * comentário na migration). Só aumentar o pageSize pedido não resolve:
 * qualquer teto fixo ainda pode ser ultrapassado por um workspace maior;
 * a Agenda semanal precisa mesmo de "todas as da semana", não de "até
 * N", então ela pagina até esgotar o total_count devolvido pelo próprio
 * RPC.
 *
 * Nunca devolve sucesso com uma lista parcial: se qualquer página falhar,
 * ou se LIST_ALL_MAX_PAGES for atingido sem terminar de buscar tudo, joga
 * ActivitiesLoadError em vez de retornar o que já tinha acumulado — a
 * trava de segurança continua em 50 páginas (não é a solução aumentar
 * esse número; é nunca fingir que uma busca incompleta terminou).
 */
const LIST_ALL_PAGE_SIZE = MAX_PAGE_SIZE;
const LIST_ALL_MAX_PAGES = 50;

export async function listAllActivities(
  workspaceId: string,
  filters: Omit<ListActivitiesFilters, "page" | "pageSize"> = {},
): Promise<{ items: ActivityListItem[]; total: number; counts: ActivityCounts }> {
  let items: ActivityListItem[] = [];
  let total = 0;
  let counts: ActivityCounts = EMPTY_COUNTS;

  for (let page = 1; page <= LIST_ALL_MAX_PAGES; page++) {
    const result = await fetchActivitiesPage(workspaceId, { ...filters, page, pageSize: LIST_ALL_PAGE_SIZE });

    if (page === 1) {
      total = result.total;
      counts = result.counts;
    }
    items = items.concat(result.items);

    if (items.length >= total) return { items, total, counts };

    if (result.items.length === 0) {
      // O total dizia que ainda faltavam itens, mas a página veio vazia —
      // inconsistência real entre total_count e as linhas devolvidas.
      // Nunca presumir "acabou" aqui: sinaliza carregamento incompleto em
      // vez de devolver uma lista menor que o total como se fosse a
      // semana inteira.
      throw new ActivitiesLoadError(
        `a lista completa de atividades do workspace ${workspaceId} (página ${page} veio vazia com ${items.length}/${total})`,
      );
    }
  }

  throw new ActivitiesLoadError(
    `a lista completa de atividades do workspace ${workspaceId} (${items.length}/${total} após ${LIST_ALL_MAX_PAGES} páginas)`,
  );
}

export type ActivitiesInRange = {
  items: ActivityListItem[];
  total: number;
  /** {"YYYY-MM-DD": n} do intervalo inteiro, calculado no banco. */
  dayCounts: Record<string, number>;
};

function mapDayCounts(raw: unknown): Record<string, number> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, number> = {};
  for (const [day, n] of Object.entries(raw as Record<string, unknown>)) out[day] = Number(n);
  return out;
}

/**
 * TODAS as atividades (pendentes e concluídas) com prazo entre `from` e `to`
 * ("YYYY-MM-DD", inclusivos, no fuso do escritório), no alcance do usuário —
 * usada pela Agenda mensal. O banco recusa intervalos de mais de 42 dias.
 *
 * Pagina até esgotar o total (o RPC devolve no máximo 100 por página) e
 * nunca devolve sucesso parcial: falha de página, página vazia antes do fim,
 * teto de páginas atingido ou itens que não batem com a contagem por dia do
 * banco viram ActivitiesLoadError — a tela mostra erro, nunca "nenhuma
 * atividade" nem um mês pela metade.
 */
export async function listActivitiesInRange(
  workspaceId: string,
  range: { from: string; to: string },
): Promise<ActivitiesInRange> {
  const supabase = await createServerSupabaseClient();
  const resource = `as atividades de ${range.from} a ${range.to} do workspace ${workspaceId}`;
  let items: ActivityListItem[] = [];
  let total = 0;
  let dayCounts: Record<string, number> = {};

  for (let page = 1; page <= LIST_ALL_MAX_PAGES; page++) {
    const { data, error } = await supabase.rpc("list_activities_in_range", {
      p_workspace_id: workspaceId,
      p_from: range.from,
      p_to: range.to,
      p_page: page,
      p_page_size: LIST_ALL_PAGE_SIZE,
    });
    if (error) throw new ActivitiesLoadError(`${resource} (página ${page})`, error);
    const row = data?.[0];
    if (!row) throw new ActivitiesLoadError(`${resource} (página ${page} sem resposta)`);

    const pageItems = (row.items as unknown as Array<Record<string, unknown>> | null) ?? [];
    if (page === 1) {
      total = row.total_count;
      dayCounts = mapDayCounts(row.day_counts);
    }
    items = items.concat(await attachCalendarInfo(pageItems.map(mapActivityRow)));

    if (items.length >= total) break;
    if (pageItems.length === 0) throw new ActivitiesLoadError(`${resource} (página ${page} vazia com ${items.length}/${total})`);
    if (page === LIST_ALL_MAX_PAGES) throw new ActivitiesLoadError(`${resource} (${items.length}/${total} após ${page} páginas)`);
  }

  // Coerência entre as páginas e a contagem do banco (uma escrita entre uma
  // página e outra pode desalinhar): na dúvida, erro — nunca números que não batem.
  const seen: Record<string, number> = {};
  for (const item of items) {
    const day = dayKeyOf(item.dueAt);
    seen[day] = (seen[day] ?? 0) + 1;
  }
  const countedTotal = Object.values(dayCounts).reduce((sum, n) => sum + n, 0);
  const consistent =
    items.length === total &&
    countedTotal === total &&
    new Set(items.map((item) => item.id)).size === items.length &&
    Object.keys(seen).length === Object.keys(dayCounts).length &&
    Object.entries(seen).every(([day, n]) => dayCounts[day] === n);
  if (!consistent) throw new ActivitiesLoadError(`${resource} (itens e contagem por dia não conferem)`);

  return { items, total, dayCounts };
}

export class ConsultationLoadError extends DataLoadError {
  constructor(resource: string, cause?: unknown) {
    super(resource, cause);
    this.name = "ConsultationLoadError";
  }
}

/** Última reunião concluída do lead, direto no banco (nunca derivada de
 * uma página já carregada). `null` = nenhuma consulta realizada ainda. */
export async function getLastCompletedMeeting(leadId: string): Promise<ActivityListItem | null> {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("get_last_completed_meeting", { p_lead_id: leadId });
  if (error) throw new ConsultationLoadError(`a última consulta do lead ${leadId}`, error);
  if (!data) return null;
  return mapActivityRow(data as Record<string, unknown>);
}

export type ActivityDetail = ActivityListItem & { workspaceId: string };

const ACTIVITY_ABSENCE_CODES = ["activity_not_found", "insufficient_permission"] as const;

export async function getActivity(activityId: string): Promise<ActivityDetail | null> {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("get_activity", { p_activity_id: activityId });
  if (error) {
    if (isExpectedAbsence(error, ACTIVITY_ABSENCE_CODES)) return null;
    throw new ActivitiesLoadError(`a atividade ${activityId}`, error);
  }
  if (!data) return null;

  const row = data as Record<string, unknown>;
  return { workspaceId: row.workspace_id as string, ...mapActivityRow(row) };
}

export async function getActivityCounts(workspaceId: string): Promise<ActivityCounts> {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("get_activity_counts", { p_workspace_id: workspaceId });
  if (error) throw new ActivitiesLoadError(`as contagens de atividades do workspace ${workspaceId}`, error);
  if (!data) return EMPTY_COUNTS;
  return mapCounts(data);
}

export type NextAction = {
  id: string;
  type: ActivityType;
  title: string;
  dueAt: string;
  hasTime: boolean;
} | null;
