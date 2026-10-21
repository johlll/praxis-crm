import { createHash, timingSafeEqual } from "node:crypto";

import { z } from "zod";

import { uuidSchema } from "@/lib/uuid";
import { isTrustedWhatsAppChannelContext, type ResolvedWhatsAppChannelContext } from "@/server/whatsapp/admin/channels";
import { createWhatsAppAdminSupabaseClient } from "@/server/whatsapp/admin/supabase";
import { getWhatsAppEnvironment } from "@/server/whatsapp/environment";
import {
  decryptWhatsAppInboxBody,
  encryptWhatsAppInboxBody,
  WhatsAppInboxCryptoError,
  type EncryptedInboxBody,
  type InboxCipherContext,
} from "@/server/whatsapp/inbox-crypto";
import { VerifiedWebhookBody, type WhatsAppProvider } from "@/server/whatsapp/provider/contract";

/**
 * Caixa de entrada CIFRADA do webhook de WhatsApp (B3.2b,
 * docs/decisoes/b3-whatsapp-real.md §17).
 *
 * Armazenamento durável e idempotente de cada entrega autêntica. Nada daqui
 * processa mensagem, cria contato, lead ou conversa, nem fala com provedor:
 * a rota é da B3.2c, o processamento, da B3.2d.
 *
 * Só aceita:
 *  - bytes já representados por `VerifiedWebhookBody` (assinatura conferida
 *    pelo adaptador);
 *  - o contexto CONFIÁVEL do canal produzido pela resolução interna
 *    (`adminResolveWhatsAppWebhookChannel`). Um objeto montado à mão, ou uma
 *    cópia do contexto, não autoriza nada.
 *
 * A gravação acontece ANTES da normalização completa: do corpo só se lê o
 * envelope mínimo (id do evento, tipo bruto, versão, um evento só). Um
 * evento autêntico cujo conteúdo o normalizador recusa é guardado do mesmo
 * jeito; a falha de normalização é tratada depois (B3.2d).
 *
 * O corpo vai cifrado (chave e AAD próprias da inbox); o banco recebe só
 * metadado, hash e texto cifrado, e confere de novo ambiente e identidade do
 * canal. Retenção: `WHATSAPP_INBOX_RETENTION_SECONDS` (configuração
 * confiável, sem padrão, até 30 dias); sem valor válido, falha fechada.
 * Nenhuma operação escreve log; erros são códigos fixos.
 */

export const WHATSAPP_INBOX_ERROR_CODES = [
  "whatsapp_environment_required",
  "channel_not_found",
  "channel_context_untrusted",
  "channel_context_mismatch",
  "channel_environment_mismatch",
  "provider_mismatch",
  "unverified_body",
  "invalid_payload",
  "unsupported_envelope_version",
  "inbox_batch_not_supported",
  "retention_not_configured",
  "inbox_crypto_not_configured",
  "inbox_decrypt_failed",
  "inbox_integrity_failed",
  "invalid_inbox_event",
  "invalid_inbox_hash",
  "invalid_inbox_ciphertext",
  "invalid_retention",
  "invalid_error_code",
  "invalid_limit",
  "inbox_entry_not_found",
  "inbox_entry_purged",
  "invalid_inbox_state",
] as const;

export type WhatsAppInboxErrorCode = (typeof WHATSAPP_INBOX_ERROR_CODES)[number] | "unknown";

export class WhatsAppInboxError extends Error {
  constructor(public readonly code: WhatsAppInboxErrorCode) {
    super(code);
    this.name = "WhatsAppInboxError";
  }
}

const KNOWN = new Set<string>(WHATSAPP_INBOX_ERROR_CODES);

/** Só o código simbólico do banco atravessa; qualquer outra mensagem vira
 * `unknown`, sem repassar o texto original. */
function toInboxError(error: { message?: string } | null | undefined): WhatsAppInboxError {
  const message = error?.message ?? "";
  return new WhatsAppInboxError(KNOWN.has(message) ? (message as WhatsAppInboxErrorCode) : "unknown");
}

function cryptoError(error: unknown, fallback: WhatsAppInboxErrorCode): WhatsAppInboxError {
  if (error instanceof WhatsAppInboxCryptoError && error.code === "not_configured") {
    return new WhatsAppInboxError("inbox_crypto_not_configured");
  }
  return new WhatsAppInboxError(fallback);
}

/** Mínimo de 1 minuto (prazo fictício curto nos testes); teto TÉCNICO de 30
 * dias, o mesmo do banco: a inbox guarda o payload bruto, não o registro
 * definitivo da conversa (que pode ter outra política). O valor do piloto
 * continua pendente do portão P9. */
