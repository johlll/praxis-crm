"use client";

import { useActionState, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FormField, FormLabel } from "@/components/ui/form-field";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { EmptyState } from "@/components/feedback/empty-state";
import type { ProposalListItem } from "@/modules/proposals/queries";
import {
  createProposalAction,
  sendProposalAction,
  decideProposalAction,
  type ProposalActionState,
} from "@/modules/proposals/actions";
import {
  generateProposalDocumentAction,
  dispatchProposalEmailAction,
  type ProposalDocumentActionState,
  type SendProposalEmailActionState,
} from "@/modules/proposals/documents-actions";
import { FEE_MODELS, PROPOSAL_CHANNELS } from "@/modules/proposals/schema";
import type { ProposalDocumentListItem, ProposalEmailSendListItem } from "@/modules/proposals/documents-queries";

const FEE_MODEL_LABEL: Record<(typeof FEE_MODELS)[number], string> = {
  fixed: "Fixo",
  contingency: "Êxito",
  fixed_contingency: "Fixo + êxito",
};

const CHANNEL_LABEL: Record<(typeof PROPOSAL_CHANNELS)[number], string> = {
  email: "E-mail",
  whatsapp: "WhatsApp",
};

const STATUS_LABEL: Record<ProposalListItem["status"], string> = {
  rascunho: "Rascunho",
  enviada: "Aguardando retorno",
  aceita: "Aceita",
  recusada: "Recusada",
};

const DOCUMENT_STATUS_LABEL: Record<ProposalDocumentListItem["status"], string> = {
  pending: "Gerando…",
  ready: "Pronto",
  failed: "Falhou",
};

function formatValue(proposal: ProposalListItem): string {
  if (proposal.valueCents !== undefined) {
    return (proposal.valueCents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
  }
  return proposal.valueBand ?? "—";
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
}

const INITIAL: ProposalActionState = { ok: false };
const DOCUMENT_INITIAL: ProposalDocumentActionState = { ok: false };
const EMAIL_INITIAL: SendProposalEmailActionState = { ok: false };

function CreateProposalDialog({ leadId, opportunityId }: { leadId: string; opportunityId: string }) {
  const [open, setOpen] = useState(false);
  const [instanceKey, setInstanceKey] = useState(0);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setInstanceKey((k) => k + 1);
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm">Nova proposta</Button>
      </DialogTrigger>
      <CreateProposalDialogBody
        key={instanceKey}
        leadId={leadId}
        opportunityId={opportunityId}
        onDone={() => setOpen(false)}
      />
    </Dialog>
  );
}

function CreateProposalDialogBody({
  leadId,
  opportunityId,
  onDone,
}: {
  leadId: string;
  opportunityId: string;
  onDone: () => void;
}) {
  const [valueReais, setValueReais] = useState("");
  const action = createProposalAction.bind(null, leadId);
  const [state, formAction, pending] = useActionState(action, INITIAL);

  const valueCents = Math.round((Number(valueReais.replace(",", ".")) || 0) * 100);

  if (state.ok) {
    return (
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Proposta criada</DialogTitle>
        </DialogHeader>
        <Alert variant="success">
          <AlertDescription>A proposta já aparece na lista.</AlertDescription>
        </Alert>
        <DialogFooter>
          <Button type="button" onClick={onDone}>
            Concluir
          </Button>
        </DialogFooter>
      </DialogContent>
    );
  }

  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Nova proposta</DialogTitle>
      </DialogHeader>
      <form action={formAction} className="flex flex-col gap-4">
        <input type="hidden" name="opportunityId" value={opportunityId} />
        <input type="hidden" name="valueCents" value={valueCents} />
        <FormField>
          <FormLabel htmlFor="proposal-value">Valor (R$)</FormLabel>
          <Input
            id="proposal-value"
            type="number"
            min="0"
            step="0.01"
            required
            value={valueReais}
            onChange={(e) => setValueReais(e.target.value)}
          />
        </FormField>
        <FormField>
          <FormLabel htmlFor="proposal-fee-model">Modelo de honorários</FormLabel>
          <select
            id="proposal-fee-model"
            name="feeModel"
            defaultValue="fixed"
            className="h-9 rounded-input border border-border-input bg-surface px-3 text-body text-text"
          >
            {FEE_MODELS.map((m) => (
              <option key={m} value={m}>
                {FEE_MODEL_LABEL[m]}
              </option>
            ))}
          </select>
        </FormField>
        {state.error ? (
          <Alert variant="danger">
            <AlertDescription>{state.error}</AlertDescription>
          </Alert>
        ) : null}
        <DialogFooter>
          <Button type="submit" disabled={pending}>
            {pending ? "Criando…" : "Criar proposta"}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}

