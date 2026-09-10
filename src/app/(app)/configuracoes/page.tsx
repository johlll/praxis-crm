import Link from "next/link";
import type { Metadata, Route } from "next";
import { Users, Workflow, type LucideIcon } from "lucide-react";

import { Topbar } from "@/components/app-shell/topbar";
import { getShellContext } from "@/modules/shell/queries";
import { requireMembership, roleHasPermission } from "@/server/authz/permissions";

export const metadata: Metadata = {
  title: "Configurações — Praxis CRM Jurídico",
};

const FUTURE_SECTIONS = [
  {
    title: "Integrações",
    description: "Google Agenda, WhatsApp.",
    phase: "B",
  },
  {
    title: "Auditoria",
    description: "Trilha de ações do workspace.",
    phase: "C",
  },
] as const;

export default async function ConfiguracoesPage() {
  const { user } = await getShellContext();
  const membership = await requireMembership();
  const canConfigurePipeline = roleHasPermission(membership.role, "pipeline.configure");

  // "Pipelines" só aparece para quem tem a permissão — diferente das
  // seções de fase futura abaixo (que todo mundo vê como "ainda não
  // existe"), esta já existe, só não é para o papel atual: mostrá-la
  // acinzentada seria dizer "ainda não construído", o que é falso.
  const readySections: Array<{ href: Route; icon: LucideIcon; title: string; description: string }> = [
    {
      href: "/configuracoes/equipe",
      icon: Users,
      title: "Equipe",
      description: "Membros, papéis e convites do workspace.",
    },
    ...(canConfigurePipeline
      ? [
          {
            href: "/configuracoes/pipelines" as Route,
            icon: Workflow,
            title: "Pipelines",
            description: "Etapas, requisitos de avanço e motivos de perda.",
          },
        ]
      : []),
  ];

  return (
    <>
      <Topbar title="Configurações" subtitle="Equipe, pipelines, integrações e auditoria" user={user} />
      <main className="flex-1 overflow-y-auto p-5">
        <div className="mx-auto grid max-w-[720px] grid-cols-2 gap-3">
          {readySections.map((section) => (
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
          ))}
          {FUTURE_SECTIONS.map((section) => (
            <div
              key={section.title}
              className="flex flex-col gap-1 rounded-lg border border-dashed border-border bg-surface-subtle p-4 opacity-60"
            >
              <span className="text-body font-semibold text-text">{section.title}</span>
              <span className="text-small text-text-tertiary">
                {section.description} — fase {section.phase}
              </span>
            </div>
          ))}
        </div>
      </main>
    </>
  );
}
