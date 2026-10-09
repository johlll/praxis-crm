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
-- 5) Identidade IMUTÁVEL da tentativa: agenda e evento efetivamente usados
--    ficam gravados na intenção ANTES da chamada ao Google. A verificação de
--    uma inclusão incerta (`get_open_calendar_create`) resolve a intenção
--    ORIGINAL nesse alvo — nunca na agenda selecionada depois — e um
--    desfecho definitivo só encerra intenções do MESMO alvo.
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

-- Alvo da tentativa (5): com ambiente, workspace e conexão, já gravados,
-- identifica a tentativa. Inclusão: a agenda selecionada no momento e o id
-- determinístico do evento. Demais operações: a agenda e o evento do vínculo.
alter table public.calendar_effect_intents
  add column calendar_id text check (calendar_id is null or char_length(calendar_id) between 1 and 1024),
  add column event_id text check (event_id is null or char_length(event_id) between 1 and 1024);

-- No máximo UMA inclusão sem desfecho por atividade e ambiente: enquanto ela
-- não for verificada, o evento PODE existir, e uma nova tentativa (talvez em
-- outra agenda) o duplicaria.
create unique index calendar_effect_intents_one_open_create_idx
  on public.calendar_effect_intents (activity_id, environment)
  where operation = 'create' and status in ('pending', 'uncertain');

-- A identidade não muda depois de gravada (só o desfecho muda).
create function private.calendar_effect_intent_identity_immutable()
returns trigger
language plpgsql
set search_path = ''
as $body$
begin
  if new.workspace_id is distinct from old.workspace_id
     or new.environment is distinct from old.environment
     or new.connection_id is distinct from old.connection_id
     or new.operation is distinct from old.operation
     or new.calendar_id is distinct from old.calendar_id
     or new.event_id is distinct from old.event_id
     or new.created_by is distinct from old.created_by then
    raise exception 'intent_identity_immutable';
  end if;
  return new;
end;
$body$;

revoke all on function private.calendar_effect_intent_identity_immutable() from public, anon, authenticated;

create trigger calendar_effect_intents_identity_immutable
  before update on public.calendar_effect_intents
  for each row execute function private.calendar_effect_intent_identity_immutable();

-- ---------------------------------------------------------------------
-- begin_calendar_effect — passa a gravar o alvo da tentativa (5)
-- ---------------------------------------------------------------------

drop function public.begin_calendar_effect(uuid, uuid, uuid, text, jsonb);

