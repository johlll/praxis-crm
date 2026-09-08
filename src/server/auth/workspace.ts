import { createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";

import { getEnv } from "@/server/env";
import { createServerSupabaseClient } from "@/server/supabase/server";

/**
 * Workspace ativo: um cookie assinado (HMAC-SHA256) guarda só o
 * `workspace_id` — nunca papel, nome ou qualquer outro dado. A assinatura
 * só prova que o valor não foi adulterado DEPOIS de emitido; ela nunca é,
 * sozinha, prova de que a membership continua válida. Por isso toda leitura
 * (getActiveWorkspaceId) revalida contra o banco via RLS a cada chamada —
 * exatamente o fluxo pedido: navegador solicita → servidor consulta a
 * membership real → só então grava/confirma.
 */
const COOKIE_NAME = "praxis_active_workspace";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function sign(workspaceId: string): string {
  const secret = getEnv().WORKSPACE_ACTIVE_COOKIE_SECRET;
  const mac = createHmac("sha256", secret).update(workspaceId).digest("hex");
  return `${workspaceId}.${mac}`;
}

/** Verifica a assinatura; devolve o workspace_id só se ela bater e o
 * formato for mesmo um uuid — nunca confia no valor sozinho. */
function verifySignature(cookieValue: string): string | null {
  const separatorIndex = cookieValue.lastIndexOf(".");
  if (separatorIndex === -1) return null;

  const workspaceId = cookieValue.slice(0, separatorIndex);
  const mac = cookieValue.slice(separatorIndex + 1);

  if (!UUID_RE.test(workspaceId)) return null;

  const secret = getEnv().WORKSPACE_ACTIVE_COOKIE_SECRET;
  const expectedMac = createHmac("sha256", secret).update(workspaceId).digest("hex");

  const macBuffer = Buffer.from(mac, "hex");
  const expectedBuffer = Buffer.from(expectedMac, "hex");
  if (macBuffer.length !== expectedBuffer.length) return null;
  if (!timingSafeEqual(macBuffer, expectedBuffer)) return null;

  return workspaceId;
}

function cookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge: 60 * 60 * 24 * 30, // 30 dias
  };
}

/**
 * Workspace ativo da sessão, ou null se não houver cookie, a assinatura
 * não bater, ou — o caso que importa de verdade — a membership não existir
 * mais (removida, suspensa, ou o cookie nunca correspondeu a uma
 * membership real). Uso em Server Components e Server Actions (só leitura).
 */
export async function getActiveWorkspaceId(): Promise<string | null> {
  const cookieStore = await cookies();
  const raw = cookieStore.get(COOKIE_NAME)?.value;
  if (!raw) return null;

  const workspaceId = verifySignature(raw);
  if (!workspaceId) return null;

  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  // A RLS de memberships é por workspace (qualquer membro vê os
  // colegas), não por dono da linha — sem o filtro por user_id aqui,
  // workspace com mais de um membro devolve mais de uma linha e
  // .maybeSingle() falha, mesmo a membership do próprio usuário existindo.
  const { data } = await supabase
    .from("memberships")
    .select("workspace_id")
    .eq("workspace_id", workspaceId)
    .eq("user_id", user.id)
    .eq("status", "active")
    .maybeSingle();

  return data ? workspaceId : null;
}

export type SwitchWorkspaceResult =
  | { ok: true }
  | { ok: false; error: "not_a_member" };

/**
 * Só grava o cookie DEPOIS de confirmar, no banco (via RLS — nunca
 * confiando no id sozinho), que o usuário tem membership ativa no
 * workspace pedido. Uso exclusivo em Server Actions/Route Handlers (grava
 * cookie).
 */
export async function switchActiveWorkspace(
  workspaceId: string,
): Promise<SwitchWorkspaceResult> {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();
  console.error(
    "[DEBUG switchActiveWorkspace] workspaceId:",
    workspaceId,
    "user:",
    user?.id,
    "userError:",
    JSON.stringify(userError),
  );
  if (!user) {
    return { ok: false, error: "not_a_member" };
  }

  // Mesmo motivo do getActiveWorkspaceId: sem o filtro por user_id, um
  // workspace com mais de um membro devolve mais de uma linha e
  // .maybeSingle() falha — mesmo a membership do próprio usuário existindo.
  const { data, error: membershipError } = await supabase
    .from("memberships")
    .select("workspace_id")
    .eq("workspace_id", workspaceId)
    .eq("user_id", user.id)
    .eq("status", "active")
    .maybeSingle();

  console.error(
    "[DEBUG switchActiveWorkspace] membership data:",
    JSON.stringify(data),
    "membershipError:",
    JSON.stringify(membershipError),
  );

  if (!data) {
    return { ok: false, error: "not_a_member" };
  }

  const cookieStore = await cookies();
  cookieStore.set(COOKIE_NAME, sign(workspaceId), cookieOptions());

  return { ok: true };
}

/** Chamado no logout — o workspace ativo não sobrevive à sessão. */
export async function clearActiveWorkspaceCookie(): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.delete(COOKIE_NAME);
}
