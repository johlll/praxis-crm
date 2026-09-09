import Link from "next/link";

import type { LeadListItem } from "@/modules/leads/queries";

const PRIORITY_LABEL: Record<LeadListItem["priority"], string> = {
  baixa: "Baixa",
  media: "Média",
  alta: "Alta",
};

const PRIORITY_DOT: Record<LeadListItem["priority"], string> = {
  baixa: "bg-text-tertiary",
  media: "bg-warning",
  alta: "bg-danger",
};

const STATUS_LABEL: Record<LeadListItem["status"], string> = {
  ativo: "Ativo",
  arquivado: "Arquivado",
};

export function LeadListTable({ items }: { items: LeadListItem[] }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-border bg-surface">
      <table className="w-full text-left text-body">
        <thead>
          <tr className="border-b border-border text-meta text-text-tertiary">
            <th className="px-4 py-2.5 font-medium">Contato</th>
            <th className="px-4 py-2.5 font-medium">Área jurídica</th>
            <th className="px-4 py-2.5 font-medium">Prioridade</th>
            <th className="px-4 py-2.5 font-medium">Status</th>
            <th className="px-4 py-2.5 font-medium">Responsável</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={item.id} className="border-b border-border last:border-0 hover:bg-app">
              <td className="px-4 py-2.5">
                <Link href={`/leads/${item.id}`} className="font-medium text-text hover:underline">
                  {item.contactName}
                </Link>
                {item.summary ? (
                  <p className="truncate text-meta text-text-tertiary" style={{ maxWidth: 260 }}>
                    {item.summary}
                  </p>
                ) : null}
              </td>
              <td className="px-4 py-2.5 text-text-secondary">{item.legalArea}</td>
              <td className="px-4 py-2.5">
                <span className="inline-flex items-center gap-1.5 text-text-secondary">
                  <span className={`size-1.5 rounded-full ${PRIORITY_DOT[item.priority]}`} aria-hidden />
                  {PRIORITY_LABEL[item.priority]}
                </span>
              </td>
              <td className="px-4 py-2.5 text-text-secondary">{STATUS_LABEL[item.status]}</td>
              <td className="px-4 py-2.5 text-text-secondary">{item.assignedToName ?? "Sem responsável"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
