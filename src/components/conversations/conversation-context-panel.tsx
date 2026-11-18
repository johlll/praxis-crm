import type { ReactNode } from "react";
import Link from "next/link";
import { Briefcase, Info, TriangleAlert } from "lucide-react";

import { cn } from "@/lib/cn";
import { initialsOf } from "@/lib/initials";
import { formatPhoneForDisplay } from "@/lib/format-phone";
import { formatDate, formatDue } from "@/lib/timezone";
import {
  ATTENDANCE_STATUSES,
  ATTENDANCE_STATUS_LABEL,
  CASE_PROGRESS_STATUSES,
  CASE_PROGRESS_STATUS_LABEL,
  type AttendanceStatus,
  type CaseProgressStatus,
} from "@/modules/status-tracks/schema";
import type { ConversationContext } from "@/modules/conversations/context";
import { inboxHref, type InboxParams } from "@/modules/conversations/inbox";
import { formatStamp, type EvidenceCandidate } from "@/modules/conversations/context-format";
import { ATTENDANCE_STATUS_CLASS, CASE_PROGRESS_STATUS_CLASS } from "./labels";
import { TrackStatusEditor } from "./context/status-editor";
import { AutomationControl } from "./context/automation-control";
import { HistoryTimeline, type TimelineSource } from "./context/history-timeline";
import { ContextRetryButton } from "./context/retry-button";
import { TrackBusyProvider } from "./context/track-busy";

const ATTENDANCE_OPTIONS = ATTENDANCE_STATUSES.filter((s) => s !== "nao_informado").map((s) => ({
  value: s,
  label: ATTENDANCE_STATUS_LABEL[s],
}));
const PROGRESS_OPTIONS = CASE_PROGRESS_STATUSES.filter((s) => s !== "nao_informado").map((s) => ({
  value: s,
  label: CASE_PROGRESS_STATUS_LABEL[s],
}));

const OPPORTUNITY_STATUS_LABEL = { open: "Aberta", won: "Ganha", lost: "Perdida" } as const;
const OPPORTUNITY_STATUS_CLASS = {
  open: "bg-info-bg text-info",
  won: "bg-success-bg text-success",
  lost: "bg-neutral-bg text-neutral",
} as const;

export type ContextPermissions = {
  /** conversation.attendance_edit — corrige a situação do atendimento e pausa as alterações automáticas dela. */
  editAttendance: boolean;
  /** case.progress_edit — corrige o andamento jurídico do serviço e pausa as alterações automáticas dele. */
  editProgress: boolean;
  /** opportunity.edit — pausa as alterações automáticas da etapa comercial. */
  pauseCommercial: boolean;
};

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3 px-4 py-4" aria-label={title}>
      <div className="flex flex-col gap-0.5">
        <h3 className="m-0 text-small font-bold uppercase tracking-[0.04em] text-text-muted">{title}</h3>
        {hint ? <p className="m-0 text-meta text-text-tertiary">{hint}</p> : null}
      </div>
      {children}
    </section>
  );
}

function StatusChip({ label, className }: { label: string; className: string }) {
  return <span className={cn("inline-flex w-fit rounded-full px-2.5 py-0.5 text-meta font-bold", className)}>{label}</span>;
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-border-subtle py-1.5 last:border-b-0">
      <dt className="shrink-0 text-meta text-text-muted">{label}</dt>
      <dd className="m-0 min-w-0 text-right text-small font-semibold text-text [overflow-wrap:anywhere]">{children}</dd>
    </div>
  );
}

/**
 * Painel de contexto da conversa (Conversas + IA, PR 2). Mostra só o que o
 * sistema tem e o papel alcança: contato, situação do atendimento (da
 * conversa), caso em foco (etapa comercial; andamento só se a oportunidade foi
 * ganha) e o histórico das alterações com referências de evidência. Não existe
 * aqui processo jurídico, imóvel, protocolo, sentença, documentos, tarefas ou
 * observações: nada disso é inventado para parecer completo.
 */
