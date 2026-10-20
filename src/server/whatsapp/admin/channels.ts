import { randomBytes, randomUUID } from "node:crypto";

import { z } from "zod";

import { uuidSchema } from "@/lib/uuid";
import { createWhatsAppAdminSupabaseClient } from "@/server/whatsapp/admin/supabase";
import {
  decryptWhatsAppCredential,
  encryptWhatsAppCredential,
  type WhatsAppCredentialPurpose,
} from "@/server/whatsapp/credential-crypto";
import { getWhatsAppEnvironment, type WhatsAppEnvironment } from "@/server/whatsapp/environment";
import { resolveWhatsAppProvider, type WhatsAppProviderEnv } from "@/server/whatsapp/provider";
import type { WhatsAppProvider, WhatsAppProviderKind } from "@/server/whatsapp/provider/contract";

/**
 * Operações de canal de WhatsApp (B3.1). Só chamadas DEPOIS de a sessão ter
 * sido verificada e autorizada (`requirePermissionSafe('channel.manage')`):
 * `workspaceId` e `actorUserId` vêm dessa verificação, nunca do
 * formulário. As funções do banco revalidam papel, workspace e ambiente.
 *
 * Nada daqui devolve credencial, texto cifrado ou versão de chave: a
 * projeção segura é montada no banco e filtrada de novo aqui. A única
 * exceção são as leituras internas de credencial (fim do arquivo), que
 * exigem um contexto de canal resolvido aqui dentro.
 */

export type WhatsAppChannelStatus = "active" | "paused" | "disconnected" | "disabled";

export type SafeWhatsAppChannel = {
  id: string;
  label: string;
  provider: WhatsAppProviderKind;
  environment: WhatsAppEnvironment;
  routingKey: string;
  displayPhoneNumber: string;
  isSimulator: boolean;
  status: WhatsAppChannelStatus;
  sendEnabled: boolean;
  statusChangedAt: string | null;
  createdAt: string;
  updatedAt: string;
  credentialPurposes: WhatsAppCredentialPurpose[];
};

/** Códigos simbólicos que as funções do banco levantam. Qualquer outra
 * falha vira `unknown` — a mensagem original nunca é repassada. */
export const WHATSAPP_CHANNEL_ERROR_CODES = [
  "whatsapp_environment_required",
  "actor_required",
  "insufficient_permission",
  "channel_not_found",
  "channel_routing_key_taken",
  "invalid_channel_state",
  "invalid_channel_label",
  "invalid_routing_key",
  "invalid_display_phone_number",
  "invalid_channel_data",
  "invalid_credential",
  "credential_purpose_not_allowed",
  "channel_environment_mismatch",
  "channel_context_untrusted",
  "channel_context_mismatch",
  "provider_mismatch",
  "credential_not_found",
  "whatsapp_provider_unavailable",
] as const;

export type WhatsAppChannelErrorCode = (typeof WHATSAPP_CHANNEL_ERROR_CODES)[number] | "unknown";

export class WhatsAppChannelStoreError extends Error {
  constructor(public readonly code: WhatsAppChannelErrorCode) {
    super(code);
    this.name = "WhatsAppChannelStoreError";
  }
}

const KNOWN = new Set<string>(WHATSAPP_CHANNEL_ERROR_CODES);

export function toChannelStoreError(error: { message?: string } | null | undefined): WhatsAppChannelStoreError {
  const message = error?.message ?? "";
  return new WhatsAppChannelStoreError(KNOWN.has(message) ? (message as WhatsAppChannelErrorCode) : "unknown");
}

const safeRowSchema = z.object({
  id: uuidSchema,
  label: z.string(),
  provider: z.enum(["simulated", "ycloud", "meta"]),
  environment: z.enum(["production", "preview"]),
  routing_key: z.string(),
  display_phone_number: z.string(),
  is_simulator: z.boolean(),
  status: z.enum(["active", "paused", "disconnected", "disabled"]),
  send_enabled: z.boolean(),
  status_changed_at: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  credential_purposes: z.array(z.enum(["api_key", "webhook_secret"])),
});

/** Monta o canal SÓ com os campos conhecidos: um campo novo que o banco
 * passe a devolver não atravessa para a aplicação sem revisão. */
export function mapSafeChannel(row: unknown): SafeWhatsAppChannel {
  const parsed = safeRowSchema.safeParse(row);
  if (!parsed.success) throw new WhatsAppChannelStoreError("unknown");
  const r = parsed.data;
  if (r.environment !== getWhatsAppEnvironment()) throw new WhatsAppChannelStoreError("channel_environment_mismatch");
  return {
    id: r.id,
    label: r.label,
    provider: r.provider,
    environment: r.environment,
    routingKey: r.routing_key,
    displayPhoneNumber: r.display_phone_number,
    isSimulator: r.is_simulator,
    status: r.status,
    sendEnabled: r.send_enabled,
    statusChangedAt: r.status_changed_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    credentialPurposes: r.credential_purposes,
  };
}

