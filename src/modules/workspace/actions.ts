"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { requireUser } from "@/server/authz/permissions";
import { switchActiveWorkspace } from "@/server/auth/workspace";
import { uuidSchema } from "@/lib/uuid";

const switchWorkspaceSchema = z.object({
  workspaceId: uuidSchema,
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
  // Quem troca de workspace normalmente já está em /visao-geral (ou outra
  // página do app): redirect() para o MESMO caminho, sozinho, nem sempre
  // força o layout a reler o cookie que acabou de mudar — revalidatePath
  // invalida o cache do layout inteiro antes do redirect confirmar a
  // navegação.
  revalidatePath("/", "layout");
  redirect("/visao-geral");
}
