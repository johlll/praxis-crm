-- B2, etapa 2b — telas de atividade ligadas ao Google Agenda.
--
-- 1) Estado de sincronização GRAVADO no vínculo: uma falha ou um resultado
--    incerto depois de salvar no CRM continua visível depois de recarregar
--    (antes, só a intenção registrava o desfecho e o vínculo seguia "ok").
-- 2) `resolve_calendar_effect` passa a gravar esse estado e a encerrar
--    intenções antigas ainda abertas quando uma nova tem desfecho definitivo.
-- 3) `mark_calendar_link_pending`: pendência quando a sincronização nem chegou
--    a abrir intenção (ex.: conexão a reautorizar), depois de o CRM já ter
--    salvo.
-- 4) `list_activity_calendar_links`: leitura do vínculo pela interface — só
--    estado, se é do usuário, duração, Meet e sincronização. Inclui a
--    inclusão no Google com resultado incerto (ainda sem vínculo).
--
-- Não é aplicada ao banco hospedado sem autorização à parte. A aplicação só
-- chama estas funções quando o provedor de agenda está configurado.

-- ---------------------------------------------------------------------
-- 1) Estado de sincronização no vínculo
-- ---------------------------------------------------------------------

alter table public.calendar_event_links
  -- in_sync: CRM e Google conferem desde a última operação;
  -- pending: o CRM mudou e o Google ainda não (temporário, pode tentar de novo);
  -- failed: o Google recusou de forma definitiva (precisa de alguém);
  -- uncertain: não se sabe se o Google aplicou — consultar ANTES de repetir.
  add column sync_state text not null default 'in_sync'
    check (sync_state in ('in_sync', 'pending', 'failed', 'uncertain')),
  add column sync_operation text
    check (sync_operation is null or sync_operation in ('create', 'update', 'delete', 'meet')),
  add column sync_error text check (sync_error is null or char_length(sync_error) <= 100),
  add column sync_state_at timestamptz;

-- Intenção encerrada por uma conferência posterior (ver resolve).
alter table public.calendar_effect_intents drop constraint calendar_effect_intents_status_check;
alter table public.calendar_effect_intents add constraint calendar_effect_intents_status_check
  check (status in ('pending', 'succeeded', 'failed', 'uncertain', 'superseded'));

-- ---------------------------------------------------------------------
-- 2) resolve_calendar_effect — grava o estado de sincronização
-- ---------------------------------------------------------------------

