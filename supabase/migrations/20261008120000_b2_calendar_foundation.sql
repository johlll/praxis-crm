-- B2 — Google Agenda, fundação (docs/decisoes/b2-google-agenda.md §4, §7, §8).
--
-- Esta migration NÃO fala com o Google: cria o modelo de conexão e de
-- vínculo, e a barreira de isolamento entre ambientes. Nada aqui é
-- aplicado ao banco hospedado sem autorização à parte.
--
-- ISOLAMENTO (§7). Preview e Production compartilham o mesmo Supabase. O
-- ambiente que está operando é informado pelo servidor num cabeçalho de
-- requisição (`X-Praxis-Env`, preenchido a partir de VERCEL_ENV — nunca
-- por dado do usuário) e lido aqui via `request.headers` do PostgREST.
-- Uma atividade com vínculo ativo pertence ao ambiente do vínculo: toda
-- tentativa de UPDATE/DELETE vinda de outro ambiente — ou sem o cabeçalho
-- (falha fechada) — é RECUSADA por inteiro, antes de qualquer alteração.
-- É um gatilho de LINHA, então cobre todos os caminhos (as funções de
-- atividade que já existem, exclusão em cascata por lead/oportunidade,
-- mescla de contatos e qualquer função futura) sem mexer em migration já
-- aplicada.
--
-- Manutenção: um superusuário que precise alterar uma atividade vinculada
-- sem passar pelo servidor deve fazê-lo de forma explícita
-- (`set session_replication_role = replica`), nunca por omissão.

create type public.calendar_environment as enum ('production', 'preview');

create type public.calendar_connection_status as enum ('active', 'needs_reauth', 'disconnected');

create type public.calendar_link_status as enum (
  'linked', 'missing_in_google', 'cancelled_in_google', 'unlinked', 'needs_attention'
);

-- ---------------------------------------------------------------------
-- Ambiente da requisição
-- ---------------------------------------------------------------------

create function private.request_environment()
returns text
language plpgsql
stable
set search_path = ''
as $body$
declare
  v_raw text := current_setting('request.headers', true);
  v_env text;
begin
  if v_raw is null or btrim(v_raw) = '' then
    return null;
  end if;
  begin
    v_env := lower(btrim(coalesce((v_raw::jsonb) ->> 'x-praxis-env', '')));
  exception when others then
    return null;
  end;
  if v_env in ('production', 'preview') then
    return v_env;
  end if;
  return null;
end;
$body$;

create function private.require_request_environment()
returns public.calendar_environment
language plpgsql
stable
set search_path = ''
as $body$
declare
  v_env text := private.request_environment();
begin
  if v_env is null then
    raise exception 'environment_required';
  end if;
  return v_env::public.calendar_environment;
end;
$body$;

-- ---------------------------------------------------------------------
-- calendar_connections — a conta Google de UM usuário, num ambiente.
--
-- Tokens sempre cifrados na aplicação (AES-256-GCM, chave do ambiente, AAD
-- com ambiente e id da conexão): o banco só guarda texto base64 opaco e
-- nunca vê um token. Desconectar apaga os tokens.
-- ---------------------------------------------------------------------

create table public.calendar_connections (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  environment public.calendar_environment not null,
  google_account_email text not null check (char_length(btrim(google_account_email)) between 3 and 320),
  scopes text[] not null,
  -- Agenda escolhida pelo usuário; nula até ele escolher.
  calendar_id text check (calendar_id is null or char_length(btrim(calendar_id)) between 1 and 1024),
  calendar_summary text check (calendar_summary is null or char_length(calendar_summary) <= 200),
  refresh_token_ciphertext text,
  access_token_ciphertext text,
  access_token_expires_at timestamptz,
  key_version text,
  status public.calendar_connection_status not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  disconnected_at timestamptz,
  constraint calendar_connections_workspace_id_id_key unique (workspace_id, id),
  constraint calendar_connections_tokens_consistent check (
    (status = 'disconnected'
       and refresh_token_ciphertext is null and access_token_ciphertext is null
       and disconnected_at is not null)
    or (status <> 'disconnected'
       and refresh_token_ciphertext is not null and key_version is not null
       and disconnected_at is null)
  )
);

comment on table public.calendar_connections is
  'Conexão Google Calendar de um usuário, por ambiente (B2). Sem GRANT para authenticated: leitura por list_calendar_connections (sem tokens), escrita por funções SECURITY DEFINER com GRANT só a service_role.';

