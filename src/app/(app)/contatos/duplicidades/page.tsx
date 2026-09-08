import type { Metadata } from "next";
import Link from "next/link";
import { Copy } from "lucide-react";

import { Topbar } from "@/components/app-shell/topbar";
import { EmptyState } from "@/components/feedback/empty-state";
import { getShellContext } from "@/modules/shell/queries";
import { requireWorkspace } from "@/server/authz/permissions";
import { listPendingDuplicateCandidates } from "@/modules/contacts/queries";
import { DuplicateCandidateRow } from "@/components/contacts/duplicate-candidate-row";

export const metadata: Metadata = {
  title: "Duplicidades — Praxis CRM Jurídico",
};

export default async function DuplicidadesPage() {
  const { user } = await getShellContext();
  const workspaceId = await requireWorkspace();
  const candidates = await listPendingDuplicateCandidates(workspaceId);

  return (
    <>
      <Topbar
        title="Possíveis duplicidades"
        subtitle={`${candidates.length} ${candidates.length === 1 ? "sugestão pendente" : "sugestões pendentes"}`}
        user={user}
      />
      <main className="flex-1 overflow-y-auto p-5">
        <div className="mx-auto flex max-w-[720px] flex-col gap-3">
          <p className="text-meta text-text-tertiary">
            Nenhuma sugestão aqui mescla contatos automaticamente — cada uma precisa de uma decisão sua. A
            ordem é só prioridade de revisão, nunca uma probabilidade de que sejam a mesma pessoa.{" "}
            <Link href="/contatos" className="text-primary hover:underline">
              Voltar para Contatos
            </Link>
          </p>

          {candidates.length === 0 ? (
            <EmptyState
              icon={Copy}
              title="Nenhuma duplicidade pendente"
              description="Sugestões aparecem aqui quando dois contatos compartilham CPF, telefone, e-mail, ou nome e cidade parecidos."
            />
          ) : (
            <div className="flex flex-col gap-2">
              {candidates.map((candidate) => (
                <DuplicateCandidateRow key={candidate.id} candidate={candidate} />
              ))}
            </div>
          )}
        </div>
      </main>
    </>
  );
}
