import { createServerSupabaseClient } from "@/server/supabase/server";
import type { Database } from "@/server/types/database";

export type MessageDirection = Database["public"]["Enums"]["message_direction"];
export type MessageStatus = Database["public"]["Enums"]["message_status"];

export type ConversationListItem = {
  id: string;
  waId: string;
  contactId: string | null;
  contactName: string | null;
  leadId: string | null;
  legalArea: string | null;
  opportunityId: string | null;
  needsLinkReview: boolean;
  lastMessageAt: string | null;
  lastMessageText: string | null;
  lastMessageDirection: MessageDirection | null;
  lastMessageStatus: MessageStatus | null;
};

function mapConversationRow(row: Record<string, unknown>): ConversationListItem {
  return {
    id: row.id as string,
    waId: row.wa_id as string,
    contactId: (row.contact_id as string | null) ?? null,
    contactName: (row.contact_name as string | null) ?? null,
    leadId: (row.lead_id as string | null) ?? null,
    legalArea: (row.legal_area as string | null) ?? null,
    opportunityId: (row.opportunity_id as string | null) ?? null,
    needsLinkReview: row.needs_link_review as boolean,
    lastMessageAt: (row.last_message_at as string | null) ?? null,
    lastMessageText: (row.last_message_text as string | null) ?? null,
    lastMessageDirection: (row.last_message_direction as MessageDirection | null) ?? null,
    lastMessageStatus: (row.last_message_status as MessageStatus | null) ?? null,
  };
}

const PAGE_SIZE = 20;

export async function listConversations(
  workspaceId: string,
  opts: { page?: number | undefined } = {},
): Promise<{ items: ConversationListItem[]; total: number; page: number; pageSize: number }> {
  const page = Math.max(1, opts.page ?? 1);
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("list_conversations", {
    p_workspace_id: workspaceId,
    p_page: page,
    p_page_size: PAGE_SIZE,
  });

  if (error || !data || data.length === 0) {
    return { items: [], total: 0, page, pageSize: PAGE_SIZE };
  }

  const row = data[0]!;
  const items = (row.items as unknown as Array<Record<string, unknown>> | null) ?? [];
  return { items: items.map(mapConversationRow), total: row.total_count, page, pageSize: PAGE_SIZE };
}

export type ConversationDetail = {
  id: string;
  workspaceId: string;
  channelId: string;
  waId: string;
  contactId: string | null;
  contactName: string | null;
  leadId: string | null;
  legalArea: string | null;
  opportunityId: string | null;
  needsLinkReview: boolean;
  linkCandidateContacts: Array<{ id: string; name: string }>;
  linkCandidateLeads: Array<{ id: string; legalArea: string }>;
  phoneNumberId: string;
  lastMessageAt: string | null;
  createdAt: string;
};

export async function getConversation(conversationId: string): Promise<ConversationDetail | null> {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("get_conversation", { p_conversation_id: conversationId });
  if (error || !data) return null;

  const row = data as Record<string, unknown>;
  return {
    id: row.id as string,
    workspaceId: row.workspace_id as string,
    channelId: row.channel_id as string,
    waId: row.wa_id as string,
    contactId: (row.contact_id as string | null) ?? null,
    contactName: (row.contact_name as string | null) ?? null,
    leadId: (row.lead_id as string | null) ?? null,
    legalArea: (row.legal_area as string | null) ?? null,
    opportunityId: (row.opportunity_id as string | null) ?? null,
    needsLinkReview: row.needs_link_review as boolean,
    linkCandidateContacts: (row.link_candidate_contacts as Array<{ id: string; name: string }>) ?? [],
    linkCandidateLeads: (row.link_candidate_leads as Array<{ id: string; legal_area: string }>).map((l) => ({
      id: l.id,
      legalArea: (l as unknown as { legal_area: string }).legal_area,
    })),
    phoneNumberId: row.phone_number_id as string,
    lastMessageAt: (row.last_message_at as string | null) ?? null,
    createdAt: row.created_at as string,
  };
}

