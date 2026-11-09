import { formatDateTime } from "@/lib/timezone";
import { auditActionLabel, auditDetailLines } from "@/modules/audit/catalog";
import type { AuditEntry } from "@/modules/audit/queries";

/**
 * Trilha somente leitura. Só mostra o que a RPC sanitizada devolve: quando,
 * quem, qual ação e detalhes de vocabulário fechado. Nunca o `metadata` cru
 * (a coluna nem chega até aqui).
 */
export function AuditLogList({ items }: { items: AuditEntry[] }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-border bg-surface">
      <table className="w-full text-left text-body">
        <thead>
          <tr className="border-b border-border text-meta text-text-tertiary">
            <th className="px-4 py-2.5 font-medium">Quando</th>
            <th className="px-4 py-2.5 font-medium">Quem</th>
            <th className="px-4 py-2.5 font-medium">O que aconteceu</th>
            <th className="px-4 py-2.5 font-medium">Detalhes</th>
          </tr>
        </thead>
        <tbody>
          {items.map((entry) => {
            const lines = auditDetailLines(entry.action, entry.details, entry.targetName);
            return (
              <tr key={entry.id} className="border-b border-border align-top last:border-0">
                <td className="px-4 py-2.5 whitespace-nowrap text-text-secondary">
                  <time dateTime={entry.createdAt}>{formatDateTime(entry.createdAt)}</time>
                </td>
                <td className="px-4 py-2.5 text-text-secondary">
                  {entry.actorUserId === null ? (
                    <span className="text-text-tertiary">Sistema</span>
                  ) : (
                    (entry.actorName ?? "Pessoa da equipe")
                  )}
                </td>
                <td className="px-4 py-2.5 font-medium text-text">{auditActionLabel(entry.action)}</td>
                <td className="px-4 py-2.5 text-meta text-text-tertiary">
                  {lines.length === 0 ? (
                    "—"
                  ) : (
                    <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
                      {lines.map((line) => (
                        <li key={line.label}>
                          {line.label}: <span className="text-text-secondary">{line.value}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
