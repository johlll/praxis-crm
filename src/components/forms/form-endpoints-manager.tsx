"use client";

import { useActionState, useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FormField, FormLabel } from "@/components/ui/form-field";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  createFormEndpointAction,
  rotateFormEndpointKeyAction,
  setFormEndpointStatusAction,
  updateFormEndpointAction,
  type FormActionState,
} from "@/modules/forms/actions";
import type { FormEndpoint } from "@/modules/forms/queries";
import type { AnswerFieldDefinition, AnswerFieldType } from "@/modules/forms/schema";

/**
 * Configuração dos formulários públicos (A11) — owner/admin.
 *
 * O fluxo normal NÃO depende de edição manual do banco: criar, desativar,
 * reativar e rotacionar a chave acontecem aqui.
 *
 * O prazo da atividade inicial é campo OBRIGATÓRIO, sem valor herdado: o
 * "60 minutos" existe só no seed fictício (contrato §4).
 */

const INITIAL: FormActionState = { ok: false };

type StageOption = { id: string; name: string; pipelineId: string; isTerminal: boolean };
type PipelineOption = { id: string; name: string; isDefault: boolean };

type DraftField = AnswerFieldDefinition & { draftId: string };

let draftFieldCounter = 0;
function nextDraftId() {
  draftFieldCounter += 1;
  return `campo-${draftFieldCounter}`;
}

/**
 * Editor da lista de campos aceitos por `answers` (A11, item 6 da
 * auditoria pós-dry-run). Serializa em JSON num campo oculto — o
 * servidor valida de novo com o MESMO schema (`answersConfigSchema`),
 * nunca confia só no que a tela mandou.
 *
 * `initialFields` (item 8): a tela de EDIÇÃO precisa nascer com os
 * campos que o endpoint já tem — sem isto, editar qualquer outra coisa
 * (nome, domínios, etc.) apagaria silenciosamente a configuração de
 * campos existente, porque o editor sempre começava vazio.
 */
function AnswersFieldEditor({ initialFields = [] }: { initialFields?: AnswerFieldDefinition[] | undefined }) {
  const [fields, setFields] = useState<DraftField[]>(() =>
    initialFields.map((field) => ({ ...field, draftId: nextDraftId() })),
  );

  const json = useMemo(
    () =>
      JSON.stringify({
        fields: fields.map(({ draftId: _draftId, ...field }) => field),
      }),
    [fields],
  );

  function addField() {
    setFields((current) => [
      ...current,
      { draftId: nextDraftId(), key: "", label: "", type: "text", required: false },
    ]);
  }

  function updateField(draftId: string, patch: Partial<AnswerFieldDefinition>) {
    setFields((current) => current.map((field) => (field.draftId === draftId ? { ...field, ...patch } : field)));
  }

  function removeField(draftId: string) {
    setFields((current) => current.filter((field) => field.draftId !== draftId));
  }

  return (
    <FormField>
      <FormLabel htmlFor="answers-field-editor">Campos do formulário (além de nome, e-mail e telefone)</FormLabel>
      <div id="answers-field-editor" className="flex flex-col gap-2">
        {fields.length === 0 ? (
          <p className="m-0 text-meta text-text-muted">Nenhum campo extra ainda. A borda recusa qualquer campo não listado aqui.</p>
        ) : null}
        {fields.map((field) => (
          <div key={field.draftId} className="flex flex-wrap items-center gap-2 rounded-input border border-border-input p-2">
            <Input
              aria-label="Chave do campo"
              placeholder="chave_do_campo"
              value={field.key}
              onChange={(event) => updateField(field.draftId, { key: event.target.value })}
              className="w-40"
            />
            <Input
              aria-label="Rótulo do campo"
              placeholder="Rótulo exibido"
              value={field.label}
              onChange={(event) => updateField(field.draftId, { label: event.target.value })}
              className="w-48"
            />
            <select
              aria-label="Tipo do campo"
              value={field.type}
              onChange={(event) => updateField(field.draftId, { type: event.target.value as AnswerFieldType })}
              className="h-9 rounded-input border border-border-input bg-surface px-2 text-body"
            >
              <option value="text">Texto</option>
              <option value="boolean">Sim/não</option>
              <option value="number">Número</option>
            </select>
            <label className="flex items-center gap-1 text-meta text-text-secondary">
              <input
                type="checkbox"
                checked={field.required}
                onChange={(event) => updateField(field.draftId, { required: event.target.checked })}
              />
              Obrigatório
            </label>
            <Button type="button" variant="ghost" size="sm" onClick={() => removeField(field.draftId)}>
              Remover
            </Button>
          </div>
        ))}
        <Button type="button" variant="secondary" size="sm" onClick={addField} className="self-start">
          Adicionar campo
        </Button>
      </div>
      <input type="hidden" name="answersConfigJson" value={json} />
    </FormField>
  );
}

