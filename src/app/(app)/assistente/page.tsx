import type { Metadata } from "next";

import { Topbar } from "@/components/app-shell/topbar";
import { AssistantChat } from "@/components/assistant/assistant-chat";
import { getShellContext } from "@/modules/shell/queries";

export const metadata: Metadata = {
  title: "Assistente — Praxis CRM Jurídico",
};

/**
 * Assistente: chat interno do escritório (docs/decisoes/assistente.md). A página só desenha a conversa;
 * cada mensagem vai para o servidor, que confere sessão, escritório e permissões antes de consultar ou
 * gravar. Neste ciclo a interpretação é simulada (sem provedor de IA).
 */
export default async function AssistentePage() {
  const { user, activeWorkspace } = await getShellContext();
  const firstName = user.fullName.split(/\s+/)[0] ?? user.fullName;

  return (
    <>
      <Topbar title="Assistente" subtitle="Pergunte sobre o CRM e peça operações em conversa" user={user} />
      <main className="flex min-h-0 flex-1 flex-col">
        {/* `key`: trocar de escritório começa uma conversa nova, sem rascunho do outro. */}
        <AssistantChat key={activeWorkspace.id} firstName={firstName} />
      </main>
    </>
  );
}
