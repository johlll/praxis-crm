-- B2, etapa 4a (docs/decisoes/b2-google-agenda.md §6.12): OAuth real do
-- Google.
--
-- 1) Estado da autorização (`calendar_oauth_states`): imprevisível (o banco
--    só guarda o HASH do state), expirável (10 min), de USO ÚNICO (consumir
--    apaga) e vinculado ao usuário, ao workspace, ao ambiente autenticado e
--    ao navegador que iniciou (hash de um cookie). O verificador PKCE fica
--    cifrado com a chave de tokens do ambiente.
-- 2) Conexão pela IDENTIDADE da conta (OpenID Connect `sub`) e pelo cliente
--    OAuth que emitiu o token:
--    - reautorização da MESMA conta e do MESMO cliente sem refresh token novo
--      mantém o existente (o Google só o devolve no consentimento);
--    - conexão nova, conexão a reautorizar, outro cliente ou outra chave de
--      cifra sem refresh token: recusada (`refresh_token_missing`), para
--      pedir novo consentimento;
--    - outra conta Google sobre uma conexão existente: recusada
--      (`calendar_account_mismatch`) — nunca se reaproveita token de outra
--      conta; para trocar de conta, desconectar antes;
--    - a mesma conta Google já conectada por OUTRA pessoa do workspace no
--      ambiente: recusada (`calendar_account_in_use`).
--
-- Não é aplicada ao banco hospedado sem autorização à parte.

-- ---------------------------------------------------------------------
-- 1) Estado da autorização
-- ---------------------------------------------------------------------

