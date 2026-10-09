-- B2, etapa 2 — compromissos CRM → Google (docs/decisoes/b2-google-agenda.md
-- §6, §11): base de sincronização por vínculo, intenções de efeito externo
-- (idempotência e resultado incerto) e conflitos registrados.
--
-- NÃO fala com o Google: guarda o que a aplicação precisa para decidir com
-- segurança. Nada aqui é aplicado ao banco hospedado sem autorização à
-- parte. Todas as funções exigem o ambiente AUTENTICADO da requisição
-- (private.request_environment, fundação) e recusam vínculo/conexão de outro
-- ambiente.

-- ---------------------------------------------------------------------
-- Base da última sincronização, no vínculo (§6.3)
-- ---------------------------------------------------------------------

alter table public.calendar_event_links
  add column -- Duração REAL do evento (inclusive de evento externo vinculado, fora de 15–480):
  -- o intervalo 15–480 vale só para o que o usuário digita, na aplicação.
  duration_minutes integer not null default 60 check (duration_minutes > 0),
  add column base_etag text,
  add column base_title text check (base_title is null or char_length(base_title) <= 1024),
  add column base_start timestamptz,
  add column base_end timestamptz,
  add column base_cancelled boolean not null default false,
  add column base_has_meet boolean not null default false,
  add column base_crm_version bigint,
  add column meet_request_id text,
  add column meet_status text check (meet_status is null or meet_status in ('pending', 'success', 'failed')),
  add column meet_url text,
  add column last_synced_at timestamptz;

comment on column public.calendar_event_links.base_title is
  'Título do evento na última sincronização (só de evento VINCULADO ao CRM, nunca de evento externo).';

-- ---------------------------------------------------------------------
-- Intenções de efeito externo: registradas ANTES de chamar o Google, para
-- nunca repetir às cegas depois de timeout (§6.7).
-- ---------------------------------------------------------------------

create table public.calendar_effect_intents (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  connection_id uuid not null,
  activity_id uuid,
  environment public.calendar_environment not null,
  operation text not null check (operation in ('create', 'update', 'delete', 'meet')),
  -- Estado pretendido (título, início, fim, Meet). Só de compromisso do CRM.
  expected jsonb not null default '{}'::jsonb,
  status text not null default 'pending' check (status in ('pending', 'succeeded', 'failed', 'uncertain')),
  error_code text,
  created_by uuid not null references auth.users (id) on delete restrict,
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  constraint calendar_effect_intents_connection_fkey
    foreign key (workspace_id, connection_id) references public.calendar_connections (workspace_id, id) on delete restrict,
  constraint calendar_effect_intents_activity_fkey
    foreign key (workspace_id, activity_id) references public.activities (workspace_id, id) on delete set null (activity_id)
);

create index calendar_effect_intents_open_idx
  on public.calendar_effect_intents (workspace_id, status) where status in ('pending', 'uncertain');

alter table public.calendar_effect_intents enable row level security;
alter table public.calendar_effect_intents force row level security;
create policy calendar_effect_intents_select_deny on public.calendar_effect_intents for select to authenticated using (false);
create policy calendar_effect_intents_insert_deny on public.calendar_effect_intents for insert to authenticated with check (false);
create policy calendar_effect_intents_update_deny on public.calendar_effect_intents for update to authenticated using (false);
create policy calendar_effect_intents_delete_deny on public.calendar_effect_intents for delete to authenticated using (false);
revoke all on table public.calendar_effect_intents from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- Conflitos: o valor perdedor NUNCA é descartado em silêncio (§6.4).
-- ---------------------------------------------------------------------

create table public.calendar_sync_conflicts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  link_id uuid not null references public.calendar_event_links (id) on delete cascade,
  environment public.calendar_environment not null,
  field text not null check (field in ('title', 'schedule', 'cancellation', 'meet')),
  crm_value jsonb,
  google_value jsonb,
  resolution text not null check (resolution in ('google_prevails', 'crm_prevails', 'kept_google_event', 'needs_attention')),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);

create index calendar_sync_conflicts_link_idx on public.calendar_sync_conflicts (link_id, created_at desc);

alter table public.calendar_sync_conflicts enable row level security;
alter table public.calendar_sync_conflicts force row level security;
create policy calendar_sync_conflicts_select_deny on public.calendar_sync_conflicts for select to authenticated using (false);
create policy calendar_sync_conflicts_insert_deny on public.calendar_sync_conflicts for insert to authenticated with check (false);
create policy calendar_sync_conflicts_update_deny on public.calendar_sync_conflicts for update to authenticated using (false);
create policy calendar_sync_conflicts_delete_deny on public.calendar_sync_conflicts for delete to authenticated using (false);
revoke all on table public.calendar_sync_conflicts from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- Auxiliar: papel e alcance de quem age sobre a atividade (mesma regra de
-- activity.edit + escopo por lead, como create_calendar_event_link).
-- ---------------------------------------------------------------------

