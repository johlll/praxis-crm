"use client";

import { useActionState, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FormField, FormLabel } from "@/components/ui/form-field";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  createFormEndpointAction,
  rotateFormEndpointKeyAction,
  setFormEndpointStatusAction,
  type FormActionState,
} from "@/modules/forms/actions";
import type { FormEndpoint } from "@/modules/forms/queries";

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

function NewEndpointForm({
  pipelines,
  stages,
}: {
  pipelines: PipelineOption[];
  stages: StageOption[];
}) {
  const [state, action, pending] = useActionState(createFormEndpointAction, INITIAL);
  // `is_default` só PRÉ-SELECIONA: o endpoint grava o id explícito, para
  // que trocar o padrão depois não mude o destino de um formulário já
  // publicado (contrato §4).
  const [pipelineId, setPipelineId] = useState(
    pipelines.find((p) => p.isDefault)?.id ?? pipelines[0]?.id ?? "",
  );

  const availableStages = stages.filter((stage) => stage.pipelineId === pipelineId && !stage.isTerminal);

  return (
    <form action={action} className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4">
      <h3 className="m-0 text-body font-bold text-text">Novo formulário</h3>

      <FormField>
        <FormLabel htmlFor="name">Nome</FormLabel>
        <Input id="name" name="name" required maxLength={120} />
      </FormField>

      <FormField>
        <FormLabel htmlFor="pipelineId">Pipeline</FormLabel>
        <select
          id="pipelineId"
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
        <FormLabel htmlFor="stageId">Etapa inicial</FormLabel>
        <select
          id="stageId"
          name="stageId"
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
        <FormLabel htmlFor="legalArea">Área jurídica</FormLabel>
        <Input id="legalArea" name="legalArea" required maxLength={120} />
      </FormField>

      <FormField>
        <FormLabel htmlFor="initialActivityType">Atividade inicial</FormLabel>
        <select
          id="initialActivityType"
          name="initialActivityType"
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
        <FormLabel htmlFor="initialActivityDueMinutes">Prazo da atividade inicial (minutos)</FormLabel>
        <Input
          id="initialActivityDueMinutes"
          name="initialActivityDueMinutes"
          type="number"
          min={1}
          max={43200}
          required
        />
      </FormField>

      <FormField>
        <FormLabel htmlFor="captureMode">Modo de captação</FormLabel>
        <select
          id="captureMode"
          name="captureMode"
          className="h-9 rounded-input border border-border-input bg-surface px-3 text-body"
        >
          <option value="new_intake">Captação nova (sempre abre demanda)</option>
          <option value="continuity">Continuidade (anexa quando houver referência válida)</option>
        </select>
      </FormField>

      <FormField>
        <FormLabel htmlFor="turnstileAction">Ação do Turnstile</FormLabel>
        <Input id="turnstileAction" name="turnstileAction" required maxLength={60} defaultValue="formulario" />
      </FormField>

      <FormField>
        <FormLabel htmlFor="allowedHostnames">Domínios permitidos (separados por vírgula)</FormLabel>
        <Input id="allowedHostnames" name="allowedHostnames" required placeholder="exemplo.com.br, www.exemplo.com.br" />
      </FormField>

      <Button type="submit" disabled={pending} className="self-start">
        {pending ? "Criando…" : "Criar formulário"}
      </Button>

      {state.error ? (
        <Alert variant="danger">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      ) : null}
      {state.ok && state.publicKey ? (
        <Alert variant="success">
          <AlertDescription>
            Formulário criado. Endereço público: <code>/api/forms/{state.publicKey}</code>
          </AlertDescription>
        </Alert>
      ) : null}
    </form>
  );
}

function EndpointRow({ endpoint }: { endpoint: FormEndpoint }) {
  const [statusState, statusAction, statusPending] = useActionState(setFormEndpointStatusAction, INITIAL);
  const [rotateState, rotateAction, rotatePending] = useActionState(rotateFormEndpointKeyAction, INITIAL);

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
      <NewEndpointForm pipelines={pipelines} stages={stages} />

      {endpoints.length === 0 ? (
        <p className="m-0 text-body text-text-secondary">Nenhum formulário configurado ainda.</p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-3 p-0">
          {endpoints.map((endpoint) => (
            <EndpointRow key={endpoint.id} endpoint={endpoint} />
          ))}
        </ul>
      )}
    </div>
  );
}
