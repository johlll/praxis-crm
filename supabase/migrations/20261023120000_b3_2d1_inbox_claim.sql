-- B3.2d-1 — claim atômico da inbox do webhook de WhatsApp
-- (docs/decisoes/b3-whatsapp-real.md §19).
--
-- Só a fundação segura do consumidor: ninguém processa uma entrada sem
-- antes obter o claim dela. Nada aqui cria conversa, contato, lead,
-- atividade ou mensagem, nem fala com provedor ou com o Inngest.
--
-- MÁQUINA DE ESTADOS.
--   pending    --claim-->   processing   (token novo, lease, claim_count + 1)
--   processing --complete-> processed    (terminal)
--   processing --fail-->    failed       (terminal, código sanitizado)
--   processing --release--> pending      (falha transitória; claim_count fica)
--   processing --claim-->   processing   (só com a lease VENCIDA: token novo)
-- Processed e failed nunca mudam de estado (nem por escrita direta).
--
-- CLAIM. Recebe SÓ o id da inbox e a duração da lease (15 a 900 s).
-- Ambiente (o assinado da requisição), workspace, canal, estado ATUAL do
-- canal, provedor, routing key, id e tipo bruto do evento, hash e a cifra
-- saem do banco: nada do evento interno é confiado. A linha é travada
-- (SELECT ... FOR UPDATE): duas chamadas concorrentes nunca saem com dois
-- claims válidos. Resultados: claimed, busy (lease vigente),
-- already_processed, terminal_failed, expired (vencida ou expurgada: a
-- retenção prevalece) e not_found (inexistente ou de outro ambiente).
-- O canal pode estar ativo, pausado, desconectado ou desativado: a entrada
-- já recebida não fica presa; aplicar ou não ao domínio é da B3.2d-2.
--
-- FINALIZAÇÃO. complete, fail e release exigem o token ATUAL; token
-- antigo, inventado, ausente ou de outra entrada não muda nada
-- (claim_lost). Repetir um complete devolve already_processed. Códigos de
-- erro são só símbolos (^[a-z0-9_]{1,64}$), nunca mensagem original.
--
-- claim_count conta AQUISIÇÕES de processamento (cada claim bem-sucedido),
-- não entregas do provedor (essas continuam deduplicadas por canal e id do
-- evento na gravação). Nunca diminui.
--
-- CAMINHO ANTIGO. A leitura de pendente e as marcações sem claim da B3.2b
-- são removidas, e a tabela perde o privilégio direto também de
-- service_role: só as funções (SECURITY DEFINER) a alcançam.

-- ---------------------------------------------------------------------
-- Colunas e restrições do claim
-- ---------------------------------------------------------------------

alter table public.whatsapp_webhook_inbox
  drop constraint whatsapp_webhook_inbox_state_check;

alter table public.whatsapp_webhook_inbox
  add column claim_token uuid,
  add column claimed_at timestamptz,
  add column lease_until timestamptz,
  add column claim_count integer not null default 0,
  -- Evidência sanitizada da última falha TRANSITÓRIA (release): só código
  -- simbólico e horário. A falha terminal continua em error_code/failed_at.
  add column last_release_code text,
  add column last_released_at timestamptz,
  add constraint whatsapp_webhook_inbox_state_check
    check (state in ('pending', 'processing', 'processed', 'failed')),
  add constraint whatsapp_webhook_inbox_claim_count_nonnegative check (claim_count >= 0),
  -- Em processamento: token, horário do claim e lease juntos, lease depois
  -- do claim, ao menos um claim contado e conteúdo presente. Fora dele:
  -- nada de token ou lease.
  add constraint whatsapp_webhook_inbox_claim_coherent check (
    (state = 'processing' and claim_token is not null and claimed_at is not null and lease_until is not null
       and lease_until > claimed_at and claim_count >= 1 and purged_at is null)
    or (state <> 'processing' and claim_token is null and claimed_at is null and lease_until is null)
  ),
  add constraint whatsapp_webhook_inbox_release_evidence check (
    (last_release_code is null) = (last_released_at is null)
    and (last_release_code is null or last_release_code ~ '^[a-z0-9_]{1,64}$')
  );

