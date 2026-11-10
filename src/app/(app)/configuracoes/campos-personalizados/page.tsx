import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { SlidersHorizontal } from "lucide-react";

import { Topbar } from "@/components/app-shell/topbar";
import { CustomFieldDefinitionList } from "@/components/custom-fields/definition-list";
import { EmptyState } from "@/components/feedback/empty-state";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { listCustomFieldDefinitions } from "@/modules/custom-fields/queries";
import { getShellContext } from "@/modules/shell/queries";
import { requireMembership, roleHasPermission } from "@/server/authz/permissions";

export const metadata: Metadata = {
  title: "Campos personalizados — Praxis CRM Jurídico",
};

/**
 * Administração dos campos personalizados (C4 mínima). Só `custom_field.manage`
 * (proprietário e administrador); qualquer outro papel recebe "não encontrado",
 * nunca "proibido". O workspace vem SEMPRE da sessão; o banco repete a checagem
 * e trata workspace alheio como inexistente.
 */
export default async function CamposPersonalizadosPage() {
  const membership = await requireMembership();
  if (!roleHasPermission(membership.role, "custom_field.manage")) {
    notFound();
  }

  const { user, activeWorkspace } = await getShellContext();
  const definitions = await listCustomFieldDefinitions(membership.workspaceId);
  // O banco recusou (papel mudou desde que a página abriu): mesma resposta de quem nunca teve acesso.
  if (definitions === null) notFound();

  return (
    <>
      <Topbar title="Campos personalizados" subtitle={activeWorkspace.name} user={user} />
      <main className="flex-1 overflow-y-auto p-5">
        <div className="mx-auto flex max-w-[900px] flex-col gap-6">
          <p className="m-0 text-meta text-text-muted">
            Crie campos próprios para contatos, leads, oportunidades e clientes. Eles aparecem na tela de cada registro e
            seguem as mesmas permissões da própria tela: quem não vê o registro não vê o campo. Tipos disponíveis: texto
            curto, número, data, sim ou não e seleção única.
          </p>

          <Alert variant="warning">
            <AlertDescription>
              Não use campos personalizados para CPF, credenciais, senhas ou outros segredos. Arquivar um campo não apaga o
              que já foi preenchido.
            </AlertDescription>
          </Alert>

          {definitions.length === 0 ? (
            <EmptyState
              icon={SlidersHorizontal}
              title="Nenhum campo personalizado ainda"
              description="Use “Novo campo” em uma das entidades abaixo para criar o primeiro."
            />
          ) : null}

          <CustomFieldDefinitionList definitions={definitions} />
        </div>
      </main>
    </>
  );
}
