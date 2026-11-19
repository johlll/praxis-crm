import type { ReactNode } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  Briefcase,
  CalendarClock,
  CalendarDays,
  FileSignature,
  FileText,
  Hash,
  Info,
  ListChecks,
  Layers,
  Link2,
  Pencil,
  Scale,
  Trophy,
  TriangleAlert,
  User,
  UserCheck,
  Wallet,
  Workflow,
  X,
  XCircle,
} from "lucide-react";

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
} from "@/modules/status-tracks/schema";
import type { ConversationContext, FocusCase } from "@/modules/conversations/context";
import { inboxHref, type InboxParams } from "@/modules/conversations/inbox";
import {
  caseHistoryExtras,
  formatStamp,
  type EvidenceCandidate,
} from "@/modules/conversations/context-format";
import {
  CASE_TABS,
  CASE_TAB_LABEL,
  caseBadge,
  caseChipLabel,
  caseCountLabel,
  caseIdentity,
  caseOpenedLine,
  focusNote,
} from "@/modules/conversations/case-display";
import { formatCaseNumber, serviceProgressCounts, serviceStepItems } from "@/modules/case-service/schema";
import { ActivitiesSection } from "@/components/activities/activities-section";
import { ACTIVITY_TYPE_LABEL } from "@/components/activities/labels";
import { LinkPending } from "./link-pending";
import { TrackStatusEditor } from "./context/status-editor";
import { AutomationControl } from "./context/automation-control";
import { HistoryTimeline, type TimelineSource } from "./context/history-timeline";
import { ContextRetryButton } from "./context/retry-button";
import { TrackBusyProvider } from "./context/track-busy";
import { AttendanceChip, CaseBadgeChip } from "./context/case-badge";
import { CaseStepper } from "./context/case-stepper";
import { CaseSwitcher } from "./context/case-switcher";
import { ConsentDisclosure } from "./context/consent-disclosure";
import { ServiceStepper } from "./context/service-stepper";
import { CaseNumberControl, ServicePlanEditor } from "./context/service-plan-editor";
import { CaseNoteComposer, CaseNotesList, CaseNotesUnavailable } from "./context/case-notes";

const ATTENDANCE_OPTIONS = ATTENDANCE_STATUSES.filter((s) => s !== "nao_informado").map((s) => ({
  value: s,
  label: ATTENDANCE_STATUS_LABEL[s],
}));
const PROGRESS_OPTIONS = CASE_PROGRESS_STATUSES.filter((s) => s !== "nao_informado").map((s) => ({
  value: s,
  label: CASE_PROGRESS_STATUS_LABEL[s],
}));

/** Próximas ações mostradas no Resumo (as demais ficam na aba Tarefas). */
const NEXT_ACTIONS_IN_SUMMARY = 3;

export type ContextPermissions = {
  /** conversation.attendance_edit — corrige a situação do atendimento e pausa as alterações automáticas dela. */
  editAttendance: boolean;
  /** case.progress_edit — corrige o andamento jurídico do serviço e pausa as alterações automáticas dele. */
  editProgress: boolean;
  /** opportunity.edit — pausa as alterações automáticas da etapa comercial. */
  pauseCommercial: boolean;
  /** activity.edit (e contato não anonimizado) — cria e altera tarefas na aba Tarefas. */
  editActivities?: boolean;
  /** case.number_assign (e contato não anonimizado) — atribui o número interno a um caso sem número. */
  assignCaseNumber?: boolean;
  /** service_catalog.manage — atalho para o catálogo quando ele está vazio. */
  manageServiceCatalog?: boolean;
  /** case_note.add (e contato não anonimizado) — acrescenta observações ao caso, pela edição (lápis). */
  addCaseNote?: boolean;
};

type PanelConversation = {
  id: string;
  contactId: string | null;
  contactName: string | null;
  waId: string;
  leadId: string | null;
  legalArea: string | null;
  needsLinkReview: boolean;
};

/** "2026-03-12" (coluna `date`) → "12/03/2026", sem passar por fuso (evita virar o dia anterior). */
function formatDateOnly(d: string): string {
  const [y, m, day] = d.slice(0, 10).split("-");
  return y && m && day ? `${day}/${m}/${y}` : d;
}

function Card({
  title,
  icon: Icon,
  action,
  children,
  className,
}: {
  title: string;
  icon?: typeof User;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section aria-label={title} className={cn("flex flex-col gap-3 rounded-card border border-border bg-surface p-3.5", className)}>
      <div className="flex items-center justify-between gap-2">
        <h3 className="m-0 flex items-center gap-2 text-body font-bold text-text">
          {Icon ? <Icon size={16} className="shrink-0 text-text-muted" aria-hidden /> : null}
          {title}
        </h3>
        {action}
      </div>
      {children}
    </section>
  );
}

