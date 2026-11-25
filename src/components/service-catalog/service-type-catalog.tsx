"use client";

import { useState, useTransition, type FormEvent, type ReactNode } from "react";
import { ArrowDown, ArrowUp, ListChecks, X } from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { FormField, FormLabel } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { saveServiceTypeAction, setServiceTypeArchivedAction } from "@/modules/case-service/actions";
import {
  SERVICE_STEP_NAME_MAX,
  SERVICE_STEPS_MAX,
  SERVICE_TYPE_NAME_MAX,
  SERVICE_TYPE_SUGGESTIONS,
  type ServiceTypeItem,
  type ServiceTypeSuggestion,
} from "@/modules/case-service/schema";

/**
 * Catálogo do escritório: tipos ativos e arquivados, com as etapas-modelo e quantos casos usam cada um, e os
 * modelos sugeridos — que só viram tipo do escritório quando alguém clica em "Copiar para o catálogo" (e a
 * cópia é editável antes de salvar). Nada aqui toca em casos existentes.
 */
export function ServiceTypeCatalog({ types }: { types: ServiceTypeItem[] }) {
  const active = types.filter((t) => !t.archived);
  const archived = types.filter((t) => t.archived);
  const copied = new Set(types.map((t) => t.suggestionCode).filter(Boolean));

  return (
    <div className="flex flex-col gap-6">
      <section aria-labelledby="st-ativos" className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id="st-ativos" className="m-0 text-body font-semibold text-text">
            Tipos do escritório <span className="text-meta font-normal text-text-tertiary">{active.length} ativos</span>
          </h2>
          <ServiceTypeDialog trigger={<Button size="sm">Novo tipo de serviço</Button>} />
        </div>
        {active.length === 0 ? (
          <p className="m-0 rounded-lg border border-dashed border-border bg-surface-subtle p-4 text-meta text-text-tertiary">
            Nenhum tipo de serviço ainda. Crie um do zero ou copie um modelo sugerido abaixo.
          </p>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-3 p-0">
            {active.map((t) => (
              <TypeCard key={t.id} type={t} />
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="st-sugestoes" className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <h2 id="st-sugestoes" className="m-0 text-body font-semibold text-text">
            Modelos sugeridos para copiar
          </h2>
          <p className="m-0 text-meta text-text-tertiary">
            Ponto de partida do Praxis, não validação jurídica. Copiar abre a cópia para você ajustar antes de salvar; nada é
            aplicado a casos. Serviços extrajudiciais e consultivos não têm protocolo de ação nem sentença.
          </p>
        </div>
        <ul className="m-0 grid list-none grid-cols-1 gap-3 p-0 md:grid-cols-2">
          {SERVICE_TYPE_SUGGESTIONS.map((s) => (
            <li key={s.code} className="flex flex-col gap-2 rounded-card border border-border bg-surface p-3.5">
              <span className="text-small font-semibold text-text">{s.name}</span>
              <span className="text-meta text-text-tertiary">{s.description}</span>
              <ol className="m-0 flex list-decimal flex-col gap-0.5 pl-5 text-meta text-text-secondary">
                {s.steps.map((step) => (
                  <li key={step}>{step}</li>
                ))}
              </ol>
              <ServiceTypeDialog
                suggestion={s}
                trigger={
                  <Button size="sm" variant="secondary" className="mt-auto w-fit">
                    {copied.has(s.code) ? "Copiar de novo" : "Copiar para o catálogo"}
                  </Button>
                }
              />
            </li>
          ))}
        </ul>
      </section>

      {archived.length > 0 ? (
        <section aria-labelledby="st-arquivados" className="flex flex-col gap-3">
          <h2 id="st-arquivados" className="m-0 text-body font-semibold text-text">
            Arquivados <span className="text-meta font-normal text-text-tertiary">não podem ser aplicados a novos casos</span>
          </h2>
          <ul className="m-0 flex list-none flex-col gap-3 p-0">
            {archived.map((t) => (
              <TypeCard key={t.id} type={t} />
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

function TypeCard({ type }: { type: ServiceTypeItem }) {
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function toggle(archived: boolean) {
    setError(null);
    start(async () => {
      const r = await setServiceTypeArchivedAction({ serviceTypeId: type.id, archived, expectedVersion: type.version });
      if (!r.ok) setError(r.error);
      else setConfirming(false);
    });
  }

  return (
    <li className="flex flex-col gap-2 rounded-card border border-border bg-surface p-3.5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="flex items-center gap-1.5 text-small font-semibold text-text [overflow-wrap:anywhere]">
            <ListChecks size={14} className="shrink-0 text-primary" aria-hidden />
            {type.name}
          </span>
          <span className="text-meta text-text-tertiary">
            {type.steps.length} {type.steps.length === 1 ? "etapa" : "etapas"} · versão {type.version} ·{" "}
            {type.activeCases === 0
              ? "nenhum caso usa agora"
              : `${type.activeCases} ${type.activeCases === 1 ? "caso usa" : "casos usam"} agora (com a própria cópia)`}
          </span>
        </div>
        <div className="flex flex-wrap gap-2">
          {type.archived ? (
            <Button size="sm" variant="secondary" disabled={pending} onClick={() => toggle(false)}>
              Restaurar
            </Button>
          ) : (
            <>
              <ServiceTypeDialog type={type} trigger={<Button size="sm" variant="secondary">Editar</Button>} />
              <Button size="sm" variant="ghost" disabled={pending} onClick={() => setConfirming(true)}>
                Arquivar
              </Button>
            </>
          )}
        </div>
      </div>
      <ol className="m-0 flex list-decimal flex-col gap-0.5 pl-5 text-meta text-text-secondary">
        {type.steps.map((s) => (
          <li key={s.position}>{s.name}</li>
        ))}
      </ol>
      {confirming ? (
        <div role="group" aria-label={`Arquivar ${type.name}`} className="flex flex-col gap-2 rounded-input border border-border bg-surface-subtle p-3">
          <p className="m-0 text-meta text-text-secondary">
            Arquivado, o tipo deixa de ser oferecido para novos casos. Os casos que já o usam não mudam.
          </p>
          <div className="flex gap-2">
            <Button size="sm" disabled={pending} onClick={() => toggle(true)}>
              {pending ? "Arquivando…" : "Confirmar"}
            </Button>
            <Button size="sm" variant="ghost" disabled={pending} onClick={() => setConfirming(false)}>
              Cancelar
            </Button>
          </div>
        </div>
      ) : null}
      {error ? (
        <Alert variant="danger">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
    </li>
  );
}

type Row = { key: number; name: string };

function ServiceTypeDialog({
  type,
  suggestion,
  trigger,
}: {
  type?: ServiceTypeItem;
  suggestion?: ServiceTypeSuggestion;
  trigger: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [instance, setInstance] = useState(0);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setInstance((k) => k + 1);
      }}
    >
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent>
        <ServiceTypeForm key={instance} type={type} suggestion={suggestion} onDone={() => setOpen(false)} />
      </DialogContent>
    </Dialog>
  );
}

function ServiceTypeForm({
  type,
  suggestion,
  onDone,
}: {
  type?: ServiceTypeItem | undefined;
  suggestion?: ServiceTypeSuggestion | undefined;
  onDone: () => void;
}) {
  const initialSteps = type ? type.steps.map((s) => s.name) : suggestion ? [...suggestion.steps] : [""];
  const [name, setName] = useState(type?.name ?? suggestion?.name ?? "");
  const [rows, setRows] = useState<Row[]>(initialSteps.map((n, i) => ({ key: i, name: n })));
  const [nextKey, setNextKey] = useState(initialSteps.length);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function move(i: number, d: -1 | 1) {
    setRows((r) => {
      const j = i + d;
      if (j < 0 || j >= r.length) return r;
      const copy = [...r];
      [copy[i], copy[j]] = [copy[j]!, copy[i]!];
      return copy;
    });
  }

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    start(async () => {
      const r = await saveServiceTypeAction({
        serviceTypeId: type?.id ?? null,
        expectedVersion: type?.version ?? null,
        name,
        steps: rows.map((x) => x.name),
        suggestionCode: type ? null : (suggestion?.code ?? null),
      });
      if (!r.ok) {
        setError(r.error);
        return;
      }
      onDone();
    });
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>{type ? "Editar tipo de serviço" : suggestion ? "Copiar modelo sugerido" : "Novo tipo de serviço"}</DialogTitle>
        <DialogDescription>
          {type
            ? "As mudanças valem para os próximos casos. Os casos que já usam este tipo guardam a cópia que receberam."
            : "Defina o nome e as etapas em ordem. Você pode ajustar tudo antes de salvar."}
        </DialogDescription>
      </DialogHeader>
      <form onSubmit={submit} className="flex max-h-[70vh] flex-col gap-4 overflow-y-auto pr-1">
        <FormField>
          <FormLabel htmlFor="st-name">Nome</FormLabel>
          <Input id="st-name" value={name} maxLength={SERVICE_TYPE_NAME_MAX} onChange={(e) => setName(e.target.value)} placeholder="Ex.: Usucapião extrajudicial" />
        </FormField>
        <fieldset className="flex flex-col gap-2 rounded-card border border-border p-3">
          <legend className="px-1 text-meta font-semibold text-text-secondary">Etapas, na ordem</legend>
          {rows.map((row, i) => (
            <div key={row.key} className="flex items-center gap-1.5">
              <span className="w-5 shrink-0 text-right text-meta tabular-nums text-text-muted">{i + 1}.</span>
              <Input
                aria-label={`Etapa ${i + 1}`}
                value={row.name}
                maxLength={SERVICE_STEP_NAME_MAX}
                onChange={(e) => setRows((r) => r.map((x) => (x.key === row.key ? { ...x, name: e.target.value } : x)))}
              />
              <Button type="button" variant="ghost" size="sm" aria-label={`Subir a etapa ${i + 1}`} disabled={i === 0} onClick={() => move(i, -1)}>
                <ArrowUp size={14} aria-hidden />
              </Button>
              <Button type="button" variant="ghost" size="sm" aria-label={`Descer a etapa ${i + 1}`} disabled={i === rows.length - 1} onClick={() => move(i, 1)}>
                <ArrowDown size={14} aria-hidden />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label={`Remover a etapa ${i + 1}`}
                disabled={rows.length === 1}
                onClick={() => setRows((r) => r.filter((x) => x.key !== row.key))}
              >
                <X size={14} aria-hidden />
              </Button>
            </div>
          ))}
          <div>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={rows.length >= SERVICE_STEPS_MAX}
              onClick={() => {
                setRows((r) => [...r, { key: nextKey, name: "" }]);
                setNextKey((k) => k + 1);
              }}
            >
              Adicionar etapa
            </Button>
          </div>
        </fieldset>
        {error ? (
          <Alert variant="danger">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onDone} disabled={pending}>
            Cancelar
          </Button>
          <Button type="submit" disabled={pending}>
            {pending ? "Salvando…" : type ? "Salvar" : "Criar tipo"}
          </Button>
        </div>
      </form>
    </>
  );
}
