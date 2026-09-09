import Link from "next/link";

import { Button } from "@/components/ui/button";

type PaginationProps = {
  page: number;
  total: number;
  pageSize: number;
  basePath: string;
  query?: string | undefined;
};

export function Pagination({ page, total, pageSize, basePath, query }: PaginationProps) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  if (totalPages <= 1) return null;

  function href(targetPage: number) {
    const params = new URLSearchParams();
    if (query) params.set("q", query);
    params.set("page", String(targetPage));
    return `${basePath}?${params.toString()}` as never;
  }

  return (
    <div className="flex items-center justify-between text-meta text-text-tertiary">
      <span>
        Página {page} de {totalPages}
      </span>
      <div className="flex gap-2">
        {/* Button asChild + Link com disabled não funciona — <a> não tem
            comportamento nativo de disabled, o link continuaria clicável.
            Sem link nenhum quando desabilitado, em vez de um link morto. */}
        {page <= 1 ? (
          <Button variant="secondary" size="sm" disabled>
            Anterior
          </Button>
        ) : (
          <Button asChild variant="secondary" size="sm">
            <Link href={href(page - 1)}>Anterior</Link>
          </Button>
        )}
        {page >= totalPages ? (
          <Button variant="secondary" size="sm" disabled>
            Próxima
          </Button>
        ) : (
          <Button asChild variant="secondary" size="sm">
            <Link href={href(page + 1)}>Próxima</Link>
          </Button>
        )}
      </div>
    </div>
  );
}
