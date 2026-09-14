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
import { FEE_MODELS, PROPOSAL_CHANNELS } from "@/modules/proposals/schema";

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

function formatValue(proposal: ProposalListItem): string {
  if (proposal.valueCents !== undefined) {
    return (proposal.valueCents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
  }
  return proposal.valueBand ?? "—";
}

const INITIAL: ProposalActionState = { ok: false };

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
        {pending ? "Enviando…" : "Enviar proposta"}
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

export function ProposalsSection({
  leadId,
  opportunityId,
  proposals,
  canEdit,
}: {
  leadId: string;
  /** Oportunidade aberta do lead — sem ela não há onde propor honorários. */
  opportunityId: string | null;
  proposals: ProposalListItem[];
  canEdit: boolean;
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
          {proposals.map((p) => (
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
          ))}
        </ul>
      )}
    </div>
  );
}