function SendProposalForm({ leadId, proposal }: { leadId: string; proposal: ProposalListItem }) {
  const action = sendProposalAction.bind(null, leadId);
  const [state, formAction, pending] = useActionState(action, INITIAL);
  return (
    <form action={formAction} className="flex flex-col gap-2">
      <input type="hidden" name="proposalId" value={proposal.id} />
      <input type="hidden" name="lockVersion" value={proposal.lockVersion} />
      {/* Registro de um envio feito por fora (WhatsApp, ou e-mail fora do
          CRM) — continua existindo do jeito que a A9 deixou, sem PDF
          nenhum envolvido. O envio REAL de e-mail com PDF anexado é outro
          fluxo, abaixo (SendEmailDialog, B1). */}
      <p className="text-meta text-text-tertiary">
        Já enviou por fora (WhatsApp, ou e-mail sem ser por aqui)? Registre o canal para liberar aceitar/recusar.
      </p>
      <div className="flex gap-3">
        {PROPOSAL_CHANNELS.map((c) => (
          <label key={c} className="flex items-center gap-1.5 text-meta text-text-secondary">
            <input type="checkbox" name="channels" value={c} defaultChecked={c === "whatsapp"} />
            {CHANNEL_LABEL[c]}
          </label>
        ))}
      </div>
      {state.error ? (
        <Alert variant="danger">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      ) : null}
      <Button type="submit" variant="secondary" size="sm" disabled={pending}>
        {pending ? "Registrando…" : "Registrar envio manual"}
      </Button>
    </form>
  );
}

function DecideProposalButton({
  leadId,
  proposal,
  decision,
  label,
}: {
  leadId: string;
  proposal: ProposalListItem;
  decision: "aceita" | "recusada";
  label: string;
}) {
  const action = decideProposalAction.bind(null, leadId);
  const [state, formAction, pending] = useActionState(action, INITIAL);
  return (
    <form action={formAction} className="inline-flex flex-col gap-1">
      <input type="hidden" name="proposalId" value={proposal.id} />
      <input type="hidden" name="lockVersion" value={proposal.lockVersion} />
      <input type="hidden" name="decision" value={decision} />
      <Button type="submit" variant="secondary" size="sm" disabled={pending}>
        {label}
      </Button>
      {state.error ? (
        <Alert variant="danger">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      ) : null}
    </form>
  );
}

function DecideProposalForm({ leadId, proposal }: { leadId: string; proposal: ProposalListItem }) {
  return (
    <div className="flex gap-2">
      <DecideProposalButton leadId={leadId} proposal={proposal} decision="aceita" label="Aceita" />
      <DecideProposalButton leadId={leadId} proposal={proposal} decision="recusada" label="Recusada" />
    </div>
  );
}

function GenerateDocumentButton({ leadId, proposalId }: { leadId: string; proposalId: string }) {
  const action = generateProposalDocumentAction.bind(null, leadId);
  const [state, formAction, pending] = useActionState(action, DOCUMENT_INITIAL);
  return (
    <form action={formAction} className="flex flex-col gap-1">
      <input type="hidden" name="proposalId" value={proposalId} />
      <Button type="submit" variant="secondary" size="sm" disabled={pending}>
        {pending ? "Gerando PDF…" : "Gerar PDF"}
      </Button>
      {state.error ? (
        <Alert variant="danger">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      ) : null}
    </form>
  );
}

function DocumentsList({ documents }: { documents: ProposalDocumentListItem[] }) {
  if (documents.length === 0) return null;
  return (
    <ul className="mt-2 flex flex-col gap-1">
      {documents.map((d) => (
        <li key={d.id} className="flex items-center gap-2 text-meta text-text-secondary">
          <span className="font-mono">v{d.version}</span>
          {d.status === "ready" && d.canDownload ? (
            <a
              href={`/api/proposals/documents/${d.id}/download`}
              target="_blank"
              rel="noreferrer"
              className="text-primary underline"
            >
              Baixar
            </a>
          ) : (
            <span>{DOCUMENT_STATUS_LABEL[d.status]}</span>
          )}
        </li>
      ))}
    </ul>
  );
}