type Actor = { workspaceId: string; actorUserId: string };
type ChannelRef = Actor & { channelId: string };

export async function adminListWhatsAppChannels(params: Actor): Promise<SafeWhatsAppChannel[]> {
  const admin = createWhatsAppAdminSupabaseClient();
  const { data, error } = await admin.rpc("whatsapp_list_channels", {
    p_workspace_id: params.workspaceId,
    p_actor_user_id: params.actorUserId,
  });
  if (error) throw toChannelStoreError(error);
  if (!Array.isArray(data)) throw new WhatsAppChannelStoreError("unknown");
  return data.map(mapSafeChannel);
}

export async function adminGetWhatsAppChannelState(params: ChannelRef): Promise<SafeWhatsAppChannel> {
  const admin = createWhatsAppAdminSupabaseClient();
  const { data, error } = await admin.rpc("whatsapp_get_channel_state", {
    p_channel_id: params.channelId,
    p_workspace_id: params.workspaceId,
    p_actor_user_id: params.actorUserId,
  });
  if (error) throw toChannelStoreError(error);
  return mapSafeChannel(data);
}

/**
 * Canal SIMULADO, com um segredo simulado de webhook gerado aqui, cifrado
 * com a AAD do próprio canal e gravado na mesma transação. O segredo em
 * claro só existe nesta função e nunca é devolvido.
 */
export async function adminCreateSimulatedWhatsAppChannel(
  params: Actor & { label: string; routingKey: string; displayPhoneNumber: string },
): Promise<SafeWhatsAppChannel> {
  const channelId = randomUUID();
  const encrypted = encryptWhatsAppCredential(randomBytes(32).toString("base64url"), {
    environment: getWhatsAppEnvironment(),
    workspaceId: params.workspaceId,
    channelId,
    provider: "simulated",
    purpose: "webhook_secret",
  });

  const admin = createWhatsAppAdminSupabaseClient();
  const { data, error } = await admin.rpc("whatsapp_create_simulated_channel", {
    p_channel_id: channelId,
    p_workspace_id: params.workspaceId,
    p_actor_user_id: params.actorUserId,
    p_label: params.label,
    p_routing_key: params.routingKey,
    p_display_phone_number: params.displayPhoneNumber,
    p_webhook_secret_ciphertext: encrypted.ciphertextBase64,
    p_key_version: encrypted.keyVersion,
  });
  if (error) throw toChannelStoreError(error);
  return mapSafeChannel(data);
}

export async function adminUpdateWhatsAppChannelSettings(
  params: ChannelRef & { label: string; displayPhoneNumber: string },
): Promise<SafeWhatsAppChannel> {
  const admin = createWhatsAppAdminSupabaseClient();
  const { data, error } = await admin.rpc("whatsapp_update_channel_settings", {
    p_channel_id: params.channelId,
    p_workspace_id: params.workspaceId,
    p_actor_user_id: params.actorUserId,
    p_label: params.label,
    p_display_phone_number: params.displayPhoneNumber,
  });
  if (error) throw toChannelStoreError(error);
  return mapSafeChannel(data);
}

type StateRpc = "whatsapp_pause_channel" | "whatsapp_reactivate_channel" | "whatsapp_disable_channel_send";

async function changeState(rpc: StateRpc, params: ChannelRef): Promise<SafeWhatsAppChannel> {
  const admin = createWhatsAppAdminSupabaseClient();
  const { data, error } = await admin.rpc(rpc, {
    p_channel_id: params.channelId,
    p_workspace_id: params.workspaceId,
    p_actor_user_id: params.actorUserId,
  });
  if (error) throw toChannelStoreError(error);
  return mapSafeChannel(data);
}

export const adminPauseWhatsAppChannel = (params: ChannelRef) => changeState("whatsapp_pause_channel", params);
export const adminReactivateWhatsAppChannel = (params: ChannelRef) => changeState("whatsapp_reactivate_channel", params);
export const adminDisableWhatsAppChannelSend = (params: ChannelRef) => changeState("whatsapp_disable_channel_send", params);

// ---------------------------------------------------------------------
// Contexto confiável do canal e leitura interna de credenciais
// ---------------------------------------------------------------------

declare const resolvedChannelBrand: unique symbol;

/**
 * Identidade completa de um canal, obtida SÓ por resolução interna:
 *  - `adminResolveManagedWhatsAppChannel` (sessão já autorizada: o banco
 *    confere papel, workspace e ambiente);
 *  - `adminResolveWhatsAppWebhookChannel` (webhook: pela routing key, no
 *    ambiente autenticado).
 * Um objeto montado à mão — com valores do formulário, por exemplo — não é
 * aceito: o tipo tem marca, e a execução confere o registro abaixo.
 */