-- Uma conexão não desconectada por usuário e ambiente.
create unique index calendar_connections_one_active_per_user_env
  on public.calendar_connections (workspace_id, user_id, environment)
  where status <> 'disconnected';

create index calendar_connections_workspace_idx on public.calendar_connections (workspace_id);

alter table public.calendar_connections enable row level security;
alter table public.calendar_connections force row level security;

create policy calendar_connections_select_deny on public.calendar_connections for select to authenticated using (false);
create policy calendar_connections_insert_deny on public.calendar_connections for insert to authenticated with check (false);
create policy calendar_connections_update_deny on public.calendar_connections for update to authenticated using (false);
create policy calendar_connections_delete_deny on public.calendar_connections for delete to authenticated using (false);

revoke all on table public.calendar_connections from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- calendar_event_links — ligação entre uma atividade e um evento.
--
-- `activity_id` fica nulo (ON DELETE SET NULL) se a atividade deixar de
-- existir: o par (calendar_id, event_id) é preservado de propósito, para
-- reconhecer a exclusão e limpar o evento, mesmo quando a resposta do
-- Google não trouxer a marca (§6.2). `environment` é o dono do vínculo.
-- ---------------------------------------------------------------------

create table public.calendar_event_links (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  activity_id uuid,
  connection_id uuid not null,
  environment public.calendar_environment not null,
  calendar_id text not null check (char_length(btrim(calendar_id)) between 1 and 1024),
  event_id text not null check (char_length(btrim(event_id)) between 1 and 1024),
  -- Cresce quando um evento cancelado precisa de id novo (§6.7).
  generation integer not null default 1 check (generation >= 1),
  status public.calendar_link_status not null default 'linked',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint calendar_event_links_activity_fkey
    foreign key (workspace_id, activity_id) references public.activities (workspace_id, id) on delete set null (activity_id),
  constraint calendar_event_links_connection_fkey
    foreign key (workspace_id, connection_id) references public.calendar_connections (workspace_id, id) on delete restrict
);

comment on table public.calendar_event_links is
  'Vínculo atividade ↔ evento do Google (B2). O ambiente do vínculo decide quem pode alterar a atividade vinculada (gatilho guard_linked_activity). Sem GRANT para authenticated.';

create unique index calendar_event_links_event_key
  on public.calendar_event_links (environment, calendar_id, event_id);

-- No máximo um vínculo ativo por atividade.
create unique index calendar_event_links_one_active_per_activity
  on public.calendar_event_links (activity_id)
  where activity_id is not null and status <> 'unlinked';

create index calendar_event_links_connection_idx on public.calendar_event_links (connection_id);

alter table public.calendar_event_links enable row level security;
alter table public.calendar_event_links force row level security;

create policy calendar_event_links_select_deny on public.calendar_event_links for select to authenticated using (false);
create policy calendar_event_links_insert_deny on public.calendar_event_links for insert to authenticated with check (false);
create policy calendar_event_links_update_deny on public.calendar_event_links for update to authenticated using (false);
create policy calendar_event_links_delete_deny on public.calendar_event_links for delete to authenticated using (false);

revoke all on table public.calendar_event_links from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- Barreira: atividade vinculada só muda no ambiente dono do vínculo.
-- ---------------------------------------------------------------------

create function private.guard_linked_activity()
returns trigger
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_link_env public.calendar_environment;
  v_env text;
begin
  select l.environment into v_link_env
  from public.calendar_event_links l
  where l.activity_id = old.id and l.status <> 'unlinked'
  limit 1;

  if v_link_env is not null then
    v_env := private.request_environment();
    if v_env is null or v_env <> v_link_env::text then
      raise exception 'calendar_environment_mismatch';
    end if;
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$body$;

create trigger activities_guard_linked_environment
  before update or delete on public.activities
  for each row execute function private.guard_linked_activity();

-- ---------------------------------------------------------------------
-- Funções de escrita — GRANT só a service_role (mesmo padrão da B1:
-- nenhum usuário autenticado fabrica uma conexão ou um vínculo por RPC
-- direta). O ambiente vem SEMPRE do cabeçalho validado, nunca de
-- parâmetro.
-- ---------------------------------------------------------------------

