import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ScrollText } from "lucide-react";

import { Topbar } from "@/components/app-shell/topbar";
import { EmptyState } from "@/components/feedback/empty-state";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { AuditFilterBar } from "@/components/audit/audit-filter-bar";
import { AuditLogList } from "@/components/audit/audit-log-list";
import { AuditPagination } from "@/components/audit/audit-pagination";
import { getShellContext } from "@/modules/shell/queries";
import { requireMembership, roleHasPermission } from "@/server/authz/permissions";
import { listTeamMembers } from "@/modules/team/queries";
import { listAuditLog } from "@/modules/audit/queries";
import { parseAuditSearchParams, type AuditSearchParams } from "@/modules/audit/schema";

export const metadata: Metadata = {
  title: "Auditoria — Praxis CRM Jurídico",
};

/**
 * Trilha de auditoria (B5) — somente leitura.
 *
 * Só quem tem `audit_log.view` (owner e admin). Um papel sem a permissão
 * recebe "não encontrado", nunca "proibido": não revela que a tela existe.
 * O workspace vem SEMPRE da sessão (membership revalidada), nunca da URL; o
 * banco repete a checagem e trata workspace alheio como inexistente.
 */
export default async function AuditoriaPage({ searchParams }: { searchParams: Promise<AuditSearchParams> }) {
  const membership = await requireMembership();
  if (!roleHasPermission(membership.role, "audit_log.view")) {
    notFound();
  }

  const { user, activeWorkspace } = await getShellContext();
  const { filters, cursor, periodError } = parseAuditSearchParams(await searchParams);

  const [page, members] = await Promise.all([
    listAuditLog(membership.workspaceId, filters, cursor),
    listTeamMembers(membership.workspaceId, membership.userId),
  ]);
  // O banco recusou (papel mudou desde que a página abriu): mesma resposta de
  // quem nunca teve acesso.
  if (page === null) notFound();

  const hasActiveFilters = Boolean(filters.action || filters.actorUserId || filters.from || filters.to);

  return (
    <>
      <Topbar title="Auditoria" subtitle={activeWorkspace.name} user={user} />
      <main className="flex-1 overflow-y-auto p-5">
        <div className="mx-auto flex max-w-[1100px] flex-col gap-4">
          <p className="m-0 text-meta text-text-muted">
            Registro de quem fez o quê neste workspace, somente para leitura: os registros não podem ser editados nem
            apagados. Dados pessoais, credenciais e conteúdo de mensagens não aparecem aqui.
          </p>

          <AuditFilterBar filters={filters} members={members} hasActiveFilters={hasActiveFilters} />

          {periodError ? (
            <Alert variant="warning">
              <AlertDescription>
                A data inicial não pode ser depois da data final. O período foi ignorado.
              </AlertDescription>
            </Alert>
          ) : null}

          {page.items.length === 0 ? (
            <EmptyState
              icon={ScrollText}
              title={hasActiveFilters ? "Nenhum registro encontrado" : "Nenhum registro ainda"}
              description={
                hasActiveFilters
                  ? "Tente outra ação, pessoa ou período, ou limpe os filtros."
                  : "As ações importantes do workspace aparecem aqui assim que acontecerem."
              }
            />
          ) : (
            <>
              <AuditLogList items={page.items} />
              <AuditPagination
                filters={filters}
                hasMore={page.hasMore}
                nextCursor={page.nextCursor}
                isFirstPage={cursor === null}
              />
            </>
          )}
        </div>
      </main>
    </>
  );
}
