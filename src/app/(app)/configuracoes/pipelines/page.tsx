import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { Topbar } from "@/components/app-shell/topbar";
import { getShellContext } from "@/modules/shell/queries";
import { requireMembership, roleHasPermission } from "@/server/authz/permissions";
import { getDefaultPipeline, listLostReasons, listPipelineStagesWithDetails } from "@/modules/opportunities/queries";
import { EmptyState } from "@/components/feedback/empty-state";
import { CreateStageDialog } from "@/components/pipeline-config/create-stage-dialog";
import { StageRow } from "@/components/pipeline-config/stage-row";
import { LostReasonsSection } from "@/components/pipeline-config/lost-reasons-section";

export const metadata: Metadata = {
  title: "Pipelines — Praxis CRM Jurídico",
};

export default async function PipelinesConfigPage() {
  const membership = await requireMembership();
  if (!roleHasPermission(membership.role, "pipeline.configure")) {
    notFound();
  }

  const { user, activeWorkspace } = await getShellContext();
  const pipeline = await getDefaultPipeline(activeWorkspace.id);

  if (!pipeline) {
    return (
      <>
        <Topbar title="Pipelines" subtitle={activeWorkspace.name} user={user} />
        <main className="flex-1 overflow-y-auto p-5">
          <div className="mx-auto max-w-[720px]">
            <EmptyState
              title="Nenhum pipeline configurado"
              description="Este workspace ainda não tem um pipeline padrão."
            />
          </div>
        </main>
      </>
    );
  }

  const [stages, lostReasons] = await Promise.all([
    listPipelineStagesWithDetails(pipeline.id),
    listLostReasons(activeWorkspace.id),
  ]);
  const orderedStageIds = stages.map((s) => s.id);

  return (
    <>
      <Topbar title="Pipelines" subtitle={`${pipeline.name} — ${activeWorkspace.name}`} user={user} />
      <main className="flex-1 overflow-y-auto p-5">
        <div className="mx-auto flex max-w-[720px] flex-col gap-5">
          <section className="rounded-lg border border-border bg-surface">
            <div className="flex items-center justify-between border-b border-border px-4 py-3">
              <div>
                <h2 className="text-body font-semibold text-text">Etapas</h2>
                <p className="text-meta text-text-tertiary">
                  Ordem, cor, requisitos de avanço e marcação de ganho/perda.
                </p>
              </div>
              <CreateStageDialog pipelineId={pipeline.id} />
            </div>
            {stages.length === 0 ? (
              <div className="p-4">
                <EmptyState title="Nenhuma etapa" description="Crie a primeira etapa deste pipeline." />
              </div>
            ) : (
              stages.map((stage, index) => (
                <StageRow
                  key={stage.id}
                  stage={stage}
                  pipelineId={pipeline.id}
                  orderedStageIds={orderedStageIds}
                  index={index}
                  total={stages.length}
                />
              ))
            )}
          </section>

          <LostReasonsSection workspaceId={activeWorkspace.id} reasons={lostReasons} />
        </div>
      </main>
    </>
  );
}
