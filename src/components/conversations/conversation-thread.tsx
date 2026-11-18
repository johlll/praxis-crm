"use client";

import { Fragment, useEffect, useLayoutEffect, useRef, useState, useTransition } from "react";
import { CheckCheck, Check, Clock, EyeOff, MessageSquare, TriangleAlert } from "lucide-react";

import { cn } from "@/lib/cn";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import type { MessageListItem } from "@/modules/conversations/queries";
import { messageAuthorKind, type MessageAuthorKind } from "@/modules/conversations/message-author";
import {
  MESSAGE_AUTHOR_HINT,
  MESSAGE_AUTHOR_LABEL,
  dayKey,
  formatDaySeparator,
  unsupportedContentNotice,
} from "@/modules/conversations/inbox";
import {
  loadOlderMessagesAction,
  sendMessageAction,
  simulateStatusEventAction,
} from "@/modules/conversations/actions";
import type { WhatsAppSendUi } from "@/modules/conversations/whatsapp-send";
import { toUserMessage } from "@/lib/errors";
import { MESSAGE_STATUS_LABEL } from "./labels";
import { WhatsAppComposer } from "./whatsapp-composer";
import { OpenContextButton } from "./context-panel-shell";

function formatTime(iso: string): string {
  return new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));
}

/** Motivo de falha do envio do CRM em texto claro; texto livre (A7) fica como veio. */
function errorReasonTitle(reason: string): string {
  const friendly = toUserMessage({ message: reason });
  return /^[a-z][a-z0-9_]*$/.test(reason) && friendly !== toUserMessage(null) ? friendly : reason;
}

function StatusIcon({ status }: { status: MessageListItem["status"] }) {
  if (status === "failed") return <TriangleAlert size={13} className="text-danger" aria-hidden />;
  if (status === "read") return <CheckCheck size={13} className="text-success" aria-hidden />;
  if (status === "delivered") return <CheckCheck size={13} className="text-text-tertiary" aria-hidden />;
  if (status === "sent") return <Check size={13} className="text-text-tertiary" aria-hidden />;
  return <Clock size={13} className="text-text-tertiary" aria-hidden />;
}

/** Aparência do balão por autoria comprovada (nunca por suposição). */
const BUBBLE_CLASS: Record<MessageAuthorKind, string> = {
  client: "border border-border bg-surface-subtle",
  office_crm: "bg-primary-tint",
  office_phone: "bg-primary-tint",
  internal: "bg-primary-tint",
  automation: "border border-purple/30 bg-purple-bg",
  unidentified: "border border-dashed border-border-strong bg-surface-subtle",
};

