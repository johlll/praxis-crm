import { ProviderHttpError, type CalendarEvent } from "@/server/calendar/events-api";
import { rescheduleAppointment, type UpdateAppointmentResult } from "@/server/calendar/sync/appointments";
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
 *  3. o vínculo volta para a conexão nova com a BASE preservada, e a
 *     recuperação fica PENDENTE nele até os passos 4 e 5 terminarem;
 *  4. listagem completa de cada agenda com recuperação pendente (o que mudou
 *     no Google enquanto estava desconectado chega ao CRM, com as regras de
 *     conflito). Se ela não termina (Google indisponível, outra execução com
 *     a trava, sem acesso), a saída dessa agenda NÃO roda e tudo fica
 *     pendente;
 *  5. a saída de cada compromisso (o que mudou só no CRM vai ao Google). Só
 *     um desfecho definitivo conclui a recuperação; pendente, falha,
 *     incerto, sem acesso ou para atenção a deixam pendente.
 *
 * Recuperação pendente é retomada pela próxima tentativa ("Reencontrar
 * compromissos"), inclusive depois de uma interrupção logo após revincular.
 * Nada aqui cria evento ou vínculo: a saída só atualiza o evento vinculado.
 * Nada é decidido por data de alteração.
 */

export type ReconnectReport = {
  candidates: number;
  relinked: number;
  /** Recuperações pendentes de uma tentativa anterior, retomadas agora. */
  resumed: number;
  /** Recuperações concluídas agora (entrada e saída terminaram). */
  completed: number;
  /** Ficaram pendentes: Google indisponível, resultado incerto ou outra execução em andamento. */
  pending: number;
  /** Ficaram pendentes porque a conta não alcança a agenda. */
  accessLost: number;
  /** Evento cancelado ou apagado no Google: a atividade fica, sem vínculo (ou cancelada lá). */
  gone: number;
  /** Agenda inacessível pela conta reconectada (antes de revincular). */
  unreachable: number;
  /** Marca de outro compromisso/ambiente, ou série: nunca adotado. */
  refused: number;
  /** Atividade que deixou de ser reunião com horário. */
  notAppointment: number;
  /** Falha temporária do Google ao conferir o evento: não revinculado, fica para a próxima tentativa. */
  failed: number;
  /** Mudanças do CRM levadas ao Google. */
  pushed: number;
};

export type ReconnectContext = { connectionId: string; userId: string; accessToken: string };

const denied = (error: unknown) =>
  error instanceof ProviderHttpError && (error.status === 401 || error.status === 403 || error.status === 404);

/** Desfecho da saída: `done` conclui a recuperação; o resto a deixa pendente. */
function settle(result: UpdateAppointmentResult): "done" | "gone" | "pending" | "access_lost" {
  switch (result.status) {
    case "updated":
    case "unchanged":
    case "conflict_resolved":
      return "done";
    case "cancelled_in_google":
      return "gone";
    case "access_lost":
      return "access_lost";
    default:
      // pending, failed, uncertain, needs_attention: nada garante que o Google
      // tem o que o CRM tem.
      return "pending";
  }
}

export async function recoverLinksAfterReconnect(
  deps: { inbound: InboundDeps; outbound: SyncDeps },
  ctx: ReconnectContext,
): Promise<ReconnectReport> {
  const { inbound, outbound } = deps;
  const environment = inbound.environment;
  const report: ReconnectReport = {
    candidates: 0,
    relinked: 0,
    resumed: 0,
    completed: 0,
    pending: 0,
    accessLost: 0,
    gone: 0,
    unreachable: 0,
    refused: 0,
    notAppointment: 0,
    failed: 0,
    pushed: 0,
  };

  const candidates = await inbound.store.listRecoverableLinks(ctx.userId, ctx.connectionId);
  report.candidates = candidates.length;
  const relinkedNow = new Set<string>();

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
      relinkedNow.add(candidate.id);
    }
  }

  // Tudo o que está pendente — o que voltou agora e o que ficou de uma
  // tentativa anterior (falha ou interrupção depois de revincular).
  const work = await inbound.store.listPendingRecoveries(ctx.userId, ctx.connectionId);
  report.resumed = work.filter((w) => !relinkedNow.has(w.id)).length;

  const byCalendar = new Map<string, typeof work>();
  for (const item of work) byCalendar.set(item.calendarId, [...(byCalendar.get(item.calendarId) ?? []), item]);

  for (const [calendarId, items] of byCalendar) {
    // Google → CRM: listagem completa da agenda.
    const inboundOutcome = await syncCalendar(
      inbound,
      { connectionId: ctx.connectionId, userId: ctx.userId, calendarId, environment, accessToken: ctx.accessToken },
      { forceFull: true },
    );
    if (inboundOutcome.status !== "synced") {
      // busy, failed ou access_lost: a entrada não terminou. A saída não roda
      // (levaria ao Google sem antes trazer o que mudou lá) e tudo fica pendente.
      if (inboundOutcome.status === "access_lost") report.accessLost += items.length;
      else report.pending += items.length;
      continue;
    }

    // CRM → Google: o que mudou só no CRM enquanto estava desconectado.
    for (const item of items) {
      const activity = await outbound.loadActivity(item.activityId);
      let outcome: ReturnType<typeof settle>;
      if (!activity || activity.type !== "meeting" || !activity.hasTime) {
        // Não é mais um compromisso com horário: nada a levar ao Google.
        report.notAppointment += 1;
        outcome = "done";
      } else {
        try {
          const result = await rescheduleAppointment(
            outbound,
            { connectionId: ctx.connectionId, calendarId, environment, accessToken: ctx.accessToken },
            activity,
          );
          if (result.status === "updated" || result.status === "conflict_resolved") report.pushed += 1;
          outcome = settle(result);
        } catch {
          // A saída grava a pendência no vínculo quando chega a começar; a
          // recuperação continua pendente de qualquer forma.
          outcome = "pending";
        }
      }

      if (outcome === "pending") report.pending += 1;
      else if (outcome === "access_lost") report.accessLost += 1;
      else {
        if (outcome === "gone") report.gone += 1;
        await inbound.store.finishRecovery(ctx.userId, item.id, ctx.connectionId);
        report.completed += 1;
      }
    }
  }
  return report;
}
