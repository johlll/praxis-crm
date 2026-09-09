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
  elisa: {
    email: "viewer.seed@praxis.test",
    fullName: "Elisa Viewer (seed)",
  },
} as const;

/**
 * Contatos fictícios do seed (mesma seção de supabase/seed.sql) — usados
 * pelos e2e da A3 que dependem de dado já pronto (CPF cifrado, duplicidade
 * pendente) em vez de recriar tudo via UI a cada teste.
 */
export const SEED_CONTACTS = {
  // CPF fictício "222.222.222-22" — mesmo CPF nos dois, candidato "strong".
  carlaFerreira: { id: "40000000-0000-0000-0000-000000000001", name: "Carla Ferreira" },
  carlaFerreiraAdvocacia: { id: "40000000-0000-0000-0000-000000000002", name: "Carla Ferreira Advocacia" },
  // Mesmo telefone — candidato "review", ainda pendente no seed.
  robertoSilva: { id: "40000000-0000-0000-0000-000000000003", name: "Roberto Silva" },
  robertoSilvaFilho: { id: "40000000-0000-0000-0000-000000000004", name: "Roberto Silva Filho" },
  // Workspace Dois — mesmo CPF fictício acima, mas blind index diferente
  // (contextualizado por workspace); usado pra provar que sales precisa
  // de motivo pra revelar.
  clienteEscritorioDois: { id: "40000000-0000-0000-0000-000000000007", name: "Cliente do Escritório Dois" },
} as const;

export const SEED_CPF_RAW = "222.222.222-22";
