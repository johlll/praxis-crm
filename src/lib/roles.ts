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
  | "audit_log.view"
  // A3 — contatos, identidade e deduplicação. Matriz do plano: "Editar
  // contatos" (todos menos visualizador), "Revelar CPF/CNPJ" (todos menos
  // visualizador — atendimento precisa de motivo, checado no servidor/RPC,
  // não aqui), "Mesclar/desfazer contatos" (só owner/admin/manager).
  | "contact.view"
  | "contact.edit"
  | "contact.reveal_sensitive"
  | "contact.merge"
  // A4 — leads. Matriz do plano: "Ver leads" (todos os papéis — mas
  // advogado só enxerga os seus + sem responsável, um filtro de LINHA
  // aplicado dentro das funções do banco, não expressável nesta matriz
  // booleana — mesma regra vale para editar/arquivar/atribuir, também
  // reforçada no banco); "Editar contatos" estendido por analogia a leads
  // (todos menos visualizador). Honorários NÃO faz parte do modelo de
  // dados de leads (plano seção 6.3: valor mora em `opportunities`, A5)
  // — não existe permissão de valor aqui de propósito, depois da revisão
  // que retirou esse fluxo antecipado da A4.
  | "lead.view"
  | "lead.edit"
  // A5 — pipeline e oportunidades. "Ver"/"Movimentar oportunidades" segue
  // a matriz do plano (todos os papéis veem; advogado e atendimento só
  // "suas", herdado do lead pai, reforçado no banco). Honorários exatos
  // vs. faixa vs. ausente é projeção do SERVIDOR (não uma permissão desta
  // matriz — não há como expressar "sales vê só a faixa" como um booleano
  // por papel aqui). Configurar pipeline/etapas/requisitos/motivos de
  // perda é administrativo, mesmo nível de "configurar integrações".
  | "opportunity.view"
  | "opportunity.edit"
  | "pipeline.configure";

const MATRIX: Record<Permission, ReadonlySet<Role>> = {
  "workspace.view": new Set(ROLES),
  "workspace.rename": new Set<Role>(["owner", "admin"]),
  "membership.view": new Set(ROLES),
  "membership.manage": new Set<Role>(["owner", "admin"]),
  "invitation.view": new Set<Role>(["owner", "admin"]),
  "invitation.manage": new Set<Role>(["owner", "admin"]),
  "audit_log.view": new Set<Role>(["owner", "admin"]),
  "contact.view": new Set(ROLES),
  "contact.edit": new Set<Role>(["owner", "admin", "manager", "lawyer", "sales"]),
  "contact.reveal_sensitive": new Set<Role>(["owner", "admin", "manager", "lawyer", "sales"]),
  "contact.merge": new Set<Role>(["owner", "admin", "manager"]),
  "lead.view": new Set(ROLES),
  "lead.edit": new Set<Role>(["owner", "admin", "manager", "lawyer", "sales"]),
  "opportunity.view": new Set(ROLES),
  "opportunity.edit": new Set<Role>(["owner", "admin", "manager", "lawyer", "sales"]),
  "pipeline.configure": new Set<Role>(["owner", "admin", "manager"]),
};

export function roleHasPermission(role: Role, permission: Permission): boolean {
  return MATRIX[permission].has(role);
}
