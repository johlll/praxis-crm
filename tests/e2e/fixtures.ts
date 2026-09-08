/**
 * Usuários fictícios do seed (supabase/seed.sql) — mesmos UUIDs e senha
 * usados pelos testes pgTAP. Nenhum dado real; só existe no Postgres local
 * efêmero que o CI sobe e descarta a cada run.
 */
export const SEED_PASSWORD = "praxis-seed-nao-e-senha-real";

export const SEED_USERS = {
  ana: {
    email: "owner-a.seed@praxis.test",
    fullName: "Ana Owner (seed)",
    workspaceName: "Escritório Um (seed)",
  },
  bruno: {
    email: "owner-b.seed@praxis.test",
    fullName: "Bruno Owner (seed)",
    workspaceName: "Escritório Dois (seed)",
  },
  carla: {
    email: "compartilhado.seed@praxis.test",
    fullName: "Carla Compartilhada (seed)",
  },
  daniel: {
    email: "sem-membership.seed@praxis.test",
    fullName: "Daniel Sem Workspace (seed)",
  },
} as const;
