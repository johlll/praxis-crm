"use client";

import { useState } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { ContactRetentionPanel } from "@/components/contacts/contact-retention-panel";
import type { RetentionStatus } from "@/modules/privacy/retention";

type Phase = "idle" | "confirming" | "processing" | "done" | "failed";

const FAILURE_MESSAGE: Record<string, string> = {
  forbidden: "Você não tem permissão para exportar os dados deste titular.",
  not_found: "Contato não encontrado.",
};
const GENERIC_FAILURE = "Não foi possível gerar a exportação. Nenhum arquivo foi entregue; tente novamente.";

/** Nome do anexo vem do cabeçalho da resposta (sem PII: id do contato e data). */
function fileNameFrom(response: Response): string {
  const match = /filename="([^"]+)"/.exec(response.headers.get("Content-Disposition") ?? "");
  return match?.[1] ?? "titular.json";
}

/**
 * C3a — exportação dos dados do titular, na tela do contato (só owner/admin;
 * a página nem renderiza para os demais papéis). O arquivo é baixado direto da
 * resposta e nunca fica guardado no servidor.
 */
export function ContactPrivacySection({
  contactId,
  initialRetention,
}: {
  contactId: string;
  /** Estado da retenção (C3b). `null` = indisponível (aviso); omitido = painel não é exibido. */
  initialRetention?: RetentionStatus | null;
}) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [retention, setRetention] = useState<RetentionStatus | null>(initialRetention ?? null);
  // Depois de anonimizado não há o que exportar: o arquivo seria só o esqueleto.
  const anonymized = retention?.state === "anonymized";

  async function generate() {
    setPhase("processing");
    setMessage(null);
    try {
      const response = await fetch(`/api/privacy/contacts/${contactId}/export`, { method: "POST" });
      if (!response.ok) {
        let code = "";
        try {
          code = ((await response.json()) as { error?: string }).error ?? "";
        } catch {
          code = "";
        }
        setMessage(FAILURE_MESSAGE[code] ?? GENERIC_FAILURE);
        setPhase("failed");
        return;
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = fileNameFrom(response);
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      setPhase("done");
    } catch {
      setMessage(GENERIC_FAILURE);
      setPhase("failed");
    }
  }

  return (
    <section className="rounded-lg border border-border bg-surface p-4">
      <h2 className="mb-2 text-body font-semibold text-text">Privacidade e LGPD</h2>
      {anonymized ? null : (
        <p className="mb-3 text-small text-text-secondary">
          Use esta exportação somente para atendimento de solicitação do titular. O arquivo pode conter dados pessoais e deve ser
          armazenado e compartilhado com segurança.
        </p>
      )}

      {anonymized ? null : phase === "confirming" ? (
        <div className="flex flex-col gap-3">
          <Alert variant="warning">
            <AlertDescription>
              Será gerado um arquivo com os dados pessoais deste titular, e a exportação ficará registrada na auditoria. Continuar?
            </AlertDescription>
          </Alert>
          <div className="flex gap-2">
            <Button type="button" size="sm" onClick={generate}>
              Gerar exportação
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setPhase("idle")}>
              Cancelar
            </Button>
          </div>
        </div>
      ) : (
        <Button
          type="button"
          size="sm"
          variant="secondary"
          disabled={phase === "processing"}
          onClick={() => setPhase("confirming")}
        >
          {phase === "processing" ? "Gerando exportação…" : "Exportar dados do titular"}
        </Button>
      )}

      {phase === "done" ? (
        <Alert variant="success" className="mt-3">
          <AlertDescription>Exportação gerada. O download começou.</AlertDescription>
        </Alert>
      ) : null}
      {phase === "failed" && message ? (
        <Alert variant="danger" className="mt-3">
          <AlertDescription>{message}</AlertDescription>
        </Alert>
      ) : null}

      {initialRetention === undefined ? null : (
        <ContactRetentionPanel contactId={contactId} status={retention} onStatus={setRetention} />
      )}
    </section>
  );
}
