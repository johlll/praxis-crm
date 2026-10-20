import type { z } from "zod";

import { toUserMessage } from "@/lib/errors";
import { requirePermissionSafe } from "@/server/authz/safe";
import {
  adminCreateSimulatedWhatsAppChannel,
  adminDisableWhatsAppChannelSend,
  adminGetWhatsAppChannelState,
  adminListWhatsAppChannels,
  adminPauseWhatsAppChannel,
  adminReactivateWhatsAppChannel,
  adminUpdateWhatsAppChannelSettings,
  WhatsAppChannelStoreError,
  type SafeWhatsAppChannel,
} from "@/server/whatsapp/admin/channels";
import { isWhatsAppCredentialCryptoConfigured, WhatsAppCredentialError } from "@/server/whatsapp/credential-crypto";
import { isWhatsAppEnvironmentConfigured } from "@/server/whatsapp/environment";
import { resolveWhatsAppProvider } from "@/server/whatsapp/provider";
import { channelRefSchema, createSimulatedChannelSchema, updateChannelSettingsSchema } from "./schema";

/**
 * Operações internas de canal de WhatsApp (B3.1). NÃO são Server Actions
 * (sem "use server"): nenhuma tela ou endpoint as expõe nesta etapa.
 *
 * Ordem fixa em todas: permissão `channel.manage` pela sessão → validação
 * estrita da entrada → ambiente do WhatsApp configurado → banco (que
 * revalida papel, workspace e ambiente). Workspace e usuário vêm SÓ da
 * sessão. Respostas nunca carregam credencial, texto cifrado nem erro cru.
 */

export type WhatsAppChannelResult<T> = { ok: true; data: T } | { ok: false; error: string };

type Session = { workspaceId: string; actorUserId: string };

async function authorize(): Promise<{ session: Session } | { error: string }> {
  const guard = await requirePermissionSafe("channel.manage");
  if ("error" in guard) return { error: guard.error };
  return { session: { workspaceId: guard.ctx.workspaceId, actorUserId: guard.ctx.userId } };
}

function invalidInput(issues: { message: string }[]): { ok: false; error: string } {
  return { ok: false, error: issues[0]?.message ?? "Dados inválidos." };
}

/** Converte qualquer falha num texto seguro. Só o código e ids internos
 * vão para o log — nunca a mensagem original, payload ou credencial. */
function failure(error: unknown, session: Session): { ok: false; error: string } {
  let code = "unknown";
  if (error instanceof WhatsAppChannelStoreError) code = error.code;
  else if (error instanceof WhatsAppCredentialError) code = "whatsapp_not_configured";
  if (code === "unknown" || code === "channel_environment_mismatch") {
    console.warn(JSON.stringify({ event: "whatsapp_channel_operation_failed", code, workspaceId: session.workspaceId }));
  }
  return { ok: false, error: toUserMessage({ message: code }) };
}

function environmentReady(): { ok: false; error: string } | null {
  if (!isWhatsAppEnvironmentConfigured()) return { ok: false, error: toUserMessage({ message: "whatsapp_not_configured" }) };
  return null;
}

async function run<I, R>(
  input: unknown,
  schema: z.ZodType<I>,
  operation: (data: I, session: Session) => Promise<R>,
): Promise<WhatsAppChannelResult<R>> {
  const auth = await authorize();
  if ("error" in auth) return { ok: false, error: auth.error };
  const parsed = schema.safeParse(input);
  if (!parsed.success) return invalidInput(parsed.error.issues);
  const notReady = environmentReady();
  if (notReady) return notReady;
  try {
    return { ok: true, data: await operation(parsed.data, auth.session) };
  } catch (error) {
    return failure(error, auth.session);
  }
}

export async function listWhatsAppChannelsForManagement(): Promise<WhatsAppChannelResult<SafeWhatsAppChannel[]>> {
  const auth = await authorize();
  if ("error" in auth) return { ok: false, error: auth.error };
  const notReady = environmentReady();
  if (notReady) return notReady;
  try {
    return { ok: true, data: await adminListWhatsAppChannels(auth.session) };
  } catch (error) {
    return failure(error, auth.session);
  }
}

export async function getWhatsAppChannelState(input: unknown): Promise<WhatsAppChannelResult<SafeWhatsAppChannel>> {
  return run(input, channelRefSchema, (data, session) =>
    adminGetWhatsAppChannelState({ ...session, channelId: data.channelId }),
  );
}

/** Só o provedor SIMULADO cria canal nesta etapa, e só quando ele está
 * habilitado (`WHATSAPP_PROVIDER=simulated`, fora de Production) e a cifra
 * das credenciais está configurada. */
export async function createSimulatedWhatsAppChannel(input: unknown): Promise<WhatsAppChannelResult<SafeWhatsAppChannel>> {
  const auth = await authorize();
  if ("error" in auth) return { ok: false, error: auth.error };
  const parsed = createSimulatedChannelSchema.safeParse(input);
  if (!parsed.success) return invalidInput(parsed.error.issues);
  const notReady = environmentReady();
  if (notReady) return notReady;

  const provider = resolveWhatsAppProvider({ channelProvider: "simulated" });
  if (provider.status !== "enabled") {
    return { ok: false, error: toUserMessage({ message: "whatsapp_provider_unavailable" }) };
  }
  if (!isWhatsAppCredentialCryptoConfigured()) {
    return { ok: false, error: toUserMessage({ message: "whatsapp_not_configured" }) };
  }

  try {
    return { ok: true, data: await adminCreateSimulatedWhatsAppChannel({ ...auth.session, ...parsed.data }) };
  } catch (error) {
    return failure(error, auth.session);
  }
}

export async function updateWhatsAppChannelSettings(input: unknown): Promise<WhatsAppChannelResult<SafeWhatsAppChannel>> {
  return run(input, updateChannelSettingsSchema, (data, session) =>
    adminUpdateWhatsAppChannelSettings({ ...session, ...data }),
  );
}

export async function pauseWhatsAppChannel(input: unknown): Promise<WhatsAppChannelResult<SafeWhatsAppChannel>> {
  return run(input, channelRefSchema, (data, session) =>
    adminPauseWhatsAppChannel({ ...session, channelId: data.channelId }),
  );
}

export async function reactivateWhatsAppChannel(input: unknown): Promise<WhatsAppChannelResult<SafeWhatsAppChannel>> {
  return run(input, channelRefSchema, (data, session) =>
    adminReactivateWhatsAppChannel({ ...session, channelId: data.channelId }),
  );
}

export async function disableWhatsAppChannelSend(input: unknown): Promise<WhatsAppChannelResult<SafeWhatsAppChannel>> {
  return run(input, channelRefSchema, (data, session) =>
    adminDisableWhatsAppChannelSend({ ...session, channelId: data.channelId }),
  );
}