export const WHATSAPP_INBOX_MIN_RETENTION_SECONDS = 60;
export const WHATSAPP_INBOX_MAX_RETENTION_SECONDS = 30 * 86_400;

export function getWhatsAppInboxRetentionSeconds(): number {
  const raw = process.env.WHATSAPP_INBOX_RETENTION_SECONDS;
  if (typeof raw !== "string" || !/^[0-9]{1,10}$/.test(raw)) throw new WhatsAppInboxError("retention_not_configured");
  const seconds = Number(raw);
  if (seconds < WHATSAPP_INBOX_MIN_RETENTION_SECONDS || seconds > WHATSAPP_INBOX_MAX_RETENTION_SECONDS) {
    throw new WhatsAppInboxError("retention_not_configured");
  }
  return seconds;
}

/** Confere o contexto antes de qualquer banco: confiável, do ambiente atual. */
function requireTrustedChannel(channel: unknown): ResolvedWhatsAppChannelContext {
  if (!isTrustedWhatsAppChannelContext(channel)) throw new WhatsAppInboxError("channel_context_untrusted");
  if (channel.environment !== getWhatsAppEnvironment()) throw new WhatsAppInboxError("channel_environment_mismatch");
  return channel;
}

function channelArgs(channel: ResolvedWhatsAppChannelContext) {
  return {
    p_channel_id: channel.channelId,
    p_workspace_id: channel.workspaceId,
    p_provider: channel.provider,
    p_routing_key: channel.routingKey,
  };
}

