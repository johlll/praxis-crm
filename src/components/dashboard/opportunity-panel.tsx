"use client";

import { useState } from "react";
import type { Route } from "next";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ACTIVITY_TYPE_LABEL } from "@/components/activities/labels";
import { WonDialog } from "@/components/pipeline/won-dialog";
import { LostDialog } from "@/components/pipeline/lost-dialog";
import { formatDue } from "@/lib/timezone";
import type { OpportunityDetail } from "@/modules/opportunities/queries";
import { formatBRL } from "@/modules/dashboard/presentation";

const STATUS_LABEL: Record<OpportunityDetail["status"], string> = {
  open: "Aberta",
  won: "Ganha",
  lost: "Perdida",
};

/**
 * Painel lateral da Visão geral: resumo da oportunidade escolhida na
 * lista de atenção, com os mesmos diálogos de ganho e perda do Pipeline
 * (mesmas Server Actions, mesmas regras no servidor). Depois de ganhar ou
 * perder, a página é recarregada e os números do painel já refletem.
 */
export function OpportunityPanel({
  opportunity,
  canEdit,
  closeHref,
  stalledDays,
}: {
  opportunity: OpportunityDetail;
  canEdit: boolean;
  closeHref: Route;
  stalledDays: number | null;
}) {
  const router = useRouter();
  const [wonOpen, setWonOpen] = useState(false);
  const [lostOpen, setLostOpen] = useState(false);

  const value =
    opportunity.valueCents !== undefined
      ? opportunity.valueCents === null
        ? "Não informado"
        : formatBRL(opportunity.valueCents)
      : opportunity.valueBand;

  return (
    <aside
      aria-labelledby="painel-oportunidade-titulo"
      className="flex flex-col gap-4 rounded-lg border border-primary bg-surface p-4 shadow-raised"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="m-0 text-label font-semibold tracking-[1.3px] text-text-tertiary uppercase">Oportunidade</p>
          <h2 id="painel-oportunidade-titulo" className="m-0 truncate text-lead font-bold text-text">
            {opportunity.contactName}
          </h2>
          <p className="m-0 text-meta text-text-secondary">
            {opportunity.legalArea} · {STATUS_LABEL[opportunity.status]}
          </p>
        </div>
        <Link href={closeHref} scroll={false} aria-label="Fechar painel" className="rounded-md p-1 text-text-secondary hover:bg-app">
          <X size={16} aria-hidden />
        </Link>
      </div>

      <dl className="m-0 grid grid-cols-2 gap-3 text-body">
        <div>
          <dt className="text-meta text-text-tertiary">Etapa</dt>
          <dd className="m-0 text-text">{opportunity.stageName}</dd>
        </div>
        {value !== undefined ? (
          <div>
            <dt className="text-meta text-text-tertiary">Valor estimado</dt>
            <dd className="m-0 font-mono text-text">{value}</dd>
          </div>
        ) : null}
        <div>
          <dt className="text-meta text-text-tertiary">Responsável</dt>
          <dd className="m-0 text-text">{opportunity.assignedToName ?? "Sem responsável"}</dd>
        </div>
        {stalledDays !== null ? (
          <div>
            <dt className="text-meta text-text-tertiary">Na etapa há</dt>
            <dd className="m-0 text-text">
              {stalledDays} dia{stalledDays === 1 ? "" : "s"}
            </dd>
          </div>
        ) : null}
        <div className="col-span-2">
          <dt className="text-meta text-text-tertiary">Próxima ação</dt>
          <dd className="m-0 text-text">
            {opportunity.nextAction
              ? `${ACTIVITY_TYPE_LABEL[opportunity.nextAction.type]}: ${opportunity.nextAction.title} — ${formatDue(opportunity.nextAction.dueAt, opportunity.nextAction.hasTime)}`
              : "Sem próxima atividade agendada"}
            {opportunity.overdueActivitiesCount > 0 ? (
              <span className="ml-2 rounded-full bg-danger-bg px-2 py-0.5 text-meta font-medium text-danger">
                {opportunity.overdueActivitiesCount} atrasada{opportunity.overdueActivitiesCount === 1 ? "" : "s"}
              </span>
            ) : null}
          </dd>
        </div>
      </dl>

      <div className="flex flex-wrap gap-2">
        <Button asChild variant="secondary" size="sm">
          <Link href={`/leads/${opportunity.leadId}`}>Abrir perfil completo</Link>
        </Button>
        {canEdit && opportunity.status === "open" ? (
          <>
            <Button type="button" variant="secondary" size="sm" onClick={() => setWonOpen(true)}>
              Ganhou
            </Button>
            <Button type="button" variant="secondary" size="sm" onClick={() => setLostOpen(true)}>
              Perdeu
            </Button>
          </>
        ) : null}
      </div>

      {wonOpen ? (
        <WonDialog
          opportunity={opportunity}
          open={wonOpen}
          onOpenChange={setWonOpen}
          onDone={() => {
            setWonOpen(false);
            router.refresh();
          }}
        />
      ) : null}
      {lostOpen ? (
        <LostDialog
          opportunity={opportunity}
          workspaceId={opportunity.workspaceId}
          open={lostOpen}
          onOpenChange={setLostOpen}
          onDone={() => {
            setLostOpen(false);
            router.refresh();
          }}
        />
      ) : null}
    </aside>
  );
}
