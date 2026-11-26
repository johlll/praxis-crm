"use client";

import { useId, useState, useTransition, type FormEvent, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { CalendarDays, Loader2 } from "lucide-react";

import { cn } from "@/lib/cn";
import { Button } from "@/components/ui/button";
import {
  PERIOD_ERROR_MESSAGE,
  PERIOD_LABEL,
  PERIOD_PRESETS,
  PLATFORMS,
  PLATFORM_LABEL,
  trafficHref,
  validateCustomRange,
  type PeriodError,
  type PeriodPreset,
  type Platform,
  type TrafficFilters,
} from "@/modules/traffic/schema";
import { PlatformMark } from "./platform-mark";

const FROM_ERRORS: readonly PeriodError[] = ["missing_from", "invalid_from", "inverted", "too_old", "too_long"];
const TO_ERRORS: readonly PeriodError[] = ["missing_to", "invalid_to", "inverted", "future", "too_long"];

const controlClass = "h-9 rounded-md border border-border bg-surface px-3 text-body text-text";

type Draft = { href: string; filters: TrafficFilters; error: PeriodError | null; platformHint: boolean };

/**
 * Filtros + conteúdo filtrado. Os filtros vivem na URL; enquanto a nova consulta não chega, o conteúdo antigo
 * fica marcado como "carregando" (aria-busy), nunca como se já fosse o novo. Um envio antes de a página ficar
 * interativa cai no GET comum do formulário. Os controles não são remontados ao aplicar, então o foco do teclado
 * não se perde.
 */
export function TrafficFiltersShell({
  filters,
  today,
  range,
  error,
  children,
}: {
  filters: TrafficFilters;
  today: string;
  /** Período em vigor (nulo quando as datas da URL foram recusadas). */
  range: { from: string; to: string } | null;
  error: PeriodError | null;
  children: ReactNode;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const href = trafficHref(filters);
  const initial = (): Draft => ({
    href,
    error,
    platformHint: false,
    filters: {
      ...filters,
      from: filters.preset === "personalizado" ? filters.from : (range?.from ?? ""),
      to: filters.preset === "personalizado" ? filters.to : (range?.to ?? ""),
    },
  });
  const [draft, setDraft] = useState<Draft>(initial);
  // A URL mudou (aplicar, voltar, avançar): o rascunho volta a refletir o que está em vigor.
  if (draft.href !== href) setDraft(initial());
  const current = draft.filters;
  const errorId = useId();
  const hintId = useId();

  function navigate(next: TrafficFilters) {
    startTransition(() => {
      router.push(trafficHref(next), { scroll: false });
    });
  }

  /** O que já está valendo (URL), para a troca de plataforma não aplicar datas ainda em digitação. */
  const applied = (platforms: Platform[]): TrafficFilters => ({ ...filters, platforms });

  function togglePlatform(platform: Platform, checked: boolean) {
    const platforms = PLATFORMS.filter((p) => (p === platform ? checked : current.platforms.includes(p)));
    if (platforms.length === 0) {
      setDraft({ ...draft, platformHint: true });
      return;
    }
    setDraft({ ...draft, platformHint: false, filters: { ...current, platforms: [...platforms] } });
    navigate(applied([...platforms]));
  }

  function changePreset(preset: PeriodPreset) {
    const next = { ...current, preset };
    setDraft({ ...draft, error: null, filters: next });
    // No personalizado espera as duas datas e o botão.
    if (preset !== "personalizado") navigate(next);
  }

  function setDate(key: "from" | "to", value: string) {
    setDraft({ ...draft, error: null, filters: { ...current, [key]: value } });
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (current.preset === "personalizado") {
      // Data impossível digitada no campo (31/02) chega como texto vazio; o navegador avisa em badInput.
      const inputs = event.currentTarget.elements;
      const bad = (name: string) => (inputs.namedItem(name) as HTMLInputElement | null)?.validity?.badInput === true;
      const problem = bad("de") ? "invalid_from" : bad("ate") ? "invalid_to" : validateCustomRange(current.from, current.to, today);
      if (problem) {
        setDraft({ ...draft, error: problem });
        return;
      }
    }
    setDraft({ ...draft, error: null });
    navigate(current);
  }

  const custom = current.preset === "personalizado";

  return (
    <div className="flex flex-col gap-4">
      <form
        action="/trafego-pago"
        method="get"
        noValidate
        onSubmit={submit}
        aria-label="Filtros do tráfego pago"
        className="flex flex-col gap-2"
      >
        <div className="flex flex-wrap items-end gap-x-5 gap-y-3">
          <fieldset className="m-0 border-0 p-0" aria-describedby={draft.platformHint ? hintId : undefined}>
            <legend className="mb-1 p-0 text-meta text-text-tertiary">Plataforma</legend>
            <div className="flex gap-2">
              {PLATFORMS.map((platform) => {
                const checked = current.platforms.includes(platform);
                return (
                  <label
                    key={platform}
                    className={cn(
                      "flex h-9 min-w-[112px] cursor-pointer items-center gap-2 rounded-md border px-3 text-body font-semibold transition-colors has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-primary",
                      checked ? "border-accent-border bg-accent-tint text-text" : "border-border bg-surface text-text-muted",
                    )}
                  >
                    <PlatformMark platform={platform} />
                    <span className="flex-1">{PLATFORM_LABEL[platform]}</span>
                    <input
                      type="checkbox"
                      name="plataforma"
                      value={platform}
                      checked={checked}
                      onChange={(e) => togglePlatform(platform, e.target.checked)}
                      className="size-3.5 cursor-pointer accent-[var(--color-accent)]"
                    />
                  </label>
                );
              })}
            </div>
          </fieldset>

          <label className="flex flex-col gap-1">
            <span className="text-meta text-text-tertiary">Período</span>
            <span className={cn(controlClass, "flex items-center gap-2 pr-2")}>
              <CalendarDays size={14} aria-hidden className="shrink-0 text-text-secondary" />
              <select
                name="periodo"
                value={current.preset}
                onChange={(e) => changePreset(e.target.value as PeriodPreset)}
                className="h-8 min-w-[150px] cursor-pointer rounded-input border-0 bg-surface text-body font-semibold text-text"
              >
                {PERIOD_PRESETS.map((preset) => (
                  <option key={preset} value={preset}>
                    {PERIOD_LABEL[preset]}
                  </option>
                ))}
              </select>
            </span>
          </label>

          {custom ? (
            <div className="flex flex-wrap items-end gap-2">
              {(["from", "to"] as const).map((key) => {
                const invalid = draft.error !== null && (key === "from" ? FROM_ERRORS : TO_ERRORS).includes(draft.error);
                return (
                  <label key={key} className="flex flex-col gap-1">
                    <span className="text-meta text-text-tertiary">{key === "from" ? "Início" : "Fim"}</span>
                    <input
                      type="date"
                      name={key === "from" ? "de" : "ate"}
                      value={current[key]}
                      max={today}
                      onChange={(e) => setDate(key, e.target.value)}
                      aria-invalid={invalid || undefined}
                      aria-describedby={invalid ? errorId : undefined}
                      className={cn(controlClass, "w-[150px]", invalid && "border-danger")}
                    />
                  </label>
                );
              })}
              <Button type="submit" variant="secondary">
                Aplicar período
              </Button>
            </div>
          ) : null}

          <p role="status" className="m-0 flex h-9 items-center gap-1.5 text-meta text-text-secondary">
            {isPending ? (
              <>
                <Loader2 size={13} aria-hidden className="animate-spin motion-reduce:animate-none" />
                Carregando…
              </>
            ) : null}
          </p>
        </div>

        {draft.platformHint ? (
          <p id={hintId} role="alert" className="m-0 text-small text-warning">
            Mantenha ao menos uma plataforma selecionada.
          </p>
        ) : null}
        {draft.error ? (
          <p id={errorId} role="alert" className="m-0 text-small text-danger">
            {PERIOD_ERROR_MESSAGE[draft.error]}
          </p>
        ) : null}
      </form>

      <div aria-busy={isPending} className={cn("flex flex-col gap-4 transition-opacity", isPending && "opacity-50")}>
        {children}
      </div>
    </div>
  );
}
