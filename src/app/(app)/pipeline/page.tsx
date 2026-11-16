import type { Metadata } from "next";
import Link from "next/link";
import { Columns3, Eye, GitBranch, GripVertical, Table2 } from "lucide-react";

import { cn } from "@/lib/cn";

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

  const toolbar = (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <nav aria-label="Modo de visualização" className="flex rounded-[10px] border border-border bg-surface-subtle p-0.5">
        {(
          [
            { key: "kanban", label: "Kanban", icon: Columns3 },
            { key: "tabela", label: "Tabela", icon: Table2 },
          ] as const
        ).map(({ key, label, icon: Icon }) => (
          <Link
            key={key}
            href={`/pipeline?view=${key}`}
            aria-current={view === key ? "page" : undefined}
            className={cn(
              "flex h-7 items-center gap-1.5 rounded-[8px] px-2.5 text-small font-semibold no-underline transition-colors hover:no-underline",
              view === key
                ? "bg-surface-hover text-text shadow-card"
                : "text-text-muted hover:text-text",
            )}
          >
            <Icon size={14} strokeWidth={1.5} aria-hidden />
            {label}
          </Link>
        ))}
      </nav>
      {board ? (
        <p className="m-0 flex items-center gap-1.5 text-meta text-text-muted">
          {canEdit ? (
            <>
              <GripVertical size={13} aria-hidden />
              Arraste um cartão para outra etapa ou use o botão Mover.
            </>
          ) : (
            <>
              <Eye size={13} aria-hidden />
              Somente visualização: seu papel não move oportunidades.
            </>
          )}
        </p>
      ) : null}
    </div>
  );

  return (
    <>
      <Topbar title="Pipeline" subtitle={`${pipeline.name} · ${subtitle}`} user={user} />
      {board ? (
        // Kanban ocupa a altura disponível: cada coluna rola por dentro e o
        // quadro rola na horizontal, sem a página inteira transbordar.
        <main className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden px-5 pt-1 pb-3">
          {toolbar}
          <PipelineBoard workspaceId={workspaceId} columns={board} canEdit={canEdit} />
        </main>
      ) : (
        <main className="flex-1 overflow-y-auto px-5 pt-1 pb-5">
          <div className="mx-auto flex max-w-[1400px] flex-col gap-4">
            {toolbar}
            {table ? (
              <>
                <OpportunityTable items={table.items} />
                <OpportunityTablePagination page={table.page} total={table.total} pageSize={table.pageSize} />
              </>
            ) : null}
          </div>
        </main>
      )}
    </>
  );
}
