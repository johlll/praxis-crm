import { z } from "zod";

import { uuidSchema } from "@/lib/uuid";
import { createWhatsAppAdminSupabaseClient } from "@/server/whatsapp/admin/supabase";

/**
 * Operações de saída humana do WhatsApp (B3.3, docs/decisoes/b3-whatsapp-real.md
 * §28.18): contexto de envio da conversa, reserva (fase 1) e begin/finish da
 * outbox (fase 2). Só chamadas pelo servidor DEPOIS de a sessão ter sido
 * autorizada (`conversation.send`): `workspaceId` e `actorUserId` vêm da sessão,
 * nunca do formulário, e o banco revalida papel, acesso à conversa e ambiente.
 *
 * Nada daqui devolve credencial, telefone da conversa fora do `begin` (que o
 * servidor usa só para chamar o provedor), texto cifrado nem a mensagem do erro
 * original: o erro é sempre um código simbólico.
 */

export const WHATSAPP_OUTBOUND_ERROR_CODES = [
  "whatsapp_environment_required",
  "actor_required",
  "insufficient_permission",
  "conversation_not_found",
  "conversation_not_linked",
  "consent_required",
  "channel_not_active",
  "send_disabled",
  "recipient_unavailable",
  "window_closed",
  "invalid_message_body",
  "invalid_message_kind",
  "template_not_found",
  "template_not_approved",
  "template_category_not_allowed",
  "template_requires_case",
  "invalid_template_params",
  "invalid_template",
  "outbox_not_found",
  "invalid_outbox_state",
  "invalid_outcome",
  "invalid_provider_message_id",
  "invalid_lease",
  "channel_not_found",
  "channel_uses_whatsapp_outbox",
  "provider_send_not_available",
  "invalid_channel_state",
  // Do servidor, não do banco:
  "whatsapp_provider_unavailable",
  "whatsapp_not_configured",
  "send_result_unconfirmed",
] as const;

export type WhatsAppOutboundErrorCode = (typeof WHATSAPP_OUTBOUND_ERROR_CODES)[number] | "unknown";

export class WhatsAppOutboundError extends Error {
  constructor(public readonly code: WhatsAppOutboundErrorCode) {
    super(code);
    this.name = "WhatsAppOutboundError";
  }
}

const KNOWN = new Set<string>(WHATSAPP_OUTBOUND_ERROR_CODES);

/** Só o código simbólico do banco atravessa; qualquer outra mensagem vira
 * `unknown`, sem repassar o texto original. */
export function toOutboundError(error: { message?: string } | null | undefined): WhatsAppOutboundError {
  const message = error?.message ?? "";
  return new WhatsAppOutboundError(KNOWN.has(message) ? (message as WhatsAppOutboundErrorCode) : "unknown");
}

type Actor = { workspaceId: string; actorUserId: string };

// ---------------------------------------------------------------------
// Contexto de envio (o que a tela mostra)
// ---------------------------------------------------------------------

const contextSchema = z.discriminatedUnion("route", [
  z.object({ route: z.literal("legacy") }),
  z.object({
    route: z.literal("b3"),
    provider: z.enum(["simulated", "ycloud", "meta"]),
    blocked_reason: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/).nullable(),
    window_open: z.boolean(),
    window_expires_at: z.string().nullable(),
    case_linked: z.boolean(),
    templates: z.array(
      z.object({
        id: uuidSchema,
        name: z.string(),
        language: z.string(),
        body_text: z.string(),
        param_count: z.number().int().min(0).max(10),
      }),
    ),
  }),
]);

export type WhatsAppSendTemplateOption = {
  id: string;
  name: string;
  language: string;
  bodyText: string;
  paramCount: number;
};

export type WhatsAppSendContext =
  | { route: "legacy" }
  | {
      route: "b3";
      provider: "simulated" | "ycloud" | "meta";
      blockedReason: string | null;
      windowOpen: boolean;
      windowExpiresAt: string | null;
      caseLinked: boolean;
      templates: WhatsAppSendTemplateOption[];
    };

export async function adminGetWhatsAppSendContext(params: Actor & { conversationId: string }): Promise<WhatsAppSendContext> {
  const admin = createWhatsAppAdminSupabaseClient();
  const { data, error } = await admin.rpc("whatsapp_send_context", {
    p_conversation_id: params.conversationId,
    p_workspace_id: params.workspaceId,
    p_actor_user_id: params.actorUserId,
  });
  if (error) throw toOutboundError(error);
  const parsed = contextSchema.safeParse(data);
  if (!parsed.success) throw new WhatsAppOutboundError("unknown");
  const c = parsed.data;
  if (c.route === "legacy") return { route: "legacy" };
  return {
    route: "b3",
    provider: c.provider,
    blockedReason: c.blocked_reason,
    windowOpen: c.window_open,
    windowExpiresAt: c.window_expires_at,
    caseLinked: c.case_linked,
    templates: c.templates.map((t) => ({ id: t.id, name: t.name, language: t.language, bodyText: t.body_text, paramCount: t.param_count })),
  };
}

// ---------------------------------------------------------------------
// Reserva, begin e finish
// ---------------------------------------------------------------------

/** Resultado de toda operação da outbox: o estado e o registro REALMENTE
 * persistido da mensagem (as chaves são as mesmas do `send_message` da A7). */
