"use client";

import { useActionState, useState } from "react";

import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { SensitiveField } from "./sensitive-field";
import { mergeContactsAction, type MergeState } from "@/modules/contacts/actions";
import type { DuplicateCandidateDetail } from "@/modules/contacts/queries";

const INITIAL_STATE: MergeState = { ok: false };

const FIELD_LABEL = {
  name: "Nome",
  city: "Cidade",
  uf: "UF",
  preferred_channel: "Canal preferido",
} as const;

type FieldKey = keyof typeof FIELD_LABEL;

function fieldValue(contact: DuplicateCandidateDetail["contactA"], field: FieldKey): string {
  if (field === "name") return contact.name;
  if (field === "city") return contact.city ?? "—";
  if (field === "uf") return contact.uf ?? "—";
  return contact.preferredChannel ?? "—";
}

export function MergeComparisonForm({ candidate }: { candidate: DuplicateCandidateDetail }) {
  const [state, formAction, pending] = useActionState(mergeContactsAction, INITIAL_STATE);
  // "a" = candidate.contactA sobrevive; "b" = candidate.contactB sobrevive.
  const [keepSide, setKeepSide] = useState<"a" | "b">("a");
  const [overrides, setOverrides] = useState<Partial<Record<FieldKey, boolean>>>({});

  const kept = keepSide === "a" ? candidate.contactA : candidate.contactB;
  const other = keepSide === "a" ? candidate.contactB : candidate.contactA;

  const differingFields = (Object.keys(FIELD_LABEL) as FieldKey[]).filter(
    (field) => fieldValue(candidate.contactA, field) !== fieldValue(candidate.contactB, field),
  );

  return (
    <form action={formAction} className="flex flex-col gap-5">
      <input type="hidden" name="candidateId" value={candidate.id} />
      <input type="hidden" name="keptContactId" value={kept.id} />
      <input type="hidden" name="mergedContactId" value={other.id} />
      {differingFields.map((field) =>
        overrides[field] ? (
          <input key={field} type="hidden" name={`resolution_${field}`} value="b" />
        ) : null,
      )}

      <div className="grid grid-cols-2 gap-4">
        {([candidate.contactA, candidate.contactB] as const).map((contact, index) => {
          const side = index === 0 ? "a" : "b";
          return (
            <div
              key={contact.id}
              className={`flex flex-col gap-3 rounded-lg border p-4 ${
                keepSide === side ? "border-primary bg-primary-tint" : "border-border bg-surface"
              }`}
            >
              <label className="flex items-center gap-2 text-body font-semibold text-text">
                <input
                  type="radio"
                  name="keepSideDisplay"
                  checked={keepSide === side}
                  onChange={() => setKeepSide(side)}
                  className="size-4"
                />
                Manter {contact.name}
              </label>
              <dl className="flex flex-col gap-1.5 text-body text-text-secondary">
                <div>
                  <dt className="text-meta text-text-tertiary">Cidade/UF</dt>
                  <dd>{contact.city ? `${contact.city}${contact.uf ? `/${contact.uf}` : ""}` : "—"}</dd>
                </div>
                <div>
                  <dt className="text-meta text-text-tertiary">Telefones</dt>
                  <dd>{contact.phones.map((p) => p.value).join(", ") || "—"}</dd>
                </div>
                <div>
                  <dt className="text-meta text-text-tertiary">E-mails</dt>
                  <dd>{contact.emails.map((e) => e.value).join(", ") || "—"}</dd>
                </div>
                <div>
                  <dt className="text-meta text-text-tertiary">CPF/CNPJ</dt>
                  <dd>
                    {contact.hasSensitive ? (
                      <SensitiveField contactId={contact.id} />
                    ) : (
                      <span className="text-text-tertiary">Não cadastrado</span>
                    )}
                  </dd>
                </div>
              </dl>
            </div>
          );
        })}
      </div>

      {differingFields.length > 0 ? (
        <div className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-4">
          <p className="text-body font-semibold text-text">Campos diferentes — escolha o que fica</p>
          {differingFields.map((field) => (
            <label key={field} className="flex items-center justify-between gap-3 text-body text-text">
              <span>{FIELD_LABEL[field]}</span>
              <select
                value={overrides[field] ? "other" : "kept"}
                onChange={(event) =>
                  setOverrides((prev) => ({ ...prev, [field]: event.target.value === "other" }))
                }
                className="h-8 rounded-input border border-border-input bg-surface px-2 text-small text-text"
              >
                <option value="kept">{fieldValue(kept, field)} (mantido)</option>
                <option value="other">{fieldValue(other, field)} (do outro)</option>
              </select>
            </label>
          ))}
        </div>
      ) : null}

      <p className="text-meta text-text-tertiary">
        Telefones, e-mails e identificadores dos dois contatos são combinados — nada se perde. O contato não
        mantido continua existindo no histórico e pode ser restaurado (desde que nada tenha sido editado
        depois da mesclagem).
      </p>

      {state.error ? (
        <Alert variant="danger">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      ) : null}

      <Button type="submit" disabled={pending} className="self-start">
        {pending ? "Mesclando…" : `Mesclar, mantendo ${kept.name}`}
      </Button>
    </form>
  );
}
