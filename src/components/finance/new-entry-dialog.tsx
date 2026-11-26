"use client";

import { useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Plus } from "lucide-react";

import { cn } from "@/lib/cn";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import type { EntryKind, FinanceEntry } from "@/modules/finance/ledger";
import {
  MAX_DESCRIPTION,
  MAX_PARTY,
  validateNewEntry,
  type NewEntryDraft,
  type NewEntryErrors,
  type NewEntryField,
} from "@/modules/finance/new-entry";

export const SIMULATION_NOTICE = "Simulação — não grava no financeiro do escritório";

const FIELD_ORDER: readonly NewEntryField[] = ["description", "party", "amount", "dueDate", "paidDate"];
const inputClass = "h-9 w-full min-w-0 rounded-md border border-border-input bg-surface-subtle px-3 text-body text-text";

const emptyDraft = (today: string): NewEntryDraft => ({
  kind: "receita",
  description: "",
  party: "",
  amount: "",
  dueDate: today,
  settled: false,
  paidDate: today,
});

function Field({ id, label, error, children }: { id: string; label: string; error?: string | undefined; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <label htmlFor={id} className="text-meta font-semibold text-text-secondary">
        {label}
      </label>
      {children}
      {error ? (
        <p id={`${id}-erro`} className="m-0 text-meta text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function Choice<T extends string>({
  legend,
  name,
  value,
  options,
  onChange,
}: {
  legend: string;
  name: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <fieldset className="m-0 border-0 p-0">
      <legend className="mb-1 p-0 text-meta font-semibold text-text-secondary">{legend}</legend>
      <div className="flex gap-2">
        {options.map((option) => (
          <label
            key={option.value}
            className={cn(
              "flex h-9 flex-1 cursor-pointer items-center justify-center gap-2 rounded-md border px-2 text-body font-semibold has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-primary",
              value === option.value ? "border-primary-border bg-primary-tint text-text" : "border-border bg-surface text-text-muted",
            )}
          >
            <input
              type="radio"
              name={name}
              checked={value === option.value}
              onChange={() => onChange(option.value)}
              className="accent-[var(--color-primary)]"
            />
            {option.label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/**
 * Formulário de SIMULAÇÃO. Ao confirmar, só devolve o lançamento para a memória da página: não há envio,
 * Server Action, banco nem armazenamento do navegador.
 */
export function NewEntryDialog({ today, nextId, onAdd }: { today: string; nextId: () => string; onAdd: (entry: FinanceEntry) => void }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<NewEntryDraft>(() => emptyDraft(today));
  const [errors, setErrors] = useState<NewEntryErrors>({});
  const formRef = useRef<HTMLFormElement>(null);
  const prefix = useId();
  const fieldId = (field: string) => `${prefix}-${field}`;
  const update = (patch: Partial<NewEntryDraft>) => {
    setDraft((d) => ({ ...d, ...patch }));
    setErrors((e) => {
      const next = { ...e };
      for (const key of Object.keys(patch)) delete next[key as NewEntryField];
      return next;
    });
  };
  const aria = (field: NewEntryField) => ({
    id: fieldId(field),
    "aria-invalid": errors[field] ? true : undefined,
    "aria-describedby": errors[field] ? `${fieldId(field)}-erro` : undefined,
    className: cn(inputClass, errors[field] && "border-danger"),
  });

  function changeOpen(next: boolean) {
    setOpen(next);
    if (next) {
      setDraft(emptyDraft(today));
      setErrors({});
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const result = validateNewEntry(draft, today, nextId());
    if (!result.ok) {
      setErrors(result.errors);
      const first = FIELD_ORDER.find((f) => result.errors[f]);
      formRef.current?.querySelector<HTMLInputElement>(`[id="${fieldId(first!)}"]`)?.focus();
      return;
    }
    setOpen(false);
    onAdd(result.entry);
  }

  const income = draft.kind === "receita";

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogTrigger asChild>
        <Button type="button">
          <Plus size={15} aria-hidden />
          Novo lançamento
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-[520px]">
        <DialogHeader>
          <DialogTitle>Novo lançamento (simulação)</DialogTitle>
          <DialogDescription className="rounded-md border border-purple/40 bg-purple-bg px-3 py-2 font-semibold text-purple">
            {SIMULATION_NOTICE}
          </DialogDescription>
        </DialogHeader>
        <form ref={formRef} noValidate onSubmit={submit} className="flex flex-col gap-3">
          <Choice<EntryKind>
            legend="Tipo"
            name={fieldId("kind")}
            value={draft.kind}
            options={[
              { value: "receita", label: "Receita" },
              { value: "despesa", label: "Despesa" },
            ]}
            onChange={(kind) => update({ kind })}
          />
          <Field id={fieldId("description")} label="Descrição" error={errors.description}>
            <input {...aria("description")} type="text" maxLength={MAX_DESCRIPTION} value={draft.description} onChange={(e) => update({ description: e.target.value })} />
          </Field>
          <Field id={fieldId("party")} label={`${income ? "Cliente" : "Fornecedor"} (fictício)`} error={errors.party}>
            <input {...aria("party")} type="text" maxLength={MAX_PARTY} autoComplete="off" value={draft.party} onChange={(e) => update({ party: e.target.value })} />
          </Field>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field id={fieldId("amount")} label="Valor (R$)" error={errors.amount}>
              <input {...aria("amount")} type="text" inputMode="decimal" placeholder="1.250,00" value={draft.amount} onChange={(e) => update({ amount: e.target.value })} />
            </Field>
            <Field id={fieldId("dueDate")} label="Vencimento" error={errors.dueDate}>
              <input {...aria("dueDate")} type="date" value={draft.dueDate} onChange={(e) => update({ dueDate: e.target.value })} />
            </Field>
          </div>
          <Choice<"open" | "settled">
            legend="Situação"
            name={fieldId("situation")}
            value={draft.settled ? "settled" : "open"}
            options={[
              { value: "open", label: income ? "A receber" : "A pagar" },
              { value: "settled", label: income ? "Recebido" : "Pago" },
            ]}
            onChange={(v) => update({ settled: v === "settled" })}
          />
          {draft.settled ? (
            <Field id={fieldId("paidDate")} label={`Data do ${income ? "recebimento" : "pagamento"}`} error={errors.paidDate}>
              <input {...aria("paidDate")} type="date" max={today} value={draft.paidDate} onChange={(e) => update({ paidDate: e.target.value })} />
            </Field>
          ) : null}
          <DialogFooter className="mt-2">
            <DialogClose asChild>
              <Button type="button" variant="secondary">
                Cancelar
              </Button>
            </DialogClose>
            <Button type="submit">Adicionar à simulação</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
