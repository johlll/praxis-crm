"use client";

import { useActionState, useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { createLeadNoteAction, type LeadNoteActionState } from "@/modules/lead-notes/actions";
import { sendMessageAction } from "@/modules/conversations/actions";

type ComposerMode = "anotacao" | "mensagem";

const NOTE_INITIAL: LeadNoteActionState = { ok: false };

function NoteComposer({ leadId }: { leadId: string }) {
  const [state, formAction, pending] = useActionState(createLeadNoteAction, NOTE_INITIAL);
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (state.ok) formRef.current?.reset();
  }, [state]);

  return (
    <form ref={formRef} action={formAction} className="flex items-center gap-2">
      <input type="hidden" name="leadId" value={leadId} />
      <input
        name="body"
        placeholder="Escreva uma anotação…"
        maxLength={4000}
        required
        className="h-9 flex-1 rounded-input border border-border-input bg-surface px-3 text-body text-text"
      />
      <Button type="submit" size="sm" disabled={pending}>
        {pending ? "Registrando…" : "Registrar anotação"}
      </Button>
      {state.error ? (
        <Alert variant="danger">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      ) : null}
    </form>
  );
}

function MessageComposer({ conversationId }: { conversationId: string }) {
  const [text, setText] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send() {
    if (!text.trim()) return;
    setPending(true);
    setError(null);
    const dedupeKey = crypto.randomUUID();
    const result = await sendMessageAction(conversationId, text.trim(), dedupeKey);
    setPending(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setText("");
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Escreva uma mensagem de WhatsApp…"
          className="h-9 flex-1 rounded-input border border-border-input bg-surface px-3 text-body text-text"
        />
        <Button type="button" size="sm" onClick={send} disabled={pending}>
          {pending ? "Enviando…" : "Enviar"}
        </Button>
      </div>
      {error ? (
        <Alert variant="danger">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}

export function LeadComposer({
  leadId,
  conversationId,
}: {
  leadId: string;
  /** Conversa já vinculada a este lead — sem ela, "Mensagem" fica
   * desabilitado (a A9 não cria um canal de WhatsApp novo). Criar
   * atividade já tem entrada própria (o "Nova atividade" da
   * `ActivitiesSection`, sempre visível na Visão geral) — o composer não
   * duplica esse botão. */
  conversationId: string | null;
}) {
  const [mode, setMode] = useState<ComposerMode>("anotacao");

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex gap-1 rounded-md bg-surface-subtle p-1">
          <button
            type="button"
            onClick={() => setMode("anotacao")}
            className={`rounded px-2.5 py-1 text-meta font-semibold ${
              mode === "anotacao" ? "bg-surface text-text" : "text-text-secondary"
            }`}
          >
            Anotação
          </button>
          <button
            type="button"
            onClick={() => setMode("mensagem")}
            disabled={!conversationId}
            title={conversationId ? undefined : "Nenhuma conversa vinculada a este lead ainda."}
            className={`rounded px-2.5 py-1 text-meta font-semibold disabled:cursor-not-allowed disabled:opacity-50 ${
              mode === "mensagem" ? "bg-surface text-text" : "text-text-secondary"
            }`}
          >
            Mensagem
          </button>
          <button
            type="button"
            disabled
            title="Anexos entram na fase B4."
            className="rounded px-2.5 py-1 text-meta font-semibold text-text-secondary disabled:cursor-not-allowed disabled:opacity-50"
          >
            Anexo
          </button>
        </div>
      </div>

      {mode === "anotacao" ? <NoteComposer leadId={leadId} /> : null}
      {mode === "mensagem" && conversationId ? <MessageComposer conversationId={conversationId} /> : null}
    </div>
  );
}
