"use client";

import { useState, useTransition, type FormEvent, type ReactNode } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { FormField, FormLabel } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { saveCustomFieldDefinitionAction } from "@/modules/custom-fields/actions";
import type { CustomFieldDefinition } from "@/modules/custom-fields/queries";
import {
  CUSTOM_FIELD_ENTITIES,
  CUSTOM_FIELD_ENTITY_LABEL,
  CUSTOM_FIELD_MAX_OPTIONS,
  CUSTOM_FIELD_NAME_MAX,
  CUSTOM_FIELD_OPTION_MAX,
  CUSTOM_FIELD_TYPE_LABEL,
  CUSTOM_FIELD_TYPES,
  type CustomFieldEntity,
  type CustomFieldType,
} from "@/modules/custom-fields/schema";

const SELECT_CLASS = "h-9 rounded-input border border-border-input bg-surface px-3 text-body text-text";

type Props = {
  /** Sem `definition`, cria um campo novo. */
  definition?: CustomFieldDefinition | undefined;
  /** Entidade sugerida ao criar. */
  defaultEntity?: CustomFieldEntity | undefined;
  trigger: ReactNode;
};

type OptionRow = { key: number; id: string | null; label: string; inUse: boolean };

/**
 * Criar e editar campo. Ao criar, define entidade, nome, tipo e (para seleção
 * única) as opções. Ao editar, só nome, posição e opções: o TIPO e a ENTIDADE
 * não mudam depois da criação. Opção que já tem valor não pode ser removida —
 * o botão fica desabilitado e o banco recusaria de qualquer forma. O estado
 * volta ao inicial a cada abertura (o corpo é remontado).
 */
export function CustomFieldDefinitionDialog({ definition, defaultEntity, trigger }: Props) {
  const [open, setOpen] = useState(false);
  const [instanceKey, setInstanceKey] = useState(0);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setInstanceKey((key) => key + 1);
      }}
    >
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent>
        <DefinitionFormBody
          key={instanceKey}
          definition={definition}
          defaultEntity={defaultEntity}
          onDone={() => setOpen(false)}
        />
      </DialogContent>
    </Dialog>
  );
}

function DefinitionFormBody({
  definition,
  defaultEntity,
  onDone,
}: Omit<Props, "trigger"> & { onDone: () => void }) {
  const isEdit = definition !== undefined;
  const [entity, setEntity] = useState<CustomFieldEntity>(definition?.entity ?? defaultEntity ?? "contact");
  const [name, setName] = useState(definition?.name ?? "");
  const [type, setType] = useState<CustomFieldType>(definition?.type ?? "text");
  const [position, setPosition] = useState(definition ? String(definition.position) : "");
  const [nextKey, setNextKey] = useState((definition?.options.length ?? 0) + 1);
  const [options, setOptions] = useState<OptionRow[]>(
    (definition?.options ?? []).map((option, index) => ({
      key: index,
      id: option.id,
      label: option.label,
      inUse: option.inUse,
    })),
  );
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData();
    if (definition) data.set("definitionId", definition.id);
    data.set("entity", entity);
    data.set("name", name);
    data.set("type", type);
    data.set("position", position);
    data.set(
      "options",
      JSON.stringify(
        type === "select"
          ? options.map((option) => (option.id ? { id: option.id, label: option.label } : { label: option.label }))
          : [],
      ),
    );

    setError(null);
    startTransition(async () => {
      const result = await saveCustomFieldDefinitionAction(data);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      onDone();
    });
  }

  function addOption() {
    setOptions((rows) => [...rows, { key: nextKey, id: null, label: "", inUse: false }]);
    setNextKey((key) => key + 1);
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>{isEdit ? "Editar campo" : "Novo campo"}</DialogTitle>
        <DialogDescription>
          {isEdit
            ? "Você pode mudar o nome, a posição e as opções. O tipo e a entidade não mudam depois de criado."
            : "O campo aparece na tela de cada registro da entidade escolhida."}
        </DialogDescription>
      </DialogHeader>

      <form onSubmit={submit} className="flex max-h-[70vh] flex-col gap-4 overflow-y-auto pr-1">
        <FormField>
          <FormLabel htmlFor="cf-entity">Entidade</FormLabel>
          <select
            id="cf-entity"
            value={entity}
            disabled={isEdit}
            onChange={(event) => setEntity(event.target.value as CustomFieldEntity)}
            className={SELECT_CLASS}
          >
            {CUSTOM_FIELD_ENTITIES.map((value) => (
              <option key={value} value={value}>
                {CUSTOM_FIELD_ENTITY_LABEL[value]}
              </option>
            ))}
          </select>
        </FormField>

        <FormField>
          <FormLabel htmlFor="cf-name">Nome do campo</FormLabel>
          <Input
            id="cf-name"
            value={name}
            maxLength={CUSTOM_FIELD_NAME_MAX}
            onChange={(event) => setName(event.target.value)}
            placeholder="Ex.: Número do processo"
          />
        </FormField>

        <div className="grid grid-cols-2 gap-3">
          <FormField>
            <FormLabel htmlFor="cf-type">Tipo</FormLabel>
            <select
              id="cf-type"
              value={type}
              disabled={isEdit}
              onChange={(event) => setType(event.target.value as CustomFieldType)}
              className={SELECT_CLASS}
            >
              {CUSTOM_FIELD_TYPES.map((value) => (
                <option key={value} value={value}>
                  {CUSTOM_FIELD_TYPE_LABEL[value]}
                </option>
              ))}
            </select>
          </FormField>
          <FormField>
            <FormLabel htmlFor="cf-position">Posição (opcional)</FormLabel>
            <Input
              id="cf-position"
              inputMode="numeric"
              value={position}
              maxLength={4}
              onChange={(event) => setPosition(event.target.value)}
              placeholder="Última"
            />
          </FormField>
        </div>

        {type === "select" ? (
          <fieldset className="flex flex-col gap-2 rounded-card border border-border p-3">
            <legend className="px-1 text-meta font-semibold text-text-secondary">Opções permitidas</legend>
            {options.map((option, index) => (
              <div key={option.key} className="flex items-center gap-2">
                <Input
                  aria-label={`Opção ${index + 1}`}
                  value={option.label}
                  maxLength={CUSTOM_FIELD_OPTION_MAX}
                  onChange={(event) =>
                    setOptions((rows) =>
                      rows.map((row) => (row.key === option.key ? { ...row, label: event.target.value } : row)),
                    )
                  }
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={option.inUse}
                  title={option.inUse ? "Já há registros usando esta opção." : undefined}
                  onClick={() => setOptions((rows) => rows.filter((row) => row.key !== option.key))}
                >
                  Remover
                </Button>
              </div>
            ))}
            {options.some((option) => option.inUse) ? (
              <p className="m-0 text-meta text-text-tertiary">
                Opções que já têm registros não podem ser removidas (só renomeadas).
              </p>
            ) : null}
            <div>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={addOption}
                disabled={options.length >= CUSTOM_FIELD_MAX_OPTIONS}
              >
                Adicionar opção
              </Button>
            </div>
          </fieldset>
        ) : null}

        <Alert variant="warning">
          <AlertDescription>
            Não use campos personalizados para CPF, credenciais, senhas ou outros segredos.
          </AlertDescription>
        </Alert>

        {error ? (
          <Alert variant="danger">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}

        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onDone} disabled={pending}>
            Cancelar
          </Button>
          <Button type="submit" disabled={pending}>
            {pending ? "Salvando…" : isEdit ? "Salvar" : "Criar campo"}
          </Button>
        </div>
      </form>
    </>
  );
}
