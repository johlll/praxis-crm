import type { ClientHistoryItem } from "@/modules/clients/queries";

/**
 * Handoff honesto (item 6 do pedido): sem integração jurídica configurada
 * (target_system nulo), mostra "Aguardando integração" — nunca oferece
 * reprocessamento fictício, nunca marca como concluído manualmente, nunca
 * afirma que um processo externo foi criado. `last_error`/`payload` do
 * banco NUNCA chegam aqui (get_client() já os omite por completo) — não
 * há como este componente vazá-los mesmo por engano.
 */
const HANDOFF_STATUS_LABEL: Record<ClientHistoryItem["handoffStatus"], string> = {
  pendente: "Aguardando integração",
  concluido: "Concluído",
  falhou: "Falha no processamento — nova tentativa será feita",
};

const HANDOFF_STATUS_DOT: Record<ClientHistoryItem["handoffStatus"], string> = {
  pendente: "bg-warning",
  concluido: "bg-success",
  falhou: "bg-danger",
};

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });
}

export function HandoffCard({ item }: { item: ClientHistoryItem }) {
  const label = item.handoffAwaitingIntegration ? "Aguardando integração" : HANDOFF_STATUS_LABEL[item.handoffStatus];

  return (
    <div className="flex flex-col gap-1 rounded-card border border-border-input bg-surface-subtle p-3">
      <div className="flex items-center gap-1.5 text-meta text-text-secondary">
        <span className={`size-1.5 rounded-full ${HANDOFF_STATUS_DOT[item.handoffStatus]}`} aria-hidden />
        {label}
      </div>
      {item.handoffStatus === "concluido" && item.handoffCompletedAt ? (
        <p className="text-meta text-text-tertiary">Concluído em {formatDateTime(item.handoffCompletedAt)}</p>
      ) : null}
      {item.handoffAttempts > 0 ? (
        <p className="text-meta text-text-tertiary">
          {item.handoffAttempts} tentativa{item.handoffAttempts === 1 ? "" : "s"} de processamento
        </p>
      ) : null}
    </div>
  );
}
