"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { TriangleAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import { addCaseNoteAction, loadCaseNotesAction } from "@/modules/case-notes/actions";
import { CASE_NOTE_MAX, normalizeNoteBody, type CaseNote, type CaseNotesCursor, type CaseNotesPage } from "@/modules/case-notes/schema";
import { formatStamp } from "@/modules/conversations/context-format";
import { readCaseNoteDraft, useCaseNoteDraft, writeCaseNoteDraft } from "./case-note-drafts";
import { ContextRetryButton } from "./retry-button";

/**
 * Observações por caso (docs/decisoes/conversas-observacoes-caso.md). Quatro peças:
 *
 * - `CaseNotesList`: as observações do caso, da mais recente para a mais antiga, com autor e horário; as
 *   anteriores vêm do SERVIDOR por página ("Ver anteriores"). O texto é sempre TEXTO (o React escapa; nada de
 *   HTML), com as quebras de linha preservadas e sem rolagem lateral.
 * - `CaseNotesUnavailable`: a leitura falhou — aviso com nova tentativa, nunca "nenhuma observação".
 * - `CaseNoteComposer`: a escrita, só na edição (lápis). Diz em qual caso a observação será registrada, tem
 *   uma chave de idempotência por intenção e protege o rascunho: um link interno com texto não registrado pede
 *   confirmação antes de descartar; Voltar/Avançar e a troca de caso não descartam — o rascunho fica guardado na
 *   memória da aba, por caso (case-note-drafts.ts), e volta quando a pessoa retorna. Rascunho, erro e confirmação
 *   de um caso nunca passam para outro. Uma chamada sem resposta vira aviso de resultado desconhecido, com o
 *   texto e a chave mantidos para a nova tentativa.
 * - `CaseNoteDraftHint`: no Resumo, avisa que o caso tem observação não registrada guardada na aba.
 */

// ---------------------------------------------------------------------
// Lista
// ---------------------------------------------------------------------

function appendUnique(items: CaseNote[], more: CaseNote[]): CaseNote[] {
  const seen = new Set(items.map((n) => n.id));
  return [...items, ...more.filter((n) => !seen.has(n.id))];
}

export function CaseNoteItem({ note }: { note: CaseNote }) {
  return (
    <li className="flex min-w-0 flex-col gap-1 rounded-input border border-border-subtle bg-surface-subtle px-3 py-2.5">
      <p className="m-0 whitespace-pre-wrap text-small text-text [overflow-wrap:anywhere]">{note.body}</p>
      <p className="m-0 text-meta text-text-tertiary">
        {note.authorName ?? "Alguém da equipe"} · <time dateTime={note.createdAt}>{formatStamp(note.createdAt)}</time>
      </p>
    </li>
  );
}

export function CaseNotesList({
  opportunityId,
  initial,
  emptyText = "Nenhuma observação registrada neste caso.",
}: {
  opportunityId: string;
  initial: CaseNotesPage;
  emptyText?: string;
}) {
  const [state, setState] = useState<{ opportunityId: string; items: CaseNote[]; next: CaseNotesCursor | null }>(() => ({
    opportunityId,
    items: initial.items,
    next: initial.next,
  }));
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function loadMore() {
    const cursor = state.next;
    if (!cursor) return;
    const target = state.opportunityId;
    setError(null);
    start(async () => {
      let result: Awaited<ReturnType<typeof loadCaseNotesAction>>;
      try {
        result = await loadCaseNotesAction({ opportunityId: target, before: cursor.before, beforeId: cursor.beforeId });
      } catch {
        // Chamada sem resposta (transporte): avisa e deixa tentar de novo com o mesmo cursor, sem derrubar o painel.
        result = { ok: false, error: "Não foi possível carregar as observações anteriores. Tente de novo." };
      }
      if (!result.ok) {
        setError(result.error);
        return;
      }
      // Só entra se ainda for o MESMO caso e o mesmo ponto da lista (resposta atrasada não mistura casos).
      const page = result.page;
      setState((prev) =>
        prev.opportunityId === target && prev.next?.beforeId === cursor.beforeId
          ? { ...prev, items: appendUnique(prev.items, page.items), next: page.next }
          : prev,
      );
    });
  }

  if (state.items.length === 0 && !state.next) {
    return <p className="m-0 text-meta text-text-tertiary">{emptyText}</p>;
  }

  return (
    <div className="flex min-w-0 flex-col gap-2.5">
      <ol className="m-0 flex list-none flex-col gap-2 p-0" aria-label="Observações do caso, da mais recente para a mais antiga">
        {state.items.map((n) => (
          <CaseNoteItem key={n.id} note={n} />
        ))}
      </ol>
      {error ? (
        <p role="alert" className="m-0 text-meta text-danger">
          {error}
        </p>
      ) : null}
      {state.next ? (
        <Button type="button" size="sm" variant="secondary" className="w-fit" disabled={pending} onClick={loadMore}>
          {pending ? "Carregando…" : error ? "Tentar de novo" : "Ver anteriores"}
        </Button>
      ) : null}
    </div>
  );
}

