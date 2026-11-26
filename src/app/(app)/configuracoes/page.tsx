import Link from "next/link";
import type { Metadata, Route } from "next";
import {
  Users,
  Workflow,
  MessageCircle,
  Building2,
  CalendarDays,
  ScrollText,
  SlidersHorizontal,
  ListChecks,
  Plug,
  type LucideIcon,
} from "lucide-react";

import { Topbar } from "@/components/app-shell/topbar";
import { getShellContext } from "@/modules/shell/queries";
import { requireMembership, roleHasPermission } from "@/server/authz/permissions";

export const metadata: Metadata = {
  title: "Configurações — Praxis CRM Jurídico",
};

export default async function ConfiguracoesPage() {
  const { user } = await getShellContext();
  const membership = await requireMembership();
  const canConfigurePipeline = roleHasPermission(membership.role, "pipeline.configure");
  const canUseSimulator = roleHasPermission(membership.role, "conversation.simulate");
  const canManageLegalProfile = roleHasPermission(membership.role, "workspace_legal_profile.manage");
  const canConnectCalendar = roleHasPermission(membership.role, "calendar.connect_own");
  const canViewAudit = roleHasPermission(membership.role, "audit_log.view");
  const canManageCustomFields = roleHasPermission(membership.role, "custom_field.manage");
  const canManageServiceCatalog = roleHasPermission(membership.role, "service_catalog.manage");

  // Cada seção só aparece para quem tem a permissão: mostrá-la apagada
  // daria a entender que ainda não foi construída, o que é falso.
  const readySections: Array<{ href: Route; icon: LucideIcon; title: string; description: string }> = [
    {
      href: "/configuracoes/equipe",
      icon: Users,
      title: "Equipe",
      description: "Membros, papéis e convites do workspace.",
    },
    ...(canConnectCalendar
      ? [
          {
            href: "/configuracoes/integracoes" as Route,
            icon: CalendarDays,
            title: "Google Agenda",
            description: "Conectar sua conta e escolher a agenda vinculada aos compromissos.",
          },
        ]
      : []),
    ...(canManageLegalProfile
      ? [
          {
            href: "/configuracoes/escritorio" as Route,
            icon: Building2,
            title: "Escritório",
            description: "Razão social, CNPJ, OAB e endereço — cabeçalho do PDF de proposta.",
          },
        ]
      : []),
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
    ...(canManageServiceCatalog
      ? [
          {
            href: "/configuracoes/tipos-de-servico" as Route,
            icon: ListChecks,
            title: "Tipos de serviço",
            description: "Roteiros de etapas que os casos ganhos podem receber.",
          },
        ]
      : []),
    ...(canManageCustomFields
      ? [
          {
            href: "/configuracoes/campos-personalizados" as Route,
            icon: SlidersHorizontal,
            title: "Campos personalizados",
            description: "Campos próprios de contatos, leads, oportunidades e clientes.",
          },
        ]
      : []),
    ...(canViewAudit
      ? [
          {
            href: "/configuracoes/auditoria" as Route,
            icon: ScrollText,
            title: "Auditoria",
            description: "Quem fez o quê no workspace — somente leitura.",
          },
        ]
      : []),
    ...(canUseSimulator
      ? [
          {
            href: "/configuracoes/simulador-whatsapp" as Route,
            icon: MessageCircle,
            title: "Simulador de WhatsApp",
            description: "Canais e mensagens simuladas — sem conexão real com a Meta.",
          },
        ]
      : []),
    {
      href: "/integracoes",
      icon: Plug,
      title: "Central de Integrações",
      description: "Situação de cada ferramenta, inclusive WhatsApp, anúncios e assinatura.",
    },
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
        </div>
      </main>
    </>
  );
}
