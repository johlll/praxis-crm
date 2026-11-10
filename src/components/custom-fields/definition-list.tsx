"use client";

import { useState, useTransition } from "react";

import { CustomFieldDefinitionDialog } from "@/components/custom-fields/definition-dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { setCustomFieldArchivedAction } from "@/modules/custom-fields/actions";
import type { CustomFieldDefinition } from "@/modules/custom-fields/queries";
import {
  CUSTOM_FIELD_ENTITIES,
  CUSTOM_FIELD_ENTITY_LABEL,
  CUSTOM_FIELD_MAX_ACTIVE_PER_ENTITY,
  CUSTOM_FIELD_TYPE_LABEL,
  type CustomFieldEntity,
} from "@/modules/custom-fields/schema";

/**
 * Lista por entidade, com tipo, estado (ativo ou arquivado) e as ações de editar,
 * arquivar (com confirmação) e restaurar. Arquivar NÃO apaga nada: os valores
 * continuam guardados e o campo só deixa de aparecer nos formulários.
 */
export function CustomFieldDefinitionList({ definitions }: { definitions: CustomFieldDefinition[] }) {
  return (
    <div className="flex flex-col gap-6">
      {CUSTOM_FIELD_ENTITIES.map((entity) => (
        <EntitySection key={entity} entity={entity} definitions={definitions.filter((d) => d.entity === entity)} />
      ))}
    </div>
  );
}

function EntitySection({ entity, definitions }: { entity: CustomFieldEntity; definitions: CustomFieldDefinition[] }) {
  const active = definitions.filter((definition) => !definition.archived);
  const archived = definitions.filter((definition) => definition.archived);

  return (
    <section aria-labelledby={`cf-${entity}`} className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id={`cf-${entity}`} className="m-0 text-body font-semibold text-text">
          {CUSTOM_FIELD_ENTITY_LABEL[entity]}{" "}
          <span className="text-meta font-normal text-text-tertiary">
            {active.length} de {CUSTOM_FIELD_MAX_ACTIVE_PER_ENTITY} campos ativos
          </span>
        </h2>
        <CustomFieldDefinitionDialog
          defaultEntity={entity}
          trigger={
            <Button size="sm" variant="secondary">
              Novo campo
            </Button>
          }
        />
      </div>

      {definitions.length === 0 ? (
        <p className="m-0 rounded-lg border border-dashed border-border bg-surface-subtle p-4 text-meta text-text-tertiary">
          Nenhum campo em {CUSTOM_FIELD_ENTITY_LABEL[entity].toLocaleLowerCase("pt-BR")} ainda.
        </p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {[...active, ...archived].map((definition) => (
            <DefinitionRow key={definition.id} definition={definition} />
          ))}
        </ul>
      )}
    </section>
  );
}

function DefinitionRow({ definition }: { definition: CustomFieldDefinition }) {
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function setArchived(archived: boolean) {
    setError(null);
    startTransition(async () => {
      const result = await setCustomFieldArchivedAction(definition.id, archived);
      if (!result.ok) setError(result.error);
      setConfirmArchive(false);
    });
  }

  return (
    <li className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="m-0 text-body font-semibold text-text">{definition.name}</h3>
            <span
              className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-meta font-medium ${
                definition.archived
                  ? "border border-border bg-surface text-text-tertiary"
                  : "bg-success-bg text-success"
              }`}
            >
              {definition.archived ? "Arquivado" : "Ativo"}
            </span>
          </div>
          <p className="m-0 text-meta text-text-secondary">
            {CUSTOM_FIELD_ENTITY_LABEL[definition.entity]} · {CUSTOM_FIELD_TYPE_LABEL[definition.type]} · posição{" "}
            {definition.position}
          </p>
          {definition.type === "select" && definition.options.length > 0 ? (
            <p className="m-0 text-meta text-text-tertiary">
              Opções: {definition.options.map((option) => option.label).join(", ")}
            </p>
          ) : null}
          {definition.archived ? (
            <p className="m-0 text-meta text-text-tertiary">
              Arquivado: não aparece nos formulários, mas os valores já preenchidos continuam guardados.
            </p>
          ) : null}
        </div>
      </div>

      {error ? (
        <Alert variant="danger">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        {definition.archived ? (
          <Button variant="secondary" size="sm" onClick={() => setArchived(false)} disabled={pending}>
            {pending ? "Aguarde…" : "Restaurar"}
          </Button>
        ) : (
          <>
            <CustomFieldDefinitionDialog
              definition={definition}
              trigger={
                <Button variant="secondary" size="sm" disabled={pending}>
                  Editar
                </Button>
              }
            />
            {confirmArchive ? (
              <>
                <Button variant="danger" size="sm" onClick={() => setArchived(true)} disabled={pending}>
                  Confirmar arquivamento
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setConfirmArchive(false)} disabled={pending}>
                  Cancelar
                </Button>
                <span className="text-meta text-text-tertiary">
                  Os valores preenchidos continuam guardados; o campo só some dos formulários.
                </span>
              </>
            ) : (
              <Button variant="ghost" size="sm" onClick={() => setConfirmArchive(true)} disabled={pending}>
                Arquivar
              </Button>
            )}
          </>
        )}
      </div>
    </li>
  );
}