create or replace function public.resolve_calendar_effect(
  p_intent_id uuid,
  p_actor_user_id uuid,
  p_status text,
  p_error_code text,
  p_state jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_env public.calendar_environment := private.require_request_environment();
  v_intent public.calendar_effect_intents;
  v_conn public.calendar_connections;
  v_link public.calendar_event_links;
  v_link_id uuid;
  v_status public.calendar_link_status;
  v_sync text;
begin
  if p_status not in ('succeeded', 'failed', 'uncertain') then
    raise exception 'invalid_status';
  end if;

  select * into v_intent from public.calendar_effect_intents i where i.id = p_intent_id for update;
  if v_intent.id is null or v_intent.created_by is distinct from p_actor_user_id then
    raise exception 'intent_not_found';
  end if;
  if v_intent.environment <> v_env then
    raise exception 'calendar_environment_mismatch';
  end if;
  if v_intent.status in ('succeeded', 'failed', 'superseded') then
    -- Idempotente: um resultado já definitivo não é reescrito.
    select l.id into v_link_id from public.calendar_event_links l where l.activity_id = v_intent.activity_id and l.status <> 'unlinked';
    return v_link_id;
  end if;

  update public.calendar_effect_intents
  set status = p_status,
      error_code = left(p_error_code, 100),
      resolved_at = case when p_status = 'uncertain' then null else now() end
  where id = v_intent.id;

  -- Desfecho definitivo: intenções antigas ainda abertas da mesma atividade e
  -- conexão foram respondidas por esta (a conferência consultou o Google).
  if p_status <> 'uncertain' and v_intent.activity_id is not null then
    update public.calendar_effect_intents
    set status = 'superseded', error_code = 'superseded', resolved_at = now()
    where activity_id = v_intent.activity_id and connection_id = v_intent.connection_id
      and id <> v_intent.id and status in ('pending', 'uncertain');
  end if;

  if p_status <> 'succeeded' then
    -- Falha ou incerteza ficam GRAVADAS no vínculo ativo da conexão dona,
    -- para continuarem visíveis depois de recarregar. Perda de acesso é
    -- pendência explícita (nunca "evento apagado").
    v_sync := case
      when p_status = 'uncertain' then 'uncertain'
      when p_state ->> 'syncState' = 'pending' then 'pending'
      else 'failed'
    end;

    update public.calendar_event_links
    set status = case when p_status = 'failed' and p_state ->> 'linkStatus' = 'needs_attention'
                      then 'needs_attention'::public.calendar_link_status else status end,
        sync_state = v_sync,
        sync_operation = v_intent.operation,
        sync_error = left(p_error_code, 100),
        sync_state_at = now(),
        updated_at = now()
    where activity_id = v_intent.activity_id and status <> 'unlinked' and connection_id = v_intent.connection_id
    returning id into v_link_id;

    if v_link_id is not null then
      insert into public.audit_logs (workspace_id, actor_user_id, action, resource_type, resource_id, metadata)
      values (
        v_intent.workspace_id, p_actor_user_id,
        case when p_status = 'failed' and p_state ->> 'linkStatus' = 'needs_attention'
             then 'calendar.link.needs_attention' else 'calendar.link.sync_' || v_sync end,
        'calendar_event_link', v_link_id,
        jsonb_build_object('environment', v_env, 'activity_id', v_intent.activity_id,
          'operation', v_intent.operation, 'reason', left(p_error_code, 100))
      );
    end if;
    return null;
  end if;

  select * into v_conn from public.calendar_connections c where c.id = v_intent.connection_id;
  v_status := coalesce(nullif(p_state ->> 'linkStatus', ''), 'linked')::public.calendar_link_status;

  -- O vínculo ativo da atividade manda (mesmo que a agenda selecionada da
  -- conexão tenha mudado): ele só é gravado pela conexão que o criou.
  select * into v_link from public.calendar_event_links l
  where l.activity_id = v_intent.activity_id and l.status <> 'unlinked';
  if v_link.id is not null then
    if v_link.connection_id <> v_conn.id then
      raise exception 'calendar_link_mismatch';
    end if;
  else
    select * into v_link from public.calendar_event_links l
    where l.environment = v_env and l.calendar_id = v_conn.calendar_id and l.event_id = p_state ->> 'eventId';
  end if;

  if v_link.id is null then
    insert into public.calendar_event_links (
      workspace_id, activity_id, connection_id, environment, calendar_id, event_id, status,
      duration_minutes, base_etag, base_title, base_start, base_end, base_cancelled, base_has_meet,
      base_crm_version, meet_request_id, meet_status, meet_url, last_synced_at,
      sync_state, sync_operation, sync_error, sync_state_at
    ) values (
      v_intent.workspace_id, v_intent.activity_id, v_conn.id, v_env, v_conn.calendar_id, p_state ->> 'eventId', v_status,
      coalesce((p_state ->> 'durationMinutes')::integer, 60), p_state ->> 'etag', p_state ->> 'title',
      (p_state ->> 'start')::timestamptz, (p_state ->> 'end')::timestamptz,
      coalesce((p_state ->> 'cancelled')::boolean, false), coalesce((p_state ->> 'hasMeet')::boolean, false),
      (p_state ->> 'crmVersion')::bigint, p_state ->> 'meetRequestId', p_state ->> 'meetStatus', p_state ->> 'meetUrl', now(),
      'in_sync', null, null, now()
    ) returning id into v_link_id;
  else
    update public.calendar_event_links set
      status = v_status,
      duration_minutes = coalesce((p_state ->> 'durationMinutes')::integer, duration_minutes),
      base_etag = p_state ->> 'etag',
      base_title = p_state ->> 'title',
      base_start = (p_state ->> 'start')::timestamptz,
      base_end = (p_state ->> 'end')::timestamptz,
      base_cancelled = coalesce((p_state ->> 'cancelled')::boolean, false),
      base_has_meet = coalesce((p_state ->> 'hasMeet')::boolean, false),
      base_crm_version = (p_state ->> 'crmVersion')::bigint,
      -- Chave AUSENTE preserva o valor guardado; chave presente — inclusive
      -- null, que é o Google informando que o Meet foi removido — o substitui.
      meet_request_id = case when p_state ? 'meetRequestId' then p_state ->> 'meetRequestId' else meet_request_id end,
      meet_status = case when p_state ? 'meetStatus' then p_state ->> 'meetStatus' else meet_status end,
      meet_url = case when p_state ? 'meetUrl' then p_state ->> 'meetUrl' else meet_url end,
      sync_state = 'in_sync',
      sync_operation = null,
      sync_error = null,
      sync_state_at = now(),
      last_synced_at = now(),
      updated_at = now()
    where id = v_link.id
    returning id into v_link_id;
  end if;

  insert into public.audit_logs (workspace_id, actor_user_id, action, resource_type, resource_id, metadata)
  values (
    v_intent.workspace_id, p_actor_user_id, 'calendar.effect.' || v_intent.operation, 'calendar_event_link', v_link_id,
    jsonb_build_object('environment', v_env, 'activity_id', v_intent.activity_id)
  );

  return v_link_id;
end;
$body$;

revoke all on function public.resolve_calendar_effect(uuid, uuid, text, text, jsonb) from public;
grant execute on function public.resolve_calendar_effect(uuid, uuid, text, text, jsonb) to service_role;
revoke execute on function public.resolve_calendar_effect(uuid, uuid, text, text, jsonb) from anon, authenticated;

-- ---------------------------------------------------------------------
-- 3) mark_calendar_link_pending — pendência sem intenção
-- ---------------------------------------------------------------------