export function ConversationContextPanel({
  conversation,
  context,
  contextFailed,
  params,
  permissions,
  evidence,
  consentSlot,
}: {
  conversation: {
    id: string;
    contactId: string | null;
    contactName: string | null;
    waId: string;
    leadId: string | null;
    legalArea: string | null;
    needsLinkReview: boolean;
  };
  context: ConversationContext | null;
  contextFailed: boolean;
  params: InboxParams;
  permissions: ContextPermissions;
  evidence: EvidenceCandidate[];
  consentSlot: ReactNode;
}) {
  const name = conversation.contactName ?? "Contato a definir";

  return (
    <div className="flex flex-col divide-y divide-border">
      <p className="m-0 flex items-start gap-2 bg-surface-subtle px-4 py-2.5 text-meta text-text-tertiary">
        <Info size={14} className="mt-px shrink-0" aria-hidden />
        <span>A automação de status ainda não foi ativada: nenhuma situação ou andamento muda sozinho.</span>
      </p>

      <Section title="Contato">
        <div className="flex items-center gap-3">
          <span
            aria-hidden
            className="flex size-10 shrink-0 items-center justify-center rounded-full bg-surface-muted text-body font-bold text-text-secondary"
          >
            {conversation.contactName ? initialsOf(conversation.contactName) : "?"}
          </span>
          <div className="flex min-w-0 flex-col">
            <span className="truncate text-body font-semibold text-text">{name}</span>
            <span className="truncate text-meta text-text-tertiary">{conversation.waId ? formatPhoneForDisplay(conversation.waId) : "Telefone não informado"}</span>
          </div>
        </div>
        {conversation.legalArea || conversation.contactId || conversation.leadId ? (
          <dl className="m-0">
            {conversation.legalArea ? <Row label="Área">{conversation.legalArea}</Row> : null}
          </dl>
        ) : null}
        <div className="flex flex-wrap gap-3">
          {conversation.contactId ? (
            <Link href={`/contatos/${conversation.contactId}` as never} className="text-small font-semibold text-primary hover:underline">
              Ver contato
            </Link>
          ) : null}
          {conversation.leadId ? (
            <Link href={`/leads/${conversation.leadId}` as never} className="text-small font-semibold text-primary hover:underline">
              Ver lead e linha do tempo
            </Link>
          ) : null}
        </div>
        {!conversation.contactId ? (
          <p className="m-0 text-meta text-text-tertiary">
            Esta conversa ainda não tem um contato vinculado.
            {conversation.needsLinkReview ? (
              <>
                {" "}
                <a href="#revisao-vinculo" className="font-semibold text-primary hover:underline">
                  Ir para a revisão de vínculo
                </a>
              </>
            ) : null}
          </p>
        ) : null}
      </Section>

      {contextFailed || !context ? (
        <Section title="Atendimento e caso">
          <div role="alert" className="flex flex-col gap-2 rounded-input border border-danger/25 bg-danger-bg px-3 py-3">
            <p className="m-0 flex items-center gap-2 text-small font-semibold text-text">
              <TriangleAlert size={14} className="text-danger" aria-hidden />
              {contextFailed ? "Não foi possível carregar o contexto" : "Contexto indisponível"}
            </p>
            <p className="m-0 text-meta text-text-secondary">
              {contextFailed
                ? "A conversa e as mensagens continuam funcionando. Tente novamente em instantes."
                : "Você não tem acesso às informações de situação e caso desta conversa."}
            </p>
            {contextFailed ? <ContextRetryButton /> : null}
          </div>
        </Section>
      ) : (
        <ContextSections
          conversation={conversation}
          context={context}
          params={params}
          permissions={permissions}
          evidence={evidence}
        />
      )}

      <Section title="Consentimento">{consentSlot}</Section>
    </div>
  );
}

