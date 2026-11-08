"use client";

import { useState, useTransition } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { toUserMessage } from "@/lib/errors";
import { sendMessageAction, sendWhatsAppTemplateAction } from "@/modules/conversations/actions";
import type { MessageListItem } from "@/modules/conversations/queries";
import type { WhatsAppSendUi } from "@/modules/conversations/whatsapp-send";

/**
 * Compositor do canal REAL da B3 (B3.3, docs/decisoes/b3-whatsapp-real.md
 * §28.18): mostra a janela de 24 h, o motivo quando o envio está bloqueado e,
 * fora da janela, o envio de template aprovado. As regras valem no servidor;
 * aqui é só leitura honesta delas. Canal legado da A7 usa o compositor antigo.
 */

function formatDateTime(iso: string): string {
  return new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));
}

/** {{1}}, {{2}}… trocados pelo que foi digitado (ou deixados como estão). */
function preview(body: string, params: string[]): string {
  return body.replace(/\{\{(\d{1,2})\}\}/g, (marker, n: string) => params[Number(n) - 1]?.trim() || marker);
}

export function WhatsAppComposer({
  conversationId,
  context,
  onSent,
}: {
  conversationId: string;
  context: WhatsAppSendUi;
  onSent: (message: MessageListItem) => void;
}) {
  const hasTemplates = context.templates.length > 0;
  const [mode, setMode] = useState<"text" | "template">(context.windowOpen ? "text" : "template");
  const [text, setText] = useState("");
  const [templateId, setTemplateId] = useState(context.templates[0]?.id ?? "");
  const [params, setParams] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  // Uma chave por intenção de envio, mantida até o envio ser decidido: clicar de
  // novo depois de uma falha de rede reenvia a MESMA intenção e nunca duplica.
  const [dedupeKey, setDedupeKey] = useState(() => crypto.randomUUID());

  const template = context.templates.find((t) => t.id === templateId) ?? null;
  const blocked = context.blockedReason;
  const templateReady =
    !!template && Array.from({ length: template.paramCount }, (_, i) => params[i]?.trim()).every((p) => !!p);
  const canSubmit = !blocked && !isPending && (mode === "text" ? !!text.trim() : templateReady);

  function chooseTemplate(id: string) {
    setTemplateId(id);
    setParams([]);
    setDedupeKey(crypto.randomUUID());
  }

  function setParam(index: number, value: string) {
    setParams((prev) => {
      const next = [...prev];
      next[index] = value;
      return next;
    });
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setError(null);
    startTransition(async () => {
      const result =
        mode === "text"
          ? await sendMessageAction(conversationId, text.trim(), dedupeKey)
          : await sendWhatsAppTemplateAction(
              conversationId,
              templateId,
              Array.from({ length: template?.paramCount ?? 0 }, (_, i) => params[i]?.trim() ?? ""),
              dedupeKey,
            );

      if (result.ok) {
        onSent(result.message);
        setText("");
        setParams([]);
        setDedupeKey(crypto.randomUUID());
        return;
      }

      setError(result.error);
      if (result.persisted) {
        // O servidor gravou a mensagem (falha, envio incerto ou conflito): mostra o
        // que foi REALMENTE persistido e queima a chave. Outro envio é outra intenção.
        onSent(result.persisted);
        setDedupeKey(crypto.randomUUID());
      }
    });
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-2 border-t border-border pt-3">
      {blocked ? (
        <Alert variant="warning">
          <AlertDescription>{toUserMessage({ message: blocked })}</AlertDescription>
        </Alert>
      ) : context.windowOpen ? (
        <p className="text-meta text-text-tertiary">
          Janela de atendimento aberta
          {context.windowExpiresAt ? ` até ${formatDateTime(context.windowExpiresAt)}` : ""}. Texto livre permitido.
        </p>
      ) : (
        <Alert variant="warning">
          <AlertDescription>
            A janela de 24 horas está fechada. Só é possível enviar um template aprovado, ligado a um caso do cliente.
          </AlertDescription>
        </Alert>
      )}

      {context.windowOpen && hasTemplates ? (
        <div className="flex gap-2" role="group" aria-label="Tipo de mensagem">
          <Button type="button" size="sm" variant={mode === "text" ? "primary" : "secondary"} onClick={() => setMode("text")}>
            Texto
          </Button>
          <Button type="button" size="sm" variant={mode === "template" ? "primary" : "secondary"} onClick={() => setMode("template")}>
            Template
          </Button>
        </div>
      ) : null}

      {mode === "text" && context.windowOpen ? (
        <div className="flex gap-2">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            disabled={isPending || !!blocked}
            rows={2}
            maxLength={4096}
            aria-label="Mensagem"
            placeholder="Escreva uma mensagem…"
            className="flex-1 resize-none rounded-input border border-border-input bg-surface px-3 py-2 text-body text-text disabled:opacity-60"
          />
          <Button type="submit" disabled={!canSubmit}>
            {isPending ? "Enviando…" : "Enviar"}
          </Button>
        </div>
      ) : !hasTemplates ? (
        <p className="text-meta text-text-tertiary">Nenhum template aprovado está disponível neste canal.</p>
      ) : (
        <div className="flex flex-col gap-2">
          <label className="flex flex-col gap-1 text-meta text-text-secondary">
            Template
            <select
              value={templateId}
              onChange={(e) => chooseTemplate(e.target.value)}
              disabled={isPending || !!blocked}
              className="rounded-input border border-border-input bg-surface px-3 py-2 text-body text-text disabled:opacity-60"
            >
              {context.templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name} ({t.language})
                </option>
              ))}
            </select>
          </label>
          {template ? (
            <>
              <p className="whitespace-pre-wrap rounded-input border border-border bg-surface-subtle px-3 py-2 text-body text-text">
                {preview(template.bodyText, params)}
              </p>
              {Array.from({ length: template.paramCount }, (_, i) => (
                <input
                  key={`${template.id}-${i}`}
                  value={params[i] ?? ""}
                  onChange={(e) => setParam(i, e.target.value)}
                  disabled={isPending || !!blocked}
                  maxLength={128}
                  aria-label={`Campo ${i + 1} do template`}
                  placeholder={`Campo ${i + 1}`}
                  className="rounded-input border border-border-input bg-surface px-3 py-2 text-body text-text disabled:opacity-60"
                />
              ))}
            </>
          ) : null}
          <div className="flex justify-end">
            <Button type="submit" disabled={!canSubmit}>
              {isPending ? "Enviando…" : "Enviar template"}
            </Button>
          </div>
        </div>
      )}

      {error ? (
        <Alert variant="danger">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
    </form>
  );
}
