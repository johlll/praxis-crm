"use client";

import type { Route } from "next";
import Link from "next/link";
import { useId, useState, useTransition } from "react";
import { ArrowUpRight, CircleAlert, LoaderCircle, Pencil, UserPlus, UserRoundCheck } from "lucide-react";

import { cn } from "@/lib/cn";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { confirmRegistrationAction } from "@/modules/assistant/actions";
import { FIELD_LABEL } from "@/modules/assistant/operations";
import type { AssistantBlock, RegistrationDraft } from "@/modules/assistant/types";

const card = "rounded-card border border-border bg-surface p-4";
/** Celular: botões em coluna e largura total, principal em cima. Computador: em linha, à direita. */
const actionsClass = "flex flex-col-reverse gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:justify-end [&>button]:w-full sm:[&>button]:w-auto";
const CANCELLED: AssistantBlock = { type: "text", text: "Cadastro cancelado. Nada foi gravado." };

type DuplicateBlock = Extract<AssistantBlock, { type: "duplicate" }>;
type ConfirmBlock = Extract<AssistantBlock, { type: "confirm" }>;

/** Possível duplicidade: a pessoa decide entre o contato encontrado e um contato novo. */
export function DuplicateCard({
  block,
  onReplace,
  onClosed,
}: {
  block: DuplicateBlock;
  onReplace: (blocks: AssistantBlock[]) => void;
  onClosed: () => void;
}) {
  const titleId = useId();
  return (
    <section aria-labelledby={titleId} className={cn(card, "flex flex-col gap-3 border-warning/40")}>
      <h3 id={titleId} className="m-0 text-body font-bold text-text">
        Possível duplicidade para “{block.draft.name}”
      </h3>
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {block.matches.map((match) => (
          <li key={match.contactId} className="flex flex-col gap-2 rounded-md border border-border-subtle p-3 sm:flex-row sm:items-center">
            <div className="flex min-w-0 flex-1 flex-col">
              <Link href={match.href as Route} target="_blank" className="inline-flex items-center gap-1 text-small font-semibold break-words">
                {match.name}
                <ArrowUpRight size={12} aria-hidden />
                <span className="sr-only">(abre em outra aba)</span>
              </Link>
              <span className="text-meta text-text-tertiary">{match.reasons.join(" · ")}</span>
            </div>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() =>
                onReplace([
                  {
                    type: "confirm",
                    requestId: block.requestId,
                    ticket: block.ticket,
                    draft: { ...block.draft, name: match.name },
                    decision: { kind: "existing", contactId: match.contactId, contactName: match.name },
                  },
                ])
              }
            >
              <UserRoundCheck size={14} aria-hidden />
              Usar este contato
            </Button>
          </li>
        ))}
      </ul>
      <div className={actionsClass}>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => {
            onReplace([CANCELLED]);
            onClosed();
          }}
        >
          Cancelar
        </Button>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={() =>
            onReplace([{ type: "confirm", requestId: block.requestId, ticket: block.ticket, draft: block.draft, decision: { kind: "new" } }])
          }
        >
          <UserPlus size={14} aria-hidden />
          Cadastrar como pessoa nova
        </Button>
      </div>
    </section>
  );
}

const EDITABLE: (keyof RegistrationDraft)[] = ["name", "legalArea", "summary", "phone", "email"];

/**
 * O que será criado, para conferir, corrigir, cancelar ou confirmar. A gravação acontece no servidor; o
 * botão fica bloqueado enquanto ela corre, e a chave da solicitação impede um segundo cadastro mesmo assim.
 */
