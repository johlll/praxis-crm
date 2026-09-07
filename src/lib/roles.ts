import type { Database } from "@/server/types/database";

/**
 * Papéis e a matriz de permissões — puramente dados, sem nenhuma
 * dependência de `next/headers`/Supabase. Fica FORA de `src/server/` de
 * propósito, para poder ser importado por Client Components (ex.: mostrar
 * o rótulo do papel, ou decidir se um botão aparece) sem arrastar o
 * restante da árvore de autorização (que aí sim é só de servidor) para o
 * bundle do navegador — foi exatamente isso que quebrou o build na
 * primeira tentativa, com `member-row.tsx` puxando `next/headers`
 * transitivamente.
 */

export type Role = Database["public"]["Enums"]["membership_role"];

export const ROLES = [
  "owner",
  "admin",
  "manager",
  "lawyer",
  "sales",
  "viewer",
] as const satisfies readonly Role[];

export const ROLE_LABEL: Record<Role, string> = {
  owner: "Proprietário",
  admin: "Administrador",
  manager: "Gestor",
  lawyer: "Advogado",
  sales: "Atendimento/comercial",
  viewer: "Visualizador",
};

/**
 * Só os recursos que existem na A2. Fases futuras (leads, pipeline,
 * atividades...) estendem esta lista quando os recursos existirem de
 * verdade — não antes.
 */
export type Permission =
  | "workspace.view"
  | "workspace.rename"
  | "membership.view"
  | "membership.manage"
  | "invitation.view"
  | "invitation.manage"
  | "audit_log.view";

const MATRIX: Record<Permission, ReadonlySet<Role>> = {
  "workspace.view": new Set(ROLES),
  "workspace.rename": new Set<Role>(["owner", "admin"]),
  "membership.view": new Set(ROLES),
  "membership.manage": new Set<Role>(["owner", "admin"]),
  "invitation.view": new Set<Role>(["owner", "admin"]),
  "invitation.manage": new Set<Role>(["owner", "admin"]),
  "audit_log.view": new Set<Role>(["owner", "admin"]),
};

export function roleHasPermission(role: Role, permission: Permission): boolean {
  return MATRIX[permission].has(role);
}
