"use client";

import Link from "next/link";
import { useId, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { cn } from "@/lib/cn";
import { formatDate } from "@/lib/timezone";
import { CASE_PROGRESS_STATUSES, CASE_PROGRESS_STATUS_LABEL } from "@/modules/status-tracks/schema";
import {
  applyCaseServicePlanAction,
  assignCaseNumberAction,
  completeCaseServiceStepAction,
  removeCaseServicePlanAction,
  reopenCaseServiceStepAction,
  setCaseServiceCurrentStepAction,
} from "@/modules/case-service/actions";
import {
  nextPendingAfter,
  serviceStepItems,
  type CaseService,
  type ServiceTypeItem,
} from "@/modules/case-service/schema";
import { useTrackAction, type PanelActionState } from "./use-track-action";

const SELECT_CLASS =
  "h-9 min-w-0 rounded-input border border-border-input bg-surface-subtle px-2 text-body text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-ring disabled:opacity-60";
/** Botões com o nome da etapa quebram linha em vez de transbordar no celular. */
const WRAP_BUTTON = "h-auto min-h-8 whitespace-normal py-1.5 text-left";

const REOPEN_STATUS_OPTIONS = CASE_PROGRESS_STATUSES.filter((s) => s !== "nao_informado" && s !== "concluido").map((s) => ({
  value: s,
  label: CASE_PROGRESS_STATUS_LABEL[s],
}));

/**
 * Uma chave de idempotência por INTENÇÃO: repetir o mesmo pedido (clique duplo, resposta perdida) reaproveita a
 * chave; qualquer outro pedido ganha chave nova. Depois de concluído, a chave é descartada.
 */
function useIntentKey() {
  const ref = useRef<{ sig: string; key: string } | null>(null);
  return {
    keyFor(sig: string): string {
      if (!ref.current || ref.current.sig !== sig) ref.current = { sig, key: crypto.randomUUID() };
      return ref.current.key;
    },
    reset() {
      ref.current = null;
    },
  };
}

function Feedback({
  done,
  error,
  conflict,
  onRefresh,
}: {
  done: string | null;
  error: string | null;
  conflict: boolean;
  onRefresh: () => void;
}) {
  return (
    <div aria-live="polite" className="flex flex-col gap-2">
      {done ? <p className="m-0 text-meta font-semibold text-success">{done}</p> : null}
      {conflict ? (
        <Alert variant="warning">
          <AlertDescription>
            Este caso mudou enquanto você editava (o andamento e o roteiro têm uma versão só). Atualize para ver o estado atual
            antes de tentar de novo.{" "}
            <button type="button" onClick={onRefresh} className="font-semibold underline">
              Atualizar
            </button>
          </AlertDescription>
        </Alert>
      ) : null}
      {error ? (
        <Alert variant="danger">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------
// Número interno
// ---------------------------------------------------------------------

/**
 * Atribuição EXPLÍCITA do número interno (casos antigos, ou um caso ainda aberto). O número é o próximo do
 * escritório, não muda depois e não é o número do processo judicial.
 */
export function CaseNumberControl(props: { opportunityId: string; canAssign: boolean; closed: boolean }) {
  return <CaseNumberControlBody key={`case_number:${props.opportunityId}`} {...props} />;
}

function CaseNumberControlBody({ opportunityId, canAssign, closed }: { opportunityId: string; canAssign: boolean; closed: boolean }) {
  const [confirming, setConfirming] = useState(false);
  const { pending, blocked, error, conflict, done, run, refresh } = useTrackAction();

  if (closed) {
    return <p className="m-0 text-meta text-text-tertiary">Caso perdido sem número interno: não recebe número.</p>;
  }
  if (!canAssign) {
    return <p className="m-0 text-meta text-text-tertiary">Sem número interno. Seu perfil não atribui números.</p>;
  }
  return (
    <div className="flex flex-col gap-2">
      {!confirming ? (
        <Button type="button" variant="secondary" size="sm" className="w-fit" disabled={pending || blocked} onClick={() => setConfirming(true)}>
          Atribuir número interno
        </Button>
      ) : (
        <div role="group" aria-label="Confirmar a atribuição do número" className="flex flex-col gap-2 rounded-input border border-border bg-surface-subtle p-3">
          <p className="m-0 text-meta text-text-secondary">
            O caso recebe o próximo número interno do escritório. O número não muda depois e não é o número do processo.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              disabled={pending || blocked}
              onClick={() => run(() => assignCaseNumberAction({ opportunityId }), () => setConfirming(false))}
            >
              {pending ? "Atribuindo…" : "Confirmar"}
            </Button>
            <Button type="button" variant="ghost" size="sm" disabled={pending} onClick={() => setConfirming(false)}>
              Cancelar
            </Button>
          </div>
        </div>
      )}
      <Feedback done={done} error={error} conflict={conflict} onRefresh={refresh} />
    </div>
  );
}

// ---------------------------------------------------------------------
// Roteiro do serviço
// ---------------------------------------------------------------------

type EditorProps = {
  opportunityId: string;
  service: CaseService;
  serviceTypes: ServiceTypeItem[] | null;
  canEdit: boolean;
  /** service_catalog.manage — mostra o atalho para o catálogo quando ele está vazio. */
  canManageCatalog: boolean;
};

/**
 * Roteiro do caso na edição pelo lápis. Cada botão é UMA decisão humana registrada (quem, quando, alvo):
 * concluir não conclui outras etapas; escolher a etapa atual não conclui nada; voltar a uma etapa concluída
 * exige reabri-la; reabrir num serviço concluído exige escolher o novo andamento (as duas mudanças juntas).
 * Usa a versão ÚNICA da trilha case_progress: se o andamento ou o roteiro mudou no meio, o servidor recusa.
 */
export function ServicePlanEditor(props: EditorProps) {
  // Identidade = trilha + alvo: trocar de caso leva a um editor do zero (escolhas, confirmações, erros e chave).
  return <ServicePlanEditorBody key={`case_progress:${props.opportunityId}`} {...props} />;
}

type Pending =
  | { kind: "reopen"; stepId: string }
  | { kind: "replace" }
  | { kind: "remove" }
  | null;

function ServicePlanEditorBody({ opportunityId, service, serviceTypes, canEdit, canManageCatalog }: EditorProps) {
  const uid = useId();
  const intent = useIntentKey();
  const { pending, blocked, error, conflict, done, run, refresh } = useTrackAction();
  const busy = pending || blocked;
  const [typeId, setTypeId] = useState("");
  const [startPos, setStartPos] = useState("");
  const [next, setNext] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<Pending>(null);
  const [ack, setAck] = useState(false);
  const [reopenStatus, setReopenStatus] = useState("");
  const [reopenCurrent, setReopenCurrent] = useState(true);

  const plan = service.plan;
  const concluded = service.status === "concluido";
  const version = service.version;

  function go(sig: string, call: (key: string) => Promise<PanelActionState>) {
    run(
      () => call(intent.keyFor(sig)),
      () => {
        intent.reset();
        setConfirm(null);
        setAck(false);
        setTypeId("");
        setStartPos("");
        setNext(null);
        setReopenStatus("");
      },
    );
  }

  function onRefresh() {
    intent.reset();
    setConfirm(null);
    setAck(false);
    refresh();
  }

  const types = serviceTypes ?? [];
  const chosen = types.find((t) => t.id === typeId) ?? null;

  const typePicker = (
    <div className="flex flex-col gap-2">
      <div className="flex min-w-0 flex-col gap-1">
        <label htmlFor={`${uid}-tipo`} className="text-meta font-semibold text-text-secondary">
          Tipo de serviço
        </label>
        <select
          id={`${uid}-tipo`}
          value={typeId}
          onChange={(e) => {
            setTypeId(e.target.value);
            setStartPos("");
          }}
          disabled={busy}
          className={SELECT_CLASS}
        >
          <option value="">Escolher…</option>
          {types.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name} ({t.steps.length} {t.steps.length === 1 ? "etapa" : "etapas"})
            </option>
          ))}
        </select>
      </div>
      {chosen ? (
        <>
          <ol className="m-0 flex list-decimal flex-col gap-0.5 pl-5 text-meta text-text-tertiary">
            {chosen.steps.map((s) => (
              <li key={s.position}>{s.name}</li>
            ))}
          </ol>
          <div className="flex min-w-0 flex-col gap-1">
            <label htmlFor={`${uid}-inicio`} className="text-meta font-semibold text-text-secondary">
              Etapa atual ao aplicar
            </label>
            <select id={`${uid}-inicio`} value={startPos} onChange={(e) => setStartPos(e.target.value)} disabled={busy} className={SELECT_CLASS}>
              <option value="">Nenhuma por enquanto</option>
              {chosen.steps.map((s) => (
                <option key={s.position} value={String(s.position)}>
                  {s.position}. {s.name}
                </option>
              ))}
            </select>
            <p className="m-0 text-meta text-text-tertiary">Nenhuma etapa nasce concluída: as conclusões são registradas uma a uma.</p>
          </div>
        </>
      ) : null}
    </div>
  );

  const emptyCatalog =
    types.length === 0 ? (
      <p className="m-0 text-meta text-text-tertiary">
        O escritório ainda não tem tipos de serviço.{" "}
        {canManageCatalog ? (
          <Link href={"/configuracoes/tipos-de-servico" as never} className="font-semibold text-primary hover:underline">
            Criar no catálogo
          </Link>
        ) : (
          "Peça a quem configura o escritório para criar no catálogo."
        )}
      </p>
    ) : null;

  if (!canEdit) {
    return <p className="m-0 text-meta text-text-tertiary">Seu perfil não altera o roteiro do serviço.</p>;
  }

  // ---- Sem roteiro: aplicar
  if (!plan) {
    if (concluded) {
      return (
        <p className="m-0 text-meta text-text-tertiary">
          O serviço está concluído. Para aplicar um roteiro, primeiro reabra o andamento (em “Andamento do serviço”).
        </p>
      );
    }
    return (
      <div className="flex flex-col gap-3">
        <p className="m-0 text-meta text-text-tertiary">
          Este caso não tem roteiro. Aplicar copia as etapas do tipo escolhido para o caso: mudanças futuras no modelo não
          alteram este caso.
        </p>
        {emptyCatalog ?? (
          <>
            {typePicker}
            <Button
              type="button"
              size="md"
              className="w-fit"
              disabled={busy || !chosen}
              onClick={() =>
                go(`apply:${typeId}:${startPos}`, (key) =>
                  applyCaseServicePlanAction(
                    {
                      opportunityId,
                      serviceTypeId: typeId,
                      expectedVersion: version,
                      currentStepPosition: startPos ? Number(startPos) : null,
                      idempotencyKey: key,
                    },
                    "apply",
                  ),
                )
              }
            >
              {pending ? "Aplicando…" : "Aplicar roteiro"}
            </Button>
          </>
        )}
        <Feedback done={done} error={error} conflict={conflict} onRefresh={onRefresh} />
      </div>
    );
  }

  // ---- Com roteiro
  const items = serviceStepItems(plan);
  const current = items.find((s) => s.state === "current") ?? null;
  const suggestedNext = current ? nextPendingAfter(plan, current.id) : null;
  const nextChoice = next ?? suggestedNext?.id ?? "";
  const pendingOthers = items.filter((s) => s.state === "pending");
  const allDone = items.every((s) => s.state === "completed");
  const templateNewer = plan.templateVersion !== null && plan.templateVersion > plan.serviceTypeVersion;

  return (
    <div className="flex flex-col gap-3">
      <p className="m-0 text-meta text-text-tertiary">
        Roteiro <span className="font-semibold text-text-secondary">{plan.serviceTypeName}</span>, aplicado em {formatDate(plan.appliedAt)}
        {plan.appliedByName ? ` por ${plan.appliedByName}` : ""}.
        {templateNewer
          ? ` O modelo foi alterado depois; este caso continua com a cópia aplicada (para usar o modelo novo, troque o roteiro).`
          : ""}
      </p>

      {current ? (
        <div className="flex flex-col gap-2 rounded-input border border-primary-border bg-primary-tint/40 p-3">
          <p className="m-0 text-small font-semibold text-text">
            Etapa atual: {current.position}. {current.name}
          </p>
          <div className="flex min-w-0 flex-col gap-1">
            <label htmlFor={`${uid}-proxima`} className="text-meta font-semibold text-text-secondary">
              Depois de concluir, etapa atual
            </label>
            <select id={`${uid}-proxima`} value={nextChoice} onChange={(e) => setNext(e.target.value)} disabled={busy} className={SELECT_CLASS}>
              <option value="">Nenhuma</option>
              {pendingOthers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.position}. {s.name}
                </option>
              ))}
            </select>
          </div>
          <Button
            type="button"
            size="sm"
            className={cn("w-fit", WRAP_BUTTON)}
            disabled={busy}
            onClick={() =>
              go(`complete:${current.id}:${nextChoice}`, (key) =>
                completeCaseServiceStepAction({
                  opportunityId,
                  stepId: current.id,
                  expectedVersion: version,
                  nextCurrentStepId: nextChoice || null,
                  idempotencyKey: key,
                }),
              )
            }
          >
            {pending ? "Registrando…" : `Concluir “${current.name}”`}
          </Button>
          <p className="m-0 text-meta text-text-tertiary">Concluir registra só esta etapa, com seu nome e o horário.</p>
        </div>
      ) : allDone ? (
        <p className="m-0 rounded-input bg-surface-subtle px-3 py-2 text-meta text-text-secondary">
          Todas as etapas têm conclusão registrada.
          {concluded ? " O serviço está concluído." : " Para dar o serviço como concluído, use “Andamento do serviço” acima."}
        </p>
      ) : (
        <p className="m-0 rounded-input bg-surface-subtle px-3 py-2 text-meta text-text-secondary">
          Nenhuma etapa atual definida. Escolha abaixo em qual etapa o serviço está.
        </p>
      )}

      <ul className="m-0 flex list-none flex-col p-0" aria-label="Etapas do roteiro">
        {items.map((s) => (
          <li key={s.id} className="flex flex-col gap-1.5 border-b border-border-subtle py-2 first:pt-0 last:border-b-0 last:pb-0">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <span className="min-w-0 flex-1 text-small text-text [overflow-wrap:anywhere]">
                <span className="mr-1 tabular-nums text-text-muted">{s.position}.</span>
                <span className={s.state === "current" ? "font-bold" : undefined}>{s.name}</span>
                <span
                  className={cn(
                    "ml-1.5 inline-block rounded-full px-1.5 py-px text-label font-bold",
                    s.state === "completed" ? "bg-success-bg text-success" : s.state === "current" ? "bg-primary-tint text-primary" : "bg-surface-muted text-text-secondary",
                  )}
                >
                  {s.state === "completed" ? "✓ concluída" : s.state === "current" ? "atual" : "pendente"}
                </span>
                {s.state === "completed" && s.completedAt ? (
                  <span className="block text-meta text-text-tertiary">
                    Concluída em {formatDate(s.completedAt)}
                    {s.completedByName ? ` por ${s.completedByName}` : ""}
                  </span>
                ) : null}
              </span>
              <span className="flex flex-wrap gap-1.5">
                {s.state === "pending" ? (
                  <>
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      disabled={busy}
                      aria-label={`Tornar “${s.name}” a etapa atual`}
                      onClick={() =>
                        go(`current:${s.id}`, (key) =>
                          setCaseServiceCurrentStepAction({ opportunityId, stepId: s.id, expectedVersion: version, idempotencyKey: key }),
                        )
                      }
                    >
                      Tornar atual
                    </Button>
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      disabled={busy}
                      aria-label={`Concluir “${s.name}”`}
                      onClick={() =>
                        go(`complete:${s.id}:-`, (key) =>
                          completeCaseServiceStepAction({ opportunityId, stepId: s.id, expectedVersion: version, idempotencyKey: key }),
                        )
                      }
                    >
                      Concluir
                    </Button>
                  </>
                ) : null}
                {s.state === "completed" ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    aria-label={`Reabrir “${s.name}”`}
                    onClick={() => {
                      setConfirm({ kind: "reopen", stepId: s.id });
                      setReopenCurrent(true);
                      setReopenStatus("");
                    }}
                  >
                    Reabrir
                  </Button>
                ) : null}
              </span>
            </div>

            {confirm?.kind === "reopen" && confirm.stepId === s.id ? (
              <div role="group" aria-label={`Reabrir “${s.name}”`} className="flex flex-col gap-2 rounded-input border border-warning/30 bg-warning-bg p-3">
                <p className="m-0 text-meta text-text-secondary">
                  A conclusão sai da etapa, mas continua no histórico, com quem concluiu e quando.
                </p>
                {concluded ? (
                  <div className="flex min-w-0 flex-col gap-1">
                    <label htmlFor={`${uid}-reab-${s.id}`} className="text-meta font-semibold text-text-secondary">
                      O serviço está concluído. Novo andamento
                    </label>
                    <select
                      id={`${uid}-reab-${s.id}`}
                      value={reopenStatus}
                      onChange={(e) => setReopenStatus(e.target.value)}
                      disabled={busy}
                      className={SELECT_CLASS}
                    >
                      <option value="">Escolher…</option>
                      {REOPEN_STATUS_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  </div>
                ) : null}
                <label className="flex items-center gap-2 text-meta text-text-secondary">
                  <input
                    type="checkbox"
                    checked={reopenCurrent}
                    onChange={(e) => setReopenCurrent(e.target.checked)}
                    disabled={busy}
                    className="size-4 accent-[var(--color-primary)]"
                  />
                  Voltar a ser a etapa atual
                </label>
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    size="sm"
                    disabled={busy || (concluded && !reopenStatus)}
                    onClick={() =>
                      go(`reopen:${s.id}:${reopenCurrent}:${reopenStatus}`, (key) =>
                        reopenCaseServiceStepAction({
                          opportunityId,
                          stepId: s.id,
                          expectedVersion: version,
                          makeCurrent: reopenCurrent,
                          progressStatus: concluded ? reopenStatus : null,
                          idempotencyKey: key,
                        }),
                      )
                    }
                  >
                    {pending ? "Reabrindo…" : "Confirmar reabertura"}
                  </Button>
                  <Button type="button" variant="ghost" size="sm" disabled={pending} onClick={() => setConfirm(null)}>
                    Cancelar
                  </Button>
                </div>
              </div>
            ) : null}
          </li>
        ))}
      </ul>

      {current ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="w-fit"
          disabled={busy}
          onClick={() =>
            go("current:-", (key) => setCaseServiceCurrentStepAction({ opportunityId, stepId: null, expectedVersion: version, idempotencyKey: key }))
          }
        >
          Deixar sem etapa atual
        </Button>
      ) : null}

      <div className="flex flex-col gap-2 border-t border-border-subtle pt-3">
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="secondary" size="sm" disabled={busy || concluded} onClick={() => { setConfirm({ kind: "replace" }); setAck(false); }}>
            Trocar roteiro
          </Button>
          <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => { setConfirm({ kind: "remove" }); setAck(false); }}>
            Remover roteiro
          </Button>
        </div>
        {concluded ? <p className="m-0 text-meta text-text-tertiary">Serviço concluído: para trocar o roteiro, reabra o andamento.</p> : null}

        {confirm?.kind === "replace" ? (
          <div role="group" aria-label="Trocar roteiro" className="flex flex-col gap-2 rounded-input border border-border bg-surface-subtle p-3">
            <p className="m-0 text-meta text-text-secondary">
              O roteiro atual fica encerrado no histórico, com as conclusões dele. O novo começa sem nenhuma etapa concluída.
            </p>
            {emptyCatalog ?? typePicker}
            {plan.hasRecords ? <AckBox id={`${uid}-ack-troca`} checked={ack} onChange={setAck} disabled={busy} /> : null}
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                size="sm"
                disabled={busy || !chosen || (plan.hasRecords && !ack)}
                onClick={() =>
                  go(`replace:${typeId}:${startPos}:${ack}`, (key) =>
                    applyCaseServicePlanAction(
                      {
                        opportunityId,
                        serviceTypeId: typeId,
                        expectedVersion: version,
                        currentStepPosition: startPos ? Number(startPos) : null,
                        acknowledgeRecords: ack,
                        idempotencyKey: key,
                      },
                      "replace",
                    ),
                  )
                }
              >
                {pending ? "Trocando…" : "Confirmar troca"}
              </Button>
              <Button type="button" variant="ghost" size="sm" disabled={pending} onClick={() => setConfirm(null)}>
                Cancelar
              </Button>
            </div>
          </div>
        ) : null}

        {confirm?.kind === "remove" ? (
          <div role="group" aria-label="Remover roteiro" className="flex flex-col gap-2 rounded-input border border-border bg-surface-subtle p-3">
            <p className="m-0 text-meta text-text-secondary">
              O caso volta a não ter roteiro. Nada é apagado: o roteiro e as conclusões ficam no histórico. O andamento não muda.
            </p>
            {plan.hasRecords ? <AckBox id={`${uid}-ack-remove`} checked={ack} onChange={setAck} disabled={busy} /> : null}
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="danger"
                size="sm"
                disabled={busy || (plan.hasRecords && !ack)}
                onClick={() =>
                  go(`remove:${ack}`, (key) =>
                    removeCaseServicePlanAction({ opportunityId, expectedVersion: version, acknowledgeRecords: ack, idempotencyKey: key }),
                  )
                }
              >
                {pending ? "Removendo…" : "Confirmar remoção"}
              </Button>
              <Button type="button" variant="ghost" size="sm" disabled={pending} onClick={() => setConfirm(null)}>
                Cancelar
              </Button>
            </div>
          </div>
        ) : null}
      </div>

      <Feedback done={done} error={error} conflict={conflict} onRefresh={onRefresh} />
    </div>
  );
}

function AckBox({ id, checked, onChange, disabled }: { id: string; checked: boolean; onChange: (v: boolean) => void; disabled: boolean }) {
  return (
    <label htmlFor={id} className="flex items-start gap-2 text-meta text-text-secondary">
      <input
        id={id}
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        disabled={disabled}
        className="mt-0.5 size-4 shrink-0 accent-[var(--color-primary)]"
      />
      Este roteiro tem etapas concluídas. Entendo que as conclusões ficam no histórico e não passam para o caso daqui em diante.
    </label>
  );
}
