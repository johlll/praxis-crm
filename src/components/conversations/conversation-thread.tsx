"use client";

import { useState, useTransition } from "react";
import { CheckCheck, Check, Clock, TriangleAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import type { MessageListItem } from "@/modules/conversations/queries";
import {
  loadOlderMessagesAction,
  sendMessageAction,
  simulateStatusEventAction,
} from "@/modules/conversations/actions";
import { MESSAGE_STATUS_LABEL } from "./labels";

function formatTime(iso: string): string {
  return new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));
}

function StatusIcon({ status }: { status: MessageListItem["status"] }) {
  if (status === "failed") return <TriangleAlert size={13} className="text-danger" aria-hidden />;
  if (status === "read") return <CheckCheck size={13} className="text-success" aria-hidden />;
  if (status === "delivered") return <CheckCheck size={13} className="text-text-tertiary" aria-hidden />;
  if (status === "sent") return <Check size={13} className="text-text-tertiary" aria-hidden />;
  return <Clock size={13} className="text-text-tertiary" aria-hidden />;
}

export function ConversationThread({
  conversationId,
  initialItems,
  initialHasMore,
  canSend,
  canSimulateStatus,
  phoneNumberId,
  recipientWaId,
  consentBlocked,
}: {
  conversationId: string;
  initialItems: MessageListItem[];
  initialHasMore: boolean;
  canSend: boolean;
  canSimulateStatus: boolean;
  phoneNumberId: string;
  recipientWaId: string;
  consentBlocked: boolean;
}) {
  const [items, setItems] = useState(initialItems);
  const [hasMore, setHasMore] = useState(initialHasMore);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadingOlder, startLoadOlder] = useTransition();

  function handleLoadOlder() {
    const oldest = items[0];
    if (!oldest) return;
    setLoadError(null);
    startLoadOlder(async () => {
      const result = await loadOlderMessagesAction(conversationId, oldest.createdAt);
      if (!result.ok) {
        setLoadError(result.error);
        return;
      }
      setItems((prev) => [...result.items, ...prev]);
      setHasMore(result.hasMore);
    });
  }

  function handleSent(message: MessageListItem) {
    setItems((prev) => [...prev, message]);
  }

  function handleStatusSimulated(messageId: string, status: MessageListItem["status"]) {
    setItems((prev) => prev.map((m) => (m.id === messageId ? { ...m, status } : m)));
  }

  return (
    <div className="flex flex-1 flex-col gap-3">
      <div className="flex flex-col gap-2">
        {hasMore ? (
          <div className="flex justify-center">
            <Button variant="secondary" size="sm" onClick={handleLoadOlder} disabled={loadingOlder}>
              {loadingOlder ? "Carregando…" : "Carregar mensagens mais antigas"}
            </Button>
          </div>
        ) : null}
        {loadError ? (
          <Alert variant="danger">
            <AlertDescription>
              {loadError}{" "}
              <button type="button" onClick={handleLoadOlder} className="font-semibold underline">
                Tentar novamente
              </button>
            </AlertDescription>
          </Alert>
        ) : null}

        <ul className="flex flex-col gap-2">
          {items.map((m) => (
            <li key={m.id} className={m.direction === "outbound" ? "flex justify-end" : "flex justify-start"}>
              <div
                className={
                  m.direction === "outbound"
                    ? "max-w-[75%] rounded-card rounded-tr-sm bg-primary-tint px-3 py-2"
                    : "max-w-[75%] rounded-card rounded-tl-sm border border-border bg-surface px-3 py-2"
                }
              >
                <p className="whitespace-pre-wrap text-body text-text">{m.bodyText}</p>
                <div className="mt-1 flex items-center justify-end gap-1.5">
                  {m.direction === "outbound" && canSimulateStatus ? (
                    <StatusSimulateMenu
                      phoneNumberId={phoneNumberId}
                      waMessageId={m.waMessageId}
                      recipientWaId={recipientWaId}
                      currentStatus={m.status}
                      onSimulated={(status) => handleStatusSimulated(m.id, status)}
                    />
                  ) : null}
                  {m.errorReason ? (
                    <span className="text-label text-danger" title={m.errorReason}>
                      {MESSAGE_STATUS_LABEL.failed}
                    </span>
                  ) : null}
                  <span className="text-label text-text-tertiary">{formatTime(m.createdAt)}</span>
                  {m.direction === "outbound" ? <StatusIcon status={m.status} /> : null}
                </div>
              </div>
            </li>
          ))}
        </ul>
      </div>

      {canSend ? (
        <Composer conversationId={conversationId} disabled={consentBlocked} onSent={handleSent} />
      ) : null}
    </div>
  );
}