function EmailSendsList({ emailSends }: { emailSends: ProposalEmailSendListItem[] }) {
  if (emailSends.length === 0) return null;
  return (
    <ul className="mt-2 flex flex-col gap-1">
      {emailSends.map((s) => (
        <li key={s.id} className="text-meta text-text-secondary">
          {s.status === "accepted" ? (
            // Nunca "entregue"/"enviado com sucesso": só provamos que o
            // Resend ACEITOU a mensagem, não que a caixa do cliente
            // recebeu (B1, correção 2).
            <>
              Aceito pelo provedor de e-mail para {s.toEmail}
              {s.resolvedAt ? ` em ${formatDateTime(s.resolvedAt)}` : ""}
            </>
          ) : s.status === "failed" ? (
            <>Falha ao enviar para {s.toEmail}. Tente novamente.</>
          ) : (
            <>Envio para {s.toEmail} em andamento…</>
          )}
        </li>
      ))}
    </ul>
  );
}

function SendEmailDialogBody({
  leadId,
  proposalId,
  documentId,
  contactEmails,
  onDone,
}: {
  leadId: string;
  proposalId: string;
  documentId: string;
  contactEmails: string[];
  onDone: () => void;
}) {
  // Gerado UMA vez por abertura do diálogo — reenviar o MESMO clique
  // (retry de formulário, duplo clique) usa a MESMA chave, então nunca
  // dispara um segundo envio real (B1, correção 1). Reabrir o diálogo
  // (nova intenção deliberada) remonta este componente via `key` no
  // dialog pai e gera uma chave nova.
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const action = dispatchProposalEmailAction.bind(null, leadId);
  const [state, formAction, pending] = useActionState(action, EMAIL_INITIAL);

  if (state.ok) {
    return (
      <DialogContent>
        <DialogHeader>
          <DialogTitle>E-mail enviado</DialogTitle>
        </DialogHeader>
        <Alert variant="success">
          <AlertDescription>
            {state.status === "accepted"
              ? "O provedor de e-mail aceitou a mensagem."
              : "O envio está em andamento."}
          </AlertDescription>
        </Alert>
        <DialogFooter>
          <Button type="button" onClick={onDone}>
            Concluir
          </Button>
        </DialogFooter>
      </DialogContent>
    );
  }

  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Enviar proposta por e-mail</DialogTitle>
      </DialogHeader>
      <form action={formAction} className="flex flex-col gap-4">
        <input type="hidden" name="proposalId" value={proposalId} />
        <input type="hidden" name="documentId" value={documentId} />
        <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
        <FormField>
          <FormLabel htmlFor="proposal-email-to">Destinatário</FormLabel>
          <select
            id="proposal-email-to"
            name="toEmail"
            required
            className="h-9 rounded-input border border-border-input bg-surface px-3 text-body text-text"
          >
            {contactEmails.map((email) => (
              <option key={email} value={email}>
                {email}
              </option>
            ))}
          </select>
        </FormField>
        <p className="text-meta text-text-tertiary">
          O PDF vai anexado. O CRM só registra &ldquo;aceito pelo provedor&rdquo; — não confirma que a caixa do cliente
          recebeu.
        </p>
        {state.error ? (
          <Alert variant="danger">
            <AlertDescription>{state.error}</AlertDescription>
          </Alert>
        ) : null}
        <DialogFooter>
          <Button type="submit" disabled={pending}>
            {pending ? "Enviando…" : "Enviar"}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}

