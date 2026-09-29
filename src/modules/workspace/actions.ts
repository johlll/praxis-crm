"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { requireUser } from "@/server/authz/permissions";
import { requirePermissionSafe } from "@/server/authz/safe";
import { createServerSupabaseClient } from "@/server/supabase/server";
import { toUserMessage } from "@/lib/errors";
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

export type UpdateWorkspaceLegalProfileState = { ok: boolean; error?: string };

const OPTIONAL_TRIMMED = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === "" ? null : v))
    .nullable()
    .optional()
    .transform((v) => v ?? null);

const updateLegalProfileSchema = z.object({
  legalName: OPTIONAL_TRIMMED(200),
  cnpj: z
    .string()
    .transform((v) => v.replace(/\D/g, ""))
    .transform((v) => (v === "" ? null : v))
    .nullable()
    .optional()
    .transform((v) => v ?? null),
  oabUf: OPTIONAL_TRIMMED(2),
  oabNumber: OPTIONAL_TRIMMED(40),
  addressLine: OPTIONAL_TRIMMED(200),
  addressCity: OPTIONAL_TRIMMED(120),
  addressUf: OPTIONAL_TRIMMED(2),
  addressZip: z
    .string()
    .transform((v) => v.replace(/\D/g, ""))
    .transform((v) => (v === "" ? null : v))
    .nullable()
    .optional()
    .transform((v) => v ?? null),
});

/**
 * Perfil jurídico do escritório (B1) — cabeçalho do PDF de proposta.
 * Nenhum campo é obrigatório (checklist B1, correção 6): salvar em branco
 * é permitido, só reduz o que aparece no documento. UPDATE direto na
 * tabela, sob a sessão do usuário — workspaces_update (A2) já restringe a
 * owner/admin, nenhuma função nova é necessária.
 */
export async function updateWorkspaceLegalProfileAction(
  workspaceId: string,
  _prevState: UpdateWorkspaceLegalProfileState,
  formData: FormData,
): Promise<UpdateWorkspaceLegalProfileState> {
  const guard = await requirePermissionSafe("workspace_legal_profile.manage");
  if ("error" in guard) return { ok: false, error: guard.error };

  const parsed = updateLegalProfileSchema.safeParse({
    legalName: formData.get("legalName") ?? "",
    cnpj: formData.get("cnpj") ?? "",
    oabUf: formData.get("oabUf") ?? "",
    oabNumber: formData.get("oabNumber") ?? "",
    addressLine: formData.get("addressLine") ?? "",
    addressCity: formData.get("addressCity") ?? "",
    addressUf: formData.get("addressUf") ?? "",
    addressZip: formData.get("addressZip") ?? "",
  });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Dados inválidos." };
  }

  const supabase = await createServerSupabaseClient();
  const { error } = await supabase
    .from("workspaces")
    .update({
      legal_name: parsed.data.legalName,
      cnpj: parsed.data.cnpj,
      oab_uf: parsed.data.oabUf ? parsed.data.oabUf.toUpperCase() : null,
      oab_number: parsed.data.oabNumber,
      address_line: parsed.data.addressLine,
      address_city: parsed.data.addressCity,
      address_uf: parsed.data.addressUf ? parsed.data.addressUf.toUpperCase() : null,
      address_zip: parsed.data.addressZip,
    })
    .eq("id", workspaceId);

  if (error) return { ok: false, error: toUserMessage(error) };

  revalidatePath("/configuracoes/escritorio");
  return { ok: true };
}
