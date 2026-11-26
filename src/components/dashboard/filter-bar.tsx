"use client";

import Form from "next/form";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import { DEFAULT_ATTRIBUTION_MODEL } from "@/modules/forms/schema";
import { CUSTOM_PERIOD, UNASSIGNED_FILTER, type DashboardFilters } from "@/modules/dashboard/schema";
import { FilterMenu } from "./filter-menu";
import { PeriodPicker } from "./period-picker";

/**
 * Filtros da Visão geral como formulário GET da própria página (next/form):
 * sem JavaScript o botão "Aplicar" faz o envio nativo; com o JavaScript
 * carregado, escolher uma opção em qualquer menu já aplica, com navegação
 * no cliente.
 *
 * A navegação do cliente ("Limpar filtros", voltar e avançar no
 * navegador) troca as props deste componente sem desmontá-lo: cada menu
 * acompanha o valor que veio da URL (ver `FilterMenu`).
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

      <FilterMenu
        name="responsavel"
        label="Responsável"
        value={responsavel}
        options={[
          { value: "", label: "Toda a equipe" },
          { value: UNASSIGNED_FILTER, label: "Sem responsável" },
          ...members.map((member) => ({ value: member.userId, label: member.name })),
        ]}
      />

      <FilterMenu
        name="area"
        label="Área jurídica"
        value={filters.legalArea ?? ""}
        options={[
          { value: "", label: "todas" },
          // Área pedida na URL que não está na lista continua visível, para o botão não mentir.
          ...(filters.legalArea && !legalAreas.includes(filters.legalArea) ? [filters.legalArea, ...legalAreas] : legalAreas).map((area) => ({
            value: area,
            label: area,
          })),
        ]}
      />

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
