import { createHash, timingSafeEqual } from "node:crypto";

import { z } from "zod";

import { uuidSchema } from "@/lib/uuid";
import {
  isTrustedWhatsAppChannelContext,
  type ResolvedWhatsAppChannelContext,
  type WhatsAppChannelStatus,
} from "@/server/whatsapp/admin/channels";
import { createWhatsAppAdminSupabaseClient } from "@/server/whatsapp/admin/supabase";
import { getWhatsAppEnvironment, type WhatsAppEnvironment } from "@/server/whatsapp/environment";
import {
  decryptWhatsAppInboxBody,
  encryptWhatsAppInboxBody,
  WhatsAppInboxCryptoError,
  type EncryptedInboxBody,
  type InboxCipherContext,
} from "@/server/whatsapp/inbox-crypto";
import { VerifiedWebhookBody, type WhatsAppProvider, type WhatsAppProviderKind } from "@/server/whatsapp/provider/contract";

/**
 * Caixa de entrada CIFRADA do webhook de WhatsApp (B3.2b,
 * docs/decisoes/b3-whatsapp-real.md §17) e o claim atômico do consumidor
 * (B3.2d-1, §19).
 *
 * Armazenamento durável e idempotente de cada entrega autêntica. Nada daqui
 * processa mensagem, cria contato, lead ou conversa, nem fala com provedor:
 * a rota é da B3.2c; a normalização e o domínio, da B3.2d-2.
 *
 * A gravação só aceita:
 *  - bytes já representados por `VerifiedWebhookBody` (assinatura conferida
 *    pelo adaptador);
 *  - o contexto CONFIÁVEL do canal produzido pela resolução interna
 *    (`adminResolveWhatsAppWebhookChannel`). Um objeto montado à mão, ou uma
 *    cópia do contexto, não autoriza nada.
 *
 * A gravação acontece ANTES da normalização completa: do corpo só se lê o
 * envelope mínimo (id do evento, tipo bruto, versão, um evento só). Um
 * evento autêntico cujo conteúdo o normalizador recusa é guardado do mesmo
 * jeito; a falha de normalização é tratada depois (B3.2d-2).
 *
 * O corpo vai cifrado (chave e AAD próprias da inbox); o banco recebe só
 * metadado, hash e texto cifrado, e confere de novo ambiente e identidade do
 * canal. Retenção: `WHATSAPP_INBOX_RETENTION_SECONDS` (configuração
 * confiável, sem padrão, até 30 dias), mandada ao banco em SEGUNDOS: o
 * prazo é calculado lá, a partir do horário de recebimento do próprio
 * banco, e o relógio da aplicação não entra. Sem valor válido, falha
 * fechada.
 *
 * Ler o corpo de uma entrada e mudar o estado dela só acontece pelo claim
 * (`claimWhatsAppInboxEntry`): não existe leitura nem marcação sem token.
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
  "inbox_key_version_unknown",
  "inbox_decrypt_failed",
  "inbox_integrity_failed",
  "invalid_inbox_event",
  "invalid_inbox_hash",
  "invalid_inbox_ciphertext",
  "invalid_retention",
  "invalid_error_code",
  "invalid_disposition",
  "invalid_limit",
  "invalid_lease",
  "inbox_claim_invalid",
  "inbox_claim_untrusted",
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
  if (error instanceof WhatsAppInboxCryptoError && error.code === "unknown_key_version") {
    return new WhatsAppInboxError("inbox_key_version_unknown");
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
 * Nos dois últimos, o prazo da primeira entrega também fica intacto.
 */
export async function storeWhatsAppWebhookDelivery(params: {
  channel: ResolvedWhatsAppChannelContext;
  adapter: WhatsAppProvider;
  verified: VerifiedWebhookBody;
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
    p_retention_seconds: retentionSeconds,
  });
  if (error) throw toInboxError(error);
  const parsed = storeResultSchema.safeParse(data);
  if (!parsed.success) throw new WhatsAppInboxError("unknown");
  return { outcome: parsed.data.outcome, inboxId: parsed.data.inbox_id };
}

// ---------------------------------------------------------------------
// Claim (B3.2d-1): a única porta para ler o corpo e mudar o estado
// ---------------------------------------------------------------------

