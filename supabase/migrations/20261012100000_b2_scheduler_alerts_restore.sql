-- B2, etapa 3b (docs/decisoes/b2-google-agenda.md §6.11, §9.2, §9.3).
--
-- 1) Batimento dos agendadores (`calendar_scheduler_heartbeats`): cada
--    rodada da manutenção grava quando rodou e só CONTAGENS.
-- 2) Alertas de agendador parado (`calendar_scheduler_alerts`): reserva
--    atômica com intervalo mínimo entre alertas, destinatários = owner/admin
--    dos workspaces com vínculo ativo no ambiente. O ENVIO é decidido pela
--    aplicação e fica desligado por padrão (CALENDAR_ALERTS_ENABLED).
-- 3) Saúde da sincronização para a tela (owner/admin): batimento e canais
--    com pouca vida do workspace (Detector 2, §9.3).
-- 4) Agendas da própria conexão para a sincronização sob demanda.
-- 5) Reconexão: vínculos desfeitos por uma desconexão ANTERIOR do mesmo
--    usuário são reencontrados (o evento é conferido no Google pela marca
--    antes) e voltam para a conexão nova, com a base preservada.
-- 6) Restauração do valor do CRM que perdeu num conflito, e conflito e
--    restauração na timeline do lead.
--
-- Não é aplicada ao banco hospedado sem autorização à parte.

-- ---------------------------------------------------------------------
-- 1) Batimento
-- ---------------------------------------------------------------------

create table public.calendar_scheduler_heartbeats (
  id uuid primary key default gen_random_uuid(),
  environment public.calendar_environment not null,
  -- inngest = principal; github = recuperação adicional; manual = chamada
  -- avulsa ao endpoint (teste, operação).
  scheduler text not null check (scheduler in ('inngest', 'github', 'manual')),
  last_run_at timestamptz not null,
  last_outcome text not null check (last_outcome in ('ok', 'failed')),
  -- Só contagens (números), nunca conteúdo de evento.
  last_report jsonb not null default '{}'::jsonb,
  runs bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint calendar_scheduler_heartbeats_key unique (environment, scheduler)
);

alter table public.calendar_scheduler_heartbeats enable row level security;
alter table public.calendar_scheduler_heartbeats force row level security;
create policy calendar_scheduler_heartbeats_select_deny on public.calendar_scheduler_heartbeats for select to authenticated using (false);
create policy calendar_scheduler_heartbeats_insert_deny on public.calendar_scheduler_heartbeats for insert to authenticated with check (false);
create policy calendar_scheduler_heartbeats_update_deny on public.calendar_scheduler_heartbeats for update to authenticated using (false);
create policy calendar_scheduler_heartbeats_delete_deny on public.calendar_scheduler_heartbeats for delete to authenticated using (false);
revoke all on table public.calendar_scheduler_heartbeats from public, anon, authenticated;

create function public.record_calendar_scheduler_heartbeat(p_scheduler text, p_outcome text, p_report jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_env public.calendar_environment := private.require_request_environment();
  v_report jsonb;
begin
  if p_scheduler is null or p_scheduler not in ('inngest', 'github', 'manual') then
    raise exception 'invalid_scheduler';
  end if;
  if p_outcome is null or p_outcome not in ('ok', 'failed') then
    raise exception 'invalid_outcome';
  end if;
  -- Só pares nome → número, no máximo 30: nada de texto livre no batimento.
  select coalesce(jsonb_object_agg(e.key, e.value), '{}'::jsonb) into v_report
  from (
    select key, value from jsonb_each(coalesce(p_report, '{}'::jsonb))
    where jsonb_typeof(value) = 'number' and key ~ '^[A-Za-z]{1,40}$'
    order by key limit 30
  ) e;

  insert into public.calendar_scheduler_heartbeats (environment, scheduler, last_run_at, last_outcome, last_report)
  values (v_env, p_scheduler, now(), p_outcome, v_report)
  on conflict (environment, scheduler) do update
    set last_run_at = now(), last_outcome = excluded.last_outcome, last_report = excluded.last_report,
        runs = public.calendar_scheduler_heartbeats.runs + 1, updated_at = now();
end;
$body$;

revoke all on function public.record_calendar_scheduler_heartbeat(text, text, jsonb) from public;
grant execute on function public.record_calendar_scheduler_heartbeat(text, text, jsonb) to service_role;
revoke execute on function public.record_calendar_scheduler_heartbeat(text, text, jsonb) from anon, authenticated;

-- Batimentos do ambiente (para o Detector 1, rodado pela recuperação adicional).
create function public.list_calendar_scheduler_heartbeats()
returns jsonb
language plpgsql
security definer
stable
set search_path = ''
as $body$
declare
  v_env public.calendar_environment := private.require_request_environment();
begin
  return coalesce((
    select jsonb_agg(jsonb_build_object('scheduler', h.scheduler, 'lastRunAt', h.last_run_at, 'lastOutcome', h.last_outcome)
      order by h.scheduler)
    from public.calendar_scheduler_heartbeats h
    where h.environment = v_env
  ), '[]'::jsonb);
end;
$body$;

revoke all on function public.list_calendar_scheduler_heartbeats() from public;
grant execute on function public.list_calendar_scheduler_heartbeats() to service_role;
revoke execute on function public.list_calendar_scheduler_heartbeats() from anon, authenticated;

-- ---------------------------------------------------------------------
-- 2) Alertas de agendador parado
-- ---------------------------------------------------------------------

