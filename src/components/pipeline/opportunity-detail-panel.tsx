"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import type { OpportunityDetail } from "@/modules/opportunities/queries";
import { WonDialog } from "./won-dialog";
import { LostDialog } from "./lost-dialog";

function formatCents(cents: number): string {
  return (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

const STATUS_LABEL: Record<OpportunityDetail["status"], string> = {
  open: "Aberta",
  won: "Ganha",
  lost: "Perdida",
};

export function OpportunityDetailPanel({
  opportunity,
  canEdit,
}: {
  opportunity: OpportunityDetail;
  canEdit: boolean;
}) {
  const router = useRouter();
  const [wonOpen, setWonOpen] = useState(false);
  const [lostOpen, setLostOpen] = useState(false);

  return (
    <div className="flex flex-col gap-4">
      <section className="rounded-lg border border-border bg-surface p-4">
        <h2 className="mb-3 text-body font-semibold text-text">Dados da oportunidade</h2>
        <dl className="grid grid-cols-2 gap-3 text-body">
          <div>
            <dt className="text-meta text-text-tertiary">Etapa</dt>
            <dd className="text-text">{opportunity.stageName}</dd>
          </div>
          <div>
            <dt className="text-meta text-text-tertiary">Status</dt>
            <dd className="text-text">{STATUS_LABEL[opportunity.status]}</dd>
          </div>
          <div>
            <dt className="text-meta text-text-tertiary">Responsável</dt>
            <dd className="text-text">{opportunity.assignedToName ?? "Sem responsável"}</dd>
          </div>
          <div>
            <dt className="text-meta text-text-tertiary">Valor</dt>
            <dd className="font-mono text-text">
              {opportunity.valueCents !== undefined
                ? formatCents(opportunity.valueCents)
                : (opportunity.valueBand ?? "—")}
            </dd>
          </div>
          {opportunity.status === "lost" && opportunity.lostReasonLabel ? (
            <div className="col-span-2">
              <dt className="text-meta text-text-tertiary">Motivo da perda</dt>
              <dd className="text-text">{opportunity.lostReasonLabel}</dd>
            </div>
          ) : null}
        </dl>

        {canEdit && opportunity.status === "open" ? (
          <div className="mt-4 flex gap-2">
            <Button type="button" variant="secondary" size="sm" onClick={() => setWonOpen(true)}>
              Ganhou
            </Button>
            <Button type="button" variant="secondary" size="sm" onClick={() => setLostOpen(true)}>
              Perdeu
            </Button>
          </div>
        ) : null}
      </section>

      {opportunity.history.length > 0 ? (
        <section className="rounded-lg border border-border bg-surface p-4">
          <h2 className="mb-3 text-body font-semibold text-text">Histórico de etapas</h2>
          <ul className="flex flex-col gap-2">
            {opportunity.history.map((h, i) => (
              <li key={i} className="text-meta text-text-secondary">
                {new Date(h.occurredAt).toLocaleString("pt-BR")}
                {h.secondsInPreviousStage !== null
                  ? ` — ${Math.round(h.secondsInPreviousStage / 3600)}h na etapa anterior`
                  : ""}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

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
    </div>
  );
}
