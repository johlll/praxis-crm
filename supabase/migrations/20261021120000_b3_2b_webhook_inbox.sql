-- B3.2b — caixa de entrada CIFRADA do webhook de WhatsApp
-- (docs/decisoes/b3-whatsapp-real.md §4.3, §15.9, §17).
--
-- Só o armazenamento durável e idempotente de cada entrega autêntica do
-- webhook. Nada aqui recebe requisição, processa mensagem, cria contato,
-- lead ou conversa, nem fala com provedor. A rota é da B3.2c; o
-- processamento, da B3.2d.
--
-- O QUE FICA GRAVADO. Ambiente, workspace, canal, provedor, id do evento,
-- tipo do evento normalizado (vocabulário do CRM), SHA-256 dos bytes
-- exatos e o corpo CIFRADO pela aplicação (AES-256-GCM, chave própria da
-- inbox, AAD com finalidade, ambiente, workspace, canal, provedor e id do
-- evento): versão da chave, nonce, texto cifrado e tag em colunas
-- separadas. Nunca em texto puro: corpo, mensagem, telefone, BSUID, nome,
-- mídia, assinatura recebida ou segredo.
--
-- IDEMPOTÊNCIA. Única por (canal, id do evento). A gravação distingue:
--   - inserted: primeira entrega;
--   - duplicate: mesmo canal, mesmo id, mesmo hash;
--   - conflict: mesmo canal, mesmo id, hash diferente. O primeiro payload
--     nunca é sobrescrito; fica só a evidência mínima (contagem, horário e
--     hash da entrega divergente) e um registro de auditoria sem conteúdo.
--
-- RETENÇÃO. A política definitiva da Vizentini não é escolhida aqui (§12,
-- decisão 6). O prazo vem da aplicação, por configuração confiável; sem
-- prazo válido, a gravação falha fechada. O expurgo apaga versão, nonce,
-- texto cifrado e tag e deixa um TOMBSTONE (canal, id do evento, hash,
-- datas, purged_at) que continua impedindo que uma reentrega antiga seja
-- tratada como evento nova.
--
-- ISOLAMENTO. Tabela deny-all (RLS forçada, sem GRANT). Funções SECURITY
-- DEFINER, search_path travado, EXECUTE só para service_role, sempre com o
-- ambiente assinado do WhatsApp e a identidade inteira do canal (canal,
-- workspace, provedor, routing key) conferida contra a linha real. Canal
-- ativo ou pausado: aceito (o pausado preserva o evento autêntico; a
-- decisão de processar é da B3.2c/B3.2d). Desativado, desconectado ou de
-- outro ambiente: não encontrado.

