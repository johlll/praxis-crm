import type { ReactNode } from "react";
import { Table2 } from "lucide-react";

export type ChartTableColumn = { key: string; label: string; numeric?: boolean };

/**
 * Tabela equivalente ao gráfico, dentro de um <details> nativo: abre e
 * fecha sem JavaScript, é lida por leitor de tela e traz TODOS os valores
 * do gráfico — o tooltip nunca é o único caminho até um número.
 */
export function ChartDataTable({
  caption,
  columns,
  rows,
  summary = "Ver dados em tabela",
}: {
  caption: string;
  columns: ChartTableColumn[];
  rows: { key: string; cells: ReactNode[] }[];
  summary?: string;
}) {
  return (
    <details className="group">
      <summary className="inline-flex cursor-pointer list-none items-center gap-1.5 rounded-md text-meta text-text-secondary select-none hover:text-text [&::-webkit-details-marker]:hidden">
        <Table2 size={12} strokeWidth={1.75} aria-hidden />
        <span className="group-open:hidden">{summary}</span>
        <span className="hidden group-open:inline">Ocultar tabela</span>
      </summary>
      <div className="mt-2 overflow-x-auto">
        <table className="w-full border-collapse text-small">
          <caption className="sr-only">{caption}</caption>
          <thead>
            <tr className="text-left text-label font-semibold tracking-[1px] text-text-tertiary uppercase">
              {columns.map((column, index) => (
                <th
                  key={column.key}
                  scope="col"
                  className={`py-1.5 font-semibold ${column.numeric ? "text-right" : "text-left"} ${index === 0 ? "pr-3" : "pl-3"}`}
                >
                  {column.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key} className="border-t border-border-subtle">
                {row.cells.map((cell, index) => {
                  const column = columns[index]!;
                  return index === 0 ? (
                    <th key={column.key} scope="row" className="py-1.5 pr-3 text-left font-normal text-text-secondary">
                      {cell}
                    </th>
                  ) : (
                    <td key={column.key} className={`py-1.5 pl-3 tabular text-text ${column.numeric ? "text-right" : "text-left"}`}>
                      {cell}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}
