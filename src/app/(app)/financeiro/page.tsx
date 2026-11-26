import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { Topbar } from "@/components/app-shell/topbar";
import { FinanceDashboard } from "@/components/finance/finance-dashboard";
import { FinanceUnavailable } from "@/components/finance/finance-unavailable";
import { dateTimeInputParts } from "@/lib/timezone";
import { buildFinanceDemo } from "@/modules/finance/demo-data";
import { getShellContext } from "@/modules/shell/queries";
import { isDemoWorkspace } from "@/modules/workspace/demo";
import { requireMembership, roleHasPermission } from "@/server/authz/permissions";

export const metadata: Metadata = {
  title: "Financeiro — Praxis CRM Jurídico",
};

/**
 * Financeiro (docs/decisoes/financeiro.md). Etapa visual com demonstração: não há lançamento gravado, banco,
 * cobrança, integração bancária, nota ou contabilidade.
 *
 * Quem acessa: proprietário, administrador e gestor (`finance.view`); os demais recebem "não encontrado". Os
 * lançamentos fictícios são montados AQUI, no servidor, só para o escritório demonstrativo — parâmetro de URL
 * não libera nada (a página nem lê a URL).
 */
export default async function FinanceiroPage() {
  const membership = await requireMembership();
  if (!roleHasPermission(membership.role, "finance.view")) notFound();

  const { user } = await getShellContext();
  const demo = await isDemoWorkspace(membership.workspaceId);
  // "Hoje" no fuso do escritório (America/Sao_Paulo): é o corte de tudo o que a página calcula.
  const today = dateTimeInputParts(new Date().toISOString(), false).date;
  const data = demo ? buildFinanceDemo(today) : null;

  return (
    <>
      <Topbar title="Financeiro" subtitle="Recebimentos, despesas e honorários a receber" user={user} wrapSubtitle />
      <main className="flex-1 overflow-y-auto p-5">
        {/* @container: a grade reage à largura do CONTEÚDO, que muda com a barra lateral aberta. */}
        <div className="@container mx-auto flex max-w-[1400px] flex-col gap-4">
          {data ? (
            // A chave troca de escritório = simulação nova: nada atravessa de um escritório para outro.
            <FinanceDashboard key={membership.workspaceId} initialEntries={data.entries} coverageStart={data.coverageStart} today={today} />
          ) : (
            <FinanceUnavailable />
          )}
        </div>
      </main>
    </>
  );
}