function Composer({
  conversationId,
  disabled,
  onSent,
}: {
  conversationId: string;
  disabled: boolean;
  onSent: (message: MessageListItem) => void;
}) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  // Gerado uma vez por composição, mantido até o envio confirmar — reenviar
  // a MESMA tentativa (ex.: clicar de novo após falha) nunca duplica.
  const [dedupeKey, setDedupeKey] = useState(() => crypto.randomUUID());

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const bodyText = text.trim();
    if (!bodyText) return;
    setError(null);
    startTransition(async () => {
      const result = await sendMessageAction(conversationId, bodyText, dedupeKey);
      if (!result.ok || !result.messageId) {
        setError(result.error ?? "Não foi possível enviar.");
        return;
      }
      onSent({
        id: result.messageId,
        direction: "outbound",
        bodyText,
        status: "sent",
        statusUpdatedAt: new Date().toISOString(),
        errorReason: null,
        sentBy: null,
        createdAt: new Date().toISOString(),
        waMessageId: "",
      });
      setText("");
      setDedupeKey(crypto.randomUUID());
    });
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-2 border-t border-border pt-3">
      {disabled ? (
        <Alert variant="warning">
          <AlertDescription>
            Sem consentimento vigente para WhatsApp — registre o consentimento do contato abaixo antes de enviar.
          </AlertDescription>
        </Alert>
      ) : null}
      <div className="flex gap-2">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          disabled={isPending}
          rows={2}
          maxLength={4096}
          placeholder="Escreva uma mensagem (simulada)…"
          className="flex-1 resize-none rounded-input border border-border-input bg-surface px-3 py-2 text-body text-text disabled:opacity-60"
        />
        {/* Não desabilita pelo "disabled" (falta de consentimento): o
            servidor já recusa com "consent_required" — deixar tentar e
            mostrar o erro tratado é o mesmo padrão do resto do app (nunca
            esconder uma ação que o servidor recusaria com boa mensagem). */}
        <Button type="submit" disabled={isPending || !text.trim()}>
          {isPending ? "Enviando…" : "Enviar"}
        </Button>
      </div>
      {error ? (
        <Alert variant="danger">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
    </form>
  );
}

function StatusSimulateMenu({
  phoneNumberId,
  waMessageId,
  recipientWaId,
  currentStatus,
  onSimulated,
}: {
  phoneNumberId: string;
  waMessageId: string;
  recipientWaId: string;
  currentStatus: MessageListItem["status"];
  onSimulated: (status: MessageListItem["status"]) => void;
}) {
  const [isPending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);

  if (currentStatus === "read" || currentStatus === "failed") return null;

  function simulate(status: "delivered" | "read" | "failed") {
    setOpen(false);
    startTransition(async () => {
      const formData = new FormData();
      formData.set("phoneNumberId", phoneNumberId);
      formData.set("waMessageId", waMessageId);
      formData.set("recipientWaId", recipientWaId);
      formData.set("status", status);
      const result = await simulateStatusEventAction({ ok: false }, formData);
      if (result.ok) onSimulated(status);
    });
  }

  return (
    <span className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={isPending}
        className="rounded-full bg-purple-bg px-1.5 py-0.5 text-label font-bold text-purple"
        title="Simular evento de status (visível só para administração)"
      >
        SIMULAR
      </button>
      {open ? (
        <span className="absolute bottom-full right-0 z-10 mb-1 flex flex-col gap-0.5 rounded-md border border-border bg-surface p-1 shadow-md">
          <button type="button" onClick={() => simulate("delivered")} className="whitespace-nowrap rounded px-2 py-1 text-left text-meta text-text hover:bg-surface-subtle">
            Marcar entregue
          </button>
          <button type="button" onClick={() => simulate("read")} className="whitespace-nowrap rounded px-2 py-1 text-left text-meta text-text hover:bg-surface-subtle">
            Marcar lida
          </button>
          <button type="button" onClick={() => simulate("failed")} className="whitespace-nowrap rounded px-2 py-1 text-left text-meta text-danger hover:bg-danger-bg">
            Marcar falha
          </button>
        </span>
      ) : null}
    </span>
  );
}
