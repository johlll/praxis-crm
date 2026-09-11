-- A6 — Atividades: funções de negócio.
--
-- Papéis com acesso de escrita: mesma lista de leads/oportunidades
-- (owner, admin, manager, lawyer, sales) — alcance por registro herdado
-- do LEAD pai via private.lead_accessible_to_role(), reaproveitada sem
-- duplicar a regra (mesma função já usada pela A4/A5). Cada função busca
-- e checa o alcance por conta própria (mesmo padrão de duplicação da A5 —
-- create/move/win/lose_opportunity nunca compartilharam um helper de
-- "busca + checa", de propósito: cada função fica legível e auditável
-- sozinha, sem depender de entender outra função primeiro).
--
-- Concorrência: lock_version bigint (padrão da A5), checado no mesmo
-- WHERE do UPDATE — nunca SELECT-compara-UPDATE em passos separados.
--
-- Data/hora: due_date + due_time (opcional) chegam sempre separados —
-- NUNCA um timestamptz pré-calculado pelo cliente. O instante final é
-- montado aqui, com "AT TIME ZONE 'America/Sao_Paulo'" explícito, para
-- não depender do fuso do navegador nem do servidor Node (Vercel roda em
-- UTC). due_time nulo = atividade só de DATA — normalizada para o fim do
-- dia (23:59:59) nesse fuso, para que "due_at < now()" sozinho já seja a
-- regra de atrasada, igual para os dois casos.

