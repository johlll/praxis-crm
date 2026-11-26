"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AlertTriangle, ArrowRight, Info, Loader2, RotateCw, Zap } from "lucide-react";

import { cn } from "@/lib/cn";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { categoryCounts, type Category, type IntegrationCard, type StateTone } from "@/modules/integrations/cards";

const TONE_TEXT: Record<StateTone, string> = {
  ok: "text-success",
  attention: "text-warning",
  neutral: "text-text-secondary",
  unavailable: "text-text-muted",
  error: "text-danger",
};

const TONE_DOT: Record<StateTone, string> = {
  ok: "bg-success",
  attention: "bg-warning",
  neutral: "bg-info",
  unavailable: "bg-text-disabled",
  error: "bg-danger",
};

function CardIcon({ card }: { card: IntegrationCard }) {
  if (!card.logo) {
    // Recurso do próprio Praxis: o mesmo ícone do item "Automações" do menu.
    return (
      <span aria-hidden className="flex size-14 shrink-0 items-center justify-center rounded-[14px] border border-accent-border bg-accent-tint text-accent">
        <Zap size={28} strokeWidth={1.6} />
      </span>
    );
  }
  return (
    <span aria-hidden className="flex size-14 shrink-0 items-center justify-center">
      {/* Arquivo local; o nome ao lado identifica o cartão, então a imagem é decorativa. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={card.logo} alt="" className="max-h-14 max-w-14 object-contain" />
    </span>
  );
}

function Details({ card, primary }: { card: IntegrationCard; primary: boolean }) {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button type="button" variant={primary ? "secondary" : "ghost"} size="sm" aria-label={`Ver detalhes de ${card.name}`}>
          <Info size={13} aria-hidden />
          Ver detalhes
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-[480px]">
        <DialogHeader>
          <DialogTitle>{card.name}</DialogTitle>
          <DialogDescription>{card.state.label}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2 text-small text-text-secondary">
          {card.details.paragraphs.map((p) => (
            <p key={p} className="m-0">
              {p}
            </p>
          ))}
        </div>
        <DialogFooter className="flex-wrap">
          {card.details.links.map((link) => (
            <Button asChild key={link.href} variant="secondary" size="sm">
              <Link href={link.href}>{link.label}</Link>
            </Button>
          ))}
          <DialogClose asChild>
            <Button type="button" size="sm">
              Entendi
            </Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Retry({ name }: { name: string }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  return (
    <Button type="button" variant="secondary" size="sm" disabled={isPending} aria-label={`Tentar consultar ${name} novamente`} onClick={() => startTransition(() => router.refresh())}>
      {isPending ? <Loader2 size={13} aria-hidden className="animate-spin motion-reduce:animate-none" /> : <RotateCw size={13} aria-hidden />}
      Tentar novamente
    </Button>
  );
}

function Card({ card }: { card: IntegrationCard }) {
  const headingId = `integracao-${card.id}`;
  return (
    <li aria-labelledby={headingId} data-testid={`integration-${card.id}`} className="flex min-w-0 flex-col gap-3 rounded-lg border border-border bg-surface p-4">
      <div className="flex min-w-0 items-center gap-3">
        <CardIcon card={card} />
        <div className="flex min-w-0 flex-col items-start gap-1">
          <h2 id={headingId} className="m-0 text-[17px] leading-tight font-bold break-words text-text">
            {card.name}
          </h2>
          <span className="max-w-full rounded-pill border border-border-strong bg-neutral-bg px-2.5 py-0.5 text-meta break-words text-text-secondary">
            {card.badge}
          </span>
        </div>
      </div>
      <p className="m-0 text-small leading-relaxed break-words text-text-secondary">{card.description}</p>

      <div className="mt-auto flex flex-col gap-2 border-t border-border-subtle pt-3">
        <div role={card.state.tone === "error" ? "alert" : undefined} className="flex flex-col gap-0.5">
          <p data-testid={`integration-state-${card.id}`} className={cn("m-0 flex items-center gap-2 text-small font-semibold", TONE_TEXT[card.state.tone])}>
            {card.state.tone === "error" ? (
              <AlertTriangle size={13} aria-hidden className="shrink-0" />
            ) : (
              <span aria-hidden className={cn("size-2 shrink-0 rounded-full", TONE_DOT[card.state.tone])} />
            )}
            {card.state.label}
          </p>
          {card.state.lines.map((line) => (
            <p key={line} className="m-0 text-meta leading-snug break-words text-text-muted">
              {line}
            </p>
          ))}
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          {card.state.tone === "error" ? <Retry name={card.name} /> : null}
          <Details card={card} primary={card.action === null && card.state.tone !== "error"} />
          {card.action ? (
            <Button asChild variant="secondary" size="sm">
              <Link href={card.action.href} aria-label={`${card.action.label}: ${card.name}`}>
                {card.action.label}
                <ArrowRight size={13} aria-hidden />
              </Link>
            </Button>
          ) : null}
        </div>
      </div>
    </li>
  );
}

export function IntegrationsHub({ cards }: { cards: IntegrationCard[] }) {
  const [filter, setFilter] = useState<Category | "Todas">("Todas");
  const tabs = [{ category: "Todas" as const, count: cards.length }, ...categoryCounts(cards)];
  const visible = filter === "Todas" ? cards : cards.filter((c) => c.category === filter);

  return (
    <>
      <div role="group" aria-label="Filtrar por categoria" className="flex flex-wrap gap-x-1 gap-y-1 border-b border-border">
        {tabs.map((tab) => {
          const active = filter === tab.category;
          return (
            <button
              key={tab.category}
              type="button"
              aria-pressed={active}
              onClick={() => setFilter(tab.category)}
              className={cn(
                "-mb-px rounded-t-sm border-b-2 px-3 py-2 text-body font-semibold",
                active ? "border-accent text-accent" : "border-transparent text-text-secondary hover:text-text",
              )}
            >
              {tab.category} ({tab.count})
            </button>
          );
        })}
      </div>
      <p role="status" className="sr-only">
        {filter === "Todas" ? "" : `${visible.length} em ${filter}.`}
      </p>
      <ul aria-label="Integrações" className="m-0 grid list-none grid-cols-1 gap-4 p-0 @min-[600px]:grid-cols-2 @min-[940px]:grid-cols-3">
        {visible.map((card) => (
          <Card key={card.id} card={card} />
        ))}
      </ul>
    </>
  );
}