comment on column public.whatsapp_webhook_inbox.claim_count is
  'Aquisições de processamento (claims bem-sucedidos), não entregas do provedor. Nunca diminui.';
comment on column public.whatsapp_webhook_inbox.claim_token is
  'Token do claim vigente. Só existe em processing; nunca sai na listagem.';

-- Para o reconciliador (B3.2e): entradas com lease vencida.
create index whatsapp_webhook_inbox_lease_idx
  on public.whatsapp_webhook_inbox (environment, lease_until) where state = 'processing';

-- claim_count nunca diminui; processed e failed são terminais.
create function private.whatsapp_webhook_inbox_guard()
returns trigger
language plpgsql
set search_path = ''
as $body$
begin
  if new.claim_count < old.claim_count then
    raise exception 'inbox_claim_count_decreased';
  end if;
  if old.state in ('processed', 'failed') and new.state is distinct from old.state then
    raise exception 'inbox_terminal_state';
  end if;
  return new;
end;
$body$;

revoke all on function private.whatsapp_webhook_inbox_guard() from public, anon, authenticated;

create trigger whatsapp_webhook_inbox_guard
  before update on public.whatsapp_webhook_inbox
  for each row execute function private.whatsapp_webhook_inbox_guard();

-- Sem atalho direto: nem service_role lê ou escreve a tabela. As funções
-- abaixo e as da B3.2b são SECURITY DEFINER.
revoke all on table public.whatsapp_webhook_inbox from service_role;

-- ---------------------------------------------------------------------
-- Caminho antigo sem claim: removido
-- ---------------------------------------------------------------------

drop function public.whatsapp_inbox_get_pending(uuid, uuid, uuid, public.whatsapp_provider, text);
drop function public.whatsapp_inbox_mark_processed(uuid, uuid, uuid, public.whatsapp_provider, text);
drop function public.whatsapp_inbox_mark_failed(uuid, uuid, uuid, public.whatsapp_provider, text, text);
drop function private.whatsapp_inbox_lock_entry(uuid, public.whatsapp_channels, public.whatsapp_environment);

-- ---------------------------------------------------------------------
-- Projeção segura e expurgo, com o claim
-- ---------------------------------------------------------------------

-- Nunca versão de chave, nonce, texto cifrado, tag ou token do claim.
create or replace function private.whatsapp_inbox_safe_row(p_row public.whatsapp_webhook_inbox)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $body$
  select jsonb_build_object(
    'id', p_row.id,
    'provider_event_id', p_row.provider_event_id,
    'provider_event_type', p_row.provider_event_type,
    'body_sha256', p_row.body_sha256,
    'received_at', p_row.received_at,
    'retain_until', p_row.retain_until,
    'state', p_row.state,
    'processed_at', p_row.processed_at,
    'failed_at', p_row.failed_at,
    'purged_at', p_row.purged_at,
    'error_code', p_row.error_code,
    'conflict_count', p_row.conflict_count,
    'last_conflict_at', p_row.last_conflict_at,
    'claim_count', p_row.claim_count,
    'claimed_at', p_row.claimed_at,
    'lease_until', p_row.lease_until,
    'last_release_code', p_row.last_release_code,
    'last_released_at', p_row.last_released_at
  );
$body$;

-- A retenção prevalece também sobre uma entrada em processamento: o
-- expurgo apaga a cifra, invalida o claim (token e lease) e a deixa como
-- tombstone pendente. O token antigo não completa mais nada.
create or replace function public.whatsapp_inbox_purge_expired(p_limit integer)
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
    set key_version = null, nonce = null, ciphertext = null, auth_tag = null, purged_at = now(),
        state = case when i.state = 'processing' then 'pending' else i.state end,
        claim_token = null, claimed_at = null, lease_until = null
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

