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
import type { WhatsAppProviderKind } from "@/server/whatsapp/provider/contract";

/**
 * Operações de canal de WhatsApp (B3.1). Só chamadas DEPOIS de a sessão ter
 * sido verificada e autorizada (`requirePermissionSafe('channel.manage')`):
 * `workspaceId` e `actorUserId` vêm dessa verificação, nunca do
 * formulário. As funções do banco revalidam papel, workspace e ambiente.
 *
 * Nada daqui devolve credencial, texto cifrado ou versão de chave: a
 * projeção segura é montada no banco e filtrada de novo aqui.
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

/**
 * Lê e decifra uma credencial, para uso INTERNO do servidor (o adaptador
 * real, nas próximas etapas). Recusa linha de outro ambiente antes de
 * decifrar; a AAD garante o resto. Nunca expor o retorno em resposta de
 * ação, log ou erro.
 */
export async function adminReadWhatsAppChannelCredential(params: {
  channelId: string;
  purpose: WhatsAppCredentialPurpose;
}): Promise<string | null> {
  const admin = createWhatsAppAdminSupabaseClient();
  const { data, error } = await admin.rpc("whatsapp_get_channel_credential", {
    p_channel_id: params.channelId,
    p_purpose: params.purpose,
  });
  if (error) throw toChannelStoreError(error);
  const row = data?.[0];
  if (!row) return null;
  const environment = getWhatsAppEnvironment();
  if (row.environment !== environment) throw new WhatsAppChannelStoreError("channel_environment_mismatch");
  return decryptWhatsAppCredential(row.ciphertext, row.key_version, {
    environment,
    workspaceId: row.workspace_id,
    channelId: row.channel_id,
    provider: row.provider,
    purpose: row.purpose,
  });
}
