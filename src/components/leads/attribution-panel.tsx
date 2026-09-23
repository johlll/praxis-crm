"use client";

import { useActionState, useState } from "react";

import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { formatDateTime } from "@/lib/timezone";
import {
  correctTouchpointLinkAction,
  issueContinuityReferenceAction,
  type ContinuityActionState,
  type FormActionState,
} from "@/modules/forms/actions";
import type { LeadAttribution, TouchpointItem } from "@/modules/attribution/queries";

/**
 * AttributionPanel (A11) — sequência completa de interações do contato e
 * a atribuição POR OPORTUNIDADE.
 *
 * Duas coisas que a tela nunca deixa ambíguas:
 *  1. a unidade é a oportunidade, não o lead (um lead pode ter várias, e
 *     uma nunca empresta origem à outra);
 *  2. "Não atribuído" é um resultado legítimo e aparece como tal — nunca
 *     se escolhe uma oportunidade qualquer do lead para preencher.
 */

const INITIAL: FormActionState = { ok: false };
const CONTINUITY_INITIAL: ContinuityActionState = { ok: false };

/**
 * Botão que emite um link de continuidade (A11, item 5 da auditoria
 * pós-dry-run): o token só existe em claro NESTA resposta — some ao sair
 * da tela ou pedir outro. O servidor grava só o hash.
 */
