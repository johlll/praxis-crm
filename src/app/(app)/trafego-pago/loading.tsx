import { Topbar } from "@/components/app-shell/topbar";

const block = "rounded-lg border border-border bg-surface motion-safe:animate-pulse";

/** Carregando: nenhum número (nem zero) enquanto a página não chega. */
export default function TrafficLoading() {
  return (
    <>
      <Topbar title="Tráfego Pago" subtitle="Desempenho dos anúncios e geração de oportunidades para o escritório" wrapSubtitle />
      <main className="flex-1 overflow-y-auto p-5">
        <div className="@container mx-auto flex max-w-[1400px] flex-col gap-4">
          <p role="status" className="m-0 text-small text-text-secondary">
            Carregando o Tráfego Pago…
          </p>
          <div aria-hidden className="grid grid-cols-2 gap-3 @min-[740px]:grid-cols-4">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className={`${block} h-[124px]`} />
            ))}
          </div>
          <div aria-hidden className="grid grid-cols-1 gap-4 @min-[900px]:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
            <div className={`${block} h-[320px]`} />
            <div className={`${block} h-[320px]`} />
          </div>
          <div aria-hidden className={`${block} h-[280px]`} />
        </div>
      </main>
    </>
  );
}
