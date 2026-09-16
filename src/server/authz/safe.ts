import { AuthzError, requirePermission, type MembershipContext, type Permission } from "./permissions";
import { DataLoadError, LOAD_ERROR_MESSAGE } from "@/server/data/load-error";

export const PERMISSION_DENIED_MESSAGE = "Você não tem permissão para fazer isso.";

/**
 * Checagem de permissão para Server Actions (única cópia — antes havia uma
 * por módulo). requirePermission() lança; dentro de uma action isso viraria
 * exceção sem tratamento. Aqui vira erro sanitizado para o cliente, tanto
 * para permissão negada quanto para falha ao carregar a membership.
 */
export async function requirePermissionSafe(
  permission: Permission,
): Promise<{ ctx: MembershipContext } | { error: string }> {
  try {
    return { ctx: await requirePermission(permission) };
  } catch (error) {
    if (error instanceof AuthzError) return { error: PERMISSION_DENIED_MESSAGE };
    if (error instanceof DataLoadError) return { error: LOAD_ERROR_MESSAGE };
    throw error;
  }
}
