import Link from "next/link";

import type { ContactListItem } from "@/modules/contacts/queries";

const TYPE_LABEL: Record<ContactListItem["type"], string> = { pf: "PF", pj: "PJ" };

export function ContactListTable({ items }: { items: ContactListItem[] }) {
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-surface">
      <table className="w-full text-left text-body">
        <thead>
          <tr className="border-b border-border text-meta text-text-tertiary">
            <th className="px-4 py-2.5 font-medium">Nome</th>
            <th className="px-4 py-2.5 font-medium">Tipo</th>
            <th className="px-4 py-2.5 font-medium">Cidade/UF</th>
            <th className="px-4 py-2.5 font-medium">Telefone</th>
            <th className="px-4 py-2.5 font-medium">E-mail</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={item.id} className="border-b border-border last:border-0 hover:bg-app">
              <td className="px-4 py-2.5">
                <Link href={`/contatos/${item.id}`} className="font-medium text-text hover:underline">
                  {item.name}
                </Link>
              </td>
              <td className="px-4 py-2.5 text-text-secondary">{TYPE_LABEL[item.type]}</td>
              <td className="px-4 py-2.5 text-text-secondary">
                {item.city ? `${item.city}${item.uf ? `/${item.uf}` : ""}` : "—"}
              </td>
              <td className="px-4 py-2.5 tabular-nums text-text-secondary">{item.phones[0] ?? "—"}</td>
              <td className="px-4 py-2.5 text-text-secondary">{item.emails[0] ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
