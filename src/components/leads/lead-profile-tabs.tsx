"use client";

import { useState, type ReactNode } from "react";

const TABS = [
  { key: "visao", label: "Visão geral" },
  { key: "conversas", label: "Conversas" },
  { key: "atividades", label: "Atividades" },
  { key: "arquivos", label: "Arquivos" },
  { key: "propostas", label: "Propostas" },
  { key: "historico", label: "Histórico" },
] as const;

type TabKey = (typeof TABS)[number]["key"];

export function LeadProfileTabs(props: Record<TabKey, ReactNode>) {
  const [tab, setTab] = useState<TabKey>("visao");

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap gap-1 border-b border-border">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={`h-10 border-b-2 px-1 text-body font-semibold ${
              tab === t.key ? "border-primary text-text" : "border-transparent text-text-secondary"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div>{props[tab]}</div>
    </div>
  );
}
