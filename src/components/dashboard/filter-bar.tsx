"use client";

import type { ChangeEvent, ReactNode } from "react";
import Form from "next/form";
import Link from "next/link";
import { Calendar } from "lucide-react";

import { Button } from "@/components/ui/button";
import { DASHBOARD_PERIODS, UNASSIGNED_FILTER, type DashboardFilters } from "@/modules/dashboard/schema";

const selectClass =
  "h-8 cursor-pointer appearance-none rounded-input border-0 bg-transparent pr-1 text-body font-semibold text-text focus-visible:outline-2";

function Pill({ label, children, icon }: { label: string; children: ReactNode; icon?: ReactNode }) {
  return (
    <label className="flex h-9 items-center gap-1.5 rounded-md border border-border bg-surface px-3 text-body text-text-secondary">
      {icon}
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
 */
export function DashboardFilterBar({
  filters,
  members,
  legalAreas,
  hasActiveFilters,
}: {
  filters: DashboardFilters;
  members: { userId: string; name: string }[];
  legalAreas: string[];
  hasActiveFilters: boolean;
}) {
  const submitOnChange = (event: ChangeEvent<HTMLSelectElement>) => event.currentTarget.form?.requestSubmit();
  const responsavel = filters.onlyUnassigned ? UNASSIGNED_FILTER : (filters.assignedTo ?? "");

  return (
    <Form action="/visao-geral" className="flex flex-wrap items-center gap-2" aria-label="Filtros da visão geral">
      {filters.pipelineId ? <input type="hidden" name="pipeline" value={filters.pipelineId} /> : null}

      <Pill label="Últimos" icon={<Calendar size={14} aria-hidden />}>
        <select name="periodo" defaultValue={String(filters.periodDays)} onChange={submitOnChange} className={selectClass} aria-label="Período">
          {DASHBOARD_PERIODS.map((days) => (
            <option key={days} value={days}>
              {days} dias
            </option>
          ))}
        </select>
      </Pill>

      <Pill label="Responsável:">
        <select name="responsavel" defaultValue={responsavel} onChange={submitOnChange} className={selectClass} aria-label="Responsável pelo lead">
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
        <select name="area" defaultValue={filters.legalArea ?? ""} onChange={submitOnChange} className={selectClass} aria-label="Área jurídica">
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