/**
 * Formulário de CRIAR e de EDITAR um endpoint — o MESMO componente (item
 * 8 da auditoria pós-dry-run: antes só existia a metade de criar; editar
 * não tinha tela nenhuma, só era possível mexendo direto no banco).
 *
 * `endpoint` presente = modo edição: todo campo nasce PREENCHIDO com o
 * valor atual (inclusive os campos extras, via AnswersFieldEditor), e o
 * submit chama `updateFormEndpointAction` em vez de `createFormEndpointAction`.
 */
function EndpointForm({
  pipelines,
  stages,
  endpoint,
  onSaved,
}: {
  pipelines: PipelineOption[];
  stages: StageOption[];
  endpoint?: FormEndpoint;
  onSaved?: () => void;
}) {
  const isEditing = Boolean(endpoint);
  const [state, action, pending] = useActionState(
    isEditing ? updateFormEndpointAction : createFormEndpointAction,
    INITIAL,
  );
  // `is_default` só PRÉ-SELECIONA na criação: o endpoint grava o id
  // explícito, para que trocar o padrão depois não mude o destino de um
  // formulário já publicado (contrato §4). Na edição, o pipeline ATUAL
  // do endpoint é o ponto de partida.
  const [pipelineId, setPipelineId] = useState(
    endpoint?.pipelineId ?? pipelines.find((p) => p.isDefault)?.id ?? pipelines[0]?.id ?? "",
  );

  const availableStages = stages.filter((stage) => stage.pipelineId === pipelineId && !stage.isTerminal);

  useEffect(() => {
    if (isEditing && state.ok) onSaved?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.ok]);

  return (
    <form action={action} className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4">
      <h3 className="m-0 text-body font-bold text-text">{isEditing ? `Editar “${endpoint!.name}”` : "Novo formulário"}</h3>

      {isEditing ? <input type="hidden" name="formEndpointId" value={endpoint!.id} /> : null}

      <FormField>
        <FormLabel htmlFor={`name-${endpoint?.id ?? "novo"}`}>Nome</FormLabel>
        <Input id={`name-${endpoint?.id ?? "novo"}`} name="name" required maxLength={120} defaultValue={endpoint?.name} />
      </FormField>

      <FormField>
        <FormLabel htmlFor={`pipelineId-${endpoint?.id ?? "novo"}`}>Pipeline</FormLabel>
        <select
          id={`pipelineId-${endpoint?.id ?? "novo"}`}
          name="pipelineId"
          value={pipelineId}
          onChange={(event) => setPipelineId(event.target.value)}
          className="h-9 rounded-input border border-border-input bg-surface px-3 text-body"
        >
          {pipelines.map((pipeline) => (
            <option key={pipeline.id} value={pipeline.id}>
              {pipeline.name}
              {pipeline.isDefault ? " (padrão)" : ""}
            </option>
          ))}
        </select>
      </FormField>

      <FormField>
        <FormLabel htmlFor={`stageId-${endpoint?.id ?? "novo"}`}>Etapa inicial</FormLabel>
        <select
          id={`stageId-${endpoint?.id ?? "novo"}`}
          name="stageId"
          defaultValue={endpoint?.stageId}
          className="h-9 rounded-input border border-border-input bg-surface px-3 text-body"
        >
          {availableStages.map((stage) => (
            <option key={stage.id} value={stage.id}>
              {stage.name}
            </option>
          ))}
        </select>
        <span className="text-meta text-text-muted">
          Etapas de ganho e de perda não aparecem aqui: uma captação nova nunca nasce numa etapa terminal.
        </span>
      </FormField>

      <FormField>
        <FormLabel htmlFor={`legalArea-${endpoint?.id ?? "novo"}`}>Área jurídica</FormLabel>
        <Input
          id={`legalArea-${endpoint?.id ?? "novo"}`}
          name="legalArea"
          required
          maxLength={120}
          defaultValue={endpoint?.legalArea}
        />
      </FormField>

      <FormField>
        <FormLabel htmlFor={`initialActivityType-${endpoint?.id ?? "novo"}`}>Atividade inicial</FormLabel>
        <select
          id={`initialActivityType-${endpoint?.id ?? "novo"}`}
          name="initialActivityType"
          defaultValue={endpoint?.initialActivityType ?? "call"}
          className="h-9 rounded-input border border-border-input bg-surface px-3 text-body"
        >
          <option value="call">Ligação</option>
          <option value="meeting">Reunião</option>
          <option value="task">Tarefa</option>
          <option value="email">E-mail</option>
          <option value="deadline">Prazo</option>
        </select>
      </FormField>

      <FormField>
        <FormLabel htmlFor={`initialActivityDueMinutes-${endpoint?.id ?? "novo"}`}>
          Prazo da atividade inicial (minutos)
        </FormLabel>
        <Input
          id={`initialActivityDueMinutes-${endpoint?.id ?? "novo"}`}
          name="initialActivityDueMinutes"
          type="number"
          min={1}
          max={43200}
          required
          defaultValue={endpoint?.initialActivityDueMinutes}
        />
      </FormField>

      <FormField>
        <FormLabel htmlFor={`captureMode-${endpoint?.id ?? "novo"}`}>Modo de captação</FormLabel>
        <select
          id={`captureMode-${endpoint?.id ?? "novo"}`}
          name="captureMode"
          defaultValue={endpoint?.captureMode ?? "new_intake"}
          className="h-9 rounded-input border border-border-input bg-surface px-3 text-body"
        >
          <option value="new_intake">Captação nova (sempre abre demanda)</option>
          <option value="continuity">Continuidade (anexa quando houver referência válida)</option>
        </select>
      </FormField>

      <FormField>
        <FormLabel htmlFor={`turnstileAction-${endpoint?.id ?? "novo"}`}>Ação do Turnstile</FormLabel>
        <Input
          id={`turnstileAction-${endpoint?.id ?? "novo"}`}
          name="turnstileAction"
          required
          maxLength={60}
          defaultValue={endpoint?.turnstileAction ?? "formulario"}
        />
      </FormField>

      <FormField>
        <FormLabel htmlFor={`allowedHostnames-${endpoint?.id ?? "novo"}`}>
          Domínios permitidos (separados por vírgula)
        </FormLabel>
        <Input
          id={`allowedHostnames-${endpoint?.id ?? "novo"}`}
          name="allowedHostnames"
          required
          placeholder="exemplo.com.br, www.exemplo.com.br"
          defaultValue={endpoint?.allowedHostnames.join(", ")}
        />
      </FormField>

      <AnswersFieldEditor initialFields={endpoint?.answersConfig.fields} />

      <div className="flex items-center gap-2">
        <Button type="submit" disabled={pending} className="self-start">
          {pending ? "Salvando…" : isEditing ? "Salvar alterações" : "Criar formulário"}
        </Button>
        {isEditing ? (
          <Button type="button" variant="ghost" size="sm" onClick={onSaved}>
            Cancelar
          </Button>
        ) : null}
      </div>

      {state.error ? (
        <Alert variant="danger">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      ) : null}
      {!isEditing && state.ok && state.publicKey ? (
        <Alert variant="success">
          <AlertDescription>
            Formulário criado. Endereço público: <code>/api/forms/{state.publicKey}</code>
          </AlertDescription>
        </Alert>
      ) : null}
    </form>
  );
}