create table public.calendar_scheduler_alerts (
  id uuid primary key default gen_random_uuid(),
  environment public.calendar_environment not null,
  kind text not null check (kind in ('scheduler_stale')),
  scheduler text not null check (scheduler in ('inngest', 'github', 'manual')),
  status text not null default 'claimed' check (status in ('claimed', 'sent', 'failed')),
  recipients integer not null default 0 check (recipients >= 0),
  error text check (error is null or char_length(error) <= 100),
  created_at timestamptz not null default now(),
  finished_at timestamptz
);

create index calendar_scheduler_alerts_recent_idx on public.calendar_scheduler_alerts (environment, kind, scheduler, created_at desc);

alter table public.calendar_scheduler_alerts enable row level security;
alter table public.calendar_scheduler_alerts force row level security;
create policy calendar_scheduler_alerts_select_deny on public.calendar_scheduler_alerts for select to authenticated using (false);
create policy calendar_scheduler_alerts_insert_deny on public.calendar_scheduler_alerts for insert to authenticated with check (false);
create policy calendar_scheduler_alerts_update_deny on public.calendar_scheduler_alerts for update to authenticated using (false);
create policy calendar_scheduler_alerts_delete_deny on public.calendar_scheduler_alerts for delete to authenticated using (false);
revoke all on table public.calendar_scheduler_alerts from public, anon, authenticated;

-- Reserva UM alerta por (ambiente, tipo, agendador) a cada `p_cooldown_minutes`
-- (mínimo 60). Duas chamadas simultâneas não reservam duas vezes (bloqueio
-- consultivo por transação). Devolve null quando ainda está no intervalo;
-- senão { alertId, recipients: [{ email }] } — owner/admin ativos dos
-- workspaces com vínculo ativo no ambiente.
create function public.claim_calendar_scheduler_alert(p_kind text, p_scheduler text, p_cooldown_minutes integer default 360)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_env public.calendar_environment := private.require_request_environment();
  v_cooldown integer := greatest(60, least(coalesce(p_cooldown_minutes, 360), 10080));
  v_id uuid;
  v_recipients jsonb;
begin
  if p_kind is null or p_kind not in ('scheduler_stale') then
    raise exception 'invalid_alert_kind';
  end if;
  if p_scheduler is null or p_scheduler not in ('inngest', 'github', 'manual') then
    raise exception 'invalid_scheduler';
  end if;

  perform pg_advisory_xact_lock(hashtext('calendar_scheduler_alert:' || v_env || ':' || p_kind || ':' || p_scheduler));

  if exists (
    select 1 from public.calendar_scheduler_alerts a
    where a.environment = v_env and a.kind = p_kind and a.scheduler = p_scheduler
      and a.status <> 'failed' and a.created_at > now() - make_interval(mins => v_cooldown)
  ) then
    return null;
  end if;

  select coalesce(jsonb_agg(distinct jsonb_build_object('email', u.email)), '[]'::jsonb) into v_recipients
  from public.memberships m
  join public.users u on u.id = m.user_id
  where m.status = 'active' and m.role in ('owner', 'admin')
    and exists (
      select 1 from public.calendar_event_links l
      where l.workspace_id = m.workspace_id and l.environment = v_env and l.status <> 'unlinked');

  insert into public.calendar_scheduler_alerts (environment, kind, scheduler, recipients)
  values (v_env, p_kind, p_scheduler, jsonb_array_length(v_recipients))
  returning id into v_id;

  return jsonb_build_object('alertId', v_id, 'recipients', v_recipients);