create function public.connect_calendar_account(
  p_workspace_id uuid,
  p_actor_user_id uuid,
  p_google_account_email text,
  p_scopes text[],
  p_refresh_token_ciphertext text,
  p_access_token_ciphertext text,
  p_access_token_expires_at timestamptz,
  p_key_version text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_env public.calendar_environment := private.require_request_environment();
  v_role public.membership_role;
  v_email text := lower(btrim(p_google_account_email));
  v_existing public.calendar_connections;
  v_id uuid;
begin
  if p_actor_user_id is null then
    raise exception 'actor_required';
  end if;
  if p_refresh_token_ciphertext is null or btrim(p_refresh_token_ciphertext) = '' or p_key_version is null then
    raise exception 'tokens_required';
  end if;
  if p_scopes is null or cardinality(p_scopes) = 0 then
    raise exception 'scopes_required';
  end if;

  select role into v_role from public.memberships m
  where m.workspace_id = p_workspace_id and m.user_id = p_actor_user_id and m.status = 'active';

  -- calendar.connect_own (src/lib/roles.ts).
  if v_role is null or v_role not in ('owner', 'admin', 'manager', 'lawyer', 'sales') then
    raise exception 'insufficient_permission';
  end if;

  select * into v_existing from public.calendar_connections c
  where c.workspace_id = p_workspace_id and c.user_id = p_actor_user_id
    and c.environment = v_env and c.status <> 'disconnected';

  if v_existing.id is not null then
    update public.calendar_connections set
      google_account_email = v_email,
      scopes = p_scopes,
      -- Outra conta Google: a agenda escolhida antes não vale mais.
      calendar_id = case when v_existing.google_account_email = v_email then v_existing.calendar_id end,
      calendar_summary = case when v_existing.google_account_email = v_email then v_existing.calendar_summary end,
      refresh_token_ciphertext = p_refresh_token_ciphertext,
      access_token_ciphertext = p_access_token_ciphertext,
      access_token_expires_at = p_access_token_expires_at,
      key_version = p_key_version,
      status = 'active',
      updated_at = now()
    where id = v_existing.id;
    v_id := v_existing.id;
  else
    insert into public.calendar_connections (
      workspace_id, user_id, environment, google_account_email, scopes,
      refresh_token_ciphertext, access_token_ciphertext, access_token_expires_at, key_version
    ) values (
      p_workspace_id, p_actor_user_id, v_env, v_email, p_scopes,
      p_refresh_token_ciphertext, p_access_token_ciphertext, p_access_token_expires_at, p_key_version
    ) returning id into v_id;
  end if;

  -- Nunca token, nunca e-mail da conta no log de auditoria.
  insert into public.audit_logs (workspace_id, actor_user_id, action, resource_type, resource_id, metadata)
  values (
    p_workspace_id, p_actor_user_id, 'calendar.connection.connected', 'calendar_connection', v_id,
    jsonb_build_object('environment', v_env, 'reconnected', v_existing.id is not null)
  );

  return v_id;
end;
$body$;

revoke all on function public.connect_calendar_account(uuid, uuid, text, text[], text, text, timestamptz, text) from public;
grant execute on function public.connect_calendar_account(uuid, uuid, text, text[], text, text, timestamptz, text) to service_role;
revoke execute on function public.connect_calendar_account(uuid, uuid, text, text[], text, text, timestamptz, text) from anon, authenticated;

create function public.get_calendar_connection_secrets(p_connection_id uuid, p_actor_user_id uuid)
returns table (
  refresh_token_ciphertext text,
  access_token_ciphertext text,
  access_token_expires_at timestamptz,
  key_version text,
  status public.calendar_connection_status,
  environment public.calendar_environment
)
language plpgsql
security definer
stable
set search_path = ''
as $body$
declare
  v_env public.calendar_environment := private.require_request_environment();
  v_conn public.calendar_connections;
begin
  select * into v_conn from public.calendar_connections c where c.id = p_connection_id;
  if v_conn.id is null or v_conn.user_id is distinct from p_actor_user_id then
    raise exception 'connection_not_found';
  end if;
  if v_conn.environment <> v_env then
    raise exception 'calendar_environment_mismatch';
  end if;
  if v_conn.status = 'disconnected' then
    raise exception 'connection_not_found';
  end if;

  return query select
    v_conn.refresh_token_ciphertext, v_conn.access_token_ciphertext,
    v_conn.access_token_expires_at, v_conn.key_version, v_conn.status, v_conn.environment;
end;
$body$;

revoke all on function public.get_calendar_connection_secrets(uuid, uuid) from public;
grant execute on function public.get_calendar_connection_secrets(uuid, uuid) to service_role;
revoke execute on function public.get_calendar_connection_secrets(uuid, uuid) from anon, authenticated;

create function public.set_calendar_connection_calendar(
  p_connection_id uuid,
  p_actor_user_id uuid,
  p_calendar_id text,
  p_calendar_summary text
)
returns void
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_env public.calendar_environment := private.require_request_environment();
  v_conn public.calendar_connections;
begin
  if p_calendar_id is null or btrim(p_calendar_id) = '' then
    raise exception 'calendar_id_required';
  end if;

  select * into v_conn from public.calendar_connections c where c.id = p_connection_id;
  -- Cada usuário escolhe a agenda da PRÓPRIA conexão.
  if v_conn.id is null or v_conn.user_id is distinct from p_actor_user_id or v_conn.status = 'disconnected' then
    raise exception 'connection_not_found';
  end if;
  if v_conn.environment <> v_env then
    raise exception 'calendar_environment_mismatch';
  end if;
  if v_conn.status <> 'active' then
    raise exception 'connection_not_active';
  end if;

  update public.calendar_connections
  set calendar_id = btrim(p_calendar_id), calendar_summary = left(p_calendar_summary, 200), updated_at = now()
  where id = v_conn.id;

  insert into public.audit_logs (workspace_id, actor_user_id, action, resource_type, resource_id, metadata)
  values (
    v_conn.workspace_id, p_actor_user_id, 'calendar.connection.calendar_selected', 'calendar_connection', v_conn.id,
    jsonb_build_object('environment', v_env)
  );
end;
$body$;

revoke all on function public.set_calendar_connection_calendar(uuid, uuid, text, text) from public;
grant execute on function public.set_calendar_connection_calendar(uuid, uuid, text, text) to service_role;
revoke execute on function public.set_calendar_connection_calendar(uuid, uuid, text, text) from anon, authenticated;

-- Desconectar: apaga os tokens e desvincula os eventos. NÃO apaga evento
-- do Google nem atividade do CRM (§6.5).
create function public.disconnect_calendar_connection(p_connection_id uuid, p_actor_user_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_env public.calendar_environment := private.require_request_environment();
  v_conn public.calendar_connections;
  v_role public.membership_role;
begin
  select * into v_conn from public.calendar_connections c where c.id = p_connection_id;
  if v_conn.id is null or v_conn.status = 'disconnected' then
    raise exception 'connection_not_found';
  end if;

  select role into v_role from public.memberships m
  where m.workspace_id = v_conn.workspace_id and m.user_id = p_actor_user_id and m.status = 'active';

  -- A própria conexão (calendar.connect_own) ou, de outro usuário,
  -- calendar.manage (owner/admin).
  -- coalesce: sem membership, `v_role in (...)` é NULL e `not NULL` não
  -- dispararia o raise.
  if not coalesce(
    (v_conn.user_id = p_actor_user_id and v_role in ('owner', 'admin', 'manager', 'lawyer', 'sales'))
    or v_role in ('owner', 'admin'),
    false
  ) then
    raise exception 'connection_not_found';
  end if;

  if v_conn.environment <> v_env then
    raise exception 'calendar_environment_mismatch';
  end if;

  update public.calendar_event_links
  set status = 'unlinked', updated_at = now()
  where connection_id = v_conn.id and status <> 'unlinked';

  update public.calendar_connections
  set status = 'disconnected',
      refresh_token_ciphertext = null,
      access_token_ciphertext = null,
      access_token_expires_at = null,
      disconnected_at = now(),
      updated_at = now()
  where id = v_conn.id;

  insert into public.audit_logs (workspace_id, actor_user_id, action, resource_type, resource_id, metadata)
  values (
    v_conn.workspace_id, p_actor_user_id, 'calendar.connection.disconnected', 'calendar_connection', v_conn.id,
    jsonb_build_object('environment', v_env, 'by_other_user', v_conn.user_id <> p_actor_user_id)
  );
end;
$body$;

revoke all on function public.disconnect_calendar_connection(uuid, uuid) from public;
grant execute on function public.disconnect_calendar_connection(uuid, uuid) to service_role;
revoke execute on function public.disconnect_calendar_connection(uuid, uuid) from anon, authenticated;

-- Vínculo atividade ↔ evento. Só compromisso (reunião com horário).
create function public.create_calendar_event_link(
  p_connection_id uuid,
  p_activity_id uuid,
  p_actor_user_id uuid,
  p_event_id text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_env public.calendar_environment := private.require_request_environment();
  v_conn public.calendar_connections;
  v_activity public.activities;
  v_lead public.leads;
  v_role public.membership_role;
  v_id uuid;
begin
  if p_event_id is null or btrim(p_event_id) = '' then
    raise exception 'event_id_required';
  end if;

  select * into v_conn from public.calendar_connections c where c.id = p_connection_id;
  if v_conn.id is null or v_conn.user_id is distinct from p_actor_user_id or v_conn.status <> 'active' then
    raise exception 'connection_not_found';
  end if;
  if v_conn.environment <> v_env then
    raise exception 'calendar_environment_mismatch';
  end if;
  if v_conn.calendar_id is null then
    raise exception 'calendar_not_selected';
  end if;

  select * into v_activity from public.activities a where a.id = p_activity_id and a.workspace_id = v_conn.workspace_id;
  if v_activity.id is null then
    raise exception 'activity_not_found';
  end if;

  select role into v_role from public.memberships m
  where m.workspace_id = v_conn.workspace_id and m.user_id = p_actor_user_id and m.status = 'active';
  select * into v_lead from public.leads l where l.id = v_activity.lead_id;

  -- Mesmo alcance de activity.edit (src/lib/roles.ts) + escopo por lead.
  if v_role is null or v_role not in ('owner', 'admin', 'manager', 'lawyer', 'sales')
     or not private.lead_accessible_to_role(v_role, v_lead.assigned_to, p_actor_user_id) then
    raise exception 'activity_not_found';
  end if;

  if v_activity.type <> 'meeting' or not v_activity.has_time then
    raise exception 'activity_not_appointment';
  end if;

  -- Um vínculo ativo de OUTRO ambiente bloqueia: a atividade pertence a ele.
  if exists (
    select 1 from public.calendar_event_links l
    where l.activity_id = v_activity.id and l.status <> 'unlinked' and l.environment <> v_env
  ) then
    raise exception 'calendar_environment_mismatch';
  end if;

  insert into public.calendar_event_links (
    workspace_id, activity_id, connection_id, environment, calendar_id, event_id
  ) values (
    v_conn.workspace_id, v_activity.id, v_conn.id, v_env, v_conn.calendar_id, btrim(p_event_id)
  ) returning id into v_id;

  insert into public.audit_logs (workspace_id, actor_user_id, action, resource_type, resource_id, metadata)
  values (
    v_conn.workspace_id, p_actor_user_id, 'calendar.link.created', 'calendar_event_link', v_id,
    jsonb_build_object('environment', v_env, 'activity_id', v_activity.id)
  );

  return v_id;
end;
$body$;

revoke all on function public.create_calendar_event_link(uuid, uuid, uuid, text) from public;
grant execute on function public.create_calendar_event_link(uuid, uuid, uuid, text) to service_role;
revoke execute on function public.create_calendar_event_link(uuid, uuid, uuid, text) from anon, authenticated;

-- ---------------------------------------------------------------------
-- Leitura (authenticated): sem tokens. Cada usuário vê as próprias
-- conexões; owner/admin (calendar.manage) veem as do workspace. Só do
-- ambiente que está operando.
-- ---------------------------------------------------------------------

create function public.list_calendar_connections(p_workspace_id uuid)
returns jsonb
language plpgsql
security definer
stable
set search_path = ''
as $body$
declare
  v_actor uuid := auth.uid();
  v_env public.calendar_environment := private.require_request_environment();
  v_role public.membership_role;
begin
  if v_actor is null then
    raise exception 'authentication_required';
  end if;

  select role into v_role from public.memberships m
  where m.workspace_id = p_workspace_id and m.user_id = v_actor and m.status = 'active';

  if v_role is null then
    raise exception 'workspace_not_found';
  end if;

  return coalesce(
    (
      select jsonb_agg(
        jsonb_build_object(
          'id', c.id,
          'userId', c.user_id,
          'isMine', c.user_id = v_actor,
          'googleAccountEmail', c.google_account_email,
          'calendarId', c.calendar_id,
          'calendarSummary', c.calendar_summary,
          'status', c.status,
          'createdAt', c.created_at
        )
        order by c.created_at desc
      )
      from public.calendar_connections c
      where c.workspace_id = p_workspace_id
        and c.environment = v_env
        and c.status <> 'disconnected'
        and (c.user_id = v_actor or v_role in ('owner', 'admin'))
    ),
    '[]'::jsonb
  );
end;
$body$;

revoke all on function public.list_calendar_connections(uuid) from public;
grant execute on function public.list_calendar_connections(uuid) to authenticated;
revoke execute on function public.list_calendar_connections(uuid) from anon;
