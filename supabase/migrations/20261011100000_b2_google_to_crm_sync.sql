-- B2, etapa 3 — Google → CRM (docs/decisoes/b2-google-agenda.md §6.2, §9).
--
-- 1) `calendar_sync_state`: por conexão e agenda, o `syncToken`, a trava de
--    execução (uma sincronização por vez), a dica do webhook (`dirty_at`) e
--    a última visita da manutenção (lote justo). O token só avança quando
--    TODAS as páginas foram processadas, e toda escrita confere a trava com
--    a linha bloqueada (`private.lock_sync_lease`).
-- 2) `calendar_watch_channels`: canais de notificação, com o segredo do
--    canal guardado só como hash, a vida EFETIVA devolvida pelo Google e a
--    trava de renovação.
-- 3) `apply_google_inbound_change`: aplica a mudança do Google à atividade e
--    à base do vínculo NA MESMA transação, só se a atividade ainda está na
--    versão lida e a base é a lida; o valor do CRM que perdeu num conflito é
--    gravado junto. Sem alcance do dono da conexão à atividade, nada é
--    aplicado e o vínculo fica para atenção.
-- 4) Webhook: `record_calendar_notification` reconhece só canal conhecido
--    do ambiente, com o segredo certo.
--
-- Eventos SEM vínculo nunca chegam ao banco: a filtragem é feita em memória.
-- Não é aplicada ao banco hospedado sem autorização à parte.

-- ---------------------------------------------------------------------
-- 1) Estado de sincronização
-- ---------------------------------------------------------------------

create table public.calendar_sync_state (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  connection_id uuid not null,
  environment public.calendar_environment not null,
  calendar_id text not null check (char_length(btrim(calendar_id)) between 1 and 1024),
  sync_token text check (sync_token is null or char_length(sync_token) <= 4096),
  sync_token_at timestamptz,
  -- Última listagem COMPLETA concluída (sync de segurança diário e após 410).
  full_sync_at timestamptz,
  -- Última execução concluída com sucesso.
  last_run_at timestamptz,
  last_error text check (last_error is null or char_length(last_error) <= 100),
  last_error_at timestamptz,
  -- Dica do webhook: algo mudou na agenda depois da última execução.
  dirty_at timestamptz,
  -- Última vez que a agenda entrou num lote da manutenção (justiça entre
  -- rodadas: os visitados há mais tempo vão primeiro).
  last_visit_at timestamptz,
  -- Trava de execução: uma sincronização por conexão e agenda.
  lease_id uuid,
  lease_started_at timestamptz,
  lease_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint calendar_sync_state_connection_fkey
    foreign key (workspace_id, connection_id) references public.calendar_connections (workspace_id, id) on delete cascade,
  constraint calendar_sync_state_connection_calendar_key unique (connection_id, calendar_id)
);

alter table public.calendar_sync_state enable row level security;
alter table public.calendar_sync_state force row level security;
create policy calendar_sync_state_select_deny on public.calendar_sync_state for select to authenticated using (false);
create policy calendar_sync_state_insert_deny on public.calendar_sync_state for insert to authenticated with check (false);
create policy calendar_sync_state_update_deny on public.calendar_sync_state for update to authenticated using (false);
create policy calendar_sync_state_delete_deny on public.calendar_sync_state for delete to authenticated using (false);
revoke all on table public.calendar_sync_state from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 2) Canais de notificação
-- ---------------------------------------------------------------------

create table public.calendar_watch_channels (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  connection_id uuid not null,
  environment public.calendar_environment not null,
  calendar_id text not null check (char_length(btrim(calendar_id)) between 1 and 1024),
  channel_id text not null unique check (char_length(channel_id) between 1 and 64),
  -- SHA-256 (hex) do segredo enviado ao Google no `token` do canal. O
  -- segredo em si nunca é guardado.
  token_hash text not null check (token_hash ~ '^[0-9a-f]{64}$'),
  resource_id text check (resource_id is null or char_length(resource_id) <= 1024),
  status text not null default 'creating'
    check (status in ('creating', 'active', 'retiring', 'stopped', 'polling_only')),
  -- Vida EFETIVA devolvida pelo Google (não há TTL fixo documentado).
  expires_at timestamptz,
  renew_at timestamptz,
  renewing_until timestamptz,
  -- Primeira mensagem (`sync`) recebida: o canal está de fato entregando.
  sync_received_at timestamptz,
  last_message_number bigint,
  last_notified_at timestamptz,
  stop_reason text check (stop_reason is null or char_length(stop_reason) <= 100),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  stopped_at timestamptz,
  constraint calendar_watch_channels_connection_fkey
    foreign key (workspace_id, connection_id) references public.calendar_connections (workspace_id, id) on delete cascade
);

create index calendar_watch_channels_live_idx
  on public.calendar_watch_channels (connection_id, calendar_id)
  where status in ('creating', 'active', 'retiring');

alter table public.calendar_watch_channels enable row level security;
alter table public.calendar_watch_channels force row level security;
create policy calendar_watch_channels_select_deny on public.calendar_watch_channels for select to authenticated using (false);
create policy calendar_watch_channels_insert_deny on public.calendar_watch_channels for insert to authenticated with check (false);
create policy calendar_watch_channels_update_deny on public.calendar_watch_channels for update to authenticated using (false);
create policy calendar_watch_channels_delete_deny on public.calendar_watch_channels for delete to authenticated using (false);
revoke all on table public.calendar_watch_channels from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- Auxiliar: a conexão é do ator, do ambiente autenticado e está ativa.
-- ---------------------------------------------------------------------

