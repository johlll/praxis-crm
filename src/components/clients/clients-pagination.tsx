import Link from "next/link";

import { Button } from "@/components/ui/button";

type ClientsPaginationProps = {
  page: number;
  total: number;
  pageSize: number;
  currentParams: Record<string, string | undefined>;
};

/** Mesmo padrão de LeadsPagination (A4). */
export function ClientsPagination({ page, total, pageSize, currentParams }: ClientsPaginationProps) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  if (totalPages <= 1) return null;

  function href(targetPage: number) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(currentParams)) {
      if (key !== "page" && value) params.set(key, value);
    }
    params.set("page", String(targetPage));
    return `/clientes?${params.toString()}` as never;
  }

  return (
    <div className="flex items-center justify-between text-meta text-text-tertiary">
      <span>
        Página {page} de {totalPages} — {total} {total === 1 ? "cliente" : "clientes"}
      </span>
      <div className="flex gap-2">
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
