import Link from "next/link";

import type { ClientHistoryItem } from "@/modules/clients/queries";
import { HandoffCard } from "./handoff-card";

const FEE_MODEL_LABEL: Record<string, string> = {
  fixed: "Valor fixo",
  contingency: "Êxito",
  fixed_contingency: "Fixo + êxito",
};

function formatCents(cents: number): string {
  return (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" });
}

export function ClientHistoryList({ history }: { history: ClientHistoryItem[] }) {
  if (history.length === 0) {
    return (
      <p className="text-meta text-text-tertiary">
        Nenhuma oportunidade vinculada dentro do seu alcance de acesso.
      </p>
    );
  }

  return (
    <ul className="flex flex-col gap-3">
      {history.map((item) => (
        <li key={item.opportunityId} className="rounded-lg border border-border bg-surface p-3">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <Link href={`/oportunidades/${item.opportunityId}`} className="font-medium text-text hover:underline">
                {item.legalArea}
              </Link>
              <p className="text-meta text-text-tertiary">
                Ganha em {item.wonAt ? formatDate(item.wonAt) : "—"}
                {item.signedAt ? ` · Assinada em ${formatDate(item.signedAt)}` : ""}
              </p>
            </div>
            <div className="text-right">
              <p className="font-mono text-text">
                {item.valueCents !== undefined ? formatCents(item.valueCents) : (item.valueBand ?? "—")}
              </p>
              {item.feeModel ? (
                <p className="text-meta text-text-tertiary">{FEE_MODEL_LABEL[item.feeModel] ?? item.feeModel}</p>
              ) : null}
            </div>
          </div>
          <div className="mt-2">
            <HandoffCard item={item} />
          </div>
        </li>
      ))}
    </ul>
  );
}
