"use client";

import { useId, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, Download, ExternalLink, FileText, Image as ImageIcon, Paperclip, ShieldAlert, Trash2, TriangleAlert } from "lucide-react";

import { cn } from "@/lib/cn";
import { Button } from "@/components/ui/button";
import { createBrowserSupabaseClient } from "@/lib/supabase/browser";
import {
  abandonCaseDocumentUploadAction,
  beginCaseDocumentUploadAction,
  finalizeCaseDocumentUploadAction,
  removeCaseDocumentAction,
  reviewCaseDocumentAction,
} from "@/modules/case-documents/actions";
import {
  CASE_DOCUMENT_ACCEPT,
  CASE_DOCUMENT_NOTE_MAX,
  CASE_DOCUMENT_TYPE_LABEL,
  REMOVAL_REASONS,
  REMOVAL_REASON_LABEL,
  REVIEW_STATUSES,
  REVIEW_STATUS_LABEL,
  formatFileSize,
  precheckFile,
  type CaseDocument,
  type CaseDocumentType,
  type RemovalReason,
  type ReviewStatus,
} from "@/modules/case-documents/schema";
import { formatStamp } from "@/modules/conversations/context-format";

/**
 * Documentos por caso (docs/decisoes/conversas-documentos-caso.md) — a parte interativa da aba Documentos.
 *
 * - Envio em duas fases: o servidor reserva o documento e devolve um link de envio para o caminho que o BANCO
 *   gerou; o navegador sobe o arquivo direto ao Storage (sem sobrescrita); o servidor confere o conteúdo e só
 *   então o documento aparece. Uma chave por arquivo escolhido: repetir não duplica.
 * - Conferência humana explícita (Recebido · Conferido · Com pendência), com versão: se outra pessoa registrou
 *   antes, a tela avisa em vez de sobrescrever.
 * - Remoção controlada com motivo, em duas fases; se o arquivo ainda não saiu do armazenamento, a remoção fica
 *   pendente e visível.
 * - Nome e observação são sempre TEXTO (o React escapa; nada de HTML). O estado é deste caso: o componente é
 *   montado com `key` do caso, e uma resposta atrasada de outro caso nunca aparece aqui.
 */

type Can = { upload: boolean; review: boolean; remove: boolean };

/** Motivo pelo qual o envio está fechado nesta tela (o servidor e o banco recusam de qualquer forma). */
export type UploadBlock = "backup_pending" | "anonymized" | "no_permission" | null;

export const UPLOAD_BLOCK_TEXT: Record<Exclude<UploadBlock, null>, string> = {
  backup_pending: "O recebimento de documentos aguarda a ativação do backup dos arquivos. Até lá, não é possível anexar.",
  anonymized: "Este contato foi anonimizado: o caso só pode ser consultado.",
  no_permission: "Seu perfil só consulta os documentos deste caso.",
};

export const UPLOAD_TRANSPORT_FAILED =
  "Não foi possível confirmar o envio: a conexão falhou antes da resposta. Tente de novo — se o arquivo já tiver sido recebido, ele não será duplicado.";

function TypeIcon({ type }: { type: CaseDocumentType }) {
  const Icon = type === "application/pdf" ? FileText : ImageIcon;
  return <Icon size={16} className="mt-0.5 shrink-0 text-text-muted" aria-hidden />;
}

function ReviewBadge({ status }: { status: ReviewStatus }) {
  return (
    <span
      className={cn(
        "inline-flex w-fit items-center gap-1 rounded-full px-2 py-0.5 text-label font-bold",
        status === "conferido" && "bg-success-bg text-success",
        status === "com_pendencia" && "bg-warning-bg text-warning",
        status === "recebido" && "bg-neutral-bg text-neutral",
      )}
    >
      {status === "conferido" ? <CheckCircle2 size={12} aria-hidden /> : status === "com_pendencia" ? <TriangleAlert size={12} aria-hidden /> : null}
      {REVIEW_STATUS_LABEL[status]}
    </span>
  );
}

// ---------------------------------------------------------------------
// Envio
// ---------------------------------------------------------------------

