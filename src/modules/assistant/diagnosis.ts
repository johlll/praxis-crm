import type { ActivityListItem } from "@/modules/activities/queries";
import type { AttentionItem, Dashboard } from "@/modules/dashboard/queries";
import { ACTIVITY_TYPE_LABEL } from "@/components/activities/labels";
import { TIMEZONE } from "@/lib/timezone";
import { daysSince } from "@/modules/dashboard/presentation";
import type { AssistantBlock, DiagnosisItem, DiagnosisSection } from "./types";

/** Quantos itens de cada lista aparecem na resposta; o total vem sempre do banco. */
export const DIAGNOSIS_LIMIT = 5;

type ActivitiesPage = { items: ActivityListItem[]; total: number };

/** As três consultas, injetadas para teste. Cada uma pode falhar sozinha. */
export type DiagnosisSources = {
  overdue: () => Promise<ActivitiesPage>;
  today: () => Promise<ActivitiesPage>;
  attention: () => Promise<Pick<Dashboard, "attention" | "generatedAt" | "stalledDays">>;
  now: () => Date;
};

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

const hourOf = (iso: string) =>
  new Date(iso).toLocaleTimeString("pt-BR", { timeZone: TIMEZONE, hour: "2-digit", minute: "2-digit" });

/** "22/11 às 14:30" (ou só "22/11" sem horário), no fuso do escritório; o ano só quando não é o atual. */
export function shortWhen(iso: string, hasTime: boolean, now: Date): string {
  const year = (d: Date) => d.toLocaleDateString("pt-BR", { timeZone: TIMEZONE, year: "numeric" });
  const day = new Date(iso).toLocaleDateString("pt-BR", {
    timeZone: TIMEZONE,
    day: "2-digit",
    month: "2-digit",
    ...(year(new Date(iso)) === year(now) ? {} : { year: "numeric" }),
  });
  return hasTime ? `${day} às ${hourOf(iso)}` : day;
}

function overdueItem(a: ActivityListItem, now: Date): DiagnosisItem {
  return {
    id: a.id,
    title: `${a.contactName} · ${a.title}`,
    reason: `${ACTIVITY_TYPE_LABEL[a.type]} atrasada desde ${shortWhen(a.dueAt, a.hasTime, now)}${
      a.assignedToName ? ` · ${a.assignedToName}` : " · sem responsável"
    }`,
    href: `/leads/${a.leadId}`,
    tone: "danger",
  };
}

function todayItem(a: ActivityListItem): DiagnosisItem {
  return {
    id: a.id,
    title: `${a.contactName} · ${a.title}`,
    reason: `${ACTIVITY_TYPE_LABEL[a.type]} hoje${a.hasTime ? ` às ${hourOf(a.dueAt)}` : ", sem horário marcado"}${
      a.assignedToName ? ` · ${a.assignedToName}` : " · sem responsável"
    }`,
    href: `/leads/${a.leadId}`,
    tone: "warning",
  };
}

function attentionItem(item: AttentionItem, generatedAt: string, stalledDays: number): DiagnosisItem {
  const reasons: string[] = [];
  if (item.overdueActivitiesCount > 0) reasons.push(plural(item.overdueActivitiesCount, "atividade atrasada", "atividades atrasadas"));
  if (item.isStalled) {
    const days = daysSince(item.stageEnteredAt, generatedAt);
    reasons.push(`parada há ${plural(days, "dia", "dias")} em "${item.stageName}" (limite: ${stalledDays})`);
  }
  if (item.isUnassigned) reasons.push("sem responsável");
  return {
    id: item.id,
    title: `${item.contactName} · ${item.legalArea}`,
    reason: capitalizeFirst(reasons.join(" · ") || `na etapa "${item.stageName}"`),
    href: `/oportunidades/${item.id}`,
    tone: item.overdueActivitiesCount > 0 ? "danger" : item.isStalled ? "warning" : "neutral",
  };
}