function SendEmailDialog({
  leadId,
  proposalId,
  readyDocumentId,
  contactEmails,
  hasWorkspaceLegalProfile,
}: {
  leadId: string;
  proposalId: string;
  readyDocumentId: string | null;
  contactEmails: string[];
  hasWorkspaceLegalProfile: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [instanceKey, setInstanceKey] = useState(0);

  if (!readyDocumentId) {
    return <p className="text-meta text-text-tertiary">Gere o PDF antes de enviar por e-mail.</p>;
  }
  if (!hasWorkspaceLegalProfile) {
    return (
      <p className="text-meta text-text-tertiary">
        Preencha a razão social do escritório em Configurações para habilitar o envio real.
      </p>
    );
  }
  if (contactEmails.length === 0) {
    return <p className="text-meta text-text-tertiary">Este contato não tem e-mail cadastrado.</p>;
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setInstanceKey((k) => k + 1);
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm" variant="secondary">
          Enviar por e-mail
        </Button>
      </DialogTrigger>
      <SendEmailDialogBody
        key={instanceKey}
        leadId={leadId}
        proposalId={proposalId}
        documentId={readyDocumentId}
        contactEmails={contactEmails}
        onDone={() => setOpen(false)}
      />
    </Dialog>
  );
}

export function ProposalsSection({
  leadId,
  opportunityId,
  proposals,
  canEdit,
  canManageDocuments,
  documentsByProposal,
  emailSendsByProposal,
  contactEmails,
  hasWorkspaceLegalProfile,
}: {
  leadId: string;
  /** Oportunidade aberta do lead — sem ela não há onde propor honorários. */
  opportunityId: string | null;
  proposals: ProposalListItem[];
  canEdit: boolean;
  /** B1: gerar/baixar/enviar o PDF exige enxergar o valor exato — mais
   * restrito que canEdit (que inclui `sales`, banda apenas). */
  canManageDocuments: boolean;
  documentsByProposal: Record<string, ProposalDocumentListItem[]>;
  emailSendsByProposal: Record<string, ProposalEmailSendListItem[]>;
  contactEmails: string[];
  hasWorkspaceLegalProfile: boolean;
}) {
  return (
    <div className="flex flex-col gap-3">
      {canEdit ? (
        opportunityId ? (
          <div>
            <CreateProposalDialog leadId={leadId} opportunityId={opportunityId} />
          </div>
        ) : (
          <p className="text-meta text-text-tertiary">
            Crie uma oportunidade aberta para este lead antes de propor honorários.
          </p>
        )
      ) : null}

      {proposals.length === 0 ? (
        <EmptyState title="Nenhuma proposta ainda" description="Propostas criadas para este lead aparecem aqui." />
      ) : (
        <ul className="flex flex-col gap-3">
          {proposals.map((p) => {
            const documents = documentsByProposal[p.id] ?? [];
            const emailSends = emailSendsByProposal[p.id] ?? [];
            const readyDocument = [...documents].reverse().find((d) => d.status === "ready" && d.canDownload);
            const canGenerateNewDocument = canManageDocuments && p.status !== "aceita" && p.status !== "recusada";

            return (
              <li key={p.id} className="rounded-lg border border-border bg-surface p-3">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-body font-semibold text-text">{p.number}</span>
                  <span className="ml-auto rounded-full bg-warning-bg px-2 py-0.5 text-meta font-semibold text-warning">
                    {STATUS_LABEL[p.status]}
                  </span>
                </div>
                <div className="mt-1 flex items-baseline gap-2">
                  <span className="font-mono text-body">{formatValue(p)}</span>
                  {p.feeModel ? (
                    <span className="text-meta text-text-secondary">{FEE_MODEL_LABEL[p.feeModel]}</span>
                  ) : null}
                </div>

                {canManageDocuments ? (
                  <div className="mt-2 flex flex-wrap items-start gap-2">
                    {canGenerateNewDocument ? (
                      <GenerateDocumentButton leadId={leadId} proposalId={p.id} />
                    ) : documents.length > 0 ? (
                      <p className="text-meta text-text-tertiary">
                        Proposta decidida — para revisar, crie uma nova proposta.
                      </p>
                    ) : null}
                    <SendEmailDialog
                      leadId={leadId}
                      proposalId={p.id}
                      readyDocumentId={readyDocument?.id ?? null}
                      contactEmails={contactEmails}
                      hasWorkspaceLegalProfile={hasWorkspaceLegalProfile}
                    />
                  </div>
                ) : null}
                <DocumentsList documents={documents} />
                <EmailSendsList emailSends={emailSends} />

                {canEdit && p.status === "rascunho" ? (
                  <div className="mt-2">
                    <SendProposalForm leadId={leadId} proposal={p} />
                  </div>
                ) : null}
                {canEdit && p.status === "enviada" ? (
                  <div className="mt-2">
                    <DecideProposalForm leadId={leadId} proposal={p} />
                  </div>
                ) : null}
                {p.decisionNote ? <p className="mt-2 text-meta text-text-secondary">{p.decisionNote}</p> : null}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
