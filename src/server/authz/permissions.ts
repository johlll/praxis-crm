import { redirect } from "next/navigation";

import { createServerSupabaseClient } from "@/server/supabase/server";
import { getActiveWorkspaceId } from "@/server/auth/workspace";
import { roleHasPermission, type Permission, type Role } from "@/lib/roles";

export type { Permission, Role } from "@/lib/roles";
export { ROLES, ROLE_LABEL, roleHasPermission } from "@/lib/roles";

/**
 * Erro tipado para toda falha de autorização. O código é o que a camada de
 * UI usa para decidir a mensagem sanitizada — o texto de `message` é só
 * para log interno, nunca renderizado direto (checklist §8: nenhum erro
 * interno exibido ao usuário).
 */
export class AuthzError extends Error {
  constructor(
    public readonly code:
      | "unauthenticated"
      | "no_active_workspace"
      | "not_a_member"
      | "forbidden",
    message: string,
  ) {
    super(message);
    this.name = "AuthzError";
  }
}

/**
 * Identidade verificada no servidor — `getUser()`, não `getSession()`: o
 * primeiro valida o JWT contra o Supabase Auth a cada chamada, o segundo
 * só lê o cookie sem confirmar que ainda vale. Nunca use dado de sessão
 * não verificado para autorizar operação nenhuma.
 */
export async function requireUser() {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();

  if (error || !user) {
    throw new AuthzError("unauthenticated", "Sessão ausente ou inválida.");
  }

  return user;
}

/** O workspace ativo já revalidado contra membership real (ver
 * src/server/auth/workspace.ts) — nunca o id cru do cookie. */
export async function requireWorkspace(): Promise<string> {
  const workspaceId = await getActiveWorkspaceId();
  if (!workspaceId) {
    throw new AuthzError("no_active_workspace", "Nenhum workspace ativo válido.");
  }
  return workspaceId;
}

export type MembershipContext = {
  userId: string;
  workspaceId: string;
  membershipId: string;
  role: Role;
};

/**
 * Confirma, nesta chamada, que o usuário autenticado tem membership ativa
 * no workspace ativo — nunca confia em nada carregado antes. Consulta via
 * RLS: se a linha não existir para este usuário, o resultado é vazio (não
 * um erro de permissão do Postgres), o que já é o comportamento "responde
 * como não encontrado" pedido pela seção 5 do prompt.
 */
export async function requireMembership(): Promise<MembershipContext> {
  const user = await requireUser();
  const workspaceId = await requireWorkspace();

  const supabase = await createServerSupabaseClient();
  const { data } = await supabase
    .from("memberships")
    .select("id, role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", user.id)
    .eq("status", "active")
    .maybeSingle();

  if (!data) {
    throw new AuthzError("not_a_member", "Sem membership ativa neste workspace.");
  }

  return { userId: user.id, workspaceId, membershipId: data.id, role: data.role };
}

export async function requirePermission(permission: Permission): Promise<MembershipContext> {
  const ctx = await requireMembership();
  if (!roleHasPermission(ctx.role, permission)) {
    throw new AuthzError(
      "forbidden",
      `Papel "${ctx.role}" não tem a permissão "${permission}".`,
    );
  }
  return ctx;
}

/**
 * Para o topo de Server Components de página: garante sessão e workspace
 * ativo, redirecionando para o lugar certo em vez de deixar a página
 * quebrar com um erro cru. Use `requirePermission`/`requireMembership`
 * direto em Server Actions, onde redirecionar não faz sentido — lá o
 * chamador decide o que fazer com o AuthzError.
 */
export async function requireUserOrRedirect() {
  try {
    return await requireUser();
  } catch {
    redirect("/entrar");
  }
}

export async function requireMembershipOrRedirect(): Promise<MembershipContext> {
  await requireUserOrRedirect();
  try {
    return await requireMembership();
  } catch (error) {
    if (error instanceof AuthzError && error.code === "no_active_workspace") {
      redirect("/onboarding");
    }
    redirect("/entrar");
  }
}
