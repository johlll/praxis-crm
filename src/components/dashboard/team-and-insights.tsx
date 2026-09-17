import { initialsOf } from "@/lib/initials";
import type { TeamRow } from "@/modules/dashboard/queries";
import type { Insight } from "@/modules/dashboard/presentation";

export function TeamTable({ rows, days }: { rows: TeamRow[]; days: number }) {
  return (
    <section aria-labelledby="equipe-titulo" className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4">
      <div className="flex flex-col">
        <h2 id="equipe-titulo" className="m-0 text-body font-bold text-text">
          Desempenho da equipe
        </h2>
        <p className="m-0 text-meta text-text-muted">
          Leads recebidos e oportunidades ganhas: responsável atual do lead. Consultas e atrasadas: responsável atual da
          atividade. Atribuir um lead não significa que ele foi atendido.
        </p>
      </div>
      {rows.length === 0 ? (
        <p className="m-0 text-body text-text-secondary">Nenhum membro com dados no período.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-body">
            <thead>
              <tr className="text-left text-label font-semibold tracking-[1px] text-text-tertiary uppercase">
                <th scope="col" className="py-2 pr-3 font-semibold">Responsável</th>
                <th scope="col" className="px-3 py-2 text-right font-semibold">Leads recebidos</th>
                <th scope="col" className="px-3 py-2 text-right font-semibold">Consultas realizadas</th>
                <th scope="col" className="px-3 py-2 text-right font-semibold">Oportunidades ganhas</th>
                <th scope="col" className="py-2 pl-3 text-right font-semibold">Atrasadas agora</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const name = row.userId ? (row.fullName ?? "Membro sem nome") : "Sem responsável";
                return (
                  <tr key={row.userId ?? "sem-responsavel"} className="border-t border-border-subtle">
                    <th scope="row" className="py-2 pr-3 text-left font-semibold">
                      <span className="flex items-center gap-2">
                        <span
                          aria-hidden
                          className={
                            row.userId
                              ? "flex size-6 shrink-0 items-center justify-center rounded-full bg-primary-tint text-[10px] font-bold text-primary"
                              : "flex size-6 shrink-0 items-center justify-center rounded-full border border-dashed border-border-unassigned text-[10px] text-text-tertiary"
                          }
                        >
                          {row.userId ? initialsOf(name) : "—"}
                        </span>
                        {name}
                      </span>
                    </th>
                    <td className="px-3 py-2 text-right tabular">{row.leadsReceived}</td>
                    <td className="px-3 py-2 text-right tabular">{row.consultationsDone}</td>
                    <td className="px-3 py-2 text-right tabular">{row.opportunitiesWon}</td>
                    <td className={`py-2 pl-3 text-right tabular ${row.overdueActivities > 0 ? "font-semibold text-danger" : ""}`}>
                      {row.overdueActivities}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="mt-2 mb-0 text-meta text-text-muted">Colunas do período: últimos {days} dias.</p>
        </div>
      )}
    </section>
  );
}

export function InsightsSection({ insights }: { insights: Insight[] }) {
  if (insights.length === 0) return null;
  return (
    <section aria-labelledby="insights-titulo" className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4">
      <h2 id="insights-titulo" className="m-0 text-label font-semibold tracking-[1.3px] text-text-tertiary uppercase">
        Destaques calculados
      </h2>
      <ul className="m-0 grid list-none gap-3 p-0 md:grid-cols-3">
        {insights.map((insight) => (
          <li key={insight.id} className="flex flex-col gap-1 rounded-card border border-border bg-surface-subtle px-3.5 py-3">
            <span className="text-body text-text">{insight.text}</span>
            <span className="text-meta text-text-muted">Base: {insight.basis}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