create function private.own_active_connection(p_connection_id uuid, p_actor_user_id uuid)
returns public.calendar_connections
language plpgsql
stable
security definer
set search_path = ''
as $body$
declare
  v_env public.calendar_environment := private.require_request_environment();
  v_conn public.calendar_connections;
begin
  select * into v_conn from public.calendar_connections c where c.id = p_connection_id;
  if v_conn.id is null or v_conn.user_id is distinct from p_actor_user_id or v_conn.status = 'disconnected' then
    raise exception 'connection_not_found';
  end if;
  if v_conn.environment <> v_env then
    raise exception 'calendar_environment_mismatch';
  end if;
  if v_conn.status <> 'active' then
    raise exception 'connection_not_active';
  end if;
  return v_conn;
end;
$body$;

revoke all on function private.own_active_connection(uuid, uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- claim_calendar_maintenance_batch — o lote de UMA rodada da manutenção.
--
-- Candidatos: cada (conexão ATIVA, agenda) com vínculo ativo no ambiente.
-- Lote justo, limitado (1–200): até metade das vagas para agendas com dica
-- do webhook ainda não atendida (a mais antiga primeiro); o resto para as
-- visitadas há mais tempo (nunca visitadas primeiro). Cada escolhida tem a
-- visita marcada aqui, na mesma operação: a rodada seguinte começa pelas
-- outras, e toda agenda é visitada em poucas rodadas mesmo quando há mais
-- agendas que vagas.
--
-- Canais: os do lote, mais os que podem ter de ser encerrados em QUALQUER
-- agenda (sem vínculo ativo ou vencidos), até 200. Cada canal diz se a
-- agenda dele tem vínculo (`hasLinks`), calculado aqui e não pela presença
-- no lote: agenda fora do lote não está sem vínculo.
-- Nunca tokens nem hashes.
-- ---------------------------------------------------------------------

create function public.claim_calendar_maintenance_batch(p_limit integer default 25)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_env public.calendar_environment := private.require_request_environment();
  v_limit integer := greatest(1, least(coalesce(p_limit, 25), 200));
  v_targets jsonb;
  v_channels jsonb;
begin
  with candidates as (
    select distinct l.connection_id, l.calendar_id
    from public.calendar_event_links l
    join public.calendar_connections c on c.id = l.connection_id and c.environment = v_env and c.status = 'active'
    where l.environment = v_env and l.status <> 'unlinked'
  ),
  ranked as (
    select k.connection_id, k.calendar_id, s.last_visit_at, s.dirty_at,
      (s.dirty_at is not null and (s.last_visit_at is null or s.dirty_at > s.last_visit_at)) as hinted
    from candidates k
    left join public.calendar_sync_state s on s.connection_id = k.connection_id and s.calendar_id = k.calendar_id
  ),
  hinted as (
    select r.connection_id, r.calendar_id, 0 as tier, row_number() over (order by r.dirty_at, r.connection_id, r.calendar_id) as pos
    from ranked r where r.hinted
    order by r.dirty_at, r.connection_id, r.calendar_id
    limit v_limit / 2
  ),
  fair as (
    select r.connection_id, r.calendar_id, 1 as tier,
      row_number() over (order by r.last_visit_at asc nulls first, r.connection_id, r.calendar_id) as pos
    from ranked r
    order by r.last_visit_at asc nulls first, r.connection_id, r.calendar_id
    limit v_limit
  ),
  picked as (
    select distinct on (u.connection_id, u.calendar_id) u.connection_id, u.calendar_id, u.tier, u.pos
    from (select * from hinted union all select * from fair) u
    order by u.connection_id, u.calendar_id, u.tier, u.pos
  ),
  batch as (
    select p.connection_id, p.calendar_id, p.tier, p.pos from picked p order by p.tier, p.pos limit v_limit
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'connectionId', b.connection_id,
      'workspaceId', c.workspace_id,
      'userId', c.user_id,
      'connectionStatus', c.status,
      'calendarId', b.calendar_id,
      'hasSyncToken', s.sync_token is not null,
      'lastRunAt', s.last_run_at,
      'fullSyncAt', s.full_sync_at,
      'dirtyAt', s.dirty_at,
      'leaseUntil', s.lease_until
    ) order by b.tier, b.pos), '[]'::jsonb)
  into v_targets
  from batch b
  join public.calendar_connections c on c.id = b.connection_id
  left join public.calendar_sync_state s on s.connection_id = b.connection_id and s.calendar_id = b.calendar_id;

  -- A visita é marcada na reserva.
  insert into public.calendar_sync_state (workspace_id, connection_id, environment, calendar_id, last_visit_at)
  select (t ->> 'workspaceId')::uuid, (t ->> 'connectionId')::uuid, v_env, t ->> 'calendarId', now()
  from jsonb_array_elements(v_targets) t
  on conflict (connection_id, calendar_id) do update set last_visit_at = now(), updated_at = now();

  select coalesce(jsonb_agg(x.item order by x.updated_at), '[]'::jsonb)
  into v_channels
  from (
    select w.updated_at, jsonb_build_object(
      'channelId', w.channel_id,
      'connectionId', w.connection_id,
      'workspaceId', w.workspace_id,
      'userId', c.user_id,
      'connectionStatus', c.status,
      'calendarId', w.calendar_id,
      'status', w.status,
      'resourceId', w.resource_id,
      'expiresAt', w.expires_at,
      'renewAt', w.renew_at,
      'syncReceivedAt', w.sync_received_at,
      'createdAt', w.created_at,
      'updatedAt', w.updated_at,
      'hasLinks', exists (
        select 1 from public.calendar_event_links l
        where l.connection_id = w.connection_id and l.calendar_id = w.calendar_id
          and l.environment = v_env and l.status <> 'unlinked'),
      'replacementDelivered', exists (
        select 1 from public.calendar_watch_channels o
        where o.connection_id = w.connection_id and o.calendar_id = w.calendar_id and o.id <> w.id
          and o.status = 'active' and o.sync_received_at is not null)
    ) as item
    from public.calendar_watch_channels w
    join public.calendar_connections c on c.id = w.connection_id
    where w.environment = v_env and w.status <> 'stopped'
      and (
        exists (select 1 from jsonb_array_elements(v_targets) t
                where (t ->> 'connectionId')::uuid = w.connection_id and t ->> 'calendarId' = w.calendar_id)
        or not exists (
          select 1 from public.calendar_event_links l
          where l.connection_id = w.connection_id and l.calendar_id = w.calendar_id
            and l.environment = v_env and l.status <> 'unlinked')
        or (w.expires_at is not null and w.expires_at <= now())
      )
    order by w.updated_at
    limit 200
  ) x;

  return jsonb_build_object('targets', v_targets, 'channels', v_channels);