const snapshotSchema = z.object({
  outbox_id: uuidSchema,
  state: z.enum(["reserved", "sending", "accepted", "rejected", "uncertain"]),
  error_code: z.string().nullable(),
  duplicate_submit: z.boolean(),
  content_conflict: z.boolean(),
  message_id: uuidSchema,
  direction: z.string(),
  body_text: z.string().nullable(),
  status: z.string(),
  status_updated_at: z.string(),
  error_reason: z.string().nullable(),
  sent_by: z.string().nullable(),
  created_at: z.string(),
  wa_message_id: z.string().nullable(),
});

export type OutboxSnapshot = z.infer<typeof snapshotSchema>;

function parseSnapshot(data: unknown): OutboxSnapshot {
  const parsed = snapshotSchema.safeParse(data);
  if (!parsed.success) throw new WhatsAppOutboundError("unknown");
  return parsed.data;
}

export type ReserveContent =
  | { kind: "text"; text: string }
  | { kind: "template"; templateId: string; params: string[] };

export async function adminReserveWhatsAppSend(
  params: Actor & { conversationId: string; clientDedupeKey: string; content: ReserveContent },
): Promise<OutboxSnapshot> {
  const admin = createWhatsAppAdminSupabaseClient();
  const { data, error } = await admin.rpc("whatsapp_reserve_send", {
    p_conversation_id: params.conversationId,
    p_workspace_id: params.workspaceId,
    p_actor_user_id: params.actorUserId,
    p_client_dedupe_key: params.clientDedupeKey,
    p_kind: params.content.kind,
    ...(params.content.kind === "text"
      ? { p_body_text: params.content.text }
      : { p_template_id: params.content.templateId, p_template_params: params.content.params }),
  });
  if (error) throw toOutboundError(error);
  return parseSnapshot(data);
}

const beginExtraSchema = z.object({
  outcome: z.enum(["begin", "in_progress", "done"]),
  kind: z.enum(["text", "template"]).optional(),
  /** Canal da intenção, lido pelo banco da própria outbox (migration 20261109120000).
   * Banco antigo não devolve: fica `null` e o envio com rede falha fechado. */
  channel_id: z.string().max(64).nullish(),
  provider: z.enum(["simulated", "ycloud", "meta"]).optional(),
  routing_key: z.string().optional(),
  recipient_phone: z.string().optional(),
  text: z.string().nullable().optional(),
  template_name: z.string().nullable().optional(),
  template_language: z.string().nullable().optional(),
  template_params: z.array(z.string()).nullable().optional(),
});

export type OutboxBegin =
  | { outcome: "in_progress" | "done"; snapshot: OutboxSnapshot }
  | {
      outcome: "begin";
      snapshot: OutboxSnapshot;
      /** Vem só do banco (`begin`); nunca da tela, do formulário ou do chamador. */
      channelId: string | null;
      provider: "simulated" | "ycloud" | "meta";
      routingKey: string;
      recipientPhone: string;
      content:
        | { kind: "text"; text: string }
        | { kind: "template"; name: string; language: string; params: string[] };
    };

/** Inicia (no máximo uma vez) a tentativa de envio. Uma tentativa que já
 * começou e sumiu nunca volta a ser iniciada: vira incerta. */
export async function adminBeginWhatsAppOutboxSend(outboxId: string): Promise<OutboxBegin> {
  const admin = createWhatsAppAdminSupabaseClient();
  const { data, error } = await admin.rpc("whatsapp_outbox_begin", { p_outbox_id: outboxId });
  if (error) throw toOutboundError(error);
  const snapshot = parseSnapshot(data);
  const extra = beginExtraSchema.safeParse(data);
  if (!extra.success) throw new WhatsAppOutboundError("unknown");
  const e = extra.data;
  if (e.outcome !== "begin") return { outcome: e.outcome, snapshot };

  if (!e.provider || !e.routing_key || !e.recipient_phone || !e.kind) throw new WhatsAppOutboundError("unknown");
  if (e.kind === "text") {
    if (typeof e.text !== "string") throw new WhatsAppOutboundError("unknown");
    return { outcome: "begin", snapshot, channelId: e.channel_id ?? null, provider: e.provider, routingKey: e.routing_key, recipientPhone: e.recipient_phone, content: { kind: "text", text: e.text } };
  }
  if (!e.template_name || !e.template_language || !e.template_params) throw new WhatsAppOutboundError("unknown");
  return {
    outcome: "begin",
    snapshot,
    channelId: e.channel_id ?? null,
    provider: e.provider,
    routingKey: e.routing_key,
    recipientPhone: e.recipient_phone,
    content: { kind: "template", name: e.template_name, language: e.template_language, params: e.template_params },
  };
}

export type OutboxOutcome =
  | { outcome: "accepted"; providerMessageId: string }
  | { outcome: "rejected"; errorCode: string }
  | { outcome: "uncertain" };

export async function adminFinishWhatsAppOutboxSend(outboxId: string, result: OutboxOutcome): Promise<OutboxSnapshot> {
  const admin = createWhatsAppAdminSupabaseClient();
  const { data, error } = await admin.rpc("whatsapp_outbox_finish", {
    p_outbox_id: outboxId,
    p_outcome: result.outcome,
    ...(result.outcome === "accepted" ? { p_provider_message_id: result.providerMessageId } : {}),
    ...(result.outcome === "rejected" ? { p_error_code: result.errorCode } : {}),
  });
  if (error) throw toOutboundError(error);
  return parseSnapshot(data);
}
