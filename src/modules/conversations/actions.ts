"use server";

import { revalidatePath } from "next/cache";

import { createServerSupabaseClient } from "@/server/supabase/server";
import { requirePermission, AuthzError, type Permission } from "@/server/authz/permissions";
import { toUserMessage } from "@/lib/errors";
import { normalizeWebhookPayload } from "@/server/whatsapp/normalize-event";
import { buildSimulatedInboundMessage, buildSimulatedStatusEvent } from "@/server/whatsapp/simulator";
import { listConversationMessages, mapSendMessageResult, type MessageListItem, type MessagesCursor } from "./queries";
import {
  createWhatsAppChannelSchema,
  simulateInboundMessageSchema,
  simulateStatusEventSchema,
  sendMessageSchema,
  resolveConversationLinkSchema,
  registerContactConsentSchema,
  revokeContactConsentSchema,
} from "./schema";

export type ActionState = { ok: boolean; error?: string };

async function requirePermissionSafe(
  permission: Permission,
): Promise<{ ctx: Awaited<ReturnType<typeof requirePermission>> } | { deniedMessage: string }> {
  try {
    return { ctx: await requirePermission(permission) };
  } catch (error) {
    if (error instanceof AuthzError) return { deniedMessage: "Você não tem permissão para fazer isso." };
    throw error;
  }
}

function revalidateConversationRoutes(conversationId?: string) {
  revalidatePath("/conversas");
  if (conversationId) revalidatePath(`/conversas/${conversationId}`);
}

// ---------------------------------------------------------------------
// Canal (config do simulador)
// ---------------------------------------------------------------------

export async function createWhatsAppChannelAction(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const guard = await requirePermissionSafe("conversation.simulate");
  if ("deniedMessage" in guard) return { ok: false, error: guard.deniedMessage };

  const parsed = createWhatsAppChannelSchema.safeParse({
    workspaceId: formData.get("workspaceId"),
    label: formData.get("label"),
    phoneNumberId: formData.get("phoneNumberId"),
    displayPhoneNumber: formData.get("displayPhoneNumber"),
  });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Dados inválidos." };
  }

  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.rpc("create_whatsapp_channel", {
    p_workspace_id: parsed.data.workspaceId,
    p_label: parsed.data.label,
    p_phone_number_id: parsed.data.phoneNumberId,
    p_display_phone_number: parsed.data.displayPhoneNumber,
  });

  if (error) return { ok: false, error: toUserMessage(error) };

  revalidatePath("/configuracoes/simulador-whatsapp");
  return { ok: true };
}

// ---------------------------------------------------------------------
// Simulador — entrada e status. Constrói o payload no formato da Cloud API
// (simulator.ts), normaliza (normalize-event.ts, a MESMA peça que a
// conexão real vai reaproveitar) e só então chama o RPC.
// ---------------------------------------------------------------------

export type SimulateActionState = ActionState & { conversationId?: string; messageId?: string };

export async function simulateInboundMessageAction(
  _prevState: SimulateActionState,
  formData: FormData,
): Promise<SimulateActionState> {
  const guard = await requirePermissionSafe("conversation.simulate");
  if ("deniedMessage" in guard) return { ok: false, error: guard.deniedMessage };

  const parsed = simulateInboundMessageSchema.safeParse({
    channelId: formData.get("channelId"),
    phoneNumberId: formData.get("phoneNumberId"),
    fromPhone: formData.get("fromPhone"),
    bodyText: formData.get("bodyText"),
    profileName: formData.get("profileName") ?? "",
    timestampOverride: formData.get("timestampOverride") ?? "",
  });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Dados inválidos." };
  }

  const fromWaId = parsed.data.fromPhone.replace(/^\+/, "");
  const timestamp = parsed.data.timestampOverride ? new Date(parsed.data.timestampOverride) : new Date();
  const waMessageId = `wamid.sim.${crypto.randomUUID().replace(/-/g, "")}`;

  const payload = buildSimulatedInboundMessage({
    phoneNumberId: parsed.data.phoneNumberId,
    fromWaId,
    waMessageId,
    bodyText: parsed.data.bodyText,
    profileName: parsed.data.profileName || undefined,
    timestamp,
  });

  const [event] = normalizeWebhookPayload(payload);
  if (!event || event.kind !== "inbound_message") {
    return { ok: false, error: "Não foi possível montar o evento simulado." };
  }

  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("simulate_inbound_whatsapp_message", {
    p_phone_number_id: event.phoneNumberId,
    p_from_wa_id_raw: event.fromWaIdRaw,
    p_from_e164: parsed.data.fromPhone,
    p_wa_message_id: event.waMessageId,
    p_event_timestamp: event.timestamp.toISOString(),
    p_body_text: event.bodyText,
    ...(event.profileName ? { p_profile_name: event.profileName } : {}),
  });

  if (error || !data) return { ok: false, error: toUserMessage(error) };

  const result = data as { conversation_id: string; message_id: string };
  revalidateConversationRoutes(result.conversation_id);
  return { ok: true, conversationId: result.conversation_id, messageId: result.message_id };
}

