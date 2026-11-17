import Link from "next/link";
import { Scale } from "lucide-react";

import { ListTag, type ListTagTone } from "@/components/lists/list-tag";
import { NoOwnerMark, PersonInitials } from "@/components/lists/person-initials";
import type { LeadListItem } from "@/modules/leads/queries";

const PRIORITY_LABEL: Record<LeadListItem["priority"], string> = {
  baixa: "Baixa",
  media: "Média",
  alta: "Alta",
};

const PRIORITY_TONE: Record<LeadListItem["priority"], ListTagTone> = {
  baixa: "neutral",
  media: "warning",
  alta: "danger",
};

const STATUS_LABEL: Record<LeadListItem["status"], string> = {
  ativo: "Ativo",
  arquivado: "Arquivado",
};

const STATUS_TONE: Record<LeadListItem["status"], ListTagTone> = {
  ativo: "success",
  arquivado: "neutral",
};

const th = "px-4 py-2.5 text-label font-semibold tracking-[1px] text-text-tertiary uppercase";
const meta =
  "px-4 py-2.5 align-middle text-text-secondary max-md:inline-flex max-md:items-center max-md:gap-1.5 max-md:p-0 max-md:text-small";

/**
 * Componente de servidor: o navegador recebe só o HTML da linha. Status é
 * o do lead (ativo/arquivado), nunca a etapa de uma oportunidade.
 */
export function LeadListTable({ items }: { items: LeadListItem[] }) {
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-surface">
      <table className="w-full border-collapse text-left text-body max-md:block md:table-fixed">
        <caption className="sr-only">Leads do escritório</caption>
        <thead className="max-md:hidden">
          <tr className="border-b border-border bg-surface-subtle">
            <th scope="col" className={th}>Contato</th>
            <th scope="col" className={`${th} w-[180px] lg:w-[220px]`}>Área jurídica</th>
            <th scope="col" className={`${th} w-[116px]`}>Prioridade</th>
            <th scope="col" className={`${th} w-[120px]`}>Status</th>
            <th scope="col" className={`${th} w-[200px] lg:w-[230px]`}>Responsável</th>
          </tr>
        </thead>
        <tbody className="max-md:block">
          {items.map((item) => (
            <tr
              key={item.id}
              className="border-b border-border-subtle transition-colors last:border-0 focus-within:bg-surface-hover hover:bg-surface-hover max-md:relative max-md:flex max-md:flex-wrap max-md:items-center max-md:gap-x-3 max-md:gap-y-2 max-md:py-3 max-md:pr-4 max-md:pl-[60px]"
            >
              <td className="px-4 py-2.5 align-middle max-md:block max-md:basis-full max-md:p-0">
                <div className="flex min-w-0 items-center gap-3">
                  <PersonInitials name={item.contactName} className="max-md:absolute max-md:top-3 max-md:left-4" />
                  <div className="flex min-w-0 flex-col">
                    <Link
                      href={`/leads/${item.id}`}
                      className="w-fit rounded-sm font-semibold text-text [overflow-wrap:anywhere] underline-offset-2 hover:text-primary hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                    >
                      {item.contactName}
                    </Link>
                    {item.summary ? (
                      <span
                        title={item.summary}
                        className="truncate text-small text-text-muted max-md:line-clamp-2 max-md:whitespace-normal"
                      >
                        {item.summary}
                      </span>
                    ) : null}
                  </div>
                </div>
              </td>
              <td className={`${meta} max-md:basis-full`}>
                <Scale size={13} aria-hidden className="shrink-0 text-text-muted md:hidden" />
                <span className="[overflow-wrap:anywhere]">{item.legalArea}</span>
              </td>
              <td className={meta}>
                <ListTag tone={PRIORITY_TONE[item.priority]} dot>
                  <span>
                    <span className="md:sr-only">Prioridade </span>
                    <span className="max-md:lowercase">{PRIORITY_LABEL[item.priority]}</span>
                  </span>
                </ListTag>
              </td>
              <td className={meta}>
                <ListTag tone={STATUS_TONE[item.status]}>{STATUS_LABEL[item.status]}</ListTag>
              </td>
              <td className={meta}>
                {item.assignedToName ? (
                  <span className="flex min-w-0 items-center gap-2">
                    <PersonInitials name={item.assignedToName} tone="member" size="sm" />
                    <span className="truncate" title={item.assignedToName}>
                      {item.assignedToName}
                    </span>
                  </span>
                ) : (
                  <span className="flex items-center gap-2 text-text-muted">
                    <NoOwnerMark />
                    Sem responsável
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
