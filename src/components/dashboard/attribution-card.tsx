"use client";

import type { Route } from "next";
import Link from "next/link";

import { cn } from "@/lib/cn";
import type { DashboardAttribution } from "@/modules/attribution/queries";
import { ATTRIBUTION_MODEL_LABEL, ATTRIBUTION_MODELS, NO_SOURCE_FILTER } from "@/modules/forms/schema";

/**
 * Origem dos leads por modelo de atribuição (A11).
 *
 * Duas honestidades que a tela precisa manter à vista:
 *
 *  1. a UNIDADE é a oportunidade, não o lead. Um lead pode ter várias
 *     oportunidades com origens diferentes; contar "leads por origem"
 *     trocaria a unidade no meio do caminho sem avisar.
 *  2. o NÚMERO MUDA conforme o modelo — e isso é dito com todas as
 *     letras, porque é a diferença entre "quem trouxe" e "quem fechou".
 *
 * O filtro de origem é coerente com o modelo escolhido: filtrar "X" no
 * primeiro toque mantém as oportunidades cujo primeiro toque tem origem
 * X; no último toque, cujo último toque tem origem X.
 */
export function AttributionCard({
  attribution,
  modelHrefs,
  sourceHrefs,
  clearSourceHref,
}: {
  attribution: DashboardAttribution;
  modelHrefs: Record<string, Route>;
  sourceHrefs: Record<string, Route>;
  clearSourceHref: Route;
}) {
  const total = attribution.sources.reduce((sum, row) => sum + row.created, 0);

  return (
    <section aria-labelledby="origem-titulo" className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-col">
          <h2 id="origem-titulo" className="m-0 text-body font-bold text-text">
            Origem das oportunidades
          </h2>
          <p className="m-0 text-meta text-text-muted">
            Unidade: oportunidade. O número muda conforme o modelo escolhido — é o mesmo dado lido de outro jeito, não
            uma correção do anterior.
          </p>
        </div>

        <nav aria-label="Modelo de atribuição" className="flex flex-wrap gap-1.5">
          {ATTRIBUTION_MODELS.map((model) => (
            <Link
              key={model}
              href={modelHrefs[model] ?? "/visao-geral"}
              aria-current={attribution.model === model ? "true" : undefined}
              className={cn(
                "rounded-pill border px-2.5 py-0.5 text-meta",
                attribution.model === model
                  ? "border-primary bg-primary-tint text-primary"
                  : "border-border text-text-secondary",
              )}
            >
              {ATTRIBUTION_MODEL_LABEL[model]}
            </Link>
          ))}
        </nav>
      </div>

      {attribution.model === "conversion" ? (
        <p className="m-0 rounded-md bg-app px-3 py-2 text-meta text-text-secondary">
          Conversão conta apenas a interação que nasceu na própria oportunidade. Uma interação corrigida para cá depois
          aparece no primeiro e no último toque, nunca aqui.
        </p>
      ) : null}

      {attribution.sources.length === 0 ? (
        <p className="m-0 rounded-md bg-app px-3 py-6 text-center text-body text-text-secondary">
          Nenhuma oportunidade com origem registrada neste período.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-body">
            <thead>
              <tr className="text-left text-label font-semibold tracking-[1px] text-text-tertiary uppercase">
                <th scope="col" className="py-2 pr-3 font-semibold">Origem</th>
                <th scope="col" className="px-3 py-2 text-right font-semibold">Criadas</th>
                <th scope="col" className="py-2 pl-3 text-right font-semibold">Ganhas</th>
              </tr>
            </thead>
            <tbody>
              {attribution.sources.map((row) => {
                const key = row.source ?? NO_SOURCE_FILTER;
                const selected = (attribution.source ?? null) === (row.source ?? NO_SOURCE_FILTER);
                return (
                  <tr key={key} className="border-t border-border-subtle">
                    <th scope="row" className="py-2 pr-3 text-left font-semibold">
                      <Link
                        href={sourceHrefs[key] ?? "/visao-geral"}
                        aria-current={selected ? "true" : undefined}
                        className={selected ? "text-primary" : undefined}
                      >
                        {row.source ?? "Não informada"}
                      </Link>
                    </th>
                    <td className="px-3 py-2 text-right tabular">{row.created}</td>
                    <td className="py-2 pl-3 text-right tabular">{row.won}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border-subtle pt-3">
        <p className="m-0 text-meta text-text-muted">
          {attribution.unattributedCreated > 0
            ? `${attribution.unattributedCreated} de ${total} criadas no período sem interação elegível ("Não atribuído").`
            : "Todas as oportunidades criadas no período têm interação elegível."}
        </p>
        {attribution.source ? (
          <Link href={clearSourceHref} className="text-meta text-primary">
            Limpar origem
          </Link>
        ) : null}
      </div>
    </section>
  );
}
