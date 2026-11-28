"use client";

import { useEffect, useId, useRef, useState, useTransition, type FormEvent, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
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

/** Troca suave entre a abertura e a conversa; sem animação para quem pediu menos movimento. */
const MOTION = "duration-300 ease-out motion-reduce:transition-none";

/**
 * A conversa vive só nesta tela (não é gravada). O rascunho de cadastro em aberto vai junto de cada
 * mensagem e o servidor o valida de novo; o escritório nunca sai daqui, vem da sessão.
 *
 * Duas apresentações com o MESMO campo de mensagem (o mesmo elemento, então o foco não se perde):
 * - abertura, antes da primeira mensagem: saudação, campo e sugestões centralizados na área do
 *   Assistente, um pouco acima do meio (os espaços acima e abaixo crescem na proporção 2:3);
 * - conversa: as mensagens ocupam a área e o campo fica no rodapé.
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
  const headingId = useId();

  const empty = messages.length === 0;

  const lastPlaced = useRef<string | null>(null);

  /**
   * Onde a conversa para depois de cada mensagem nova:
   * - pergunta enviada (e "Consultando o CRM…"): desce até o fim;
   * - resposta nova: o INÍCIO dela fica à vista, com um pedaço da pergunta acima quando houver espaço. Resposta
   *   curta cabe inteira (a rolagem para no fim sozinha); resposta longa, como o diagnóstico, mostra o resumo e o
   *   começo da primeira parte, e o resto fica abaixo, para rolar.
   * Cartões trocados no lugar (confirmar, cancelar) não mexem na rolagem.
   */
  useEffect(() => {
    const el = scroller.current;
    const last = messages.at(-1);
    if (!el || !last) return;
    const behavior: ScrollBehavior = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
    if (last.role === "user") {
      el.scrollTo({ top: el.scrollHeight, behavior });
      return;
    }
    if (lastPlaced.current === last.id) return;
    const place = () => {
      lastPlaced.current = last.id;
      const reply = el.querySelector<HTMLElement>(`[data-message-id="${last.id}"]`);
      if (!reply) return;
      const question = reply.previousElementSibling as HTMLElement | null;
      const base = el.getBoundingClientRect().top - el.scrollTop;
      const replyTop = reply.getBoundingClientRect().top - base;
      const questionTop = question ? question.getBoundingClientRect().top - base : replyTop;
      // Até 15% da área (no máximo 72 px) mostra o fim da pergunta; o resto vai para a resposta. Em área pequena
      // (celular com teclado aberto) a resposta começa no topo, sem meia linha cortada da pergunta.
      const lead = el.clientHeight < 320 ? 0 : Math.min(replyTop - questionTop, el.clientHeight * 0.15, 72);
      el.scrollTo({ top: Math.max(0, replyTop - lead - 12), behavior });
    };
    // Primeira resposta: espera o campo terminar de descer (a área de conversa ainda está crescendo).
    if (messages.length <= 2 && behavior === "smooth") {
      const timer = window.setTimeout(place, 320);
      return () => window.clearTimeout(timer);
    }
    place();
  }, [messages]);

  // Enquanto consulta, o aviso "Consultando o CRM…" aparece no fim.
  useEffect(() => {
    const el = scroller.current;
    if (el && sending && messages.at(-1)?.role === "user") el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [sending, messages]);

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

  /**
   * Sugestão escolhida. As sugestões somem com o primeiro envio; quem as acionou pelo teclado (clique sem
   * ponteiro, `detail === 0`) continua no campo de mensagem. Por toque o foco não vai ao campo, para não
   * abrir o teclado do celular sem pedido.
   */
  function onSuggestion(event: MouseEvent<HTMLButtonElement>, suggestion: string) {
    send(suggestion);
    if (event.detail === 0) field.current?.focus();
  }

  /** Um cartão terminou (confirmado, cancelado, trocado por outro): troca o bloco no lugar. */
  function replaceBlock(messageId: string, index: number, blocks: AssistantBlock[]) {
    setMessages((current) =>
      current.map((m) => (m.id === messageId && m.role === "assistant" ? { ...m, blocks: [...m.blocks.slice(0, index), ...blocks, ...m.blocks.slice(index + 1)] } : m)),
    );
  }

  return (
    // Na abertura, se a altura não couber (celular com teclado aberto), a área inteira rola em vez de cortar.
    <div className={cn("flex min-h-0 flex-1 flex-col", empty && "overflow-y-auto")} data-state={empty ? "abertura" : "conversa"}>
      {simulated ? (
        <div className="flex shrink-0 justify-center px-4 pt-3 md:px-5">
          <p
            role="note"
            className="m-0 inline-flex max-w-[760px] items-start gap-1.5 rounded-[12px] border sm:rounded-pill border-purple/30 bg-purple-bg px-3 py-1 text-meta leading-snug text-purple"
          >
            <FlaskConical size={12} aria-hidden className="mt-px shrink-0" />
            <span>
              <strong>Interpretação simulada</strong>, sem provedor de IA. Consultas e cadastros usam os dados reais do CRM.
            </span>
          </p>
        </div>
      ) : null}

      {/* Conversa. Na abertura é só o espaço acima do conjunto central (2 partes). */}
      <div
        ref={scroller}
        className={cn("min-h-0 overflow-y-auto px-4 md:px-5", MOTION, "transition-[flex-grow]", empty ? "grow-[2] basis-0" : "grow basis-0 pt-3 pb-4")}
        aria-live="polite"
        aria-busy={sending}
      >
        {empty ? null : (
          <div className="mx-auto flex w-full max-w-[860px] flex-col gap-4">
            {messages.map((message) =>
              message.role === "user" ? (
                <div key={message.id} data-message-id={message.id} className="flex justify-end">
                  <p className="m-0 max-w-[min(560px,85%)] rounded-[14px] rounded-br-sm bg-primary-tint px-3.5 py-2 text-body whitespace-pre-wrap text-text">
                    <span className="sr-only">Você: </span>
                    {message.text}
                  </p>
                </div>
              ) : (
                <div key={message.id} data-message-id={message.id} className="flex items-start gap-2.5">
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
        )}
      </div>

      {/* O mesmo campo nas duas apresentações: no centro, com saudação e sugestões; depois, no rodapé. */}
      <section
        aria-labelledby={empty ? headingId : undefined}
        aria-label={empty ? undefined : "Nova mensagem"}
        className={cn(
          "shrink-0 px-4 md:px-5",
          MOTION,
          "transition-[padding,background-color,border-color]",
          empty ? "border-t border-transparent py-2" : "border-t border-border-subtle bg-app pt-3 pb-4",
        )}
      >
        <div className={cn("mx-auto flex w-full flex-col", MOTION, "transition-[max-width]", empty ? "max-w-[740px]" : "max-w-[860px]")}>
          <Collapsible open={empty}>
            <h2 id={headingId} className="m-0 pb-5 text-center text-[20px] leading-tight font-bold text-text md:pb-6 md:text-[26px]">
              Como posso ajudar, {firstName}?
            </h2>
          </Collapsible>

          <form onSubmit={onSubmit} className="flex flex-col gap-2" aria-label="Enviar mensagem ao Assistente">
            {pending ? (
              <p id={hintId} className="m-0 flex flex-wrap items-center gap-x-2 gap-y-1 text-meta text-text-tertiary">
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
            <div
              className={cn(
                "flex items-end gap-2 border border-border-input bg-surface focus-within:border-primary focus-within:ring-2 focus-within:ring-primary-ring",
                MOTION,
                "transition-[padding,border-radius,box-shadow]",
                empty ? "rounded-[20px] p-2 pl-4 shadow-raised" : "rounded-[14px] p-1.5 pl-3",
              )}
            >
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
                placeholder={pending ? "Escreva a resposta…" : empty ? "Pergunte ou peça algo…" : "Escreva uma mensagem…"}
                className={cn(
                  "field-sizing-content max-h-40 flex-1 resize-none border-0 bg-transparent text-text placeholder:text-text-muted focus:outline-none",
                  empty ? "min-h-11 py-2.5 text-lead" : "min-h-9 py-2 text-body",
                )}
              />
              <button
                type="submit"
                disabled={sending || !text.trim()}
                aria-label="Enviar"
                className={cn(
                  "flex shrink-0 items-center justify-center rounded-[12px] bg-primary text-on-solid transition-colors hover:bg-primary-hover",
                  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-text disabled:cursor-not-allowed disabled:opacity-40",
                  empty ? "size-11" : "size-9",
                )}
              >
                {sending ? <LoaderCircle size={16} className="animate-spin" aria-hidden /> : <ArrowUp size={empty ? 18 : 16} aria-hidden />}
              </button>
            </div>
            {empty ? null : <p className="m-0 hidden text-meta text-text-muted md:block">Enter envia · Shift+Enter quebra a linha</p>}
          </form>

          <Collapsible open={empty}>
            <div className="flex flex-wrap justify-center gap-2 pt-4" role="group" aria-label="Sugestões">
              {SUGGESTIONS.map((suggestion) => (
                <button
                  key={suggestion}
                  type="button"
                  onClick={(event) => onSuggestion(event, suggestion)}
                  disabled={sending || !empty}
                  tabIndex={empty ? undefined : -1}
                  className="rounded-pill border border-border bg-surface px-3.5 py-2 text-center text-body text-text transition-colors hover:border-primary-border hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary active:bg-primary-tint disabled:opacity-60"
                >
                  {suggestion}
                </button>
              ))}
            </div>
          </Collapsible>
        </div>
      </section>

      {/* Espaço abaixo do conjunto na abertura (3 partes, por isso ele fica um pouco acima do meio). */}
      <div aria-hidden className={cn("min-h-0 basis-0", MOTION, "transition-[flex-grow]", empty ? "grow-[3]" : "grow-0")} />
    </div>
  );
}

/** Mostra ou recolhe um trecho com transição de altura, sem deixá-lo acessível quando fechado. */
function Collapsible({ open, children }: { open: boolean; children: ReactNode }) {
  return (
    <div
      className={cn("grid", MOTION, "transition-[grid-template-rows,opacity]", open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0")}
      inert={!open}
      aria-hidden={!open}
    >
      <div className="min-h-0 overflow-hidden">{children}</div>
    </div>
  );
}
