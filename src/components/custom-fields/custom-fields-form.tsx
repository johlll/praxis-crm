"use client";

import { useState, useTransition, type FormEvent } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { FormField, FormLabel } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { saveCustomFieldValuesAction } from "@/modules/custom-fields/actions";
import type { CustomFieldValueField } from "@/modules/custom-fields/queries";
import {
  customFieldInputName,
  CUSTOM_FIELD_TEXT_MAX,
  type CustomFieldEntity,
} from "@/modules/custom-fields/schema";

const SELECT_CLASS = "h-9 rounded-input border border-border-input bg-surface px-3 text-body text-text";

type Props = {
  entity: CustomFieldEntity;
  recordId: string;
  fields: CustomFieldValueField[];
  /** Permissão de edição da entidade; sem ela os valores aparecem só para leitura. */
  canEdit: boolean;
};

function initialText(field: CustomFieldValueField): string {
  if (field.value === null) return "";
  if (field.type === "boolean") return field.value === true ? "true" : "false";
  return String(field.value);
}

function displayValue(field: CustomFieldValueField): string {
  if (field.value === null) return "—";
  switch (field.type) {
    case "boolean":
      return field.value === true ? "Sim" : "Não";
    case "select":
      return field.options.find((option) => option.id === field.value)?.label ?? "—";
    case "date": {
      const [year, month, day] = String(field.value).split("-");
      return year && month && day ? `${day}/${month}/${year}` : "—";
    }
    case "number":
      return typeof field.value === "number" ? field.value.toLocaleString("pt-BR", { maximumFractionDigits: 4 }) : "—";
    default:
      return String(field.value);
  }
}

/**
 * Campos personalizados de um registro, dentro da própria tela da entidade. Os
 * tipos e as opções vêm do banco; o envio é uma gravação só (tudo ou nada).
 * Sem permissão de edição, só leitura.
 */
export function CustomFieldsForm({ entity, recordId, fields, canEdit }: Props) {
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(fields.map((field) => [field.definitionId, initialText(field)])),
  );
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [pending, startTransition] = useTransition();

  if (!canEdit) {
    return (
      <dl className="m-0 grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-2">
        {fields.map((field) => (
          <div key={field.definitionId} className="flex flex-col gap-0.5">
            <dt className="text-meta text-text-tertiary">{field.name}</dt>
            <dd className="m-0 text-body text-text">{displayValue(field)}</dd>
          </div>
        ))}
      </dl>
    );
  }

  function set(definitionId: string, value: string) {
    setValues((current) => ({ ...current, [definitionId]: value }));
    setMessage(null);
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData();
    for (const field of fields) {
      data.set(customFieldInputName(field.definitionId), values[field.definitionId] ?? "");
    }
    setMessage(null);
    startTransition(async () => {
      const result = await saveCustomFieldValuesAction(entity, recordId, data);
      setMessage(
        result.ok
          ? { kind: "ok", text: result.changed > 0 ? "Campos salvos." : "Nada mudou." }
          : { kind: "error", text: result.error },
      );
    });
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      {fields.map((field) => {
        const id = `cf-value-${field.definitionId}`;
        const current = values[field.definitionId] ?? "";
        return (
          <FormField key={field.definitionId}>
            <FormLabel htmlFor={id}>{field.name}</FormLabel>
            {field.type === "boolean" ? (
              <select id={id} value={current} onChange={(e) => set(field.definitionId, e.target.value)} className={SELECT_CLASS}>
                <option value="">Não informado</option>
                <option value="true">Sim</option>
                <option value="false">Não</option>
              </select>
            ) : field.type === "select" ? (
              <select id={id} value={current} onChange={(e) => set(field.definitionId, e.target.value)} className={SELECT_CLASS}>
                <option value="">Não informado</option>
                {field.options.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
            ) : field.type === "date" ? (
              <Input id={id} type="date" value={current} onChange={(e) => set(field.definitionId, e.target.value)} />
            ) : (
              <Input
                id={id}
                value={current}
                inputMode={field.type === "number" ? "decimal" : undefined}
                maxLength={field.type === "text" ? CUSTOM_FIELD_TEXT_MAX : 20}
                onChange={(e) => set(field.definitionId, e.target.value)}
              />
            )}
          </FormField>
        );
      })}

      {message ? (
        <Alert variant={message.kind === "ok" ? "default" : "danger"}>
          <AlertDescription>{message.text}</AlertDescription>
        </Alert>
      ) : null}

      <div>
        <Button type="submit" size="sm" disabled={pending}>
          {pending ? "Salvando…" : "Salvar campos"}
        </Button>
      </div>
    </form>
  );
}
