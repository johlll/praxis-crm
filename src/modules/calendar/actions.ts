"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { requirePermissionSafe } from "@/server/authz/safe";
import { toUserMessage } from "@/lib/errors";
import { uuidSchema } from "@/lib/uuid";
import { getCalendarProvider } from "@/server/calendar/provider";
import {
  adminConnectCalendar,
  adminDisconnectCalendar,
  adminGetConnectionTokens,
  adminSetConnectionCalendar,
} from "@/server/calendar/admin/connections";

export type CalendarActionState = { ok: boolean; error?: string };

/**
 * A recusa de ambiente aborta a transação no banco, então não deixa
 * auditoria lá (o registro seria desfeito junto). Quem registra é o
 * servidor: só o código e ids internos, nunca conteúdo de evento.
 */
function logRefusal(error: unknown, ctx: { userId: string; workspaceId: string }) {
  if (error instanceof Error && error.message === "calendar_environment_mismatch") {
    console.warn(
      JSON.stringify({ event: "calendar_environment_mismatch", userId: ctx.userId, workspaceId: ctx.workspaceId }),
    );
  }
}

const PROVIDER_NOT_CONFIGURED = toUserMessage(new Error("calendar_provider_not_configured"));

const connectSchema = z.object({ authorization: z.string().trim().min(3).max(500) });

/**
 * Conectar a PRÓPRIA conta (`calendar.connect_own`). Nesta etapa só existe o
 * provedor simulado; sem provedor configurado, a ação recusa sem tocar em
 * nada. O `authorization` é o resultado do consentimento (no Google real,
 * o código OAuth devolvido ao retorno da autorização).
 */
export async function connectCalendarAction(
  _prev: CalendarActionState,
  formData: FormData,
): Promise<CalendarActionState> {
  const auth = await requirePermissionSafe("calendar.connect_own");
  if ("error" in auth) return { ok: false, error: auth.error };

  const parsed = connectSchema.safeParse({ authorization: formData.get("authorization") });
  if (!parsed.success) return { ok: false, error: "Informe a autorização." };

  const provider = await getCalendarProvider();
  if (!provider) return { ok: false, error: PROVIDER_NOT_CONFIGURED };

  try {
    const tokens = await provider.exchangeAuthorization(parsed.data.authorization);
    await adminConnectCalendar({
      workspaceId: auth.ctx.workspaceId,
      actorUserId: auth.ctx.userId,
      tokens,
    });
  } catch (error) {
    logRefusal(error, auth.ctx);
    return { ok: false, error: toUserMessage(error) };
  }

  revalidatePath("/configuracoes/integracoes");
  return { ok: true };
}

const selectSchema = z.object({ connectionId: uuidSchema, calendarId: z.string().trim().min(1).max(1024) });

/** Escolher a agenda da PRÓPRIA conexão. O id escolhido é conferido contra
 * a lista que o provedor devolve para este token — nunca aceito às cegas. */
export async function selectCalendarAction(
  _prev: CalendarActionState,
  formData: FormData,
): Promise<CalendarActionState> {
  const auth = await requirePermissionSafe("calendar.connect_own");
  if ("error" in auth) return { ok: false, error: auth.error };

  const parsed = selectSchema.safeParse({
    connectionId: formData.get("connectionId"),
    calendarId: formData.get("calendarId"),
  });
  if (!parsed.success) return { ok: false, error: toUserMessage(new Error("calendar_id_required")) };

  const provider = await getCalendarProvider();
  if (!provider) return { ok: false, error: PROVIDER_NOT_CONFIGURED };

  try {
    const tokens = await adminGetConnectionTokens({
      connectionId: parsed.data.connectionId,
      workspaceId: auth.ctx.workspaceId,
      actorUserId: auth.ctx.userId,
    });
    const calendars = await provider.listCalendars(tokens.accessToken);
    const chosen = calendars.find((c) => c.id === parsed.data.calendarId);
    if (!chosen) return { ok: false, error: toUserMessage(new Error("calendar_id_required")) };

    await adminSetConnectionCalendar({
      connectionId: parsed.data.connectionId,
      actorUserId: auth.ctx.userId,
      calendarId: chosen.id,
      calendarSummary: chosen.summary,
    });
  } catch (error) {
    logRefusal(error, auth.ctx);
    return { ok: false, error: toUserMessage(error) };
  }

  revalidatePath("/configuracoes/integracoes");
  return { ok: true };
}

const disconnectSchema = z.object({ connectionId: uuidSchema });

/**
 * Desconectar. A própria conexão: revoga o token no provedor (melhor
 * esforço) e apaga os tokens do banco. Conexão de OUTRO usuário (só
 * owner/admin, decidido pelo banco): apenas apaga os tokens locais — nunca
 * lê o token alheio, então a autorização no Google segue até o dono
 * revogá-la na conta dele. Em ambos os casos: nenhum evento do Google e
 * nenhum compromisso do CRM é apagado.
 */
export async function disconnectCalendarAction(
  _prev: CalendarActionState,
  formData: FormData,
): Promise<CalendarActionState> {
  const auth = await requirePermissionSafe("calendar.connect_own");
  if ("error" in auth) return { ok: false, error: auth.error };

  const parsed = disconnectSchema.safeParse({ connectionId: formData.get("connectionId") });
  if (!parsed.success) return { ok: false, error: toUserMessage(new Error("connection_not_found")) };

  try {
    const provider = await getCalendarProvider();
    if (provider) {
      try {
        const tokens = await adminGetConnectionTokens({
          connectionId: parsed.data.connectionId,
          workspaceId: auth.ctx.workspaceId,
          actorUserId: auth.ctx.userId,
        });
        await provider.revoke(tokens.refreshToken);
      } catch {
        // Conexão de outro usuário, ou token já inválido: a desconexão
        // local segue de qualquer jeito.
      }
    }
    await adminDisconnectCalendar({ connectionId: parsed.data.connectionId, actorUserId: auth.ctx.userId });
  } catch (error) {
    logRefusal(error, auth.ctx);
    return { ok: false, error: toUserMessage(error) };
  }

  revalidatePath("/configuracoes/integracoes");
  return { ok: true };
}