export type MessageListItem = {
  id: string;
  direction: MessageDirection;
  bodyText: string;
  status: MessageStatus;
  statusUpdatedAt: string;
  errorReason: string | null;
  sentBy: string | null;
  createdAt: string;
  waMessageId: string;
};

function mapMessageRow(row: Record<string, unknown>): MessageListItem {
  return {
    id: row.id as string,
    direction: row.direction as MessageDirection,
    bodyText: row.body_text as string,
    status: row.status as MessageStatus,
    statusUpdatedAt: row.status_updated_at as string,
    errorReason: (row.error_reason as string | null) ?? null,
    sentBy: (row.sent_by as string | null) ?? null,
    createdAt: row.created_at as string,
    waMessageId: row.wa_message_id as string,
  };
}

/**
 * Erro deliberado (nunca uma página parcial disfarçada de "conversa
 * vazia" ou "acabaram as mensagens") para quando uma busca de histórico
 * falha — mesmo espírito de ActivitiesLoadError (A6): quem chama isto deixa
 * subir para o error.tsx da rota, que mostra erro tratado com "tentar
 * novamente".
 */
export class ConversationMessagesLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConversationMessagesLoadError";
  }
}

const MESSAGES_PAGE_SIZE = 30;

export async function listConversationMessages(
  conversationId: string,
  opts: { before?: string | undefined; limit?: number | undefined } = {},
): Promise<{ items: MessageListItem[]; hasMore: boolean }> {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("list_conversation_messages", {
    p_conversation_id: conversationId,
    ...(opts.before ? { p_before: opts.before } : {}),
    p_limit: opts.limit ?? MESSAGES_PAGE_SIZE,
  });

  if (error) {
    throw new ConversationMessagesLoadError(
      `Falha ao buscar mensagens da conversa ${conversationId}: ${error.message}`,
    );
  }
  if (!data || data.length === 0) {
    return { items: [], hasMore: false };
  }

  const row = data[0]!;
  const items = (row.items as unknown as Array<Record<string, unknown>> | null) ?? [];
  return { items: items.map(mapMessageRow), hasMore: row.has_more };
}

export type WhatsAppChannel = {
  id: string;
  label: string;
  phoneNumberId: string;
  displayPhoneNumber: string;
  isSimulator: boolean;
  status: string;
};

export async function listWhatsAppChannels(workspaceId: string): Promise<WhatsAppChannel[]> {
  const supabase = await createServerSupabaseClient();
  const { data } = await supabase
    .from("whatsapp_channels")
    .select("id, label, phone_number_id, display_phone_number, is_simulator, status")
    .eq("workspace_id", workspaceId)
    .order("created_at", { ascending: true });

  return (data ?? []).map((row) => ({
    id: row.id,
    label: row.label,
    phoneNumberId: row.phone_number_id,
    displayPhoneNumber: row.display_phone_number,
    isSimulator: row.is_simulator,
    status: row.status,
  }));
}

export type ContactConsent = {
  id: string;
  channel: string;
  legalBasis: string;
  purpose: string;
  grantedAt: string | null;
  revokedAt: string | null;
  evidenceSource: string | null;
  createdAt: string;
};

export async function listContactConsents(contactId: string): Promise<ContactConsent[]> {
  const supabase = await createServerSupabaseClient();
  const { data } = await supabase
    .from("contact_consents")
    .select("id, channel, legal_basis, purpose, granted_at, revoked_at, evidence_source, created_at")
    .eq("contact_id", contactId)
    .order("created_at", { ascending: false });

  return (data ?? []).map((row) => ({
    id: row.id,
    channel: row.channel,
    legalBasis: row.legal_basis,
    purpose: row.purpose,
    grantedAt: row.granted_at,
    revokedAt: row.revoked_at,
    evidenceSource: row.evidence_source,
    createdAt: row.created_at,
  }));
}

export function hasActiveWhatsAppConsent(consents: ContactConsent[]): boolean {
  return consents.some((c) => c.channel === "whatsapp" && c.grantedAt && !c.revokedAt);
}