function InfoRow({ icon: Icon, label, children }: { icon: typeof User; label: string; children: ReactNode }) {
  return (
    <div className="flex items-start gap-2.5 border-b border-border-subtle py-2 first:pt-0 last:border-b-0 last:pb-0">
      <Icon size={15} className="mt-0.5 shrink-0 text-text-muted" aria-hidden />
      <dt className="w-[92px] shrink-0 text-meta text-text-tertiary">{label}</dt>
      <dd className="m-0 min-w-0 flex-1 text-small font-semibold text-text [overflow-wrap:anywhere]">{children}</dd>
    </div>
  );
}

function Muted({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cn("m-0 text-meta text-text-tertiary", className)}>{children}</p>;
}

/**
 * Painel do caso na conversa (Conversas + IA). Organização da referência: cabeçalho compacto do caso
 * (assunto, abertura, selo e lápis), abas Resumo · Tarefas · Histórico e o Resumo em cartões. Os
 * formulários (correção de situação e andamento, pausas) ficam na EDIÇÃO aberta pelo lápis, nunca expostos
 * na consulta. Só aparece o que o sistema tem e o papel alcança: nada de código de caso, tipo de serviço,
 * número de processo, protocolo, sentença, documentos ou observações inventados.
 */
export function ConversationContextPanel({
  conversation,
  context,
  contextFailed,
  params,
  permissions,
  evidence,
  consentSlot,
  consentNeedsAttention = false,
}: {
  conversation: PanelConversation;
  context: ConversationContext | null;
  contextFailed: boolean;
  params: InboxParams;
  permissions: ContextPermissions;
  evidence: EvidenceCandidate[];
  consentSlot: ReactNode;
  /** Sem consentimento vigente: a seção de consentimento já vem aberta. */
  consentNeedsAttention?: boolean;
}) {
  if (contextFailed || !context) {
    return (
      <div className="flex flex-col gap-3 p-4">
        <ContactCard conversation={conversation} />
        <div role="alert" className="flex flex-col gap-2 rounded-card border border-danger/25 bg-danger-bg px-3.5 py-3">
          <p className="m-0 flex items-center gap-2 text-small font-semibold text-text">
            <TriangleAlert size={14} className="text-danger" aria-hidden />
            {contextFailed ? "Não foi possível carregar o caso" : "Caso indisponível"}
          </p>
          <p className="m-0 text-meta text-text-secondary">
            {contextFailed
              ? "A conversa e as mensagens continuam funcionando. Tente novamente em instantes."
              : "Você não tem acesso às informações de situação e caso desta conversa."}
          </p>
          {contextFailed ? <ContextRetryButton /> : null}
        </div>
        <ConsentDisclosure defaultOpen={consentNeedsAttention}>{consentSlot}</ConsentDisclosure>
      </div>
    );
  }

  const { focus } = context;
  const status = focus?.option.status ?? null;
  const canAssignNumber = Boolean(focus && !focus.service.caseNumber && status !== "lost" && permissions.assignCaseNumber);
  const canEditAny =
    permissions.editAttendance ||
    (status === "won" && permissions.editProgress) ||
    (status === "open" && permissions.pauseCommercial) ||
    canAssignNumber ||
    Boolean(focus && permissions.addCaseNote);
  const editing = params.editar && canEditAny;
  const hrefWith = (over: Partial<InboxParams>) => inboxHref(conversation.id, { ...params, ...over }, { keepCase: true });

  return (
    <div className="flex flex-col">
      <CaseHeader
        conversation={conversation}
        context={context}
        params={params}
        editing={editing}
        editHref={canEditAny ? hrefWith({ editar: !editing }) : null}
      />

      {editing ? (
        <CaseEdit
          conversation={conversation}
          context={context}
          permissions={permissions}
          evidence={evidence}
          closeHref={hrefWith({ editar: false })}
        />
      ) : (
        <>
          <nav aria-label="Seções do caso" className="mt-3 border-b border-border px-4">
            <ul className="m-0 flex list-none gap-5 p-0">
              {CASE_TABS.map((t) => {
                const active = params.aba === t;
                const count = t === "tarefas" && focus ? focus.pendingActivities.length : 0;
                return (
                  <li key={t}>
                    <Link
                      href={hrefWith({ aba: t, editar: false }) as never}
                      aria-current={active ? "page" : undefined}
                      className={cn(
                        "-mb-px inline-flex h-10 items-center gap-1.5 border-b-2 text-small font-semibold no-underline transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary-ring",
                        active ? "border-primary text-primary" : "border-transparent text-text-tertiary hover:text-text",
                      )}
                    >
                      {CASE_TAB_LABEL[t]}
                      {count > 0 ? (
                        <span className="rounded-full bg-surface-muted px-1.5 text-label font-bold tabular-nums text-text-secondary">
                          {count}
                          <span className="sr-only"> pendentes</span>
                        </span>
                      ) : null}
                      <LinkPending />
                    </Link>
                  </li>
                );
              })}
            </ul>
          </nav>

          <div className="flex flex-col gap-3 p-4">
            {params.aba === "tarefas" ? (
              <CaseTasks conversation={conversation} context={context} canEdit={permissions.editActivities === true} params={params} />
            ) : params.aba === "historico" ? (
              <CaseHistory conversation={conversation} context={context} />
            ) : (
              <CaseSummary
                conversation={conversation}
                context={context}
                params={params}
                consentSlot={consentSlot}
                consentNeedsAttention={consentNeedsAttention}
                writeNoteHref={permissions.addCaseNote ? `${hrefWith({ editar: true })}#observacoes` : null}
              />
            )}
          </div>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------
// Cabeçalho
// ---------------------------------------------------------------------

function CaseHeader({
  conversation,
  context,
  params,
  editing,
  editHref,
}: {
  conversation: PanelConversation;
  context: ConversationContext;
  params: InboxParams;
  editing: boolean;
  editHref: string | null;
}) {
  const { cases, focus } = context;
  const n = cases.items.length;
  const switcherOptions = cases.items.map((o) => {
    const id = caseIdentity(o, cases.items);
    return {
      id: o.opportunityId,
      href: inboxHref(conversation.id, { ...params, caso: o.opportunityId }, { keepCase: true }),
      title: caseChipLabel(o),
      openedLine: caseOpenedLine(id),
      badge: caseBadge(o),
      isLinked: o.isLinked,
      selected: o.opportunityId === context.focusId,
    };
  });

  const pencil = editHref ? (
    <Link
      href={editHref as never}
      aria-label={editing ? "Fechar a edição" : "Editar situação e andamento"}
      title={editing ? "Fechar a edição" : "Editar situação e andamento"}
      className={cn(
        "flex size-8 shrink-0 items-center justify-center rounded-md border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-ring",
        editing ? "border-primary-border bg-primary-tint text-primary" : "border-border text-text-secondary hover:bg-surface-hover hover:text-text",
      )}
    >
      {editing ? <X size={15} aria-hidden /> : <Pencil size={15} aria-hidden />}
    </Link>
  ) : null;

  let identityBlock: ReactNode;
  if (focus) {
    const id = caseIdentity(focus.option, cases.items);
    const plan = focus.service.plan;
    // Com número: "Caso #0042" e, abaixo, tipo de serviço · área (como na referência). Sem número: a área é o título.
    const subtitle = id.number
      ? [plan?.serviceTypeName, id.subject].filter(Boolean).join(" · ")
      : (plan?.serviceTypeName ?? null);
    identityBlock = (
      <>
        <span className="flex size-11 shrink-0 items-center justify-center rounded-input bg-primary-tint text-primary" aria-hidden>
          <Briefcase size={20} />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <h3 className="m-0 text-body font-bold leading-snug text-text [overflow-wrap:anywhere]">
            {id.number ? <span className="sr-only">Número interno do caso: </span> : null}
            {id.title}
          </h3>
          {subtitle ? <p className="m-0 text-meta font-semibold text-text-secondary [overflow-wrap:anywhere]">{subtitle}</p> : null}
          <p className="m-0 text-meta text-text-tertiary">{caseOpenedLine(id)}</p>
          <div className="flex min-w-0 flex-wrap gap-1">
            <CaseBadgeChip badge={caseBadge(focus.option)} wrap />
          </div>
        </div>
      </>
    );
  } else {
    const title = !cases.contactResolved ? "Sem contato vinculado" : n === 0 ? "Nenhum caso" : `${caseCountLabel(n)} deste contato`;
    const hint = !cases.contactResolved
      ? "Sem contato não há caso para mostrar."
      : n === 0
        ? "Este contato não tem oportunidade ao seu alcance."
        : "Nenhum deles está vinculado a esta conversa. Escolha qual mostrar.";
    identityBlock = (
      <>
        <span className="flex size-11 shrink-0 items-center justify-center rounded-input bg-surface-muted text-text-muted" aria-hidden>
          {n > 1 ? <Layers size={20} /> : <Briefcase size={20} />}
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <h3 className="m-0 text-body font-bold text-text">{title}</h3>
          <p className="m-0 text-meta text-text-tertiary">{hint}</p>
        </div>
      </>
    );
  }

  const note = focus && context.focusSource ? focusNote(context.focusSource, focus.option.opportunityId, cases.linkedOpportunityId) : null;

  return (
    <div className="flex flex-col gap-2 px-4 pt-4">
      {context.invalidCaseRequested ? (
        <p role="status" className="m-0 rounded-input border border-warning/25 bg-warning-bg px-3 py-2 text-meta text-warning">
          O caso pedido no endereço não pertence a este contato ou não está ao seu alcance. Mostrando o caso padrão.
        </p>
      ) : null}

      <div className="flex items-start gap-3 rounded-card border border-border bg-surface-subtle p-3">
        {identityBlock}
        {pencil}
      </div>

      {note || n > 1 ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          {note ? (
            <p className={cn("m-0 flex min-w-0 flex-1 items-start gap-1.5 text-meta", note.tone === "differs" ? "text-warning" : "text-text-tertiary")}>
              {note.tone === "differs" ? <Info size={13} className="mt-px shrink-0" aria-hidden /> : <Link2 size={13} className="mt-px shrink-0" aria-hidden />}
              <span>
                {note.text}
                {note.linkedId ? (
                  <>
                    {" "}
                    <Link
                      href={inboxHref(conversation.id, { ...params, caso: note.linkedId }, { keepCase: true }) as never}
                      className="font-semibold text-primary hover:underline"
                    >
                      Ver o caso vinculado
                    </Link>
                  </>
                ) : null}
              </span>
            </p>
          ) : (
            <span />
          )}
          {n > 1 ? <CaseSwitcher options={switcherOptions} label={focus ? `Trocar caso (${n})` : `Escolher caso (${n})`} /> : null}
        </div>
      ) : null}

      {!cases.contactResolved && conversation.needsLinkReview ? (
        <a href="#revisao-vinculo" className="text-meta font-semibold text-primary hover:underline">
          Resolver na revisão de vínculo
        </a>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------
// Resumo
// ---------------------------------------------------------------------

function ContactCard({ conversation }: { conversation: PanelConversation }) {
  const name = conversation.contactName ?? "Contato a definir";
  return (
    <Card title="Contato">
      <div className="flex items-center gap-3">
        <span aria-hidden className="flex size-10 shrink-0 items-center justify-center rounded-full bg-surface-muted text-body font-bold text-text-secondary">
          {conversation.contactName ? initialsOf(conversation.contactName) : "?"}
        </span>
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-body font-semibold text-text">{name}</span>
          <span className="truncate text-meta text-text-tertiary">
            {conversation.waId ? formatPhoneForDisplay(conversation.waId) : "Telefone não informado"}
          </span>
        </div>
      </div>
      {conversation.contactId || conversation.leadId ? (
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
      ) : null}
    </Card>
  );
}

function CaseChooser({ conversation, context, params }: { conversation: PanelConversation; context: ConversationContext; params: InboxParams }) {
  const { cases } = context;
  return (
    <Card title="Escolha o caso">
      <Muted>
        O cliente tem {cases.items.length} casos e esta conversa não está vinculada a nenhum. Nenhum andamento é atribuído ao
        cliente inteiro: escolha qual caso mostrar. A escolha muda só esta tela; o vínculo da conversa não muda.
      </Muted>
      <ul className="m-0 flex list-none flex-col gap-2 p-0" aria-label="Casos do contato">
        {cases.items.map((o) => {
          const id = caseIdentity(o, cases.items);
          return (
            <li key={o.opportunityId}>
              <Link
                href={inboxHref(conversation.id, { ...params, caso: o.opportunityId }, { keepCase: true }) as never}
                className="flex flex-col gap-1.5 rounded-input border border-border bg-surface-subtle px-3 py-2.5 no-underline transition-colors hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-ring"
              >
                <span className="text-small font-semibold text-text [overflow-wrap:anywhere]">{caseChipLabel(o)}</span>
                <span className="text-meta text-text-tertiary">{caseOpenedLine(id)}</span>
                <span className="flex flex-wrap gap-1">
                  <CaseBadgeChip badge={caseBadge(o)} className="w-fit" />
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

function CaseSummary({
  conversation,
  context,
  params,
  consentSlot,
  consentNeedsAttention,
  writeNoteHref,
}: {
  conversation: PanelConversation;
  context: ConversationContext;
  params: InboxParams;
  consentSlot: ReactNode;
  consentNeedsAttention: boolean;
  /** Edição com a seção de observações (só para quem acrescenta). O Resumo continua sendo consulta. */
  writeNoteHref: string | null;
}) {
  const { focus, cases } = context;
  if (!focus) {
    return (
      <>
        {cases.items.length > 1 ? <CaseChooser conversation={conversation} context={context} params={params} /> : null}
        <ContactCard conversation={conversation} />
        <ConsentDisclosure defaultOpen={consentNeedsAttention}>{consentSlot}</ConsentDisclosure>
      </>
    );
  }

  const o = focus.option;
  const pending = focus.pendingActivities;
  return (
    <>
      <Card title="Informações do caso">
        <dl className="m-0">
          <InfoRow icon={User} label="Cliente">
            {conversation.contactId ? (
              <Link href={`/contatos/${conversation.contactId}` as never} className="text-text hover:text-primary hover:underline">
                {conversation.contactName ?? "Contato"}
              </Link>
            ) : (
              (conversation.contactName ?? "Contato a definir")
            )}
          </InfoRow>
          <InfoRow icon={Hash} label="Nº interno">
            {focus.service.caseNumber ? (
              formatCaseNumber(focus.service.caseNumber.number)
            ) : (
              <span className="font-normal text-text-tertiary">Não atribuído</span>
            )}
          </InfoRow>
          {o.status === "won" ? (
            <InfoRow icon={ListChecks} label="Tipo de serviço">
              {focus.service.plan?.serviceTypeName ?? <span className="font-normal text-text-tertiary">Sem roteiro aplicado</span>}
            </InfoRow>
          ) : null}
          <InfoRow icon={Scale} label="Área">
            {o.legalArea ?? <span className="font-normal text-text-tertiary">Não informada</span>}
          </InfoRow>
          {o.status === "open" ? (
            <InfoRow icon={Workflow} label="Etapa comercial">
              {o.stageName}
            </InfoRow>
          ) : null}
          <InfoRow icon={UserCheck} label="Responsável">
            {focus.responsible ?? <span className="font-normal text-text-tertiary">Sem responsável</span>}
          </InfoRow>
          {focus.valueLabel ? (
            <InfoRow icon={Wallet} label="Valor">
              {focus.valueLabel}
            </InfoRow>
          ) : null}
          <InfoRow icon={CalendarDays} label="Aberta em">
            {formatDate(o.createdAt)}
          </InfoRow>
          {focus.wonAt ? (
            <InfoRow icon={Trophy} label="Ganha em">
              {formatDate(focus.wonAt)}
            </InfoRow>
          ) : null}
          {focus.signedAt ? (
            <InfoRow icon={FileSignature} label="Contrato assinado">
              {formatDateOnly(focus.signedAt)}
            </InfoRow>
          ) : null}
          {o.status === "lost" ? (
            <InfoRow icon={XCircle} label="Motivo da perda">
              {focus.lostReasonLabel ?? <span className="font-normal text-text-tertiary">Não informado</span>}
            </InfoRow>
          ) : null}
        </dl>
        <Link href={`/oportunidades/${o.opportunityId}` as never} className="w-fit text-small font-semibold text-primary hover:underline">
          Abrir a oportunidade completa
        </Link>
      </Card>

      <ProgressCard focus={focus} />

      <Card
        title="Próximas ações"
        action={
          pending.length > 0 ? (
            <Link href={inboxHref(conversation.id, { ...params, aba: "tarefas", editar: false }, { keepCase: true }) as never} className="text-meta font-semibold text-primary hover:underline">
              Ver todas ({pending.length})
            </Link>
          ) : null
        }
      >
        {pending.length === 0 ? (
          <Muted>Nenhuma tarefa pendente vinculada a este caso.</Muted>
        ) : (
          <ul className="m-0 flex list-none flex-col p-0">
            {pending.slice(0, NEXT_ACTIONS_IN_SUMMARY).map((a) => (
              <li key={a.id} className="flex items-start gap-2.5 border-b border-border-subtle py-2 first:pt-0 last:border-b-0 last:pb-0">
                <CalendarClock size={15} className={cn("mt-0.5 shrink-0", a.isOverdue ? "text-danger" : "text-text-muted")} aria-hidden />
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="text-small font-semibold text-text [overflow-wrap:anywhere]">{a.title}</span>
                  <span className="text-meta text-text-tertiary">
                    {ACTIVITY_TYPE_LABEL[a.type]} · {a.assignedToName ?? "Sem responsável"}
                  </span>
                </div>
                <span className={cn("shrink-0 text-meta font-semibold", a.isOverdue ? "text-danger" : "text-text-secondary")}>
                  {formatDue(a.dueAt, a.hasTime)}
                  {a.isOverdue ? <span className="block text-right text-label">atrasada</span> : null}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card
        title="Observações"
        icon={FileText}
        action={
          writeNoteHref ? (
            <Link href={writeNoteHref as never} className="text-meta font-semibold text-primary hover:underline">
              Escrever
            </Link>
          ) : null
        }
      >
        <CaseNotesBlock focus={focus} />
      </Card>

      <ConsentDisclosure defaultOpen={consentNeedsAttention}>{consentSlot}</ConsentDisclosure>
    </>
  );
}

/** Observações do caso em foco: lista (com as anteriores por página), falha com nova tentativa ou vazio. */
function CaseNotesBlock({ focus }: { focus: FocusCase }) {
  const notes = focus.notes;
  if (!notes) return <Muted>As observações aparecem no Resumo do caso.</Muted>;
  if (notes.status === "error") return <CaseNotesUnavailable />;
  if (notes.status === "unavailable") return <Muted>As observações deste caso não estão disponíveis para o seu perfil.</Muted>;
  return (
    <CaseNotesList key={`case_note:${focus.option.opportunityId}`} opportunityId={focus.option.opportunityId} initial={notes.page} />
  );
}

function ProgressCard({ focus }: { focus: FocusCase }) {
  const o = focus.option;
  if (o.status === "open") {
    return (
      <Card title="Andamento comercial">
        {focus.steps ? (
          <CaseStepper steps={focus.steps} label={`Etapas comerciais${focus.pipelineName ? ` do funil ${focus.pipelineName}` : ""}`} />
        ) : (
          <CaseBadgeChip badge={caseBadge(o)} className="w-fit" />
        )}
        <Muted>
          Posição no funil{focus.pipelineName ? ` “${focus.pipelineName}”` : ""}. Etapas anteriores e seguintes são só a ordem do
          funil, não indicam conclusão. O andamento do serviço começa quando a oportunidade é ganha.
        </Muted>
      </Card>
    );
  }
  if (o.status === "lost") {
    return (
      <Card title="Andamento">
        <CaseBadgeChip badge={caseBadge(o)} className="w-fit" />
        <Muted>Oportunidade perdida: não há andamento de serviço.</Muted>
      </Card>
    );
  }
  const state = focus.progress?.state;
  const badge = caseBadge(o);
  const plan = focus.service.plan;
  const counts = plan ? serviceProgressCounts(plan) : null;
  return (
    <Card title="Andamento do serviço">
      <div className="flex flex-wrap items-center gap-2">
        <CaseBadgeChip badge={badge} className="w-fit" />
        {counts ? (
          <span className="text-meta text-text-tertiary">
            {counts.completed} de {counts.total} {counts.total === 1 ? "etapa concluída" : "etapas concluídas"}
          </span>
        ) : null}
      </div>
      {plan ? <ServiceStepper steps={serviceStepItems(plan)} label={`Etapas do roteiro ${plan.serviceTypeName}`} /> : null}
      {plan && counts ? (
        <Muted>
          {counts.current
            ? `Etapa atual: ${counts.current.name}.`
            : counts.completed === counts.total
              ? "Todas as etapas têm conclusão registrada."
              : "Nenhuma etapa atual definida."}{" "}
          Só aparecem como concluídas as etapas com conclusão registrada; a posição não conclui nada.
        </Muted>
      ) : null}
      {badge.progress === "nao_informado" ? (
        <Muted>Ainda sem registro de andamento para este caso. Nada foi inferido.</Muted>
      ) : state?.manualDecidedAt ? (
        <Muted>Última decisão manual em {formatStamp(state.manualDecidedAt)}.</Muted>
      ) : null}
      {!plan ? (
        <p className="m-0 flex items-start gap-1.5 rounded-input bg-surface-subtle px-3 py-2 text-meta text-text-tertiary">
          <Info size={13} className="mt-px shrink-0" aria-hidden />
          <span>
            Este caso não tem roteiro de etapas{focus.service.previousPlans > 0 ? " ativo (os anteriores estão no Histórico)" : ""}. O
            que aparece acima é o andamento registrado. Um roteiro só é aplicado por escolha, na edição do caso.
          </span>
        </p>
      ) : null}
    </Card>
  );
}

// ---------------------------------------------------------------------
// Tarefas
// ---------------------------------------------------------------------

function CaseTasks({
  conversation,
  context,
  canEdit,
  params,
}: {
  conversation: PanelConversation;
  context: ConversationContext;
  canEdit: boolean;
  params: InboxParams;
}) {
  const { focus } = context;
  if (!focus) {
    return context.cases.items.length > 1 ? (
      <CaseChooser conversation={conversation} context={context} params={params} />
    ) : (
      <Muted>Sem caso em foco não há tarefas vinculadas para mostrar.</Muted>
    );
  }
  const o = focus.option;
  const done = focus.doneActivities;
  return (
    <>
      <Muted>
        Só aparecem as atividades vinculadas a este caso. As do lead sem caso definido ficam{" "}
        <Link href={`/leads/${o.leadId}` as never} className="font-semibold text-primary hover:underline">
          na página do lead
        </Link>
        .
      </Muted>
      <ActivitiesSection
        leadId={o.leadId}
        opportunityId={o.opportunityId}
        activities={focus.pendingActivities}
        members={context.members}
        canEdit={canEdit}
        title="Pendentes"
        emptyText="Nenhuma tarefa pendente vinculada a este caso."
      />
      {done ? (
        <>
          <ActivitiesSection
            leadId={o.leadId}
            opportunityId={o.opportunityId}
            activities={done.items}
            members={context.members}
            canEdit={canEdit}
            allowCreate={false}
            title="Concluídas"
            emptyText="Nenhuma tarefa concluída vinculada a este caso."
          />
          {done.total > done.items.length ? (
            <Muted>
              Mostrando as {done.items.length} concluídas mais recentes de {done.total}.{" "}
              <Link href={`/oportunidades/${o.opportunityId}` as never} className="font-semibold text-primary hover:underline">
                Ver na oportunidade
              </Link>
            </Muted>
          ) : null}
        </>
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------------
// Histórico
// ---------------------------------------------------------------------

function CaseHistory({ conversation, context }: { conversation: PanelConversation; context: ConversationContext }) {
  const { attendance, focus } = context;
  const sources: TimelineSource[] = [{ track: "attendance", targetId: conversation.id, page: attendance.history }];
  if (focus) {
    if (focus.progress) sources.push({ track: "case_progress", targetId: focus.option.opportunityId, page: focus.progress.history });
    sources.push({ track: "commercial_stage", targetId: focus.option.opportunityId, page: focus.commercial.history });
  }
  const extra = focus
    ? caseHistoryExtras({
        opportunityId: focus.option.opportunityId,
        createdAt: focus.option.createdAt,
        wonAt: focus.wonAt,
        stageMoves: focus.stageMoves,
        caseNumber: focus.service.caseNumber,
      })
    : [];
  // O roteiro tem paginação própria no servidor (o botão "Mais antigos — roteiro do serviço").
  const service = focus?.serviceHistory ? { opportunityId: focus.option.opportunityId, page: focus.serviceHistory } : null;
  return (
    <>
      <Muted>
        {focus
          ? "Mudanças de andamento, do roteiro do serviço e da etapa comercial, pausas das alterações automáticas, a situação do atendimento desta conversa e os marcos da oportunidade. Cada evento aparece uma vez, da fonte que o registra."
          : "Sem caso em foco, aparece só a situação do atendimento desta conversa."}
      </Muted>
      <HistoryTimeline
        key={[
          ...sources.map((s) => `${s.track}:${s.targetId}:${s.page.items[0]?.id ?? "-"}`),
          `service:${service?.opportunityId ?? "-"}:${service?.page.items[0]?.id ?? "-"}`,
          extra.length,
        ].join("|")}
        sources={sources}
        currentConversationId={conversation.id}
        extra={extra}
        service={service}
      />
      {conversation.leadId ? (
        <Muted>
          Propostas, notas e mensagens continuam na{" "}
          <Link href={`/leads/${conversation.leadId}` as never} className="font-semibold text-primary hover:underline">
            linha do tempo do lead
          </Link>
          .
        </Muted>
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------------
// Edição (lápis)
// ---------------------------------------------------------------------

function EditSection({ title, hint, id, children }: { title: string; hint?: string | undefined; id?: string; children: ReactNode }) {
  return (
    <section id={id} aria-label={title} className="flex scroll-mt-4 flex-col gap-3 rounded-card border border-border bg-surface p-3.5">
      <div className="flex flex-col gap-0.5">
        <h3 className="m-0 text-body font-bold text-text">{title}</h3>
        {hint ? <Muted>{hint}</Muted> : null}
      </div>
      {children}
    </section>
  );
}

function CaseEdit({
  conversation,
  context,
  permissions,
  evidence,
  closeHref,
}: {
  conversation: PanelConversation;
  context: ConversationContext;
  permissions: ContextPermissions;
  evidence: EvidenceCandidate[];
  closeHref: string;
}) {
  const { attendance, focus } = context;
  const attStatus = (attendance.state.status ?? "nao_informado") as AttendanceStatus;
  const o = focus?.option ?? null;

  return (
    <TrackBusyProvider>
      <div className="flex flex-col gap-3 p-4">
        <div className="flex items-center justify-between gap-2">
          <h3 className="m-0 text-body font-bold text-text">Editar o caso e o atendimento</h3>
          <Link href={closeHref as never} className="inline-flex items-center gap-1 text-small font-semibold text-primary hover:underline">
            <ArrowLeft size={14} aria-hidden />
            Voltar ao caso
          </Link>
        </div>

        {o ? (
          <EditSection title="Identificação do caso" hint="Número interno do escritório, separado de qualquer número de processo.">
            {focus?.service.caseNumber ? (
              <Muted>
                Número interno{" "}
                <span className="font-semibold text-text-secondary">{formatCaseNumber(focus.service.caseNumber.number)}</span>,
                atribuído em {formatStamp(focus.service.caseNumber.assignedAt)}
                {focus.service.caseNumber.assignedVia === "win" ? " no ganho da oportunidade" : ""}. O número não muda.
              </Muted>
            ) : (
              <CaseNumberControl
                opportunityId={o.opportunityId}
                canAssign={permissions.assignCaseNumber === true}
                closed={o.status === "lost"}
              />
            )}
          </EditSection>
        ) : null}

        {focus && o ? (
          <EditSection
            title="Observações do caso"
            hint="Pertencem a este caso, não ao contato: outro caso do mesmo cliente tem as suas. As notas gerais do lead continuam no perfil do lead."
            id="observacoes"
          >
            {permissions.addCaseNote ? (
              <CaseNoteComposer
                key={`case_note:${o.opportunityId}`}
                opportunityId={o.opportunityId}
                caseLabel={caseChipLabel(o)}
              />
            ) : (
              <Muted>Seu perfil só lê as observações deste caso.</Muted>
            )}
            <CaseNotesBlock focus={focus} />
          </EditSection>
        ) : null}

        <EditSection title="Situação do atendimento" hint="Pertence a esta conversa, não ao caso.">
          <div className="flex flex-col gap-1.5">
            <AttendanceChip status={attStatus} className="w-fit" />
            {attStatus === "nao_informado" ? (
              <Muted>Ainda sem registro de situação. Nada foi inferido para conversas anteriores.</Muted>
            ) : attendance.state.manualDecidedAt ? (
              <Muted>Última decisão manual em {formatStamp(attendance.state.manualDecidedAt)}.</Muted>
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
            <Muted>Seu perfil só visualiza a situação do atendimento.</Muted>
          )}
        </EditSection>

        <EditSection title="Andamento do serviço" hint={o ? "Pertence ao caso mostrado." : undefined}>
          {!o ? (
            <Muted>Escolha um caso para ver e corrigir o andamento.</Muted>
          ) : o.status !== "won" || !focus?.progress ? (
            <Muted>
              O andamento do serviço só existe para oportunidade ganha. {o.status === "open" ? "Esta ainda está aberta." : "Esta foi perdida."}
            </Muted>
          ) : (
            <>
              <div className="flex flex-col gap-1.5">
                <CaseBadgeChip badge={caseBadge(o)} className="w-fit" />
                {focus.progress.state.manualDecidedAt ? (
                  <Muted>Última decisão manual em {formatStamp(focus.progress.state.manualDecidedAt)}.</Muted>
                ) : null}
              </div>
              {permissions.editProgress ? (
                <TrackStatusEditor
                  kind="case_progress"
                  targetId={o.opportunityId}
                  current={focus.progress.state.status}
                  version={focus.progress.state.version}
                  options={PROGRESS_OPTIONS}
                  evidence={evidence}
                  fieldLabel="Corrigir andamento"
                />
              ) : (
                <Muted>Seu perfil não altera o andamento do caso. Alterar a situação do atendimento não muda o andamento.</Muted>
              )}
              {focus.service.plan ? (
                <Muted>
                  “Concluído” só é aceito com todas as etapas do roteiro concluídas. Aguardar informações (aguardando documentos,
                  cliente ou terceiros) não mexe no roteiro.
                </Muted>
              ) : null}
            </>
          )}
        </EditSection>

        {focus && o?.status === "won" ? (
          <EditSection
            title="Roteiro do serviço"
            hint="Etapas copiadas do tipo de serviço para este caso, com a etapa atual e as conclusões registradas."
          >
            <ServicePlanEditor
              opportunityId={o.opportunityId}
              service={focus.service}
              serviceTypes={focus.serviceTypes}
              canEdit={permissions.editProgress}
              canManageCatalog={permissions.manageServiceCatalog === true}
            />
          </EditSection>
        ) : null}

        {o ? (
          <EditSection title="Etapa comercial" hint="A etapa muda pelo Pipeline, onde fica o histórico canônico das movimentações.">
            {o.status === "open" ? (
              <CaseBadgeChip badge={caseBadge(o)} className="w-fit" wrap />
            ) : (
              <Muted>
                Última etapa: <span className="font-semibold text-text-secondary">{o.stageName}</span>. Oportunidade{" "}
                {o.status === "won" ? "ganha" : "perdida"}: a etapa comercial não muda mais.
              </Muted>
            )}
            <div className="flex flex-wrap gap-3">
              <Link href="/pipeline" className="text-small font-semibold text-primary hover:underline">
                Abrir o Pipeline
              </Link>
              <Link href={`/oportunidades/${o.opportunityId}` as never} className="text-small font-semibold text-primary hover:underline">
                Abrir a oportunidade
              </Link>
            </div>
          </EditSection>
        ) : null}

        <EditSection
          title="Alterações automáticas de status"
          hint="A automação de status ainda não foi ativada: nenhuma situação ou andamento muda sozinho. Pausar vale só para as futuras alterações automáticas de cada status; não pausa nem retoma o bot de atendimento e não impede a correção manual."
        >
          <AutomationControl
            track="attendance"
            targetId={conversation.id}
            paused={attendance.state.automationPaused}
            pausedAt={attendance.state.automationPausedAt}
            pausedByName={attendance.state.automationPausedByName}
            version={attendance.state.version}
            canEdit={permissions.editAttendance}
            deniedReason="Seu perfil não altera as alterações automáticas da situação do atendimento."
            heading="Situação do atendimento"
          />
          {focus && o?.status === "won" && focus.progress ? (
            <AutomationControl
              track="case_progress"
              targetId={o.opportunityId}
              paused={focus.progress.state.automationPaused}
              pausedAt={focus.progress.state.automationPausedAt}
              pausedByName={focus.progress.state.automationPausedByName}
              version={focus.progress.state.version}
              canEdit={permissions.editProgress}
              deniedReason="Seu perfil não altera as alterações automáticas do andamento do caso."
              heading="Andamento do serviço"
            />
          ) : null}
          {focus && o?.status === "open" ? (
            <AutomationControl
              track="commercial_stage"
              targetId={o.opportunityId}
              paused={focus.commercial.state.automationPaused}
              pausedAt={focus.commercial.state.automationPausedAt}
              pausedByName={focus.commercial.state.automationPausedByName}
              version={focus.commercial.state.version}
              canEdit={permissions.pauseCommercial}
              deniedReason="Seu perfil não altera as alterações automáticas da etapa comercial."
              heading="Etapa comercial"
            />
          ) : null}
        </EditSection>
      </div>
    </TrackBusyProvider>
  );
}