type UploadPhase =
  | { kind: "idle" }
  | { kind: "working"; step: "reservando" | "enviando" | "conferindo"; fileName: string }
  | { kind: "done"; fileName: string }
  | { kind: "error"; message: string; retry: { file: File; type: CaseDocumentType; key: string } | null };

const STEP_TEXT = { reservando: "Preparando o envio…", enviando: "Enviando o arquivo…", conferindo: "Conferindo o arquivo…" } as const;

function isAlreadyExists(error: unknown): boolean {
  const e = error as { statusCode?: unknown; status?: unknown; message?: unknown; error?: unknown } | null;
  const status = String(e?.statusCode ?? e?.status ?? "");
  const text = `${String(e?.message ?? "")} ${String(e?.error ?? "")}`.toLowerCase();
  return status === "409" || text.includes("already exists") || text.includes("duplicate");
}

export function CaseDocumentUploader({ opportunityId, caseLabel }: { opportunityId: string; caseLabel: string }) {
  const router = useRouter();
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [phase, setPhase] = useState<UploadPhase>({ kind: "idle" });
  const [, startRefresh] = useTransition();
  const busy = phase.kind === "working";

  async function run(file: File, type: CaseDocumentType, key: string) {
    const retry = { file, type, key };
    setPhase({ kind: "working", step: "reservando", fileName: file.name });
    let begun: Awaited<ReturnType<typeof beginCaseDocumentUploadAction>>;
    try {
      begun = await beginCaseDocumentUploadAction({ opportunityId, name: file.name, type, size: file.size, idempotencyKey: key });
    } catch {
      setPhase({ kind: "error", message: UPLOAD_TRANSPORT_FAILED, retry });
      return;
    }
    if (!begun.ok) {
      setPhase({ kind: "error", message: begun.error, retry: null });
      return;
    }
    if (begun.alreadyReady) {
      setPhase({ kind: "done", fileName: begun.alreadyReady.name });
      startRefresh(() => router.refresh());
      return;
    }

    if (begun.token) {
      setPhase({ kind: "working", step: "enviando", fileName: file.name });
      let uploadError: unknown = null;
      try {
        const { error } = await createBrowserSupabaseClient()
          .storage.from("case-documents")
          .uploadToSignedUrl(begun.path, begun.token, file, { contentType: type, upsert: false });
        uploadError = error;
      } catch (error) {
        uploadError = error ?? new Error("upload_failed");
      }
      // Repetição de um envio que já tinha chegado: o objeto existe — segue para a conferência.
      if (uploadError && !isAlreadyExists(uploadError)) {
        await abandonCaseDocumentUploadAction({ documentId: begun.documentId, reason: "upload_interrupted" }).catch(() => undefined);
        setPhase({
          kind: "error",
          message: "O envio do arquivo não foi concluído. Nada foi guardado; tente de novo.",
          retry: { file, type, key: crypto.randomUUID() },
        });
        return;
      }
    }

    setPhase({ kind: "working", step: "conferindo", fileName: file.name });
    let fin: Awaited<ReturnType<typeof finalizeCaseDocumentUploadAction>>;
    try {
      fin = await finalizeCaseDocumentUploadAction({ documentId: begun.documentId, declaredType: type });
    } catch {
      setPhase({ kind: "error", message: UPLOAD_TRANSPORT_FAILED, retry });
      return;
    }
    if (!fin.ok) {
      setPhase({ kind: "error", message: fin.error, retry: fin.abandoned ? null : retry });
      return;
    }
    setPhase({ kind: "done", fileName: fin.document.name });
    startRefresh(() => router.refresh());
  }

  function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    const pre = precheckFile(file);
    if (!pre.ok) {
      setPhase({ kind: "error", message: pre.error, retry: null });
      return;
    }
    void run(file, pre.type, crypto.randomUUID());
  }

  return (
    <div className="flex flex-col gap-2 rounded-input border border-dashed border-border bg-surface-subtle px-3 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-col">
          <p className="m-0 text-small font-semibold text-text">Anexar documento a {caseLabel}</p>
          <p className="m-0 text-meta text-text-tertiary">PDF, JPEG ou PNG, até 10 MB. O formato é conferido pelo conteúdo do arquivo.</p>
        </div>
        <input ref={inputRef} id={inputId} type="file" accept={CASE_DOCUMENT_ACCEPT} className="sr-only" onChange={onPick} disabled={busy} />
        <Button type="button" size="sm" variant="secondary" disabled={busy} onClick={() => inputRef.current?.click()}>
          <Paperclip size={14} aria-hidden />
          Escolher arquivo
        </Button>
      </div>
      <div aria-live="polite" className="min-h-0">
        {phase.kind === "working" ? (
          <p role="status" className="m-0 text-meta text-text-secondary [overflow-wrap:anywhere]">
            {STEP_TEXT[phase.step]} <span className="font-semibold">{phase.fileName}</span>
          </p>
        ) : phase.kind === "done" ? (
          <p role="status" className="m-0 text-meta text-success [overflow-wrap:anywhere]">
            Documento recebido: <span className="font-semibold">{phase.fileName}</span>. A conferência começa como “Recebido”.
          </p>
        ) : phase.kind === "error" ? (
          <div role="alert" className="flex flex-col gap-1.5">
            <p className="m-0 text-meta text-danger">{phase.message}</p>
            {phase.retry ? (
              <Button
                type="button"
                size="sm"
                variant="secondary"
                className="w-fit"
                onClick={() => phase.retry && void run(phase.retry.file, phase.retry.type, phase.retry.key)}
              >
                Tentar de novo
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------
// Lista, conferência e remoção
// ---------------------------------------------------------------------

function ReviewForm({ doc, onDone }: { doc: CaseDocument; onDone: () => void }) {
  const router = useRouter();
  const groupId = useId();
  const noteId = useId();
  const [status, setStatus] = useState<ReviewStatus>(doc.reviewStatus === "recebido" ? "conferido" : doc.reviewStatus);
  const [note, setNote] = useState(doc.reviewNote ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const target = doc.id;
    start(async () => {
      let result: Awaited<ReturnType<typeof reviewCaseDocumentAction>>;
      try {
        result = await reviewCaseDocumentAction({ documentId: target, status, note, expectedVersion: doc.reviewVersion });
      } catch {
        result = { ok: false, error: "Não foi possível confirmar o registro: a conexão falhou. Atualize e confira antes de repetir.", conflict: false };
      }
      if (!result.ok) {
        setError(result.error);
        // Outra pessoa registrou antes: traz a situação atual (sem sobrescrever) e mantém a escolha para decidir de novo.
        if (result.conflict) router.refresh();
        return;
      }
      onDone();
      router.refresh();
    });
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-2 rounded-input border border-border bg-surface px-3 py-2.5" aria-label={`Conferência de ${doc.name}`}>
      <fieldset className="m-0 flex flex-col gap-1.5 border-0 p-0">
        <legend className="mb-1 text-meta font-semibold text-text-secondary">Registrar a conferência</legend>
        <div className="flex flex-wrap gap-x-4 gap-y-1.5" role="radiogroup" aria-labelledby={groupId}>
          <span id={groupId} className="sr-only">
            Situação da conferência
          </span>
          {REVIEW_STATUSES.map((s) => (
            <label key={s} className="inline-flex items-center gap-1.5 text-small text-text">
              <input type="radio" name={`review-${doc.id}`} value={s} checked={status === s} onChange={() => setStatus(s)} disabled={pending} />
              {REVIEW_STATUS_LABEL[s]}
            </label>
          ))}
        </div>
      </fieldset>
      {status !== "recebido" ? (
        <div className="flex flex-col gap-1">
          <label htmlFor={noteId} className="text-meta font-semibold text-text-secondary">
            {status === "com_pendencia" ? "O que está pendente (obrigatório)" : "Observação (opcional)"}
          </label>
          <textarea
            id={noteId}
            value={note}
            maxLength={CASE_DOCUMENT_NOTE_MAX}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
            disabled={pending}
            className="min-h-[56px] w-full resize-y rounded-input border border-border bg-surface px-2.5 py-1.5 text-small text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-ring"
          />
        </div>
      ) : (
        <p className="m-0 text-meta text-text-tertiary">Voltar para “Recebido” desfaz a conferência registrada (fica no histórico de auditoria).</p>
      )}
      <p className="m-0 text-meta text-text-tertiary">“Conferido” registra que a equipe conferiu o arquivo; não é aprovação jurídica automática.</p>
      {error ? (
        <p role="alert" className="m-0 text-meta text-danger">
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" disabled={pending}>
          {pending ? "Registrando…" : "Registrar"}
        </Button>
        <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={onDone}>
          Cancelar
        </Button>
      </div>
    </form>
  );
}

function RemoveForm({ doc, onDone }: { doc: CaseDocument; onDone: () => void }) {
  const router = useRouter();
  const selectId = useId();
  const [reason, setReason] = useState<RemovalReason | "">("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!reason) {
      setError("Escolha o motivo da remoção.");
      return;
    }
    setError(null);
    const target = doc.id;
    start(async () => {
      let result: Awaited<ReturnType<typeof removeCaseDocumentAction>>;
      try {
        result = await removeCaseDocumentAction({ documentId: target, reason });
      } catch {
        result = { ok: false, error: "Não foi possível confirmar a remoção: a conexão falhou. Atualize e confira a situação.", pending: true };
      }
      if (!result.ok) {
        setError(result.error);
        if (result.pending) router.refresh();
        return;
      }
      onDone();
      router.refresh();
    });
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-2 rounded-input border border-danger/25 bg-danger-bg px-3 py-2.5" aria-label={`Remover ${doc.name}`}>
      <p className="m-0 text-meta text-text-secondary">
        O arquivo será apagado do armazenamento e o registro sai do caso. A remoção fica registrada na auditoria, com o motivo. Cópias já incluídas em
        backups continuam lá até o fim da retenção deles.
      </p>
      <div className="flex flex-col gap-1">
        <label htmlFor={selectId} className="text-meta font-semibold text-text-secondary">
          Motivo
        </label>
        <select
          id={selectId}
          value={reason}
          onChange={(e) => setReason(e.target.value as RemovalReason | "")}
          disabled={pending}
          className="h-9 w-full rounded-input border border-border bg-surface px-2.5 text-small text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-ring"
        >
          <option value="">Escolha…</option>
          {REMOVAL_REASONS.map((r) => (
            <option key={r} value={r}>
              {REMOVAL_REASON_LABEL[r]}
            </option>
          ))}
        </select>
      </div>
      {error ? (
        <p role="alert" className="m-0 text-meta text-danger">
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" variant="danger" disabled={pending}>
          {pending ? "Removendo…" : "Remover documento"}
        </Button>
        <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={onDone}>
          Cancelar
        </Button>
      </div>
    </form>
  );
}

function PendingRemoval({ doc, canRetry }: { doc: CaseDocument; canRetry: boolean }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <div className="flex flex-col gap-1.5">
      <p className="m-0 text-meta text-warning">
        Remoção pendente: o arquivo ainda não saiu do armazenamento. Não está disponível para abrir e a exclusão só se completa quando ele sair.
      </p>
      {error ? (
        <p role="alert" className="m-0 text-meta text-danger">
          {error}
        </p>
      ) : null}
      {canRetry ? (
        <Button
          type="button"
          size="sm"
          variant="secondary"
          className="w-fit"
          disabled={pending}
          onClick={() =>
            start(async () => {
              let result: Awaited<ReturnType<typeof removeCaseDocumentAction>>;
              try {
                // O banco mantém o motivo original; este só satisfaz o formato da retomada.
                result = await removeCaseDocumentAction({ documentId: doc.id, reason: "outro" });
              } catch {
                result = { ok: false, error: "Não foi possível confirmar: a conexão falhou.", pending: true };
              }
              if (!result.ok) setError(result.error);
              router.refresh();
            })
          }
        >
          {pending ? "Concluindo…" : "Concluir a remoção"}
        </Button>
      ) : null}
    </div>
  );
}

function DocumentItem({ doc, can }: { doc: CaseDocument; can: Can }) {
  const [mode, setMode] = useState<"view" | "review" | "remove">("view");
  const removing = doc.status === "removing";
  const href = `/api/case-documents/${doc.id}`;
  return (
    <li className="flex min-w-0 flex-col gap-2 rounded-input border border-border-subtle bg-surface-subtle px-3 py-2.5">
      <div className="flex min-w-0 items-start gap-2.5">
        <TypeIcon type={doc.contentType} />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <p className="m-0 text-small font-semibold text-text [overflow-wrap:anywhere]">{doc.name}</p>
          <p className="m-0 text-meta text-text-tertiary">
            {CASE_DOCUMENT_TYPE_LABEL[doc.contentType]} · {formatFileSize(doc.byteSize)} · enviado por {doc.uploadedByName ?? "alguém da equipe"} em{" "}
            <time dateTime={doc.uploadedAt}>{formatStamp(doc.uploadedAt)}</time>
          </p>
          {!removing ? (
            <div className="flex flex-col gap-1">
              <ReviewBadge status={doc.reviewStatus} />
              {doc.reviewStatus !== "recebido" && doc.reviewedAt ? (
                <p className="m-0 text-meta text-text-tertiary">
                  {doc.reviewStatus === "conferido" ? "Conferido" : "Pendência registrada"} por {doc.reviewedByName ?? "alguém da equipe"} em{" "}
                  <time dateTime={doc.reviewedAt}>{formatStamp(doc.reviewedAt)}</time>
                </p>
              ) : null}
              {doc.reviewNote ? <p className="m-0 whitespace-pre-wrap text-meta text-text-secondary [overflow-wrap:anywhere]">{doc.reviewNote}</p> : null}
            </div>
          ) : null}
        </div>
      </div>

      {removing ? (
        <PendingRemoval doc={doc} canRetry={can.remove} />
      ) : mode === "review" ? (
        <ReviewForm doc={doc} onDone={() => setMode("view")} />
      ) : mode === "remove" ? (
        <RemoveForm doc={doc} onDone={() => setMode("view")} />
      ) : (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 pl-[26px]">
          <a href={`${href}?modo=abrir`} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-small font-semibold text-primary hover:underline">
            <ExternalLink size={13} aria-hidden />
            Abrir
          </a>
          <a href={`${href}?modo=baixar`} rel="noopener noreferrer" className="inline-flex items-center gap-1 text-small font-semibold text-primary hover:underline">
            <Download size={13} aria-hidden />
            Baixar
          </a>
          {can.review ? (
            <button type="button" onClick={() => setMode("review")} className="text-small font-semibold text-primary hover:underline">
              Registrar conferência
            </button>
          ) : null}
          {can.remove ? (
            <button type="button" onClick={() => setMode("remove")} className="inline-flex items-center gap-1 text-small font-semibold text-text-secondary hover:text-danger hover:underline">
              <Trash2 size={13} aria-hidden />
              Remover
            </button>
          ) : null}
        </div>
      )}
    </li>
  );
}

export function CaseDocumentsList({ items, can }: { items: CaseDocument[]; can: Can }) {
  if (items.length === 0) {
    return <p className="m-0 text-meta text-text-tertiary">Nenhum documento recebido neste caso.</p>;
  }
  return (
    <ol className="m-0 flex list-none flex-col gap-2 p-0" aria-label="Documentos do caso, do mais recente para o mais antigo">
      {items.map((d) => (
        <DocumentItem key={`${d.id}:${d.reviewVersion}:${d.status}`} doc={d} can={can} />
      ))}
    </ol>
  );
}

export function UploadBlockedNotice({ block }: { block: Exclude<UploadBlock, null> }) {
  return (
    <div role="note" className="flex items-start gap-2 rounded-input border border-border bg-surface-subtle px-3 py-2.5">
      <ShieldAlert size={15} className="mt-0.5 shrink-0 text-text-muted" aria-hidden />
      <p className="m-0 text-meta text-text-secondary">{UPLOAD_BLOCK_TEXT[block]}</p>
    </div>
  );
}
