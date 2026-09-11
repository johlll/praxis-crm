"use client";

import { useActionState, useState, useTransition } from "react";
import { ShieldCheck, ShieldOff } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FormField, FormLabel } from "@/components/ui/form-field";
import { Alert, AlertDescription } from "@/components/ui/alert";
import type { ContactConsent } from "@/modules/conversations/queries";
import {
  registerContactConsentAction,
  revokeContactConsentAction,
  type ActionState,
} from "@/modules/conversations/actions";
import { CONSENT_LEGAL_BASIS } from "@/modules/conversations/schema";
import { CONSENT_LEGAL_BASIS_LABEL } from "./labels";

const INITIAL_STATE: ActionState = { ok: false };

function formatDate(iso: string | null): string {
  if (!iso) return "";
  return new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", dateStyle: "short" }).format(new Date(iso));
}

export function ConsentPanel({ contactId, consents, canManage }: { contactId: string; consents: ContactConsent[]; canManage: boolean }) {
  const whatsappConsents = consents.filter((c) => c.channel === "whatsapp");
  const active = whatsappConsents.find((c) => c.grantedAt && !c.revokedAt);

  return (
    <section className="rounded-card border border-border bg-surface p-4">
      <h2 className="mb-2 text-body font-semibold text-text">Consentimento — WhatsApp</h2>
      {active ? (
        <div className="mb-3 flex items-center justify-between gap-2 rounded-md bg-success-bg px-3 py-2">
          <div className="flex items-center gap-2">
            <ShieldCheck size={14} className="text-success" aria-hidden />
            <span className="text-meta text-success">
              Vigente desde {formatDate(active.grantedAt)} — {active.purpose}
            </span>
          </div>
          {canManage ? <RevokeButton consentId={active.id} /> : null}
        </div>
      ) : (
        <div className="mb-3 flex items-center gap-2 rounded-md bg-danger-bg px-3 py-2">
          <ShieldOff size={14} className="text-danger" aria-hidden />
          <span className="text-meta text-danger">Nenhum consentimento vigente — envio ativo bloqueado.</span>
        </div>
      )}

      {whatsappConsents.length > 0 ? (
        <ul className="mb-3 flex flex-col gap-1">
          {whatsappConsents
            .filter((c) => c.id !== active?.id)
            .map((c) => (
              <li key={c.id} className="text-label text-text-tertiary">
                {formatDate(c.grantedAt)} — {c.purpose} ({CONSENT_LEGAL_BASIS_LABEL[c.legalBasis] ?? c.legalBasis})
                {c.revokedAt ? ` — revogado em ${formatDate(c.revokedAt)}` : ""}
              </li>
            ))}
        </ul>
      ) : null}

      {canManage && !active ? <RegisterConsentForm contactId={contactId} /> : null}
    </section>
  );
}

function RevokeButton({ consentId }: { consentId: string }) {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={isPending}
        onClick={() =>
          startTransition(async () => {
            const result = await revokeContactConsentAction(consentId);
            if (!result.ok) setError(result.error ?? "Não foi possível revogar.");
          })
        }
      >
        {isPending ? "Revogando…" : "Revogar"}
      </Button>
      {error ? <span className="text-label text-danger">{error}</span> : null}
    </div>
  );
}

function RegisterConsentForm({ contactId }: { contactId: string }) {
  const [state, formAction, pending] = useActionState(registerContactConsentAction, INITIAL_STATE);

  return (
    <form action={formAction} className="flex flex-col gap-2 border-t border-border pt-3">
      <input type="hidden" name="contactId" value={contactId} />
      <input type="hidden" name="channel" value="whatsapp" />
      <div className="grid grid-cols-2 gap-2">
        <FormField>
          <FormLabel htmlFor="consent-legal-basis">Base legal</FormLabel>
          <select
            id="consent-legal-basis"
            name="legalBasis"
            defaultValue="consentimento"
            className="h-9 rounded-input border border-border-input bg-surface px-3 text-body text-text"
          >
            {CONSENT_LEGAL_BASIS.map((b) => (
              <option key={b} value={b}>
                {CONSENT_LEGAL_BASIS_LABEL[b]}
              </option>
            ))}
          </select>
        </FormField>
        <FormField>
          <FormLabel htmlFor="consent-evidence">Origem da prova (opcional)</FormLabel>
          <Input id="consent-evidence" name="evidenceSource" maxLength={300} placeholder="Ex.: formulário do site" />
        </FormField>
      </div>
      <FormField>
        <FormLabel htmlFor="consent-purpose">Finalidade</FormLabel>
        <Input id="consent-purpose" name="purpose" required maxLength={300} placeholder="Ex.: atendimento via WhatsApp" />
      </FormField>
      {state.error ? (
        <Alert variant="danger">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      ) : null}
      <Button type="submit" size="sm" disabled={pending}>
        {pending ? "Registrando…" : "Registrar consentimento"}
      </Button>
    </form>
  );
}
