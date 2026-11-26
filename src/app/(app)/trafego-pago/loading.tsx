const block = "rounded-lg border border-border bg-surface motion-safe:animate-pulse";

/**
 * Carregando: nenhum número (nem zero) enquanto a página não chega. O cabeçalho é estático de propósito: com o
 * Topbar (que traz a busca global, interativa) dentro desta reserva, o carregamento direto da página gera um
 * <script> sem nonce, bloqueado pela CSP. Sem JavaScript, a troca da reserva pelo conteúdo não acontece, então a
 * tela diz isso em vez de "carregar" para sempre.
 */
export default function TrafficLoading() {
  return (
    <>
      <header className="flex shrink-0 flex-col justify-center gap-0.5 px-5 pt-4 pb-2 md:min-h-[68px] md:pt-5">
        <h1 className="m-0 text-[19px] leading-tight font-bold tracking-[-0.3px] text-text md:text-[22px]">Tráfego Pago</h1>
        <p className="m-0 text-small text-text-muted">Desempenho dos anúncios e geração de oportunidades para o escritório</p>
      </header>
      <main className="flex-1 overflow-y-auto p-5">
        <div className="@container mx-auto flex max-w-[1400px] flex-col gap-4">
          <p role="status" className="m-0 text-small text-text-secondary">
            Carregando o Tráfego Pago…
          </p>
          <noscript>
            <p className="m-0 rounded-md border border-warning/30 bg-warning-bg px-3 py-2 text-small text-warning">
              Esta página precisa de JavaScript. Ative-o no navegador e recarregue.
            </p>
          </noscript>
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
