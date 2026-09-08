import { createServerSupabaseClient } from "@/server/supabase/server";
import { blindIndexesForSearch } from "@/server/crypto/contact-sensitive";
import type { Database } from "@/server/types/database";

export type ContactType = Database["public"]["Enums"]["contact_type"];
export type ContactChannel = Database["public"]["Enums"]["contact_channel"];
export type DuplicateTier = Database["public"]["Enums"]["duplicate_tier"];

export type ContactListItem = {
  id: string;
  name: string;
  type: ContactType;
  city: string | null;
  uf: string | null;
  createdAt: string;
  phones: string[];
  emails: string[];
};

const PAGE_SIZE = 20;

/**
 * Listagem paginada + busca por nome/telefone/e-mail. `merged_into_contact_id
 * is null` de propósito: um contato mesclado nunca aparece como ativo — a
 * mesclagem é "soft" (a linha continua existindo para o histórico/undo),
 * não some do banco, só some da listagem.
 */
export async function listContacts(
  workspaceId: string,
  opts: { search?: string | undefined; page?: number | undefined } = {},
): Promise<{ items: ContactListItem[]; total: number; page: number; pageSize: number }> {
  const supabase = await createServerSupabaseClient();
  const page = Math.max(1, opts.page ?? 1);
  const from = (page - 1) * PAGE_SIZE;
  const to = from + PAGE_SIZE - 1;

  let query = supabase
    .from("contacts")
    .select(
      "id, name, type, city, uf, created_at, phones:contact_phones(value_normalized), emails:contact_emails(value_normalized)",
      { count: "exact" },
    )
    .eq("workspace_id", workspaceId)
    .is("merged_into_contact_id", null)
    .order("created_at", { ascending: false })
    .range(from, to);

  const search = opts.search?.trim();
  const searchDigits = search?.replace(/\D/g, "") ?? "";
  const looksLikeCpfCnpj = searchDigits.length === 11 || searchDigits.length === 14;

  if (search && !looksLikeCpfCnpj) {
    query = query.ilike("name", `%${search}%`);
  }

  if (looksLikeCpfCnpj) {
    // Termo de busca parece CPF/CNPJ — busca exata pelo blind index
    // (nunca decifra em massa) em vez de filtrar por nome.
    const matches = await searchContactsByCpfCnpj(workspaceId, searchDigits);
    const ids = matches.map((m) => m.id);
    if (ids.length === 0) {
      return { items: [], total: 0, page, pageSize: PAGE_SIZE };
    }
    query = query.in("id", ids);
  }

  const { data, count } = await query;

  const items: ContactListItem[] = (data ?? []).map((row) => ({
    id: row.id,
    name: row.name,
    type: row.type,
    city: row.city,
    uf: row.uf,
    createdAt: row.created_at,
    phones: (row.phones ?? []).map((p) => p.value_normalized),
    emails: (row.emails ?? []).map((e) => e.value_normalized),
  }));

  return { items, total: count ?? 0, page, pageSize: PAGE_SIZE };
}

/**
 * Busca exata por CPF/CNPJ pelo blind index — nunca decifra em massa
 * (nem decifra nada: só compara índices). Cobre todas as versões de chave
 * conhecidas, para achar linhas gravadas antes de uma rotação.
 */
export async function searchContactsByCpfCnpj(
  workspaceId: string,
  rawValue: string,
): Promise<{ id: string; name: string }[]> {
  const supabase = await createServerSupabaseClient();
  const candidates = blindIndexesForSearch(workspaceId, rawValue);

  const { data } = await supabase.rpc("search_contacts_by_cpf_cnpj", {
    p_workspace_id: workspaceId,
    p_blind_indexes_base64: candidates,
  });

  return (data ?? []).map((row) => ({ id: row.id, name: row.name }));
}

export type ContactDetail = {
  id: string;
  workspaceId: string;
  name: string;
  type: ContactType;
  city: string | null;
  uf: string | null;
  preferredChannel: ContactChannel | null;
  createdAt: string;
  phones: { id: string; value: string; isPrimary: boolean }[];
  emails: { id: string; value: string; isPrimary: boolean }[];
  hasSensitive: boolean;
};

