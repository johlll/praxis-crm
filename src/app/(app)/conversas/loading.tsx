import { Skeleton } from "@/components/feedback/loading-state";

/**
 * Esqueleto da tela de Conversas enquanto a lista e a conversa carregam: mesmas
 * colunas da tela final, sem texto inventado.
 */
export default function ConversasLoading() {
  return (
    <main
      role="status"
      aria-live="polite"
      aria-busy="true"
      className="flex min-h-0 flex-1 gap-3 px-3 pb-3 pt-[76px] md:px-5 md:pb-5"
    >
      <span className="sr-only">Carregando conversas…</span>
      <div className="flex min-h-0 w-full flex-col gap-3 rounded-card border border-border bg-surface p-3 min-[768px]:w-[300px] min-[768px]:shrink-0 min-[1400px]:w-[320px]">
        <Skeleton className="h-9 w-full" />
        <div className="flex gap-1.5">
          <Skeleton className="h-7 w-16" />
          <Skeleton className="h-7 w-24" />
          <Skeleton className="h-7 w-20" />
        </div>
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="flex gap-3 py-2">
            <Skeleton className="size-9 shrink-0 rounded-full" />
            <div className="flex flex-1 flex-col gap-1.5">
              <Skeleton className="h-3.5 w-2/3" />
              <Skeleton className="h-3 w-full" />
            </div>
          </div>
        ))}
      </div>
      <div className="hidden min-w-0 flex-1 flex-col gap-3 rounded-card border border-border bg-surface p-4 min-[768px]:flex">
        <Skeleton className="h-10 w-1/2" />
        <Skeleton className="h-16 w-2/3" />
        <Skeleton className="ml-auto h-16 w-1/2" />
        <Skeleton className="h-12 w-3/5" />
      </div>
    </main>
  );
}