/** Lease de 15 s a 15 min; 5 min quando o chamador não informa. */
export const WHATSAPP_INBOX_MIN_LEASE_SECONDS = 15;
export const WHATSAPP_INBOX_MAX_LEASE_SECONDS = 900;
export const WHATSAPP_INBOX_DEFAULT_LEASE_SECONDS = 300;

declare const inboxClaimBrand: unique symbol;

/**
 * Entrada de posse exclusiva deste worker até `leaseUntil`. O contexto foi
 * montado no servidor a partir da linha do banco (nada do evento interno),
 * e `verified` só existe depois de decifrar com a AAD desse contexto e
 * conferir o SHA-256. O token do claim NÃO é propriedade do objeto: fica
 * num registro interno, e só as finalizações abaixo o usam.
 *
 * A posse termina em `leaseUntil`, mesmo que nenhum outro worker tenha
 * reclamado a entrada: depois disso o banco responde `claim_lost` também
 * ao token deste claim. A identidade é a do objeto em memória (WeakMap):
 * o claim NÃO atravessa serialização, retorno de `step.run`, fila ou outra
 * execução — uma cópia não finaliza nada. Claim, normalização, efeito e
 * finalização acontecem na mesma execução lógica (B3.2d-2), e nenhuma
 * operação externa ou efeito no domínio pode presumir que um claim
 * serializado continua válido.
 */
export type WhatsAppInboxClaim = Readonly<{
  inboxId: string;
  environment: WhatsAppEnvironment;
  workspaceId: string;
  channelId: string;
  /** Estado ATUAL do canal. Aplicar ou não ao domínio é da B3.2d-2. */
  channelStatus: WhatsAppChannelStatus;
  provider: WhatsAppProviderKind;
  routingKey: string;
  providerEventId: string;
  /** Tipo BRUTO do provedor; o normalizado só existe depois da B3.2d-2. */
  providerEventType: string;
  receivedAt: string;
  retainUntil: string;
  /** Aquisições de processamento desta entrada, contando esta. */
  claimCount: number;
  /** SHA-256 gravado na linha; o consumidor o confere de novo (B3.2d-2a). */
  bodySha256: string;
  claimedAt: string;
  leaseUntil: string;
  verified: VerifiedWebhookBody;
}> & { readonly [inboxClaimBrand]: true };

export type WhatsAppInboxClaimResult =
  | { outcome: "claimed"; claim: WhatsAppInboxClaim }
  | { outcome: "busy" | "already_processed" | "terminal_failed" | "expired" | "not_found" };

/** Token de cada claim emitido aqui. Um objeto montado à mão ou copiado não
 * está no registro e não finaliza nada. */
const claimTokens = new WeakMap<object, { inboxId: string; token: string }>();

const ERROR_CODE = /^[a-z0-9_]{1,64}$/;

const claimedRowSchema = z
  .object({
    outcome: z.literal("claimed"),
    inbox_id: uuidSchema,
    claim_token: uuidSchema,
    claim_count: z.number().int().min(1),
    claimed_at: z.string().min(1),
    lease_until: z.string().min(1),
    environment: z.enum(["production", "preview"]),
    workspace_id: uuidSchema,
    channel_id: uuidSchema,
    channel_status: z.enum(["active", "paused", "disconnected", "disabled"]),
    provider: z.enum(["simulated", "ycloud", "meta"]),
    routing_key: z.string().min(1).max(128),
    provider_event_id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
    provider_event_type: z.string().min(1).max(128),
    body_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    received_at: z.string().min(1),
    retain_until: z.string().min(1),
    key_version: z.string().min(1),
    nonce: z.string().min(1),
    ciphertext: z.string().min(1),
    auth_tag: z.string().min(1),
  })
  .strict();

const otherClaimSchema = z
  .object({ outcome: z.enum(["busy", "already_processed", "terminal_failed", "expired", "not_found"]) })
  .strict();

const finishSchema = z
  .object({ outcome: z.enum(["completed", "failed", "released", "already_processed", "terminal_failed", "claim_lost", "not_found"]) })
  .strict();

