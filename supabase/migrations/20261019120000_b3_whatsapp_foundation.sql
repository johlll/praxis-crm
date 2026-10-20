-- B3.1 — WhatsApp real, fundação do provedor (docs/decisoes/b3-whatsapp-real.md
-- §4.3, §6 B3.1, §7, §7.1).
--
-- Esta migration NÃO fala com YCloud nem com a Meta, não recebe webhook e
-- não envia mensagem. Ela prepara:
--   1. o ambiente AUTENTICADO próprio do WhatsApp (cabeçalho assinado);
--   2. a evolução de `whatsapp_channels` (A7) para canal por workspace E
--      ambiente, com provedor, chave de roteamento, estado e envio
--      desligado;
--   3. as credenciais do canal, sempre cifradas pela aplicação;
--   4. as funções de administração, executáveis só por service_role.
--
-- ISOLAMENTO CRIPTOGRÁFICO (§7.1). Reaproveita só o PADRÃO da B2: nenhuma
-- chave, tabela de chaves, cabeçalho, função ou finalidade da B2 é usada
-- aqui. `calendar_environment_keys`, `X-Praxis-Env` e
-- `private.request_environment()` não são lidos por nada desta migration.
-- O cabeçalho do WhatsApp tem nome próprio (`X-Praxis-WhatsApp-Env`),
-- versão de formato (`v1`) e finalidade embutida na mensagem assinada
-- (`praxis:whatsapp:env:v1|<ambiente>|<expira>`): uma assinatura de outro
-- módulo não confere aqui nem com a mesma chave. Compartilhar o Supabase
-- não significa compartilhar segredos entre módulos.
--
-- COMPATIBILIDADE COM A A7. `whatsapp_channels` continua sendo a ÚNICA
-- fonte de verdade do canal. Estado anterior: toda linha era um canal do
-- simulador da A7, sem ambiente, roteada por `phone_number_id`. Estado
-- posterior:
--   - linha LEGADA (A7): `environment` nulo, `provider = 'simulated'`,
--     `is_simulator = true`, `phone_number_id` preenchido,
--     `routing_key = phone_number_id`. Continua visível por SELECT direto e
--     continua funcionando no simulador e na Central de Conversas,
--     exatamente como antes. Nenhuma linha existente vira canal real.
--   - linha da B3: `environment` obrigatório, `phone_number_id` NULO (as
--     funções da A7 resolvem o canal por `phone_number_id` e por isso nunca
--     alcançam um canal da B3), roteada por `routing_key`. Invisível por
--     SELECT direto; lida e administrada só pelas funções abaixo, que
--     exigem o ambiente autenticado igual ao do canal.
-- Nenhuma função da A7 é alterada.
--
-- As chaves do ambiente são provisionadas à mão no banco, uma linha por
-- ambiente, como na B2 — e NADA disso é feito por esta migration. Sem
-- chave, nenhuma operação desta fase funciona (falha fechada).

create type public.whatsapp_environment as enum ('production', 'preview');

-- Provedor do canal. 'ycloud' e 'meta' existem no vocabulário para que o
-- modelo não mude quando o adaptador real chegar; nenhuma função desta
-- fase cria um canal real.
create type public.whatsapp_provider as enum ('simulated', 'ycloud', 'meta');

create type public.whatsapp_credential_purpose as enum ('api_key', 'webhook_secret');

-- ---------------------------------------------------------------------
-- Ambiente da requisição — próprio do WhatsApp
-- ---------------------------------------------------------------------

create table public.whatsapp_environment_keys (
  environment public.whatsapp_environment primary key,
  signing_key text not null check (char_length(signing_key) >= 32),
  updated_at timestamptz not null default now()
);

alter table public.whatsapp_environment_keys enable row level security;
alter table public.whatsapp_environment_keys force row level security;
revoke all on table public.whatsapp_environment_keys from public, anon, authenticated;

