import { formatDateTime } from "@/lib/timezone";
import type { AutomationExecution } from "@/modules/automations/queries";
import {
  AUTOMATION_EXECUTION_STATE_LABEL,
  AUTOMATION_MAX_ATTEMPTS,
  AUTOMATION_TRIGGER_LABEL,
  automationErrorLabel,
} from "@/modules/automations/schema";

function resultText(item: AutomationExecution): string {
  if (item.state === "pending") {
    if (item.attemptCount === 0) return AUTOMATION_EXECUTION_STATE_LABEL.pending;
    return item.nextAttemptAt
      ? `Nova tentativa agendada para ${formatDateTime(item.nextAttemptAt)}`
      : "Nova tentativa agendada";
  }
  return AUTOMATION_EXECUTION_STATE_LABEL[item.state];
}

/**
 * Histórico de execuções: resultado, horário, tentativa e o motivo em texto
 * claro. Só vem do que a RPC devolve (ids, estado e CÓDIGOS fechados): nunca há
 * dado de lead, contato, conversa ou mensagem de erro do banco.
 */
export function AutomationExecutionHistory({ items }: { items: AutomationExecution[] }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-border bg-surface">
      <table className="w-full text-left text-body">
        <thead>
          <tr className="border-b border-border text-meta text-text-tertiary">
            <th className="px-4 py-2.5 font-medium">Quando</th>
            <th className="px-4 py-2.5 font-medium">Regra</th>
            <th className="px-4 py-2.5 font-medium">Resultado</th>
            <th className="px-4 py-2.5 font-medium">Tentativa</th>
            <th className="px-4 py-2.5 font-medium">Motivo</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => {
            const when = item.finishedAt ?? item.lastAttemptAt ?? item.createdAt;
            const reason = automationErrorLabel(item.errorCode);
            return (
              <tr key={item.id} className="border-b border-border align-top last:border-0">
                <td className="whitespace-nowrap px-4 py-2.5 text-text-secondary">
                  <time dateTime={when}>{formatDateTime(when)}</time>
                </td>
                <td className="px-4 py-2.5 text-text">
                  <span className="font-medium">{item.ruleName}</span>
                  <span className="block text-meta text-text-tertiary">{AUTOMATION_TRIGGER_LABEL[item.trigger]}</span>
                </td>
                <td
                  className={`px-4 py-2.5 font-medium ${
                    item.state === "succeeded"
                      ? "text-success"
                      : item.state === "dead_letter"
                        ? "text-danger"
                        : item.state === "cancelled"
                          ? "text-text-tertiary"
                          : "text-warning"
                  }`}
                >
                  {resultText(item)}
                </td>
                <td className="whitespace-nowrap px-4 py-2.5 text-text-secondary">
                  {item.attemptCount === 0 ? "—" : `${item.attemptCount} de ${AUTOMATION_MAX_ATTEMPTS}`}
                </td>
                <td className="px-4 py-2.5 text-meta text-text-tertiary">{reason ?? "—"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