create function private.assert_can_sync_activity(p_workspace_id uuid, p_activity_id uuid, p_actor_user_id uuid)
returns public.activities
language plpgsql
stable
security definer
set search_path = ''
as $body$
declare
  v_activity public.activities;
  v_lead public.leads;
  v_role public.membership_role;
begin
  select * into v_activity from public.activities a where a.id = p_activity_id and a.workspace_id = p_workspace_id;
  if v_activity.id is null then
    raise exception 'activity_not_found';
  end if;

  select role into v_role from public.memberships m
  where m.workspace_id = p_workspace_id and m.user_id = p_actor_user_id and m.status = 'active';
  select * into v_lead from public.leads l where l.id = v_activity.lead_id;

  if v_role is null or v_role not in ('owner', 'admin', 'manager', 'lawyer', 'sales')
     or not private.lead_accessible_to_role(v_role, v_lead.assigned_to, p_actor_user_id) then
    raise exception 'activity_not_found';
  end if;

  return v_activity;
end;
$body$;

revoke all on function private.assert_can_sync_activity(uuid, uuid, uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- begin_calendar_effect — registra a intenção ANTES do efeito externo.
-- ---------------------------------------------------------------------

create function public.begin_calendar_effect(
  p_connection_id uuid,
  p_activity_id uuid,
  p_actor_user_id uuid,
  p_operation text,
  p_expected jsonb
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

  insert into public.calendar_effect_intents (workspace_id, connection_id, activity_id, environment, operation, expected, created_by)
  values (v_conn.workspace_id, v_conn.id, v_activity.id, v_env, p_operation, coalesce(p_expected, '{}'::jsonb), p_actor_user_id)
  returning id into v_id;

  return v_id;
end;
$body$;

revoke all on function public.begin_calendar_effect(uuid, uuid, uuid, text, jsonb) from public;
grant execute on function public.begin_calendar_effect(uuid, uuid, uuid, text, jsonb) to service_role;
revoke execute on function public.begin_calendar_effect(uuid, uuid, uuid, text, jsonb) from anon, authenticated;

-- ---------------------------------------------------------------------
-- resolve_calendar_effect — fecha a intenção e, no mesmo passo, grava o
-- vínculo e a nova base. p_state: { eventId, etag, title, start, end,
-- cancelled, hasMeet, meetStatus, meetUrl, meetRequestId, durationMinutes,
-- crmVersion, linkStatus }. Nos três campos do Meet, chave ausente preserva o
-- valor e chave com null o remove.
-- ---------------------------------------------------------------------

create function public.resolve_calendar_effect(
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
  if v_intent.status in ('succeeded', 'failed') then
    -- Idempotente: um resultado já definitivo não é reescrito.
    select l.id into v_link_id from public.calendar_event_links l where l.activity_id = v_intent.activity_id and l.status <> 'unlinked';
    return v_link_id;
  end if;

  update public.calendar_effect_intents
  set status = p_status,
      error_code = left(p_error_code, 100),
      resolved_at = case when p_status = 'uncertain' then null else now() end
  where id = v_intent.id;

  if p_status <> 'succeeded' then
    -- Perda de acesso à agenda: pendência EXPLÍCITA no vínculo (nunca "evento
    -- apagado"). Só a conexão dona do vínculo o marca.
    if p_status = 'failed' and p_state ->> 'linkStatus' = 'needs_attention' then
      update public.calendar_event_links
      set status = 'needs_attention', updated_at = now()
      where activity_id = v_intent.activity_id and status <> 'unlinked' and connection_id = v_intent.connection_id
      returning id into v_link_id;

      if v_link_id is not null then
        insert into public.audit_logs (workspace_id, actor_user_id, action, resource_type, resource_id, metadata)
        values (
          v_intent.workspace_id, p_actor_user_id, 'calendar.link.needs_attention', 'calendar_event_link', v_link_id,
          jsonb_build_object('environment', v_env, 'activity_id', v_intent.activity_id, 'reason', left(p_error_code, 100))
        );
      end if;
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
      base_crm_version, meet_request_id, meet_status, meet_url, last_synced_at
    ) values (
      v_intent.workspace_id, v_intent.activity_id, v_conn.id, v_env, v_conn.calendar_id, p_state ->> 'eventId', v_status,
      coalesce((p_state ->> 'durationMinutes')::integer, 60), p_state ->> 'etag', p_state ->> 'title',
      (p_state ->> 'start')::timestamptz, (p_state ->> 'end')::timestamptz,
      coalesce((p_state ->> 'cancelled')::boolean, false), coalesce((p_state ->> 'hasMeet')::boolean, false),
      (p_state ->> 'crmVersion')::bigint, p_state ->> 'meetRequestId', p_state ->> 'meetStatus', p_state ->> 'meetUrl', now()
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
-- get_calendar_link — o vínculo ativo de uma atividade, com a base.
-- ---------------------------------------------------------------------

create function public.get_calendar_link(p_activity_id uuid, p_actor_user_id uuid)
returns jsonb
language plpgsql
security definer
stable
set search_path = ''
as $body$
declare
  v_env public.calendar_environment := private.require_request_environment();
  v_activity public.activities;
  v_link public.calendar_event_links;
begin
  select * into v_activity from public.activities a where a.id = p_activity_id;
  if v_activity.id is null then
    raise exception 'activity_not_found';
  end if;
  v_activity := private.assert_can_sync_activity(v_activity.workspace_id, p_activity_id, p_actor_user_id);

  select * into v_link from public.calendar_event_links l
  where l.activity_id = p_activity_id and l.status <> 'unlinked';
  if v_link.id is null then
    return null;
  end if;
  if v_link.environment <> v_env then
    raise exception 'calendar_environment_mismatch';
  end if;

  return jsonb_build_object(
    'id', v_link.id,
    'connectionId', v_link.connection_id,
    'environment', v_link.environment,
    'calendarId', v_link.calendar_id,
    'eventId', v_link.event_id,
    'generation', v_link.generation,
    'status', v_link.status,
    'durationMinutes', v_link.duration_minutes,
    'baseEtag', v_link.base_etag,
    'baseTitle', v_link.base_title,
    'baseStart', v_link.base_start,
    'baseEnd', v_link.base_end,
    'baseCancelled', v_link.base_cancelled,
    'baseHasMeet', v_link.base_has_meet,
    'baseCrmVersion', v_link.base_crm_version,
    'meetRequestId', v_link.meet_request_id,
    'meetStatus', v_link.meet_status,
    'meetUrl', v_link.meet_url
  );
end;
$body$;

revoke all on function public.get_calendar_link(uuid, uuid) from public;
grant execute on function public.get_calendar_link(uuid, uuid) to service_role;
revoke execute on function public.get_calendar_link(uuid, uuid) from anon, authenticated;

-- ---------------------------------------------------------------------
-- record_calendar_conflict — guarda o valor perdedor (nunca em silêncio).
-- ---------------------------------------------------------------------

create function public.record_calendar_conflict(
  p_link_id uuid,
  p_actor_user_id uuid,
  p_field text,
  p_crm_value jsonb,
  p_google_value jsonb,
  p_resolution text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_env public.calendar_environment := private.require_request_environment();
  v_link public.calendar_event_links;
  v_id uuid;
begin
  select * into v_link from public.calendar_event_links l where l.id = p_link_id;
  if v_link.id is null then
    raise exception 'link_not_found';
  end if;
  if v_link.environment <> v_env then
    raise exception 'calendar_environment_mismatch';
  end if;
  if v_link.activity_id is not null then
    perform private.assert_can_sync_activity(v_link.workspace_id, v_link.activity_id, p_actor_user_id);
  end if;

  insert into public.calendar_sync_conflicts (workspace_id, link_id, environment, field, crm_value, google_value, resolution, created_by)
  values (v_link.workspace_id, v_link.id, v_env, p_field, p_crm_value, p_google_value, p_resolution, p_actor_user_id)
  returning id into v_id;

  -- A auditoria guarda só o fato, nunca os valores.
  insert into public.audit_logs (workspace_id, actor_user_id, action, resource_type, resource_id, metadata)
  values (
    v_link.workspace_id, p_actor_user_id, 'calendar.conflict.recorded', 'calendar_event_link', v_link.id,
    jsonb_build_object('environment', v_env, 'field', p_field, 'resolution', p_resolution)
  );

  return v_id;
end;
$body$;

revoke all on function public.record_calendar_conflict(uuid, uuid, text, jsonb, jsonb, text) from public;
grant execute on function public.record_calendar_conflict(uuid, uuid, text, jsonb, jsonb, text) to service_role;
revoke execute on function public.record_calendar_conflict(uuid, uuid, text, jsonb, jsonb, text) from anon, authenticated;

-- ---------------------------------------------------------------------
-- apply_google_values_to_activity — aplica o valor do Google à atividade
-- quando ele prevalece num conflito. Passa pelo gatilho de ambiente como
-- qualquer outra alteração. Só título e horário.
--
-- Controle de concorrência: só aplica se a atividade ainda está em
-- `p_expected_version` (a versão que a aplicação LEU). Se o CRM foi editado
-- depois da leitura, NÃO aplica nada, NÃO grava conflito e devolve null —
-- quem chamou relê a atividade e reavalia. Os conflitos (o valor do CRM que
-- perdeu) são gravados na MESMA transação em que o valor do Google é
-- aplicado: ou acontecem os dois, ou nenhum.
-- ---------------------------------------------------------------------

create function public.apply_google_values_to_activity(
  p_activity_id uuid,
  p_actor_user_id uuid,
  p_expected_version bigint,
  p_title text,
  p_due_at timestamptz,
  p_conflicts jsonb default '[]'::jsonb
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_env public.calendar_environment := private.require_request_environment();
  v_activity public.activities;
  v_link public.calendar_event_links;
  v_version bigint;
  v_conflict jsonb;
begin
  if p_expected_version is null then
    raise exception 'expected_version_required';
  end if;

  select * into v_activity from public.activities a where a.id = p_activity_id;
  if v_activity.id is null then
    raise exception 'activity_not_found';
  end if;
  v_activity := private.assert_can_sync_activity(v_activity.workspace_id, p_activity_id, p_actor_user_id);

  select * into v_link from public.calendar_event_links l
  where l.activity_id = p_activity_id and l.status <> 'unlinked';
  if v_link.id is null or v_link.environment <> v_env then
    raise exception 'calendar_environment_mismatch';
  end if;

  update public.activities set
    title = coalesce(nullif(btrim(p_title), ''), title),
    due_at = coalesce(p_due_at, due_at),
    has_time = case when p_due_at is not null then true else has_time end,
    lock_version = lock_version + 1,
    updated_at = now()
  where id = p_activity_id and lock_version = p_expected_version
  returning lock_version into v_version;

  if v_version is null then
    -- Versão diferente da lida: o CRM mudou no meio. Nada é aplicado.
    return null;
  end if;

  for v_conflict in
    select c.value from jsonb_array_elements(coalesce(p_conflicts, '[]'::jsonb)) as c(value)
  loop
    insert into public.calendar_sync_conflicts (workspace_id, link_id, environment, field, crm_value, google_value, resolution, created_by)
    values (v_link.workspace_id, v_link.id, v_env, v_conflict ->> 'field', v_conflict -> 'crmValue', v_conflict -> 'googleValue', 'google_prevails', p_actor_user_id);

    -- A auditoria guarda só o fato, nunca os valores.
    insert into public.audit_logs (workspace_id, actor_user_id, action, resource_type, resource_id, metadata)
    values (
      v_link.workspace_id, p_actor_user_id, 'calendar.conflict.recorded', 'calendar_event_link', v_link.id,
      jsonb_build_object('environment', v_env, 'field', v_conflict ->> 'field', 'resolution', 'google_prevails')
    );
  end loop;

  return v_version;
end;
$body$;

revoke all on function public.apply_google_values_to_activity(uuid, uuid, bigint, text, timestamptz, jsonb) from public;
grant execute on function public.apply_google_values_to_activity(uuid, uuid, bigint, text, timestamptz, jsonb) to service_role;
revoke execute on function public.apply_google_values_to_activity(uuid, uuid, bigint, text, timestamptz, jsonb) from anon, authenticated;

-- ---------------------------------------------------------------------
-- store_calendar_access_token — guarda o novo token de acesso (já cifrado
-- pela aplicação) depois de uma renovação. Só o dono da conexão.
-- ---------------------------------------------------------------------

create function public.store_calendar_access_token(
  p_connection_id uuid,
  p_actor_user_id uuid,
  p_access_token_ciphertext text,
  p_access_token_expires_at timestamptz,
  p_key_version text
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
  select * into v_conn from public.calendar_connections c where c.id = p_connection_id;
  if v_conn.id is null or v_conn.user_id is distinct from p_actor_user_id or v_conn.status <> 'active' then
    raise exception 'connection_not_found';
  end if;
  if v_conn.environment <> v_env then
    raise exception 'calendar_environment_mismatch';
  end if;

  -- A versão de chave é UMA por conexão (refresh e acesso são lidos com a
  -- mesma): só aceita a versão já gravada.
  if v_conn.key_version is distinct from p_key_version then
    raise exception 'key_version_mismatch';
  end if;

  update public.calendar_connections
  set access_token_ciphertext = p_access_token_ciphertext,
      access_token_expires_at = p_access_token_expires_at,
      updated_at = now()
  where id = v_conn.id;
end;
$body$;

revoke all on function public.store_calendar_access_token(uuid, uuid, text, timestamptz, text) from public;
grant execute on function public.store_calendar_access_token(uuid, uuid, text, timestamptz, text) to service_role;
revoke execute on function public.store_calendar_access_token(uuid, uuid, text, timestamptz, text) from anon, authenticated;