function cipherContext(channel: ResolvedWhatsAppChannelContext, providerEventId: string): InboxCipherContext {
  return {
    environment: channel.environment,
    workspaceId: channel.workspaceId,
    channelId: channel.channelId,
    provider: channel.provider,
    providerEventId,
  };
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

// ---------------------------------------------------------------------
// Gravação
// ---------------------------------------------------------------------

export type WhatsAppInboxOutcome = "inserted" | "duplicate" | "conflict";

const storeResultSchema = z.object({
  outcome: z.enum(["inserted", "duplicate", "conflict"]),
  inbox_id: uuidSchema,
});

/**
 * Grava uma entrega autêntica. O id do evento e o tipo BRUTO saem da
 * inspeção mínima do envelope do PRÓPRIO corpo verificado (nunca de um
 * parâmetro solto), e cada entrega tem de ser um evento só. A normalização
 * completa não roda aqui. Resultado:
 *  - `inserted`: primeira entrega;
 *  - `duplicate`: mesmo canal, id e hash (inclusive depois do expurgo);
 *  - `conflict`: mesmo canal e id, bytes diferentes — o primeiro payload
 *    fica intacto e o novo não é guardado nem processado.
 */
export async function storeWhatsAppWebhookDelivery(params: {
  channel: ResolvedWhatsAppChannelContext;
  adapter: WhatsAppProvider;
  verified: VerifiedWebhookBody;
  nowMs?: number | undefined;
}): Promise<{ outcome: WhatsAppInboxOutcome; inboxId: string }> {
  const channel = requireTrustedChannel(params.channel);
  if (!VerifiedWebhookBody.is(params.verified)) throw new WhatsAppInboxError("unverified_body");
  if (!params.adapter || params.adapter.kind !== channel.provider) throw new WhatsAppInboxError("provider_mismatch");
  const retentionSeconds = getWhatsAppInboxRetentionSeconds();

  const inspected = params.adapter.inspectEnvelope(params.verified);
  if (!inspected.ok) {
    if (inspected.reason === "batch_not_supported") throw new WhatsAppInboxError("inbox_batch_not_supported");
    if (inspected.reason === "unsupported_envelope_version") throw new WhatsAppInboxError("unsupported_envelope_version");
    if (inspected.reason === "unverified_body") throw new WhatsAppInboxError("unverified_body");
    throw new WhatsAppInboxError("invalid_payload");
  }
  const envelope = inspected.envelope;
  if (envelope.eventCount !== 1) throw new WhatsAppInboxError("inbox_batch_not_supported");

  const bytes = params.verified.copyBytes();
  let encrypted: EncryptedInboxBody;
  try {
    encrypted = encryptWhatsAppInboxBody(bytes, cipherContext(channel, envelope.providerEventId));
  } catch (error) {
    throw cryptoError(error, "invalid_inbox_event");
  }

  const nowMs = params.nowMs ?? Date.now();
  const admin = createWhatsAppAdminSupabaseClient();
  const { data, error } = await admin.rpc("whatsapp_inbox_store", {
    ...channelArgs(channel),
    p_provider_event_id: envelope.providerEventId,
    p_provider_event_type: envelope.providerEventType,
    p_body_sha256: sha256Hex(bytes),
    p_key_version: encrypted.keyVersion,
    p_nonce: encrypted.nonce,
    p_ciphertext: encrypted.ciphertext,
    p_auth_tag: encrypted.authTag,
    p_retain_until: new Date(nowMs + retentionSeconds * 1000).toISOString(),
  });
  if (error) throw toInboxError(error);
  const parsed = storeResultSchema.safeParse(data);
  if (!parsed.success) throw new WhatsAppInboxError("unknown");
  return { outcome: parsed.data.outcome, inboxId: parsed.data.inbox_id };
}

// ---------------------------------------------------------------------
// Leitura de pendente (para o processamento da B3.2d)
// ---------------------------------------------------------------------

const pendingRowSchema = z.object({
  inbox_id: uuidSchema,
  channel_id: uuidSchema,
  workspace_id: uuidSchema,
  environment: z.enum(["production", "preview"]),
  provider: z.enum(["simulated", "ycloud", "meta"]),
  routing_key: z.string(),
  provider_event_id: z.string(),
  provider_event_type: z.string(),
  body_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  key_version: z.string(),
  nonce: z.string(),
  ciphertext: z.string(),
  auth_tag: z.string(),
});

export type PendingWhatsAppWebhookDelivery = {
  inboxId: string;
  providerEventId: string;
  /** Tipo BRUTO do provedor. O tipo normalizado só existe depois da
   * normalização (B3.2d). */
  providerEventType: string;
  /** Os bytes exatos da entrega, verificados na chegada e conferidos agora
   * contra o hash gravado. */
  verified: VerifiedWebhookBody;
};

/**
 * Lê UMA entrega pendente pelo contexto confiável. Antes de decifrar: a
 * linha tem de ser exatamente a do contexto (entrada, canal, workspace,
 * ambiente, provedor, routing key). A AAD é montada do CONTEXTO, nunca da
 * linha. Depois de decifrar: o SHA-256 tem de conferir com o gravado.
 */
export async function readPendingWhatsAppWebhookDelivery(params: {
  channel: ResolvedWhatsAppChannelContext;
  inboxId: string;
}): Promise<PendingWhatsAppWebhookDelivery | null> {
  const channel = requireTrustedChannel(params.channel);
  const admin = createWhatsAppAdminSupabaseClient();
  const { data, error } = await admin.rpc("whatsapp_inbox_get_pending", { p_inbox_id: params.inboxId, ...channelArgs(channel) });
  if (error) throw toInboxError(error);
  if (!Array.isArray(data)) throw new WhatsAppInboxError("unknown");
  if (data.length === 0) return null;
  if (data.length > 1) throw new WhatsAppInboxError("channel_context_mismatch");

  const parsed = pendingRowSchema.safeParse(data[0]);
  if (!parsed.success) throw new WhatsAppInboxError("unknown");
  const row = parsed.data;
  if (
    row.inbox_id !== params.inboxId ||
    row.channel_id !== channel.channelId ||
    row.workspace_id !== channel.workspaceId ||
    row.environment !== channel.environment ||
    row.provider !== channel.provider ||
    row.routing_key !== channel.routingKey
  ) {
    throw new WhatsAppInboxError("channel_context_mismatch");
  }

  let bytes: Uint8Array;
  try {
    bytes = decryptWhatsAppInboxBody(
      { keyVersion: row.key_version, nonce: row.nonce, ciphertext: row.ciphertext, authTag: row.auth_tag },
      cipherContext(channel, row.provider_event_id),
    );
  } catch (error) {
    throw cryptoError(error, "inbox_decrypt_failed");
  }
  const expected = Buffer.from(row.body_sha256, "hex");
  const actual = createHash("sha256").update(bytes).digest();
  if (!timingSafeEqual(actual, expected)) throw new WhatsAppInboxError("inbox_integrity_failed");

  return {
    inboxId: row.inbox_id,
    providerEventId: row.provider_event_id,
    providerEventType: row.provider_event_type,
    verified: VerifiedWebhookBody.afterSignatureCheck(bytes),
  };
}

// ---------------------------------------------------------------------
// Estados, listagem e expurgo — só metadado
// ---------------------------------------------------------------------

const safeEntrySchema = z.object({
  id: uuidSchema,
  provider_event_id: z.string(),
  provider_event_type: z.string(),
  body_sha256: z.string(),
  received_at: z.string(),
  retain_until: z.string(),
  state: z.enum(["pending", "processed", "failed"]),
  processed_at: z.string().nullable(),
  failed_at: z.string().nullable(),
  purged_at: z.string().nullable(),
  error_code: z.string().nullable(),
  conflict_count: z.number().int().nonnegative(),
  last_conflict_at: z.string().nullable(),
});

export type WhatsAppInboxEntry = {
  id: string;
  providerEventId: string;
  providerEventType: string;
  bodySha256: string;
  receivedAt: string;
  retainUntil: string;
  state: "pending" | "processed" | "failed";
  processedAt: string | null;
  failedAt: string | null;
  purgedAt: string | null;
  errorCode: string | null;
  conflictCount: number;
  lastConflictAt: string | null;
};

/** Monta a entrada SÓ com os campos conhecidos: um campo novo do banco (ou
 * texto cifrado por engano) não atravessa para a aplicação. */
function mapEntry(row: unknown): WhatsAppInboxEntry {
  const parsed = safeEntrySchema.safeParse(row);
  if (!parsed.success) throw new WhatsAppInboxError("unknown");
  const r = parsed.data;
  return {
    id: r.id,
    providerEventId: r.provider_event_id,
    providerEventType: r.provider_event_type,
    bodySha256: r.body_sha256,
    receivedAt: r.received_at,
    retainUntil: r.retain_until,
    state: r.state,
    processedAt: r.processed_at,
    failedAt: r.failed_at,
    purgedAt: r.purged_at,
    errorCode: r.error_code,
    conflictCount: r.conflict_count,
    lastConflictAt: r.last_conflict_at,
  };
}

/** Pendente → processado. Repetir é idempotente; falho não vira processado
 * (nova tentativa é política da B3.2c/B3.2d). */
export async function markWhatsAppWebhookDeliveryProcessed(params: {
  channel: ResolvedWhatsAppChannelContext;
  inboxId: string;
}): Promise<WhatsAppInboxEntry> {
  const channel = requireTrustedChannel(params.channel);
  const admin = createWhatsAppAdminSupabaseClient();
  const { data, error } = await admin.rpc("whatsapp_inbox_mark_processed", { p_inbox_id: params.inboxId, ...channelArgs(channel) });
  if (error) throw toInboxError(error);
  return mapEntry(data);
}

const ERROR_CODE = /^[a-z0-9_]{1,64}$/;

/** Pendente → falho, com código simbólico (nunca mensagem ou conteúdo). */
export async function markWhatsAppWebhookDeliveryFailed(params: {
  channel: ResolvedWhatsAppChannelContext;
  inboxId: string;
  errorCode: string;
}): Promise<WhatsAppInboxEntry> {
  const channel = requireTrustedChannel(params.channel);
  if (typeof params.errorCode !== "string" || !ERROR_CODE.test(params.errorCode)) throw new WhatsAppInboxError("invalid_error_code");
  const admin = createWhatsAppAdminSupabaseClient();
  const { data, error } = await admin.rpc("whatsapp_inbox_mark_failed", {
    p_inbox_id: params.inboxId,
    ...channelArgs(channel),
    p_error_code: params.errorCode,
  });
  if (error) throw toInboxError(error);
  return mapEntry(data);
}

export async function listWhatsAppWebhookInbox(params: {
  channel: ResolvedWhatsAppChannelContext;
  limit: number;
}): Promise<WhatsAppInboxEntry[]> {
  const channel = requireTrustedChannel(params.channel);
  if (!Number.isInteger(params.limit) || params.limit < 1 || params.limit > 200) throw new WhatsAppInboxError("invalid_limit");
  const admin = createWhatsAppAdminSupabaseClient();
  const { data, error } = await admin.rpc("whatsapp_inbox_list", { ...channelArgs(channel), p_limit: params.limit });
  if (error) throw toInboxError(error);
  if (!Array.isArray(data)) throw new WhatsAppInboxError("unknown");
  return data.map(mapEntry);
}

const purgeResultSchema = z.object({ purged: z.number().int().nonnegative() });

/** Expurgo das entregas vencidas do ambiente atual (para o agendador
 * futuro): apaga a cifra e deixa o tombstone. Repetir não faz nada. */
export async function purgeExpiredWhatsAppWebhookInbox(params: { limit: number }): Promise<{ purged: number }> {
  if (!Number.isInteger(params.limit) || params.limit < 1 || params.limit > 5000) throw new WhatsAppInboxError("invalid_limit");
  const admin = createWhatsAppAdminSupabaseClient();
  const { data, error } = await admin.rpc("whatsapp_inbox_purge_expired", { p_limit: params.limit });
  if (error) throw toInboxError(error);
  const parsed = purgeResultSchema.safeParse(data);
  if (!parsed.success) throw new WhatsAppInboxError("unknown");
  return { purged: parsed.data.purged };
}