export async function simulateStatusEventAction(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const guard = await requirePermissionSafe("conversation.simulate");
  if ("deniedMessage" in guard) return { ok: false, error: guard.deniedMessage };

  const parsed = simulateStatusEventSchema.safeParse({
    phoneNumberId: formData.get("phoneNumberId"),
    waMessageId: formData.get("waMessageId"),
    recipientWaId: formData.get("recipientWaId"),
    status: formData.get("status"),
    timestampOverride: formData.get("timestampOverride") ?? "",
    errorMessage: formData.get("errorMessage") ?? "",
  });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Dados inválidos." };
  }

  const timestamp = parsed.data.timestampOverride ? new Date(parsed.data.timestampOverride) : new Date();
  const payload = buildSimulatedStatusEvent({
    phoneNumberId: parsed.data.phoneNumberId,
    waMessageId: parsed.data.waMessageId,
    status: parsed.data.status,
    recipientWaId: parsed.data.recipientWaId,
    timestamp,
    errorMessage: parsed.data.errorMessage || undefined,
  });

  const [event] = normalizeWebhookPayload(payload);
  if (!event || event.kind !== "status_event") {
    return { ok: false, error: "Não foi possível montar o evento simulado." };
  }

  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.rpc("apply_message_status_event", {
    p_phone_number_id: event.phoneNumberId,
    p_wa_message_id: event.waMessageId,
    p_status: event.status,
    p_event_timestamp: event.timestamp.toISOString(),
    ...(event.errorCode ? { p_error_code: event.errorCode } : {}),
    ...(event.errorMessage ? { p_error_message: event.errorMessage } : {}),
  });

  if (error) return { ok: false, error: toUserMessage(error) };

  revalidatePath("/conversas");
  return { ok: true };
}

// ---------------------------------------------------------------------
// Envio (mesmo caminho, simulado ou real futuro) e vínculo/consentimento.
// ---------------------------------------------------------------------

export type SendMessageActionResult =
  | { ok: true; message: MessageListItem; duplicateSubmit: boolean }
  | { ok: false; error: string; conflict?: true; persisted?: MessageListItem };

export async function sendMessageAction(
  conversationId: string,
  bodyText: string,
  clientDedupeKey: string,
): Promise<SendMessageActionResult> {
  const guard = await requirePermissionSafe("conversation.send");
  if ("deniedMessage" in guard) return { ok: false, error: guard.deniedMessage };

  const parsed = sendMessageSchema.safeParse({ conversationId, bodyText, clientDedupeKey });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Dados inválidos." };
  }

  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("send_message", {
    p_conversation_id: parsed.data.conversationId,
    p_body_text: parsed.data.bodyText,
    p_client_dedupe_key: parsed.data.clientDedupeKey,
  });

  if (error || !data) return { ok: false, error: toUserMessage(error) };

  const result = mapSendMessageResult(data as unknown as Record<string, unknown>);

  if (result.contentConflict) {
    // A MESMA client_dedupe_key voltou a ser usada com um texto diferente
    // do que já está gravado — nunca um falso sucesso: devolve o registro
    // REALMENTE persistido (texto, status) para a interface reconciliar em
    // vez de fingir que o texto novo foi enviado (a7-conversas.md §8).
    revalidateConversationRoutes(parsed.data.conversationId);
    return {
      ok: false,
      error: "Esta tentativa de envio já tinha sido registrada com outro texto — a mensagem realmente enviada foi recuperada.",
      conflict: true,
      persisted: result.message,
    };
  }

  revalidateConversationRoutes(parsed.data.conversationId);
  return { ok: true, message: result.message, duplicateSubmit: result.duplicateSubmit };
}

