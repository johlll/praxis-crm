import Link from "next/link";

import type { OpportunityListItem } from "@/modules/opportunities/queries";

function formatCents(cents: number): string {
  return (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

const STATUS_LABEL: Record<OpportunityListItem["status"], string> = {
  open: "Aberta",
  won: "Ganha",
  lost: "Perdida",
};

export function OpportunityTable({ items }: { items: OpportunityListItem[] }) {
  if (items.length === 0) {
    return <p className="text-body text-text-tertiary">Nenhuma oportunidade encontrada.</p>;
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-border bg-surface">
      <table className="w-full text-left text-body">
        <thead>
          <tr className="border-b border-border text-meta text-text-tertiary">
            <th className="px-4 py-2.5 font-medium">Contato</th>
            <th className="px-4 py-2.5 font-medium">Área jurídica</th>
            <th className="px-4 py-2.5 font-medium">Etapa</th>
            <th className="px-4 py-2.5 font-medium">Status</th>
            <th className="px-4 py-2.5 font-medium">Valor</th>
            <th className="px-4 py-2.5 font-medium">Responsável</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={item.id} className="border-b border-border last:border-0 hover:bg-app">
              <td className="px-4 py-2.5">
                <Link href={`/oportunidades/${item.id}`} className="font-medium text-text hover:underline">
                  {item.contactName}
                </Link>
              </td>
              <td className="px-4 py-2.5 text-text-secondary">{item.legalArea}</td>
              <td className="px-4 py-2.5 text-text-secondary">{item.stageName}</td>
              <td className="px-4 py-2.5 text-text-secondary">{STATUS_LABEL[item.status]}</td>
              <td className="px-4 py-2.5 font-mono text-text-secondary">
                {item.valueCents !== undefined ? formatCents(item.valueCents) : item.valueBand ?? "—"}
              </td>
              <td className="px-4 py-2.5 text-text-secondary">{item.assignedToName ?? "Sem responsável"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