export async function getContactDetail(contactId: string): Promise<ContactDetail | null> {
  const supabase = await createServerSupabaseClient();
  const { data: contact } = await supabase
    .from("contacts")
    .select("id, workspace_id, name, type, city, uf, preferred_channel, created_at")
    .eq("id", contactId)
    .is("merged_into_contact_id", null)
    .maybeSingle();

  if (!contact) return null;

  const [{ data: phones }, { data: emails }, { data: hasSensitive }] = await Promise.all([
    supabase
      .from("contact_phones")
      .select("id, value_normalized, is_primary")
      .eq("contact_id", contactId)
      .order("is_primary", { ascending: false }),
    supabase
      .from("contact_emails")
      .select("id, value_normalized, is_primary")
      .eq("contact_id", contactId)
      .order("is_primary", { ascending: false }),
    supabase.rpc("contact_has_sensitive", { p_contact_id: contactId }),
  ]);

  return {
    id: contact.id,
    workspaceId: contact.workspace_id,
    name: contact.name,
    type: contact.type,
    city: contact.city,
    uf: contact.uf,
    preferredChannel: contact.preferred_channel,
    createdAt: contact.created_at,
    phones: (phones ?? []).map((p) => ({ id: p.id, value: p.value_normalized, isPrimary: p.is_primary })),
    emails: (emails ?? []).map((e) => ({ id: e.id, value: e.value_normalized, isPrimary: e.is_primary })),
    hasSensitive: hasSensitive ?? false,
  };
}

export type DuplicateCandidateItem = {
  id: string;
  contactAId: string;
  contactAName: string;
  contactBId: string;
  contactBName: string;
  tier: DuplicateTier;
  priority: number;
  signals: { type: string; [key: string]: unknown }[];
  createdAt: string;
};

export type DuplicateCandidateDetail = {
  id: string;
  tier: DuplicateTier;
  signals: { type: string; [key: string]: unknown }[];
  status: string;
  contactA: ContactDetail;
  contactB: ContactDetail;
};

/** Candidato + os dois contatos completos, para a tela de comparação
 * lado a lado. `null` se o candidato não existir mais ou não pertencer ao
 * workspace ativo (RLS filtra sozinha, sem precisar checar aqui). */
export async function getDuplicateCandidateDetail(
  candidateId: string,
): Promise<DuplicateCandidateDetail | null> {
  const supabase = await createServerSupabaseClient();
  const { data: candidate } = await supabase
    .from("duplicate_candidates")
    .select("id, tier, signals, status, contact_a_id, contact_b_id")
    .eq("id", candidateId)
    .maybeSingle();

  if (!candidate) return null;

  const [contactA, contactB] = await Promise.all([
    getContactDetail(candidate.contact_a_id),
    getContactDetail(candidate.contact_b_id),
  ]);

  if (!contactA || !contactB) return null;

  return {
    id: candidate.id,
    tier: candidate.tier,
    signals: (candidate.signals ?? []) as { type: string; [key: string]: unknown }[],
    status: candidate.status,
    contactA,
    contactB,
  };
}

/**
 * Fila de revisão — só pendentes, ordenada por priority (que é só ordem de
 * fila, nunca probabilidade de identidade — ver docs/decisoes/a3-duplicidades.md).
 */
export async function listPendingDuplicateCandidates(
  workspaceId: string,
): Promise<DuplicateCandidateItem[]> {
  const supabase = await createServerSupabaseClient();
  const { data } = await supabase
    .from("duplicate_candidates")
    .select(
      "id, tier, priority, signals, created_at, contact_a:contacts!duplicate_candidates_contact_a_id_fkey(id, name), contact_b:contacts!duplicate_candidates_contact_b_id_fkey(id, name)",
    )
    .eq("workspace_id", workspaceId)
    .eq("status", "pending")
    .order("priority", { ascending: false });

  return (data ?? [])
    .filter((row) => row.contact_a !== null && row.contact_b !== null)
    .map((row) => ({
      id: row.id,
      contactAId: row.contact_a!.id,
      contactAName: row.contact_a!.name,
      contactBId: row.contact_b!.id,
      contactBName: row.contact_b!.name,
      tier: row.tier,
      priority: row.priority,
      signals: (row.signals ?? []) as { type: string; [key: string]: unknown }[],
      createdAt: row.created_at,
    }));
}
