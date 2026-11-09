import Link from "next/link";
import type { Route } from "next";

import { Button } from "@/components/ui/button";
import { auditHref, type AuditCursor, type AuditFilters } from "@/modules/audit/schema";

/**
 * Paginação por cursor: a trilha cresce o tempo todo, então "página N" mudaria
 * de conteúdo entre um clique e outro. Aqui cada link carrega a posição exata
 * (created_at, id) do último registro visto, mantendo os filtros.
 */
export function AuditPagination({
  filters,
  hasMore,
  nextCursor,
  isFirstPage,
}: {
  filters: AuditFilters;
  hasMore: boolean;
  nextCursor: AuditCursor | null;
  isFirstPage: boolean;
}) {
  if (isFirstPage && !hasMore) return null;

  return (
    <nav aria-label="Paginação da auditoria" className="flex items-center justify-between text-meta text-text-tertiary">
      <span>{isFirstPage ? "Registros mais recentes" : "Registros anteriores"}</span>
      <div className="flex gap-2">
        {isFirstPage ? null : (
          <Button asChild variant="secondary" size="sm">
            <Link href={auditHref(filters) as Route}>Voltar ao início</Link>
          </Button>
        )}
        {hasMore && nextCursor ? (
          <Button asChild variant="secondary" size="sm">
            <Link href={auditHref(filters, nextCursor) as Route}>Registros mais antigos</Link>
          </Button>
        ) : (
          <Button variant="secondary" size="sm" disabled>
            Registros mais antigos
          </Button>
        )}
      </div>
    </nav>
  );
}