end;
$body$;

revoke all on function public.claim_calendar_maintenance_batch(integer) from public;
grant execute on function public.claim_calendar_maintenance_batch(integer) to service_role;
revoke execute on function public.claim_calendar_maintenance_batch(integer) from anon, authenticated;

-- ---------------------------------------------------------------------
-- claim / reset / finish — uma sincronização por vez; o token só avança
-- no fim, e só por quem ainda detém a trava.
-- ---------------------------------------------------------------------

create function public.claim_calendar_sync(
  p_connection_id uuid,
  p_calendar_id text,
  p_actor_user_id uuid,
  p_lease_seconds integer default 120
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_conn public.calendar_connections := private.own_active_connection(p_connection_id, p_actor_user_id);
  v_state public.calendar_sync_state;
begin
  if p_calendar_id is null or btrim(p_calendar_id) = '' then
    raise exception 'calendar_id_required';
  end if;
  if p_lease_seconds is null or p_lease_seconds < 10 or p_lease_seconds > 900 then
    raise exception 'invalid_lease';
  end if;

  insert into public.calendar_sync_state (workspace_id, connection_id, environment, calendar_id)
  values (v_conn.workspace_id, v_conn.id, v_conn.environment, btrim(p_calendar_id))
  on conflict (connection_id, calendar_id) do nothing;

  -- Concessão atômica: quem não pega a trava não sincroniza.
  update public.calendar_sync_state
  set lease_id = gen_random_uuid(), lease_started_at = now(),
      lease_until = now() + make_interval(secs => p_lease_seconds), updated_at = now()
  where connection_id = v_conn.id and calendar_id = btrim(p_calendar_id)
    and (lease_until is null or lease_until < now())
  returning * into v_state;

  if v_state.id is null then
    return null;
  end if;
  return jsonb_build_object('leaseId', v_state.lease_id, 'syncToken', v_state.sync_token,
    'fullSyncAt', v_state.full_sync_at);
end;
$body$;

revoke all on function public.claim_calendar_sync(uuid, text, uuid, integer) from public;
grant execute on function public.claim_calendar_sync(uuid, text, uuid, integer) to service_role;
revoke execute on function public.claim_calendar_sync(uuid, text, uuid, integer) from anon, authenticated;

-- A trava AINDA é desta execução? Bloqueia a linha do estado (`for update`)
-- e só então confere dono, ambiente e validade (pelo relógio de agora, não
-- pelo início da transação). Com a linha bloqueada, nenhuma outra execução
-- toma a trava (claim espera) até o fim da transação de quem chamou: a
-- conferência e a escrita que vem depois são uma coisa só.
-- `null` = a trava não é mais desta execução (vencida ou tomada).
create function private.lock_sync_lease(p_lease_id uuid, p_actor_user_id uuid)
returns public.calendar_sync_state
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_env public.calendar_environment := private.require_request_environment();
  v_state public.calendar_sync_state;
  v_conn public.calendar_connections;
begin
  select * into v_state from public.calendar_sync_state s where s.lease_id = p_lease_id for update;
  if v_state.id is null then
    return null;
  end if;
  if v_state.environment <> v_env then
    raise exception 'calendar_environment_mismatch';
  end if;
  select * into v_conn from public.calendar_connections c where c.id = v_state.connection_id;
  if v_conn.user_id is distinct from p_actor_user_id then
    raise exception 'connection_not_found';
  end if;
  if v_state.lease_until is null or v_state.lease_until < clock_timestamp() then
    return null;
  end if;
  return v_state;
end;
$body$;

revoke all on function private.lock_sync_lease(uuid, uuid) from public, anon, authenticated;

-- 410: o token deixa de valer JÁ (uma falha na listagem completa não volta
-- a tentar o token inválido). A trava continua com quem a detém; quem a
-- perdeu não descarta nada (`false`).
create function public.reset_calendar_sync_token(p_lease_id uuid, p_actor_user_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_state public.calendar_sync_state := private.lock_sync_lease(p_lease_id, p_actor_user_id);
begin
  if v_state.id is null then
    return false;
  end if;
  update public.calendar_sync_state
  set sync_token = null, sync_token_at = null, last_error = 'sync_token_invalid', last_error_at = now(), updated_at = now()
  where id = v_state.id;

  insert into public.audit_logs (workspace_id, actor_user_id, action, resource_type, resource_id, metadata)
  values (v_state.workspace_id, p_actor_user_id, 'calendar.sync.token_reset', 'calendar_sync_state', v_state.id,
    jsonb_build_object('environment', v_state.environment));
  return true;
end;
$body$;

revoke all on function public.reset_calendar_sync_token(uuid, uuid) from public;
grant execute on function public.reset_calendar_sync_token(uuid, uuid) to service_role;
revoke execute on function public.reset_calendar_sync_token(uuid, uuid) from anon, authenticated;

-- p_outcome:
--  success      — todas as páginas processadas: grava o NOVO token;
--  failed       — mantém o token anterior (a execução é refeita);
--  access_lost  — idem, e os vínculos da agenda viram pendência explícita.
create function public.finish_calendar_sync(
  p_lease_id uuid,
  p_actor_user_id uuid,
  p_outcome text,
  p_sync_token text,
  p_full boolean,
  p_error text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_state public.calendar_sync_state;
begin
  if p_outcome not in ('success', 'failed', 'access_lost') then
    raise exception 'invalid_outcome';
  end if;
  v_state := private.lock_sync_lease(p_lease_id, p_actor_user_id);
  -- Trava perdida (vencida e/ou tomada por outra execução): nada é gravado.
  if v_state.id is null then
    return false;
  end if;

  if p_outcome = 'success' then
    if p_sync_token is null or btrim(p_sync_token) = '' then
      raise exception 'sync_token_required';
    end if;
    update public.calendar_sync_state
    set sync_token = p_sync_token, sync_token_at = now(), last_run_at = now(),
        full_sync_at = case when coalesce(p_full, false) then now() else full_sync_at end,
        last_error = null, last_error_at = null,
        -- A dica só se apaga se veio ANTES desta execução começar.
        dirty_at = case when dirty_at is not null and dirty_at < lease_started_at then null else dirty_at end,
        lease_id = null, lease_started_at = null, lease_until = null, updated_at = now()
    where id = v_state.id;

    -- A listagem funcionou: o acesso à agenda está de volta. Vínculos que
    -- estavam pendentes por perda de acesso voltam a `linked`.
    update public.calendar_event_links
    set status = 'linked', updated_at = now()
    where connection_id = v_state.connection_id and calendar_id = v_state.calendar_id
      and environment = v_state.environment and status = 'needs_attention' and sync_error = 'calendar_access_lost';
  else
    update public.calendar_sync_state
    set last_error = left(coalesce(nullif(p_error, ''), p_outcome), 100), last_error_at = now(),
        lease_id = null, lease_started_at = null, lease_until = null, updated_at = now()
    where id = v_state.id;

    if p_outcome = 'access_lost' then
      update public.calendar_event_links
      set status = 'needs_attention', sync_state = 'pending', sync_error = 'calendar_access_lost',
          sync_state_at = now(), updated_at = now()
      where connection_id = v_state.connection_id and calendar_id = v_state.calendar_id
        and environment = v_state.environment and status = 'linked';
    end if;
  end if;

  insert into public.audit_logs (workspace_id, actor_user_id, action, resource_type, resource_id, metadata)
  values (v_state.workspace_id, p_actor_user_id, 'calendar.sync.' || p_outcome, 'calendar_sync_state', v_state.id,
    jsonb_build_object('environment', v_state.environment, 'full', coalesce(p_full, false),
      'reason', left(nullif(p_error, ''), 100)));
  return true;
end;
$body$;

revoke all on function public.finish_calendar_sync(uuid, uuid, text, text, boolean, text) from public;
grant execute on function public.finish_calendar_sync(uuid, uuid, text, text, boolean, text) to service_role;
revoke execute on function public.finish_calendar_sync(uuid, uuid, text, text, boolean, text) from anon, authenticated;

-- ---------------------------------------------------------------------
-- list_calendar_links_for_sync — os vínculos da agenda (do ambiente e da
-- conexão), com a base e a atividade atual. É contra esta lista que cada
-- item da listagem é reconhecido; o resto é descartado em memória.
-- ---------------------------------------------------------------------

create function public.list_calendar_links_for_sync(p_connection_id uuid, p_calendar_id text, p_actor_user_id uuid)
returns jsonb
language plpgsql
security definer
stable
set search_path = ''
as $body$
declare
  v_conn public.calendar_connections := private.own_active_connection(p_connection_id, p_actor_user_id);
begin
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', l.id,
      'activityId', l.activity_id,
      'connectionId', l.connection_id,
      'environment', l.environment,
      'calendarId', l.calendar_id,
      'eventId', l.event_id,
      'status', l.status,
      'durationMinutes', l.duration_minutes,
      'baseEtag', l.base_etag,
      'baseTitle', l.base_title,
      'baseStart', l.base_start,
      'baseEnd', l.base_end,
      'baseCancelled', l.base_cancelled,
      'baseHasMeet', l.base_has_meet,
      'meetStatus', l.meet_status,
      'meetUrl', l.meet_url,
      'activity', case when a.id is null then null else jsonb_build_object(
        'title', a.title, 'dueAt', a.due_at, 'hasTime', a.has_time, 'type', a.type, 'lockVersion', a.lock_version) end
    ))
    from public.calendar_event_links l
    left join public.activities a on a.id = l.activity_id
    where l.connection_id = v_conn.id and l.calendar_id = btrim(p_calendar_id)
      and l.environment = v_conn.environment and l.status <> 'unlinked'
  ), '[]'::jsonb);
