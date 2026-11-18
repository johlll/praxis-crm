import Link from "next/link";

import { Button } from "@/components/ui/button";

/**
 * Paginação da lista. `hrefFor` monta o endereço da página preservando busca,
 * filtro e a conversa aberta (a navegação e o Voltar do navegador continuam
 * funcionando, e a seleção não se perde ao paginar).
 */
export function ConversationsPagination({
  page,
  total,
  pageSize,
  hrefFor,
}: {
  page: number;
  total: number;
  pageSize: number;
  hrefFor: (page: number) => string;
}) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  if (totalPages <= 1) return null;

  return (
    <nav
      aria-label="Paginação das conversas"
      className="flex shrink-0 items-center justify-between gap-2 border-t border-border px-3 py-2.5 text-meta text-text-tertiary"
    >
      <span>
        Página {page} de {totalPages}
        <span className="sr-only">
          {" "}
          — {total} {total === 1 ? "conversa" : "conversas"}
        </span>
      </span>
      <div className="flex gap-2">
        {page <= 1 ? (
          <Button variant="secondary" size="sm" disabled>
            Anterior
          </Button>
        ) : (
          <Button asChild variant="secondary" size="sm">
            <Link href={hrefFor(page - 1) as never}>Anterior</Link>
          </Button>
        )}
        {page >= totalPages ? (
          <Button variant="secondary" size="sm" disabled>
            Próxima
          </Button>
        ) : (
          <Button asChild variant="secondary" size="sm">
            <Link href={hrefFor(page + 1) as never}>Próxima</Link>
          </Button>
        )}
      </div>
    </nav>
  );
}
