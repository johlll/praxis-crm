import { Briefcase, MessageSquare, Scale, XCircle } from "lucide-react";

import { cn } from "@/lib/cn";
import { ATTENDANCE_STATUS_LABEL, type AttendanceStatus } from "@/modules/status-tracks/schema";
import type { CaseBadge } from "@/modules/conversations/case-display";
import { ATTENDANCE_STATUS_CLASS, CASE_BADGE_KIND_CLASS, CASE_PROGRESS_STATUS_CLASS } from "../labels";

const KIND_ICON = { commercial: Briefcase, service: Scale, lost: XCircle } as const;

function badgeClass(badge: CaseBadge): string {
  if (badge.kind === "service") return CASE_PROGRESS_STATUS_CLASS[badge.progress ?? "nao_informado"];
  return CASE_BADGE_KIND_CLASS[badge.kind];
}

/**
 * Selo do caso. A natureza (comercial, serviço, perdida) vai SEMPRE escrita e com ícone próprio — nunca só
 * a cor —, para não ser confundida com a situação do atendimento.
 */
export function CaseBadgeChip({ badge, className, wrap = false }: { badge: CaseBadge; className?: string; wrap?: boolean }) {
  const Icon = KIND_ICON[badge.kind];
  return (
    <span
      title={badge.full}
      className={cn(
        "inline-flex min-w-0 max-w-full gap-1 px-2 py-0.5 text-label font-bold",
        wrap ? "items-start rounded-[10px]" : "items-center rounded-full",
        badgeClass(badge),
        className,
      )}
    >
      <Icon size={11} className={cn("shrink-0", wrap && "mt-[3px]")} aria-hidden />
      <span className="sr-only">{badge.full}</span>
      <span aria-hidden className={wrap ? "[overflow-wrap:anywhere]" : "truncate"}>
        {badge.kind === "lost" ? badge.label : `${badge.prefix} · ${badge.label}`}
      </span>
    </span>
  );
}

/**
 * Assunto do caso + selo numa linha só (o selo encurta com reticências e mostra o texto completo na dica),
 * para a lista e o cabeçalho da conversa não empilharem uma etiqueta por linha.
 */
export function CaseSubjectChips({ subject, badge }: { subject: string; badge: CaseBadge }) {
  return (
    <span className="inline-flex min-w-0 max-w-full items-center gap-1">
      <span
        title={`Caso: ${subject}`}
        className="inline-flex min-w-0 max-w-[45%] shrink-0 items-center rounded-full bg-neutral-bg px-2 py-0.5 text-label font-bold text-neutral"
      >
        <span className="sr-only">Caso: </span>
        <span className="truncate">{subject}</span>
      </span>
      <CaseBadgeChip badge={badge} />
    </span>
  );
}

/**
 * Situação do atendimento (pertence à CONVERSA, não ao caso): ícone de mensagem e, para leitor de tela e dica,
 * o nome completo. `showPrefix` escreve "Atendimento:" na própria etiqueta, onde há espaço.
 */
export function AttendanceChip({
  status,
  showPrefix = false,
  className,
}: {
  status: AttendanceStatus;
  showPrefix?: boolean;
  className?: string;
}) {
  const label = ATTENDANCE_STATUS_LABEL[status];
  return (
    <span
      title={`Situação do atendimento: ${label}`}
      className={cn(
        "inline-flex min-w-0 max-w-full items-center gap-1 rounded-full px-2 py-0.5 text-label font-bold",
        ATTENDANCE_STATUS_CLASS[status],
        className,
      )}
    >
      <MessageSquare size={11} className="shrink-0" aria-hidden />
      <span className="sr-only">Situação do atendimento: {label}</span>
      <span aria-hidden className="truncate">
        {showPrefix ? `Atendimento · ${label}` : label}
      </span>
    </span>
  );
}
