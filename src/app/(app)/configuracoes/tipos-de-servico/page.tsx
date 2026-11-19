import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { Topbar } from "@/components/app-shell/topbar";
import { ServiceTypeCatalog } from "@/components/service-catalog/service-type-catalog";
import { listServiceTypes } from "@/modules/case-service/queries";
import { getShellContext } from "@/modules/shell/queries";
import { requireMembership, roleHasPermission } from "@/server/authz/permissions";

export const metadata: Metadata = {
  title: "Tipos de serviço — Praxis CRM Jurídico",
};

/**
 * Catálogo de tipos de serviço e etapas do escritório (painel do caso, etapa B). Só `service_catalog.manage`
 * (proprietário, administrador e gestor); qualquer outro papel recebe "não encontrado". O workspace vem
 * SEMPRE da sessão; o banco repete a checagem. Os modelos sugeridos só entram por escolha explícita.
 */
export default async function TiposDeServicoPage() {
  const membership = await requireMembership();
  if (!roleHasPermission(membership.role, "service_catalog.manage")) {
    notFound();
  }

  const { user, activeWorkspace } = await getShellContext();
  const types = await listServiceTypes(membership.workspaceId);
  if (types === null) notFound();

  return (
    <>
      <Topbar title="Tipos de serviço" subtitle={activeWorkspace.name} user={user} />
      <main className="flex-1 overflow-y-auto p-5">
        <div className="mx-auto flex max-w-[900px] flex-col gap-6">
          <p className="m-0 text-meta text-text-muted">
            Cada tipo de serviço tem um roteiro de etapas em ordem. Na conversa, um caso ganho pode receber um roteiro por
            escolha de quem cuida dele: as etapas são COPIADAS para o caso. Editar ou arquivar um tipo aqui não muda os casos
            que já o usam. Nenhum roteiro é aplicado sozinho.
          </p>
          <ServiceTypeCatalog types={types} />
        </div>
      </main>
    </>
  );
}
