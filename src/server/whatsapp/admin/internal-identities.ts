import { z } from "zod";

import { uuidSchema } from "@/lib/uuid";
import { createWhatsAppAdminSupabaseClient } from "@/server/whatsapp/admin/supabase";
import { getWhatsAppEnvironment } from "@/server/whatsapp/environment";
import { encryptWhatsAppBsuid } from "@/server/whatsapp/identity-crypto";

/**
 * Identidades INTERNAS do WhatsApp (B3.2d-2b1, docs/decisoes/b3-whatsapp-real.md
 * §21): números e BSUIDs do próprio escritório, por workspace, ambiente e
 * canal. Quem chama já verificou a sessão (`channel.manage`): workspace e
 * ator vêm dessa verificação, nunca do formulário. O banco revalida papel
 * (owner/admin), workspace, ambiente e canal.
 *
 * O BSUID vai ao banco só como índice cego e texto cifrado, calculados aqui
 * com as chaves próprias e o escopo do canal (o mesmo do índice das
 * conversas); a listagem nunca devolve nenhum dos dois.
 */

export type SafeWhatsAppInternalIdentity = {
  id: string;
  channelId: string;
  label: string;
  phoneE164: string | null;
  hasBsuid: boolean;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
};

export const WHATSAPP_INTERNAL_IDENTITY_ERROR_CODES = [
  "whatsapp_environment_required",
  "actor_required",
  "insufficient_permission",
  "channel_not_found",
  "invalid_internal_identity",
  "internal_identity_taken",
  "internal_identity_not_found",
  "internal_identity_invalid_response",
] as const;

export type WhatsAppInternalIdentityErrorCode = (typeof WHATSAPP_INTERNAL_IDENTITY_ERROR_CODES)[number] | "unknown";

export class WhatsAppInternalIdentityError extends Error {
  constructor(public readonly code: WhatsAppInternalIdentityErrorCode) {
    super(code);
    this.name = "WhatsAppInternalIdentityError";
  }
}

const KNOWN: ReadonlySet<string> = new Set(WHATSAPP_INTERNAL_IDENTITY_ERROR_CODES);

/** Só o código: a mensagem original do banco (que pode citar um valor de
 * restrição) nunca sai daqui. */
function toError(error: { message?: string } | null | undefined): WhatsAppInternalIdentityError {
  const message = error?.message ?? "";
  return new WhatsAppInternalIdentityError(KNOWN.has(message) ? (message as WhatsAppInternalIdentityErrorCode) : "unknown");
}

const safeRowSchema = z
  .object({
    id: uuidSchema,
    channel_id: uuidSchema,
    label: z.string().min(1).max(120),
    phone_e164: z.string().regex(/^\+[1-9][0-9]{7,14}$/).nullable(),
    has_bsuid: z.boolean(),
    is_active: z.boolean(),
    created_at: z.string().min(1),
    updated_at: z.string().min(1),
  })
  .strict();

function mapRow(row: unknown): SafeWhatsAppInternalIdentity {
  const parsed = safeRowSchema.safeParse(row);
  if (!parsed.success) throw new WhatsAppInternalIdentityError("internal_identity_invalid_response");
  const r = parsed.data;
  return {
    id: r.id,
    channelId: r.channel_id,
    label: r.label,
    phoneE164: r.phone_e164,
    hasBsuid: r.has_bsuid,
    isActive: r.is_active,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

type Actor = { workspaceId: string; actorUserId: string };

export async function adminListWhatsAppInternalIdentities(params: Actor & { channelId: string }): Promise<SafeWhatsAppInternalIdentity[]> {
  const admin = createWhatsAppAdminSupabaseClient();
  const { data, error } = await admin.rpc("whatsapp_list_internal_identities", {
    p_workspace_id: params.workspaceId,
    p_actor_user_id: params.actorUserId,
    p_channel_id: params.channelId,
  });
  if (error) throw toError(error);
  if (!Array.isArray(data)) throw new WhatsAppInternalIdentityError("internal_identity_invalid_response");
  return data.map(mapRow);
}

/** Telefone e/ou BSUID já validados por quem chama (pelo menos um). */
export async function adminCreateWhatsAppInternalIdentity(
  params: Actor & { channelId: string; label: string; phoneE164: string | null; bsuid: string | null },
): Promise<SafeWhatsAppInternalIdentity> {
  const encrypted =
    params.bsuid === null
      ? null
      : encryptWhatsAppBsuid({ environment: getWhatsAppEnvironment(), workspaceId: params.workspaceId, channelId: params.channelId }, params.bsuid);
  const admin = createWhatsAppAdminSupabaseClient();
  const { data, error } = await admin.rpc("whatsapp_create_internal_identity", {
    p_workspace_id: params.workspaceId,
    p_actor_user_id: params.actorUserId,
    p_channel_id: params.channelId,
    p_label: params.label,
    p_phone_e164: params.phoneE164,
    p_bsuid_blind_index: encrypted?.blindIndexBase64 ?? null,
    p_bsuid_ciphertext: encrypted?.ciphertextBase64 ?? null,
    p_bsuid_key_version: encrypted?.keyVersion ?? null,
  } as never);
  if (error) throw toError(error);
  return mapRow(data);
}

export async function adminSetWhatsAppInternalIdentityActive(
  params: Actor & { identityId: string; active: boolean },
): Promise<SafeWhatsAppInternalIdentity> {
  const admin = createWhatsAppAdminSupabaseClient();
  const { data, error } = await admin.rpc("whatsapp_set_internal_identity_active", {
    p_identity_id: params.identityId,
    p_workspace_id: params.workspaceId,
    p_actor_user_id: params.actorUserId,
    p_active: params.active,
  });
  if (error) throw toError(error);
  return mapRow(data);
}