const capitalizeFirst = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * "O que precisa da minha atenção hoje?" — agenda, atividades e oportunidades pelas regras que o CRM já
 * usa (list_activities e get_dashboard, com o alcance de cada papel aplicado no banco). Uma consulta que
 * falha vira "indisponível", nunca zero; "nada pendente" só é dito quando as três responderam vazias.
 */
export async function buildDiagnosis(sources: DiagnosisSources): Promise<AssistantBlock> {
  const [overdue, today, attention] = await Promise.allSettled([sources.overdue(), sources.today(), sources.attention()]);
  const generatedAt = attention.status === "fulfilled" ? attention.value.generatedAt : sources.now().toISOString();

  const sections: DiagnosisSection[] = [
    {
      key: "overdue",
      title: "Atividades atrasadas",
      status: overdue.status === "fulfilled" ? "ok" : "unavailable",
      total: overdue.status === "fulfilled" ? overdue.value.total : 0,
      items: overdue.status === "fulfilled" ? overdue.value.items.slice(0, DIAGNOSIS_LIMIT).map((a) => overdueItem(a, sources.now())) : [],
      emptyText: "Nenhuma atividade atrasada.",
      moreHref: "/atividades?filter=overdue",
    },
    {
      key: "today",
      title: "Agenda de hoje",
      status: today.status === "fulfilled" ? "ok" : "unavailable",
      total: today.status === "fulfilled" ? today.value.total : 0,
      items: today.status === "fulfilled" ? today.value.items.slice(0, DIAGNOSIS_LIMIT).map(todayItem) : [],
      emptyText: "Nenhuma atividade pendente para hoje.",
      moreHref: "/agenda",
    },
    {
      key: "attention",
      title: "Oportunidades que exigem atenção",
      status: attention.status === "fulfilled" ? "ok" : "unavailable",
      total: attention.status === "fulfilled" ? attention.value.attention.total : 0,
      items:
        attention.status === "fulfilled"
          ? attention.value.attention.items
              .slice(0, DIAGNOSIS_LIMIT)
              .map((item) => attentionItem(item, attention.value.generatedAt, attention.value.stalledDays))
          : [],
      emptyText: "Nenhuma oportunidade aberta está parada, sem responsável ou com atividade atrasada.",
      moreHref: "/visao-geral#atencao",
    },
  ];

  return { type: "diagnosis", summary: summaryOf(sections), generatedAt, sections };
}

function summaryOf(sections: DiagnosisSection[]): string {
  const available = sections.filter((s) => s.status === "ok");
  const unavailable = sections.filter((s) => s.status === "unavailable");
  const [overdue, today, attention] = sections as [DiagnosisSection, DiagnosisSection, DiagnosisSection];
  const parts: string[] = [];
  if (overdue.status === "ok" && overdue.total > 0) parts.push(plural(overdue.total, "atividade atrasada", "atividades atrasadas"));
  if (today.status === "ok" && today.total > 0) parts.push(plural(today.total, "atividade na agenda de hoje", "atividades na agenda de hoje"));
  if (attention.status === "ok" && attention.total > 0)
    parts.push(plural(attention.total, "oportunidade que exige atenção", "oportunidades que exigem atenção"));

  const missing = unavailable.length
    ? ` Não consegui consultar: ${listOf(unavailable.map((s) => s.title.toLowerCase()))}. Tente de novo em instantes.`
    : "";

  if (available.length === 0) return `Não consegui consultar nenhuma das informações agora. Tente de novo em instantes.`;
  if (parts.length === 0) {
    return unavailable.length
      ? `Nas consultas que responderam, não há pendências.${missing}`
      : "Nada precisa da sua atenção agora: nenhuma atividade atrasada, nada pendente para hoje e nenhuma oportunidade parada, sem responsável ou com atraso.";
  }
  return `Encontrei ${listOf(parts)}.${missing}`;
}

const listOf = (items: string[]) => (items.length > 1 ? `${items.slice(0, -1).join(", ")} e ${items.at(-1)}` : (items[0] ?? ""));
