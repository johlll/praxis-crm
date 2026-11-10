"use client";

import { useActionState, useMemo, useState } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { FormField, FormLabel } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { EditForm } from "@/components/feedback/edit-form";
import { saveCustomFieldValuesAction, type CustomFieldActionState } from "@/modules/custom-fields/actions";
import type { RecordCustomField } from "@/modules/custom-fields/queries";
import type { CustomFieldEntity } from "@/modules/custom-fields/schema";

const INITIAL_STATE: CustomFieldActionState = { ok: false };

function initialValue(field: RecordCustomField): string {
  if (field.fieldType === "short_text") return field.textValue ?? "";
  if (field.fieldType === "number") return field.numberValue === null ? "" : String(field.numberValue);
  if (field.fieldType === "date") return field.dateValue ?? "";
  if (field.fieldType === "boolean") return field.booleanValue === null ? "" : String(field.booleanValue);
  return field.optionId ?? "";
}

export function RecordCustomFieldsForm({
  entityType,
  recordId,
  fields,
  canEdit,
}: {
  entityType: CustomFieldEntity;
  recordId: string;
  fields: RecordCustomField[];
  canEdit: boolean;
}) {
  const [state, action, pending] = useActionState(saveCustomFieldValuesAction, INITIAL_STATE);
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(fields.map((field) => [field.definitionId, initialValue(field)])),
  );

  const payload = useMemo(() => fields.flatMap((field) => {
    const value = values[field.definitionId] ?? "";
    if (value === "") return [];
    return [{
      definition_id: field.definitionId,
      ...(field.fieldType === "short_text" ? { text_value: value } : {}),
      ...(field.fieldType === "number" ? { number_value: value } : {}),
      ...(field.fieldType === "date" ? { date_value: value } : {}),
      ...(field.fieldType === "boolean" ? { boolean_value: value } : {}),
      ...(field.fieldType === "single_select" ? { option_id: value } : {}),
    }];
  }), [fields, values]);

  if (fields.length === 0) return null;

  return (
    <section className="rounded-lg border border-border bg-surface p-4">
      <h2 className="mb-3 text-body font-semibold text-text">Campos personalizados</h2>
      <EditForm action={action} className="flex flex-col gap-4">
        <input type="hidden" name="entityType" value={entityType} />
        <input type="hidden" name="recordId" value={recordId} />
        <input type="hidden" name="valuesJson" value={JSON.stringify(payload)} />
        {fields.map((field) => {
          const id = `custom-field-${field.definitionId}`;
          const value = values[field.definitionId] ?? "";
          return (
            <FormField key={field.definitionId}>
              <FormLabel htmlFor={id}>{field.name}</FormLabel>
              {field.fieldType === "boolean" ? (
                <select
                  id={id}
                  value={value}
                  disabled={!canEdit}
                  onChange={(event) => setValues((current) => ({ ...current, [field.definitionId]: event.target.value }))}
                  className="h-9 rounded-input border border-border-input bg-surface px-3 text-body text-text disabled:opacity-60"
                >
                  <option value="">Não informado</option>
                  <option value="true">Sim</option>
                  <option value="false">Não</option>
                </select>
              ) : field.fieldType === "single_select" ? (
                <select
                  id={id}
                  value={value}
                  disabled={!canEdit}
                  onChange={(event) => setValues((current) => ({ ...current, [field.definitionId]: event.target.value }))}
                  className="h-9 rounded-input border border-border-input bg-surface px-3 text-body text-text disabled:opacity-60"
                >
                  <option value="">Não informado</option>
                  {field.options.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
                </select>
              ) : (
                <Input
                  id={id}
                  type={field.fieldType === "number" ? "number" : field.fieldType === "date" ? "date" : "text"}
                  step={field.fieldType === "number" ? "any" : undefined}
                  maxLength={field.fieldType === "short_text" ? 200 : undefined}
                  value={value}
                  disabled={!canEdit}
                  onChange={(event) => setValues((current) => ({ ...current, [field.definitionId]: event.target.value }))}
                />
              )}
            </FormField>
          );
        })}
        {state.error ? <Alert variant="danger"><AlertDescription>{state.error}</AlertDescription></Alert> : null}
        {state.ok ? <Alert variant="success"><AlertDescription>Campos salvos.</AlertDescription></Alert> : null}
        {canEdit ? <Button type="submit" disabled={pending} className="self-start">{pending ? "Salvando…" : "Salvar campos"}</Button> : null}
      </EditForm>
    </section>
  );
}