export type ResolvedWhatsAppChannelContext = Readonly<{
  channelId: string;
  workspaceId: string;
  environment: WhatsAppEnvironment;
  provider: WhatsAppProviderKind;
  routingKey: string;
}> & { readonly [resolvedChannelBrand]: true };

const resolvedContexts = new WeakSet<object>();

function resolvedContext(fields: {
  channelId: string;
  workspaceId: string;
  environment: WhatsAppEnvironment;
  provider: WhatsAppProviderKind;
  routingKey: string;
}): ResolvedWhatsAppChannelContext {
  const context = Object.freeze({ ...fields }) as ResolvedWhatsAppChannelContext;
  resolvedContexts.add(context);
  return context;
}

function isResolvedContext(value: unknown): value is ResolvedWhatsAppChannelContext {
  return typeof value === "object" && value !== null && resolvedContexts.has(value);
}

/** Canal administrado pela sessão: `workspaceId` e `actorUserId` vêm da
 * verificação da sessão; o banco confere papel, workspace e ambiente. */
export async function adminResolveManagedWhatsAppChannel(
  params: ChannelRef,
): Promise<{ channel: SafeWhatsAppChannel; context: ResolvedWhatsAppChannelContext }> {
  const channel = await adminGetWhatsAppChannelState(params);
  if (channel.id !== params.channelId) throw new WhatsAppChannelStoreError("channel_context_mismatch");
  return {
    channel,
    context: resolvedContext({
      channelId: channel.id,
      workspaceId: params.workspaceId,
      environment: channel.environment,
      provider: channel.provider,
      routingKey: channel.routingKey,
    }),
  };
}

const credentialRowSchema = z.object({
  channel_id: uuidSchema,
  workspace_id: uuidSchema,
  environment: z.enum(["production", "preview"]),
  provider: z.enum(["simulated", "ycloud", "meta"]),
  routing_key: z.string(),
  purpose: z.enum(["api_key", "webhook_secret"]),
  ciphertext: z.string(),
  key_version: z.string(),
});

/**
 * Lê e decifra uma credencial, para uso INTERNO do servidor. Nunca expor o
 * retorno em resposta de ação, log ou erro.
 *
 * Antes do banco: contexto resolvido internamente, ambiente atual e
 * `adapter.kind === canal.provider`. O banco recebe a identidade inteira do
 * canal e recusa qualquer divergência. Antes de decifrar: a linha devolvida
 * tem de ser exatamente a do contexto (canal, workspace, ambiente, provedor,
 * routing key e propósito). A AAD é montada do CONTEXTO, nunca da linha.
 */
export async function adminReadWhatsAppChannelCredential(params: {
  channel: ResolvedWhatsAppChannelContext;
  adapter: WhatsAppProvider;
  purpose: WhatsAppCredentialPurpose;
}): Promise<string | null> {
  const { channel, adapter, purpose } = params;
  if (!isResolvedContext(channel)) throw new WhatsAppChannelStoreError("channel_context_untrusted");
  if (channel.environment !== getWhatsAppEnvironment()) throw new WhatsAppChannelStoreError("channel_environment_mismatch");
  if (!adapter || adapter.kind !== channel.provider) throw new WhatsAppChannelStoreError("provider_mismatch");

  const admin = createWhatsAppAdminSupabaseClient();
  const { data, error } = await admin.rpc("whatsapp_get_channel_credential", {
    p_channel_id: channel.channelId,
    p_workspace_id: channel.workspaceId,
    p_provider: channel.provider,
    p_routing_key: channel.routingKey,
    p_purpose: purpose,
  });
  if (error) throw toChannelStoreError(error);
  if (!Array.isArray(data)) throw new WhatsAppChannelStoreError("unknown");
  if (data.length === 0) return null;
  if (data.length > 1) throw new WhatsAppChannelStoreError("channel_context_mismatch");

  const parsed = credentialRowSchema.safeParse(data[0]);
  if (!parsed.success) throw new WhatsAppChannelStoreError("unknown");
  const row = parsed.data;
  if (row.provider !== channel.provider || row.provider !== adapter.kind) {
    throw new WhatsAppChannelStoreError("provider_mismatch");
  }
  if (
    row.channel_id !== channel.channelId ||
    row.workspace_id !== channel.workspaceId ||
    row.environment !== channel.environment ||
    row.routing_key !== channel.routingKey ||
    row.purpose !== purpose
  ) {
    throw new WhatsAppChannelStoreError("channel_context_mismatch");
  }

  return decryptWhatsAppCredential(row.ciphertext, row.key_version, {
    environment: channel.environment,
    workspaceId: channel.workspaceId,
    channelId: channel.channelId,
    provider: channel.provider,
    purpose,
  });
}

