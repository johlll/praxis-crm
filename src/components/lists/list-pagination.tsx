import Link from "next/link";
import type { Route } from "next";
import { ChevronLeft, ChevronRight } from "lucide-react";

import { cn } from "@/lib/cn";

/**
 * Páginas exibidas na navegação: sempre a primeira, a última e as vizinhas
 * da atual; o resto vira reticências. Pura, testada em
 * tests/unit/refino-visual-3-listagens.test.tsx.
 */
export function pageWindow(page: number, totalPages: number): (number | "gap")[] {
  if (totalPages <= 7) return Array.from({ length: totalPages }, (_, i) => i + 1);
  const wanted = new Set([1, totalPages, page - 1, page, page + 1]);
  if (page <= 3) [2, 3, 4].forEach((p) => wanted.add(p));
  if (page >= totalPages - 2) [totalPages - 3, totalPages - 2, totalPages - 1].forEach((p) => wanted.add(p));
  const pages = [...wanted].filter((p) => p >= 1 && p <= totalPages).sort((a, b) => a - b);
  const out: (number | "gap")[] = [];
  pages.forEach((p, i) => {
    if (i > 0 && p - pages[i - 1]! > 1) out.push("gap");
    out.push(p);
  });
  return out;
}

type ListPaginationProps = {
  page: number;
  total: number;
  pageSize: number;
  /** Quantos itens vieram nesta página (o servidor já paginou). */
  itemCount: number;
  noun: { one: string; many: string };
  hrefFor: (page: number) => string;
};

const navItem =
  "inline-flex h-8 min-w-8 items-center justify-center gap-1 rounded-md border px-2.5 text-small font-semibold tabular-nums transition-colors";
const navLink = `${navItem} border-border bg-surface text-text-secondary hover:border-border-strong hover:bg-surface-hover hover:text-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary`;

/**
 * Paginação das listagens (server-side: cada página é um link com o mesmo
 * conjunto de parâmetros da URL). Página fora do alcance não vira link morto.
 */
export function ListPagination({ page, total, pageSize, itemCount, noun, hrefFor }: ListPaginationProps) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const first = total === 0 || itemCount === 0 ? 0 : (page - 1) * pageSize + 1;
  const last = first === 0 ? 0 : first + itemCount - 1;
  const href = (p: number) => hrefFor(p) as Route;

  return (
    <div className="flex flex-col items-center gap-3 md:flex-row md:justify-between">
      <p className="m-0 text-small text-text-muted tabular-nums">
        {first === 0 ? (
          <>Página {page} de {totalPages}</>
        ) : (
          <>
            Mostrando <span className="font-semibold text-text-secondary">{first.toLocaleString("pt-BR")}</span>–
            <span className="font-semibold text-text-secondary">{last.toLocaleString("pt-BR")}</span> de{" "}
            <span className="font-semibold text-text-secondary">{total.toLocaleString("pt-BR")}</span>{" "}
            {total === 1 ? noun.one : noun.many}
          </>
        )}
      </p>

      {totalPages > 1 ? (
        <nav aria-label="Paginação" className="flex items-center gap-1.5">
          {page <= 1 ? (
            <span aria-disabled="true" className={cn(navItem, "border-border-subtle text-text-disabled")}>
              <ChevronLeft size={14} aria-hidden />
              Anterior
            </span>
          ) : (
            <Link href={href(page - 1)} className={navLink}>
              <ChevronLeft size={14} aria-hidden />
              Anterior
            </Link>
          )}

          <ol className="m-0 hidden list-none items-center gap-1.5 p-0 md:flex">
            {pageWindow(page, totalPages).map((p, i) =>
              p === "gap" ? (
                <li key={`gap-${i}`} aria-hidden className="px-0.5 text-small text-text-muted">
                  …
                </li>
              ) : (
                <li key={p}>
                  {p === page ? (
                    <span
                      aria-current="page"
                      className={cn(navItem, "border-primary-border bg-primary-tint text-primary")}
                    >
                      <span className="sr-only">Página {p}</span>
                      <span aria-hidden>{p}</span>
                    </span>
                  ) : (
                    <Link href={href(p)} className={navLink}>
                      <span className="sr-only">Página {p}</span>
                      <span aria-hidden>{p}</span>
                    </Link>
                  )}
                </li>
              ),
            )}
          </ol>
          <span className="px-1 text-small text-text-muted tabular-nums md:hidden">
            {page} de {totalPages}
          </span>

          {page >= totalPages ? (
            <span aria-disabled="true" className={cn(navItem, "border-border-subtle text-text-disabled")}>
              Próxima
              <ChevronRight size={14} aria-hidden />
            </span>
          ) : (
            <Link href={href(page + 1)} className={navLink}>
              Próxima
              <ChevronRight size={14} aria-hidden />
            </Link>
          )}
        </nav>
      ) : null}
    </div>
  );
}