async function finish(
  rpc: "whatsapp_inbox_complete" | "whatsapp_inbox_fail" | "whatsapp_inbox_release" | "whatsapp_inbox_dispose",
  entry: { inboxId: string; token: string },
  code?: string,
) {
  const admin = createWhatsAppAdminSupabaseClient();
  const args =
    rpc === "whatsapp_inbox_complete"
      ? { p_inbox_id: entry.inboxId, p_claim_token: entry.token }
      : rpc === "whatsapp_inbox_dispose"
        ? { p_inbox_id: entry.inboxId, p_claim_token: entry.token, p_disposition: code! }
        : { p_inbox_id: entry.inboxId, p_claim_token: entry.token, p_error_code: code! };
  const { data, error } = await admin.rpc(rpc, args as never);
  if (error) throw toInboxError(error);
  const parsed = finishSchema.safeParse(data);
  if (!parsed.success) throw new WhatsAppInboxError("inbox_claim_invalid");
  return parsed.data;
}

/** Finalização de melhor esforço depois de uma conferência que falhou: o
 * erro original é o que o chamador recebe. */
async function finishQuietly(rpc: "whatsapp_inbox_fail" | "whatsapp_inbox_release", entry: { inboxId: string; token: string }, code: string) {
  try {
    await finish(rpc, entry, code);
  } catch {
    // Sem log: a lease vence e a entrada volta a ser reclamável.
  }
}

/**
 * Reclama uma entrada pelo `inboxId` vindo do evento interno — e SÓ por
 * ele: qualquer outro campo que o chamador passe é ignorado. O banco
 * resolve ambiente, workspace, canal, estado do canal, provedor e routing
 * key, trava a linha e emite um token novo. Antes de devolver o corpo:
 *  1. o retorno é conferido campo por campo (campo a mais, como corpo ou
 *     credencial, é recusado) e tem de ser da entrada pedida e do ambiente
 *     deste servidor;
 *  2. o corpo é decifrado com a AAD do contexto da linha;
 *  3. o SHA-256 dos bytes é comparado em tempo constante com o gravado.
 * Cifra ou integridade inválidas: a entrada falha de forma terminal
 * (`inbox_decrypt_failed`, `inbox_integrity_failed`). Chave da inbox
 * ausente ou versão desconhecida: a entrada é liberada para nova tentativa.
 */
export async function claimWhatsAppInboxEntry(params: { inboxId: string; leaseSeconds?: number }): Promise<WhatsAppInboxClaimResult> {
  const leaseSeconds = params.leaseSeconds ?? WHATSAPP_INBOX_DEFAULT_LEASE_SECONDS;
  if (
    !Number.isInteger(leaseSeconds) ||
    leaseSeconds < WHATSAPP_INBOX_MIN_LEASE_SECONDS ||
    leaseSeconds > WHATSAPP_INBOX_MAX_LEASE_SECONDS
  ) {
    throw new WhatsAppInboxError("invalid_lease");
  }
  const parsedId = uuidSchema.safeParse(params.inboxId);
  if (!parsedId.success) return { outcome: "not_found" };
  const inboxId = parsedId.data.toLowerCase();

  const admin = createWhatsAppAdminSupabaseClient();
  const { data, error } = await admin.rpc("whatsapp_inbox_claim", { p_inbox_id: inboxId, p_lease_seconds: leaseSeconds });
  if (error) throw toInboxError(error);

  const other = otherClaimSchema.safeParse(data);
  if (other.success) return { outcome: other.data.outcome };
  const parsed = claimedRowSchema.safeParse(data);
  if (!parsed.success) throw new WhatsAppInboxError("inbox_claim_invalid");
  const row = parsed.data;
  if (row.inbox_id !== inboxId) throw new WhatsAppInboxError("inbox_claim_invalid");
  if (row.environment !== getWhatsAppEnvironment()) throw new WhatsAppInboxError("channel_environment_mismatch");
  const entry = { inboxId: row.inbox_id, token: row.claim_token };

  let bytes: Uint8Array;
  try {
    bytes = decryptWhatsAppInboxBody(
      { keyVersion: row.key_version, nonce: row.nonce, ciphertext: row.ciphertext, authTag: row.auth_tag },
      {
        environment: row.environment,
        workspaceId: row.workspace_id,
        channelId: row.channel_id,
        provider: row.provider,
        providerEventId: row.provider_event_id,
      },
    );
  } catch (error) {
    if (error instanceof WhatsAppInboxCryptoError && (error.code === "not_configured" || error.code === "unknown_key_version")) {
      const code = error.code === "not_configured" ? "inbox_crypto_not_configured" : "inbox_key_version_unknown";
      await finishQuietly("whatsapp_inbox_release", entry, code);
      throw cryptoError(error, "inbox_decrypt_failed");
    }
    await finishQuietly("whatsapp_inbox_fail", entry, "inbox_decrypt_failed");
    throw new WhatsAppInboxError("inbox_decrypt_failed");
  }
  const expected = Buffer.from(row.body_sha256, "hex");
  const actual = createHash("sha256").update(bytes).digest();
  if (!timingSafeEqual(actual, expected)) {
    await finishQuietly("whatsapp_inbox_fail", entry, "inbox_integrity_failed");
    throw new WhatsAppInboxError("inbox_integrity_failed");
  }

  const claim = Object.freeze({
    inboxId: row.inbox_id,
    environment: row.environment,
    workspaceId: row.workspace_id,
    channelId: row.channel_id,
    channelStatus: row.channel_status,
    provider: row.provider,
    routingKey: row.routing_key,
    providerEventId: row.provider_event_id,
    providerEventType: row.provider_event_type,
    receivedAt: row.received_at,
    retainUntil: row.retain_until,
    claimCount: row.claim_count,
    bodySha256: row.body_sha256,
    claimedAt: row.claimed_at,
    leaseUntil: row.lease_until,
    verified: VerifiedWebhookBody.afterSignatureCheck(bytes),
  }) as WhatsAppInboxClaim;
  claimTokens.set(claim, entry);
  return { outcome: "claimed", claim };
}

