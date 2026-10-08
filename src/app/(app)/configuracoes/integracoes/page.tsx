import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { Topbar } from "@/components/app-shell/topbar";
import {
  ConnectCalendarForm,
  DisconnectCalendarForm,
  SelectCalendarForm,
} from "@/components/calendar/calendar-connection-forms";
import { getShellContext } from "@/modules/shell/queries";
import { listCalendarConnections, listChoosableCalendars } from "@/modules/calendar/queries";
import { requireMembership, roleHasPermission } from "@/server/authz/permissions";
import { getCalendarProvider } from "@/server/calendar/provider";

export const metadata: Metadata = {
  title: "Integrações — Praxis CRM Jurídico",
};

export default async function IntegracoesPage() {
  const { user, activeWorkspace } = await getShellContext();
  const membership = await requireMembership();

  // Mesmo padrão das outras telas de Configurações: quem não tem a
  // permissão nem enxerga a página.
  if (!roleHasPermission(membership.role, "calendar.connect_own")) notFound();

  const provider = await getCalendarProvider();

  // Integração DESATIVADA: nada de B2 é consultado no banco. Importa em
  // deployment que antecede a aplicação da migration da B2 no hospedado —
  // as RPCs de calendário ainda não existem lá, e a tela precisa chegar ao
  // aviso em vez de quebrar. Com a integração HABILITADA o contrário vale:
  // erro de banco sobe (error.tsx) e nunca é mascarado como "sem conexões".
  if (!provider) {
    return (
      <>
        <Topbar title="Integrações" subtitle="Google Agenda" user={user} />
        <main className="flex-1 overflow-y-auto p-5">
          <div className="mx-auto flex max-w-[560px] flex-col gap-4">
            <div className="rounded-lg border border-border bg-surface p-4 text-body">
              A integração com o Google Agenda ainda não está configurada neste ambiente.
            </div>
          </div>
        </main>
      </>
    );
  }

  const connections = await listCalendarConnections(activeWorkspace.id);
  const mine = connections.find((c) => c.isMine);
  const canManage = roleHasPermission(membership.role, "calendar.manage");

  const calendars =
    mine && mine.status === "active" && !mine.calendarId
      ? await listChoosableCalendars({
          connectionId: mine.id,
          workspaceId: activeWorkspace.id,
          actorUserId: membership.userId,
        })
      : [];

  return (
    <>
      <Topbar title="Integrações" subtitle="Google Agenda" user={user} />
      <main className="flex-1 overflow-y-auto p-5">
        <div className="mx-auto flex max-w-[560px] flex-col gap-4">
          {mine ? (
            <div className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4">
              <div>
                <p className="text-body font-semibold">Sua conta: {mine.googleAccountEmail}</p>
                <p className="text-meta text-text-tertiary">
                  {mine.calendarId ? `Agenda vinculada: ${mine.calendarSummary ?? mine.calendarId}` : "Nenhuma agenda vinculada ainda."}
                </p>
                {mine.status === "needs_reauth" ? (
                  <p className="text-meta text-danger">A conexão precisa ser autorizada novamente.</p>
                ) : null}
              </div>
              {calendars.length > 0 ? (
                <SelectCalendarForm
                  connectionId={mine.id}
                  calendars={calendars.map((c) => ({ id: c.id, summary: c.summary }))}
                />
              ) : null}
              <DisconnectCalendarForm connectionId={mine.id} />
            </div>
          ) : (
            <div className="rounded-lg border border-border bg-surface p-4">
              <ConnectCalendarForm />
            </div>
          )}

          {canManage && connections.some((c) => !c.isMine) ? (
            <div className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-4">
              <p className="text-body font-semibold">Conexões da equipe</p>
              {connections
                .filter((c) => !c.isMine)
                .map((c) => (
                  <div key={c.id} className="flex items-center justify-between gap-3 text-body">
                    <span>
                      {c.googleAccountEmail}
                      <span className="ml-2 text-meta text-text-tertiary">{c.status}</span>
                    </span>
                    <DisconnectCalendarForm connectionId={c.id} />
                  </div>
                ))}
            </div>
          ) : null}
        </div>
      </main>
    </>
  );
}