function ContextSections({
  conversation,
  context,
  params,
  permissions,
  evidence,
}: {
  conversation: { id: string; contactId: string | null; needsLinkReview: boolean };
  context: ConversationContext;
  params: InboxParams;
  permissions: ContextPermissions;
  evidence: EvidenceCandidate[];
}) {
  const { attendance, cases, focus } = context;
  const attStatus = (attendance.state.status ?? "nao_informado") as AttendanceStatus;

  const sources: TimelineSource[] = [{ track: "attendance", targetId: conversation.id, page: attendance.history }];
  if (focus) {
    if (focus.progress) {
      sources.push({ track: "case_progress", targetId: focus.option.opportunityId, page: focus.progress.history });
    }
    sources.push({ track: "commercial_stage", targetId: focus.option.opportunityId, page: focus.commercial.history });
  }

  return (
    <TrackBusyProvider>
      <Section title="Situação do atendimento" hint="Pertence a esta conversa.">
        <div className="flex flex-col gap-1.5">
          <StatusChip label={ATTENDANCE_STATUS_LABEL[attStatus]} className={ATTENDANCE_STATUS_CLASS[attStatus]} />
          {attStatus === "nao_informado" ? (
            <p className="m-0 text-meta text-text-tertiary">
              Ainda sem registro de situação. Nada foi inferido para conversas anteriores.
            </p>
          ) : attendance.state.manualDecidedAt ? (
            <p className="m-0 text-meta text-text-tertiary">
              Última decisão manual em {formatStamp(attendance.state.manualDecidedAt)}.
            </p>
          ) : null}
        </div>
        {permissions.editAttendance ? (
          <TrackStatusEditor
            kind="attendance"
            targetId={conversation.id}
            current={attendance.state.status}
            version={attendance.state.version}
            options={ATTENDANCE_OPTIONS}
            evidence={evidence}
            fieldLabel="Corrigir situação"
          />
        ) : (
          <p className="m-0 text-meta text-text-tertiary">Seu perfil só visualiza a situação do atendimento.</p>
        )}
        <AutomationControl
          track="attendance"
          targetId={conversation.id}
          paused={attendance.state.automationPaused}
          pausedAt={attendance.state.automationPausedAt}
          pausedByName={attendance.state.automationPausedByName}
          version={attendance.state.version}
          canEdit={permissions.editAttendance}
          deniedReason="Seu perfil não altera as alterações automáticas da situação do atendimento."
        />
      </Section>

      <Section title="Caso em foco" hint="A oportunidade que este painel mostra. Não altera o vínculo da conversa.">
        {context.invalidCaseRequested ? (
          <p role="status" className="m-0 rounded-input border border-warning/25 bg-warning-bg px-3 py-2 text-meta text-warning">
            O caso pedido no endereço não pertence a este contato ou não está ao seu alcance. Mostrando o caso padrão.
          </p>
        ) : null}

        {!cases.contactResolved ? (
          <p className="m-0 text-meta text-text-tertiary">
            Sem contato vinculado não há caso para escolher.
            {conversation.needsLinkReview ? (
              <>
                {" "}
                <a href="#revisao-vinculo" className="font-semibold text-primary hover:underline">
                  Resolver na revisão de vínculo
                </a>
              </>
            ) : null}
          </p>
        ) : cases.items.length === 0 ? (
          <p className="m-0 text-meta text-text-tertiary">
            Este contato ainda não tem oportunidade ao seu alcance.
          </p>
        ) : (
          <>
            <ul className="m-0 flex list-none flex-col gap-1.5 p-0" aria-label="Casos do contato">
              {cases.items.map((o) => {
                const selected = o.opportunityId === context.focusId;
                return (
                  <li key={o.opportunityId}>
                    <Link
                      href={inboxHref(conversation.id, { ...params, caso: o.opportunityId }, { keepCase: true }) as never}
                      aria-current={selected ? "true" : undefined}
                      className={cn(
                        "flex items-center gap-2.5 rounded-input border px-3 py-2 no-underline transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-ring",
                        selected
                          ? "border-primary-border bg-primary-tint"
                          : "border-border bg-surface-subtle hover:bg-surface-hover",
                      )}
                    >
                      <Briefcase size={15} className="shrink-0 text-text-muted" aria-hidden />
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate text-small font-semibold text-text">{o.legalArea ?? "Oportunidade"}</span>
                        <span className="truncate text-meta text-text-tertiary">
                          {o.stageName}
                          {o.isLinked ? " · vínculo da conversa" : ""}
                        </span>
                      </span>
                      <span className={cn("shrink-0 rounded-full px-2 py-0.5 text-label font-bold", OPPORTUNITY_STATUS_CLASS[o.status])}>
                        {OPPORTUNITY_STATUS_LABEL[o.status]}
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
            {cases.items.length > 1 ? (
              <p className="m-0 text-meta text-text-tertiary">
                Escolher um caso muda só o que este painel mostra: as mensagens e as evidências não são transferidas.
              </p>
            ) : null}
          </>
        )}

        {!focus && cases.items.length > 1 ? (
          <p className="m-0 rounded-input border border-dashed border-border px-3 py-3 text-meta text-text-tertiary">
            Este contato tem {cases.items.length} oportunidades e a conversa não está ligada a nenhuma delas. Escolha um
            caso acima para ver a etapa e o andamento.
          </p>
        ) : null}

        {focus ? (
          <div className="flex flex-col gap-4">
            <dl className="m-0 rounded-input border border-border bg-surface-subtle px-3 py-1">
              <Row label="Etapa comercial">{focus.option.stageName}</Row>
              <Row label="Situação da oportunidade">{OPPORTUNITY_STATUS_LABEL[focus.option.status]}</Row>
              {focus.responsible ? <Row label="Responsável">{focus.responsible}</Row> : null}
              {focus.valueLabel ? <Row label="Valor">{focus.valueLabel}</Row> : null}
              {focus.nextAction ? (
                <Row label="Próxima ação">
                  {focus.nextAction.title}
                  <span className="block text-meta font-normal text-text-tertiary">
                    {formatDue(focus.nextAction.dueAt, focus.nextAction.hasTime)}
                  </span>
                </Row>
              ) : null}
              <Row label="Aberta em">{formatDate(focus.option.createdAt)}</Row>
            </dl>

            {focus.option.status === "open" ? (
              <AutomationControl
                track="commercial_stage"
                targetId={focus.option.opportunityId}
                paused={focus.commercial.state.automationPaused}
                pausedAt={focus.commercial.state.automationPausedAt}
                pausedByName={focus.commercial.state.automationPausedByName}
                version={focus.commercial.state.version}
                canEdit={permissions.pauseCommercial}
                deniedReason="Seu perfil não altera as alterações automáticas da etapa comercial."
              />
            ) : null}

            {focus.progress ? (
              <div className="flex flex-col gap-3">
                <div className="flex flex-col gap-1.5">
                  <h4 className="m-0 text-small font-bold text-text">Andamento do serviço</h4>
                  {(() => {
                    const s = (focus.progress.state.status ?? "nao_informado") as CaseProgressStatus;
                    return (
                      <>
                        <StatusChip label={CASE_PROGRESS_STATUS_LABEL[s]} className={CASE_PROGRESS_STATUS_CLASS[s]} />
                        {s === "nao_informado" ? (
                          <p className="m-0 text-meta text-text-tertiary">
                            Ainda sem registro de andamento para este caso. Nada foi inferido.
                          </p>
                        ) : focus.progress.state.manualDecidedAt ? (
                          <p className="m-0 text-meta text-text-tertiary">
                            Última decisão manual em {formatStamp(focus.progress.state.manualDecidedAt)}.
                          </p>
                        ) : null}
                      </>
                    );
                  })()}
                </div>
                {permissions.editProgress ? (
                  <TrackStatusEditor
                    kind="case_progress"
                    targetId={focus.option.opportunityId}
                    current={focus.progress.state.status}
                    version={focus.progress.state.version}
                    options={PROGRESS_OPTIONS}
                    evidence={evidence}
                    fieldLabel="Corrigir andamento"
                  />
                ) : (
                  <p className="m-0 text-meta text-text-tertiary">
                    Seu perfil não altera o andamento do caso. Alterar a situação do atendimento não muda o andamento.
                  </p>
                )}
                <AutomationControl
                  track="case_progress"
                  targetId={focus.option.opportunityId}
                  paused={focus.progress.state.automationPaused}
                  pausedAt={focus.progress.state.automationPausedAt}
                  pausedByName={focus.progress.state.automationPausedByName}
                  version={focus.progress.state.version}
                  canEdit={permissions.editProgress}
                  deniedReason="Seu perfil não altera as alterações automáticas do andamento do caso."
                />
              </div>
            ) : (
              <p className="m-0 text-meta text-text-tertiary">
                O andamento do serviço só existe para oportunidade ganha. {focus.option.status === "open" ? "Esta ainda está aberta." : "Esta foi perdida."}
              </p>
            )}
          </div>
        ) : null}
      </Section>

      <Section title="Histórico" hint="Alterações humanas registradas, com as referências das mensagens de evidência.">
        <HistoryTimeline
          key={sources.map((s) => `${s.track}:${s.targetId}:${s.page.items[0]?.id ?? "-"}`).join("|")}
          sources={sources}
          currentConversationId={conversation.id}
        />
      </Section>
    </TrackBusyProvider>
  );
}