end;
$body$;

revoke all on function public.list_calendar_links_for_sync(uuid, text, uuid) from public;
grant execute on function public.list_calendar_links_for_sync(uuid, text, uuid) to service_role;
revoke execute on function public.list_calendar_links_for_sync(uuid, text, uuid) from anon, authenticated;

-- ---------------------------------------------------------------------
-- apply_google_inbound_change — mudança do Google aplicada ao CRM.
--
-- p_state: { etag, title, start, end, cancelled, hasMeet, meetStatus,
-- meetUrl, durationMinutes, linkStatus, changed[] }. Nos campos do Meet,
-- chave ausente preserva e null remove (mesma regra da etapa 2).
--
-- p_lease_id: a trava da execução. Antes de qualquer escrita, a linha do
-- estado é BLOQUEADA e a trava conferida (desta execução, desta conexão e
-- agenda, ainda válida); o bloqueio dura até o fim desta transação, então
-- nenhuma outra execução assume no meio. Ordem de bloqueio: estado, depois
-- vínculo (a mesma de `finish_calendar_sync`), sem impasse entre as duas.
-- Devolve { status: applied | stale_link | stale_activity | not_authorized
-- | lease_lost }.
-- ---------------------------------------------------------------------

create function public.apply_google_inbound_change(
  p_link_id uuid,
  p_actor_user_id uuid,
  p_lease_id uuid,
  p_expected_base_etag text,
  p_expected_version bigint,
  p_title text,
  p_due_at timestamptz,
  p_conflicts jsonb,
  p_state jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_env public.calendar_environment := private.require_request_environment();
  v_lease public.calendar_sync_state;
  v_link public.calendar_event_links;
  v_conn public.calendar_connections;
  v_activity public.activities;
  v_lead public.leads;
  v_role public.membership_role;
  v_version bigint;
  v_conflict jsonb;
  v_status public.calendar_link_status;
begin
  -- 1) A trava (linha do estado bloqueada até o fim da transação).
  v_lease := private.lock_sync_lease(p_lease_id, p_actor_user_id);

  -- 2) O vínculo.
  select * into v_link from public.calendar_event_links l where l.id = p_link_id for update;
  if v_link.id is null or v_link.status = 'unlinked' then
    raise exception 'link_not_found';
  end if;
  if v_link.environment <> v_env then
    raise exception 'calendar_environment_mismatch';
  end if;
  select * into v_conn from public.calendar_connections c where c.id = v_link.connection_id;
  -- Só a conexão dona do vínculo, ativa, aplica o que veio da agenda dela.
  if v_conn.user_id is distinct from p_actor_user_id or v_conn.status <> 'active' then
    raise exception 'connection_not_found';
  end if;

  -- A trava tem de ser desta conexão e agenda. Sem ela, nada é gravado:
  -- nem atividade, nem vínculo, nem conflito, nem auditoria.
  if v_lease.id is null or v_lease.connection_id <> v_link.connection_id or v_lease.calendar_id <> v_link.calendar_id then
    return jsonb_build_object('status', 'lease_lost');
  end if;

  -- A base mudou desde a leitura (outra operação gravou): o chamador relê.
  if v_link.base_etag is distinct from p_expected_base_etag then
    return jsonb_build_object('status', 'stale_link');
  end if;

  v_status := coalesce(nullif(p_state ->> 'linkStatus', ''), 'linked')::public.calendar_link_status;

  if v_link.activity_id is not null then
    select * into v_activity from public.activities a where a.id = v_link.activity_id;
    select role into v_role from public.memberships m
    where m.workspace_id = v_activity.workspace_id and m.user_id = p_actor_user_id and m.status = 'active';
    select * into v_lead from public.leads ld where ld.id = v_activity.lead_id;

    -- Mesma regra de activity.edit + alcance por lead. Sem ela, nada da
    -- agenda é aplicado: o vínculo fica para atenção (não é erro silencioso).
    if v_role is null or v_role not in ('owner', 'admin', 'manager', 'lawyer', 'sales')
       or not private.lead_accessible_to_role(v_role, v_lead.assigned_to, p_actor_user_id) then
      update public.calendar_event_links
      set status = 'needs_attention', sync_state = 'failed', sync_error = 'owner_lost_access',
          sync_state_at = now(), updated_at = now()
      where id = v_link.id;
      insert into public.audit_logs (workspace_id, actor_user_id, action, resource_type, resource_id, metadata)
      values (v_link.workspace_id, p_actor_user_id, 'calendar.inbound.not_authorized', 'calendar_event_link', v_link.id,
        jsonb_build_object('environment', v_env, 'activity_id', v_link.activity_id));
      return jsonb_build_object('status', 'not_authorized');
    end if;

    if p_expected_version is distinct from v_activity.lock_version then
      return jsonb_build_object('status', 'stale_activity');
    end if;
    v_version := v_activity.lock_version;

    if nullif(btrim(p_title), '') is not null or p_due_at is not null then
      -- Passa pelo gatilho de ambiente como qualquer alteração.
      update public.activities set
        title = coalesce(nullif(btrim(p_title), ''), title),
        due_at = coalesce(p_due_at, due_at),
        has_time = case when p_due_at is not null then true else has_time end,
        lock_version = lock_version + 1,
        updated_at = now()
      where id = v_activity.id and lock_version = p_expected_version
      returning lock_version into v_version;
      if v_version is null then
        return jsonb_build_object('status', 'stale_activity');
      end if;
    end if;
  end if;

  -- O valor do CRM que perdeu: gravado na MESMA transação.
  for v_conflict in
    select c.value from jsonb_array_elements(coalesce(p_conflicts, '[]'::jsonb)) as c(value)
  loop
    insert into public.calendar_sync_conflicts (workspace_id, link_id, environment, field, crm_value, google_value, resolution, created_by)
    values (v_link.workspace_id, v_link.id, v_env, v_conflict ->> 'field', v_conflict -> 'crmValue', v_conflict -> 'googleValue',
      'google_prevails', p_actor_user_id);
    insert into public.audit_logs (workspace_id, actor_user_id, action, resource_type, resource_id, metadata)
    values (v_link.workspace_id, p_actor_user_id, 'calendar.conflict.recorded', 'calendar_event_link', v_link.id,
      jsonb_build_object('environment', v_env, 'field', v_conflict ->> 'field', 'resolution', 'google_prevails'));
  end loop;

  update public.calendar_event_links set
    status = v_status,
    duration_minutes = coalesce((p_state ->> 'durationMinutes')::integer, duration_minutes),
    base_etag = p_state ->> 'etag',
    base_title = p_state ->> 'title',
    base_start = (p_state ->> 'start')::timestamptz,
    base_end = (p_state ->> 'end')::timestamptz,
    base_cancelled = coalesce((p_state ->> 'cancelled')::boolean, false),
    base_has_meet = coalesce((p_state ->> 'hasMeet')::boolean, false),
    base_crm_version = coalesce(v_version, base_crm_version),
    meet_status = case when p_state ? 'meetStatus' then p_state ->> 'meetStatus' else meet_status end,
    meet_url = case when p_state ? 'meetUrl' then p_state ->> 'meetUrl' else meet_url end,
    last_synced_at = now(),
    updated_at = now()
  where id = v_link.id;

  -- A auditoria guarda só os NOMES dos campos que mudaram, nunca valores.
  insert into public.audit_logs (workspace_id, actor_user_id, action, resource_type, resource_id, metadata)
  values (v_link.workspace_id, p_actor_user_id, 'calendar.inbound.applied', 'calendar_event_link', v_link.id,
    jsonb_build_object('environment', v_env, 'activity_id', v_link.activity_id, 'link_status', v_status,
      'changed', coalesce(p_state -> 'changed', '[]'::jsonb)));

  return jsonb_build_object('status', 'applied', 'lockVersion', v_version);
