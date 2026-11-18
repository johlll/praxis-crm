import {
  ATTENDANCE_STATUS_LABEL,
  CASE_PROGRESS_STATUS_LABEL,
  type AttendanceStatus,
  type CaseProgressStatus,
  type StatusTrack,
} from "@/modules/status-tracks/schema";
import type { StatusTrackEvent, StatusTrackEvidence } from "@/modules/status-tracks/queries";
import { MESSAGE_AUTHOR_LABEL, contentKindLabel } from "./inbox";
import { messageAuthorKind } from "./message-author";

/**
 * Conversas + IA (PR 2) — texto do histórico das trilhas, sem acesso a banco.
 * Tudo vem de códigos já gravados; nenhuma frase é inventada a partir do texto
 * de mensagem (o histórico guarda só referências).
 */

export const TRACK_LABEL: Record<StatusTrack, string> = {
  attendance: "Situação do atendimento",
  case_progress: "Andamento do caso",
  commercial_stage: "Etapa comercial",
};

/** Etiqueta de ORIGEM de cada evento no histórico do caso (a situação do atendimento é da conversa). */
export const TRACK_TAG: Record<StatusTrack, string> = {
  attendance: "Atendimento desta conversa",
  case_progress: "Andamento do serviço",
  commercial_stage: "Etapa comercial",
};

/**
 * Evento do histórico do caso que não é de trilha de status: movimentação da etapa comercial
 * (`stage_transitions`, a fonte canônica) ou marco gravado na própria oportunidade (abertura, ganho).
 */
export type CaseHistoryExtra = {
  id: string;
  occurredAt: string;
  tag: string;
  title: string;
  detail: string | null;
  /** Autor quando a fonte registra; `null` quando a fonte não guarda quem fez. */
  actorLabel: string | null;
};

/**
 * Monta os eventos de fonte canônica fora das trilhas: cada movimentação comercial uma vez, a abertura
 * (`opportunities.created_at`) e o ganho (`won_at`). A perda não entra: a oportunidade não grava quando
 * foi perdida (o motivo aparece no Resumo).
 */
export function caseHistoryExtras(input: {
  opportunityId: string;
  createdAt: string;
  wonAt: string | null;
  stageMoves: readonly { id: string; occurredAt: string; fromStageName: string | null; toStageName: string; actorName: string | null }[];
}): CaseHistoryExtra[] {
  const out: CaseHistoryExtra[] = input.stageMoves.map((m) => ({
    id: `move:${m.id}`,
    occurredAt: m.occurredAt,
    tag: "Etapa comercial",
    title: "Etapa comercial alterada",
    detail: m.fromStageName ? `De “${m.fromStageName}” para “${m.toStageName}”` : `Para “${m.toStageName}”`,
    actorLabel: m.actorName ?? "Alguém da equipe",
  }));
  out.push({
    id: `opened:${input.opportunityId}`,
    occurredAt: input.createdAt,
    tag: "Oportunidade",
    title: "Oportunidade aberta",
    detail: null,
    actorLabel: null,
  });
  if (input.wonAt) {
    out.push({
      id: `won:${input.opportunityId}`,
      occurredAt: input.wonAt,
      tag: "Oportunidade",
      title: "Oportunidade ganha",
      detail: "A partir daqui o caso tem andamento do serviço.",
      actorLabel: null,
    });
  }
  return out;
}

/** Rótulo de um código de status de uma trilha; código fora do vocabulário é mostrado como veio. */
export function statusLabel(track: StatusTrack, code: string | null): string {
  if (code === null) return "Não informado";
  if (track === "attendance") return ATTENDANCE_STATUS_LABEL[code as AttendanceStatus] ?? code;
  if (track === "case_progress") return CASE_PROGRESS_STATUS_LABEL[code as CaseProgressStatus] ?? code;
  return code;
}

/** Particípio concordando com o gênero de cada trilha: "situação … alterada", "andamento … alterado". */
const CHANGED: Record<StatusTrack, string> = {
  attendance: "alterada",
  case_progress: "alterado",
  commercial_stage: "alterada",
};

const STAMP = new Intl.DateTimeFormat("pt-BR", {
  timeZone: "America/Sao_Paulo",
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

/** "17/11/2026 21:55" — data e hora no fuso do escritório, sem segundos. */
export function formatStamp(iso: string): string {
  return STAMP.format(new Date(iso)).replace(", ", " ");
}

export type EventDescription = {
  /** Linha principal do evento. */
  title: string;
  /** Linha de apoio: de → para, ou o alcance da pausa. */
  detail: string | null;
};

export function describeTrackEvent(track: StatusTrack, event: Pick<StatusTrackEvent, "event" | "fromStatus" | "toStatus">): EventDescription {
  if (event.event === "status_changed") {
    return {
      title: `${TRACK_LABEL[track]} ${CHANGED[track]}`,
      detail: `De “${statusLabel(track, event.fromStatus)}” para “${statusLabel(track, event.toStatus)}”`,
    };
  }
  const scope = `Vale para ${TRACK_LABEL[track].toLowerCase()}; não afeta o bot de atendimento.`;
  return event.event === "automation_paused"
    ? { title: "Alterações automáticas de status pausadas", detail: scope }
    : { title: "Alterações automáticas de status retomadas", detail: scope };
}

const REF_FORMAT = new Intl.DateTimeFormat("pt-BR", {
  timeZone: "America/Sao_Paulo",
  day: "2-digit",
  month: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

/** Referência de uma mensagem usada como evidência: autoria comprovada, data/hora e, se não for texto, o tipo. */
export function evidenceRefLabel(e: Pick<StatusTrackEvidence, "direction" | "origin" | "senderClassification" | "contentKind" | "createdAt">): string {
  const author = MESSAGE_AUTHOR_LABEL[
    messageAuthorKind({ direction: e.direction, origin: e.origin, senderClassification: e.senderClassification })
  ];
  const kind = e.contentKind && e.contentKind !== "text" ? ` · ${contentKindLabel(e.contentKind)}` : "";
  return `${author}${kind} · ${REF_FORMAT.format(new Date(e.createdAt))}`;
}

/** Resumo do que sobrou fora do alcance ou foi apagado pela retenção, sem revelar o conteúdo. */
export function evidenceAbsenceNote(e: Pick<StatusTrackEvent, "evidenceHidden" | "evidenceRemoved">): string | null {
  const parts: string[] = [];
  if (e.evidenceHidden > 0) {
    parts.push(`${e.evidenceHidden} ${e.evidenceHidden === 1 ? "referência fora do seu alcance" : "referências fora do seu alcance"}`);
  }
  if (e.evidenceRemoved > 0) {
    parts.push(`${e.evidenceRemoved} ${e.evidenceRemoved === 1 ? "removida" : "removidas"} pela política de retenção`);
  }
  return parts.length ? parts.join(" · ") : null;
}

export type TaggedEvent = StatusTrackEvent & { track: StatusTrack; targetId: string };

/** Une as linhas do tempo das trilhas, da mais recente para a mais antiga (desempate pelo id, como no servidor). */
export function mergeTimeline(events: TaggedEvent[]): TaggedEvent[] {
  return [...events].sort((a, b) => {
    const ta = Date.parse(a.occurredAt);
    const tb = Date.parse(b.occurredAt);
    if (ta !== tb) return tb - ta;
    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
  });
}

/** Mensagens que a pessoa pode anexar como evidência de uma correção (referência, nunca obrigatória). */
export type EvidenceCandidate = {
  id: string;
  createdAt: string;
  authorLabel: string;
  excerpt: string;
};
