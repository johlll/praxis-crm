-- A6 — configuração de atividade automática por etapa. Administrativo:
-- owner/admin/manager apenas (mesmo nível de pipeline.configure/
-- create_stage_requirement na A5).
--
-- Configuração MÍNIMA por etapa: no máximo uma regra (unique(stage_id) na
-- tabela) — "definir" é sempre um upsert (cria se não existe, substitui
-- se já existe), não uma lista com criar/editar/excluir separados por
-- item.

-- ---------------------------------------------------------------------
-- set_stage_auto_activity_rule — cria ou substitui a regra da etapa.
-- ---------------------------------------------------------------------

create function public.set_stage_auto_activity_rule(
  p_stage_id uuid,
  p_activity_type public.activity_type,
  p_title text,
  p_due_offset_hours integer default 24,
  p_assignee_rule public.activity_assignee_rule default 'lead_owner'
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_actor uuid := auth.uid();
  v_workspace_id uuid;
  v_rule_id uuid;
begin
  if v_actor is null then
    raise exception 'authentication_required';
  end if;

  select workspace_id into v_workspace_id from public.pipeline_stages where id = p_stage_id;
  if v_workspace_id is null then
    raise exception 'stage_not_found';
  end if;

  if not private.has_workspace_role(v_workspace_id, array['owner', 'admin', 'manager']::public.membership_role[]) then
    raise exception 'insufficient_permission';
  end if;

  if p_due_offset_hours is null or p_due_offset_hours < 0 or p_due_offset_hours > 720 then
    raise exception 'invalid_value';
  end if;

  insert into public.stage_auto_activity_rules (
    workspace_id, stage_id, activity_type, title, due_offset_hours, assignee_rule
  )
  values (
    v_workspace_id, p_stage_id, p_activity_type, btrim(p_title), p_due_offset_hours,
    coalesce(p_assignee_rule, 'lead_owner')
  )
  on conflict (stage_id) do update
    set activity_type = excluded.activity_type,
        title = excluded.title,
        due_offset_hours = excluded.due_offset_hours,
        assignee_rule = excluded.assignee_rule,
        updated_at = now()
  returning id into v_rule_id;

  insert into public.audit_logs (workspace_id, actor_user_id, action, resource_type, resource_id, metadata)
  values (
    v_workspace_id, v_actor, 'stage_auto_activity_rule.set', 'stage_auto_activity_rule', v_rule_id,
    jsonb_build_object('stage_id', p_stage_id, 'activity_type', p_activity_type)
  );

  return v_rule_id;
end;
$body$;

revoke all on function public.set_stage_auto_activity_rule(uuid, public.activity_type, text, integer, public.activity_assignee_rule) from public;
grant execute on function public.set_stage_auto_activity_rule(uuid, public.activity_type, text, integer, public.activity_assignee_rule) to authenticated;

-- ---------------------------------------------------------------------
-- delete_stage_auto_activity_rule — remove a regra da etapa (etapa fica
-- sem atividade automática; nenhuma atividade já criada é afetada, ela só
-- perde a referência da regra — on delete set null na FK, migration de
-- schema).
-- ---------------------------------------------------------------------

create function public.delete_stage_auto_activity_rule(p_stage_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_actor uuid := auth.uid();
  v_workspace_id uuid;
begin
  if v_actor is null then
    raise exception 'authentication_required';
  end if;

  select workspace_id into v_workspace_id from public.pipeline_stages where id = p_stage_id;
  if v_workspace_id is null then
    raise exception 'stage_not_found';
  end if;

  if not private.has_workspace_role(v_workspace_id, array['owner', 'admin', 'manager']::public.membership_role[]) then
    raise exception 'insufficient_permission';
  end if;

  delete from public.stage_auto_activity_rules where stage_id = p_stage_id;

  insert into public.audit_logs (workspace_id, actor_user_id, action, resource_type, resource_id, metadata)
  values (
    v_workspace_id, v_actor, 'stage_auto_activity_rule.deleted', 'stage_auto_activity_rule', p_stage_id, '{}'::jsonb
  );
end;
$body$;

revoke all on function public.delete_stage_auto_activity_rule(uuid) from public;
grant execute on function public.delete_stage_auto_activity_rule(uuid) to authenticated;