function requireClaim(claim: unknown): { inboxId: string; token: string } {
  const entry = typeof claim === "object" && claim !== null ? claimTokens.get(claim) : undefined;
  if (!entry) throw new WhatsAppInboxError("inbox_claim_untrusted");
  return entry;
}

function requireErrorCode(code: unknown): string {
  if (typeof code !== "string" || !ERROR_CODE.test(code)) throw new WhatsAppInboxError("invalid_error_code");
  return code;
}

export type WhatsAppInboxFinishOutcome = z.infer<typeof finishSchema>["outcome"];

/** processing → processed, só com o token deste claim e a lease vigente.
 * Repetir devolve `already_processed`; lease vencida ou token substituído,
 * `claim_lost`. Os resultados do banco são repassados como vieram: nada é
 * repetido, e um `claim_lost` não dispara outra finalização. */
export async function completeWhatsAppInboxClaim(claim: WhatsAppInboxClaim): Promise<{ outcome: WhatsAppInboxFinishOutcome }> {
  return finish("whatsapp_inbox_complete", requireClaim(claim));
}

/** processing → failed (terminal), com código simbólico — nunca mensagem
 * de erro original ou conteúdo. */
export async function failWhatsAppInboxClaim(claim: WhatsAppInboxClaim, errorCode: string): Promise<{ outcome: WhatsAppInboxFinishOutcome }> {
  const entry = requireClaim(claim);
  return finish("whatsapp_inbox_fail", entry, requireErrorCode(errorCode));
}

/** processing → pending para nova tentativa (falha transitória), com código
 * simbólico. claim_count não volta: conta aquisições de processamento. */
export async function releaseWhatsAppInboxClaim(claim: WhatsAppInboxClaim, errorCode: string): Promise<{ outcome: WhatsAppInboxFinishOutcome }> {
  const entry = requireClaim(claim);
  return finish("whatsapp_inbox_release", entry, requireErrorCode(errorCode));
}

/**
 * Disposições de uma entrada finalizada SEM efeito no domínio (B3.2d-2a,
 * docs/decisoes/b3-whatsapp-real.md §20): lista fechada, igual à do banco.
 */
export const WHATSAPP_INBOX_DISPOSITIONS = [
  "ignored_history",
  "ignored_group_message",
  "ignored_non_whatsapp_product",
  "unsupported_event",
] as const;

export type WhatsAppInboxDisposition = (typeof WHATSAPP_INBOX_DISPOSITIONS)[number];

const DISPOSITIONS: ReadonlySet<string> = new Set(WHATSAPP_INBOX_DISPOSITIONS);

/** processing → processed SEM efeito no domínio, com a disposição, só com o
 * token deste claim e a lease vigente (a mesma regra do complete). Repetir
 * devolve `already_processed`; lease vencida ou token substituído,
 * `claim_lost`. Nada é repetido. */
