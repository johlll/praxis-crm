"use server";

import { revalidatePath } from "next/cache";

import { createServerSupabaseClient } from "@/server/supabase/server";
import { requirePermission, AuthzError, type Permission } from "@/server/authz/permissions";
import { toUserMessage } from "@/lib/errors";
import { updateClientStatusSchema, transferClientOwnerSchema } from "./schema";

export type ClientActionState = {
  ok: boolean;
  error?: string;
  clientId?: string;
};

const PERMISSION_DENIED_MESSAGE = "Você não tem permissão para fazer isso.";

async function requirePermissionSafe(
  permission: Permission,
): Promise<{ ctx: Awaited<ReturnType<typeof requirePermission>> } | { deniedMessage: string }> {
  try {
    return { ctx: await requirePermission(permission) };
  } catch (error) {
    if (error instanceof AuthzError) return { deniedMessage: PERMISSION_DENIED_MESSAGE };
    throw error;
  }
}

export async function updateClientStatusAction(
  _prevState: ClientActionState,
  formData: FormData,
): Promise<ClientActionState> {
  const guard = await requirePermissionSafe("client.manage");
  if ("deniedMessage" in guard) return { ok: false, error: guard.deniedMessage };

  const parsed = updateClientStatusSchema.safeParse({
    clientId: formData.get("clientId"),
    status: formData.get("status"),
    lockVersion: formData.get("lockVersion"),
  });

  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Dados inválidos." };
  }

  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.rpc("update_client_status", {
    p_client_id: parsed.data.clientId,
    p_status: parsed.data.status,
    p_lock_version: parsed.data.lockVersion,
  });

  if (error) {
    return { ok: false, error: toUserMessage(error) };
  }

  revalidatePath(`/clientes/${parsed.data.clientId}`);
  revalidatePath("/clientes");
  return { ok: true, clientId: parsed.data.clientId };
}

export async function transferClientOwnerAction(
  _prevState: ClientActionState,
  formData: FormData,
): Promise<ClientActionState> {
  const guard = await requirePermissionSafe("client.manage");
  if ("deniedMessage" in guard) return { ok: false, error: guard.deniedMessage };

  const parsed = transferClientOwnerSchema.safeParse({
    clientId: formData.get("clientId"),
    ownerUserId: formData.get("ownerUserId") ?? "",
    lockVersion: formData.get("lockVersion"),
  });

  if (!parsed.success) {
    return { ok: false, error: "Dados inválidos." };
  }

  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.rpc("transfer_client_owner", {
    p_client_id: parsed.data.clientId,
    ...(parsed.data.ownerUserId ? { p_owner_user_id: parsed.data.ownerUserId } : {}),
    p_lock_version: parsed.data.lockVersion,
  });

  if (error) {
    return { ok: false, error: toUserMessage(error) };
  }

  revalidatePath(`/clientes/${parsed.data.clientId}`);
  revalidatePath("/clientes");
  return { ok: true, clientId: parsed.data.clientId };
}