export function ConfirmCard({
  block,
  onReplace,
  onClosed,
}: {
  block: ConfirmBlock;
  onReplace: (blocks: AssistantBlock[]) => void;
  onClosed: () => void;
}) {
  const [draft, setDraft] = useState<RegistrationDraft>(block.draft);
  const [decision, setDecision] = useState(block.decision);
  const [editing, setEditing] = useState(false);
  const [message, setMessage] = useState<{ text: string; uncertain: boolean } | null>(null);
  const [saving, startSaving] = useTransition();
  const titleId = useId();
  const existing = decision?.kind === "existing" ? decision : null;

  function change(field: keyof RegistrationDraft, value: string) {
    setDraft((current) => ({ ...current, [field]: value }));
    // Mudou quem é a pessoa: a duplicidade é conferida de novo ao confirmar.
    if (!existing && (field === "name" || field === "phone" || field === "email")) setDecision(null);
  }

  function confirm() {
    if (saving) return;
    setMessage(null);
    startSaving(async () => {
      try {
        const result = await confirmRegistrationAction({ requestId: block.requestId, ticket: block.ticket, draft, decision });
        if (result.outcome === "saved" || result.outcome === "duplicate" || result.outcome === "denied" || result.outcome === "stale") {
          if (result.outcome !== "duplicate") onClosed();
          onReplace(result.blocks);
          return;
        }
        setMessage({ text: result.message ?? "Não foi possível gravar. Nada foi gravado.", uncertain: result.outcome === "uncertain" });
        if (result.outcome === "invalid") setEditing(true);
      } catch {
        // Sem resposta do servidor não dá para saber se gravou: repetir é seguro (mesma chave e mesmo resultado).
        setMessage({
          text: "Não sei se o cadastro foi gravado: a resposta do servidor não chegou. Confirme de novo para conferir. Se ele já tiver sido gravado, eu mostro o mesmo cadastro, sem criar outro.",
          uncertain: true,
        });
      }
    });
  }

  const rows: { field: keyof RegistrationDraft; value: string | undefined }[] = EDITABLE.filter(
    (field) => !(existing && (field === "phone" || field === "email")),
  ).map((field) => ({ field, value: draft[field] }));

  return (
    <section aria-labelledby={titleId} className={cn(card, "flex flex-col gap-3 border-primary-border")} aria-busy={saving}>
      <div className="flex flex-col gap-0.5">
        <h3 id={titleId} className="m-0 text-body font-bold text-text">
          {existing ? `Novo caso para ${existing.contactName}` : "Cadastrar pessoa e caso"}
        </h3>
        <p className="m-0 text-meta text-text-tertiary">
          {existing
            ? "Será criado um lead no contato existente. O contato não muda."
            : "Será criado um contato (pessoa física) e um lead para o caso, como no cadastro do CRM."}
        </p>
      </div>

      {editing ? (
        <div className="grid gap-3 sm:grid-cols-2">
          {rows.map(({ field, value }) => {
            const id = `${titleId}-${field}`;
            const locked = existing && field === "name";
            return (
              <label key={field} htmlFor={id} className={cn("flex flex-col gap-1", field === "summary" && "sm:col-span-2")}>
                <span className="text-meta font-semibold text-text-secondary">
                  {FIELD_LABEL[field]}
                  {field === "name" || field === "legalArea" ? "" : " (opcional)"}
                </span>
                <Input
                  id={id}
                  value={value ?? ""}
                  disabled={Boolean(locked) || saving}
                  onChange={(event) => change(field, event.target.value)}
                  type={field === "email" ? "email" : "text"}
                  inputMode={field === "phone" ? "tel" : undefined}
                />
              </label>
            );
          })}
        </div>
      ) : (
        <dl className="m-0 grid gap-x-4 gap-y-2 sm:grid-cols-[150px_1fr]">
          {rows.map(({ field, value }) => (
            <div key={field} className="contents">
              <dt className="text-meta font-semibold text-text-tertiary">{FIELD_LABEL[field]}</dt>
              <dd className={cn("m-0 text-small break-words", value ? "text-text" : "text-text-muted")}>{value || "não informado"}</dd>
            </div>
          ))}
        </dl>
      )}

      {message ? (
        <p
          role="alert"
          className={cn(
            "m-0 flex items-start gap-2 rounded-md border px-3 py-2 text-small",
            message.uncertain ? "border-warning/40 bg-warning-bg text-warning" : "border-danger/25 bg-danger-bg text-danger",
          )}
        >
          <CircleAlert size={14} aria-hidden className="mt-0.5 shrink-0" />
          {message.text}
        </p>
      ) : null}

      <div className={actionsClass}>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={saving}
          onClick={() => {
            onReplace([CANCELLED]);
            onClosed();
          }}
        >
          Cancelar
        </Button>
        <Button type="button" variant="secondary" size="sm" disabled={saving} onClick={() => setEditing((v) => !v)} aria-pressed={editing}>
          <Pencil size={13} aria-hidden />
          {editing ? "Concluir correção" : "Corrigir"}
        </Button>
        <Button type="button" size="sm" disabled={saving} onClick={confirm}>
          {saving ? <LoaderCircle size={14} className="animate-spin" aria-hidden /> : null}
          {saving ? "Gravando…" : message?.uncertain ? "Confirmar de novo" : "Confirmar cadastro"}
        </Button>
      </div>
    </section>
  );
}