end;
$body$;

revoke all on function public.claim_calendar_scheduler_alert(text, text, integer) from public;
grant execute on function public.claim_calendar_scheduler_alert(text, text, integer) to service_role;
revoke execute on function public.claim_calendar_scheduler_alert(text, text, integer) from anon, authenticated;

create function public.finish_calendar_scheduler_alert(p_alert_id uuid, p_status text, p_error text)
returns void
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_env public.calendar_environment := private.require_request_environment();
begin
  if p_status is null or p_status not in ('sent', 'failed') then
    raise exception 'invalid_status';
  end if;
  update public.calendar_scheduler_alerts
  set status = p_status, error = left(nullif(p_error, ''), 100), finished_at = now()
  where id = p_alert_id and environment = v_env and status = 'claimed';
end;
$body$;

revoke all on function public.finish_calendar_scheduler_alert(uuid, text, text) from public;
grant execute on function public.finish_calendar_scheduler_alert(uuid, text, text) to service_role;
revoke execute on function public.finish_calendar_scheduler_alert(uuid, text, text) from anon, authenticated;

-- ---------------------------------------------------------------------
-- 3) Saúde da sincronização (Detector 2) — owner/admin do workspace, pela
--    SESSÃO, no ambiente autenticado. Só datas e contagens.
-- ---------------------------------------------------------------------

create function public.get_calendar_sync_health(p_workspace_id uuid)
returns jsonb
language plpgsql
security definer
stable
set search_path = ''
as $body$
declare
  v_env public.calendar_environment := private.require_request_environment();
begin
  -- calendar.manage (src/lib/roles.ts).
  if not private.has_workspace_role(p_workspace_id, array['owner', 'admin']::public.membership_role[]) then
    raise exception 'insufficient_permission';
  end if;

  return jsonb_build_object(
    'schedulers', coalesce((
      select jsonb_agg(jsonb_build_object('scheduler', h.scheduler, 'lastRunAt', h.last_run_at, 'lastOutcome', h.last_outcome)
        order by h.scheduler)
      from public.calendar_scheduler_heartbeats h where h.environment = v_env
    ), '[]'::jsonb),
    'activeLinks', (
      select count(*) from public.calendar_event_links l
      where l.workspace_id = p_workspace_id and l.environment = v_env and l.status <> 'unlinked'),
    -- Canal ativo com menos de 25% da vida (§9.4) ou já vencido.
    'channelsLowLife', (
      select count(*) from public.calendar_watch_channels w
      where w.workspace_id = p_workspace_id and w.environment = v_env and w.status = 'active'
        and w.expires_at is not null
        and (w.expires_at - now()) < (w.expires_at - w.created_at) * 0.25)
  );
end;
$body$;

revoke all on function public.get_calendar_sync_health(uuid) from public;
grant execute on function public.get_calendar_sync_health(uuid) to authenticated;
revoke execute on function public.get_calendar_sync_health(uuid) from anon;

-- ---------------------------------------------------------------------
-- 4) Sincronização sob demanda: as agendas da PRÓPRIA conexão com vínculo
--    ativo, com a última execução.
-- ---------------------------------------------------------------------

create function public.list_own_calendar_sync_targets(p_connection_id uuid, p_actor_user_id uuid)
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
    select jsonb_agg(jsonb_build_object('calendarId', t.calendar_id, 'lastRunAt', s.last_run_at, 'leaseUntil', s.lease_until)
      order by t.calendar_id)
    from (
      select distinct l.calendar_id from public.calendar_event_links l
      where l.connection_id = v_conn.id and l.environment = v_conn.environment and l.status <> 'unlinked'
    ) t
    left join public.calendar_sync_state s on s.connection_id = v_conn.id and s.calendar_id = t.calendar_id
  ), '[]'::jsonb);
end;
$body$;

revoke all on function public.list_own_calendar_sync_targets(uuid, uuid) from public;
grant execute on function public.list_own_calendar_sync_targets(uuid, uuid) to service_role;
revoke execute on function public.list_own_calendar_sync_targets(uuid, uuid) from anon, authenticated;