create policy whatsapp_environment_keys_select_deny on public.whatsapp_environment_keys for select to authenticated using (false);
create policy whatsapp_environment_keys_insert_deny on public.whatsapp_environment_keys for insert to authenticated with check (false);
create policy whatsapp_environment_keys_update_deny on public.whatsapp_environment_keys for update to authenticated using (false);
create policy whatsapp_environment_keys_delete_deny on public.whatsapp_environment_keys for delete to authenticated using (false);

comment on table public.whatsapp_environment_keys is
  'Chaves que assinam o cabeçalho X-Praxis-WhatsApp-Env (B3). Próprias do WhatsApp: nunca as da B2. Sem GRANT, sem policy permissiva e sem função que as defina: provisionadas à mão, uma linha por ambiente.';

-- Mensagem assinada: finalidade + versão + ambiente + expiração. A mesma
-- conta é feita em src/server/whatsapp/environment.ts (vetor compartilhado
-- nos testes).
create function private.whatsapp_environment_signature(p_environment text, p_expires bigint, p_key text)
returns text
language sql
immutable
set search_path = ''
as $body$
  select encode(
    extensions.hmac('praxis:whatsapp:env:v1|' || p_environment || '|' || p_expires::text, p_key, 'sha256'),
    'hex'
  );
$body$;

-- Ambiente AUTENTICADO da requisição para o WhatsApp, ou NULL. Formato do
-- cabeçalho: `v1.<ambiente>.<expira>.<hmac-hex>`. Nunca devolve um
-- ambiente só porque o cabeçalho o declara.
create function private.whatsapp_request_environment()
returns text
language plpgsql
stable
security definer
set search_path = ''
as $body$
declare
  v_raw text := current_setting('request.headers', true);
  v_value text;
  v_version text;
  v_env text;
  v_expires_txt text;
  v_signature text;
  v_expires bigint;
  v_now bigint := extract(epoch from now())::bigint;
  v_key text;
  v_expected text;
begin
  if v_raw is null or btrim(v_raw) = '' then
    return null;
  end if;
  begin
    v_value := (v_raw::jsonb) ->> 'x-praxis-whatsapp-env';
  exception when others then
    return null;
  end;
  if v_value is null then
    return null;
  end if;

  -- Exatamente quatro partes: um ponto a mais ou a menos é outro formato.
  if array_length(string_to_array(v_value, '.'), 1) <> 4 then
    return null;
  end if;

  v_version := split_part(v_value, '.', 1);
  v_env := split_part(v_value, '.', 2);
  v_expires_txt := split_part(v_value, '.', 3);
  v_signature := split_part(v_value, '.', 4);

  if v_version <> 'v1'
     or v_env not in ('production', 'preview')
     or v_expires_txt !~ '^[0-9]{1,12}$'
     or v_signature !~ '^[0-9a-f]{64}$' then
    return null;
  end if;

  v_expires := v_expires_txt::bigint;
  -- Vencido, ou com validade excessiva (o servidor emite 5 minutos; um
  -- cabeçalho vazado não pode valer por muito tempo).
  if v_expires < v_now or v_expires > v_now + 900 then
    return null;
  end if;

  select k.signing_key into v_key
  from public.whatsapp_environment_keys k
  where k.environment = v_env::public.whatsapp_environment;
  if v_key is null then
    return null;
  end if;

  v_expected := private.whatsapp_environment_signature(v_env, v_expires, v_key);
  -- Comparação por HMAC das duas assinaturas: não depende do primeiro byte
  -- que difere.
  if extensions.hmac(v_signature, v_key, 'sha256') <> extensions.hmac(v_expected, v_key, 'sha256') then
    return null;
  end if;

  return v_env;
end;
$body$;

revoke all on function private.whatsapp_request_environment() from public, anon, authenticated;
revoke all on function private.whatsapp_environment_signature(text, bigint, text) from public, anon, authenticated;

create function private.require_whatsapp_environment()
returns public.whatsapp_environment
language plpgsql
stable
set search_path = ''
as $body$
declare
  v_env text := private.whatsapp_request_environment();
begin
  if v_env is null then
    raise exception 'whatsapp_environment_required';
  end if;
  return v_env::public.whatsapp_environment;
