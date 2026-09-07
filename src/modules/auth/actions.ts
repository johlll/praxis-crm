"use server";

import type { Route } from "next";
import { redirect } from "next/navigation";

import { createServerSupabaseClient } from "@/server/supabase/server";
import { clearActiveWorkspaceCookie, getActiveWorkspaceId, switchActiveWorkspace } from "@/server/auth/workspace";
import { listMyWorkspaces } from "@/modules/workspace/queries";
import { getRequestOrigin } from "@/server/request-origin";
import { toUserMessage } from "@/lib/errors";
import { signInSchema, signUpSchema } from "./schema";

export type AuthActionState = {
  ok: boolean;
  error?: string;
};

const INITIAL_MESSAGE = "Dados inválidos.";

export async function signUpAction(
  _prevState: AuthActionState,
  formData: FormData,
): Promise<AuthActionState> {
  const parsed = signUpSchema.safeParse({
    fullName: formData.get("fullName"),
    email: formData.get("email"),
    password: formData.get("password"),
  });

  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? INITIAL_MESSAGE };
  }

  let origin: string;
  try {
    origin = await getRequestOrigin();
  } catch {
    return { ok: false, error: "Não foi possível iniciar o cadastro. Tente novamente." };
  }

  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.auth.signUp({
    email: parsed.data.email,
    password: parsed.data.password,
    options: {
      data: { full_name: parsed.data.fullName },
      emailRedirectTo: `${origin}/auth/confirm`,
    },
  });

  if (error) {
    return { ok: false, error: toUserMessage(error) };
  }

  return { ok: true };
}

/** Só caminhos internos, nunca uma URL de terceiro — impede que o campo
 * "next" seja usado para redirecionar o login para fora do próprio app. */
function sanitizeNextPath(value: FormDataEntryValue | null): Route {
  // "as Route": o destino é dinâmico (veio do campo "next"), não uma rota
  // literal que o typedRoutes consiga verificar em tempo de build — a
  // validação real (só caminho interno, nunca outra origem) é a checagem
  // acima, não o tipo.
  if (typeof value !== "string") return "/visao-geral" as Route;
  if (!value.startsWith("/") || value.startsWith("//")) return "/visao-geral" as Route;
  return value as Route;
}

export async function signInAction(
  _prevState: AuthActionState,
  formData: FormData,
): Promise<AuthActionState> {
  const parsed = signInSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
  });

  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? INITIAL_MESSAGE };
  }

  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.auth.signInWithPassword(parsed.data);

  if (error) {
    // O Supabase distingue "credenciais erradas" de outros erros pelo
    // texto — mas não repassamos o texto dele, só decidimos com base nele
    // qual mensagem NOSSA mostrar.
    return {
      ok: false,
      error: "E-mail ou senha incorretos.",
    };
  }

  // Sem isso, quem já é membro de um workspace (ex.: convidado antes,
  // relogando num navegador novo) cai no /onboarding só por falta do
  // cookie de workspace ativo — mesmo já tendo membership de verdade.
  // O id vem da própria consulta de membership do usuário, nunca do
  // cliente; switchActiveWorkspace revalida contra o banco de novo antes
  // de gravar.
  if (!(await getActiveWorkspaceId())) {
    const [firstWorkspace] = await listMyWorkspaces();
    if (firstWorkspace) {
      await switchActiveWorkspace(firstWorkspace.id);
    }
  }

  redirect(sanitizeNextPath(formData.get("next")));
}

export async function signOutAction(): Promise<void> {
  const supabase = await createServerSupabaseClient();
  await supabase.auth.signOut();
  await clearActiveWorkspaceCookie();
  redirect("/entrar");
}
