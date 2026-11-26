import type { Metadata } from "next";

import { Topbar } from "@/components/app-shell/topbar";
import { TrafficView } from "@/components/traffic/traffic-view";
import { dateTimeInputParts } from "@/lib/timezone";
import { getShellContext } from "@/modules/shell/queries";
import { buildDemoDataset } from "@/modules/traffic/demo-data";
import { getTrafficWorkspaceMode } from "@/modules/traffic/queries";
import { parseTrafficFilters } from "@/modules/traffic/schema";
import { requireWorkspace } from "@/server/authz/permissions";

export const metadata: Metadata = {
  title: "Tráfego Pago — Praxis CRM Jurídico",
};

/**
 * Tráfego Pago (docs/decisoes/trafego-pago.md). Etapa visual: não há integração com Meta ou Google e nada é
 * gravado. Os números fictícios são montados AQUI, no servidor, e só quando o escritório é demonstrativo; para
 * qualquer outro, o conjunto nem existe e a tela mostra "Nenhuma conta conectada".
 */
export default async function TrafegoPagoPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { user } = await getShellContext();
  const workspaceId = await requireWorkspace();
  const filters = parseTrafficFilters(await searchParams);
  const mode = await getTrafficWorkspaceMode(workspaceId);
  const today = dateTimeInputParts(new Date().toISOString(), false).date;

  return (
    <>
      <Topbar title="Tráfego Pago" subtitle="Desempenho dos anúncios e geração de oportunidades para o escritório" wrapSubtitle user={user} />
      <main className="flex-1 overflow-y-auto p-5">
        {/* @container: a grade reage à largura do CONTEÚDO, que muda com a barra lateral aberta. */}
        <div className="@container mx-auto flex max-w-[1400px] flex-col gap-4">
          {/* A chave troca de escritório = estado novo (filtros digitados e ordenação não atravessam). */}
          <TrafficView key={workspaceId} dataset={mode === "demo" ? buildDemoDataset(today) : null} filters={filters} today={today} />
        </div>
      </main>
    </>
  );
}
