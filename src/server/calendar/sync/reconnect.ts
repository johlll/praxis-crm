import { ProviderHttpError, type CalendarEvent } from "@/server/calendar/events-api";
import { rescheduleAppointment } from "@/server/calendar/sync/appointments";
import { syncCalendar } from "@/server/calendar/sync/inbound";
import type { InboundDeps } from "@/server/calendar/sync/inbound-types";
import type { SyncDeps } from "@/server/calendar/sync/types";

/**
 * Reconexão (§6.5, critério 12): desconectar desfaz os vínculos sem apagar
 * nada; ao reconectar, os compromissos são REENCONTRADOS.
 *
 *  1. o banco lista os vínculos desfeitos por uma desconexão anterior do
 *     MESMO usuário, no mesmo workspace e ambiente, cuja atividade ainda
 *     existe e não tem outro vínculo ativo;
 *  2. cada evento é conferido no Google ANTES: existe, não está cancelado,
 *     não é série e tem a marca DESTE compromisso e ambiente. Marca
 *     diferente nunca é adotada; evento que sumiu não é recriado;
 *  3. o vínculo volta para a conexão nova com a BASE preservada;
 *  4. listagem completa de cada agenda (o que mudou no Google enquanto
 *     estava desconectado chega ao CRM, com as regras de conflito) e, em
 *     seguida, a saída de cada compromisso (o que mudou só no CRM vai ao
 *     Google). Nada é decidido por data de alteração.
 */

export type ReconnectReport = {
  candidates: number;
  relinked: number;
  /** Evento cancelado ou apagado no Google: a atividade fica, sem vínculo. */
  gone: number;
  /** Agenda inacessível pela conta reconectada. */
  unreachable: number;
  /** Marca de outro compromisso/ambiente, ou série: nunca adotado. */
  refused: number;
  /** Atividade que deixou de ser reunião com horário. */
  notAppointment: number;
  /** Falha temporária do Google: fica para a próxima tentativa. */
  failed: number;
  pushed: number;
};

export type ReconnectContext = { connectionId: string; userId: string; accessToken: string };

const denied = (error: unknown) =>
  error instanceof ProviderHttpError && (error.status === 401 || error.status === 403 || error.status === 404);

export async function recoverLinksAfterReconnect(
  deps: { inbound: InboundDeps; outbound: SyncDeps },
  ctx: ReconnectContext,
): Promise<ReconnectReport> {
  const { inbound, outbound } = deps;
  const environment = inbound.environment;
  const report: ReconnectReport = {
    candidates: 0,
    relinked: 0,
    gone: 0,
    unreachable: 0,
    refused: 0,
    notAppointment: 0,
    failed: 0,
    pushed: 0,
  };

  const candidates = await inbound.store.listRecoverableLinks(ctx.userId, ctx.connectionId);
  report.candidates = candidates.length;
  const relinked: Array<{ activityId: string; calendarId: string }> = [];

  for (const candidate of candidates) {
    const activity = await outbound.loadActivity(candidate.activityId);
    if (!activity || activity.type !== "meeting" || !activity.hasTime) {
      report.notAppointment += 1;
      continue;
    }

    let event: CalendarEvent | null;
    try {
      event = await inbound.api.getEvent(ctx.accessToken, candidate.calendarId, candidate.eventId);
      if (!event && !(await inbound.api.calendarAccessible(ctx.accessToken, candidate.calendarId))) {
        report.unreachable += 1;
        continue;
      }
    } catch (error) {
      if (denied(error)) report.unreachable += 1;
      else report.failed += 1;
      continue;
    }
    if (!event || event.status === "cancelled") {
      report.gone += 1;
      continue;
    }
    const marker = event.extendedProperties?.private;
    if (
      marker?.crmAppointment !== candidate.activityId ||
      marker?.crmEnv !== environment ||
      event.recurrence?.length ||
      event.recurringEventId
    ) {
      report.refused += 1;
      continue;
    }

    const result = await inbound.store.relinkRecovered(ctx.userId, candidate.id, ctx.connectionId);
    if (result === "relinked") {
      report.relinked += 1;
      relinked.push({ activityId: candidate.activityId, calendarId: candidate.calendarId });
    }
  }

  // Google → CRM: listagem completa de cada agenda reencontrada.
  for (const calendarId of new Set(relinked.map((r) => r.calendarId))) {
    await syncCalendar(
      inbound,
      { connectionId: ctx.connectionId, userId: ctx.userId, calendarId, environment, accessToken: ctx.accessToken },
      { forceFull: true },
    );
  }

  // CRM → Google: o que mudou só no CRM enquanto estava desconectado.
  for (const { activityId, calendarId } of relinked) {
    const activity = await outbound.loadActivity(activityId);
    if (!activity) continue;
    try {
      const result = await rescheduleAppointment(
        outbound,
        { connectionId: ctx.connectionId, calendarId, environment, accessToken: ctx.accessToken },
        activity,
      );
      if (result.status === "updated" || result.status === "conflict_resolved") report.pushed += 1;
    } catch {
      // A pendência fica gravada no vínculo pela própria saída; a próxima
      // edição ou "Sincronizar" refaz.
    }
  }
  return report;
}