/**
 * Prepara uma chamada ao provedor do canal: escolhe o adaptador pelo
 * provedor GRAVADO no canal (a variável de ambiente só habilita) e só então
 * lê a credencial. Vale, antes de qualquer banco adicional ou rede:
 * `adapter.kind === canal.provider === credencial.provider`.
 */
export async function adminPrepareWhatsAppChannelCall(params: {
  channel: ResolvedWhatsAppChannelContext;
  purpose: WhatsAppCredentialPurpose;
  env?: WhatsAppProviderEnv | undefined;
}): Promise<{ adapter: WhatsAppProvider; credential: string }> {
  if (!isResolvedContext(params.channel)) throw new WhatsAppChannelStoreError("channel_context_untrusted");
  const resolution = resolveWhatsAppProvider({ channelProvider: params.channel.provider, env: params.env });
  if (resolution.status !== "enabled") throw new WhatsAppChannelStoreError("whatsapp_provider_unavailable");

  const credential = await adminReadWhatsAppChannelCredential({
    channel: params.channel,
    adapter: resolution.provider,
    purpose: params.purpose,
  });
  if (credential === null) throw new WhatsAppChannelStoreError("credential_not_found");
  return { adapter: resolution.provider, credential };
}

const webhookRowSchema = z.object({
  channel_id: uuidSchema,
  workspace_id: uuidSchema,
  environment: z.enum(["production", "preview"]),
  provider: z.enum(["simulated", "ycloud", "meta"]),
  routing_key: z.string(),
  status: z.enum(["active", "paused", "disconnected"]),
  ciphertext: z.string(),
  key_version: z.string(),
});

export type ResolvedWhatsAppWebhookChannel = {
  adapter: WhatsAppProvider;
  channel: ResolvedWhatsAppChannelContext;
  status: "active" | "paused" | "disconnected";
  webhookSecret: string;
};

/**
 * Resolução do canal para o WEBHOOK (a rota real é da B3.2): pelo
 * identificador de roteamento que o provedor manda, no ambiente
 * autenticado, numa única consulta que devolve canal + segredo do webhook
 * (nunca a chave de API). Sem ator: o workspace vem da linha do canal, e a
 * AAD da cifra amarra o segredo a essa mesma identidade. O segredo
 * devolvido serve só para conferir a assinatura; o contexto resolvido é o
 * que as etapas seguintes usam.
 *
 * Provedor não habilitado → recusado antes do banco.
 */
export async function adminResolveWhatsAppWebhookChannel(params: {
  provider: WhatsAppProviderKind;
  routingKey: string;
  env?: WhatsAppProviderEnv | undefined;
}): Promise<ResolvedWhatsAppWebhookChannel | null> {
  const resolution = resolveWhatsAppProvider({ channelProvider: params.provider, env: params.env });
  if (resolution.status !== "enabled") throw new WhatsAppChannelStoreError("whatsapp_provider_unavailable");
  const adapter = resolution.provider;
  if (adapter.kind !== params.provider) throw new WhatsAppChannelStoreError("provider_mismatch");
  if (typeof params.routingKey !== "string" || params.routingKey.length === 0 || params.routingKey.length > 128) {
    return null;
  }

  const admin = createWhatsAppAdminSupabaseClient();
  const { data, error } = await admin.rpc("whatsapp_resolve_webhook_channel", {
    p_provider: params.provider,
    p_routing_key: params.routingKey,
  });
  if (error) throw toChannelStoreError(error);
  if (!Array.isArray(data)) throw new WhatsAppChannelStoreError("unknown");
  if (data.length === 0) return null;
  if (data.length > 1) throw new WhatsAppChannelStoreError("channel_context_mismatch");

  const parsed = webhookRowSchema.safeParse(data[0]);
  if (!parsed.success) throw new WhatsAppChannelStoreError("unknown");
  const row = parsed.data;
  if (row.environment !== getWhatsAppEnvironment()) throw new WhatsAppChannelStoreError("channel_environment_mismatch");
  if (row.provider !== params.provider || row.provider !== adapter.kind) {
    throw new WhatsAppChannelStoreError("provider_mismatch");
  }
  if (row.routing_key !== params.routingKey) throw new WhatsAppChannelStoreError("channel_context_mismatch");

  const channel = resolvedContext({
    channelId: row.channel_id,
    workspaceId: row.workspace_id,
    environment: row.environment,
    provider: row.provider,
    routingKey: row.routing_key,
  });
  const webhookSecret = decryptWhatsAppCredential(row.ciphertext, row.key_version, {
    environment: channel.environment,
    workspaceId: channel.workspaceId,
    channelId: channel.channelId,
    provider: channel.provider,
    purpose: "webhook_secret",
  });
  return { adapter, channel, status: row.status, webhookSecret };
}
