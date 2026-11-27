"use client";

import { useEffect, useId, useRef, useState, useTransition, type FormEvent, type KeyboardEvent } from "react";
import { ArrowUp, FlaskConical, LoaderCircle, Sparkles, X } from "lucide-react";

import { cn } from "@/lib/cn";
import { askAssistantAction } from "@/modules/assistant/actions";
import type { AssistantBlock, AssistantReply, RegistrationDraft } from "@/modules/assistant/types";
import { AssistantBlocks } from "./assistant-blocks";

export const SUGGESTIONS = ["O que precisa da minha atenção hoje?", "Cadastre um cliente"] as const;

type ChatMessage =
  | { id: string; role: "user"; text: string }
  | { id: string; role: "assistant"; blocks: AssistantBlock[]; simulated: boolean };

let sequence = 0;
const nextId = () => `m${(sequence += 1)}`;

/**
 * A conversa vive só nesta tela (não é gravada). O rascunho de cadastro em aberto vai junto de cada
 * mensagem e o servidor o valida de novo; o escritório nunca sai daqui, vem da sessão.
 */
export function AssistantChat({ firstName }: { firstName: string }) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [pending, setPending] = useState<RegistrationDraft | null>(null);
  const [text, setText] = useState("");
  const [sending, startSending] = useTransition();
  const [simulated, setSimulated] = useState(true);
  const scroller = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const hintId = useId();

  // Nova mensagem ou resposta: a conversa desce até o fim.
  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [messages, sending]);

  function send(raw: string) {
    const message = raw.trim();
    if (!message || sending) return;
    setText("");
    setMessages((current) => [...current, { id: nextId(), role: "user", text: message }]);
    startSending(async () => {
      let answer: AssistantReply;
      try {
        answer = await askAssistantAction({ text: message, pending });
      } catch {
        answer = {
          blocks: [{ type: "error", text: "Não consegui falar com o servidor. Confira a conexão e tente de novo." }],
          pending,
          interpreter: { id: "indisponivel", simulated },
        };
      }
      setSimulated(answer.interpreter.simulated);
      setPending(answer.pending);
      setMessages((current) => [...current, { id: nextId(), role: "assistant", blocks: answer.blocks, simulated: answer.interpreter.simulated }]);
    });
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    send(text);
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      send(text);
    }
  }

  /** Um cartão terminou (confirmado, cancelado, trocado por outro): troca o bloco no lugar. */
  function replaceBlock(messageId: string, index: number, blocks: AssistantBlock[]) {
    setMessages((current) =>
      current.map((m) => (m.id === messageId && m.role === "assistant" ? { ...m, blocks: [...m.blocks.slice(0, index), ...blocks, ...m.blocks.slice(index + 1)] } : m)),
    );
  }

  const empty = messages.length === 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto px-4 pt-2 pb-4 md:px-5" aria-live="polite" aria-busy={sending}>
        <div className="mx-auto flex w-full max-w-[860px] flex-col gap-4">
          {simulated ? (
            <p
              role="note"
              className="m-0 flex items-start gap-2 self-start rounded-md border border-purple/30 bg-purple-bg px-3 py-2 text-small text-purple"
            >
              <FlaskConical size={14} aria-hidden className="mt-0.5 shrink-0" />
              <span>
                <strong>Interpretação simulada.</strong> Neste ciclo as mensagens são lidas por regras fixas, sem provedor de IA.
                Consultas e cadastros usam os dados reais do CRM, com as suas permissões.
              </span>
            </p>
          ) : null}

          {empty ? (
            <div className="flex flex-col items-start gap-4 py-6 md:py-10">
              <span className="flex size-11 items-center justify-center rounded-card bg-primary-tint text-primary" aria-hidden>
                <Sparkles size={20} />
              </span>
              <div className="flex flex-col gap-1">
                <h2 className="m-0 text-[20px] leading-tight font-bold text-text">Olá, {firstName}. Como posso ajudar?</h2>
                <p className="m-0 max-w-[60ch] text-body text-text-secondary">
                  Posso mostrar o que precisa da sua atenção hoje e cadastrar uma pessoa com um caso. Antes de gravar qualquer coisa,
                  mostro um cartão para você conferir.
                </p>
              </div>
              <div className="flex flex-wrap gap-2" role="group" aria-label="Sugestões">
                {SUGGESTIONS.map((suggestion) => (
                  <button
                    key={suggestion}
                    type="button"
                    onClick={() => send(suggestion)}
                    disabled={sending}
                    className="rounded-pill border border-border bg-surface px-3.5 py-2 text-left text-body text-text transition-colors hover:border-primary-border hover:bg-surface-hover active:bg-primary-tint disabled:opacity-60"
                  >
                    {suggestion}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          {messages.map((message) =>
            message.role === "user" ? (
              <div key={message.id} className="flex justify-end">
                <p className="m-0 max-w-[min(560px,85%)] rounded-[14px] rounded-br-sm bg-primary-tint px-3.5 py-2 text-body whitespace-pre-wrap text-text">
                  <span className="sr-only">Você: </span>
                  {message.text}
                </p>
              </div>
            ) : (
              <div key={message.id} className="flex items-start gap-2.5">
                <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-primary-tint text-primary" aria-hidden>
                  <Sparkles size={14} />
                </span>
                <div className="flex min-w-0 flex-1 flex-col gap-2.5">
                  <span className="sr-only">Assistente: </span>
                  <AssistantBlocks
                    blocks={message.blocks}
                    onReplace={(index, blocks) => replaceBlock(message.id, index, blocks)}
                    onDraftClosed={() => setPending(null)}
                  />
                </div>
              </div>
            ),
          )}

          {sending ? (
            <div className="flex items-center gap-2.5 text-small text-text-tertiary" role="status">
              <span className="flex size-7 items-center justify-center rounded-full bg-primary-tint text-primary" aria-hidden>
                <LoaderCircle size={14} className="animate-spin" />
              </span>
              Consultando o CRM…
            </div>
          ) : null}
        </div>
      </div>

      <div className="shrink-0 border-t border-border-subtle bg-app px-4 pt-3 pb-4 md:px-5">
        <form onSubmit={onSubmit} className="mx-auto flex w-full max-w-[860px] flex-col gap-2" aria-label="Enviar mensagem ao Assistente">
          {pending ? (
            <p id={hintId} className="m-0 flex items-center gap-2 text-meta text-text-tertiary">
              <span>Cadastro em andamento{pending.name ? ` de ${pending.name}` : ""}: responda à pergunta acima.</span>
              <button
                type="button"
                onClick={() => send("Cancelar")}
                disabled={sending}
                className="inline-flex items-center gap-1 rounded-sm font-semibold text-text-secondary hover:text-text"
              >
                <X size={12} aria-hidden />
                Cancelar cadastro
              </button>
            </p>
          ) : null}
          <div className="flex items-end gap-2 rounded-[14px] border border-border-input bg-surface p-1.5 pl-3 focus-within:border-primary focus-within:ring-2 focus-within:ring-primary-ring">
            <label htmlFor="assistente-mensagem" className="sr-only">
              Mensagem
            </label>
            <textarea
              ref={field}
              id="assistente-mensagem"
              rows={1}
              value={text}
              onChange={(event) => setText(event.target.value)}
              onKeyDown={onKeyDown}
              maxLength={2000}
              aria-describedby={pending ? hintId : undefined}
              placeholder={pending ? "Escreva a resposta…" : "Pergunte ou peça algo ao Assistente…"}
              className="field-sizing-content max-h-40 min-h-9 flex-1 resize-none border-0 bg-transparent py-2 text-body text-text placeholder:text-text-muted focus:outline-none"
            />
            <button
              type="submit"
              disabled={sending || !text.trim()}
              aria-label="Enviar"
              className={cn(
                "flex size-9 shrink-0 items-center justify-center rounded-[10px] bg-primary text-on-solid transition-colors hover:bg-primary-hover",
                "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-text disabled:cursor-not-allowed disabled:opacity-40",
              )}
            >
              {sending ? <LoaderCircle size={16} className="animate-spin" aria-hidden /> : <ArrowUp size={16} aria-hidden />}
            </button>
          </div>
          <p className="m-0 hidden text-meta text-text-muted md:block">Enter envia · Shift+Enter quebra a linha</p>
        </form>
      </div>
    </div>
  );
}