-- ---------------------------------------------------------------------
-- 5) Reconexão: reencontrar vínculos
-- ---------------------------------------------------------------------

-- Vínculo recuperável pela conexão `p_connection`: desfeito (`unlinked`),
-- do MESMO usuário, workspace e ambiente, de uma conexão anterior já
-- desconectada; a atividade ainda existe e não tem outro vínculo ativo.
create function private.recoverable_link(p_link public.calendar_event_links, p_conn public.calendar_connections)
returns boolean
language sql
stable
security definer
set search_path = ''
as $body$
  select p_link.status = 'unlinked'
    and p_link.activity_id is not null
    and p_link.workspace_id = p_conn.workspace_id
    and p_link.environment = p_conn.environment
    and p_link.connection_id <> p_conn.id
    and exists (
      select 1 from public.calendar_connections old
      where old.id = p_link.connection_id and old.user_id = p_conn.user_id and old.status = 'disconnected')
    and exists (select 1 from public.activities a where a.id = p_link.activity_id)
    and not exists (
      select 1 from public.calendar_event_links o
      where o.activity_id = p_link.activity_id and o.status <> 'unlinked' and o.id <> p_link.id);
$body$;

revoke all on function private.recoverable_link(public.calendar_event_links, public.calendar_connections) from public, anon, authenticated;

create function public.list_recoverable_calendar_links(p_connection_id uuid, p_actor_user_id uuid)
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
      'id', l.id, 'activityId', l.activity_id, 'calendarId', l.calendar_id, 'eventId', l.event_id,
      'baseEtag', l.base_etag) order by l.updated_at desc)
    from (
      select l.* from public.calendar_event_links l
      where l.workspace_id = v_conn.workspace_id and l.environment = v_conn.environment and l.status = 'unlinked'
        and private.recoverable_link(l, v_conn)
      order by l.updated_at desc
      limit 200
    ) l
  ), '[]'::jsonb);
end;
$body$;

revoke all on function public.list_recoverable_calendar_links(uuid, uuid) from public;
grant execute on function public.list_recoverable_calendar_links(uuid, uuid) to service_role;
revoke execute on function public.list_recoverable_calendar_links(uuid, uuid) from anon, authenticated;

-- Volta o vínculo para a conexão nova, com a base preservada: a próxima
-- sincronização compara Google e CRM com o que os dois tinham na última vez
-- em que concordaram (as regras de conflito valem normalmente). Só depois
-- de a aplicação conferir o evento no Google (existe, mesma marca e
-- ambiente, não cancelado).
create function public.relink_recovered_calendar_link(p_link_id uuid, p_connection_id uuid, p_actor_user_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_conn public.calendar_connections := private.own_active_connection(p_connection_id, p_actor_user_id);
  v_link public.calendar_event_links;
begin
  select * into v_link from public.calendar_event_links l where l.id = p_link_id for update;
  if v_link.id is null or v_link.environment <> v_conn.environment then
    return 'not_recoverable';
  end if;
  if not private.recoverable_link(v_link, v_conn) then
    return 'not_recoverable';
  end if;

  update public.calendar_event_links
  set connection_id = v_conn.id, status = 'linked', sync_state = 'pending', sync_error = 'reconnected',
      sync_state_at = now(), updated_at = now()
  where id = v_link.id;

  insert into public.audit_logs (workspace_id, actor_user_id, action, resource_type, resource_id, metadata)
  values (v_link.workspace_id, p_actor_user_id, 'calendar.link.recovered', 'calendar_event_link', v_link.id,
    jsonb_build_object('environment', v_link.environment, 'activity_id', v_link.activity_id));
  return 'relinked';
end;
$body$;

revoke all on function public.relink_recovered_calendar_link(uuid, uuid, uuid) from public;
grant execute on function public.relink_recovered_calendar_link(uuid, uuid, uuid) to service_role;
revoke execute on function public.relink_recovered_calendar_link(uuid, uuid, uuid) from anon, authenticated;

-- ---------------------------------------------------------------------
-- 6) Restauração do valor do CRM que perdeu num conflito
-- ---------------------------------------------------------------------

alter table public.calendar_sync_conflicts
  add column restored_at timestamptz,
  add column restored_by uuid references auth.users (id) on delete set null,
  add column restored_activity_version bigint;