end;
$body$;

revoke all on function public.apply_google_inbound_change(uuid, uuid, uuid, text, bigint, text, timestamptz, jsonb, jsonb) from public;
grant execute on function public.apply_google_inbound_change(uuid, uuid, uuid, text, bigint, text, timestamptz, jsonb, jsonb) to service_role;
revoke execute on function public.apply_google_inbound_change(uuid, uuid, uuid, text, bigint, text, timestamptz, jsonb, jsonb) from anon, authenticated;

-- ---------------------------------------------------------------------
-- Conexão a reautorizar (o refresh token deixou de valer).
-- ---------------------------------------------------------------------

create function public.mark_calendar_connection_needs_reauth(p_connection_id uuid, p_actor_user_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_env public.calendar_environment := private.require_request_environment();
  v_conn public.calendar_connections;
begin
  select * into v_conn from public.calendar_connections c where c.id = p_connection_id;
  if v_conn.id is null or v_conn.user_id is distinct from p_actor_user_id or v_conn.status = 'disconnected' then
    raise exception 'connection_not_found';
  end if;
  if v_conn.environment <> v_env then
    raise exception 'calendar_environment_mismatch';
  end if;
  if v_conn.status = 'needs_reauth' then
    return;
  end if;

  update public.calendar_connections set status = 'needs_reauth', updated_at = now() where id = v_conn.id;
  insert into public.audit_logs (workspace_id, actor_user_id, action, resource_type, resource_id, metadata)
  values (v_conn.workspace_id, p_actor_user_id, 'calendar.connection.needs_reauth', 'calendar_connection', v_conn.id,
    jsonb_build_object('environment', v_env, 'reason', left(p_reason, 100)));
end;
$body$;

revoke all on function public.mark_calendar_connection_needs_reauth(uuid, uuid, text) from public;
grant execute on function public.mark_calendar_connection_needs_reauth(uuid, uuid, text) to service_role;
revoke execute on function public.mark_calendar_connection_needs_reauth(uuid, uuid, text) from anon, authenticated;

-- ---------------------------------------------------------------------
-- Canais: criar (linha ANTES da chamada), ativar, travar renovação, parar.
-- ---------------------------------------------------------------------

create function public.begin_calendar_channel(
  p_connection_id uuid,
  p_calendar_id text,
  p_actor_user_id uuid,
  p_channel_id text,
  p_token_hash text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_conn public.calendar_connections := private.own_active_connection(p_connection_id, p_actor_user_id);
  v_id uuid;
begin
  if p_calendar_id is null or btrim(p_calendar_id) = '' then
    raise exception 'calendar_id_required';
  end if;
  insert into public.calendar_watch_channels (workspace_id, connection_id, environment, calendar_id, channel_id, token_hash)
  values (v_conn.workspace_id, v_conn.id, v_conn.environment, btrim(p_calendar_id), p_channel_id, lower(p_token_hash))
  returning id into v_id;
  return v_id;
end;
$body$;

revoke all on function public.begin_calendar_channel(uuid, text, uuid, text, text) from public;
grant execute on function public.begin_calendar_channel(uuid, text, uuid, text, text) to service_role;
revoke execute on function public.begin_calendar_channel(uuid, text, uuid, text, text) from anon, authenticated;

-- Canal do ator, do ambiente autenticado.
create function private.own_channel(p_channel_id text, p_actor_user_id uuid)
returns public.calendar_watch_channels
language plpgsql
stable
security definer
set search_path = ''
as $body$
declare
  v_env public.calendar_environment := private.require_request_environment();
  v_channel public.calendar_watch_channels;
  v_conn public.calendar_connections;
begin
  select * into v_channel from public.calendar_watch_channels w where w.channel_id = p_channel_id;
  if v_channel.id is null then
    raise exception 'channel_not_found';
  end if;
  if v_channel.environment <> v_env then
    raise exception 'calendar_environment_mismatch';
  end if;
  select * into v_conn from public.calendar_connections c where c.id = v_channel.connection_id;
  if v_conn.user_id is distinct from p_actor_user_id then
    raise exception 'channel_not_found';
  end if;
  return v_channel;
end;
$body$;

revoke all on function private.own_channel(text, uuid) from public, anon, authenticated;

-- Ativa o canal novo e manda o anterior da mesma agenda para `retiring`
-- (ele só é parado depois que o novo entregar a primeira mensagem).
create function public.activate_calendar_channel(
  p_channel_id text,
  p_actor_user_id uuid,
  p_resource_id text,
  p_expires_at timestamptz,
  p_renew_at timestamptz,
  p_polling_only boolean
)
returns void
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_channel public.calendar_watch_channels := private.own_channel(p_channel_id, p_actor_user_id);
begin
  if v_channel.status not in ('creating', 'active') then
    raise exception 'channel_not_creating';
  end if;
  if p_resource_id is null or p_expires_at is null then
    raise exception 'channel_details_required';
  end if;

  update public.calendar_watch_channels
  set status = case when coalesce(p_polling_only, false) then 'polling_only' else 'active' end,
      resource_id = p_resource_id, expires_at = p_expires_at,
      renew_at = case when coalesce(p_polling_only, false) then null else p_renew_at end,
      renewing_until = null, updated_at = now()
  where id = v_channel.id;

  if not coalesce(p_polling_only, false) then
    update public.calendar_watch_channels
    set status = 'retiring', updated_at = now()
    where connection_id = v_channel.connection_id and calendar_id = v_channel.calendar_id
      and id <> v_channel.id and status = 'active';
  end if;

  insert into public.audit_logs (workspace_id, actor_user_id, action, resource_type, resource_id, metadata)
  values (v_channel.workspace_id, p_actor_user_id,
    case when coalesce(p_polling_only, false) then 'calendar.channel.polling_only' else 'calendar.channel.active' end,
    'calendar_watch_channel', v_channel.id,
    jsonb_build_object('environment', v_channel.environment, 'expires_at', p_expires_at));
end;
$body$;

revoke all on function public.activate_calendar_channel(text, uuid, text, timestamptz, timestamptz, boolean) from public;
grant execute on function public.activate_calendar_channel(text, uuid, text, timestamptz, timestamptz, boolean) to service_role;
revoke execute on function public.activate_calendar_channel(text, uuid, text, timestamptz, timestamptz, boolean) from anon, authenticated;

-- Trava de renovação: duas execuções simultâneas nunca renovam o mesmo canal.
create function public.claim_calendar_channel_renewal(p_channel_id text, p_actor_user_id uuid, p_lock_seconds integer default 120)
returns boolean
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_channel public.calendar_watch_channels := private.own_channel(p_channel_id, p_actor_user_id);
  v_id uuid;
begin
  update public.calendar_watch_channels
  set renewing_until = now() + make_interval(secs => greatest(10, least(coalesce(p_lock_seconds, 120), 900))), updated_at = now()
  where id = v_channel.id and status = 'active' and renew_at <= now()
    and (renewing_until is null or renewing_until < now())
  returning id into v_id;
  return v_id is not null;
end;
$body$;

revoke all on function public.claim_calendar_channel_renewal(text, uuid, integer) from public;
grant execute on function public.claim_calendar_channel_renewal(text, uuid, integer) to service_role;
revoke execute on function public.claim_calendar_channel_renewal(text, uuid, integer) from anon, authenticated;

create function public.stop_calendar_channel(p_channel_id text, p_actor_user_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_channel public.calendar_watch_channels := private.own_channel(p_channel_id, p_actor_user_id);
begin
  if v_channel.status = 'stopped' then
    return;
  end if;
  update public.calendar_watch_channels
  set status = 'stopped', stopped_at = now(), stop_reason = left(p_reason, 100), renewing_until = null, updated_at = now()
  where id = v_channel.id;
  insert into public.audit_logs (workspace_id, actor_user_id, action, resource_type, resource_id, metadata)
  values (v_channel.workspace_id, p_actor_user_id, 'calendar.channel.stopped', 'calendar_watch_channel', v_channel.id,
    jsonb_build_object('environment', v_channel.environment, 'reason', left(p_reason, 100)));
end;
$body$;

revoke all on function public.stop_calendar_channel(text, uuid, text) from public;
grant execute on function public.stop_calendar_channel(text, uuid, text) to service_role;
revoke execute on function public.stop_calendar_channel(text, uuid, text) from anon, authenticated;

-- ---------------------------------------------------------------------
-- record_calendar_notification — o webhook. Sem ator (quem chama é o
-- Google). Só canal conhecido DO AMBIENTE, com o segredo certo e, quando já
-- conhecido, o mesmo recurso. A notificação não tem corpo: ela só marca a
-- agenda para sincronizar ("dica"); nada é lido do Google aqui.
-- Devolve accepted | ignored (canal encerrado) | rejected.
-- ---------------------------------------------------------------------

create function public.record_calendar_notification(
  p_channel_id text,
  p_token_hash text,
  p_resource_id text,
  p_resource_state text,
  p_message_number bigint,
  p_expires_at timestamptz
)
returns text
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_env public.calendar_environment := private.require_request_environment();
  v_channel public.calendar_watch_channels;
begin
  select * into v_channel from public.calendar_watch_channels w where w.channel_id = p_channel_id for update;
  -- Canal de outro ambiente é tratado como desconhecido (nada é revelado).
  if v_channel.id is null or v_channel.environment <> v_env then
    return 'rejected';
  end if;
  if p_token_hash is null or lower(p_token_hash) <> v_channel.token_hash then
    return 'rejected';
  end if;
  if v_channel.resource_id is not null and p_resource_id is distinct from v_channel.resource_id then
    return 'rejected';
  end if;
  if v_channel.status in ('stopped', 'polling_only') then
    return 'ignored';
  end if;

  update public.calendar_watch_channels
  set resource_id = coalesce(resource_id, p_resource_id),
      -- Canal ainda `creating` (resposta do watch perdida): a primeira
      -- mensagem traz o recurso e a validade, e a manutenção o ativa.
      expires_at = coalesce(expires_at, p_expires_at),
      sync_received_at = case when p_resource_state = 'sync' then coalesce(sync_received_at, now()) else sync_received_at end,
      last_message_number = greatest(coalesce(last_message_number, 0), coalesce(p_message_number, 0)),
      last_notified_at = now(),
      updated_at = now()
  where id = v_channel.id;

  if p_resource_state <> 'sync' then
    update public.calendar_sync_state
    set dirty_at = now(), updated_at = now()
    where connection_id = v_channel.connection_id and calendar_id = v_channel.calendar_id;
    if not found then
      insert into public.calendar_sync_state (workspace_id, connection_id, environment, calendar_id, dirty_at)
      values (v_channel.workspace_id, v_channel.connection_id, v_channel.environment, v_channel.calendar_id, now())
      on conflict (connection_id, calendar_id) do update set dirty_at = now(), updated_at = now();
    end if;
  end if;
  return 'accepted';
end;
$body$;

revoke all on function public.record_calendar_notification(text, text, text, text, bigint, timestamptz) from public;
grant execute on function public.record_calendar_notification(text, text, text, text, bigint, timestamptz) to service_role;
revoke execute on function public.record_calendar_notification(text, text, text, text, bigint, timestamptz) from anon, authenticated;

-- ---------------------------------------------------------------------
-- Desconectar também encerra os canais e o estado de sincronização
-- (§6.5). Continua sem apagar evento do Google nem atividade do CRM.
-- ---------------------------------------------------------------------

create or replace function public.disconnect_calendar_connection(p_connection_id uuid, p_actor_user_id uuid)
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

  -- Canais deixam de ser aceitos pelo webhook (o encerramento no Google é
  -- feito pela aplicação antes, enquanto ainda há token).
  update public.calendar_watch_channels
  set status = 'stopped', stopped_at = now(), stop_reason = 'disconnected', renewing_until = null, updated_at = now()
  where connection_id = v_conn.id and status <> 'stopped';

  update public.calendar_sync_state
  set sync_token = null, sync_token_at = null, dirty_at = null,
      lease_id = null, lease_started_at = null, lease_until = null, updated_at = now()
  where connection_id = v_conn.id;

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

-- Canais vivos da PRÓPRIA conexão (para encerrá-los no Google antes de
-- desconectar). Sem hash de segredo.
create function public.list_own_calendar_channels(p_connection_id uuid, p_actor_user_id uuid)
returns jsonb
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
  if v_conn.id is null or v_conn.user_id is distinct from p_actor_user_id or v_conn.status = 'disconnected' then
    raise exception 'connection_not_found';
  end if;
  if v_conn.environment <> v_env then
    raise exception 'calendar_environment_mismatch';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('channelId', w.channel_id, 'resourceId', w.resource_id, 'status', w.status))
    from public.calendar_watch_channels w
    where w.connection_id = v_conn.id and w.status in ('creating', 'active', 'retiring') and w.resource_id is not null
  ), '[]'::jsonb);
end;
$body$;

revoke all on function public.list_own_calendar_channels(uuid, uuid) from public;
grant execute on function public.list_own_calendar_channels(uuid, uuid) to service_role;
revoke execute on function public.list_own_calendar_channels(uuid, uuid) from anon, authenticated;
