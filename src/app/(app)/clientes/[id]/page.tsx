import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { Topbar } from "@/components/app-shell/topbar";
import { getShellContext } from "@/modules/shell/queries";
import { requireWorkspace } from "@/server/authz/permissions";
import { roleHasPermission } from "@/lib/roles";
import { getClient, type ClientStatus } from "@/modules/clients/queries";
import { listTeamMembers } from "@/modules/team/queries";
import { ClientStatusForm } from "@/components/clients/client-status-form";
import { TransferClientOwnerForm } from "@/components/clients/transfer-client-owner-form";
import { ClientHistoryList } from "@/components/clients/client-history-list";

const STATUS_LABEL: Record<ClientStatus, string> = {
  ativo: "Ativo",
  encerrado: "Encerrado",
  suspenso: "Suspenso",
};

function formatCents(cents: number): string {
  return (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" });
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const client = await getClient(id);
  return { title: client ? `${client.contactName} — Cliente — Praxis CRM Jurídico` : "Cliente — Praxis CRM Jurídico" };
}

export default async function ClienteDetalhePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user } = await getShellContext();
  const workspaceId = await requireWorkspace();
  const client = await getClient(id);

  // Cliente inexistente, de outro workspace, ou (advogado) sem nenhuma
  // oportunidade vinculada em seu alcance — get_client() já responde como
  // não encontrado nos três casos; a página trata os três do mesmo jeito
  // (mesmo princípio de leads/[id], A4).
  if (!client) notFound();

  const canManage = roleHasPermission(user.role, "client.manage");
  const members = canManage ? await listTeamMembers(workspaceId, user.id) : [];

  // history[0] (ordem cronológica crescente, ver get_client()) é a
  // origem — item 5 do pedido: identificada pelo primeiro handoff
  // vinculado, com ordenação determinística, sem consulta redundante.
  const origin = client.history[0];

  return (
    <>
      <Topbar title={client.contactName} subtitle={STATUS_LABEL[client.status]} user={user} />
      <main className="flex-1 overflow-y-auto p-5">
        <div className="mx-auto flex max-w-[640px] flex-col gap-5">
          <Link href={`/contatos/${client.contactId}`} className="text-meta text-primary hover:underline">
            Ver contato
          </Link>

          <section className="rounded-lg border border-border bg-surface p-4">
            <h2 className="mb-3 text-body font-semibold text-text">Dados do cliente</h2>
            <dl className="grid grid-cols-2 gap-3 text-body">
              <div>
                <dt className="text-meta text-text-tertiary">Cliente desde</dt>
                <dd className="font-mono text-text">{formatDate(client.createdAt)}</dd>
              </div>
              <div>
                <dt className="text-meta text-text-tertiary">Responsável</dt>
                <dd className="text-text">{client.ownerName ?? "Sem responsável"}</dd>
              </div>
              {origin ? (
                <div className="col-span-2">
                  <dt className="text-meta text-text-tertiary">Origem</dt>
                  <dd className="text-text">
                    <Link href={`/oportunidades/${origin.opportunityId}`} className="hover:underline">
                      {origin.legalArea}
                    </Link>
                  </dd>
                </div>
              ) : null}
              {client.valueSumCents !== undefined ? (
                <div className="col-span-2">
                  <dt className="text-meta text-text-tertiary">Valor total (oportunidades no seu alcance)</dt>
                  <dd className="font-mono text-text">{formatCents(client.valueSumCents)}</dd>
                </div>
              ) : null}
            </dl>
          </section>

          {canManage ? (
            <section className="rounded-lg border border-border bg-surface p-4">
              <h2 className="mb-3 text-body font-semibold text-text">Status</h2>
              <ClientStatusForm client={client} />
            </section>
          ) : null}

          {canManage ? (
            <section className="rounded-lg border border-border bg-surface p-4">
              <h2 className="mb-3 text-body font-semibold text-text">Responsável</h2>
              <TransferClientOwnerForm client={client} members={members} />
            </section>
          ) : null}

          <section className="rounded-lg border border-border bg-surface p-4">
            <h2 className="mb-3 text-body font-semibold text-text">Histórico</h2>
            <ClientHistoryList history={client.history} />
          </section>
        </div>
      </main>
    </>
  );
}