-- Devolve { status: restored | already_restored | not_restorable | outdated
-- | link_inactive | not_owner, activityId?, lockVersion? }.
--  - só título e horário, e só o que o Google venceu;
--  - só pelo DONO da conexão do vínculo (é ele quem leva a mudança ao
--    Google) e com activity.edit + alcance ao lead;
--  - só se a atividade ainda tem o valor que prevaleceu (senão alguém já a
--    mudou depois: restaurar sobrescreveria esse valor mais novo);
--  - a atividade passa pelo gatilho de ambiente, como toda alteração.
-- A ida ao Google é feita em seguida pela aplicação, com as regras normais
-- de saída (se o Google mudou de novo, vale a regra de conflito).
create function public.restore_calendar_conflict(p_conflict_id uuid, p_actor_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_env public.calendar_environment := private.require_request_environment();
  v_conflict public.calendar_sync_conflicts;
  v_link public.calendar_event_links;
  v_conn public.calendar_connections;
  v_activity public.activities;
  v_lead public.leads;
  v_role public.membership_role;
  v_version bigint;
  v_crm_start timestamptz;
  v_google_start timestamptz;
begin
  select * into v_conflict from public.calendar_sync_conflicts c where c.id = p_conflict_id for update;
  if v_conflict.id is null then
    raise exception 'conflict_not_found';
  end if;
  if v_conflict.environment <> v_env then
    raise exception 'calendar_environment_mismatch';
  end if;

  select * into v_link from public.calendar_event_links l where l.id = v_conflict.link_id;
  select * into v_activity from public.activities a where a.id = v_link.activity_id for update;
  if v_activity.id is null then
    raise exception 'conflict_not_found';
  end if;

  select role into v_role from public.memberships m
  where m.workspace_id = v_activity.workspace_id and m.user_id = p_actor_user_id and m.status = 'active';
  select * into v_lead from public.leads ld where ld.id = v_activity.lead_id;
  -- activity.edit + alcance por lead. Sem isso, nem a existência é revelada.
  if v_role is null or v_role not in ('owner', 'admin', 'manager', 'lawyer', 'sales')
     or not private.lead_accessible_to_role(v_role, v_lead.assigned_to, p_actor_user_id) then
    raise exception 'conflict_not_found';
  end if;

  if v_conflict.restored_at is not null then
    return jsonb_build_object('status', 'already_restored', 'activityId', v_activity.id);
  end if;
  if v_conflict.resolution <> 'google_prevails' or v_conflict.field not in ('title', 'schedule') then
    return jsonb_build_object('status', 'not_restorable', 'activityId', v_activity.id);
  end if;
  if v_link.status <> 'linked' then
    return jsonb_build_object('status', 'link_inactive', 'activityId', v_activity.id);
  end if;
  select * into v_conn from public.calendar_connections c where c.id = v_link.connection_id;
  if v_conn.user_id is distinct from p_actor_user_id or v_conn.status <> 'active' then
    return jsonb_build_object('status', 'not_owner', 'activityId', v_activity.id);
  end if;

  if v_conflict.field = 'title' then
    if jsonb_typeof(v_conflict.crm_value) <> 'string' or btrim(v_conflict.crm_value #>> '{}') = '' then
      return jsonb_build_object('status', 'not_restorable', 'activityId', v_activity.id);
    end if;
    if v_activity.title is distinct from (v_conflict.google_value #>> '{}') then
      return jsonb_build_object('status', 'outdated', 'activityId', v_activity.id);
    end if;
    update public.activities
    set title = v_conflict.crm_value #>> '{}', lock_version = lock_version + 1, updated_at = now()
    where id = v_activity.id
    returning lock_version into v_version;
  else
    v_crm_start := (v_conflict.crm_value ->> 'start')::timestamptz;
    v_google_start := (v_conflict.google_value ->> 'start')::timestamptz;
    if v_crm_start is null or v_google_start is null then
      return jsonb_build_object('status', 'not_restorable', 'activityId', v_activity.id);
    end if;
    if v_activity.due_at is distinct from v_google_start then
      return jsonb_build_object('status', 'outdated', 'activityId', v_activity.id);
    end if;
    update public.activities
    set due_at = v_crm_start, has_time = true, lock_version = lock_version + 1, updated_at = now()
    where id = v_activity.id
    returning lock_version into v_version;
  end if;

  update public.calendar_sync_conflicts
  set restored_at = now(), restored_by = p_actor_user_id, restored_activity_version = v_version
  where id = v_conflict.id;

  -- Só o nome do campo, nunca valores.
  insert into public.audit_logs (workspace_id, actor_user_id, action, resource_type, resource_id, metadata)
  values (v_conflict.workspace_id, p_actor_user_id, 'calendar.conflict.restored', 'calendar_sync_conflict', v_conflict.id,
    jsonb_build_object('environment', v_env, 'field', v_conflict.field, 'activity_id', v_activity.id));

  return jsonb_build_object('status', 'restored', 'activityId', v_activity.id, 'lockVersion', v_version);
end;
$body$;

revoke all on function public.restore_calendar_conflict(uuid, uuid) from public;
grant execute on function public.restore_calendar_conflict(uuid, uuid) to service_role;
revoke execute on function public.restore_calendar_conflict(uuid, uuid) from anon, authenticated;

-- ---------------------------------------------------------------------
-- 7) Timeline do lead: conflito de agenda e restauração ('agenda').
--
-- create or replace com a MESMA assinatura — corpo idêntico ao de
-- 20260929120500_b1_timeline_extension.sql, com dois braços novos no
-- UNION ALL. Só conflitos do ambiente AUTENTICADO da requisição (Preview e
-- Production compartilham o banco); sem ambiente, nenhum. Valores do
-- conflito são os da própria atividade do lead (título e horário), já
-- visíveis a quem vê o lead.
-- ---------------------------------------------------------------------

create or replace function public.get_lead_timeline(
  p_lead_id uuid,
  p_types text[] default null,
  p_before timestamptz default null,
  p_before_id uuid default null,
  p_limit integer default 30
)
returns table (items jsonb, has_more boolean)
language plpgsql
security definer
stable
set search_path = ''
as $body$
declare
  v_actor uuid := auth.uid();
  v_role public.membership_role;
  v_lead public.leads;
  v_limit integer;
  v_env text := private.request_environment();
begin
  if v_actor is null then
    raise exception 'authentication_required';
  end if;

  select * into v_lead from public.leads where id = p_lead_id;
  if v_lead.id is null then
    raise exception 'lead_not_found';
  end if;

  if not private.has_workspace_role(
    v_lead.workspace_id,
    array['owner', 'admin', 'manager', 'lawyer', 'sales', 'viewer']::public.membership_role[]
  ) then
    raise exception 'insufficient_permission';
  end if;

  select role into v_role from public.memberships
  where workspace_id = v_lead.workspace_id and user_id = v_actor and status = 'active';

  if not private.lead_accessible_to_role(v_role, v_lead.assigned_to, v_actor) then
    raise exception 'lead_not_found';
  end if;

  if p_before is not null and p_before_id is null then
    raise exception 'invalid_cursor';
  end if;

  v_limit := greatest(1, least(coalesce(p_limit, 30), 100));

  return query
  with source as (
    select 'nota'::text as event_type, n.created_at as occurred_at, n.id as row_id,
      jsonb_build_object('body', n.body, 'created_by', n.created_by) as payload
    from public.lead_notes n
    where n.lead_id = p_lead_id

    union all

    select 'atividade', coalesce(a.completed_at, a.created_at), a.id,
      jsonb_build_object(
        'type', a.type, 'title', a.title, 'status', a.status, 'opportunity_id', a.opportunity_id,
        'assigned_to', a.assigned_to, 'due_at', a.due_at, 'completed_at', a.completed_at
      )
    from public.activities a
    where a.lead_id = p_lead_id

    union all

    select 'mensagem', m.created_at, m.id,
      jsonb_build_object(
        'direction', m.direction, 'body_text', m.body_text, 'status', m.status,
        'conversation_id', m.conversation_id
      )
    from public.messages m
    join public.conversations c on c.id = m.conversation_id
    where c.lead_id = p_lead_id
      and private.conversation_accessible_to_role(v_role, c.lead_id, v_lead.assigned_to, v_actor)

    union all

    select 'etapa', st.occurred_at, st.id,
      jsonb_build_object(
        'opportunity_id', st.opportunity_id, 'from_stage_id', st.from_stage_id, 'to_stage_id', st.to_stage_id,
        'from_stage_name', fs.name, 'to_stage_name', ts.name
      )
    from public.stage_transitions st
    join public.opportunities o on o.id = st.opportunity_id
    left join public.pipeline_stages fs on fs.id = st.from_stage_id
    join public.pipeline_stages ts on ts.id = st.to_stage_id
    where o.lead_id = p_lead_id

    union all

    select 'proposta', coalesce(p.decided_at, p.sent_at, p.created_at), p.id,
      jsonb_build_object('number', p.number, 'status', p.status, 'opportunity_id', p.opportunity_id)
        || private.proposal_financial_projection(v_role, p.value_cents, p.fee_model)
    from public.proposals p
    where p.lead_id = p_lead_id

    union all

    -- B1: reenvio de e-mail que NÃO foi o primeiro (caused_status_transition
    -- = false) — o primeiro já está representado pelo braço 'proposta'
    -- acima, através de sent_at. Isso evita duplicar o mesmo fato na
    -- timeline (correção 7).
    select 'proposta', pes.resolved_at, pes.id,
      jsonb_build_object(
        'kind', 'email_resent',
        'opportunity_id', p.opportunity_id,
        'document_version', pd.version,
        'to_email', pes.to_email
      )
    from public.proposal_email_sends pes
    join public.proposals p on p.id = pes.proposal_id
    join public.proposal_documents pd on pd.id = pes.document_id
    where p.lead_id = p_lead_id
      and pes.status = 'accepted'
      and not pes.caused_status_transition

    union all

    select 'conflito', cc.checked_at, cc.id,
      jsonb_build_object('status', cc.status)
    from public.conflict_checks cc
    where cc.lead_id = p_lead_id and cc.checked_at is not null

    union all

    -- B2: conflito de agenda (o Google prevaleceu; o valor do CRM ficou
    -- gravado), com o que dá para fazer com ele.
    select 'agenda', sc.created_at, sc.id,
      jsonb_build_object(
        'kind', 'conflict', 'conflict_id', sc.id, 'activity_id', a.id, 'activity_title', a.title,
        'field', sc.field, 'resolution', sc.resolution, 'crm_value', sc.crm_value, 'google_value', sc.google_value,
        'restored_at', sc.restored_at,
        'restorable', sc.restored_at is null and sc.resolution = 'google_prevails'
          and sc.field in ('title', 'schedule') and l.status = 'linked'
      )
    from public.calendar_sync_conflicts sc
    join public.calendar_event_links l on l.id = sc.link_id
    join public.activities a on a.id = l.activity_id
    where a.lead_id = p_lead_id and sc.environment::text = v_env

    union all

    -- Id próprio (derivado do conflito): a restauração é outro fato da
    -- timeline, com cursor e chave distintos do registro do conflito.
    select 'agenda', sc.restored_at, md5(sc.id::text || ':restored')::uuid,
      jsonb_build_object(
        'kind', 'restored', 'conflict_id', sc.id, 'activity_id', a.id, 'activity_title', a.title,
        'field', sc.field, 'crm_value', sc.crm_value, 'restored_by', sc.restored_by
      )
    from public.calendar_sync_conflicts sc
    join public.calendar_event_links l on l.id = sc.link_id
    join public.activities a on a.id = l.activity_id
    where a.lead_id = p_lead_id and sc.restored_at is not null and sc.environment::text = v_env
  ),
  filtered as (
    select * from source where p_types is null or event_type = any(p_types)
  ),
  page as (
    select *
    from filtered
    where p_before is null or (occurred_at, row_id) < (p_before, p_before_id)
    order by occurred_at desc, row_id desc
    limit v_limit
  ),
  cursor_point as (
    select occurred_at, row_id from page order by occurred_at asc, row_id asc limit 1
  ),
  older_count as (
    select count(*) as n
    from filtered f, cursor_point cp
    where (f.occurred_at, f.row_id) < (cp.occurred_at, cp.row_id)
  )
  select
    coalesce(
      (
        select jsonb_agg(
          jsonb_build_object(
            'event_type', p.event_type, 'occurred_at', p.occurred_at, 'id', p.row_id, 'payload', p.payload
          )
          order by p.occurred_at desc, p.row_id desc
        )
        from page p
      ),
      '[]'::jsonb
    ),
    coalesce((select n from older_count), 0) > 0;
end;
$body$;

revoke all on function public.get_lead_timeline(uuid, text[], timestamptz, uuid, integer) from public;
grant execute on function public.get_lead_timeline(uuid, text[], timestamptz, uuid, integer) to authenticated;
