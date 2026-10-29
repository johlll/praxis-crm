import { z } from "zod";

import { toUserMessage } from "@/lib/errors";
import { uuidSchema } from "@/lib/uuid";
import { requirePermissionSafe } from "@/server/authz/safe";
import {
  adminCreateWhatsAppInternalIdentity,
  adminListWhatsAppInternalIdentities,
  adminSetWhatsAppInternalIdentityActive,
  WhatsAppInternalIdentityError,
  type SafeWhatsAppInternalIdentity,
} from "@/server/whatsapp/admin/internal-identities";
import { WhatsAppDomainError, whatsappIdentityKey } from "@/server/whatsapp/domain-model";
import { isWhatsAppEnvironmentConfigured } from "@/server/whatsapp/environment";
import { WhatsAppIdentityCryptoError } from "@/server/whatsapp/identity-crypto";

/**
 * Operações internas de identidade INTERNA do WhatsApp (B3.2d-2b1). NÃO são
 * Server Actions: nenhuma tela as expõe nesta etapa.
 *
 * Ordem fixa: permissão `channel.manage` pela sessão (owner/admin) →
 * entrada estrita (workspace, usuário e ambiente nunca vêm do formulário)
 * → ambiente do WhatsApp configurado → banco, que revalida tudo. Telefone,
 * BSUID ou os dois; nunca nenhum. Respostas e logs nunca carregam telefone,
 * BSUID ou erro cru.
 */

export type WhatsAppInternalIdentityResult<T> = { ok: true; data: T } | { ok: false; error: string };

type Session = { workspaceId: string; actorUserId: string };

const optionalText = z
  .string()
  .trim()
  .max(128)
  .nullish()
  .transform((value) => (value ? value : null));

const createSchema = z
  .object({
    channelId: uuidSchema,
    label: z.string().trim().min(1, "Informe um nome para a identidade interna.").max(120),
    phoneE164: optionalText,
    bsuid: optionalText,
  })
  .strict();

const listSchema = z.object({ channelId: uuidSchema }).strict();
const setActiveSchema = z.object({ identityId: uuidSchema, active: z.boolean() }).strict();

async function authorize(): Promise<{ session: Session } | { error: string }> {
  const guard = await requirePermissionSafe("channel.manage");
  if ("error" in guard) return { error: guard.error };
  return { session: { workspaceId: guard.ctx.workspaceId, actorUserId: guard.ctx.userId } };
}

function invalidInput(): { ok: false; error: string } {
  return { ok: false, error: toUserMessage({ message: "invalid_internal_identity" }) };
}

/** Texto seguro. Só o código e o workspace vão para o log. */
function failure(error: unknown, session: Session): { ok: false; error: string } {
  let code = "unknown";
  if (error instanceof WhatsAppInternalIdentityError) code = error.code;
  else if (error instanceof WhatsAppIdentityCryptoError) code = error.code === "invalid_bsuid" ? "invalid_internal_identity" : "whatsapp_not_configured";
  else if (error instanceof WhatsAppDomainError) code = "invalid_internal_identity";
  if (code === "unknown" || code === "internal_identity_invalid_response") {
    console.warn(JSON.stringify({ event: "whatsapp_internal_identity_operation_failed", code, workspaceId: session.workspaceId }));
  }
  return { ok: false, error: toUserMessage({ message: code }) };
}

async function run<S extends z.ZodTypeAny, R>(
  input: unknown,
  schema: S,
  operation: (data: z.output<S>, session: Session) => Promise<R>,
): Promise<WhatsAppInternalIdentityResult<R>> {
  const auth = await authorize();
  if ("error" in auth) return { ok: false, error: auth.error };
  const parsed = schema.safeParse(input);
  if (!parsed.success) return invalidInput();
  if (!isWhatsAppEnvironmentConfigured()) return { ok: false, error: toUserMessage({ message: "whatsapp_not_configured" }) };
  try {
    return { ok: true, data: await operation(parsed.data, auth.session) };
  } catch (error) {
    return failure(error, auth.session);
  }
}

export function listWhatsAppInternalIdentities(input: unknown): Promise<WhatsAppInternalIdentityResult<SafeWhatsAppInternalIdentity[]>> {
  return run(input, listSchema, (data, session) => adminListWhatsAppInternalIdentities({ ...session, channelId: data.channelId }));
}

export function createWhatsAppInternalIdentity(input: unknown): Promise<WhatsAppInternalIdentityResult<SafeWhatsAppInternalIdentity>> {
  return run(input, createSchema, (data, session) => {
    // Telefone, BSUID ou os dois — validados pelo mesmo contrato do domínio.
    const kind = data.phoneE164 && data.bsuid ? "phone_and_bsuid" : data.phoneE164 ? "phone" : "bsuid";
    const key = whatsappIdentityKey({ kind, phoneE164: data.phoneE164, bsuid: data.bsuid });
    return adminCreateWhatsAppInternalIdentity({ ...session, channelId: data.channelId, label: data.label, phoneE164: key.phoneE164, bsuid: key.bsuid });
  });
}

export function setWhatsAppInternalIdentityActive(input: unknown): Promise<WhatsAppInternalIdentityResult<SafeWhatsAppInternalIdentity>> {
  return run(input, setActiveSchema, (data, session) =>
    adminSetWhatsAppInternalIdentityActive({ ...session, identityId: data.identityId, active: data.active }),
  );
}
