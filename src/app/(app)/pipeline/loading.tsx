import { Topbar } from "@/components/app-shell/topbar";

/** Esqueleto do kanban enquanto o quadro carrega (mesmas medidas do quadro real). */
export default function PipelineLoading() {
  return (
    <>
      <Topbar title="Pipeline" subtitle="Carregando oportunidades…" />
      <main className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden px-5 pt-1 pb-3" aria-busy="true">
        <div className="h-8 w-[172px] animate-pulse rounded-[10px] bg-surface-subtle" />
        <div className="-mx-5 flex min-h-0 flex-1 gap-2.5 overflow-hidden px-5 pb-2" role="status">
          <span className="sr-only">Carregando o quadro do pipeline…</span>
          {Array.from({ length: 6 }, (_, i) => (
            <div
              key={i}
              className="flex w-[82vw] max-w-[300px] shrink-0 flex-col gap-2 rounded-xl border border-border bg-surface-subtle p-2 md:w-kanban-column md:max-w-none"
            >
              <div className="h-11 animate-pulse rounded-lg bg-surface" />
              {Array.from({ length: 3 - (i % 3) }, (_, j) => (
                <div key={j} className="h-[118px] animate-pulse rounded-[10px] border border-border bg-surface" />
              ))}
            </div>
          ))}
        </div>
      </main>
    </>
  );
}
