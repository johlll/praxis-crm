import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { Topbar } from "@/components/app-shell/topbar";
import { getShellContext } from "@/modules/shell/queries";
import { requireMembership, roleHasPermission } from "@/server/authz/permissions";
import { listWhatsAppChannels } from "@/modules/conversations/queries";
import { EmptyState } from "@/components/feedback/empty-state";
import { CreateChannelForm } from "@/components/conversations/create-channel-form";
import { SimulateInboundForm } from "@/components/conversations/simulate-inbound-form";

export const metadata: Metadata = { title: "Simulador de WhatsApp — Praxis CRM Jurídico" };

export default async function SimuladorWhatsAppPage() {
  const membership = await requireMembership();
  if (!roleHasPermission(membership.role, "conversation.simulate")) {
    notFound();
  }

  const { user, activeWorkspace } = await getShellContext();
  const channels = await listWhatsAppChannels(activeWorkspace.id);

  return (
    <>
      <Topbar
        title="Simulador de WhatsApp"
        subtitle="Emite eventos no mesmo formato da Cloud API real — sem conexão com a Meta"
        user={user}
      />
      <main className="flex-1 overflow-y-auto p-5">
        <div className="mx-auto flex max-w-[640px] flex-col gap-5">
          <section className="rounded-card border border-border bg-surface p-4">
            <h2 className="mb-3 text-body font-semibold text-text">Canais</h2>
            {channels.length === 0 ? (
              <EmptyState
                title="Nenhum canal configurado"
                description="Crie um canal (fictício) para começar a simular mensagens recebidas."
              />
            ) : (
              <ul className="mb-3 flex flex-col gap-1">
                {channels.map((c) => (
                  <li key={c.id} className="flex items-center justify-between rounded-md border border-border px-3 py-2 text-meta">
                    <span className="font-semibold text-text">{c.label}</span>
                    <span className="text-text-tertiary">
                      {c.displayPhoneNumber} · {c.phoneNumberId}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <CreateChannelForm workspaceId={activeWorkspace.id} />
          </section>

          {channels.length > 0 ? (
            <section className="rounded-card border border-border bg-surface p-4">
              <h2 className="mb-1 text-body font-semibold text-text">Simular mensagem recebida</h2>
              <p className="mb-3 text-meta text-text-tertiary">
                Número desconhecido cria contato/lead/oportunidade/atividade automaticamente; número já cadastrado
                reaproveita. Enviar o mesmo evento de novo não duplica nada.
              </p>
              <SimulateInboundForm channels={channels} />
            </section>
          ) : null}
        </div>
      </main>
    </>
  );
}
