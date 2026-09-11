import { createServerSupabaseClient } from "@/server/supabase/server";
import type { Database } from "@/server/types/database";
import type { FeeModel } from "@/modules/opportunities/queries";

export type ClientStatus = Database["public"]["Enums"]["client_status"];
export type HandoffStatus = Database["public"]["Enums"]["handoff_status"];

export const CLIENT_STATUSES = ["ativo", "encerrado", "suspenso"] as const satisfies readonly ClientStatus[];

export type ClientListItem = {
  id: string;
  contactId: string;
  contactName: string;
  ownerUserId: string | null;
  ownerName: string | null;
  status: ClientStatus;
  createdAt: string;
  updatedAt: string;
  lockVersion: number;
  /** Só as oportunidades vinculadas dentro do alcance de quem pediu a
   * lista — para o advogado, isso já é o mesmo motivo pelo qual o
   * cliente aparece na lista; para os demais papéis, é o total real. */
  opportunityCount: number;
};

type ClientListJson = {
  id: string;
  contact_id: string;
  contact_name: string;
  owner_user_id: string | null;
  owner_name: string | null;
  status: ClientStatus;
  created_at: string;
  updated_at: string;
  lock_version: number;
  opportunity_count: number;
};

function mapClientListItem(row: ClientListJson): ClientListItem {
  return {
    id: row.id,
    contactId: row.contact_id,
    contactName: row.contact_name,
    ownerUserId: row.owner_user_id,
    ownerName: row.owner_name,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lockVersion: row.lock_version,
    opportunityCount: row.opportunity_count,
  };
}

export type ListClientsFilters = {
  status?: ClientStatus | undefined;
  search?: string | undefined;
  sort?: "created_at_desc" | "created_at_asc" | undefined;
  page?: number | undefined;
};

const PAGE_SIZE = 20;

/**
 * Achado da A7 (ConversationsLoadError/ConversationMessagesLoadError),
 * aplicado aqui desde o início (item 7 do pedido da A8): falha de
 * consulta nunca pode virar "nenhum cliente ainda" — as duas situações
 * são visualmente e semanticamente diferentes. `clientes/error.tsx`
 * mostra erro tratado com "tentar novamente"; um workspace genuinamente
 * sem clientes continua retornando {items: [], total: 0} normalmente
 * (RPC sem erro, lista real vazia).
 */
export class ClientsLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClientsLoadError";
  }
}

export async function listClients(
  workspaceId: string,
  filters: ListClientsFilters = {},
): Promise<{ items: ClientListItem[]; total: number; page: number; pageSize: number }> {
  const supabase = await createServerSupabaseClient();
  const page = Math.max(1, filters.page ?? 1);

  const { data, error } = await supabase.rpc("list_clients", {
    p_workspace_id: workspaceId,
    ...(filters.status ? { p_status: filters.status } : {}),
    ...(filters.search ? { p_search: filters.search } : {}),
    p_sort: filters.sort ?? "created_at_desc",
    p_page: page,
    p_page_size: PAGE_SIZE,
  });

  if (error) {
    throw new ClientsLoadError(`Falha ao carregar clientes do workspace ${workspaceId}: ${error.message}`);
  }

  if (!data || data.length === 0) {
    return { items: [], total: 0, page, pageSize: PAGE_SIZE };
  }

  const row = data[0]!;
  const items = (row.items as unknown as ClientListJson[] | null) ?? [];

  return {
    items: items.map(mapClientListItem),
    total: row.total_count,
    page,
    pageSize: PAGE_SIZE,
  };
}

/**
 * Um item de `history` é uma oportunidade GANHA + o handoff que ela
 * gerou (sempre os dois juntos — client_handoffs_one_per_opportunity,
 * A5). Campos financeiros opcionais: a projeção por papel do servidor
 * decide quais chaves existem, mesmo princípio de OpportunityCard.
 * Nunca inclui payload/last_error do handoff (item 6 do pedido).
 */
export type ClientHistoryItem = {
  opportunityId: string;
  legalArea: string;
  wonAt: string | null;
  signedAt: string | null;
  handoffId: string;
  handoffStatus: HandoffStatus;
  handoffTargetSystem: string | null;
  handoffAwaitingIntegration: boolean;
  handoffAttempts: number;
  handoffCompletedAt: string | null;
  handoffCreatedAt: string;
  valueCents?: number;
  feeModel?: FeeModel | null;
  probability?: number | null;
  forecastDate?: string | null;
  valueBand?: string;
};

export type ClientDetail = {
  id: string;
  workspaceId: string;
  contactId: string;
  contactName: string;
  ownerUserId: string | null;
  ownerName: string | null;
  status: ClientStatus;
  lockVersion: number;
  createdAt: string;
  updatedAt: string;
  /** Ordem cronológica crescente — history[0] é a origem (item 5 do
   * pedido: primeiro handoff vinculado, ordenação determinística por
   * created_at,id — resolvido aqui, sem consulta redundante no banco). */
  history: ClientHistoryItem[];
  valueSumCents?: number;
};

export async function getClient(clientId: string): Promise<ClientDetail | null> {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("get_client", { p_client_id: clientId });
  if (error || !data) return null;

  const row = data as Record<string, unknown>;
  const history = ((row.history as unknown[]) ?? []).map((h) => {
    const item = h as Record<string, unknown>;
    return {
      opportunityId: item.opportunity_id as string,
      legalArea: item.legal_area as string,
      wonAt: (item.won_at as string | null) ?? null,
      signedAt: (item.signed_at as string | null) ?? null,
      handoffId: item.handoff_id as string,
      handoffStatus: item.handoff_status as HandoffStatus,
      handoffTargetSystem: (item.handoff_target_system as string | null) ?? null,
      handoffAwaitingIntegration: item.handoff_awaiting_integration as boolean,
      handoffAttempts: item.handoff_attempts as number,
      handoffCompletedAt: (item.handoff_completed_at as string | null) ?? null,
      handoffCreatedAt: item.handoff_created_at as string,
      ...(item.value_cents !== undefined ? { valueCents: item.value_cents as number } : {}),
      ...(item.fee_model !== undefined ? { feeModel: item.fee_model as FeeModel | null } : {}),
      ...(item.probability !== undefined ? { probability: item.probability as number | null } : {}),
      ...(item.forecast_date !== undefined ? { forecastDate: item.forecast_date as string | null } : {}),
      ...(item.value_band !== undefined ? { valueBand: item.value_band as string } : {}),
    };
  });

  return {
    id: row.id as string,
    workspaceId: row.workspace_id as string,
    contactId: row.contact_id as string,
    contactName: row.contact_name as string,
    ownerUserId: (row.owner_user_id as string | null) ?? null,
    ownerName: (row.owner_name as string | null) ?? null,
    status: row.status as ClientStatus,
    lockVersion: row.lock_version as number,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    history,
    ...(row.value_sum_cents !== undefined ? { valueSumCents: row.value_sum_cents as number } : {}),
  };
}