create table public.whatsapp_webhook_inbox (
  id uuid primary key default gen_random_uuid(),
  environment public.whatsapp_environment not null,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  channel_id uuid not null,
  provider public.whatsapp_provider not null,
  provider_event_id text not null
    check (provider_event_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  -- Tipo do evento já normalizado pelo adaptador (contrato do CRM): metadado
  -- operacional, sem conteúdo.
  event_kind text not null
    check (event_kind in (
      'message.inbound', 'message.outbound_observed', 'message.status',
      'contact.identity_changed', 'ignored', 'account', 'unsupported'
    )),
  body_sha256 text not null check (body_sha256 ~ '^[0-9a-f]{64}$'),
  -- Corpo cifrado pela aplicação. Base64: nonce de 12 bytes, tag de 16.
  -- O texto cifrado cabe no limite de 256 KiB do corpo.
  key_version text check (key_version ~ '^[A-Za-z0-9_-]{1,32}$'),
  nonce text check (nonce ~ '^[A-Za-z0-9+/]{16}$'),
  ciphertext text check (char_length(ciphertext) between 4 and 349528 and ciphertext ~ '^[A-Za-z0-9+/]+={0,2}$'),
  auth_tag text check (auth_tag ~ '^[A-Za-z0-9+/]{22}==$'),
  received_at timestamptz not null default now(),
  retain_until timestamptz not null,
  state text not null default 'pending' check (state in ('pending', 'processed', 'failed')),
  processed_at timestamptz,
  failed_at timestamptz,
  purged_at timestamptz,
  -- Só código simbólico: nunca mensagem de erro original ou conteúdo.
  error_code text check (error_code ~ '^[a-z0-9_]{1,64}$'),
  conflict_count integer not null default 0 check (conflict_count >= 0),
  last_conflict_at timestamptz,
  last_conflict_sha256 text check (last_conflict_sha256 ~ '^[0-9a-f]{64}$'),
  constraint whatsapp_webhook_inbox_channel_event_key unique (channel_id, provider_event_id),
  constraint whatsapp_webhook_inbox_channel_identity_fkey
    foreign key (workspace_id, channel_id, environment, provider)
    references public.whatsapp_channels (workspace_id, id, environment, provider) on delete cascade,
  -- Conteúdo cifrado completo OU tombstone: nunca meio-termo.
  constraint whatsapp_webhook_inbox_content_or_tombstone check (
    (purged_at is null and key_version is not null and nonce is not null and ciphertext is not null and auth_tag is not null)
    or (purged_at is not null and key_version is null and nonce is null and ciphertext is null and auth_tag is null)
  ),
  constraint whatsapp_webhook_inbox_processed_dates check ((state = 'processed') = (processed_at is not null)),
  constraint whatsapp_webhook_inbox_failed_dates check ((state = 'failed') = (failed_at is not null and error_code is not null)),
  constraint whatsapp_webhook_inbox_error_only_when_failed check (error_code is null or state = 'failed'),
  constraint whatsapp_webhook_inbox_retention_after_receipt check (retain_until > received_at),
  constraint whatsapp_webhook_inbox_conflict_evidence check (
    (conflict_count = 0) = (last_conflict_at is null and last_conflict_sha256 is null)
  )
);

create index whatsapp_webhook_inbox_workspace_idx on public.whatsapp_webhook_inbox (workspace_id);
create index whatsapp_webhook_inbox_pending_idx
  on public.whatsapp_webhook_inbox (channel_id, received_at) where state = 'pending' and purged_at is null;
create index whatsapp_webhook_inbox_expiry_idx
  on public.whatsapp_webhook_inbox (environment, retain_until) where purged_at is null;

alter table public.whatsapp_webhook_inbox enable row level security;
alter table public.whatsapp_webhook_inbox force row level security;
revoke all on table public.whatsapp_webhook_inbox from public, anon, authenticated;

create policy whatsapp_webhook_inbox_select_deny on public.whatsapp_webhook_inbox for select to authenticated using (false);
create policy whatsapp_webhook_inbox_insert_deny on public.whatsapp_webhook_inbox for insert to authenticated with check (false);
create policy whatsapp_webhook_inbox_update_deny on public.whatsapp_webhook_inbox for update to authenticated using (false);
create policy whatsapp_webhook_inbox_delete_deny on public.whatsapp_webhook_inbox for delete to authenticated using (false);

comment on table public.whatsapp_webhook_inbox is
  'Caixa de entrada do webhook de WhatsApp (B3.2b): uma linha por (canal, id do evento), com o corpo cifrado pela aplicação (chave e AAD próprias da inbox), hash dos bytes exatos e retenção obrigatória. Sem texto puro. Deny-all; só funções de service_role com ambiente autenticado.';

-- ---------------------------------------------------------------------
-- Canal da inbox: identidade inteira conferida, só ativo ou pausado
-- ---------------------------------------------------------------------

create function private.whatsapp_inbox_channel(
  p_channel_id uuid,
  p_workspace_id uuid,
  p_provider public.whatsapp_provider,
  p_routing_key text,
  p_env public.whatsapp_environment
)
returns public.whatsapp_channels
language plpgsql
stable
security definer
set search_path = ''
as $body$
declare
  v_channel public.whatsapp_channels;
begin
  if p_channel_id is null or p_workspace_id is null or p_provider is null or p_routing_key is null or p_env is null then
    raise exception 'channel_not_found';
  end if;

  select ch.* into v_channel
  from public.whatsapp_channels ch
  where ch.id = p_channel_id
    and ch.workspace_id = p_workspace_id
    and ch.environment = p_env
    and ch.provider = p_provider
    and ch.routing_key = p_routing_key
    and ch.status in ('active', 'paused');
  if not found then
    raise exception 'channel_not_found';
  end if;
  return v_channel;
end;
$body$;

revoke all on function private.whatsapp_inbox_channel(uuid, uuid, public.whatsapp_provider, text, public.whatsapp_environment) from public, anon, authenticated;

-- Projeção SEGURA de uma entrada: nunca versão de chave, nonce, texto
-- cifrado ou tag.
create function private.whatsapp_inbox_safe_row(p_row public.whatsapp_webhook_inbox)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $body$
  select jsonb_build_object(
    'id', p_row.id,
    'provider_event_id', p_row.provider_event_id,
    'event_kind', p_row.event_kind,
    'body_sha256', p_row.body_sha256,
    'received_at', p_row.received_at,
    'retain_until', p_row.retain_until,
    'state', p_row.state,
    'processed_at', p_row.processed_at,
    'failed_at', p_row.failed_at,
    'purged_at', p_row.purged_at,
    'error_code', p_row.error_code,
    'conflict_count', p_row.conflict_count,
    'last_conflict_at', p_row.last_conflict_at
  );
$body$;

revoke all on function private.whatsapp_inbox_safe_row(public.whatsapp_webhook_inbox) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- Gravação idempotente
-- ---------------------------------------------------------------------

create function public.whatsapp_inbox_store(
  p_channel_id uuid,
  p_workspace_id uuid,
  p_provider public.whatsapp_provider,
  p_routing_key text,
  p_provider_event_id text,
  p_event_kind text,
  p_body_sha256 text,
  p_key_version text,
  p_nonce text,
  p_ciphertext text,
  p_auth_tag text,
  p_retain_until timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_env public.whatsapp_environment := private.require_whatsapp_environment();
  v_channel public.whatsapp_channels := private.whatsapp_inbox_channel(p_channel_id, p_workspace_id, p_provider, p_routing_key, v_env);
  v_id uuid;
  v_existing public.whatsapp_webhook_inbox;
begin
  if p_provider_event_id is null or p_provider_event_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
     or p_event_kind is null or p_event_kind not in (
       'message.inbound', 'message.outbound_observed', 'message.status',
       'contact.identity_changed', 'ignored', 'account', 'unsupported') then
    raise exception 'invalid_inbox_event';
  end if;
  if p_body_sha256 is null or p_body_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid_inbox_hash';
  end if;
  if p_key_version is null or p_key_version !~ '^[A-Za-z0-9_-]{1,32}$'
     or p_nonce is null or p_nonce !~ '^[A-Za-z0-9+/]{16}$'
     or p_auth_tag is null or p_auth_tag !~ '^[A-Za-z0-9+/]{22}==$'
     or p_ciphertext is null or char_length(p_ciphertext) not between 4 and 349528
     or p_ciphertext !~ '^[A-Za-z0-9+/]+={0,2}$' then
    raise exception 'invalid_inbox_ciphertext';
  end if;
  if p_retain_until is null or p_retain_until <= now() or p_retain_until > now() + interval '3650 days' then
    raise exception 'invalid_retention';
  end if;

  insert into public.whatsapp_webhook_inbox (
    environment, workspace_id, channel_id, provider, provider_event_id, event_kind,
    body_sha256, key_version, nonce, ciphertext, auth_tag, retain_until
  ) values (
    v_env, v_channel.workspace_id, v_channel.id, v_channel.provider, p_provider_event_id, p_event_kind,
    p_body_sha256, p_key_version, p_nonce, p_ciphertext, p_auth_tag, p_retain_until
  )
  on conflict (channel_id, provider_event_id) do nothing
  returning id into v_id;

  if v_id is not null then
    return jsonb_build_object('outcome', 'inserted', 'inbox_id', v_id);
  end if;

  -- Já existe (inclusive tombstone): trava a linha e compara só o hash.
  select i.* into v_existing
  from public.whatsapp_webhook_inbox i
  where i.channel_id = v_channel.id and i.provider_event_id = p_provider_event_id
  for update;

  if v_existing.body_sha256 = p_body_sha256 then
    return jsonb_build_object('outcome', 'duplicate', 'inbox_id', v_existing.id);
  end if;

  -- Conflito: o primeiro payload fica intacto; o novo nem é guardado.
  update public.whatsapp_webhook_inbox
  set conflict_count = conflict_count + 1,
      last_conflict_at = now(),
      last_conflict_sha256 = p_body_sha256
  where id = v_existing.id;

  insert into public.audit_logs (workspace_id, actor_user_id, action, resource_type, resource_id, metadata)
  values (
    v_channel.workspace_id, null, 'whatsapp.inbox.conflict', 'whatsapp_webhook_inbox', v_existing.id,
    jsonb_build_object('environment', v_env, 'provider', v_channel.provider, 'channel_id', v_channel.id)
  );

  return jsonb_build_object('outcome', 'conflict', 'inbox_id', v_existing.id);
end;
$body$;

-- ---------------------------------------------------------------------
-- Listagem (só metadado) e leitura de pendente (texto cifrado)
-- ---------------------------------------------------------------------

create function public.whatsapp_inbox_list(
  p_channel_id uuid,
  p_workspace_id uuid,
  p_provider public.whatsapp_provider,
  p_routing_key text,
  p_limit integer
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $body$
declare
  v_env public.whatsapp_environment := private.require_whatsapp_environment();
  v_channel public.whatsapp_channels := private.whatsapp_inbox_channel(p_channel_id, p_workspace_id, p_provider, p_routing_key, v_env);
begin
  if p_limit is null or p_limit not between 1 and 200 then
    raise exception 'invalid_limit';
  end if;

  return coalesce((
    select jsonb_agg(private.whatsapp_inbox_safe_row(r) order by r.received_at desc, r.id)
    from (
      select i.* from public.whatsapp_webhook_inbox i
      where i.channel_id = v_channel.id and i.environment = v_env
      order by i.received_at desc, i.id
      limit p_limit
    ) r
  ), '[]'::jsonb);
end;
$body$;

-- Texto cifrado de UMA entrada pendente, só pela identidade inteira do
-- canal. Decifrar acontece na aplicação, que confere tudo de novo e monta
-- a AAD do próprio contexto.
create function public.whatsapp_inbox_get_pending(
  p_inbox_id uuid,
  p_channel_id uuid,
  p_workspace_id uuid,
  p_provider public.whatsapp_provider,
  p_routing_key text
)
returns table (
  inbox_id uuid,
  channel_id uuid,
  workspace_id uuid,
  environment public.whatsapp_environment,
  provider public.whatsapp_provider,
  routing_key text,
  provider_event_id text,
  event_kind text,
  body_sha256 text,
  key_version text,
  nonce text,
  ciphertext text,
  auth_tag text
)
language plpgsql
stable
security definer
set search_path = ''
as $body$
declare
  v_env public.whatsapp_environment := private.require_whatsapp_environment();
  v_channel public.whatsapp_channels := private.whatsapp_inbox_channel(p_channel_id, p_workspace_id, p_provider, p_routing_key, v_env);
begin
  return query
  select i.id, i.channel_id, i.workspace_id, i.environment, i.provider, v_channel.routing_key,
         i.provider_event_id, i.event_kind, i.body_sha256, i.key_version, i.nonce, i.ciphertext, i.auth_tag
  from public.whatsapp_webhook_inbox i
  where i.id = p_inbox_id
    and i.channel_id = v_channel.id
    and i.workspace_id = v_channel.workspace_id
    and i.environment = v_env
    and i.provider = v_channel.provider
    and i.state = 'pending'
    and i.purged_at is null;
end;
$body$;

-- ---------------------------------------------------------------------
-- Estados: pendente → processado | falho; sem regressão, sem nova
-- tentativa (a política é da B3.2c/B3.2d e do reconciliador)
-- ---------------------------------------------------------------------

create function private.whatsapp_inbox_lock_entry(
  p_inbox_id uuid,
  p_channel public.whatsapp_channels,
  p_env public.whatsapp_environment
)
returns public.whatsapp_webhook_inbox
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_row public.whatsapp_webhook_inbox;
begin
  select i.* into v_row
  from public.whatsapp_webhook_inbox i
  where i.id = p_inbox_id
    and i.channel_id = p_channel.id
    and i.workspace_id = p_channel.workspace_id
    and i.environment = p_env
    and i.provider = p_channel.provider
  for update;
  if not found then
    raise exception 'inbox_entry_not_found';
  end if;
  if v_row.purged_at is not null then
    raise exception 'inbox_entry_purged';
  end if;
  return v_row;
end;
$body$;

revoke all on function private.whatsapp_inbox_lock_entry(uuid, public.whatsapp_channels, public.whatsapp_environment) from public, anon, authenticated;

create function public.whatsapp_inbox_mark_processed(
  p_inbox_id uuid,
  p_channel_id uuid,
  p_workspace_id uuid,
  p_provider public.whatsapp_provider,
  p_routing_key text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_env public.whatsapp_environment := private.require_whatsapp_environment();
  v_channel public.whatsapp_channels := private.whatsapp_inbox_channel(p_channel_id, p_workspace_id, p_provider, p_routing_key, v_env);
  v_row public.whatsapp_webhook_inbox := private.whatsapp_inbox_lock_entry(p_inbox_id, v_channel, v_env);
begin
  if v_row.state = 'processed' then
    return private.whatsapp_inbox_safe_row(v_row);
  end if;
  if v_row.state <> 'pending' then
    raise exception 'invalid_inbox_state';
  end if;

  update public.whatsapp_webhook_inbox
  set state = 'processed', processed_at = now()
  where id = v_row.id
  returning * into v_row;
  return private.whatsapp_inbox_safe_row(v_row);
end;
$body$;

create function public.whatsapp_inbox_mark_failed(
  p_inbox_id uuid,
  p_channel_id uuid,
  p_workspace_id uuid,
  p_provider public.whatsapp_provider,
  p_routing_key text,
  p_error_code text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_env public.whatsapp_environment := private.require_whatsapp_environment();
  v_channel public.whatsapp_channels := private.whatsapp_inbox_channel(p_channel_id, p_workspace_id, p_provider, p_routing_key, v_env);
  v_row public.whatsapp_webhook_inbox;
begin
  if p_error_code is null or p_error_code !~ '^[a-z0-9_]{1,64}$' then
    raise exception 'invalid_error_code';
  end if;
  v_row := private.whatsapp_inbox_lock_entry(p_inbox_id, v_channel, v_env);
  if v_row.state = 'failed' then
    return private.whatsapp_inbox_safe_row(v_row);
  end if;
  if v_row.state <> 'pending' then
    raise exception 'invalid_inbox_state';
  end if;

  update public.whatsapp_webhook_inbox
  set state = 'failed', failed_at = now(), error_code = p_error_code
  where id = v_row.id
  returning * into v_row;
  return private.whatsapp_inbox_safe_row(v_row);
end;
$body$;

-- ---------------------------------------------------------------------
-- Expurgo: tombstone, idempotente, auditado sem conteúdo
-- ---------------------------------------------------------------------

-- Para o agendador futuro (sem ele nesta etapa). Só o ambiente assinado;
-- não depende do estado do canal: dado vencido de canal desativado também
-- é expurgado. Repetir não faz nada.
create function public.whatsapp_inbox_purge_expired(p_limit integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_env public.whatsapp_environment := private.require_whatsapp_environment();
  v_total integer;
begin
  if p_limit is null or p_limit not between 1 and 5000 then
    raise exception 'invalid_limit';
  end if;

  with expired as (
    select i.id
    from public.whatsapp_webhook_inbox i
    where i.environment = v_env and i.purged_at is null and i.retain_until <= now()
    order by i.retain_until, i.id
    limit p_limit
    for update skip locked
  ),
  purged as (
    update public.whatsapp_webhook_inbox i
    set key_version = null, nonce = null, ciphertext = null, auth_tag = null, purged_at = now()
    from expired e
    where i.id = e.id
    returning i.workspace_id
  ),
  per_workspace as (
    select p.workspace_id, count(*)::integer as n from purged p group by p.workspace_id
  ),
  -- Um registro por workspace afetado, só com a contagem. Um CTE que
  -- modifica dados roda sempre, mesmo sem ser referenciado.
  audit as (
    insert into public.audit_logs (workspace_id, actor_user_id, action, resource_type, resource_id, metadata)
    select w.workspace_id, null, 'whatsapp.inbox.purged', 'whatsapp_webhook_inbox', null,
           jsonb_build_object('environment', v_env, 'purged', w.n)
    from per_workspace w
  )
  select coalesce(sum(w.n), 0)::integer into v_total
  from per_workspace w;

  return jsonb_build_object('purged', v_total);
end;
$body$;

-- EXECUTE só para service_role, em todas.
revoke all on function public.whatsapp_inbox_store(uuid, uuid, public.whatsapp_provider, text, text, text, text, text, text, text, text, timestamptz) from public, anon, authenticated;
revoke all on function public.whatsapp_inbox_list(uuid, uuid, public.whatsapp_provider, text, integer) from public, anon, authenticated;
revoke all on function public.whatsapp_inbox_get_pending(uuid, uuid, uuid, public.whatsapp_provider, text) from public, anon, authenticated;
revoke all on function public.whatsapp_inbox_mark_processed(uuid, uuid, uuid, public.whatsapp_provider, text) from public, anon, authenticated;
revoke all on function public.whatsapp_inbox_mark_failed(uuid, uuid, uuid, public.whatsapp_provider, text, text) from public, anon, authenticated;
revoke all on function public.whatsapp_inbox_purge_expired(integer) from public, anon, authenticated;

grant execute on function public.whatsapp_inbox_store(uuid, uuid, public.whatsapp_provider, text, text, text, text, text, text, text, text, timestamptz) to service_role;
grant execute on function public.whatsapp_inbox_list(uuid, uuid, public.whatsapp_provider, text, integer) to service_role;
grant execute on function public.whatsapp_inbox_get_pending(uuid, uuid, uuid, public.whatsapp_provider, text) to service_role;
grant execute on function public.whatsapp_inbox_mark_processed(uuid, uuid, uuid, public.whatsapp_provider, text) to service_role;
grant execute on function public.whatsapp_inbox_mark_failed(uuid, uuid, uuid, public.whatsapp_provider, text, text) to service_role;
grant execute on function public.whatsapp_inbox_purge_expired(integer) to service_role;
grant execute on function public.whatsapp_inbox_store(uuid, uuid, public.whatsapp_provider, text, text, text, text, text, text, text, text, timestamptz) to authenticated;
grant execute on function public.whatsapp_inbox_list(uuid, uuid, public.whatsapp_provider, text, integer) to authenticated;
