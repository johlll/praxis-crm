export type ChartTooltipRow = {
  key: string;
  /** Cor da marca do gráfico (vira um traço curto ao lado do valor). */
  color?: string;
  value: string;
  label: string;
};

/**
 * Cartão do tooltip dos gráficos: o VALOR vem primeiro e forte, o nome da
 * série depois; a identidade é um traço curto na cor da marca, nunca o
 * texto colorido. O tooltip só repete o que a tabela do gráfico já mostra.
 */
export function ChartTooltipCard({ title, rows }: { title: string; rows: ChartTooltipRow[] }) {
  return (
    <div className="pointer-events-none min-w-[160px] rounded-md border border-border-strong bg-surface-hover px-3 py-2 shadow-raised">
      <p className="m-0 mb-1 text-meta text-text-muted">{title}</p>
      <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
        {rows.map((row) => (
          <li key={row.key} className="flex items-center gap-2 whitespace-nowrap">
            {row.color ? <span aria-hidden className="h-[3px] w-3 shrink-0 rounded-full" style={{ background: row.color }} /> : null}
            <span className="tabular text-small font-bold text-text">{row.value}</span>
            <span className="text-meta text-text-secondary">{row.label}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
