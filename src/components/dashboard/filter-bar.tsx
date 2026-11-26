"use client";

import type { ChangeEvent, ReactNode } from "react";
import Form from "next/form";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import { DEFAULT_ATTRIBUTION_MODEL } from "@/modules/forms/schema";
import { CUSTOM_PERIOD, UNASSIGNED_FILTER, type DashboardFilters } from "@/modules/dashboard/schema";
import { PeriodPicker } from "./period-picker";

const selectClass =
  "h-8 cursor-pointer appearance-none rounded-input border-0 bg-transparent pr-1 text-body font-semibold text-text focus-visible:outline-2";

function Pill({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex h-9 items-center gap-1.5 rounded-md border border-border bg-surface px-3 text-body text-text-secondary">
      <span>{label}</span>
      {children}
    </label>
  );
}

/**
 * Filtros da Visão geral como formulário GET da própria página (next/form):
 * antes da hidratação o botão "Aplicar" faz o envio nativo; com o
 * JavaScript carregado, trocar qualquer seletor já aplica, com navegação
 * no cliente.
 *
 * Cada seletor leva `key` com o valor que veio da URL. A navegação do
 * cliente ("Limpar filtros", voltar e avançar no navegador) troca as
 * props deste componente sem desmontá-lo, e `defaultValue` só vale na
 * montagem — sem a `key`, o seletor continuaria mostrando a escolha
 * anterior enquanto os indicadores já seriam os da URL nova. Trocar a
 * `key` remonta o seletor com o valor certo. Nada disso depende de
 * JavaScript: sem ele, o HTML já vem do servidor com a opção marcada.
 *
 * O período não é um campo digitável: o calendário navega sozinho. O
 * formulário só carrega, em campos ocultos, o período aplicado (atalho ou
 * datas), o pipeline, a origem e o modelo, para trocar outro filtro sem
 * perder nenhum deles.
 */
export function DashboardFilterBar({
  filters,
  members,
  legalAreas,
  hasActiveFilters,
  today,
}: {
  filters: DashboardFilters;
  /** Hoje no fuso do escritório (vem do servidor, junto com os números). */
  today: string;
  members: { userId: string; name: string }[];
  legalAreas: string[];
  hasActiveFilters: boolean;
}) {
  const submitOnChange = (event: ChangeEvent<HTMLSelectElement>) => event.currentTarget.form?.requestSubmit();
  const responsavel = filters.onlyUnassigned ? UNASSIGNED_FILTER : (filters.assignedTo ?? "");

  return (
    <Form action="/visao-geral" className="flex flex-wrap items-center gap-2" aria-label="Filtros da visão geral">
      {filters.pipelineId ? <input type="hidden" name="pipeline" value={filters.pipelineId} /> : null}
      {filters.source ? <input type="hidden" name="origem" value={filters.source} /> : null}
      {filters.attributionModel !== DEFAULT_ATTRIBUTION_MODEL ? <input type="hidden" name="modelo" value={filters.attributionModel} /> : null}
      {/* `value` controlado: voltar e avançar trocam o período sem desmontar o formulário. */}
      <input type="hidden" name="periodo" value={filters.range ? CUSTOM_PERIOD : String(filters.periodDays)} readOnly />
      {filters.range ? (
        <>
          <input type="hidden" name="de" value={filters.range.from} readOnly />
          <input type="hidden" name="ate" value={filters.range.to} readOnly />
        </>
      ) : null}

      <PeriodPicker filters={filters} today={today} />

      <Pill label="Responsável:">
        <select key={responsavel} name="responsavel" defaultValue={responsavel} onChange={submitOnChange} className={selectClass} aria-label="Responsável pelo lead">
          <option value="">Toda a equipe</option>
          <option value={UNASSIGNED_FILTER}>Sem responsável</option>
          {members.map((member) => (
            <option key={member.userId} value={member.userId}>
              {member.name}
            </option>
          ))}
        </select>
      </Pill>

      <Pill label="Área jurídica:">
        <select key={filters.legalArea ?? ""} name="area" defaultValue={filters.legalArea ?? ""} onChange={submitOnChange} className={selectClass} aria-label="Área jurídica">
          <option value="">todas</option>
          {filters.legalArea && !legalAreas.includes(filters.legalArea) ? (
            <option value={filters.legalArea}>{filters.legalArea}</option>
          ) : null}
          {legalAreas.map((area) => (
            <option key={area} value={area}>
              {area}
            </option>
          ))}
        </select>
      </Pill>

      <Button type="submit" variant="secondary" size="sm">
        Aplicar
      </Button>
      {hasActiveFilters ? (
        <Button asChild variant="ghost" size="sm">
          <Link href="/visao-geral">Limpar filtros</Link>
        </Button>
      ) : null}
    </Form>
  );
}
