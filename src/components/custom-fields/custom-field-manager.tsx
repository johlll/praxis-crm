"use client";

import { useActionState, useState } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { FormField, FormLabel } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { EditForm } from "@/components/feedback/edit-form";
import {
  archiveCustomFieldAction,
  createCustomFieldAction,
  updateCustomFieldAction,
  type CustomFieldActionState,
} from "@/modules/custom-fields/actions";
import type { CustomFieldDefinition } from "@/modules/custom-fields/queries";
import {
  CUSTOM_FIELD_ENTITIES,
  CUSTOM_FIELD_ENTITY_LABEL,
  CUSTOM_FIELD_TYPES,
  CUSTOM_FIELD_TYPE_LABEL,
} from "@/modules/custom-fields/schema";

const INITIAL_STATE: CustomFieldActionState = { ok: false };

function DefinitionEditor({ definition }: { definition: CustomFieldDefinition }) {
  const [state, action, pending] = useActionState(updateCustomFieldAction, INITIAL_STATE);
  const [archiveState, archiveAction, archiving] = useActionState(archiveCustomFieldAction, INITIAL_STATE);
  const [name, setName] = useState(definition.name);
  const [position, setPosition] = useState(String(definition.position));
  const activeOptions = definition.options.filter((option) => option.status !== "archived");
  const [options, setOptions] = useState(activeOptions.map((option) => ({ id: option.id, label: option.label })));
  const optionsJson = options.map((option, index) => ({ ...option, label: option.label.trim(), position: index }));

  return (
    <article className="rounded-lg border border-border bg-surface p-4">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h3 className="font-semibold text-text">{definition.name}</h3>
          <p className="text-meta text-text-tertiary">
            {CUSTOM_FIELD_ENTITY_LABEL[definition.entityType]} · {CUSTOM_FIELD_TYPE_LABEL[definition.fieldType]} · {definition.status === "active" ? "Ativo" : "Arquivado"}
          </p>
        </div>
      </div>
      {definition.status === "active" ? (
        <>
          <EditForm action={action} className="flex flex-col gap-3">
            <input type="hidden" name="definitionId" value={definition.id} />
            <input type="hidden" name="optionsJson" value={JSON.stringify(optionsJson)} />
            <div className="grid grid-cols-[1fr_100px] gap-3">
              <FormField><FormLabel htmlFor={`name-${definition.id}`}>Nome</FormLabel><Input id={`name-${definition.id}`} name="name" value={name} onChange={(event) => setName(event.target.value)} /></FormField>
              <FormField><FormLabel htmlFor={`position-${definition.id}`}>Posição</FormLabel><Input id={`position-${definition.id}`} name="position" type="number" min={0} value={position} onChange={(event) => setPosition(event.target.value)} /></FormField>
            </div>
            {definition.fieldType === "single_select" ? (
              <FormField>
                <FormLabel>Opções</FormLabel>
                {options.map((option, index) => (
                  <div key={option.id || `new-${index}`} className="flex gap-2">
                    <Input
                      aria-label={`Opção ${index + 1}`}
                      value={option.label}
                      onChange={(event) => setOptions((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, label: event.target.value } : item))}
                    />
                    <Button type="button" variant="ghost" size="sm" onClick={() => setOptions((current) => current.filter((_, itemIndex) => itemIndex !== index))}>Remover</Button>
                  </div>
                ))}
                <Button type="button" variant="secondary" size="sm" className="self-start" onClick={() => setOptions((current) => [...current, { id: "", label: "" }])}>Adicionar opção</Button>
              </FormField>
            ) : null}
            {state.error ? <Alert variant="danger"><AlertDescription>{state.error}</AlertDescription></Alert> : null}
            {state.ok ? <Alert variant="success"><AlertDescription>Campo atualizado.</AlertDescription></Alert> : null}
            <Button type="submit" size="sm" variant="secondary" disabled={pending} className="self-start">{pending ? "Salvando…" : "Salvar alterações"}</Button>
          </EditForm>
          <form action={archiveAction} className="mt-3 border-t border-border pt-3" onSubmit={(event) => { if (!window.confirm("Arquivar este campo? Os valores existentes serão preservados.")) event.preventDefault(); }}>
            <input type="hidden" name="definitionId" value={definition.id} />
            {archiveState.error ? <Alert variant="danger"><AlertDescription>{archiveState.error}</AlertDescription></Alert> : null}
            <Button type="submit" size="sm" variant="ghost" disabled={archiving}>{archiving ? "Arquivando…" : "Arquivar campo"}</Button>
          </form>
        </>
      ) : <p className="text-small text-text-secondary">Os valores existentes foram preservados. Este campo não aparece mais nos formulários.</p>}
    </article>
  );
}
export function CustomFieldManager({ definitions }: { definitions: CustomFieldDefinition[] }) {
  const [state, action, pending] = useActionState(createCustomFieldAction, INITIAL_STATE);
  const [fieldType, setFieldType] = useState<(typeof CUSTOM_FIELD_TYPES)[number]>("short_text");

  return (
    <div className="flex flex-col gap-5">
      <section className="rounded-lg border border-border bg-surface p-4">
        <h2 className="mb-1 text-body font-semibold text-text">Novo campo</h2>
        <p className="mb-4 text-small text-text-secondary">Não use campos personalizados para CPF, credenciais, senhas ou segredos.</p>
        <EditForm action={action} className="grid gap-3 sm:grid-cols-2">
          <FormField><FormLabel htmlFor="entityType">Entidade</FormLabel><select id="entityType" name="entityType" className="h-9 rounded-input border border-border-input bg-surface px-3 text-body text-text">{CUSTOM_FIELD_ENTITIES.map((entity) => <option key={entity} value={entity}>{CUSTOM_FIELD_ENTITY_LABEL[entity]}</option>)}</select></FormField>
          <FormField><FormLabel htmlFor="fieldType">Tipo</FormLabel><select id="fieldType" name="fieldType" value={fieldType} onChange={(event) => setFieldType(event.target.value as typeof fieldType)} className="h-9 rounded-input border border-border-input bg-surface px-3 text-body text-text">{CUSTOM_FIELD_TYPES.map((type) => <option key={type} value={type}>{CUSTOM_FIELD_TYPE_LABEL[type]}</option>)}</select></FormField>
          <FormField><FormLabel htmlFor="custom-name">Nome</FormLabel><Input id="custom-name" name="name" maxLength={80} required /></FormField>
          <FormField><FormLabel htmlFor="custom-position">Posição</FormLabel><Input id="custom-position" name="position" type="number" min={0} defaultValue={0} required /></FormField>
          {fieldType === "single_select" ? <FormField className="sm:col-span-2"><FormLabel htmlFor="custom-options">Opções (uma por linha)</FormLabel><textarea id="custom-options" name="options" rows={4} required className="rounded-input border border-border-input bg-surface px-3 py-2 text-body text-text" /></FormField> : <input type="hidden" name="options" value="" />}
          <div className="sm:col-span-2">{state.error ? <Alert variant="danger"><AlertDescription>{state.error}</AlertDescription></Alert> : null}{state.ok ? <Alert variant="success"><AlertDescription>Campo criado.</AlertDescription></Alert> : null}</div>
          <Button type="submit" disabled={pending} className="self-start">{pending ? "Criando…" : "Criar campo"}</Button>
        </EditForm>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-body font-semibold text-text">Campos cadastrados</h2>
        {definitions.length === 0 ? <div className="rounded-lg border border-dashed border-border p-6 text-center text-small text-text-secondary">Nenhum campo personalizado cadastrado.</div> : definitions.map((definition) => <DefinitionEditor key={definition.id} definition={definition} />)}
      </section>
    </div>
  );
}
