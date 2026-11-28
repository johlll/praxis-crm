"use client";

import type { Route } from "next";
import Link from "next/link";
import {
  AlarmClock,
  ArrowRight,
  CalendarClock,
  CircleAlert,
  CircleCheck,
  ListChecks,
  Lock,
  TriangleAlert,
  UserRound,
  Users,
  type LucideIcon,
} from "lucide-react";

import { cn } from "@/lib/cn";
import { TIMEZONE } from "@/lib/timezone";
import type { AssistantBlock, DiagnosisSection } from "@/modules/assistant/types";
import { ConfirmCard, DuplicateCard } from "./registration-cards";

const SECTION_ICON: Record<DiagnosisSection["key"], LucideIcon> = {
  overdue: AlarmClock,
  today: CalendarClock,
  attention: ListChecks,
};

const TONE = {
  danger: "bg-danger",
  warning: "bg-warning",
  neutral: "bg-text-muted",
} as const;

export const cardClass = "rounded-card border border-border bg-surface p-4";

const consultedAt = (iso: string) =>
  new Date(iso).toLocaleString("pt-BR", { timeZone: TIMEZONE, day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }).replace(", ", " às ");

function Diagnosis({ block }: { block: Extract<AssistantBlock, { type: "diagnosis" }> }) {
  return (
    <div className="flex flex-col gap-3">
      <p className="m-0 text-body text-text">{block.summary}</p>
      <div className="grid gap-3">
        {block.sections.map((section) => {
          const Icon = SECTION_ICON[section.key];
          return (
            <section key={section.key} aria-labelledby={`diag-${section.key}`} className={cn(cardClass, "flex flex-col gap-2.5")}>
              <header className="flex items-center gap-2.5">
                <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-primary-tint text-primary" aria-hidden>
                  <Icon size={16} />
                </span>
                <h3 id={`diag-${section.key}`} className="m-0 flex-1 text-body font-bold text-text">
                  {section.title}
                </h3>
                {section.status === "ok" ? (
                  <span className="rounded-pill bg-surface-hover px-2 py-0.5 text-meta font-semibold text-text-secondary tabular">{section.total}</span>
                ) : null}
              </header>

              {section.status === "unavailable" ? (
                <p className="m-0 flex items-start gap-2 rounded-md border border-warning/30 bg-warning-bg px-3 py-2 text-small text-warning">
                  <TriangleAlert size={14} aria-hidden className="mt-0.5 shrink-0" />
                  Informação indisponível: não consegui consultar {section.title.toLowerCase()} agora. Esta parte ficou de fora da resposta.
                </p>
              ) : section.items.length === 0 ? (
                <p className="m-0 text-small text-text-secondary">{section.emptyText}</p>
              ) : (
                <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
                  {section.items.map((item) => (
                    <li key={item.id}>
                      <Link
                        href={item.href as Route}
                        className="group flex items-start gap-2.5 rounded-md border border-border-subtle px-3 py-2 text-text hover:border-border hover:bg-surface-hover hover:no-underline"
                      >
                        <span className={cn("mt-[7px] size-2 shrink-0 rounded-full", TONE[item.tone])} aria-hidden />
                        <span className="flex min-w-0 flex-1 flex-col">
                          <span className="text-small font-semibold break-words text-text">{item.title}</span>
                          <span className="text-meta break-words text-text-tertiary">{item.reason}</span>
                        </span>
                        <ArrowRight size={14} aria-hidden className="mt-1 shrink-0 text-text-muted group-hover:text-text" />
                      </Link>
                    </li>
                  ))}
                </ul>
              )}

              {section.status === "ok" && section.total > section.items.length ? (
                <Link href={section.moreHref as Route} className="self-start text-small font-semibold">
                  Ver todas ({section.total})
                </Link>
              ) : null}
            </section>
          );
        })}
      </div>
      <p className="m-0 text-meta text-text-muted">
        Consultado em {consultedAt(block.generatedAt)} (horário de Brasília), com o que o seu perfil pode ver neste escritório.
      </p>
    </div>
  );
}

function Success({ block }: { block: Extract<AssistantBlock, { type: "success" }> }) {
  return (
    <div className={cn(cardClass, "flex flex-col gap-3 border-success/30")} role="status">
      <p className="m-0 flex items-center gap-2 text-body font-bold text-success">
        <CircleCheck size={16} aria-hidden />
        {block.replayed ? "Este cadastro já estava gravado" : "Cadastro gravado"}
      </p>
      <p className="m-0 text-small text-text-secondary">
        {block.replayed
          ? "A confirmação chegou de novo e nenhum cadastro a mais foi criado."
          : block.contactCreated
            ? `Contato de ${block.contactName} e lead de ${block.legalArea} criados.`
            : `Lead de ${block.legalArea} criado no contato existente de ${block.contactName}.`}
      </p>
      <div className="flex flex-wrap gap-2">
        <Link
          href={block.leadHref as Route}
          className="inline-flex h-8 items-center gap-1.5 rounded-md bg-primary px-3 text-small font-semibold text-on-solid hover:bg-primary-hover hover:no-underline"
        >
          <Users size={14} aria-hidden />
          Abrir o lead
        </Link>
        <Link
          href={block.contactHref as Route}
          className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border px-3 text-small font-semibold text-text hover:bg-surface-hover hover:no-underline"
        >
          <UserRound size={14} aria-hidden />
          Abrir o contato
        </Link>
      </div>
    </div>
  );
}

export function AssistantBlocks({
  blocks,
  onReplace,
  onDraftClosed,
}: {
  blocks: AssistantBlock[];
  onReplace: (index: number, blocks: AssistantBlock[]) => void;
  onDraftClosed: () => void;
}) {
  return (
    <>
      {blocks.map((block, index) => {
        const key = `${block.type}-${index}`;
        switch (block.type) {
          case "text":
            return (
              <p key={key} className="m-0 text-body whitespace-pre-wrap text-text">
                {block.text}
              </p>
            );
          case "question":
            return (
              <p key={key} className="m-0 rounded-md border-l-2 border-primary bg-surface px-3 py-2 text-body text-text">
                {block.text}
              </p>
            );
          case "diagnosis":
            return <Diagnosis key={key} block={block} />;
          case "duplicate":
            return <DuplicateCard key={key} block={block} onReplace={(next) => onReplace(index, next)} onClosed={onDraftClosed} />;
          case "confirm":
            return <ConfirmCard key={`${key}-${block.requestId}`} block={block} onReplace={(next) => onReplace(index, next)} onClosed={onDraftClosed} />;
          case "success":
            return <Success key={key} block={block} />;
          case "denied":
            return (
              <p key={key} role="alert" className="m-0 flex items-start gap-2 rounded-md border border-border bg-surface px-3 py-2.5 text-body text-text">
                <Lock size={15} aria-hidden className="mt-0.5 shrink-0 text-text-tertiary" />
                {block.text}
              </p>
            );
          case "error":
            return (
              <p key={key} role="alert" className="m-0 flex items-start gap-2 rounded-md border border-danger/25 bg-danger-bg px-3 py-2.5 text-body text-danger">
                <CircleAlert size={15} aria-hidden className="mt-0.5 shrink-0" />
                {block.text}
              </p>
            );
        }
      })}
    </>
  );
}