function IssueContinuityLink({ leadId }: { leadId: string }) {
  const [state, action, pending] = useActionState(issueContinuityReferenceAction, CONTINUITY_INITIAL);

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-3">
      <div className="flex items-center justify-between gap-2">
        <div>
          <p className="m-0 text-body font-semibold text-text">Link de continuidade</p>
          <p className="m-0 text-meta text-text-muted">
            Gera um token de uso único (válido por 30 dias) para o formulário de continuidade reconhecer este lead
            sem usar telefone ou e-mail como identidade.
          </p>
        </div>
        <form action={action}>
          <input type="hidden" name="leadId" value={leadId} />
          <Button type="submit" variant="secondary" size="sm" disabled={pending}>
            {pending ? "Gerando…" : "Gerar link"}
          </Button>
        </form>
      </div>

      {state.error ? (
        <Alert variant="danger">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      ) : null}
      {state.ok && state.token ? (
        <Alert variant="success">
          <AlertDescription>
            Token (mostrado uma única vez — copie agora): <code className="break-all">{state.token}</code>
            {state.expiresAt ? ` · válido até ${formatDateTime(state.expiresAt)}` : ""}
          </AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}

function Chip({ children, tone = "neutral" }: { children: React.ReactNode; tone?: "neutral" | "primary" }) {
  return (
    <span
      className={`rounded-pill px-1.5 py-0.5 text-[9.5px] font-semibold tracking-[0.4px] uppercase ${
        tone === "primary" ? "bg-primary-tint text-primary" : "bg-neutral-bg text-text-tertiary"
      }`}
    >
      {children}
    </span>
  );
}

function roleLabels(touchpointId: string, attribution: LeadAttribution): string[] {
  const labels: string[] = [];
  for (const opportunity of attribution.opportunities) {
    if (opportunity.firstTouchId === touchpointId) labels.push("Primeiro toque");
    if (opportunity.lastTouchId === touchpointId) labels.push("Último toque");
    if (opportunity.conversionId === touchpointId) labels.push("Conversão");
  }
  return [...new Set(labels)];
}

function TouchpointRow({
  touchpoint,
  attribution,
  opportunities,
  canCorrect,
}: {
  touchpoint: TouchpointItem;
  attribution: LeadAttribution;
  opportunities: { id: string; label: string }[];
  canCorrect: boolean;
}) {
  const [state, action, pending] = useActionState(correctTouchpointLinkAction, INITIAL);
  const [open, setOpen] = useState(false);

  const labels = roleLabels(touchpoint.id, attribution);
  const effective = touchpoint.effectiveOpportunityId;
  const effectiveLabel = effective
    ? (opportunities.find((o) => o.id === effective)?.label ?? "Oportunidade")
    : "Não atribuído";

  return (
    <li className="flex flex-col gap-1 border-l-2 border-border py-2 pl-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-body font-semibold text-text">
          {touchpoint.source ? `${touchpoint.channel} · ${touchpoint.source}` : touchpoint.channel}
        </span>
        {labels.map((label) => (
          <Chip key={label} tone="primary">
            {label}
          </Chip>
        ))}
        <Chip>{effectiveLabel}</Chip>
      </div>

      <span className="text-meta text-text-secondary">
        {[touchpoint.campaign && `campanha: ${touchpoint.campaign}`, touchpoint.medium && `mídia: ${touchpoint.medium}`,
          touchpoint.term && `termo: ${touchpoint.term}`, touchpoint.landingUrl && `página: ${touchpoint.landingUrl}`]
          .filter(Boolean)
          .join(" · ") || "Sem parâmetros de origem declarados"}
      </span>

      <span className="font-mono text-meta text-text-tertiary">
        {formatDateTime(touchpoint.normalizedOccurredAt)}
        {touchpoint.normalizationCode && touchpoint.normalizationCode !== "ok" ? (
          <span title="A data declarada foi normalizada para a data de recebimento.">
            {" "}
            · data normalizada ({touchpoint.normalizationCode})
          </span>
        ) : null}
      </span>

      {touchpoint.history.length > 1 ? (
        <details className="text-meta text-text-secondary">
          <summary className="cursor-pointer">Histórico de correções ({touchpoint.history.length})</summary>
          <ul className="m-0 flex list-none flex-col gap-0.5 p-0 pt-1">
            {touchpoint.history.map((entry) => (
              <li key={entry.id}>
                {entry.action === "assign" ? "vinculado" : "desvinculado"} ·{" "}
                {entry.actorName ?? "origem da captação"} · {formatDateTime(entry.createdAt)}
                {entry.reason ? ` · ${entry.reason}` : ""}
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {canCorrect ? (
        <div>
          <Button type="button" variant="ghost" size="sm" onClick={() => setOpen((value) => !value)}>
            {open ? "Cancelar" : "Corrigir associação"}
          </Button>

          {open ? (
            <form action={action} className="mt-2 flex flex-col gap-2">
              <input type="hidden" name="touchpointId" value={touchpoint.id} />
              <input type="hidden" name="leadId" value={attribution.leadId} />
              {/* Versão que esta tela está vendo: se alguém corrigir antes,
                  o servidor devolve conflito em vez de criar outra ponta. */}
              <input type="hidden" name="expectedCurrentLinkId" value={touchpoint.currentLinkId ?? ""} />

              <label className="text-meta text-text-secondary">
                Vincular a
                <select
                  name="opportunityId"
                  defaultValue={effective ?? ""}
                  className="ml-2 h-8 rounded-input border border-border-input bg-surface px-2 text-body"
                >
                  <option value="">Não atribuído</option>
                  {opportunities.map((opportunity) => (
                    <option key={opportunity.id} value={opportunity.id}>
                      {opportunity.label}
                    </option>
                  ))}
                </select>
              </label>

              <input
                type="text"
                name="reason"
                maxLength={500}
                placeholder="Motivo da correção (opcional)"
                className="h-8 rounded-input border border-border-input bg-surface px-2 text-body"
              />

              <div className="flex gap-2">
                <Button type="submit" name="action" value="assign" size="sm" disabled={pending}>
                  Vincular
                </Button>
                <Button type="submit" name="action" value="unassign" variant="secondary" size="sm" disabled={pending}>
                  Desvincular
                </Button>
              </div>

              {state.error ? (
                <Alert variant="danger">
                  <AlertDescription>{state.error}</AlertDescription>
                </Alert>
              ) : null}
            </form>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

export function AttributionPanel({
  attribution,
  canCorrect,
  canIssueContinuity,
  leadId,
}: {
  attribution: LeadAttribution;
  canCorrect: boolean;
  canIssueContinuity: boolean;
  leadId: string;
}) {
  const opportunities = attribution.opportunities.map((opportunity) => ({
    id: opportunity.opportunityId,
    label: `${opportunity.stageName} · ${opportunity.status}`,
  }));

  return (
    <section aria-labelledby="atribuicao-titulo" className="flex flex-col gap-3">
      <div className="flex flex-col">
        <h2 id="atribuicao-titulo" className="m-0 text-body font-bold text-text">
          Origem e atribuição
        </h2>
        <p className="m-0 text-meta text-text-muted">
          Sequência completa das interações deste contato. A atribuição é sempre por oportunidade — uma oportunidade
          nunca empresta origem à outra, mesmo sendo do mesmo lead.
        </p>
      </div>

      {attribution.opportunities.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-body">
            <thead>
              <tr className="text-left text-label font-semibold tracking-[1px] text-text-tertiary uppercase">
                <th scope="col" className="py-2 pr-3 font-semibold">Oportunidade</th>
                <th scope="col" className="px-3 py-2 font-semibold">Primeiro toque</th>
                <th scope="col" className="px-3 py-2 font-semibold">Último toque</th>
                <th scope="col" className="py-2 pl-3 font-semibold">Conversão</th>
              </tr>
            </thead>
            <tbody>
              {attribution.opportunities.map((opportunity) => {
                const find = (id: string | null) =>
                  id ? attribution.sequence.find((t) => t.id === id) : undefined;
                const cell = (id: string | null) => {
                  const touchpoint = find(id);
                  if (!touchpoint) return "Não atribuído";
                  return touchpoint.source ? `${touchpoint.channel} · ${touchpoint.source}` : touchpoint.channel;
                };
                return (
                  <tr key={opportunity.opportunityId} className="border-t border-border-subtle">
                    <th scope="row" className="py-2 pr-3 text-left font-semibold">
                      {opportunity.stageName}
                    </th>
                    <td className="px-3 py-2">{cell(opportunity.firstTouchId)}</td>
                    <td className="px-3 py-2">{cell(opportunity.lastTouchId)}</td>
                    <td className="py-2 pl-3">{cell(opportunity.conversionId)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="mt-2 mb-0 text-meta text-text-muted">
            A conversão exige que a interação tenha nascido nesta oportunidade. Uma interação apenas corrigida para cá
            participa do primeiro e do último toque, nunca da conversão.
          </p>
        </div>
      ) : null}

      {attribution.sequence.length === 0 ? (
        <p className="m-0 py-4 text-body text-text-tertiary">Nenhuma interação registrada ainda.</p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-0 p-0">
          {attribution.sequence.map((touchpoint) => (
            <TouchpointRow
              key={touchpoint.id}
              touchpoint={touchpoint}
              attribution={attribution}
              opportunities={opportunities}
              canCorrect={canCorrect}
            />
          ))}
        </ul>
      )}

      {canIssueContinuity ? <IssueContinuityLink leadId={leadId} /> : null}
    </section>
  );
}