export async function resolveConversationLinkAction(
  conversationId: string,
  contactId: string | undefined,
  leadId: string | undefined,
  opportunityId: string | undefined,
): Promise<ActionState> {
  const guard = await requirePermissionSafe("conversation.link");
  if ("deniedMessage" in guard) return { ok: false, error: guard.deniedMessage };

  const parsed = resolveConversationLinkSchema.safeParse({ conversationId, contactId, leadId, opportunityId });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Dados inválidos." };
  }

  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.rpc("resolve_conversation_link", {
    p_conversation_id: parsed.data.conversationId,
    ...(parsed.data.contactId ? { p_contact_id: parsed.data.contactId } : {}),
    ...(parsed.data.leadId ? { p_lead_id: parsed.data.leadId } : {}),
    ...(parsed.data.opportunityId ? { p_opportunity_id: parsed.data.opportunityId } : {}),
  });

  if (error) return { ok: false, error: toUserMessage(error) };

  revalidateConversationRoutes(parsed.data.conversationId);
  return { ok: true };
}

export async function registerContactConsentAction(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const guard = await requirePermissionSafe("contact.consent_manage");
  if ("deniedMessage" in guard) return { ok: false, error: guard.deniedMessage };

  const parsed = registerContactConsentSchema.safeParse({
    contactId: formData.get("contactId"),
    channel: formData.get("channel"),
    legalBasis: formData.get("legalBasis"),
    purpose: formData.get("purpose"),
    evidenceSource: formData.get("evidenceSource") ?? "",
    acceptedText: formData.get("acceptedText") ?? "",
    purposeCode: (formData.get("purposeCode") as string | null) || undefined,
  });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Dados inválidos." };
  }

  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.rpc("register_contact_consent", {
    p_contact_id: parsed.data.contactId,
    p_channel: parsed.data.channel,
    p_legal_basis: parsed.data.legalBasis,
    p_purpose: parsed.data.purpose,
    ...(parsed.data.evidenceSource ? { p_evidence_source: parsed.data.evidenceSource } : {}),
    ...(parsed.data.acceptedText ? { p_accepted_text: parsed.data.acceptedText } : {}),
    ...(parsed.data.purposeCode ? { p_purpose_code: parsed.data.purposeCode } : {}),
  });

  if (error) return { ok: false, error: toUserMessage(error) };

  revalidatePath("/conversas");
  revalidatePath(`/contatos/${parsed.data.contactId}`);
  return { ok: true };
}

/**
 * "Carregar mais antigas" — diferente do carregamento INICIAL (que deixa
 * o erro subir puro até error.tsx da rota, mesmo padrão do A6), esta busca
 * é disparada pelo clique do usuário: precisa devolver um resultado
 * tratável para o Client Component mostrar erro com "tentar novamente"
 * SEM apagar as mensagens que já estavam carregadas na tela.
 */
export async function loadOlderMessagesAction(
  conversationId: string,
  before: MessagesCursor,
): Promise<{ ok: true; items: MessageListItem[]; hasMore: boolean } | { ok: false; error: string }> {
  try {
    const result = await listConversationMessages(conversationId, { before });
    return { ok: true, ...result };
  } catch {
    return { ok: false, error: "Não foi possível carregar mensagens mais antigas. Tente novamente." };
  }
}

export async function revokeContactConsentAction(consentId: string): Promise<ActionState> {
  const guard = await requirePermissionSafe("contact.consent_manage");
  if ("deniedMessage" in guard) return { ok: false, error: guard.deniedMessage };

  const parsed = revokeContactConsentSchema.safeParse({ consentId });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Dados inválidos." };
  }

  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.rpc("revoke_contact_consent", { p_consent_id: parsed.data.consentId });

  if (error) return { ok: false, error: toUserMessage(error) };

  revalidatePath("/conversas");
  return { ok: true };
}