create function public.mark_calendar_link_pending(
  p_activity_id uuid,
  p_actor_user_id uuid,
  p_reason text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_env public.calendar_environment := private.require_request_environment();
  v_activity public.activities;
  v_link_id uuid;
begin
  select * into v_activity from public.activities a where a.id = p_activity_id;
  if v_activity.id is null then
    raise exception 'activity_not_found';
  end if;
  perform private.assert_can_sync_activity(v_activity.workspace_id, p_activity_id, p_actor_user_id);

  -- Só o vínculo ativo, do ambiente que está operando e da conexão do PRÓPRIO
  -- usuário (mesmo a reautorizar).
  update public.calendar_event_links l
  set sync_state = 'pending', sync_operation = 'update', sync_error = left(p_reason, 100),
      sync_state_at = now(), updated_at = now()
  from public.calendar_connections c
  where l.activity_id = p_activity_id and l.status <> 'unlinked' and l.environment = v_env
    and c.id = l.connection_id and c.user_id = p_actor_user_id and c.status <> 'disconnected'
  returning l.id into v_link_id;

  if v_link_id is null then
    return false;
  end if;

  insert into public.audit_logs (workspace_id, actor_user_id, action, resource_type, resource_id, metadata)
  values (
    v_activity.workspace_id, p_actor_user_id, 'calendar.link.sync_pending', 'calendar_event_link', v_link_id,
    jsonb_build_object('environment', v_env, 'activity_id', p_activity_id, 'operation', 'update', 'reason', left(p_reason, 100))
  );
  return true;
end;
$body$;

revoke all on function public.mark_calendar_link_pending(uuid, uuid, text) from public;
grant execute on function public.mark_calendar_link_pending(uuid, uuid, text) to service_role;
revoke execute on function public.mark_calendar_link_pending(uuid, uuid, text) from anon, authenticated;

-- ---------------------------------------------------------------------
-- 4) list_activity_calendar_links — leitura pela interface
-- ---------------------------------------------------------------------

create function public.list_activity_calendar_links(p_activity_ids uuid[])
returns jsonb
language plpgsql
security definer
stable
set search_path = ''
as $body$
declare
  v_actor uuid := auth.uid();
  v_env public.calendar_environment := private.require_request_environment();
begin
  if v_actor is null then
    raise exception 'authentication_required';
  end if;
  if p_activity_ids is null or cardinality(p_activity_ids) = 0 then
    return '[]'::jsonb;
  end if;
  if cardinality(p_activity_ids) > 200 then
    raise exception 'too_many_activities';
  end if;

  return coalesce(
    (
      select jsonb_agg(row_value)
      from (
        -- Vínculo ativo, qualquer que seja o tipo atual da atividade (um vínculo
        -- existente nunca é escondido por filtro de tipo ou horário).
        (select jsonb_build_object(
          'activityId', l.activity_id,
          'status', l.status,
          'isMine', c.user_id = v_actor,
          'durationMinutes', l.duration_minutes,
          'meetStatus', l.meet_status,
          'meetUrl', l.meet_url,
          'lastSyncedAt', l.last_synced_at,
          'syncState', l.sync_state,
          'syncOperation', l.sync_operation
        ) as row_value
        from public.calendar_event_links l
        join public.calendar_connections c on c.id = l.connection_id
        join public.activities a on a.id = l.activity_id
        join public.memberships m
          on m.workspace_id = a.workspace_id and m.user_id = v_actor and m.status = 'active'
        join public.leads ld on ld.id = a.lead_id
        where l.activity_id = any (p_activity_ids)
          and l.status <> 'unlinked'
          and l.environment = v_env
          and private.lead_accessible_to_role(m.role, ld.assigned_to, v_actor))

        union all

        -- Sem vínculo, mas com inclusão no Google de resultado incerto (ou
        -- parada há mais de 2 minutos): o evento PODE existir lá.
        (select distinct on (i.activity_id) jsonb_build_object(
          'activityId', i.activity_id,
          'status', 'not_linked',
          'isMine', i.created_by = v_actor,
          'durationMinutes', 60,
          'meetStatus', null,
          'meetUrl', null,
          'lastSyncedAt', null,
          'syncState', 'uncertain',
          'syncOperation', 'create'
        )
        from public.calendar_effect_intents i
        join public.activities a on a.id = i.activity_id
        join public.memberships m
          on m.workspace_id = a.workspace_id and m.user_id = v_actor and m.status = 'active'
        join public.leads ld on ld.id = a.lead_id
        where i.activity_id = any (p_activity_ids)
          and i.operation = 'create'
          and i.environment = v_env
          and (i.status = 'uncertain' or (i.status = 'pending' and i.created_at < now() - interval '2 minutes'))
          and not exists (
            select 1 from public.calendar_event_links l2
            where l2.activity_id = i.activity_id and l2.status <> 'unlinked'
          )
          and private.lead_accessible_to_role(m.role, ld.assigned_to, v_actor)
        order by i.activity_id, i.created_at desc)
      ) t
    ),
    '[]'::jsonb
  );
end;
$body$;

revoke all on function public.list_activity_calendar_links(uuid[]) from public;
grant execute on function public.list_activity_calendar_links(uuid[]) to authenticated;
revoke execute on function public.list_activity_calendar_links(uuid[]) from anon;
