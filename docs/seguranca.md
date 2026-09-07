# Segurança — A2

Checklist da seção 8 do prompt da A2, com onde cada item está implementado
e como verificar.

## Validação de entrada

- [x] **Zod em toda entrada de Server Action.** `src/modules/*/schema.ts` —
  `signUpSchema`, `signInSchema`, `createWorkspaceSchema`,
  `createInvitationSchema`, `updateMembershipRoleSchema`,
  `acceptInvitationSchema`. Nenhuma action lê `FormData` sem passar por
  `safeParse` primeiro.
- [x] **Slug de workspace validado nos dois lados** — regex idêntica no
  Zod (`src/modules/onboarding/schema.ts`) e no `CHECK` da migration
  (`supabase/migrations/20260907120000_a2_schema.sql`).

## Erros

- [x] **Nenhum erro interno ou SQL exibido ao usuário.**
  `src/lib/errors.ts` mapeia só os códigos simbólicos que as próprias
  funções RPC levantam (`insufficient_permission`, `invitation_expired`...)
  para mensagens em português; qualquer erro fora dessa lista cai num texto
  genérico. Nenhuma Server Action repassa `error.message` cru para o
  cliente.

## Logs

- [x] **Nenhum e-mail, token ou identificador sensível em log.** Não há
  `console.log`/`console.error` em nenhum módulo desta fase. O que seria
  logado por um APM futuro (Sentry etc.) ainda não existe nesta fase —
  quando existir, `src/lib/errors.ts` já é o ponto por onde o erro
  sanitizado passa, então é o lugar certo para instrumentar sem vazar o
  erro original.

## Auditoria

- [x] **Ações relevantes da A2 auditadas.** Toda escrita de negócio grava
  em `audit_logs` de dentro da própria função `SECURITY DEFINER` (nunca do
  código TypeScript) — `workspace.created`, `invitation.created`,
  `invitation.cancelled`, `invitation.accepted`, `membership.role_changed`,
  `membership.removed`. `metadata` guarda só campo estrutural (papel
  antigo/novo, e-mail já normalizado) — nunca senha, token ou CPF.
  `audit_logs` é append-only: só tem policy de `SELECT` (restrita a
  owner/admin) e três `with check (false)`/`using (false)` para
  INSERT/UPDATE/DELETE do cliente.

## Dados

- [x] **Nenhum dado real em seed ou teste.** `supabase/seed.sql` só cria
  `@praxis.test`, com comentário explícito no topo do arquivo.
  `tests/e2e/fixtures.ts` reusa os mesmos usuários fictícios.

## CSP

- [x] **Finalizada, com nonce por request** (estava adiada desde a A1).
  `src/proxy.ts` gera o nonce, `src/app/layout.tsx` ativa a propagação
  automática do Next para os próprios scripts. `connect-src` inclui só
  `'self'` e a URL do projeto Supabase — nada além disso.
  **Testada de verdade** (não só lida no código): build com credenciais
  placeholder, servidor local, `curl -D-` confirmando o cabeçalho, e
  inspeção do HTML servido confirmando que **todo** `<script>` carrega o
  nonce correspondente e nenhum script sem nonce aparece — ver
  `A2-HANDOFF.md`, seção de verificação.
- [x] **Demais cabeçalhos preservados** — `X-Frame-Options`,
  `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`,
  `Strict-Transport-Security` continuam em `next.config.ts`, inalterados
  desde a A1.

## Secret Key / service_role

- [x] **Nunca no navegador, nunca na Vercel Preview.** Nenhum arquivo
  desta fase lê `SUPABASE_SECRET_KEY`. `.env.example` documenta a variável
  mas com a nota explícita "nenhum código desta fase a lê". A regra de
  lint de A1 (`eslint.config.mjs`, `no-restricted-imports`) continua
  proibindo qualquer importação de `src/server/supabase/admin.ts` fora de
  `src/app/api/webhooks/**`/`src/app/api/cron/**` — e esse arquivo **nem
  chegou a ser criado** na A2, porque nada nesta fase precisa dele.
- [x] **Fluxo de convite não usa service_role.** `create_workspace_invitation`,
  `accept_workspace_invitation` etc. rodam como `SECURITY DEFINER` no
  banco, chamadas via `supabase.rpc()` com a sessão do usuário — a
  elevação de privilégio acontece dentro do Postgres, nunca via uma chave
  administrativa no código da aplicação.

## Autorização

- [x] **Nunca baseada só na interface.** Toda tela esconde ações que o
  usuário não pode fazer (`roleHasPermission`), mas cada Server Action
  chama `requirePermission()`/`requireMembership()` de novo,
  independentemente do que a UI mostrou — e cada função RPC valida o papel
  do chamador uma terceira vez dentro do banco. Três camadas, nenhuma
  delas a única.
- [x] **Sem bypass temporário de RLS.** Nenhuma tabela desta fase tem
  policy `using (true)`/`with check (true)` genérica; toda policy
  permissiva é restrita por `private.auth_workspace_ids()` ou
  `private.has_workspace_role()`. Verificado por
  `supabase/tests/database/04_security_hardening.test.sql`, que consulta
  `pg_class.relrowsecurity`/`relforcerowsecurity` diretamente em vez de
  confiar na leitura do SQL.

## Itens que dependem do CI (Docker não existe nesta máquina)

Os itens abaixo estão implementados e **têm teste escrito para eles**, mas
a validação de que o teste realmente passa só acontece quando o CI roda
(runner do GitHub, que tem Docker) — não foram executados interativamente
aqui. Ver `A2-HANDOFF.md` para o estado exato do primeiro run.

- RLS habilitada e forçada nas 5 tabelas — `04_security_hardening.test.sql`
- `search_path` vazio em toda função `SECURITY DEFINER` — idem
- Isolamento entre workspaces (A não lê nem altera dado de B) —
  `01_rls_isolation.test.sql`
- Convite expirado/cancelado/reutilizado falha; papel vem só do convite —
  `02_invitations.test.sql`
- Último owner protegido — `03_last_owner.test.sql`
- Cookie adulterado não concede acesso; troca para workspace não
  autorizado falha; logout limpa o workspace ativo — e2e, testes 6 e 7 de
  `tests/e2e/auth-workspace.spec.ts`
