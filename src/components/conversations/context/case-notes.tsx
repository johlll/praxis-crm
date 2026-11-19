"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { TriangleAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import { addCaseNoteAction, loadCaseNotesAction } from "@/modules/case-notes/actions";
import { CASE_NOTE_MAX, normalizeNoteBody, type CaseNote, type CaseNotesCursor, type CaseNotesPage } from "@/modules/case-notes/schema";
import { formatStamp } from "@/modules/conversations/context-format";
import { ContextRetryButton } from "./retry-button";

/**
 * Observações por caso (docs/decisoes/conversas-observacoes-caso.md). Três peças:
 *
 * - `CaseNotesList`: as observações do caso, da mais recente para a mais antiga, com autor e horário; as
 *   anteriores vêm do SERVIDOR por página ("Ver anteriores"). O texto é sempre TEXTO (o React escapa; nada de
 *   HTML), com as quebras de linha preservadas e sem rolagem lateral.
 * - `CaseNotesUnavailable`: a leitura falhou — aviso com nova tentativa, nunca "nenhuma observação".
 * - `CaseNoteComposer`: a escrita, só na edição (lápis). Diz em qual caso a observação será registrada, tem
 *   uma chave de idempotência por intenção e protege o rascunho: trocar de caso ou sair com texto não
 *   registrado pede confirmação antes de descartar. Cada caso tem a SUA instância (chave `case_note:<caso>`),
 *   então rascunho, erro e confirmação de um caso nunca passam para outro.
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
      const result = await loadCaseNotesAction({ opportunityId: target, before: cursor.before, beforeId: cursor.beforeId });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      // Só entra se ainda for o MESMO caso e o mesmo ponto da lista (resposta atrasada não mistura casos).
      setState((prev) =>
        prev.opportunityId === target && prev.next?.beforeId === cursor.beforeId
          ? { ...prev, items: appendUnique(prev.items, result.page.items), next: result.page.next }
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

export function CaseNoteComposer({ opportunityId, caseLabel }: { opportunityId: string; caseLabel: string }) {
  const router = useRouter();
  const [body, setBody] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [leaving, setLeaving] = useState<string | null>(null);
  const [saving, start] = useTransition();
  const [refreshing, startRefresh] = useTransition();
  const intent = useRef<{ sig: string; key: string } | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  const normalized = normalizeNoteBody(body);
  const dirty = normalized.length > 0;
  const tooLong = normalized.length > CASE_NOTE_MAX;

  // Sair com texto não registrado: os links internos param e a tela pede confirmação; fechar ou recarregar a
  // aba usa o aviso do navegador. O rascunho da mensagem do WhatsApp não é tocado.
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
    function onBeforeUnload(e: BeforeUnloadEvent) {
      e.preventDefault();
      e.returnValue = "";
    }
    document.addEventListener("click", onClick, true);
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      document.removeEventListener("click", onClick, true);
      window.removeEventListener("beforeunload", onBeforeUnload);
    };
  }, [dirty]);

  function keyFor(sig: string): string {
    if (!intent.current || intent.current.sig !== sig) intent.current = { sig, key: crypto.randomUUID() };
    return intent.current.key;
  }

  function submit() {
    if (!dirty || tooLong || saving) return;
    const text = normalized;
    const key = keyFor(`${opportunityId}:${text}`);
    setError(null);
    setDone(null);
    setLeaving(null);
    start(async () => {
      const result = await addCaseNoteAction({ opportunityId, body: text, idempotencyKey: key });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      intent.current = null;
      setBody("");
      setLeaving(null);
      setDone(
        result.replayed
          ? "Esta observação já estava registrada neste caso."
          : `Observação registrada em ${formatStamp(result.note.createdAt)}.`,
      );
      startRefresh(() => router.refresh());
    });
  }

  function discardAndLeave() {
    const dest = leaving;
    setBody("");
    intent.current = null;
    setLeaving(null);
    if (dest) router.push(dest as never);
  }

  const busy = saving || refreshing;
  return (
    <div ref={boxRef} className="flex flex-col gap-2">
      <label htmlFor={`obs-${opportunityId}`} className="text-small font-semibold text-text">
        Nova observação para <span className="text-primary">{caseLabel}</span>
      </label>
      <textarea
        id={`obs-${opportunityId}`}
        value={body}
        onChange={(e) => {
          setBody(e.target.value);
          setDone(null);
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
      <Button type="button" size="sm" className="w-fit" disabled={!dirty || tooLong || busy} onClick={submit}>
        {saving ? "Registrando…" : refreshing ? "Atualizando…" : "Registrar observação"}
      </Button>
    </div>
  );
}
