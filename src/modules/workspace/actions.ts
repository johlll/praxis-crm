"use server";

import { redirect } from "next/navigation";
import { z } from "zod";

import { requireUser } from "@/server/authz/permissions";
import { switchActiveWorkspace } from "@/server/auth/workspace";

const switchWorkspaceSchema = z.object({
  workspaceId: z.string().uuid(),
});

/**
 * Troca de workspace ativo — o fluxo completo pedido pela seção 4: o
 * navegador só PEDE; switchActiveWorkspace() é quem consulta a membership
 * real antes de gravar qualquer cookie. Se não for membro, nada é
 * alterado e a página recarrega no workspace que já estava ativo (ou
 * onboarding, se nenhum).
 */
export async function switchWorkspaceAction(formData: FormData): Promise<void> {
  await requireUser();

  const parsed = switchWorkspaceSchema.safeParse({
    workspaceId: formData.get("workspaceId"),
  });

  if (!parsed.success) {
    redirect("/visao-geral");
  }

  await switchActiveWorkspace(parsed.data.workspaceId);
  redirect("/visao-geral");
}
