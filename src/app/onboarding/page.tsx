import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { requireUser } from "@/server/authz/permissions";
import { getActiveWorkspaceId } from "@/server/auth/workspace";
import { CreateWorkspaceForm } from "@/components/onboarding/create-workspace-form";

export const metadata: Metadata = {
  title: "Criar workspace — Praxis CRM Jurídico",
};

/**
 * Só chega aqui quem está autenticado mas ainda sem workspace ativo — quem
 * já tem um é mandado direto para dentro (evita o onboarding aparecer para
 * quem só está sem cookie de workspace ativo por outro motivo).
 */
export default async function OnboardingPage() {
  await requireUser();

  const activeWorkspaceId = await getActiveWorkspaceId();
  if (activeWorkspaceId) {
    redirect("/visao-geral");
  }

  return (
    <div className="flex min-h-dvh items-center justify-center bg-canvas px-4">
      <div className="flex w-full max-w-[420px] flex-col gap-6">
        <div className="flex flex-col gap-1 text-center">
          <h1 className="text-lead font-semibold text-text">
            Crie o workspace do seu escritório
          </h1>
          <p className="text-small text-text-tertiary">
            É o espaço isolado onde ficam os dados do seu escritório — outros
            escritórios nunca veem nada daqui.
          </p>
        </div>
        <CreateWorkspaceForm />
      </div>
    </div>
  );
}