export async function disposeWhatsAppInboxClaim(
  claim: WhatsAppInboxClaim,
  disposition: WhatsAppInboxDisposition,
): Promise<{ outcome: WhatsAppInboxFinishOutcome }> {
  const entry = requireClaim(claim);
  if (typeof disposition !== "string" || !DISPOSITIONS.has(disposition)) throw new WhatsAppInboxError("invalid_disposition");
  return finish("whatsapp_inbox_dispose", entry, disposition);
}

/** Efeito no domínio com este claim (B3.2d-2b2): a RPC do efeito recebe o
 * id da entrada e o token DESTE claim, que não saem daqui; os demais
 * argumentos são só do efeito. O banco confere estado, token e lease sob a
 * trava da linha. A resposta volta crua para o módulo do efeito conferir. */
export async function runWhatsAppInboxClaimEffect(
  claim: WhatsAppInboxClaim,
  rpc: "whatsapp_effect_inbound_message" | "whatsapp_effect_outbound_observed",
  args: Readonly<Record<string, unknown>>,
): Promise<{ data: unknown; error: { message?: string } | null }> {
  const entry = requireClaim(claim);
  if ("p_inbox_id" in args || "p_claim_token" in args) throw new WhatsAppInboxError("inbox_claim_invalid");
  const admin = createWhatsAppAdminSupabaseClient();
  const { data, error } = await admin.rpc(rpc, { ...args, p_inbox_id: entry.inboxId, p_claim_token: entry.token } as never);
  return { data, error };
}

// ---------------------------------------------------------------------
// Listagem e expurgo — só metadado
// ---------------------------------------------------------------------

const safeEntrySchema = z.object({
  id: uuidSchema,
  provider_event_id: z.string(),
  provider_event_type: z.string(),
  body_sha256: z.string(),
  received_at: z.string(),
  retain_until: z.string(),
  state: z.enum(["pending", "processing", "processed", "failed"]),
  processed_at: z.string().nullable(),
  failed_at: z.string().nullable(),
  purged_at: z.string().nullable(),
  error_code: z.string().nullable(),
  conflict_count: z.number().int().nonnegative(),
  last_conflict_at: z.string().nullable(),
  claim_count: z.number().int().nonnegative(),
  claimed_at: z.string().nullable(),
  lease_until: z.string().nullable(),
  last_release_code: z.string().nullable(),
  last_released_at: z.string().nullable(),
});

export type WhatsAppInboxEntry = {
  id: string;
  providerEventId: string;
  providerEventType: string;
  bodySha256: string;
  receivedAt: string;
  retainUntil: string;
  state: "pending" | "processing" | "processed" | "failed";
  processedAt: string | null;
  failedAt: string | null;
  purgedAt: string | null;
  errorCode: string | null;
  conflictCount: number;
  lastConflictAt: string | null;
  claimCount: number;
  claimedAt: string | null;
  leaseUntil: string | null;
  lastReleaseCode: string | null;
  lastReleasedAt: string | null;
};

/** Monta a entrada SÓ com os campos conhecidos: um campo novo do banco (ou
 * texto cifrado, ou o token do claim, por engano) não atravessa para a
 * aplicação. */
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
    claimCount: r.claim_count,
    claimedAt: r.claimed_at,
    leaseUntil: r.lease_until,
    lastReleaseCode: r.last_release_code,
    lastReleasedAt: r.last_released_at,
  };
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
 * futuro): apaga a cifra e deixa o tombstone. Uma entrada em processamento
 * também é expurgada, e o claim dela deixa de valer. Repetir não faz nada. */
export async function purgeExpiredWhatsAppWebhookInbox(params: { limit: number }): Promise<{ purged: number }> {
  if (!Number.isInteger(params.limit) || params.limit < 1 || params.limit > 5000) throw new WhatsAppInboxError("invalid_limit");
  const admin = createWhatsAppAdminSupabaseClient();
  const { data, error } = await admin.rpc("whatsapp_inbox_purge_expired", { p_limit: params.limit });
  if (error) throw toInboxError(error);
  const parsed = purgeResultSchema.safeParse(data);
  if (!parsed.success) throw new WhatsAppInboxError("unknown");
  return { purged: parsed.data.purged };
}
