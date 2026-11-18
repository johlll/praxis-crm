"use client";

import { useId, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { formatTime } from "@/lib/timezone";
import {
  setConversationAttendanceAction,
  setOpportunityCaseProgressAction,
} from "@/modules/status-tracks/actions";
import type { EvidenceCandidate } from "@/modules/conversations/context-format";
import { useTrackAction } from "./use-track-action";

export type StatusOption = { value: string; label: string };

const MAX_EVIDENCE = 20;

/**
 * Correção HUMANA da situação do atendimento ou do andamento do caso.
 *
 * - Usa a versão lida: se outra pessoa mudou no meio, o servidor recusa e a
 *   tela pede para atualizar (nunca sobrescreve em silêncio nem repete).
 * - "Não informado" é só leitura: nunca aparece como opção.
 * - Evidência é OPCIONAL e pertence só a esta correção; trocar o caso em foco
 *   não leva evidência de um caso para o outro.
 * - Não envia mensagem nem faz nenhuma ação externa.
 */
export function TrackStatusEditor({
  kind,
  targetId,
  current,
  version,
  options,
  evidence,
  fieldLabel,
}: {
  kind: "attendance" | "case_progress";
  targetId: string;
  current: string | null;
  version: number;
  options: StatusOption[];
  evidence: EvidenceCandidate[];
  fieldLabel: string;
}) {
  const selectId = useId();
  const [choice, setChoice] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const idempotency = useRef<string | null>(null);
  const { pending, blocked, error, conflict, done, run, refresh } = useTrackAction();

  function key(): string {
    if (!idempotency.current) idempotency.current = crypto.randomUUID();
    return idempotency.current;
  }

  function togglePicked(id: string) {
    setPicked((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : prev.length >= MAX_EVIDENCE ? prev : [...prev, id]));
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!choice || choice === current) return;
    const input = {
      status: choice,
      expectedVersion: version,
      evidenceMessageIds: picked,
      idempotencyKey: key(),
    };
    run(
      () =>
        kind === "attendance"
          ? setConversationAttendanceAction({ conversationId: targetId, ...input })
          : setOpportunityCaseProgressAction({ opportunityId: targetId, ...input }),
      () => {
        // Pedido concluído: próxima correção usa chave nova e começa limpa.
        idempotency.current = null;
        setChoice("");
        setPicked([]);
      },
    );
  }

  function onRefresh() {
    idempotency.current = null;
    setChoice("");
    setPicked([]);
    refresh();
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-2" aria-busy={pending}>
      <div className="flex items-end gap-2">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <label htmlFor={selectId} className="text-meta font-semibold text-text-secondary">
            {fieldLabel}
          </label>
          <select
            id={selectId}
            value={choice}
            onChange={(e) => setChoice(e.target.value)}
            disabled={pending || blocked}
            className="h-9 min-w-0 rounded-input border border-border-input bg-surface-subtle px-2 text-body text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-ring disabled:opacity-60"
          >
            <option value="">Escolher…</option>
            {options.map((o) => (
              <option key={o.value} value={o.value} disabled={o.value === current}>
                {o.label}
                {o.value === current ? " (atual)" : ""}
              </option>
            ))}
          </select>
        </div>
        <Button type="submit" size="md" disabled={pending || blocked || !choice || choice === current}>
          {pending ? "Salvando…" : "Salvar"}
        </Button>
      </div>

      {evidence.length > 0 ? (
        <details className="rounded-input border border-border bg-surface-subtle px-3 py-2">
          <summary className="cursor-pointer text-meta font-semibold text-text-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-ring">
            Anexar mensagens como evidência (opcional){picked.length ? ` — ${picked.length}` : ""}
          </summary>
          <p className="m-0 mt-2 text-meta text-text-tertiary">
            A evidência fica registrada só nesta alteração. Escolher outro caso não leva evidência junto.
          </p>
          <ul className="m-0 mt-2 flex max-h-40 list-none flex-col gap-1 overflow-y-auto p-0">
            {evidence.map((m) => {
              const id = `${selectId}-ev-${m.id}`;
              return (
                <li key={m.id} className="flex items-start gap-2">
                  <input
                    id={id}
                    type="checkbox"
                    checked={picked.includes(m.id)}
                    onChange={() => togglePicked(m.id)}
                    disabled={pending || blocked || (!picked.includes(m.id) && picked.length >= MAX_EVIDENCE)}
                    className="mt-0.5 size-4 shrink-0 accent-[var(--color-primary)]"
                  />
                  <label htmlFor={id} className="min-w-0 text-meta text-text-secondary">
                    <span className="font-semibold text-text">{m.authorLabel}</span> · {formatTime(m.createdAt)}
                    <span className="block truncate text-text-tertiary">{m.excerpt}</span>
                  </label>
                </li>
              );
            })}
          </ul>
        </details>
      ) : null}

      <div aria-live="polite" className="flex flex-col gap-2">
        {done ? <p className="m-0 text-meta font-semibold text-success">{done}</p> : null}
        {conflict ? (
          <Alert variant="warning">
            <AlertDescription>
              Este registro mudou enquanto você editava. Atualize para ver o estado atual antes de tentar de novo.{" "}
              <button type="button" onClick={onRefresh} className="font-semibold underline">
                Atualizar
              </button>
            </AlertDescription>
          </Alert>
        ) : null}
        {error ? (
          <Alert variant="danger">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
      </div>
    </form>
  );
}