end;
$body$;

revoke all on function private.require_whatsapp_environment() from public, anon, authenticated;

-- Quem administra canais (`channel.manage` em src/lib/roles.ts): owner e
-- admin com membership ativa NO workspace informado pelo servidor.
create function private.whatsapp_actor_can_manage(p_workspace_id uuid, p_actor_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $body$
  select exists (
    select 1 from public.memberships m
    where m.workspace_id = p_workspace_id
      and m.user_id = p_actor_user_id
      and m.status = 'active'
      and m.role in ('owner', 'admin')
  );
$body$;

revoke all on function private.whatsapp_actor_can_manage(uuid, uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- whatsapp_channels — evolução da tabela da A7 (uma fonte de verdade)
-- ---------------------------------------------------------------------

alter table public.whatsapp_channels
  add column provider public.whatsapp_provider not null default 'simulated',
  add column environment public.whatsapp_environment,
  add column routing_key text,
  add column send_enabled boolean not null default false,
  add column status_changed_at timestamptz;

-- Linhas existentes: todas do simulador da A7. Ganham só a chave de
-- roteamento igual ao identificador que já usavam; nada mais muda.
update public.whatsapp_channels set routing_key = phone_number_id where routing_key is null;

alter table public.whatsapp_channels alter column routing_key set not null;
alter table public.whatsapp_channels alter column phone_number_id drop not null;

alter table public.whatsapp_channels
  add constraint whatsapp_channels_routing_key_check
    check (char_length(btrim(routing_key)) between 1 and 128),
  -- O modo (simulado ou real) é o próprio provedor; `is_simulator` (A7)
  -- continua existindo e nunca diverge dele.
  add constraint whatsapp_channels_mode_matches_provider
    check (is_simulator = (provider = 'simulated')),
  -- Cada linha é OU legada da A7 (sem ambiente, com phone_number_id) OU da
  -- B3 (com ambiente, sem phone_number_id). Nunca as duas coisas.
  add constraint whatsapp_channels_legacy_or_environment
    check ((environment is null) = (phone_number_id is not null)),
  -- Canal real só existe com ambiente; a linha legada é sempre simulador.
  add constraint whatsapp_channels_real_requires_environment
    check (environment is not null or provider = 'simulated'),
  -- Canal simulado nunca habilita envio real.
  add constraint whatsapp_channels_simulator_never_sends
    check (not (is_simulator and send_enabled));

alter table public.whatsapp_channels drop constraint whatsapp_channels_status_check;
alter table public.whatsapp_channels
  add constraint whatsapp_channels_status_check
    check (status in ('active', 'paused', 'disconnected', 'disabled'));

-- Unicidade GLOBAL por provedor e chave de roteamento — mais forte que
-- "por ambiente": o mesmo número nunca fica em Preview e Production ao
-- mesmo tempo (docs/decisoes/b3-whatsapp-real.md §8).
create unique index whatsapp_channels_provider_routing_key_key
  on public.whatsapp_channels (provider, routing_key);

-- Alvo das FKs das credenciais: garante que a credencial é do mesmo
-- workspace, ambiente e provedor do canal.
alter table public.whatsapp_channels
  add constraint whatsapp_channels_identity_key unique (workspace_id, id, environment, provider);

create index whatsapp_channels_workspace_environment_idx
  on public.whatsapp_channels (workspace_id, environment) where environment is not null;

-- A linha legada da A7 nasce por `create_whatsapp_channel()`, que não
-- conhece `routing_key`: herda o phone_number_id. Identidade do canal
-- (workspace, ambiente, provedor, roteamento) é imutável depois de criada.
create function private.whatsapp_channels_guard()
returns trigger
language plpgsql
set search_path = ''
as $body$
begin
  if tg_op = 'INSERT' then
    if new.routing_key is null then
      new.routing_key := new.phone_number_id;
    end if;
    return new;
  end if;

  if new.workspace_id is distinct from old.workspace_id
     or new.environment is distinct from old.environment
     or new.provider is distinct from old.provider
     or new.routing_key is distinct from old.routing_key
     or new.is_simulator is distinct from old.is_simulator then
    raise exception 'channel_identity_immutable';
  end if;
  return new;
end;
$body$;

revoke all on function private.whatsapp_channels_guard() from public, anon, authenticated;

create trigger whatsapp_channels_guard
  before insert or update on public.whatsapp_channels
  for each row execute function private.whatsapp_channels_guard();

-- SELECT direto: só as linhas legadas da A7 (simulador e Central de
-- Conversas continuam iguais). Um canal da B3 tem ambiente: só as funções
-- abaixo, com o ambiente autenticado, o alcançam.
drop policy whatsapp_channels_select on public.whatsapp_channels;
create policy whatsapp_channels_select on public.whatsapp_channels
  for select
  to authenticated
  using (environment is null and workspace_id in (select private.auth_workspace_ids()));

comment on table public.whatsapp_channels is
  'Canal de WhatsApp. Linha legada (A7): simulador sem ambiente, roteada por phone_number_id. Linha da B3: canal por workspace E ambiente, roteada por routing_key, administrada só por funções de service_role com ambiente autenticado.';

-- ---------------------------------------------------------------------
-- whatsapp_channel_credentials — sempre cifradas pela aplicação
-- ---------------------------------------------------------------------

create table public.whatsapp_channel_credentials (
  channel_id uuid not null,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  environment public.whatsapp_environment not null,
  provider public.whatsapp_provider not null,
  purpose public.whatsapp_credential_purpose not null,
  -- AES-256-GCM (iv || authTag || ciphertext, base64), AAD com finalidade,
  -- versão, ambiente, workspace, canal, provedor e propósito. O banco só
  -- guarda texto opaco.
  ciphertext text not null check (char_length(ciphertext) between 40 and 8192 and ciphertext ~ '^[A-Za-z0-9+/]+={0,2}$'),
  key_version text not null check (key_version ~ '^[A-Za-z0-9_-]{1,32}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (channel_id, purpose),
  constraint whatsapp_channel_credentials_channel_identity_fkey
    foreign key (workspace_id, channel_id, environment, provider)
    references public.whatsapp_channels (workspace_id, id, environment, provider) on delete cascade
);

create index whatsapp_channel_credentials_workspace_idx on public.whatsapp_channel_credentials (workspace_id);

create trigger whatsapp_channel_credentials_set_updated_at
  before update on public.whatsapp_channel_credentials
  for each row execute function private.set_updated_at();

alter table public.whatsapp_channel_credentials enable row level security;
alter table public.whatsapp_channel_credentials force row level security;
revoke all on table public.whatsapp_channel_credentials from public, anon, authenticated;

create policy whatsapp_channel_credentials_select_deny on public.whatsapp_channel_credentials for select to authenticated using (false);
create policy whatsapp_channel_credentials_insert_deny on public.whatsapp_channel_credentials for insert to authenticated with check (false);
create policy whatsapp_channel_credentials_update_deny on public.whatsapp_channel_credentials for update to authenticated using (false);
create policy whatsapp_channel_credentials_delete_deny on public.whatsapp_channel_credentials for delete to authenticated using (false);

comment on table public.whatsapp_channel_credentials is
  'Credenciais do canal de WhatsApp (B3), cifradas pela aplicação com chave e AAD próprias do WhatsApp. Sem GRANT para anon/authenticated; lidas e gravadas só por funções de service_role com ambiente autenticado. Nunca retornadas em listagem.';

-- ---------------------------------------------------------------------
-- Funções de administração — service_role apenas
--
-- Chamadas pelo servidor DEPOIS de a sessão ter sido verificada
-- (`requirePermissionSafe('channel.manage')`): workspace e ator vêm dessa
-- verificação, nunca do formulário. Cada função revalida papel, workspace
-- e ambiente por dentro. Canal de outro workspace ou de outro ambiente
-- responde como não encontrado. Auditoria nunca leva segredo.
-- ---------------------------------------------------------------------

-- Projeção SEGURA do canal: nunca ciphertext, nunca versão de chave.
create function private.whatsapp_channel_safe_row(p_channel public.whatsapp_channels)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $body$
  select jsonb_build_object(
    'id', p_channel.id,
    'label', p_channel.label,
    'provider', p_channel.provider,
    'environment', p_channel.environment,
    'routing_key', p_channel.routing_key,
    'display_phone_number', p_channel.display_phone_number,
    'is_simulator', p_channel.is_simulator,
    'status', p_channel.status,
    'send_enabled', p_channel.send_enabled,
    'status_changed_at', p_channel.status_changed_at,
    'created_at', p_channel.created_at,
    'updated_at', p_channel.updated_at,
    'credential_purposes', coalesce((
      select jsonb_agg(c.purpose order by c.purpose)
      from public.whatsapp_channel_credentials c
      where c.channel_id = p_channel.id
    ), '[]'::jsonb)
  );
$body$;

revoke all on function private.whatsapp_channel_safe_row(public.whatsapp_channels) from public, anon, authenticated;

-- Carrega o canal que o ator pode administrar NESTE ambiente, ou recusa.
-- `for update` serializa duas mudanças de estado concorrentes do mesmo canal.
create function private.whatsapp_lock_managed_channel(
  p_channel_id uuid,
  p_workspace_id uuid,
  p_actor_user_id uuid,
  p_env public.whatsapp_environment
)
returns public.whatsapp_channels
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_channel public.whatsapp_channels;
begin
  if p_actor_user_id is null or p_workspace_id is null then
    raise exception 'actor_required';
  end if;
  if not private.whatsapp_actor_can_manage(p_workspace_id, p_actor_user_id) then
    raise exception 'insufficient_permission';
  end if;

  select * into v_channel from public.whatsapp_channels c
  where c.id = p_channel_id
    and c.workspace_id = p_workspace_id
    and c.environment = p_env
  for update;

  if v_channel.id is null then
    raise exception 'channel_not_found';
  end if;
  return v_channel;
end;
$body$;

revoke all on function private.whatsapp_lock_managed_channel(uuid, uuid, uuid, public.whatsapp_environment) from public, anon, authenticated;

create function public.whatsapp_list_channels(p_workspace_id uuid, p_actor_user_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $body$
declare
  v_env public.whatsapp_environment := private.require_whatsapp_environment();
begin
  if p_actor_user_id is null or p_workspace_id is null then
    raise exception 'actor_required';
  end if;
  if not private.whatsapp_actor_can_manage(p_workspace_id, p_actor_user_id) then
    raise exception 'insufficient_permission';
  end if;

  return coalesce((
    select jsonb_agg(private.whatsapp_channel_safe_row(c) order by c.created_at, c.id)
    from public.whatsapp_channels c
    where c.workspace_id = p_workspace_id and c.environment = v_env
  ), '[]'::jsonb);
end;
$body$;

create function public.whatsapp_get_channel_state(p_channel_id uuid, p_workspace_id uuid, p_actor_user_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $body$
declare
  v_env public.whatsapp_environment := private.require_whatsapp_environment();
  v_channel public.whatsapp_channels;
begin
  if p_actor_user_id is null or p_workspace_id is null then
    raise exception 'actor_required';
  end if;
  if not private.whatsapp_actor_can_manage(p_workspace_id, p_actor_user_id) then
    raise exception 'insufficient_permission';
  end if;

  select * into v_channel from public.whatsapp_channels c
  where c.id = p_channel_id and c.workspace_id = p_workspace_id and c.environment = v_env;
  if v_channel.id is null then
    raise exception 'channel_not_found';
  end if;

  return private.whatsapp_channel_safe_row(v_channel);
end;
$body$;

-- Canal SIMULADO da B3, com o segredo simulado de webhook já cifrado, numa
-- transação só. O id vem da aplicação porque entra na AAD da cifra, que é
-- feita antes do INSERT. Envio sempre desligado.
create function public.whatsapp_create_simulated_channel(
  p_channel_id uuid,
  p_workspace_id uuid,
  p_actor_user_id uuid,
  p_label text,
  p_routing_key text,
  p_display_phone_number text,
  p_webhook_secret_ciphertext text,
  p_key_version text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_env public.whatsapp_environment := private.require_whatsapp_environment();
  v_channel public.whatsapp_channels;
begin
  if p_actor_user_id is null or p_workspace_id is null or p_channel_id is null then
    raise exception 'actor_required';
  end if;
  if not private.whatsapp_actor_can_manage(p_workspace_id, p_actor_user_id) then
    raise exception 'insufficient_permission';
  end if;
  if p_label is null or char_length(btrim(p_label)) not between 1 and 120 then
    raise exception 'invalid_channel_label';
  end if;
  if p_routing_key is null or char_length(btrim(p_routing_key)) not between 1 and 128 then
    raise exception 'invalid_routing_key';
  end if;
  if p_display_phone_number is null or char_length(btrim(p_display_phone_number)) not between 1 and 32 then
    raise exception 'invalid_display_phone_number';
  end if;
  if p_webhook_secret_ciphertext is null or p_key_version is null then
    raise exception 'invalid_credential';
  end if;

  if exists (
    select 1 from public.whatsapp_channels c
    where c.provider = 'simulated' and c.routing_key = btrim(p_routing_key)
  ) then
    raise exception 'channel_routing_key_taken';
  end if;

  begin
    insert into public.whatsapp_channels (
      id, workspace_id, label, phone_number_id, display_phone_number, is_simulator,
      status, created_by, provider, environment, routing_key, send_enabled, status_changed_at
    ) values (
      p_channel_id, p_workspace_id, btrim(p_label), null, btrim(p_display_phone_number), true,
      'active', p_actor_user_id, 'simulated', v_env, btrim(p_routing_key), false, now()
    )
    returning * into v_channel;
  exception
    when unique_violation then
      raise exception 'channel_routing_key_taken';
    when check_violation then
      raise exception 'invalid_channel_data';
  end;

  begin
    insert into public.whatsapp_channel_credentials (
      channel_id, workspace_id, environment, provider, purpose, ciphertext, key_version
    ) values (
      v_channel.id, p_workspace_id, v_env, 'simulated', 'webhook_secret',
      p_webhook_secret_ciphertext, p_key_version
    );
  exception when check_violation then
    raise exception 'invalid_credential';
  end;

  insert into public.audit_logs (workspace_id, actor_user_id, action, resource_type, resource_id, metadata)
  values (
    p_workspace_id, p_actor_user_id, 'whatsapp.channel.created', 'whatsapp_channel', v_channel.id,
    jsonb_build_object('environment', v_env, 'provider', 'simulated')
  );

  return private.whatsapp_channel_safe_row(v_channel);
end;
$body$;

-- Só o que pode mudar sem trocar a identidade do canal.
create function public.whatsapp_update_channel_settings(
  p_channel_id uuid,
  p_workspace_id uuid,
  p_actor_user_id uuid,
  p_label text,
  p_display_phone_number text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_env public.whatsapp_environment := private.require_whatsapp_environment();
  v_channel public.whatsapp_channels := private.whatsapp_lock_managed_channel(p_channel_id, p_workspace_id, p_actor_user_id, v_env);
begin
  if p_label is null or char_length(btrim(p_label)) not between 1 and 120 then
    raise exception 'invalid_channel_label';
  end if;
  if p_display_phone_number is null or char_length(btrim(p_display_phone_number)) not between 1 and 32 then
    raise exception 'invalid_display_phone_number';
  end if;

  update public.whatsapp_channels
  set label = btrim(p_label), display_phone_number = btrim(p_display_phone_number)
  where id = v_channel.id
  returning * into v_channel;

  insert into public.audit_logs (workspace_id, actor_user_id, action, resource_type, resource_id, metadata)
  values (
    p_workspace_id, p_actor_user_id, 'whatsapp.channel.updated', 'whatsapp_channel', v_channel.id,
    jsonb_build_object('environment', v_env, 'provider', v_channel.provider)
  );

  return private.whatsapp_channel_safe_row(v_channel);
end;
$body$;

-- Pausar: só a partir de 'active'. Pausar também desliga o envio.
create function public.whatsapp_pause_channel(p_channel_id uuid, p_workspace_id uuid, p_actor_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_env public.whatsapp_environment := private.require_whatsapp_environment();
  v_channel public.whatsapp_channels := private.whatsapp_lock_managed_channel(p_channel_id, p_workspace_id, p_actor_user_id, v_env);
begin
  if v_channel.status <> 'active' then
    raise exception 'invalid_channel_state';
  end if;

  update public.whatsapp_channels
  set status = 'paused', send_enabled = false, status_changed_at = now()
  where id = v_channel.id
  returning * into v_channel;

  insert into public.audit_logs (workspace_id, actor_user_id, action, resource_type, resource_id, metadata)
  values (
    p_workspace_id, p_actor_user_id, 'whatsapp.channel.paused', 'whatsapp_channel', v_channel.id,
    jsonb_build_object('environment', v_env, 'provider', v_channel.provider)
  );

  return private.whatsapp_channel_safe_row(v_channel);
end;
$body$;

-- Reativar: só a partir de 'paused'. Reativar NÃO religa o envio (nesta
-- fase nada religa: não existe envio real).
create function public.whatsapp_reactivate_channel(p_channel_id uuid, p_workspace_id uuid, p_actor_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_env public.whatsapp_environment := private.require_whatsapp_environment();
  v_channel public.whatsapp_channels := private.whatsapp_lock_managed_channel(p_channel_id, p_workspace_id, p_actor_user_id, v_env);
begin
  if v_channel.status <> 'paused' then
    raise exception 'invalid_channel_state';
  end if;

  update public.whatsapp_channels
  set status = 'active', status_changed_at = now()
  where id = v_channel.id
  returning * into v_channel;

  insert into public.audit_logs (workspace_id, actor_user_id, action, resource_type, resource_id, metadata)
  values (
    p_workspace_id, p_actor_user_id, 'whatsapp.channel.reactivated', 'whatsapp_channel', v_channel.id,
    jsonb_build_object('environment', v_env, 'provider', v_channel.provider)
  );

  return private.whatsapp_channel_safe_row(v_channel);
end;
$body$;

-- Desligar o envio. Não existe a operação inversa nesta fase.
create function public.whatsapp_disable_channel_send(p_channel_id uuid, p_workspace_id uuid, p_actor_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_env public.whatsapp_environment := private.require_whatsapp_environment();
  v_channel public.whatsapp_channels := private.whatsapp_lock_managed_channel(p_channel_id, p_workspace_id, p_actor_user_id, v_env);
begin
  update public.whatsapp_channels
  set send_enabled = false
  where id = v_channel.id
  returning * into v_channel;

  insert into public.audit_logs (workspace_id, actor_user_id, action, resource_type, resource_id, metadata)
  values (
    p_workspace_id, p_actor_user_id, 'whatsapp.channel.send_disabled', 'whatsapp_channel', v_channel.id,
    jsonb_build_object('environment', v_env, 'provider', v_channel.provider)
  );

  return private.whatsapp_channel_safe_row(v_channel);
end;
$body$;

-- Grava (ou substitui) uma credencial cifrada. Canal simulado só aceita o
-- segredo de webhook simulado; chave de API é de provedor real.
create function public.whatsapp_store_channel_credential(
  p_channel_id uuid,
  p_workspace_id uuid,
  p_actor_user_id uuid,
  p_purpose public.whatsapp_credential_purpose,
  p_ciphertext text,
  p_key_version text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_env public.whatsapp_environment := private.require_whatsapp_environment();
  v_channel public.whatsapp_channels := private.whatsapp_lock_managed_channel(p_channel_id, p_workspace_id, p_actor_user_id, v_env);
begin
  if p_purpose is null or (v_channel.is_simulator and p_purpose <> 'webhook_secret') then
    raise exception 'credential_purpose_not_allowed';
  end if;
  if p_ciphertext is null or p_key_version is null then
    raise exception 'invalid_credential';
  end if;

  begin
    insert into public.whatsapp_channel_credentials (
      channel_id, workspace_id, environment, provider, purpose, ciphertext, key_version
    ) values (
      v_channel.id, v_channel.workspace_id, v_env, v_channel.provider, p_purpose, p_ciphertext, p_key_version
    )
    on conflict (channel_id, purpose) do update
      set ciphertext = excluded.ciphertext, key_version = excluded.key_version;
  exception when check_violation then
    raise exception 'invalid_credential';
  end;

  insert into public.audit_logs (workspace_id, actor_user_id, action, resource_type, resource_id, metadata)
  values (
    p_workspace_id, p_actor_user_id, 'whatsapp.channel.credential_stored', 'whatsapp_channel', v_channel.id,
    jsonb_build_object('environment', v_env, 'provider', v_channel.provider, 'purpose', p_purpose)
  );

  return private.whatsapp_channel_safe_row(v_channel);
end;
$body$;

-- Leitura do texto CIFRADO para uso interno do servidor (o adaptador real,
-- nas etapas seguintes). Sem ator: quem chama é o servidor, e só no
-- ambiente autenticado do canal. Decifrar acontece na aplicação.
create function public.whatsapp_get_channel_credential(
  p_channel_id uuid,
  p_purpose public.whatsapp_credential_purpose
)
returns table (
  channel_id uuid,
  workspace_id uuid,
  environment public.whatsapp_environment,
  provider public.whatsapp_provider,
  purpose public.whatsapp_credential_purpose,
  ciphertext text,
  key_version text
)
language plpgsql
stable
security definer
set search_path = ''
as $body$
declare
  v_env public.whatsapp_environment := private.require_whatsapp_environment();
begin
  return query
  select c.channel_id, c.workspace_id, c.environment, c.provider, c.purpose, c.ciphertext, c.key_version
  from public.whatsapp_channel_credentials c
  where c.channel_id = p_channel_id and c.purpose = p_purpose and c.environment = v_env;
end;
$body$;

-- EXECUTE só para service_role, em todas.
revoke all on function public.whatsapp_list_channels(uuid, uuid) from public, anon, authenticated;
revoke all on function public.whatsapp_get_channel_state(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.whatsapp_create_simulated_channel(uuid, uuid, uuid, text, text, text, text, text) from public, anon, authenticated;
revoke all on function public.whatsapp_update_channel_settings(uuid, uuid, uuid, text, text) from public, anon, authenticated;
revoke all on function public.whatsapp_pause_channel(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.whatsapp_reactivate_channel(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.whatsapp_disable_channel_send(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.whatsapp_store_channel_credential(uuid, uuid, uuid, public.whatsapp_credential_purpose, text, text) from public, anon, authenticated;
revoke all on function public.whatsapp_get_channel_credential(uuid, public.whatsapp_credential_purpose) from public, anon, authenticated;

grant execute on function public.whatsapp_list_channels(uuid, uuid) to service_role;
grant execute on function public.whatsapp_get_channel_state(uuid, uuid, uuid) to service_role;
grant execute on function public.whatsapp_create_simulated_channel(uuid, uuid, uuid, text, text, text, text, text) to service_role;
grant execute on function public.whatsapp_update_channel_settings(uuid, uuid, uuid, text, text) to service_role;
grant execute on function public.whatsapp_pause_channel(uuid, uuid, uuid) to service_role;
grant execute on function public.whatsapp_reactivate_channel(uuid, uuid, uuid) to service_role;
grant execute on function public.whatsapp_disable_channel_send(uuid, uuid, uuid) to service_role;
grant execute on function public.whatsapp_store_channel_credential(uuid, uuid, uuid, public.whatsapp_credential_purpose, text, text) to service_role;
grant execute on function public.whatsapp_get_channel_credential(uuid, public.whatsapp_credential_purpose) to service_role;
