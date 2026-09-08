-- Corrige um segundo gap de privilégio, descoberto ao auditar o resultado
-- da migration anterior (20260908020000_a2_table_grants.sql): a plataforma
-- Supabase mantém, para o papel `postgres` (o que executa as migrations
-- via `supabase db push`), um `ALTER DEFAULT PRIVILEGES ... IN SCHEMA
-- public` que concede automaticamente REFERENCES, TRIGGER, TRUNCATE e
-- MAINTAIN a `anon` e `authenticated` em TODA tabela nova — sem relação
-- nenhuma com o toggle "Automatically expose new tables" (que só afeta
-- SELECT/INSERT/UPDATE/DELETE). Confirmado consultando pg_default_acl.
--
-- TRUNCATE é o mais grave dos quatro: TRUNCATE TABLE ignora RLS por
-- completo (não é uma operação linha-a-linha), então esse grant sozinho
-- significa que `authenticated` — e até `anon` — teria, em tese, permissão
-- de esvaziar public.workspaces/users/memberships/workspace_invitations/
-- audit_logs inteiras, de todos os workspaces, com um único comando.
-- REFERENCES e TRIGGER permitiriam criar constraints/triggers apontando
-- para estas tabelas; MAINTAIN cobre VACUUM/ANALYZE/REINDEX/CLUSTER.
-- Nenhum fluxo desta fase usa qualquer um dos quatro.
--
-- A Data API do PostgREST não expõe TRUNCATE/REFERENCES/TRIGGER/MAINTAIN
-- via REST — não há uma rota HTTP que os exercite hoje —, mas a política
-- deste projeto é privilégio mínimo por definição da migration, nunca
-- "seguro na prática atual porque a superfície de hoje não alcança".
--
-- Duas partes:
--   1. Revoga os quatro privilégios nas tabelas já criadas pela A2.
--   2. Altera o DEFAULT PRIVILEGES do papel `postgres` em `public`, para
--      que toda tabela de fase futura (A3 em diante) já nasça sem eles —
--      sem depender de lembrar de repetir este revoke a cada nova tabela.
-- SELECT/INSERT/UPDATE/DELETE continuam exigindo GRANT explícito por
-- tabela, como já era antes desta migration — isso não muda.

revoke references, trigger, truncate, maintain
  on public.workspaces, public.users, public.memberships,
     public.workspace_invitations, public.audit_logs
  from anon, authenticated;

alter default privileges for role postgres in schema public
  revoke references, trigger, truncate, maintain on tables from anon, authenticated;
