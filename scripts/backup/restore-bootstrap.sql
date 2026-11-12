-- B6c — base mínima "tipo Supabase" para restaurar um backup num Postgres LOCAL descartável.
-- Cria só o que o pacote assume que já existe: papéis, schemas auth/extensions, extensões e as
-- funções auth.uid()/role()/jwt() usadas por políticas. As TABELAS (auth.users, public.*, ...) vêm do
-- próprio pacote. Roda no banco novo criado pela restauração; os papéis são do SERVIDOR (por isso o
-- script só aceita destino local ou explicitamente descartável).
-- Banco recém-criado e vazio: o schema public padrão sai, porque o pacote traz o seu (CREATE SCHEMA public).
drop schema if exists public cascade;

do $$
declare r text;
begin
  foreach r in array array[
    'postgres', 'anon', 'authenticated', 'service_role', 'authenticator', 'supabase_admin',
    'supabase_auth_admin', 'supabase_storage_admin', 'supabase_read_only_user', 'dashboard_user', 'pgbouncer'
  ] loop
    if not exists (select 1 from pg_roles where rolname = r) then
      execute format('create role %I nologin', r);
    end if;
  end loop;
end
$$;

create schema if not exists extensions;
create schema if not exists auth;
create extension if not exists pgcrypto with schema extensions;
create extension if not exists pg_trgm with schema extensions;
grant usage on schema extensions to anon, authenticated, service_role;
grant usage on schema auth to anon, authenticated, service_role;

create or replace function auth.uid() returns uuid language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''),
                  (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid
$$;
create or replace function auth.role() returns text language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim.role', true), ''),
                  (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'))::text
$$;
create or replace function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim', true), ''), nullif(current_setting('request.jwt.claims', true), ''))::jsonb
$$;
grant execute on function auth.uid(), auth.role(), auth.jwt() to anon, authenticated, service_role;
