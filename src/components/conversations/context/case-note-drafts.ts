import { useEffect, useSyncExternalStore } from "react";

import { normalizeNoteBody } from "@/modules/case-notes/schema";

/**
 * Rascunhos das observações por caso, guardados SÓ na memória desta aba (docs/decisoes/conversas-observacoes-caso.md).
 *
 * Voltar/Avançar do navegador e a troca de caso mudam a URL e desmontam o editor; a navegação pelo histórico não
 * pode ser interrompida com segurança. Por isso o rascunho não vive dentro do componente: fica aqui, por caso, e
 * volta quando a pessoa retorna ao caso. A gravação em andamento também escreve aqui o resultado (registrada,
 * falhou, resultado desconhecido), sempre no caso de ORIGEM, mesmo que o editor já não esteja na tela.
 *
 * - Nada vai para o servidor, `localStorage`, `sessionStorage` ou IndexedDB: recarregar ou fechar a aba perde o
 *   rascunho, e por isso o navegador pede confirmação enquanto houver algum guardado.
 * - O escopo é escritório + pessoa: outra pessoa (ou outro escritório) na mesma aba começa vazia, e os rascunhos
 *   anteriores são esquecidos.
 */

export type CaseNoteDraft = {
  /** Texto como foi digitado. */
  body: string;
  /** Chave de idempotência da intenção atual (caso + texto normalizado). Repetir a mesma intenção reusa a chave. */
  intent: { sig: string; key: string } | null;
  saving: boolean;
  error: string | null;
  done: string | null;
};

const EMPTY: CaseNoteDraft = Object.freeze({ body: "", intent: null, saving: false, error: null, done: null });

let scope: string | null = null;
const drafts = new Map<string, CaseNoteDraft>();
const listeners = new Set<() => void>();
let unloadGuardInstalled = false;

function notify() {
  for (const l of listeners) l();
}

/** Há texto não registrado (ou uma gravação sem resposta) em algum caso desta pessoa nesta aba. */
export function hasUnsavedCaseNotes(): boolean {
  for (const d of drafts.values()) if (d.saving || normalizeNoteBody(d.body).length > 0) return true;
  return false;
}

function installUnloadGuard() {
  if (unloadGuardInstalled || typeof window === "undefined") return;
  unloadGuardInstalled = true;
  window.addEventListener("beforeunload", (e) => {
    if (!hasUnsavedCaseNotes()) return;
    e.preventDefault();
    e.returnValue = "";
  });
}

/** Passa a valer o escopo (escritório:pessoa) de quem está na tela; trocar de escopo esquece os rascunhos anteriores. */
export function adoptCaseNoteScope(next: string) {
  if (scope === next) return;
  scope = next;
  if (drafts.size > 0) {
    drafts.clear();
    notify();
  }
}

export function readCaseNoteDraft(draftScope: string, opportunityId: string): CaseNoteDraft {
  if (draftScope !== scope) return EMPTY;
  return drafts.get(opportunityId) ?? EMPTY;
}

/**
 * Altera o rascunho de um caso. `settle: true` é a resposta de uma gravação: só vale se o escopo ainda for o
 * mesmo (quem saiu da conta não recebe nada, e o rascunho de quem entrou não é tocado).
 */
export function writeCaseNoteDraft(draftScope: string, opportunityId: string, patch: Partial<CaseNoteDraft>, opts: { settle?: boolean } = {}) {
  if (draftScope !== scope) {
    if (opts.settle) return;
    adoptCaseNoteScope(draftScope);
  }
  const next = { ...readCaseNoteDraft(draftScope, opportunityId), ...patch };
  if (!next.body && !next.intent && !next.saving && !next.error && !next.done) drafts.delete(opportunityId);
  else drafts.set(opportunityId, next);
  if (next.saving || normalizeNoteBody(next.body).length > 0) installUnloadGuard();
  notify();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** O rascunho de um caso, atualizado a cada mudança (inclusive a resposta de uma gravação feita antes). */
export function useCaseNoteDraft(draftScope: string, opportunityId: string): CaseNoteDraft {
  useEffect(() => adoptCaseNoteScope(draftScope), [draftScope]);
  return useSyncExternalStore(
    subscribe,
    () => readCaseNoteDraft(draftScope, opportunityId),
    () => EMPTY,
  );
}
