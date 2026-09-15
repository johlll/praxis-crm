import type { Metadata } from "next";
import Link from "next/link";
import { GitBranch } from "lucide-react";

import { Topbar } from "@/components/app-shell/topbar";
import { EmptyState } from "@/components/feedback/empty-state";
import { getShellContext } from "@/modules/shell/queries";
import { requireWorkspace } from "@/server/authz/permissions";
import { roleHasPermission } from "@/lib/roles";
import { getDefaultPipeline, getPipelineBoard, listOpportunities } from "@/modules/opportunities/queries";
import { PipelineBoard } from "@/components/pipeline/pipeline-board";
import { OpportunityTable } from "@/components/pipeline/opportunity-table";
import { OpportunityTablePagination } from "@/components/pipeline/opportunity-table-pagination";

function countLabel(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

export const metadata: Metadata = {
  title: "Pipeline — Praxis CRM Jurídico",
};

export default async function PipelinePage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string; page?: string }>;
}) {
  const { user } = await getShellContext();
  const workspaceId = await requireWorkspace();
  const params = await searchParams;
  const view = params.view === "tabela" ? "tabela" : "kanban";
  const page = Math.max(1, Number.parseInt(params.page ?? "1", 10) || 1);
  const canEdit = roleHasPermission(user.role, "opportunity.edit");

  const pipeline = await getDefaultPipeline(workspaceId);

  if (!pipeline) {
    return (
      <>
        <Topbar title="Pipeline" subtitle="Oportunidades por etapa" user={user} />
        <main className="flex-1 overflow-y-auto p-5">
          <EmptyState
            icon={GitBranch}
            title="Nenhum pipeline configurado"
            description="Este workspace ainda não tem um funil comercial."
          />
        </main>
      </>
    );
  }

  const board = view === "kanban" ? await getPipelineBoard(pipeline.id) : null;
  // Tabela paginada: antes mostrava só a 1ª página (20) sem como avançar.
  const table = view === "tabela" ? await listOpportunities(workspaceId, { pipelineId: pipeline.id, page }) : null;
  // O kanban conta só as abertas; a tabela lista todos os status — o
  // subtítulo diz qual das duas contagens está na tela.
  const subtitle = board
    ? countLabel(board.reduce((sum, col) => sum + col.count, 0), "oportunidade aberta", "oportunidades abertas")
    : countLabel(table?.total ?? 0, "oportunidade", "oportunidades");

  return (
    <>
      <Topbar
        title="Pipeline"
        subtitle={`${pipeline.name} · ${subtitle}`}
        user={user}
      />
      <main className="flex-1 overflow-y-auto p-5">
        <div className="mx-auto flex max-w-[1400px] flex-col gap-4">
          <div className="flex items-center gap-2">
            <Link
              href="/pipeline?view=kanban"
              className={`rounded-input border px-2.5 py-1 text-meta font-medium ${
                view === "kanban" ? "border-primary bg-primary-tint text-primary" : "border-border text-text-secondary"
              }`}
            >
              Kanban
            </Link>
            <Link
              href="/pipeline?view=tabela"
              className={`rounded-input border px-2.5 py-1 text-meta font-medium ${
                view === "tabela" ? "border-primary bg-primary-tint text-primary" : "border-border text-text-secondary"
              }`}
            >
              Tabela
            </Link>
          </div>

          {board ? (
            <PipelineBoard workspaceId={workspaceId} columns={board} canEdit={canEdit} />
          ) : table ? (
            <>
              <OpportunityTable items={table.items} />
              <OpportunityTablePagination page={table.page} total={table.total} pageSize={table.pageSize} />
            </>
          ) : null}
        </div>
      </main>
    </>
  );
}
