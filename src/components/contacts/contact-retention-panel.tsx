"use client";

import { useState } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  ANONYMIZE_CONFIRMATION,
  HOLD_REASON_CODES,
  HOLD_REASON_LABEL,
  RETENTION_MONTHS,
  describeBlockReason,
  formatRetentionDate,
  type HoldReasonCode,
  type RetentionStatus,
} from "@/modules/privacy/retention";

type Phase = "idle" | "confirming" | "working";
type Notice = { variant: "success" | "danger" | "warning"; text: string } | null;

type Outcome = "anonymized" | "already_anonymized" | "refused" | "failed" | null;

const ERROR_MESSAGE: Record<string, string> = {
  forbidden: "Você não tem permissão para esta operação.",
  not_found: "Registro não encontrado.",
};
const GENERIC_FAILURE = "Não foi possível concluir a operação. Nada foi alterado; tente novamente.";

/**
 * C3b — retenção de 12 meses, preservação legal e anonimização manual, dentro da seção
 * "Privacidade e LGPD" do contato (só owner/admin; a página nem renderiza para os demais).
 * A tela só mostra estado e códigos fechados em linguagem clara; nunca dado pessoal. O workspace,
 * o ator e o prazo não saem daqui: o servidor os resolve a partir da sessão.
 */
