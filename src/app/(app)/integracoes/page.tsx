import type { Metadata } from "next";

import { Topbar } from "@/components/app-shell/topbar";
import { IntegrationsHub } from "@/components/integrations/integrations-hub";
import { loadIntegrationCards } from "@/modules/integrations/status";
import { getShellContext } from "@/modules/shell/queries";
import { requireMembership } from "@/server/authz/permissions";

export const metadata: Metadata = {
  title: "Integrações — Praxis CRM Jurídico",
};

/**
 * Central de Integrações (docs/decisoes/central-integracoes.md). Todo membro vê a central; o que cada cartão
 * informa e oferece segue o papel da sessão. Abrir a página só LÊ. A configuração do Google Agenda continua em
 * /configuracoes/integracoes, com os mesmos fluxos e retornos de autorização.
 */
export default async function CentralDeIntegracoesPage() {
  const membership = await requireMembership();
  const { user } = await getShellContext();
  const cards = await loadIntegrationCards({ workspaceId: membership.workspaceId, role: membership.role });

  return (
    <>
      <Topbar title="Integrações" subtitle="Ferramentas do escritório e a situação de cada uma" user={user} wrapSubtitle />
      <main className="flex-1 overflow-y-auto p-5">
        <div className="@container mx-auto flex max-w-[1400px] flex-col gap-4">
          <IntegrationsHub key={membership.workspaceId} cards={cards} />
        </div>
      </main>
    </>
  );
}