-- ---------------------------------------------------------------------
-- private.check_activity_assignee — valida um candidato a responsável.
-- Reaproveitada por create_activity() e reassign_activity(): precisa ser
-- membro ativo do workspace (mesma checagem de assign_lead(), A4) E,
-- adicionalmente, ter acesso ao LEAD ao qual a atividade pertence (regra
-- pedida explicitamente: atribuir uma atividade não pode virar um atalho
-- para dar a alguém acesso a um lead que ele não teria pela via normal —
-- ex.: um advogado que não é dono do lead nem o lead está "sem
-- responsável" não pode ser responsável por uma atividade dele). Função
-- nova sem duplicata anterior no código — não há convenção de duplicação
-- a preservar aqui, e reaproveitar evita duas implementações da mesma
-- regra de segurança divergindo com o tempo.
-- ---------------------------------------------------------------------

create function private.check_activity_assignee(
  p_workspace_id uuid,
  p_lead_assigned_to uuid,
  p_candidate uuid
)
returns void
language plpgsql
security definer
stable
set search_path = ''
as $body$
declare
  v_candidate_role public.membership_role;
begin
  if p_candidate is null then
    return;
  end if;

  select role into v_candidate_role from public.memberships
  where workspace_id = p_workspace_id and user_id = p_candidate and status = 'active';

  if v_candidate_role is null then
    raise exception 'assignee_not_a_member';
  end if;

  if not private.lead_accessible_to_role(v_candidate_role, p_lead_assigned_to, p_candidate) then
    raise exception 'activity_assignee_no_access';
  end if;
end;
$body$;

revoke all on function private.check_activity_assignee(uuid, uuid, uuid) from public;
grant execute on function private.check_activity_assignee(uuid, uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------
-- create_activity
-- ---------------------------------------------------------------------

create function public.create_activity(
  p_lead_id uuid,
  p_type public.activity_type,
  p_title text,
  p_due_date date,
  p_due_time time default null,
  p_opportunity_id uuid default null,
  p_notes text default null,
  p_assigned_to uuid default null,
  p_priority public.lead_priority default 'media'
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_actor uuid := auth.uid();
  v_role public.membership_role;
  v_lead public.leads;
  v_opportunity public.opportunities;
  v_due_at timestamptz;
  v_has_time boolean;
  v_activity_id uuid;
begin
  if v_actor is null then
    raise exception 'authentication_required';
  end if;

  if p_due_date is null then
    raise exception 'due_date_required';
  end if;

  select * into v_lead from public.leads where id = p_lead_id;
  if v_lead.id is null then
    raise exception 'lead_not_found';
  end if;

  if not private.has_workspace_role(
    v_lead.workspace_id, array['owner', 'admin', 'manager', 'lawyer', 'sales']::public.membership_role[]
  ) then
    raise exception 'insufficient_permission';
  end if;

  select role into v_role from public.memberships
  where workspace_id = v_lead.workspace_id and user_id = v_actor and status = 'active';

  if not private.lead_accessible_to_role(v_role, v_lead.assigned_to, v_actor) then
    raise exception 'lead_not_found';
  end if;

  -- Coerência entre vínculos: a oportunidade, se informada, precisa
  -- pertencer a ESTE lead e a este workspace (não só existir em algum
  -- lugar do workspace).
  if p_opportunity_id is not null then
    select * into v_opportunity from public.opportunities
    where id = p_opportunity_id and lead_id = p_lead_id and workspace_id = v_lead.workspace_id;
    if v_opportunity.id is null then
      raise exception 'opportunity_not_found';
    end if;
  end if;

  perform private.check_activity_assignee(v_lead.workspace_id, v_lead.assigned_to, p_assigned_to);

  if p_due_time is not null then
    v_due_at := ((p_due_date::text || ' ' || p_due_time::text)::timestamp) at time zone 'America/Sao_Paulo';
    v_has_time := true;
  else
    v_due_at := ((p_due_date::text || ' 23:59:59')::timestamp) at time zone 'America/Sao_Paulo';
    v_has_time := false;
  end if;

  insert into public.activities (
    workspace_id, lead_id, opportunity_id, type, title, notes, assigned_to, priority, due_at, has_time
  )
  values (
    v_lead.workspace_id, p_lead_id, p_opportunity_id, p_type, btrim(p_title),
    nullif(btrim(coalesce(p_notes, '')), ''), p_assigned_to, coalesce(p_priority, 'media'), v_due_at, v_has_time
  )
  returning id into v_activity_id;

  insert into public.audit_logs (workspace_id, actor_user_id, action, resource_type, resource_id, metadata)
  values (
    v_lead.workspace_id, v_actor, 'activity.created', 'activity', v_activity_id,
    jsonb_build_object('lead_id', p_lead_id, 'opportunity_id', p_opportunity_id, 'type', p_type)
  );

  return v_activity_id;
end;
$body$;

revoke all on function public.create_activity(uuid, public.activity_type, text, date, time, uuid, text, uuid, public.lead_priority) from public;
grant execute on function public.create_activity(uuid, public.activity_type, text, date, time, uuid, text, uuid, public.lead_priority) to authenticated;

-- ---------------------------------------------------------------------
-- update_activity — edição geral (tipo, título, notas, prioridade). NÃO
-- mexe em data/responsável/status — isso é reschedule/reassign/complete,
-- cada um com sua própria checagem de concorrência (mesmo espírito de
-- move/win/lose serem RPCs distintas na A5, não um "update genérico").
-- ---------------------------------------------------------------------

create function public.update_activity(
  p_activity_id uuid,
  p_lock_version bigint,
  p_type public.activity_type default null,
  p_title text default null,
  p_notes text default null,
  p_clear_notes boolean default false,
  p_priority public.lead_priority default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_actor uuid := auth.uid();
  v_role public.membership_role;
  v_activity public.activities;
  v_lead public.leads;
begin
  if v_actor is null then
    raise exception 'authentication_required';
  end if;

  select * into v_activity from public.activities where id = p_activity_id;
  if v_activity.id is null then
    raise exception 'activity_not_found';
  end if;

  select * into v_lead from public.leads where id = v_activity.lead_id;

  if not private.has_workspace_role(
    v_activity.workspace_id, array['owner', 'admin', 'manager', 'lawyer', 'sales']::public.membership_role[]
  ) then
    raise exception 'insufficient_permission';
  end if;

  select role into v_role from public.memberships
  where workspace_id = v_activity.workspace_id and user_id = v_actor and status = 'active';

  if not private.lead_accessible_to_role(v_role, v_lead.assigned_to, v_actor) then
    raise exception 'activity_not_found';
  end if;

  update public.activities
  set type = coalesce(p_type, type),
      title = coalesce(nullif(btrim(coalesce(p_title, '')), ''), title),
      notes = case when p_clear_notes then null else coalesce(nullif(btrim(coalesce(p_notes, '')), ''), notes) end,
      priority = coalesce(p_priority, priority),
      lock_version = lock_version + 1
  where id = p_activity_id and lock_version = p_lock_version
  returning * into v_activity;

  if not found then
    raise exception 'activity_conflict';
  end if;

  insert into public.audit_logs (workspace_id, actor_user_id, action, resource_type, resource_id, metadata)
  values (v_activity.workspace_id, v_actor, 'activity.updated', 'activity', p_activity_id, '{}'::jsonb);
end;
$body$;

revoke all on function public.update_activity(uuid, bigint, public.activity_type, text, text, boolean, public.lead_priority) from public;
grant execute on function public.update_activity(uuid, bigint, public.activity_type, text, text, boolean, public.lead_priority) to authenticated;

-- ---------------------------------------------------------------------
-- complete_activity
-- ---------------------------------------------------------------------

create function public.complete_activity(p_activity_id uuid, p_lock_version bigint)
returns void
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_actor uuid := auth.uid();
  v_role public.membership_role;
  v_activity public.activities;
  v_lead public.leads;
begin
  if v_actor is null then
    raise exception 'authentication_required';
  end if;

  select * into v_activity from public.activities where id = p_activity_id;
  if v_activity.id is null then
    raise exception 'activity_not_found';
  end if;

  select * into v_lead from public.leads where id = v_activity.lead_id;

  if not private.has_workspace_role(
    v_activity.workspace_id, array['owner', 'admin', 'manager', 'lawyer', 'sales']::public.membership_role[]
  ) then
    raise exception 'insufficient_permission';
  end if;

  select role into v_role from public.memberships
  where workspace_id = v_activity.workspace_id and user_id = v_actor and status = 'active';

  if not private.lead_accessible_to_role(v_role, v_lead.assigned_to, v_actor) then
    raise exception 'activity_not_found';
  end if;

  update public.activities
  set status = 'done', completed_at = now(), lock_version = lock_version + 1
  where id = p_activity_id and lock_version = p_lock_version and status = 'pending'
  returning * into v_activity;

  if not found then
    raise exception 'activity_conflict';
  end if;

  insert into public.audit_logs (workspace_id, actor_user_id, action, resource_type, resource_id, metadata)
  values (v_activity.workspace_id, v_actor, 'activity.completed', 'activity', p_activity_id, '{}'::jsonb);
end;
$body$;

revoke all on function public.complete_activity(uuid, bigint) from public;
grant execute on function public.complete_activity(uuid, bigint) to authenticated;

-- ---------------------------------------------------------------------
-- reschedule_activity — recusa reagendar uma atividade já concluída
-- (status <> 'pending' cai no mesmo 'activity_conflict' do lock_version
-- divergente, mesmo padrão de opportunity_conflict na A5).
-- ---------------------------------------------------------------------

create function public.reschedule_activity(
  p_activity_id uuid,
  p_lock_version bigint,
  p_due_date date,
  p_due_time time default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_actor uuid := auth.uid();
  v_role public.membership_role;
  v_activity public.activities;
  v_lead public.leads;
  v_due_at timestamptz;
  v_has_time boolean;
begin
  if v_actor is null then
    raise exception 'authentication_required';
  end if;

  if p_due_date is null then
    raise exception 'due_date_required';
  end if;

  select * into v_activity from public.activities where id = p_activity_id;
  if v_activity.id is null then
    raise exception 'activity_not_found';
  end if;

  select * into v_lead from public.leads where id = v_activity.lead_id;

  if not private.has_workspace_role(
    v_activity.workspace_id, array['owner', 'admin', 'manager', 'lawyer', 'sales']::public.membership_role[]
  ) then
    raise exception 'insufficient_permission';
  end if;

  select role into v_role from public.memberships
  where workspace_id = v_activity.workspace_id and user_id = v_actor and status = 'active';

  if not private.lead_accessible_to_role(v_role, v_lead.assigned_to, v_actor) then
    raise exception 'activity_not_found';
  end if;

  if p_due_time is not null then
    v_due_at := ((p_due_date::text || ' ' || p_due_time::text)::timestamp) at time zone 'America/Sao_Paulo';
    v_has_time := true;
  else
    v_due_at := ((p_due_date::text || ' 23:59:59')::timestamp) at time zone 'America/Sao_Paulo';
    v_has_time := false;
  end if;

  update public.activities
  set due_at = v_due_at, has_time = v_has_time, lock_version = lock_version + 1
  where id = p_activity_id and lock_version = p_lock_version and status = 'pending'
  returning * into v_activity;

  if not found then
    raise exception 'activity_conflict';
  end if;

  insert into public.audit_logs (workspace_id, actor_user_id, action, resource_type, resource_id, metadata)
  values (
    v_activity.workspace_id, v_actor, 'activity.rescheduled', 'activity', p_activity_id,
    jsonb_build_object('due_at', v_due_at, 'has_time', v_has_time)
  );
end;
$body$;

revoke all on function public.reschedule_activity(uuid, bigint, date, time) from public;
grant execute on function public.reschedule_activity(uuid, bigint, date, time) to authenticated;

-- ---------------------------------------------------------------------
-- reassign_activity — transferir responsável (ou desatribuir, p_assigned_to
-- nulo). Sem restrição de status: transferir uma atividade já concluída
-- é permitido (só muda quem fica registrado como responsável, não reabre
-- a tarefa).
-- ---------------------------------------------------------------------

create function public.reassign_activity(
  p_activity_id uuid,
  p_lock_version bigint,
  p_assigned_to uuid default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_actor uuid := auth.uid();
  v_role public.membership_role;
  v_activity public.activities;
  v_lead public.leads;
begin
  if v_actor is null then
    raise exception 'authentication_required';
  end if;

  select * into v_activity from public.activities where id = p_activity_id;
  if v_activity.id is null then
    raise exception 'activity_not_found';
  end if;

  select * into v_lead from public.leads where id = v_activity.lead_id;

  if not private.has_workspace_role(
    v_activity.workspace_id, array['owner', 'admin', 'manager', 'lawyer', 'sales']::public.membership_role[]
  ) then
    raise exception 'insufficient_permission';
  end if;

  select role into v_role from public.memberships
  where workspace_id = v_activity.workspace_id and user_id = v_actor and status = 'active';

  if not private.lead_accessible_to_role(v_role, v_lead.assigned_to, v_actor) then
    raise exception 'activity_not_found';
  end if;

  perform private.check_activity_assignee(v_activity.workspace_id, v_lead.assigned_to, p_assigned_to);

  update public.activities
  set assigned_to = p_assigned_to, lock_version = lock_version + 1
  where id = p_activity_id and lock_version = p_lock_version
  returning * into v_activity;

  if not found then
    raise exception 'activity_conflict';
  end if;

  insert into public.audit_logs (workspace_id, actor_user_id, action, resource_type, resource_id, metadata)
  values (
    v_activity.workspace_id, v_actor, 'activity.reassigned', 'activity', p_activity_id,
    jsonb_build_object('assigned_to', p_assigned_to)
  );
end;
$body$;

revoke all on function public.reassign_activity(uuid, bigint, uuid) from public;
grant execute on function public.reassign_activity(uuid, bigint, uuid) to authenticated;

-- ---------------------------------------------------------------------
-- delete_activity — exclusão de verdade (não é um status). Sem
-- lock_version, mesmo padrão de delete_pipeline_stage/
-- delete_stage_requirement (excluir não tem "conflito", só existe ou não).
-- ---------------------------------------------------------------------

create function public.delete_activity(p_activity_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_actor uuid := auth.uid();
  v_role public.membership_role;
  v_activity public.activities;
  v_lead public.leads;
begin
  if v_actor is null then
    raise exception 'authentication_required';
  end if;

  select * into v_activity from public.activities where id = p_activity_id;
  if v_activity.id is null then
    raise exception 'activity_not_found';
  end if;

  select * into v_lead from public.leads where id = v_activity.lead_id;

  if not private.has_workspace_role(
    v_activity.workspace_id, array['owner', 'admin', 'manager', 'lawyer', 'sales']::public.membership_role[]
  ) then
    raise exception 'insufficient_permission';
  end if;

  select role into v_role from public.memberships
  where workspace_id = v_activity.workspace_id and user_id = v_actor and status = 'active';

  if not private.lead_accessible_to_role(v_role, v_lead.assigned_to, v_actor) then
    raise exception 'activity_not_found';
  end if;

  delete from public.activities where id = p_activity_id;

  insert into public.audit_logs (workspace_id, actor_user_id, action, resource_type, resource_id, metadata)
  values (v_activity.workspace_id, v_actor, 'activity.deleted', 'activity', p_activity_id, '{}'::jsonb);
end;
$body$;

revoke all on function public.delete_activity(uuid) from public;
grant execute on function public.delete_activity(uuid) to authenticated;
