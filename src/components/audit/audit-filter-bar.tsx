import Link from "next/link";
import type { Route } from "next";

import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { AUDIT_ACTION_GROUPS, auditActionLabel } from "@/modules/audit/catalog";
import { AUDIT_PATH, type AuditFilters } from "@/modules/audit/schema";
import type { TeamMember } from "@/modules/team/queries";

const SELECT_CLASS = "h-9 rounded-input border border-border-input bg-surface px-3 text-body text-text";

/**
 * GET simples (como os filtros de leads): a consulta e a paginação acontecem
 * no servidor; nada é carregado inteiro para filtrar no navegador. Trocar um
 * filtro volta ao início da trilha — o cursor antigo não vale para outra
 * seleção, por isso o formulário não o repassa.
 */
export function AuditFilterBar({
  filters,
  members,
  hasActiveFilters,
}: {
  filters: AuditFilters;
  members: TeamMember[];
  hasActiveFilters: boolean;
}) {
  const knownAction =
    filters.action !== null && AUDIT_ACTION_GROUPS.some((g) => g.actions.some((a) => a.code === filters.action));

  return (
    <form action={AUDIT_PATH} method="get" className="flex flex-wrap items-end gap-3">
      <select name="acao" defaultValue={filters.action ?? ""} aria-label="Ação" className={SELECT_CLASS}>
        <option value="">Todas as ações</option>
        {filters.action && !knownAction ? <option value={filters.action}>{auditActionLabel(filters.action)}</option> : null}
        {AUDIT_ACTION_GROUPS.map((group) => (
          <optgroup key={group.label} label={group.label}>
            {group.actions.map((action) => (
              <option key={action.code} value={action.code}>
                {action.label}
              </option>
            ))}
          </optgroup>
        ))}
      </select>

      <select name="pessoa" defaultValue={filters.actorUserId ?? ""} aria-label="Pessoa" className={SELECT_CLASS}>
        <option value="">Todas as pessoas</option>
        {members.map((member) => (
          <option key={member.userId} value={member.userId}>
            {member.fullName ?? member.email}
          </option>
        ))}
      </select>

      <label className="flex items-center gap-2 text-meta text-text-tertiary">
        De
        <Input name="de" type="date" defaultValue={filters.from ?? ""} aria-label="Data inicial" className="w-auto" />
      </label>
      <label className="flex items-center gap-2 text-meta text-text-tertiary">
        Até
        <Input name="ate" type="date" defaultValue={filters.to ?? ""} aria-label="Data final" className="w-auto" />
      </label>

      <Button type="submit" variant="secondary" size="sm">
        Filtrar
      </Button>
      {hasActiveFilters ? (
        <Button asChild variant="ghost" size="sm">
          <Link href={AUDIT_PATH as Route}>Limpar filtros</Link>
        </Button>
      ) : null}
    </form>
  );
}
