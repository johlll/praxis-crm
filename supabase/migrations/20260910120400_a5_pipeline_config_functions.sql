-- A5 — configuração de pipeline: etapas, requisitos e motivos de perda.
--
-- Administrativo: owner/admin/manager apenas (mesmo nível de "configurar
-- pipelines" do plano, §7 — diferente de "movimentar oportunidades", que
-- também é permitido a lawyer/sales dentro do alcance deles).

-- ---------------------------------------------------------------------
-- create_pipeline_stage — nova etapa ao final do pipeline (position =
-- maior atual + 1), a menos que p_position seja informado.
-- ---------------------------------------------------------------------

create function public.create_pipeline_stage(
  p_pipeline_id uuid,
  p_name text,
  p_color text default null,
  p_position integer default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_actor uuid := auth.uid();
  v_workspace_id uuid;
  v_position integer;
  v_stage_id uuid;
begin
  if v_actor is null then
    raise exception 'authentication_required';
  end if;

  select workspace_id into v_workspace_id from public.pipelines where id = p_pipeline_id;
  if v_workspace_id is null then
    raise exception 'pipeline_not_found';
  end if;

  if not private.has_workspace_role(v_workspace_id, array['owner', 'admin', 'manager']::public.membership_role[]) then
    raise exception 'insufficient_permission';
  end if;

  if p_position is not null then
    v_position := p_position;
  else
    select coalesce(max(position) + 1, 0) into v_position
    from public.pipeline_stages where pipeline_id = p_pipeline_id;
  end if;

  insert into public.pipeline_stages (workspace_id, pipeline_id, name, position, color)
  values (v_workspace_id, p_pipeline_id, btrim(p_name), v_position, p_color)
  returning id into v_stage_id;

  insert into public.audit_logs (workspace_id, actor_user_id, action, resource_type, resource_id, metadata)
  values (v_workspace_id, v_actor, 'pipeline_stage.created', 'pipeline_stage', v_stage_id, jsonb_build_object('name', p_name));

  return v_stage_id;
end;
$body$;

revoke all on function public.create_pipeline_stage(uuid, text, text, integer) from public;
grant execute on function public.create_pipeline_stage(uuid, text, text, integer) to authenticated;

-- ---------------------------------------------------------------------
-- update_pipeline_stage — renomear/recolorir/marcar terminal. Marcar
-- is_won ou is_lost = true é recusado se a etapa tiver alguma
-- oportunidade ABERTA nela agora (ambiguidade: essa oportunidade deveria
-- estar ganha/perdida ou não?) — mover as oportunidades primeiro.
-- ---------------------------------------------------------------------

create function public.update_pipeline_stage(
  p_stage_id uuid,
  p_name text default null,
  p_color text default null,
  p_is_won boolean default null,
  p_is_lost boolean default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_actor uuid := auth.uid();
  v_stage public.pipeline_stages;
  v_open_count integer;
begin
  if v_actor is null then
    raise exception 'authentication_required';
  end if;

  select * into v_stage from public.pipeline_stages where id = p_stage_id;
  if v_stage.id is null then
    raise exception 'stage_not_found';
  end if;

  if not private.has_workspace_role(v_stage.workspace_id, array['owner', 'admin', 'manager']::public.membership_role[]) then
    raise exception 'insufficient_permission';
  end if;

  if (p_is_won is true and not v_stage.is_won) or (p_is_lost is true and not v_stage.is_lost) then
    select count(*) into v_open_count from public.opportunities
    where stage_id = p_stage_id and status = 'open';
    if v_open_count > 0 then
      raise exception 'stage_has_open_opportunities';
    end if;
  end if;

  if p_is_won is true and p_is_lost is true then
    raise exception 'stage_cannot_be_won_and_lost';
  end if;

  update public.pipeline_stages
  set name = coalesce(btrim(p_name), name),
      color = coalesce(p_color, color),
      is_won = coalesce(p_is_won, is_won),
      is_lost = coalesce(p_is_lost, is_lost)
  where id = p_stage_id;

  insert into public.audit_logs (workspace_id, actor_user_id, action, resource_type, resource_id, metadata)
  values (v_stage.workspace_id, v_actor, 'pipeline_stage.updated', 'pipeline_stage', p_stage_id, '{}'::jsonb);
end;
$body$;

revoke all on function public.update_pipeline_stage(uuid, text, text, boolean, boolean) from public;
grant execute on function public.update_pipeline_stage(uuid, text, text, boolean, boolean) to authenticated;

-- ---------------------------------------------------------------------
-- reorder_pipeline_stages — nova ordem completa, atomicamente. Rejeita
-- se o conjunto de IDs não bater exatamente com as etapas do pipeline
-- (nada perdido, nada de fora).
-- ---------------------------------------------------------------------

create function public.reorder_pipeline_stages(
  p_pipeline_id uuid,
  p_ordered_stage_ids uuid[]
)
returns void
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_actor uuid := auth.uid();
  v_workspace_id uuid;
  v_expected_count integer;
  v_stage_id uuid;
  v_position integer := 0;
begin
  if v_actor is null then
    raise exception 'authentication_required';
  end if;

  select workspace_id into v_workspace_id from public.pipelines where id = p_pipeline_id;
  if v_workspace_id is null then
    raise exception 'pipeline_not_found';
  end if;

  if not private.has_workspace_role(v_workspace_id, array['owner', 'admin', 'manager']::public.membership_role[]) then
    raise exception 'insufficient_permission';
  end if;

  select count(*) into v_expected_count from public.pipeline_stages where pipeline_id = p_pipeline_id;
  if v_expected_count <> array_length(p_ordered_stage_ids, 1)
     or v_expected_count <> (
       select count(*) from public.pipeline_stages
       where pipeline_id = p_pipeline_id and id = any(p_ordered_stage_ids)
     )
  then
    raise exception 'stage_set_mismatch';
  end if;

  -- Desloca todas as posições para fora da faixa usada primeiro — evita
  -- colidir com o índice único (pipeline_id, position) ao reatribuir.
  update public.pipeline_stages set position = position + v_expected_count where pipeline_id = p_pipeline_id;

  foreach v_stage_id in array p_ordered_stage_ids
  loop
    update public.pipeline_stages set position = v_position where id = v_stage_id;
    v_position := v_position + 1;
  end loop;

  insert into public.audit_logs (workspace_id, actor_user_id, action, resource_type, resource_id, metadata)
  values (v_workspace_id, v_actor, 'pipeline.stages_reordered', 'pipeline', p_pipeline_id, '{}'::jsonb);
end;
$body$;

revoke all on function public.reorder_pipeline_stages(uuid, uuid[]) from public;
grant execute on function public.reorder_pipeline_stages(uuid, uuid[]) to authenticated;

-- ---------------------------------------------------------------------
-- delete_pipeline_stage — recusa se a etapa tiver QUALQUER oportunidade
-- vinculada (aberta, ganha ou perdida — o histórico continua
-- referenciando a etapa). Mensagem específica, não o erro cru de FK.
-- ---------------------------------------------------------------------

create function public.delete_pipeline_stage(p_stage_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_actor uuid := auth.uid();
  v_stage public.pipeline_stages;
begin
  if v_actor is null then
    raise exception 'authentication_required';
  end if;

  select * into v_stage from public.pipeline_stages where id = p_stage_id;
  if v_stage.id is null then
    raise exception 'stage_not_found';
  end if;

  if not private.has_workspace_role(v_stage.workspace_id, array['owner', 'admin', 'manager']::public.membership_role[]) then
    raise exception 'insufficient_permission';
  end if;

  if exists (select 1 from public.opportunities where stage_id = p_stage_id) then
    raise exception 'stage_occupied';
  end if;

  delete from public.pipeline_stages where id = p_stage_id;

  insert into public.audit_logs (workspace_id, actor_user_id, action, resource_type, resource_id, metadata)
  values (v_stage.workspace_id, v_actor, 'pipeline_stage.deleted', 'pipeline_stage', p_stage_id, '{}'::jsonb);
end;
$body$;

revoke all on function public.delete_pipeline_stage(uuid) from public;
grant execute on function public.delete_pipeline_stage(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- create_stage_requirement / delete_stage_requirement
-- ---------------------------------------------------------------------

create function public.create_stage_requirement(
  p_stage_id uuid,
  p_label text,
  p_field_type public.stage_requirement_type,
  p_hint text default null,
  p_position integer default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_actor uuid := auth.uid();
  v_workspace_id uuid;
  v_position integer;
  v_requirement_id uuid;
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

  if p_position is not null then
    v_position := p_position;
  else
    select coalesce(max(position) + 1, 0) into v_position
    from public.stage_requirements where stage_id = p_stage_id;
  end if;

  insert into public.stage_requirements (workspace_id, stage_id, label, field_type, hint, position)
  values (v_workspace_id, p_stage_id, btrim(p_label), p_field_type, nullif(btrim(coalesce(p_hint, '')), ''), v_position)
  returning id into v_requirement_id;

  insert into public.audit_logs (workspace_id, actor_user_id, action, resource_type, resource_id, metadata)
  values (v_workspace_id, v_actor, 'stage_requirement.created', 'stage_requirement', v_requirement_id, '{}'::jsonb);

  return v_requirement_id;
end;
$body$;

revoke all on function public.create_stage_requirement(uuid, text, public.stage_requirement_type, text, integer) from public;
grant execute on function public.create_stage_requirement(uuid, text, public.stage_requirement_type, text, integer) to authenticated;

create function public.delete_stage_requirement(p_requirement_id uuid)
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

  select workspace_id into v_workspace_id from public.stage_requirements where id = p_requirement_id;
  if v_workspace_id is null then
    raise exception 'requirement_not_found';
  end if;

  if not private.has_workspace_role(v_workspace_id, array['owner', 'admin', 'manager']::public.membership_role[]) then
    raise exception 'insufficient_permission';
  end if;

  -- Requisito pode ser removido mesmo com respostas já gravadas — o
  -- histórico dessas respostas cai junto (on delete cascade), e novas
  -- transições simplesmente não checam mais este requisito.
  delete from public.stage_requirements where id = p_requirement_id;

  insert into public.audit_logs (workspace_id, actor_user_id, action, resource_type, resource_id, metadata)
  values (v_workspace_id, v_actor, 'stage_requirement.deleted', 'stage_requirement', p_requirement_id, '{}'::jsonb);
end;
$body$;

revoke all on function public.delete_stage_requirement(uuid) from public;
grant execute on function public.delete_stage_requirement(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- create_lost_reason / deactivate_lost_reason — desativado, nunca
-- excluído (mesmo espírito de "não apagar etapa ocupada"): um motivo já
-- usado por uma oportunidade perdida não pode sumir do histórico.
-- ---------------------------------------------------------------------

create function public.create_lost_reason(p_workspace_id uuid, p_label text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_actor uuid := auth.uid();
  v_reason_id uuid;
  v_position integer;
begin
  if v_actor is null then
    raise exception 'authentication_required';
  end if;

  if not private.has_workspace_role(p_workspace_id, array['owner', 'admin', 'manager']::public.membership_role[]) then
    raise exception 'insufficient_permission';
  end if;

  select coalesce(max(position) + 1, 0) into v_position from public.lost_reasons where workspace_id = p_workspace_id;

  insert into public.lost_reasons (workspace_id, label, position)
  values (p_workspace_id, btrim(p_label), v_position)
  returning id into v_reason_id;

  insert into public.audit_logs (workspace_id, actor_user_id, action, resource_type, resource_id, metadata)
  values (p_workspace_id, v_actor, 'lost_reason.created', 'lost_reason', v_reason_id, jsonb_build_object('label', p_label));

  return v_reason_id;
end;
$body$;

revoke all on function public.create_lost_reason(uuid, text) from public;
grant execute on function public.create_lost_reason(uuid, text) to authenticated;

create function public.deactivate_lost_reason(p_lost_reason_id uuid)
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

  select workspace_id into v_workspace_id from public.lost_reasons where id = p_lost_reason_id;
  if v_workspace_id is null then
    raise exception 'lost_reason_not_found';
  end if;

  if not private.has_workspace_role(v_workspace_id, array['owner', 'admin', 'manager']::public.membership_role[]) then
    raise exception 'insufficient_permission';
  end if;

  update public.lost_reasons set active = false where id = p_lost_reason_id;

  insert into public.audit_logs (workspace_id, actor_user_id, action, resource_type, resource_id, metadata)
  values (v_workspace_id, v_actor, 'lost_reason.deactivated', 'lost_reason', p_lost_reason_id, '{}'::jsonb);
end;
$body$;

revoke all on function public.deactivate_lost_reason(uuid) from public;
grant execute on function public.deactivate_lost_reason(uuid) to authenticated;
