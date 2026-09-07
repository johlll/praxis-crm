-- A2 — Autenticação, workspace e equipe: schema base.
--
-- Convenções válidas para todo o projeto a partir daqui (plano §6):
--   * toda tabela de negócio carrega workspace_id NOT NULL quando aplicável;
--   * todo índice composto começa por workspace_id;
--   * RLS habilitada e FORÇADA em toda tabela (migration seguinte);
--   * updated_at mantido por trigger, nunca pelo cliente.

-- Schema para funções auxiliares de RLS que NUNCA devem ser chamáveis pelo
-- cliente — não aparece em `schemas` no supabase/config.toml, logo o
-- PostgREST não expõe nada daqui. Funções de negócio que o app chama via
-- RPC (ex.: criar workspace, aceitar convite) ficam em `public` de
-- propósito — são SECURITY DEFINER também, mas são a superfície pretendida,
-- não um vazamento.
create schema if not exists private;

comment on schema private is
  'Funções auxiliares de RLS e de trigger. Nunca exposto pela Data API.';

-- Schema criado depois do Postgres 15 não herda USAGE público por padrão —
-- mas as policies de RLS (rodando como `authenticated`) precisam resolver
-- nomes como private.auth_workspace_ids() para funcionar. Only USAGE, e só
-- para quem de fato faz SELECT/INSERT/UPDATE/DELETE em tabela com RLS.
revoke all on schema private from public;
grant usage on schema private to authenticated;

-- pgcrypto fornece gen_random_bytes()/digest(), usados para gerar e
-- verificar o token de convite (migration de funções de negócio).
-- Convenção do Supabase: extensões ficam no schema `extensions`, não em
-- public — mantém public livre de objetos que não são nossos.
create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------

create type public.membership_role as enum (
  'owner',
  'admin',
  'manager',
  'lawyer',
  'sales',
  'viewer'
);

create type public.membership_status as enum (
  'active',
  'suspended'
);

create type public.invitation_status as enum (
  'pending',
  'accepted',
  'cancelled',
  'expired'
);

-- ---------------------------------------------------------------------
-- Função utilitária de updated_at (usada por trigger em toda tabela)
-- ---------------------------------------------------------------------

create function private.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $body$
begin
  new.updated_at = now();
  return new;
end;
$body$;

-- Usada por "before insert" em toda tabela cujo dono é quem a criou.
-- Sobrescreve o que vier do cliente sempre que existir uma sessão real
-- (auth.uid() não nulo) — created_by nunca é confiável vindo do
-- navegador. Fora de uma request autenticada (auth.uid() nulo: migrations,
-- seed, qualquer coisa rodando como `postgres` direto), não mexe no valor
-- — é assim que supabase/seed.sql consegue definir created_by explícito
-- para os workspaces fictícios sem violar o NOT NULL da coluna.
create function private.set_created_by_to_current_user()
returns trigger
language plpgsql
set search_path = ''
as $body$
begin
  if auth.uid() is not null then
    new.created_by = auth.uid();
  end if;
  return new;
end;
$body$;

-- ---------------------------------------------------------------------
-- workspaces
-- ---------------------------------------------------------------------

create table public.workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 1 and 120),
  slug text not null check (slug ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'),
  -- Preenchido por trigger (before insert), nunca pelo cliente — impede
  -- que alguém se declare criador de um workspace em nome de outro usuário.
  created_by uuid not null references auth.users (id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (slug)
);

comment on table public.workspaces is 'Um escritório. Raiz do isolamento multitenant.';

create trigger workspaces_set_updated_at
  before update on public.workspaces
  for each row execute function private.set_updated_at();

create trigger workspaces_set_created_by
  before insert on public.workspaces
  for each row execute function private.set_created_by_to_current_user();

-- ---------------------------------------------------------------------
-- users (espelho de auth.users; só o que a aplicação precisa exibir)
-- ---------------------------------------------------------------------

create table public.users (
  id uuid primary key references auth.users (id) on delete cascade,
  -- Denormalizado de auth.users para não precisar ler o schema auth (que a
  -- Data API não expõe) só para mostrar nome/e-mail na equipe. Mantido em
  -- sincronia pelas triggers private.handle_new_auth_user() e
  -- private.handle_auth_user_email_change() (próxima migration).
  email text not null,
  full_name text,
  avatar_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.users is
  'Espelho mínimo de auth.users, mantido por trigger. Nunca escrito diretamente pelo cliente.';

create trigger users_set_updated_at
  before update on public.users
  for each row execute function private.set_updated_at();

-- ---------------------------------------------------------------------
-- memberships
-- ---------------------------------------------------------------------

create table public.memberships (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id uuid not null references public.users (id) on delete cascade,
  role public.membership_role not null,
  status public.membership_status not null default 'active',
  invited_by uuid references public.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, user_id)
);

comment on table public.memberships is
  'Vínculo usuário↔workspace com papel. Fonte de verdade da autorização — RLS e private.auth_workspace_ids() leem só daqui.';

-- (workspace_id, user_id) já indexado pela UNIQUE acima — cobre "quem é
-- membro deste workspace". O caminho inverso ("de quais workspaces este
-- usuário é membro", usado por private.auth_workspace_ids() a cada
-- request) precisa do índice espelhado:
create index memberships_user_id_workspace_id_idx
  on public.memberships (user_id, workspace_id)
  where status = 'active';

create trigger memberships_set_updated_at
  before update on public.memberships
  for each row execute function private.set_updated_at();

-- ---------------------------------------------------------------------
-- workspace_invitations
-- ---------------------------------------------------------------------

create table public.workspace_invitations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  -- Normalizado (lower + trim) antes de gravar — feito na função de criação,
  -- nunca confiado como já normalizado vindo do cliente.
  email text not null,
  role public.membership_role not null,
  status public.invitation_status not null default 'pending',
  -- Só o hash (SHA-256) do token vai para o banco. O token em si é
  -- devolvido uma única vez, no retorno da função que cria o convite.
  token_hash text not null unique,
  invited_by uuid not null references public.users (id) on delete restrict,
  accepted_by uuid references public.users (id) on delete set null,
  expires_at timestamptz not null,
  accepted_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.workspace_invitations is
  'Convite de equipe. Token nunca fica em claro no banco — só o hash.';

create index workspace_invitations_workspace_id_idx
  on public.workspace_invitations (workspace_id, status);

create index workspace_invitations_workspace_id_email_idx
  on public.workspace_invitations (workspace_id, email)
  where status = 'pending';

create trigger workspace_invitations_set_updated_at
  before update on public.workspace_invitations
  for each row execute function private.set_updated_at();

-- ---------------------------------------------------------------------
-- audit_logs — fundação desta fase: só o que a A2 audita.
-- Append-only (garantido por policy na migration de RLS, não aqui).
-- ---------------------------------------------------------------------

create table public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  actor_user_id uuid references public.users (id) on delete set null,
  action text not null,
  resource_type text not null,
  resource_id uuid,
  -- Só metadado estrutural (papel antigo/novo, e-mail do convite já
  -- normalizado, etc.) — nunca CPF, senha, token ou qualquer segredo.
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

comment on table public.audit_logs is
  'Trilha append-only. Sem policy de UPDATE/DELETE por design — ver migration de RLS.';

create index audit_logs_workspace_id_created_at_idx
  on public.audit_logs (workspace_id, created_at desc);
