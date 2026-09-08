"use server";

import { redirect } from "next/navigation";

import { createServerSupabaseClient } from "@/server/supabase/server";
import { requireUser } from "@/server/authz/permissions";
import { switchActiveWorkspace } from "@/server/auth/workspace";
import { toUserMessage } from "@/lib/errors";
import { createWorkspaceSchema } from "./schema";

export type OnboardingActionState = {
  ok: boolean;
  error?: string;
};

/**
 * Cria o primeiro workspace do usuário e já entra nele. Toda a atomicidade
 * (workspace + membership de owner + auditoria) é da função
 * create_workspace_with_owner() no banco — esta action só valida entrada,
 * chama a função com a sessão do usuário (nunca service_role) e ativa o
 * workspace resultante.
 */
export async function createWorkspaceAction(
  _prevState: OnboardingActionState,
  formData: FormData,
): Promise<OnboardingActionState> {
  await requireUser();

  const parsed = createWorkspaceSchema.safeParse({
    name: formData.get("name"),
    slug: formData.get("slug"),
  });

  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Dados inválidos." };
  }

  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("create_workspace_with_owner", {
    p_name: parsed.data.name,
    p_slug: parsed.data.slug,
  });

  console.error("[DEBUG createWorkspaceAction] rpc data:", JSON.stringify(data), "error:", JSON.stringify(error));

  if (error || !data) {
    if (error?.code === "23505") {
      return { ok: false, error: "Esse identificador já está em uso. Tente outro." };
    }
    return { ok: false, error: toUserMessage(error) };
  }

  const switchResult = await switchActiveWorkspace(data.id);
  console.error("[DEBUG createWorkspaceAction] switchResult:", JSON.stringify(switchResult));
  redirect("/visao-geral");
}
