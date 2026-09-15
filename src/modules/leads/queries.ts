import { createServerSupabaseClient } from "@/server/supabase/server";
import { collectAllPages } from "@/server/data/collect-pages";
import { DataLoadError, isExpectedAbsence } from "@/server/data/load-error";
import type { Database } from "@/server/types/database";

export type LeadPriority = Database["public"]["Enums"]["lead_priority"];
export type LeadStatus = Database["public"]["Enums"]["lead_status"];

export type LeadListItem = {
  id: string;
  contactId: string;
  contactName: string;
  legalArea: string;
  summary: string | null;
  tags: string[];
  priority: LeadPriority;
  status: LeadStatus;
  assignedTo: string | null;
  assignedToName: string | null;
  createdAt: string;
  updatedAt: string;
};

type LeadJson = {
  id: string;
  contact_id: string;
  contact_name: string;
  legal_area: string;
  summary: string | null;
  tags: string[];
  priority: LeadPriority;
  status: LeadStatus;
  assigned_to: string | null;
  assigned_to_name: string | null;
  created_at: string;
  updated_at: string;
};

function mapLead(row: LeadJson): LeadListItem {
  return {
    id: row.id,
    contactId: row.contact_id,
    contactName: row.contact_name,
    legalArea: row.legal_area,
    summary: row.summary,
    tags: row.tags ?? [],
    priority: row.priority,
    status: row.status,
    assignedTo: row.assigned_to,
    assignedToName: row.assigned_to_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export type ListLeadsFilters = {
  search?: string | undefined;
  status?: LeadStatus | undefined;
  priority?: LeadPriority | undefined;
  assignedTo?: string | undefined;
  legalArea?: string | undefined;
  sort?: "created_at_desc" | "created_at_asc" | undefined;
  page?: number | undefined;
};

const PAGE_SIZE = 20;
/** Teto do próprio RPC (list_leads limita p_page_size a 100). */
const MAX_PAGE_SIZE = 100;

export async function listLeads(
  workspaceId: string,
  filters: ListLeadsFilters & { pageSize?: number | undefined } = {},
): Promise<{ items: LeadListItem[]; total: number; page: number; pageSize: number }> {
  const supabase = await createServerSupabaseClient();
  const page = Math.max(1, filters.page ?? 1);
  const pageSize = Math.max(1, Math.min(filters.pageSize ?? PAGE_SIZE, MAX_PAGE_SIZE));

  const { data, error } = await supabase.rpc("list_leads", {
    p_workspace_id: workspaceId,
    ...(filters.search ? { p_search: filters.search } : {}),
    ...(filters.status ? { p_status: filters.status } : {}),
    ...(filters.priority ? { p_priority: filters.priority } : {}),
    ...(filters.assignedTo ? { p_assigned_to: filters.assignedTo } : {}),
    ...(filters.legalArea ? { p_legal_area: filters.legalArea } : {}),
    p_sort: filters.sort ?? "created_at_desc",
    p_page: page,
    p_page_size: pageSize,
  });

  if (error) throw new DataLoadError(`a página ${page} de leads do workspace ${workspaceId}`, error);
  if (!data || data.length === 0) {
    return { items: [], total: 0, page, pageSize };
  }

  const row = data[0]!;
  const items = (row.items as unknown as LeadJson[] | null) ?? [];

  return {
    items: items.map(mapLead),
    total: row.total_count,
    page,
    pageSize,
  };
}

/** Todos os leads que casam com o filtro — para seletores, que não podem
 * parar na primeira página. */
export async function listAllLeads(
  workspaceId: string,
  filters: Omit<ListLeadsFilters, "page"> = {},
): Promise<LeadListItem[]> {
  return collectAllPages(`os leads do workspace ${workspaceId}`, (page) =>
    listLeads(workspaceId, { ...filters, page, pageSize: MAX_PAGE_SIZE }),
  );
}

export type ContactOption = { id: string; name: string };

/**
 * Lista enxuta de contatos para o seletor de "novo lead" — mesma tabela e
 * mesma RLS já usadas por `contacts/queries.ts` (reaproveita o registro
 * de contatos da A3, não duplica cadastro nem cria uma segunda fonte).
 */
/** Blocos abaixo do `max_rows` (1.000) do PostgREST — pedir mais faria o
 * servidor cortar a resposta em silêncio. */
const CONTACT_OPTIONS_CHUNK = 500;

export async function listContactOptions(workspaceId: string): Promise<ContactOption[]> {
  const supabase = await createServerSupabaseClient();

  return collectAllPages(`os contatos do workspace ${workspaceId}`, async (page) => {
    const from = (page - 1) * CONTACT_OPTIONS_CHUNK;
    const { data, error, count } = await supabase
      .from("contacts")
      .select("id, name", { count: "exact" })
      .eq("workspace_id", workspaceId)
      .is("merged_into_contact_id", null)
      // id desempata nomes iguais: sem ele, a ordem entre páginas não é
      // estável e um contato poderia repetir ou sumir entre dois blocos.
      .order("name", { ascending: true })
      .order("id", { ascending: true })
      .range(from, from + CONTACT_OPTIONS_CHUNK - 1);

    if (error) throw new DataLoadError(`os contatos do workspace ${workspaceId}`, error);
    return { items: data ?? [], total: count ?? 0 };
  });
}

/** Inexistente, de outro workspace ou fora do alcance do advogado. */
const LEAD_ABSENCE_CODES = ["lead_not_found", "insufficient_permission"] as const;

export async function getLeadDetail(leadId: string): Promise<LeadListItem | null> {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("get_lead", { p_lead_id: leadId });

  if (error) {
    if (isExpectedAbsence(error, LEAD_ABSENCE_CODES)) return null;
    throw new DataLoadError(`o lead ${leadId}`, error);
  }
  if (!data) return null;
  return mapLead(data as unknown as LeadJson);
}