function EndpointRow({
  endpoint,
  pipelines,
  stages,
}: {
  endpoint: FormEndpoint;
  pipelines: PipelineOption[];
  stages: StageOption[];
}) {
  const [statusState, statusAction, statusPending] = useActionState(setFormEndpointStatusAction, INITIAL);
  const [rotateState, rotateAction, rotatePending] = useActionState(rotateFormEndpointKeyAction, INITIAL);
  const [isEditing, setIsEditing] = useState(false);

  if (isEditing) {
    return (
      <li>
        <EndpointForm
          pipelines={pipelines}
          stages={stages}
          endpoint={endpoint}
          onSaved={() => setIsEditing(false)}
        />
      </li>
    );
  }

  return (
    <li className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-body font-bold text-text">{endpoint.name}</span>
        <span
          className={`rounded-pill px-2 py-0.5 text-meta font-semibold ${
            endpoint.status === "active" ? "bg-primary-tint text-primary" : "bg-neutral-bg text-text-tertiary"
          }`}
        >
          {endpoint.status === "active" ? "Ativo" : "Desativado"}
        </span>
      </div>

      <dl className="m-0 grid gap-1 text-meta text-text-secondary md:grid-cols-2">
        <div>
          <dt className="inline font-semibold">Destino: </dt>
          <dd className="m-0 inline">
            {endpoint.pipelineName} · {endpoint.stageName}
          </dd>
        </div>
        <div>
          <dt className="inline font-semibold">Área: </dt>
          <dd className="m-0 inline">{endpoint.legalArea}</dd>
        </div>
        <div>
          <dt className="inline font-semibold">Modo: </dt>
          <dd className="m-0 inline">
            {endpoint.captureMode === "new_intake" ? "Captação nova" : "Continuidade"}
          </dd>
        </div>
        <div>
          <dt className="inline font-semibold">Eventos recebidos: </dt>
          <dd className="m-0 inline">{endpoint.receivedEvents}</dd>
        </div>
      </dl>

      <p className="m-0 text-meta text-text-muted">
        Endereço público: <code>/api/forms/{endpoint.publicKey ?? "—"}</code>
        {endpoint.revokedKeyCount > 0 ? ` · ${endpoint.revokedKeyCount} chave(s) revogada(s)` : ""}
      </p>

      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="secondary" size="sm" onClick={() => setIsEditing(true)}>
          Editar
        </Button>

        <form action={statusAction}>
          <input type="hidden" name="formEndpointId" value={endpoint.id} />
          <input type="hidden" name="status" value={endpoint.status === "active" ? "disabled" : "active"} />
          <Button type="submit" variant="secondary" size="sm" disabled={statusPending}>
            {endpoint.status === "active" ? "Desativar" : "Reativar"}
          </Button>
        </form>

        <form action={rotateAction}>
          <input type="hidden" name="formEndpointId" value={endpoint.id} />
          <Button type="submit" variant="ghost" size="sm" disabled={rotatePending}>
            Rotacionar chave
          </Button>
        </form>
      </div>

      <p className="m-0 text-meta text-text-muted">
        Desativar derruba apenas a captação nova: os eventos já recebidos continuam intactos.
      </p>

      {statusState.error ? (
        <Alert variant="danger">
          <AlertDescription>{statusState.error}</AlertDescription>
        </Alert>
      ) : null}
      {rotateState.error ? (
        <Alert variant="danger">
          <AlertDescription>{rotateState.error}</AlertDescription>
        </Alert>
      ) : null}
      {rotateState.ok && rotateState.publicKey ? (
        <Alert variant="success">
          <AlertDescription>
            Chave rotacionada. Novo endereço: <code>/api/forms/{rotateState.publicKey}</code> — a anterior foi revogada
            e passa a recusar envios.
          </AlertDescription>
        </Alert>
      ) : null}
    </li>
  );
}

export function FormEndpointsManager({
  endpoints,
  pipelines,
  stages,
}: {
  endpoints: FormEndpoint[];
  pipelines: PipelineOption[];
  stages: StageOption[];
}) {
  return (
    <div className="flex flex-col gap-4">
      <EndpointForm pipelines={pipelines} stages={stages} />

      {endpoints.length === 0 ? (
        <p className="m-0 text-body text-text-secondary">Nenhum formulário configurado ainda.</p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-3 p-0">
          {endpoints.map((endpoint) => (
            <EndpointRow key={endpoint.id} endpoint={endpoint} pipelines={pipelines} stages={stages} />
          ))}
        </ul>
      )}
    </div>
  );
}