-- ---------------------------------------------------------------------
-- Claim
-- ---------------------------------------------------------------------

create function public.whatsapp_inbox_claim(p_inbox_id uuid, p_lease_seconds integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_env public.whatsapp_environment := private.require_whatsapp_environment();
  v_row public.whatsapp_webhook_inbox;
  v_channel public.whatsapp_channels;
  v_now timestamptz;
begin
  if p_lease_seconds is null or p_lease_seconds not between 15 and 900 then
    raise exception 'invalid_lease';
  end if;
  if p_inbox_id is null then
    return jsonb_build_object('outcome', 'not_found');
  end if;

  -- Trava de linha: quem chega depois espera e relê a versão final.
  select i.* into v_row
  from public.whatsapp_webhook_inbox i
  where i.id = p_inbox_id and i.environment = v_env
  for update;
  if not found then
    return jsonb_build_object('outcome', 'not_found');
  end if;

  if v_row.state = 'processed' then
    return jsonb_build_object('outcome', 'already_processed');
  end if;
  if v_row.state = 'failed' then
    return jsonb_build_object('outcome', 'terminal_failed');
  end if;

  v_now := clock_timestamp();
  if v_row.purged_at is not null or v_row.retain_until <= v_now then
    return jsonb_build_object('outcome', 'expired');
  end if;
  if v_row.state = 'processing' and v_row.lease_until > v_now then
    return jsonb_build_object('outcome', 'busy');
  end if;

  -- Canal da própria linha, no mesmo ambiente, em QUALQUER estado atual.
  select ch.* into v_channel
  from public.whatsapp_channels ch
  where ch.id = v_row.channel_id
    and ch.workspace_id = v_row.workspace_id
    and ch.environment = v_env
    and ch.provider = v_row.provider;
  if not found then
    return jsonb_build_object('outcome', 'not_found');
  end if;

  update public.whatsapp_webhook_inbox
  set state = 'processing',
      claim_token = gen_random_uuid(),
      claimed_at = v_now,
      lease_until = v_now + make_interval(secs => p_lease_seconds),
      claim_count = claim_count + 1
  where id = v_row.id
  returning * into v_row;

  -- Contexto interno e cifra. Nunca segredo do webhook, chave de API,
  -- credencial ou corpo em texto puro.
  return jsonb_build_object(
    'outcome', 'claimed',
    'inbox_id', v_row.id,
    'claim_token', v_row.claim_token,
    'claim_count', v_row.claim_count,
    'claimed_at', v_row.claimed_at,
    'lease_until', v_row.lease_until,
    'environment', v_row.environment,
    'workspace_id', v_row.workspace_id,
    'channel_id', v_row.channel_id,
    'channel_status', v_channel.status,
    'provider', v_row.provider,
    'routing_key', v_channel.routing_key,
    'provider_event_id', v_row.provider_event_id,
    'provider_event_type', v_row.provider_event_type,
    'body_sha256', v_row.body_sha256,
    'received_at', v_row.received_at,
    'retain_until', v_row.retain_until,
    'key_version', v_row.key_version,
    'nonce', v_row.nonce,
    'ciphertext', v_row.ciphertext,
    'auth_tag', v_row.auth_tag
  );
end;
$body$;

-- ---------------------------------------------------------------------
-- Finalização presa ao token
-- ---------------------------------------------------------------------

-- Trava a entrada do ambiente e decide o resultado; só aplica a transição
-- quando a entrada está em processamento com ESTE token.
create function private.whatsapp_inbox_finish(
  p_inbox_id uuid,
  p_claim_token uuid,
  p_target text,
  p_code text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_env public.whatsapp_environment := private.require_whatsapp_environment();
  v_row public.whatsapp_webhook_inbox;
  v_now timestamptz;
begin
  if p_target not in ('processed', 'failed', 'pending') then
    raise exception 'invalid_inbox_transition';
  end if;
  if p_target <> 'processed' and (p_code is null or p_code !~ '^[a-z0-9_]{1,64}$') then
    raise exception 'invalid_error_code';
  end if;
  if p_inbox_id is null then
    return jsonb_build_object('outcome', 'not_found');
  end if;

  select i.* into v_row
  from public.whatsapp_webhook_inbox i
  where i.id = p_inbox_id and i.environment = v_env
  for update;
  if not found then
    return jsonb_build_object('outcome', 'not_found');
  end if;
  if v_row.state = 'processed' then
    return jsonb_build_object('outcome', 'already_processed');
  end if;
  if v_row.state = 'failed' then
    return jsonb_build_object('outcome', 'terminal_failed');
  end if;
  if v_row.state <> 'processing' or p_claim_token is null then
    return jsonb_build_object('outcome', 'claim_lost');
  end if;

  v_now := clock_timestamp();
  if p_target = 'processed' then
    update public.whatsapp_webhook_inbox
    set state = 'processed', processed_at = v_now, claim_token = null, claimed_at = null, lease_until = null
    where id = v_row.id;
    return jsonb_build_object('outcome', 'completed');
  end if;

  if p_target = 'failed' then
    update public.whatsapp_webhook_inbox
    set state = 'failed', failed_at = v_now, error_code = p_code, claim_token = null, claimed_at = null, lease_until = null
    where id = v_row.id;
    insert into public.audit_logs (workspace_id, actor_user_id, action, resource_type, resource_id, metadata)
    values (
      v_row.workspace_id, null, 'whatsapp.inbox.failed', 'whatsapp_webhook_inbox', v_row.id,
      jsonb_build_object('environment', v_env, 'provider', v_row.provider, 'channel_id', v_row.channel_id, 'code', p_code)
    );
    return jsonb_build_object('outcome', 'failed');
  end if;

  update public.whatsapp_webhook_inbox
  set state = 'pending', claim_token = null, claimed_at = null, lease_until = null,
      last_release_code = p_code, last_released_at = v_now
  where id = v_row.id;
  return jsonb_build_object('outcome', 'released');
end;
$body$;

revoke all on function private.whatsapp_inbox_finish(uuid, uuid, text, text) from public, anon, authenticated;

create function public.whatsapp_inbox_complete(p_inbox_id uuid, p_claim_token uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $body$
begin
  return private.whatsapp_inbox_finish(p_inbox_id, p_claim_token, 'processed', null);
end;
$body$;

create function public.whatsapp_inbox_fail(p_inbox_id uuid, p_claim_token uuid, p_error_code text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $body$
begin
  return private.whatsapp_inbox_finish(p_inbox_id, p_claim_token, 'failed', p_error_code);
end;
$body$;

create function public.whatsapp_inbox_release(p_inbox_id uuid, p_claim_token uuid, p_error_code text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $body$
begin
  return private.whatsapp_inbox_finish(p_inbox_id, p_claim_token, 'pending', p_error_code);
end;
$body$;

-- EXECUTE só para service_role.
revoke all on function public.whatsapp_inbox_claim(uuid, integer) from public, anon, authenticated;
revoke all on function public.whatsapp_inbox_complete(uuid, uuid) from public, anon, authenticated;
revoke all on function public.whatsapp_inbox_fail(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.whatsapp_inbox_release(uuid, uuid, text) from public, anon, authenticated;

grant execute on function public.whatsapp_inbox_claim(uuid, integer) to service_role;
grant execute on function public.whatsapp_inbox_complete(uuid, uuid) to service_role;
grant execute on function public.whatsapp_inbox_fail(uuid, uuid, text) to service_role;
grant execute on function public.whatsapp_inbox_release(uuid, uuid, text) to service_role;