export function CaseNotesUnavailable() {
  return (
    <div role="alert" className="flex flex-col gap-1.5 rounded-input border border-danger/25 bg-danger-bg px-3 py-2.5">
      <p className="m-0 flex items-center gap-2 text-small font-semibold text-text">
        <TriangleAlert size={14} className="text-danger" aria-hidden />
        Não foi possível carregar as observações deste caso
      </p>
      <p className="m-0 text-meta text-text-secondary">As observações registradas continuam salvas. Tente novamente em instantes.</p>
      <ContextRetryButton />
    </div>
  );
}

// ---------------------------------------------------------------------
// Escrita
// ---------------------------------------------------------------------

/** Destino interno diferente da tela atual (outra conversa, outro caso, outra aba, fechar a edição…). */
function leavesCurrentScreen(anchor: HTMLAnchorElement): string | null {
  if (anchor.target && anchor.target !== "_self") return null;
  if (anchor.hasAttribute("download")) return null;
  const raw = anchor.getAttribute("href");
  if (!raw || raw.startsWith("#")) return null;
  const url = new URL(anchor.href, window.location.href);
  if (url.origin !== window.location.origin) return null;
  const here = window.location.pathname + window.location.search;
  const there = url.pathname + url.search;
  return there === here ? null : there + url.hash;
}

/** A chamada não teve resposta (rede caiu, servidor reiniciou…): o resultado é DESCONHECIDO, não uma falha certa. */
export const CASE_NOTE_TRANSPORT_FAILED =
  "Não foi possível confirmar se a observação foi registrada: a conexão falhou antes da resposta. O texto continua aqui. Tente de novo — se ela já tiver sido registrada, não será duplicada.";

