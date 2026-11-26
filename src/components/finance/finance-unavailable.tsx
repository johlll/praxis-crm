import { Wallet } from "lucide-react";

/** Escritório real: o módulo ainda não tem lançamentos. Nenhum número, nenhum botão de lançar. */
export function FinanceUnavailable() {
  return (
    <section aria-labelledby="financeiro-vazio" className="flex flex-col items-center gap-4 rounded-lg border border-border bg-surface px-5 py-10 text-center">
      <span aria-hidden className="flex size-12 items-center justify-center rounded-[12px] border border-accent-border bg-accent-tint text-accent">
        <Wallet size={22} strokeWidth={1.6} />
      </span>
      <div className="flex max-w-[520px] flex-col gap-1.5">
        <h2 id="financeiro-vazio" className="m-0 text-display font-bold text-text">
          Ainda não há lançamentos neste módulo
        </h2>
        <p className="m-0 text-body text-text-secondary">
          O registro financeiro do escritório ainda não está disponível. Por isso não há valores para mostrar, nem zero.
        </p>
        <p className="m-0 text-meta text-text-muted">
          Propostas aceitas e oportunidades ganhas não contam como dinheiro recebido e não aparecem aqui.
        </p>
      </div>
    </section>
  );
}
