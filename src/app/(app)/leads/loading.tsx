import { Skeleton } from "@/components/feedback/loading-state";

/**
 * Esqueleto no formato da listagem (cabeçalho, filtros e linhas), para a
 * troca de tela não "pular" quando os dados chegam.
 */
export default function LeadsLoading() {
  return (
    <>
      <div className="flex shrink-0 flex-col gap-2 px-5 pt-4 pb-2 md:min-h-[68px] md:pt-5" aria-hidden>
        <Skeleton className="h-6 w-28" />
        <Skeleton className="h-3.5 w-40" />
      </div>
      <main className="flex-1 overflow-y-auto p-5">
        <div
          role="status"
          aria-live="polite"
          aria-busy="true"
          className="mx-auto flex max-w-[1400px] flex-col gap-4"
        >
          <span className="sr-only">Carregando leads…</span>
          <div className="flex flex-wrap items-center gap-2" aria-hidden>
            <Skeleton className="h-9 min-w-[240px] flex-1" />
            <Skeleton className="h-9 w-36" />
            <Skeleton className="h-9 w-36" />
            <Skeleton className="h-9 w-44" />
            <Skeleton className="h-9 w-20" />
            <Skeleton className="h-9 w-28 md:ml-4" />
          </div>
          <div className="overflow-hidden rounded-lg border border-border bg-surface" aria-hidden>
            <div className="h-10 border-b border-border bg-surface-subtle" />
            {Array.from({ length: 8 }, (_, index) => (
              <div key={index} className="flex items-center gap-3 border-b border-border-subtle px-4 py-3 last:border-0">
                <Skeleton className="size-8 shrink-0 rounded-full" />
                <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                  <Skeleton className="h-3.5 w-48 max-w-full" />
                  <Skeleton className="h-3 w-72 max-w-full" />
                </div>
                <Skeleton className="hidden h-3.5 w-32 md:block" />
                <Skeleton className="hidden h-[22px] w-16 rounded-pill md:block" />
                <Skeleton className="hidden h-[22px] w-16 rounded-pill md:block" />
                <Skeleton className="hidden h-3.5 w-36 md:block" />
              </div>
            ))}
          </div>
        </div>
      </main>
    </>
  );
}