export function ConversationThread({
  conversationId,
  initialItems,
  initialHasMore,
  canSend,
  canSimulateStatus,
  phoneNumberId,
  recipientWaId,
  consentBlocked,
  sendContext,
}: {
  conversationId: string;
  initialItems: MessageListItem[];
  initialHasMore: boolean;
  canSend: boolean;
  canSimulateStatus: boolean;
  phoneNumberId: string;
  recipientWaId: string;
  consentBlocked: boolean;
  /** Canal real da B3: compositor com janela, bloqueio com motivo e template. `null` = canal legado da A7. */
  sendContext: WhatsAppSendUi | null;
}) {
  const [items, setItems] = useState(initialItems);
  const [hasMore, setHasMore] = useState(initialHasMore);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadingOlder, startLoadOlder] = useTransition();

  const scrollRef = useRef<HTMLDivElement | null>(null);
  // Distância do fundo antes de acrescentar mensagens antigas no topo (não pular a leitura).
  const anchorRef = useRef<number | null>(null);
  const stickToBottomRef = useRef(true);

  // Ao abrir, leva ao fim (a mensagem mais recente). Repete no quadro seguinte e quando as fontes
  // terminam de carregar, porque a altura do histórico ainda pode mudar até lá.
  useEffect(() => {
    const toEnd = () => {
      const el = scrollRef.current;
      if (el && stickToBottomRef.current) el.scrollTop = el.scrollHeight;
    };
    toEnd();
    const frame = requestAnimationFrame(toEnd);
    void document.fonts?.ready.then(toEnd);
    return () => cancelAnimationFrame(frame);
  }, []);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (anchorRef.current !== null) {
      el.scrollTop = el.scrollHeight - anchorRef.current;
      anchorRef.current = null;
    } else if (stickToBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [items]);

  function handleLoadOlder() {
    const oldest = items[0];
    if (!oldest) return;
    setLoadError(null);
    startLoadOlder(async () => {
      const result = await loadOlderMessagesAction(conversationId, { createdAt: oldest.createdAt, id: oldest.id });
      if (!result.ok) {
        setLoadError(result.error);
        return;
      }
      const el = scrollRef.current;
      if (el) anchorRef.current = el.scrollHeight - el.scrollTop;
      stickToBottomRef.current = false;
      setItems((prev) => [...result.items, ...prev]);
      setHasMore(result.hasMore);
    });
  }

  /**
   * Reconcilia com o registro REALMENTE persistido (id/texto/status vêm do
   * servidor, nunca fabricados a partir do texto local digitado —
   * a7-conversas.md §8). Se o id já está na lista (reenvio da mesma
   * client_dedupe_key, ex.: resposta perdida e usuário tentou de novo),
   * atualiza a bolha existente em vez de duplicar.
   */
  function handleSent(message: MessageListItem) {
    stickToBottomRef.current = true;
    setItems((prev) =>
      prev.some((m) => m.id === message.id) ? prev.map((m) => (m.id === message.id ? message : m)) : [...prev, message],
    );
  }

  function handleStatusSimulated(messageId: string, status: MessageListItem["status"]) {
    stickToBottomRef.current = false;
    setItems((prev) => prev.map((m) => (m.id === messageId ? { ...m, status } : m)));
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        ref={scrollRef}
        role="log"
        aria-label="Mensagens da conversa"
        aria-live="polite"
        tabIndex={0}
        className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-3 py-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary-ring md:px-4"
      >
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

        {items.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 py-10 text-center">
            <div className="flex size-10 items-center justify-center rounded-card bg-primary-tint text-primary" aria-hidden>
              <MessageSquare size={18} />
            </div>
            <p className="m-0 text-body font-semibold text-text">Nenhuma mensagem nesta conversa ainda</p>
            <p className="m-0 max-w-[300px] text-meta text-text-tertiary">
              As mensagens aparecem aqui assim que chegarem ou forem enviadas.
            </p>
          </div>
        ) : null}

        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {items.map((m, i) => {
            const prev = items[i - 1];
            const newDay = !prev || dayKey(prev.createdAt) !== dayKey(m.createdAt);
            const author = messageAuthorKind(m);
            const outbound = m.direction === "outbound";
            const nonText = m.contentKind && m.contentKind !== "text";
            return (
              <Fragment key={m.id}>
                {newDay ? (
                  <li className="flex justify-center py-1" aria-hidden={false}>
                    <span className="rounded-full bg-surface-muted px-3 py-0.5 text-meta font-semibold text-text-muted">
                      {formatDaySeparator(m.createdAt)}
                    </span>
                  </li>
                ) : null}
                <li className={outbound ? "flex justify-end" : "flex justify-start"}>
                  <div
                    className={cn(
                      "max-w-[88%] rounded-card px-3 py-2 md:max-w-[78%]",
                      outbound ? "rounded-tr-sm" : "rounded-tl-sm",
                      BUBBLE_CLASS[author],
                    )}
                  >
                    <p
                      className="m-0 mb-1 text-label font-bold text-text-muted"
                      title={MESSAGE_AUTHOR_HINT[author]}
                    >
                      {MESSAGE_AUTHOR_LABEL[author]}
                    </p>
                    {nonText ? (
                      <p className="m-0 mb-1 flex items-center gap-1.5 text-meta italic text-text-tertiary">
                        <EyeOff size={13} aria-hidden className="shrink-0" />
                        {unsupportedContentNotice(m.contentKind)}
                      </p>
                    ) : null}
                    {m.bodyText ? (
                      <p className="m-0 whitespace-pre-wrap text-body text-text [overflow-wrap:anywhere]">{m.bodyText}</p>
                    ) : null}
                    <div className="mt-1 flex flex-wrap items-center justify-end gap-1.5">
                      {outbound && canSimulateStatus ? (
                        <StatusSimulateMenu
                          phoneNumberId={phoneNumberId}
                          waMessageId={m.waMessageId}
                          recipientWaId={recipientWaId}
                          currentStatus={m.status}
                          onSimulated={(status) => handleStatusSimulated(m.id, status)}
                        />
                      ) : null}
                      {m.errorReason ? (
                        <span className="text-label text-danger" title={errorReasonTitle(m.errorReason)}>
                          {m.errorReason === "send_uncertain" ? "Envio incerto" : MESSAGE_STATUS_LABEL.failed}
                        </span>
                      ) : null}
                      <time dateTime={m.createdAt} className="text-label text-text-tertiary">
                        {formatTime(m.createdAt)}
                      </time>
                      {outbound ? <StatusIcon status={m.status} /> : null}
                    </div>
                  </div>
                </li>
              </Fragment>
            );
          })}
        </ul>
      </div>

      {canSend ? (
        <div className="shrink-0 border-t border-border bg-surface px-3 py-3 md:px-4">
          {sendContext ? (
            <WhatsAppComposer conversationId={conversationId} context={sendContext} onSent={handleSent} />
          ) : (
            <Composer conversationId={conversationId} disabled={consentBlocked} onSent={handleSent} />
          )}
        </div>
      ) : (
        <p className="m-0 shrink-0 border-t border-border px-4 py-3 text-meta text-text-tertiary">
          Seu perfil só visualiza as conversas; o envio de mensagens não está disponível.
        </p>
      )}
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

      if (result.ok) {
        // message vem do servidor (texto/status/id realmente persistidos) —
        // nunca fabricado localmente a partir do que estava no textarea.
        onSent(result.message);
        setText("");
        setDedupeKey(crypto.randomUUID());
        return;
      }

      setError(result.error);

      if (result.conflict && result.persisted) {
        // A MESMA client_dedupe_key já tinha sido usada com outro texto —
        // nunca um falso sucesso. Mostra na conversa o que foi REALMENTE
        // enviado da vez anterior e queima a chave antiga: a próxima
        // tentativa (com o texto atual, editado) precisa de uma chave nova,
        // porque a antiga já está permanentemente associada a outro
        // conteúdo (a7-conversas.md §8).
        onSent(result.persisted);
        setDedupeKey(crypto.randomUUID());
      }
    });
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-2">
      {disabled ? (
        <Alert variant="warning">
          <AlertDescription>
            Sem consentimento vigente para WhatsApp — registre o consentimento do contato no painel de contexto antes de
            enviar. <OpenContextButton>Abrir contexto</OpenContextButton>
          </AlertDescription>
        </Alert>
      ) : null}
      <div className="flex items-end gap-2">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          disabled={isPending}
          rows={2}
          maxLength={4096}
          aria-label="Mensagem"
          placeholder="Escreva uma mensagem (simulada)…"
          className="min-w-0 flex-1 resize-none rounded-input border border-border-input bg-surface-subtle px-3 py-2 text-body text-text placeholder:text-text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-ring disabled:opacity-60"
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
        aria-expanded={open}
        className="rounded-full bg-purple-bg px-1.5 py-0.5 text-label font-bold text-purple focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-ring"
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
