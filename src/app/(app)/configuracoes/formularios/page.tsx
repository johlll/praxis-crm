import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { Topbar } from "@/components/app-shell/topbar";
import { getShellContext } from "@/modules/shell/queries";
import { requireMembership, roleHasPermission } from "@/server/authz/permissions";
import { listPipelines, listPipelineStagesWithDetails } from "@/modules/opportunities/queries";
import { listFormEndpoints } from "@/modules/forms/queries";
import { FormEndpointsManager } from "@/components/forms/form-endpoints-manager";
import { EmptyState } from "@/components/feedback/empty-state";

export const metadata: Metadata = {
  title: "Formulários — Praxis CRM Jurídico",
};

/**
 * Configuração dos formulários públicos (A11).
 *
 * Restrita a owner/admin: abre uma porta pública. Um papel sem a
 * permissão recebe "não encontrado", nunca "proibido" — não revela que a
 * tela existe.
 */
export default async function FormulariosConfigPage() {
  const membership = await requireMembership();
  if (!roleHasPermission(membership.role, "form_endpoint.manage")) {
    notFound();
  }

  const { user, activeWorkspace } = await getShellContext();
  const pipelines = await listPipelines(activeWorkspace.id);

  if (pipelines.length === 0) {
    return (
      <>
        <Topbar title="Formulários" subtitle={activeWorkspace.name} user={user} />
        <main className="flex-1 overflow-y-auto p-5">
          <div className="mx-auto max-w-[760px]">
            <EmptyState
              title="Nenhum pipeline configurado"
              description="Configure um pipeline antes de criar um formulário público: a captação precisa de um destino explícito."
            />
          </div>
        </main>
      </>
    );
  }

  const [endpoints, stageLists] = await Promise.all([
    listFormEndpoints(activeWorkspace.id),
    Promise.all(pipelines.map((pipeline) => listPipelineStagesWithDetails(pipeline.id))),
  ]);

  const stages = stageLists.flat().map((stage) => ({
    id: stage.id,
    name: stage.name,
    pipelineId: stage.pipelineId,
    isTerminal: stage.isWon || stage.isLost,
  }));

  return (
    <>
      <Topbar title="Formulários" subtitle={activeWorkspace.name} user={user} />
      <main className="flex-1 overflow-y-auto p-5">
        <div className="mx-auto flex max-w-[760px] flex-col gap-4">
          <p className="m-0 text-meta text-text-muted">
            Cada formulário tem endereço público próprio, chave rotacionável e pode ser desativado sem apagar nada do
            que já foi recebido. A captação exige Turnstile, limite de envios e domínios declarados.
          </p>
          <FormEndpointsManager endpoints={endpoints} pipelines={pipelines} stages={stages} />
        </div>
      </main>
    </>
  );
}