create function public.begin_calendar_effect(
  p_connection_id uuid,
  p_activity_id uuid,
  p_actor_user_id uuid,
  p_operation text,
  p_expected jsonb,
  -- Inclusão: a agenda e o evento que a aplicação VAI usar na chamada.
  p_calendar_id text default null,
  p_event_id text default null
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
  v_link public.calendar_event_links;
  v_calendar text;
  v_event text;
  v_id uuid;
begin
  if p_operation not in ('create', 'update', 'delete', 'meet') then
    raise exception 'invalid_operation';
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

  v_activity := private.assert_can_sync_activity(v_conn.workspace_id, p_activity_id, p_actor_user_id);

  if p_operation <> 'delete' and (v_activity.type <> 'meeting' or not v_activity.has_time) then
    raise exception 'activity_not_appointment';
  end if;

  -- Atividade vinculada a OUTRO ambiente: nem a intenção nasce.
  if exists (
    select 1 from public.calendar_event_links l
    where l.activity_id = v_activity.id and l.status <> 'unlinked' and l.environment <> v_env
  ) then
    raise exception 'calendar_environment_mismatch';
  end if;

  -- O vínculo ativo manda: só a conexão que o criou o opera. Outra conexão (de
  -- outro usuário) procuraria o evento no lugar errado e leria "não existe"
  -- como evento apagado. Trocar a agenda SELECIONADA da própria conexão afeta
  -- só compromissos novos: o vínculo existente continua na agenda original.
  if exists (
    select 1 from public.calendar_event_links l
    where l.activity_id = v_activity.id and l.status <> 'unlinked' and l.connection_id <> v_conn.id
  ) then
    raise exception 'calendar_link_mismatch';
  end if;

  if p_operation = 'create' then
    if nullif(btrim(p_calendar_id), '') is null or nullif(btrim(p_event_id), '') is null then
      raise exception 'calendar_target_required';
    end if;
    -- A agenda da tentativa é a selecionada AGORA; se mudou entre a leitura da
    -- aplicação e este registro, recusa (a chamada iria para outra agenda).
    if p_calendar_id <> v_conn.calendar_id then
      raise exception 'calendar_selection_changed';
    end if;
    -- Inclusão anterior ainda sem desfecho: o evento pode existir. O índice
    -- único garante o mesmo sob concorrência.
    if exists (
      select 1 from public.calendar_effect_intents i
      where i.activity_id = v_activity.id and i.environment = v_env
        and i.operation = 'create' and i.status in ('pending', 'uncertain')
    ) then
      raise exception 'create_outcome_uncertain';
    end if;
    v_calendar := p_calendar_id;
    v_event := p_event_id;
  else
    -- Demais operações: o alvo é o do vínculo ativo (a agenda em que o
    -- compromisso nasceu), nunca a selecionada.
    select * into v_link from public.calendar_event_links l
    where l.activity_id = v_activity.id and l.status <> 'unlinked';
    v_calendar := v_link.calendar_id;
    v_event := v_link.event_id;
    if (p_calendar_id is not null and p_calendar_id is distinct from v_calendar)
       or (p_event_id is not null and p_event_id is distinct from v_event) then
      raise exception 'calendar_target_mismatch';
    end if;
  end if;

  begin
    insert into public.calendar_effect_intents (
      workspace_id, connection_id, activity_id, environment, operation, expected, created_by, calendar_id, event_id
    ) values (
      v_conn.workspace_id, v_conn.id, v_activity.id, v_env, p_operation, coalesce(p_expected, '{}'::jsonb),
      p_actor_user_id, v_calendar, v_event
    ) returning id into v_id;
  exception when unique_violation then
    raise exception 'create_outcome_uncertain';
  end;

  return v_id;
end;
$body$;

revoke all on function public.begin_calendar_effect(uuid, uuid, uuid, text, jsonb, text, text) from public;
grant execute on function public.begin_calendar_effect(uuid, uuid, uuid, text, jsonb, text, text) to service_role;
revoke execute on function public.begin_calendar_effect(uuid, uuid, uuid, text, jsonb, text, text) from anon, authenticated;

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

  -- Inclusão concluída: só no alvo GRAVADO na intenção. Sem alvo registrado
  -- não há como saber onde o evento está — nenhuma conclusão é inventada.
  if p_status = 'succeeded' and v_intent.operation = 'create' then
    if v_intent.calendar_id is null or v_intent.event_id is null then
      raise exception 'intent_target_unknown';
    end if;
    if p_state ->> 'eventId' is distinct from v_intent.event_id then
      raise exception 'intent_target_mismatch';
    end if;
  end if;

  update public.calendar_effect_intents
  set status = p_status,
      error_code = left(p_error_code, 100),
      resolved_at = case when p_status = 'uncertain' then null else now() end
  where id = v_intent.id;

  -- Desfecho definitivo: intenções ainda abertas do MESMO alvo (ambiente,
  -- conexão, agenda e evento) foram respondidas por esta — a conferência
  -- consultou exatamente aquele evento. Intenção sem alvo registrado, ou de
  -- outro alvo, continua aberta: pertencer à mesma atividade não basta.
  if p_status <> 'uncertain' and v_intent.calendar_id is not null and v_intent.event_id is not null then
    update public.calendar_effect_intents
    set status = 'superseded', error_code = 'superseded', resolved_at = now()
    where environment = v_intent.environment and connection_id = v_intent.connection_id
      and calendar_id = v_intent.calendar_id and event_id = v_intent.event_id
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
    -- Sem vínculo: a agenda é a da TENTATIVA (gravada na intenção), não a
    -- selecionada agora — elas diferem quando a agenda foi trocada no meio.
    select * into v_link from public.calendar_event_links l
    where l.environment = v_env and l.calendar_id = coalesce(v_intent.calendar_id, v_conn.calendar_id)
      and l.event_id = p_state ->> 'eventId';
  end if;

  if v_link.id is null then
    insert into public.calendar_event_links (
      workspace_id, activity_id, connection_id, environment, calendar_id, event_id, status,
      duration_minutes, base_etag, base_title, base_start, base_end, base_cancelled, base_has_meet,
      base_crm_version, meet_request_id, meet_status, meet_url, last_synced_at,
      sync_state, sync_operation, sync_error, sync_state_at
    ) values (
      v_intent.workspace_id, v_intent.activity_id, v_conn.id, v_env, coalesce(v_intent.calendar_id, v_conn.calendar_id),
      p_state ->> 'eventId', v_status,
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

-- ---------------------------------------------------------------------
-- 5) get_open_calendar_create — a inclusão sem desfecho, para verificá-la
-- ---------------------------------------------------------------------

-- Devolve a inclusão mais recente ainda sem desfecho da atividade, no
-- ambiente autenticado, com o alvo GRAVADO antes da chamada ao Google. Só o
-- autor da tentativa recebe a identidade (conexão, agenda, evento); para
-- qualquer outro usuário com alcance à atividade, só o fato de existir.
-- `settled`: incerta, ou parada há mais de 2 minutos (uma pendente recente
-- pode estar em andamento — verificá-la agora concluiria cedo demais).
create function public.get_open_calendar_create(p_activity_id uuid, p_actor_user_id uuid)
returns jsonb
language plpgsql
security definer
stable
set search_path = ''
as $body$
declare
  v_env public.calendar_environment := private.require_request_environment();
  v_activity public.activities;
  v_intent public.calendar_effect_intents;
begin
  select * into v_activity from public.activities a where a.id = p_activity_id;
  if v_activity.id is null then
    raise exception 'activity_not_found';
  end if;
  perform private.assert_can_sync_activity(v_activity.workspace_id, p_activity_id, p_actor_user_id);

  select * into v_intent from public.calendar_effect_intents i
  where i.activity_id = p_activity_id and i.workspace_id = v_activity.workspace_id and i.environment = v_env
    and i.operation = 'create' and i.status in ('pending', 'uncertain')
  order by i.created_at desc
  limit 1;
  if v_intent.id is null then
    return null;
  end if;

  if v_intent.created_by is distinct from p_actor_user_id then
    return jsonb_build_object('isMine', false);
  end if;

  return jsonb_build_object(
    'isMine', true,
    'intentId', v_intent.id,
    'workspaceId', v_intent.workspace_id,
    'environment', v_intent.environment,
    'connectionId', v_intent.connection_id,
    'calendarId', v_intent.calendar_id,
    'eventId', v_intent.event_id,
    'status', v_intent.status,
    'settled', v_intent.status = 'uncertain' or v_intent.created_at < now() - interval '2 minutes'
  );
end;
$body$;

revoke all on function public.get_open_calendar_create(uuid, uuid) from public;
grant execute on function public.get_open_calendar_create(uuid, uuid) to service_role;
revoke execute on function public.get_open_calendar_create(uuid, uuid) from anon, authenticated;