export function ContactRetentionPanel({
  contactId,
  status,
  onStatus,
}: {
  contactId: string;
  status: RetentionStatus | null;
  onStatus: (next: RetentionStatus) => void;
}) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [notice, setNotice] = useState<Notice>(null);
  const [typed, setTyped] = useState("");
  const [holdReason, setHoldReason] = useState<HoldReasonCode>(HOLD_REASON_CODES[0]);

  async function call(body: Record<string, unknown>): Promise<{ status: RetentionStatus; outcome: Outcome } | null> {
    setPhase("working");
    setNotice(null);
    try {
      const response = await fetch(`/api/privacy/contacts/${contactId}/retention`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await response.json().catch(() => ({}))) as {
        error?: string;
        status?: RetentionStatus;
        outcome?: Outcome;
      };
      if (!response.ok || !data.status) {
        setNotice({ variant: "danger", text: ERROR_MESSAGE[data.error ?? ""] ?? GENERIC_FAILURE });
        return null;
      }
      onStatus(data.status);
      return { status: data.status, outcome: data.outcome ?? null };
    } catch {
      setNotice({ variant: "danger", text: GENERIC_FAILURE });
      return null;
    } finally {
      setPhase("idle");
    }
  }

  async function createHold() {
    const result = await call({ action: "hold_create", reasonCode: holdReason });
    if (result) setNotice({ variant: "success", text: "Preservação legal registrada. Este contato não será anonimizado." });
  }

  async function releaseHold(holdId: string) {
    const result = await call({ action: "hold_release", holdId });
    if (result) setNotice({ variant: "success", text: "Preservação legal encerrada." });
  }

  async function anonymize() {
    const result = await call({ action: "anonymize", confirmation: typed });
    setTyped("");
    if (!result) return;
    switch (result.outcome) {
      case "anonymized":
      case "already_anonymized":
        setNotice({ variant: "success", text: "Contato anonimizado. Os dados pessoais anteriores foram removidos." });
        break;
      case "refused":
        setNotice({
          variant: "warning",
          text: "A anonimização foi recusada: a situação do contato mudou desde a última consulta. Confira os motivos abaixo.",
        });
        break;
      default:
        setNotice({ variant: "danger", text: "A anonimização falhou e nada foi alterado. Tente novamente." });
    }
  }

  if (!status) {
    return (
      <div className="mt-4 border-t border-border pt-4">
        <h3 className="mb-1 text-small font-semibold text-text">Retenção e anonimização</h3>
        <Alert variant="warning">
          <AlertDescription>Não foi possível carregar o estado de retenção deste contato. Recarregue a página.</AlertDescription>
        </Alert>
      </div>
    );
  }

  if (status.state === "anonymized") {
    return (
      <div className="mt-4 border-t border-border pt-4">
        <h3 className="mb-1 text-small font-semibold text-text">Retenção e anonimização</h3>
        <Alert variant="success">
          <AlertDescription>
            Contato anonimizado{status.anonymized_at ? ` em ${formatRetentionDate(status.anonymized_at)}` : ""}. Os dados pessoais
            anteriores foram removidos de forma irreversível e não podem ser recuperados.
          </AlertDescription>
        </Alert>
        {notice ? (
          <Alert variant={notice.variant} className="mt-3">
            <AlertDescription>{notice.text}</AlertDescription>
          </Alert>
        ) : null}
      </div>
    );
  }

  const activeHolds = status.holds.filter((hold) => hold.status === "active");
  const busy = phase === "working";

  return (
    <div className="mt-4 flex flex-col gap-3 border-t border-border pt-4">
      <div>
        <h3 className="mb-1 text-small font-semibold text-text">Retenção e anonimização</h3>
        <p className="text-small text-text-secondary">
          Leads arquivados são retidos por {RETENTION_MONTHS} meses, contados do dia em que o lead foi arquivado. Clientes, casos
          em andamento e contatos sob preservação legal não são anonimizados.
        </p>
      </div>

      {status.eligible ? (
        <Alert variant="success">
          <AlertDescription>Elegível para anonimização: o prazo de {RETENTION_MONTHS} meses foi cumprido e não há bloqueio.</AlertDescription>
        </Alert>
      ) : (
        <Alert variant="warning">
          <AlertDescription>
            <p className="mb-1 font-medium">Anonimização bloqueada:</p>
            <ul className="list-disc pl-5">
              {status.reasons.map((reason) => (
                <li key={reason}>{describeBlockReason(reason, status.retention_due_at)}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}

      <div className="flex flex-col gap-2">
        <h4 className="text-small font-medium text-text">Preservação legal</h4>
        {activeHolds.length === 0 ? (
          <p className="text-small text-text-secondary">Nenhuma preservação ativa.</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {activeHolds.map((hold) => (
              <li key={hold.id} className="flex items-center justify-between gap-2 text-small text-text">
                <span>
                  {HOLD_REASON_LABEL[hold.reason_code]} — desde {formatRetentionDate(hold.created_at)}
                </span>
                <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => releaseHold(hold.id)}>
                  Encerrar
                </Button>
              </li>
            ))}
          </ul>
        )}
        <div className="flex items-center gap-2">
          <select
            aria-label="Motivo da preservação legal"
            value={holdReason}
            disabled={busy}
            onChange={(event) => setHoldReason(event.target.value as HoldReasonCode)}
            className="h-9 flex-1 rounded-input border border-border-input bg-surface px-3 text-body text-text"
          >
            {HOLD_REASON_CODES.map((code) => (
              <option key={code} value={code}>
                {HOLD_REASON_LABEL[code]}
              </option>
            ))}
          </select>
          <Button type="button" size="sm" variant="secondary" disabled={busy} onClick={createHold}>
            Criar preservação
          </Button>
        </div>
      </div>

      {status.eligible ? (
        phase === "confirming" ? (
          <div className="flex flex-col gap-3">
            <Alert variant="danger">
              <AlertDescription>
                Esta ação é <strong>irreversível</strong>. Nome, telefones, e-mails, CPF/CNPJ, mensagens, anotações e demais dados
                pessoais deste contato serão removidos ou substituídos; só o esqueleto de métricas e a auditoria sem conteúdo
                permanecem. Digite <strong>{ANONYMIZE_CONFIRMATION}</strong> para confirmar.
              </AlertDescription>
            </Alert>
            <Input
              aria-label={`Digite ${ANONYMIZE_CONFIRMATION} para confirmar`}
              autoComplete="off"
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
            />
            <div className="flex gap-2">
              <Button
                type="button"
                size="sm"
                variant="danger"
                disabled={busy || typed !== ANONYMIZE_CONFIRMATION}
                onClick={anonymize}
              >
                {busy ? "Anonimizando…" : "Anonimizar definitivamente"}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => {
                  setTyped("");
                  setPhase("idle");
                }}
              >
                Cancelar
              </Button>
            </div>
          </div>
        ) : (
          <div>
            <Button type="button" size="sm" variant="danger" disabled={busy} onClick={() => setPhase("confirming")}>
              Anonimizar contato
            </Button>
          </div>
        )
      ) : null}

      {notice ? (
        <Alert variant={notice.variant}>
          <AlertDescription>{notice.text}</AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}