create table public.calendar_oauth_states (
  id uuid primary key default gen_random_uuid(),
  state_hash text not null unique check (state_hash ~ '^[0-9a-f]{64}$'),
  browser_hash text not null check (browser_hash ~ '^[0-9a-f]{64}$'),
  nonce_hash text not null check (nonce_hash ~ '^[0-9a-f]{64}$'),
  verifier_ciphertext text not null check (char_length(verifier_ciphertext) between 1 and 1000),
  key_version text not null check (char_length(key_version) between 1 and 64),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  environment public.calendar_environment not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create index calendar_oauth_states_user_idx on public.calendar_oauth_states (user_id, environment, created_at desc);
create index calendar_oauth_states_expires_idx on public.calendar_oauth_states (expires_at);

alter table public.calendar_oauth_states enable row level security;
alter table public.calendar_oauth_states force row level security;
create policy calendar_oauth_states_select_deny on public.calendar_oauth_states for select to authenticated using (false);
create policy calendar_oauth_states_insert_deny on public.calendar_oauth_states for insert to authenticated with check (false);
create policy calendar_oauth_states_update_deny on public.calendar_oauth_states for update to authenticated using (false);
create policy calendar_oauth_states_delete_deny on public.calendar_oauth_states for delete to authenticated using (false);
revoke all on table public.calendar_oauth_states from public, anon, authenticated;

-- Início: grava o estado (só hashes e o verificador cifrado). No máximo 5
-- autorizações em aberto por usuário e ambiente; as vencidas são apagadas.
create function public.begin_calendar_oauth(
  p_workspace_id uuid,
  p_actor_user_id uuid,
  p_state_hash text,
  p_browser_hash text,
  p_nonce_hash text,
  p_verifier_ciphertext text,
  p_key_version text
)
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_env public.calendar_environment := private.require_request_environment();
  v_role public.membership_role;
  v_expires timestamptz := now() + interval '10 minutes';
begin
  select role into v_role from public.memberships m
  where m.workspace_id = p_workspace_id and m.user_id = p_actor_user_id and m.status = 'active';
  -- calendar.connect_own (src/lib/roles.ts).
  if v_role is null or v_role not in ('owner', 'admin', 'manager', 'lawyer', 'sales') then
    raise exception 'insufficient_permission';
  end if;
  if p_state_hash is null or p_state_hash !~ '^[0-9a-f]{64}$'
     or p_browser_hash is null or p_browser_hash !~ '^[0-9a-f]{64}$'
     or p_nonce_hash is null or p_nonce_hash !~ '^[0-9a-f]{64}$'
     or p_verifier_ciphertext is null or btrim(p_verifier_ciphertext) = '' or p_key_version is null then
    raise exception 'invalid_oauth_state';
  end if;

  delete from public.calendar_oauth_states s where s.expires_at < now();
  delete from public.calendar_oauth_states s
  where s.id in (
    select o.id from public.calendar_oauth_states o
    where o.user_id = p_actor_user_id and o.environment = v_env
    order by o.created_at desc offset 4
  );

  insert into public.calendar_oauth_states (
    state_hash, browser_hash, nonce_hash, verifier_ciphertext, key_version, workspace_id, user_id, environment, expires_at
  ) values (
    p_state_hash, p_browser_hash, p_nonce_hash, p_verifier_ciphertext, p_key_version, p_workspace_id, p_actor_user_id, v_env, v_expires
  );
  return v_expires;
end;
$body$;

revoke all on function public.begin_calendar_oauth(uuid, uuid, text, text, text, text, text) from public;
grant execute on function public.begin_calendar_oauth(uuid, uuid, text, text, text, text, text) to service_role;
revoke execute on function public.begin_calendar_oauth(uuid, uuid, text, text, text, text, text) from anon, authenticated;

-- Retorno: CONSOME o estado (apaga, qualquer que seja o resultado: uso único)
-- e só então confere prazo, ambiente, sessão e navegador. Devolve
-- { status: ok | not_found | expired | wrong_environment | session_mismatch
-- | browser_mismatch, nonceHash?, verifierCiphertext?, keyVersion? }.
create function public.consume_calendar_oauth(
  p_state_hash text,
  p_actor_user_id uuid,
  p_workspace_id uuid,
  p_browser_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_env public.calendar_environment := private.require_request_environment();
  v_row public.calendar_oauth_states;
begin
  if p_state_hash is null or p_state_hash !~ '^[0-9a-f]{64}$' then
    return jsonb_build_object('status', 'not_found');
  end if;

  delete from public.calendar_oauth_states s where s.state_hash = p_state_hash returning * into v_row;
  if v_row.id is null then
    return jsonb_build_object('status', 'not_found');
  end if;
  if v_row.expires_at < now() then
    return jsonb_build_object('status', 'expired');
  end if;
  if v_row.environment <> v_env then
    return jsonb_build_object('status', 'wrong_environment');
  end if;
  if v_row.user_id is distinct from p_actor_user_id or v_row.workspace_id is distinct from p_workspace_id then
    return jsonb_build_object('status', 'session_mismatch');
  end if;
  if p_browser_hash is null or v_row.browser_hash <> p_browser_hash then
    return jsonb_build_object('status', 'browser_mismatch');
  end if;

  return jsonb_build_object(
    'status', 'ok', 'nonceHash', v_row.nonce_hash,
    'verifierCiphertext', v_row.verifier_ciphertext, 'keyVersion', v_row.key_version);
end;
$body$;

revoke all on function public.consume_calendar_oauth(text, uuid, uuid, text) from public;
grant execute on function public.consume_calendar_oauth(text, uuid, uuid, text) to service_role;
revoke execute on function public.consume_calendar_oauth(text, uuid, uuid, text) from anon, authenticated;

-- ---------------------------------------------------------------------
-- 2) Conexão pela identidade da conta
-- ---------------------------------------------------------------------

alter table public.calendar_connections
  add column google_subject text check (google_subject is null or char_length(google_subject) between 1 and 255),
  add column oauth_client_id text check (oauth_client_id is null or char_length(oauth_client_id) between 1 and 255);

create function public.connect_calendar_identity(
  p_workspace_id uuid,
  p_actor_user_id uuid,
  p_google_subject text,
  p_oauth_client_id text,
  p_google_account_email text,
  p_scopes text[],
  p_refresh_token_ciphertext text,
  p_access_token_ciphertext text,
  p_access_token_expires_at timestamptz,
  p_key_version text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_env public.calendar_environment := private.require_request_environment();
  v_role public.membership_role;
  v_email text := lower(btrim(p_google_account_email));
  v_existing public.calendar_connections;
  v_same_account boolean;
  v_kept boolean := false;
  v_id uuid;
begin
  if p_actor_user_id is null then
    raise exception 'actor_required';
  end if;
  if p_google_subject is null or btrim(p_google_subject) = '' or p_oauth_client_id is null or btrim(p_oauth_client_id) = '' then
    raise exception 'identity_required';
  end if;
  if p_access_token_ciphertext is null or btrim(p_access_token_ciphertext) = '' or p_key_version is null then
    raise exception 'tokens_required';
  end if;
  if p_scopes is null or cardinality(p_scopes) = 0 then
    raise exception 'scopes_required';
  end if;

  select role into v_role from public.memberships m
  where m.workspace_id = p_workspace_id and m.user_id = p_actor_user_id and m.status = 'active';
  if v_role is null or v_role not in ('owner', 'admin', 'manager', 'lawyer', 'sales') then
    raise exception 'insufficient_permission';
  end if;

  if exists (
    select 1 from public.calendar_connections c
    where c.workspace_id = p_workspace_id and c.environment = v_env and c.status <> 'disconnected'
      and c.google_subject = p_google_subject and c.user_id <> p_actor_user_id
  ) then
    raise exception 'calendar_account_in_use';
  end if;

  select * into v_existing from public.calendar_connections c
  where c.workspace_id = p_workspace_id and c.user_id = p_actor_user_id
    and c.environment = v_env and c.status <> 'disconnected'
  for update;

  if v_existing.id is not null then
    -- Outra conta Google sobre a conexão existente: nunca reaproveitada.
    if v_existing.google_subject is not null and v_existing.google_subject <> p_google_subject then
      raise exception 'calendar_account_mismatch';
    end if;
    v_same_account := v_existing.google_subject = p_google_subject
      or (v_existing.google_subject is null and v_existing.google_account_email = v_email);

    if p_refresh_token_ciphertext is null or btrim(p_refresh_token_ciphertext) = '' then
      -- Mantém o refresh token só se é DESTA conta, DESTE cliente, cifrado
      -- com a MESMA versão de chave, e a conexão não estava a reautorizar
      -- (nesse caso o token guardado já não serve).
      if v_existing.google_subject is distinct from p_google_subject
         or v_existing.oauth_client_id is distinct from p_oauth_client_id
         or v_existing.key_version is distinct from p_key_version
         or v_existing.status <> 'active'
         or v_existing.refresh_token_ciphertext is null then
        raise exception 'refresh_token_missing';
      end if;
      v_kept := true;
    end if;

    update public.calendar_connections set
      google_subject = p_google_subject,
      oauth_client_id = p_oauth_client_id,
      google_account_email = v_email,
      scopes = p_scopes,
      calendar_id = case when v_same_account then v_existing.calendar_id end,
      calendar_summary = case when v_same_account then v_existing.calendar_summary end,
      refresh_token_ciphertext = case when v_kept then v_existing.refresh_token_ciphertext else p_refresh_token_ciphertext end,
      access_token_ciphertext = p_access_token_ciphertext,
      access_token_expires_at = p_access_token_expires_at,
      key_version = p_key_version,
      status = 'active',
      updated_at = now()
    where id = v_existing.id;
    v_id := v_existing.id;
  else
    if p_refresh_token_ciphertext is null or btrim(p_refresh_token_ciphertext) = '' then
      raise exception 'refresh_token_missing';
    end if;
    insert into public.calendar_connections (
      workspace_id, user_id, environment, google_account_email, google_subject, oauth_client_id, scopes,
      refresh_token_ciphertext, access_token_ciphertext, access_token_expires_at, key_version
    ) values (
      p_workspace_id, p_actor_user_id, v_env, v_email, p_google_subject, p_oauth_client_id, p_scopes,
      p_refresh_token_ciphertext, p_access_token_ciphertext, p_access_token_expires_at, p_key_version
    ) returning id into v_id;
  end if;

  -- Nunca token, e-mail ou identificador da conta na auditoria.
  insert into public.audit_logs (workspace_id, actor_user_id, action, resource_type, resource_id, metadata)
  values (
    p_workspace_id, p_actor_user_id, 'calendar.connection.connected', 'calendar_connection', v_id,
    jsonb_build_object('environment', v_env, 'reconnected', v_existing.id is not null, 'refresh_kept', v_kept)
  );

  return jsonb_build_object('connectionId', v_id, 'refreshKept', v_kept);
end;
$body$;

revoke all on function public.connect_calendar_identity(uuid, uuid, text, text, text, text[], text, text, timestamptz, text) from public;
grant execute on function public.connect_calendar_identity(uuid, uuid, text, text, text, text[], text, text, timestamptz, text) to service_role;
revoke execute on function public.connect_calendar_identity(uuid, uuid, text, text, text, text[], text, text, timestamptz, text) from anon, authenticated;

-- A função antiga (sem identidade) continua para registros sem `sub`, mas
-- nunca sobrescreve uma conexão já identificada: isso é da função acima.
create or replace function public.connect_calendar_account(
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

  if v_existing.google_subject is not null then
    raise exception 'identity_connect_required';
  end if;

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
