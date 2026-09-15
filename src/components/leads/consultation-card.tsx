import type { ActivityListItem } from "@/modules/activities/queries";
import { formatDateTime } from "@/lib/timezone";

/**
 * Bloco "Consulta" do protótipo — sem tabela nova (docs/decisoes/
 * a9-perfil-360.md §9): status é sempre "Realizada" porque só existe
 * quando há uma atividade `meeting` concluída; duração e modalidade não
 * aparecem porque não existem em `activities` hoje (decisão explícita de
 * não inventar campo). Só renderiza quando essa atividade existe — sem
 * consulta ainda, a ausência do bloco já é a informação.
 */
export function ConsultationCard({ activity }: { activity: ActivityListItem }) {
  return (
    <section className="rounded-lg border border-border bg-surface p-4">
      <div className="flex items-center gap-2">
        <h2 className="text-body font-semibold text-text">Consulta</h2>
        <span className="ml-auto text-meta font-semibold text-text-secondary">Realizada</span>
      </div>
      <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-meta">
        <dt className="text-text-tertiary">Data</dt>
        <dd className="text-text">{formatDateTime(activity.completedAt ?? activity.dueAt)}</dd>
        <dt className="text-text-tertiary">Advogado</dt>
        <dd className="text-text">{activity.assignedToName ?? "Sem responsável"}</dd>
      </dl>
      {activity.notes ? <p className="mt-2 text-meta text-text-secondary">{activity.notes}</p> : null}
    </section>
  );
}
