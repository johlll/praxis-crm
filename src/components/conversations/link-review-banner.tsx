"use client";

import { useState, useTransition } from "react";
import { AlertTriangle } from "lucide-react";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { resolveConversationLinkAction } from "@/modules/conversations/actions";

type Candidate = { id: string; label: string };

export function LinkReviewBanner({
  conversationId,
  contactId,
  leadId,
  contactCandidates,
  leadCandidates,
  openOpportunities,
}: {
  conversationId: string;
  contactId: string | null;
  leadId: string | null;
  contactCandidates: Candidate[];
  leadCandidates: Candidate[];
  openOpportunities: Candidate[];
}) {
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function resolve(args: { contactId?: string; leadId?: string; opportunityId?: string }) {
    setError(null);
    startTransition(async () => {
      const result = await resolveConversationLinkAction(
        conversationId,
        args.contactId,
        args.leadId,
        args.opportunityId,
      );
      if (!result.ok) setError(result.error ?? "Não foi possível vincular.");
    });
  }

  let body: React.ReactNode;

  if (!contactId) {
    body = (
      <div className="flex flex-col gap-2">
        <p className="text-meta text-text-secondary">
          Este número tem mais de um contato cadastrado com o mesmo telefone — escolha qual é:
        </p>
        <div className="flex flex-wrap gap-2">
          {contactCandidates.map((c) => (
            <Button key={c.id} variant="secondary" size="sm" disabled={isPending} onClick={() => resolve({ contactId: c.id })}>
              {c.label}
            </Button>
          ))}
        </div>
      </div>
    );
  } else if (!leadId && leadCandidates.length > 0) {
    body = (
      <div className="flex flex-col gap-2">
        <p className="text-meta text-text-secondary">Este contato tem mais de um lead em aberto — a qual esta conversa pertence?</p>
        <div className="flex flex-wrap gap-2">
          {leadCandidates.map((l) => (
            <Button key={l.id} variant="secondary" size="sm" disabled={isPending} onClick={() => resolve({ leadId: l.id })}>
              {l.label}
            </Button>
          ))}
        </div>
      </div>
    );
  } else if (!leadId) {
    body = (
      <div className="flex items-center justify-between gap-2">
        <p className="text-meta text-text-secondary">Contato sem nenhum lead em aberto no momento.</p>
        <Button asChild size="sm">
          <Link href={`/leads/novo?contactId=${contactId}` as never}>Criar lead para este contato</Link>
        </Button>
      </div>
    );
  } else if (openOpportunities.length > 0) {
    body = (
      <div className="flex flex-col gap-2">
        <p className="text-meta text-text-secondary">Este lead tem mais de uma oportunidade aberta — a qual esta conversa pertence?</p>
        <div className="flex flex-wrap gap-2">
          {openOpportunities.map((o) => (
            <Button key={o.id} variant="secondary" size="sm" disabled={isPending} onClick={() => resolve({ leadId, opportunityId: o.id })}>
              {o.label}
            </Button>
          ))}
        </div>
      </div>
    );
  } else {
    body = null;
  }

  if (!body) return null;

  return (
    <div className="rounded-card border border-warning/30 bg-warning-bg p-3">
      <div className="mb-2 flex items-center gap-2">
        <AlertTriangle size={14} className="text-warning" aria-hidden />
        <span className="text-meta font-semibold text-warning">Vínculo pendente</span>
      </div>
      {body}
      {error ? (
        <Alert variant="danger" className="mt-2">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}
