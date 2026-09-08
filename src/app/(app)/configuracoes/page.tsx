import Link from "next/link";
import type { Metadata } from "next";
import { Users } from "lucide-react";

import { Topbar } from "@/components/app-shell/topbar";
import { getShellContext } from "@/modules/shell/queries";

export const metadata: Metadata = {
  title: "Configurações — Praxis CRM Jurídico",
};

const SECTIONS = [
  {
    href: "/configuracoes/equipe" as const,
    icon: Users,
    title: "Equipe",
    description: "Membros, papéis e convites do workspace.",
    ready: true,
  },
  {
    href: null,
    title: "Pipelines",
    description: "Etapas e requisitos de avanço.",
    phase: "A5",
    ready: false,
  },
  {
    href: null,
    title: "Integrações",
    description: "Google Agenda, WhatsApp.",
    phase: "B",
    ready: false,
  },
  {
    href: null,
    title: "Auditoria",
    description: "Trilha de ações do workspace.",
    phase: "C",
    ready: false,
  },
] as const;

export default async function ConfiguracoesPage() {
  const { user } = await getShellContext();

  return (
    <>
      <Topbar title="Configurações" subtitle="Equipe, pipelines, integrações e auditoria" user={user} />
      <main className="flex-1 overflow-y-auto p-5">
        <div className="mx-auto grid max-w-[720px] grid-cols-2 gap-3">
          {SECTIONS.map((section) =>
            section.ready && section.href ? (
              <Link
                key={section.title}
                href={section.href}
                className="flex flex-col gap-1 rounded-lg border border-border bg-surface p-4 no-underline transition-colors hover:border-primary hover:no-underline"
              >
                <span className="flex items-center gap-2 text-body font-semibold text-text">
                  <section.icon size={16} className="text-primary" aria-hidden />
                  {section.title}
                </span>
                <span className="text-small text-text-tertiary">{section.description}</span>
              </Link>
            ) : (
              <div
                key={section.title}
                className="flex flex-col gap-1 rounded-lg border border-dashed border-border bg-surface-subtle p-4 opacity-60"
              >
                <span className="text-body font-semibold text-text">{section.title}</span>
                <span className="text-small text-text-tertiary">
                  {section.description} — fase {section.phase}
                </span>
              </div>
            ),
          )}
        </div>
      </main>
    </>
  );
}