export function CaseNoteComposer({
  opportunityId,
  caseLabel,
  draftScope,
}: {
  opportunityId: string;
  caseLabel: string;
  /** Escritório:pessoa — o rascunho guardado na aba é desta pessoa neste escritório. */
  draftScope: string;
}) {
  const router = useRouter();
  const draft = useCaseNoteDraft(draftScope, opportunityId);
  const [leaving, setLeaving] = useState<string | null>(null);
  // Voltou para um caso com texto guardado (Voltar/Avançar, troca de caso): avisa que é um rascunho recuperado.
  const [restored, setRestored] = useState(() => {
    const d = readCaseNoteDraft(draftScope, opportunityId);
    return !d.saving && normalizeNoteBody(d.body).length > 0;
  });
  const [refreshing, startRefresh] = useTransition();
  const mounted = useRef(false);
  const boxRef = useRef<HTMLDivElement>(null);

  const { body, saving, error, done } = draft;
  const normalized = normalizeNoteBody(body);
  const dirty = normalized.length > 0;
  const tooLong = normalized.length > CASE_NOTE_MAX;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      // A confirmação de sucesso é vista uma vez: ao sair, some. Texto, erro e gravação em andamento ficam guardados.
      if (readCaseNoteDraft(draftScope, opportunityId).done) writeCaseNoteDraft(draftScope, opportunityId, { done: null }, { settle: true });
    };
  }, [draftScope, opportunityId]);

  // Links internos com texto não registrado: param e a tela pede confirmação antes de descartar. Voltar/Avançar e
  // a desmontagem não descartam nada (o rascunho fica guardado na aba); fechar ou recarregar a aba usa o aviso do
  // navegador (case-note-drafts.ts). O rascunho da mensagem do WhatsApp não é tocado.
  useEffect(() => {
    if (!dirty) return;
    function onClick(e: MouseEvent) {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const anchor = (e.target as Element | null)?.closest?.("a");
      if (!anchor || boxRef.current?.contains(anchor)) return;
      const dest = leavesCurrentScreen(anchor as HTMLAnchorElement);
      if (!dest) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      setLeaving(dest);
      boxRef.current?.scrollIntoView?.({ block: "nearest" });
    }
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, [dirty]);

  async function submit() {
    // Lê o guardado (não o render): um segundo clique antes de a tela atualizar já vê a gravação em andamento.
    const current = readCaseNoteDraft(draftScope, opportunityId);
    const text = normalizeNoteBody(current.body);
    if (!text || text.length > CASE_NOTE_MAX || current.saving) return;
    // Alvo e escopo presos a ESTA chamada: a resposta vai para este caso, mesmo que a tela já mostre outro.
    const target = opportunityId;
    const scopeAtSubmit = draftScope;
    const sig = `${target}:${text}`;
    const intent = current.intent?.sig === sig ? current.intent : { sig, key: crypto.randomUUID() };
    writeCaseNoteDraft(scopeAtSubmit, target, { intent, saving: true, error: null, done: null });
    setLeaving(null);
    setRestored(false);

    let result: Awaited<ReturnType<typeof addCaseNoteAction>>;
    try {
      result = await addCaseNoteAction({ opportunityId: target, body: text, idempotencyKey: intent.key });
    } catch {
      // Sem resposta: o banco pode ter gravado. Mantém texto e chave (a nova tentativa reencontra o mesmo pedido).
      writeCaseNoteDraft(scopeAtSubmit, target, { saving: false, error: CASE_NOTE_TRANSPORT_FAILED }, { settle: true });
      return;
    }
    if (!result.ok) {
      writeCaseNoteDraft(scopeAtSubmit, target, { saving: false, error: result.error }, { settle: true });
      return;
    }
    writeCaseNoteDraft(
      scopeAtSubmit,
      target,
      {
        body: "",
        intent: null,
        saving: false,
        error: null,
        done: result.replayed
          ? "Esta observação já estava registrada neste caso."
          : `Observação registrada em ${formatStamp(result.note.createdAt)}.`,
      },
      { settle: true },
    );
    if (mounted.current) startRefresh(() => router.refresh());
    else router.refresh();
  }

  function discardAndLeave() {
    const dest = leaving;
    writeCaseNoteDraft(draftScope, opportunityId, { body: "", intent: null, error: null, done: null });
    setRestored(false);
    setLeaving(null);
    if (dest) router.push(dest as never);
  }

  const busy = saving || refreshing;
  return (
    <div ref={boxRef} className="flex flex-col gap-2">
      <label htmlFor={`obs-${opportunityId}`} className="text-small font-semibold text-text">
        Nova observação para <span className="text-primary">{caseLabel}</span>
      </label>
      {restored && dirty && !saving ? (
        <p className="m-0 text-meta text-text-secondary">Rascunho recuperado: este texto ainda não foi registrado.</p>
      ) : null}
      <textarea
        id={`obs-${opportunityId}`}
        value={body}
        onChange={(e) => {
          writeCaseNoteDraft(draftScope, opportunityId, { body: e.target.value, done: null });
          setLeaving(null);
        }}
        rows={4}
        disabled={saving}
        aria-describedby={`obs-${opportunityId}-dica`}
        className="min-h-[96px] w-full resize-y rounded-input border border-border bg-surface px-3 py-2 text-small text-text placeholder:text-text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-ring disabled:opacity-60"
        placeholder="Escreva o que a equipe precisa saber sobre este caso."
      />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p id={`obs-${opportunityId}-dica`} className="m-0 text-meta text-text-tertiary">
          Fica registrada com seu nome e o horário. Não é editada nem excluída: para corrigir, registre outra.
        </p>
        <span className={tooLong ? "text-meta font-semibold text-danger" : "text-meta tabular-nums text-text-tertiary"}>
          {normalized.length.toLocaleString("pt-BR")} / {CASE_NOTE_MAX.toLocaleString("pt-BR")}
        </span>
      </div>

      {leaving ? (
        <div role="alertdialog" aria-label="Observação não registrada" className="flex flex-col gap-2 rounded-input border border-warning/30 bg-warning-bg p-3">
          <p className="m-0 text-small text-text">
            A observação para <span className="font-semibold">{caseLabel}</span> ainda não foi registrada.{" "}
            {saving ? "Ela está sendo enviada agora; aguarde a confirmação." : "Se você sair agora, o texto será descartado."}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" variant="secondary" onClick={() => setLeaving(null)}>
              Continuar escrevendo
            </Button>
            {saving ? null : (
              <Button type="button" size="sm" variant="secondary" onClick={discardAndLeave}>
                Descartar e sair
              </Button>
            )}
          </div>
        </div>
      ) : null}

      <div aria-live="polite" className="flex flex-col gap-1">
        {error ? <p role="alert" className="m-0 text-meta text-danger">{error}</p> : null}
        {done ? <p className="m-0 text-meta font-semibold text-success">{done}</p> : null}
      </div>
      <Button type="button" size="sm" className="w-fit" disabled={!dirty || tooLong || busy} onClick={() => void submit()}>
        {saving ? "Registrando…" : refreshing ? "Atualizando…" : "Registrar observação"}
      </Button>
    </div>
  );
}

/**
 * No Resumo (consulta): avisa que este caso tem uma observação não registrada guardada na aba (deixada pelo
 * Voltar/Avançar ou pela troca de caso) ou ainda sendo enviada, com o caminho de volta para a edição.
 */
export function CaseNoteDraftHint({ opportunityId, draftScope, href }: { opportunityId: string; draftScope: string; href: string }) {
  const draft = useCaseNoteDraft(draftScope, opportunityId);
  const pendingText = normalizeNoteBody(draft.body).length > 0;
  if (!draft.saving && !pendingText) return null;
  return (
    <p role="status" className="m-0 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-input border border-warning/30 bg-warning-bg px-3 py-2 text-meta text-text">
      {draft.saving ? (
        <span>Uma observação deste caso está sendo enviada.</span>
      ) : (
        <>
          <span>Há uma observação não registrada neste caso{draft.error ? " (o envio não foi confirmado)" : ""}.</span>
          <Link href={href as never} className="font-semibold text-primary hover:underline">
            Continuar escrevendo
          </Link>
        </>
      )}
    </p>
  );
}
