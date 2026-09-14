"use client";

import { useActionState } from "react";

import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import type { ConflictCheck } from "@/modules/conflict-checks/queries";
import { upsertConflictCheckAction, type ConflictCheckActionState } from "@/modules/conflict-checks/actions";
import { CONFLICT_CHECK_STATUSES } from "@/modules/conflict-checks/schema";
import { formatDateTime } from "@/lib/timezone";

const STATUS_LABEL: Record<(typeof CONFLICT_CHECK_STATUSES)[number], string> = {
  nao_verificado: "Não verificado",
  sem_conflito: "Sem conflito",
  conflito_identificado: "Conflito identificado",
  em_analise: "Em análise",
};

const INITIAL: ConflictCheckActionState = { ok: false };

export function ConflictCheckPanel({
  leadId,
  conflictCheck,
  canEdit,
}: {
  leadId: string;
  conflictCheck: ConflictCheck;
  canEdit: boolean;
}) {
  const [state, formAction, pending] = useActionState(upsertConflictCheckAction, INITIAL);

  return (
    <div className="rounded-lg border border-border bg-surface p-4">
      <div className="flex items-center gap-2">
        <h2 className="text-body font-semibold text-text">Verificação de conflito</h2>
        <span className="ml-auto text-meta font-semibold text-text-secondary">
          {STATUS_LABEL[conflictCheck.status]}
        </span>
      </div>
      {conflictCheck.checkedAt ? (
        <p className="mt-1 text-meta text-text-tertiary">Verificado em {formatDateTime(conflictCheck.checkedAt)}</p>
      ) : null}
      {conflictCheck.note ? <p className="mt-1 text-meta text-text-secondary">{conflictCheck.note}</p> : null}

      {canEdit ? (
        <form action={formAction} className="mt-3 flex flex-col gap-2">
          <input type="hidden" name="leadId" value={leadId} />
          {conflictCheck.lockVersion !== null ? (
            <input type="hidden" name="lockVersion" value={conflictCheck.lockVersion} />
          ) : null}
          <select
            name="status"
            defaultValue={conflictCheck.status}
            className="h-9 rounded-input border border-border-input bg-surface px-3 text-body text-text"
          >
            {CONFLICT_CHECK_STATUSES.map((s) => (
              <option key={s} value={s}>
                {STATUS_LABEL[s]}
              </option>
            ))}
          </select>
          <textarea
            name="note"
            placeholder="Nota (opcional)"
            rows={2}
            maxLength={2000}
            defaultValue={conflictCheck.note ?? ""}
            className="rounded-input border border-border-input bg-surface px-3 py-2 text-body text-text"
          />
          {state.error ? (
            <Alert variant="danger">
              <AlertDescription>{state.error}</AlertDescription>
            </Alert>
          ) : null}
          <Button type="submit" variant="secondary" size="sm" disabled={pending}>
            {pending ? "Salvando…" : "Registrar verificação"}
          </Button>
        </form>
      ) : null}
    </div>
  );
}
