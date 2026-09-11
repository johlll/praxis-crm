import Link from "next/link";

import type { ClientListItem } from "@/modules/clients/queries";

const STATUS_LABEL: Record<ClientListItem["status"], string> = {
  ativo: "Ativo",
  encerrado: "Encerrado",
  suspenso: "Suspenso",
};

const STATUS_DOT: Record<ClientListItem["status"], string> = {
  ativo: "bg-success",
  encerrado: "bg-text-tertiary",
  suspenso: "bg-warning",
};

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" });
}

export function ClientListTable({ items }: { items: ClientListItem[] }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-border bg-surface">
      <table className="w-full text-left text-body">
        <thead>
          <tr className="border-b border-border text-meta text-text-tertiary">
            <th className="px-4 py-2.5 font-medium">Contato</th>
            <th className="px-4 py-2.5 font-medium">Status</th>
            <th className="px-4 py-2.5 font-medium">Responsável</th>
            <th className="px-4 py-2.5 font-medium">Cliente desde</th>
            <th className="px-4 py-2.5 font-medium">Oportunidades</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={item.id} className="border-b border-border last:border-0 hover:bg-app">
              <td className="px-4 py-2.5">
                <Link href={`/clientes/${item.id}`} className="font-medium text-text hover:underline">
                  {item.contactName}
                </Link>
              </td>
              <td className="px-4 py-2.5">
                <span className="inline-flex items-center gap-1.5 text-text-secondary">
                  <span className={`size-1.5 rounded-full ${STATUS_DOT[item.status]}`} aria-hidden />
                  {STATUS_LABEL[item.status]}
                </span>
              </td>
              <td className="px-4 py-2.5 text-text-secondary">{item.ownerName ?? "Sem responsável"}</td>
              <td className="px-4 py-2.5 font-mono text-meta text-text-secondary">{formatDate(item.createdAt)}</td>
              <td className="px-4 py-2.5 text-text-secondary">{item.opportunityCount}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
