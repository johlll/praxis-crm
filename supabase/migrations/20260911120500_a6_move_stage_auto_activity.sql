-- A6 — item 4 do pedido: atividade automática ao mudar de etapa.
--
-- CREATE OR REPLACE de move_opportunity_stage() — MESMA assinatura da
-- versão vigente (20260910130000_a5_block_move_to_terminal_stage.sql),
-- nenhuma migration já aplicada foi alterada. Corpo idêntico ao anterior
-- até logo depois do INSERT em stage_transitions; dali em diante, busca a
-- regra (no máximo uma) da etapa de DESTINO e, se existir, cria a
-- atividade — sempre DEPOIS de todo raise exception possível e do UPDATE
-- que já teria abortado a transação inteira num conflito, então "movimento
-- recusado, requisito pendente ou conflito não geram atividade" é
-- automático (rollback de toda a função, não só desta parte).
--
-- Idempotência: on conflict (source_stage_transition_id) do nothing —
-- redundante com o fato de v_transition_id ser sempre novo aqui (acabou
-- de nascer no INSERT anterior, dentro da mesma transação), mas mantido
-- como reforço explícito pedido ("mesmo em reenvios ou chamadas
-- concorrentes").

create or replace function public.move_opportunity_stage(
  p_opportunity_id uuid,
  p_from_stage_id uuid,
  p_to_stage_id uuid,
  p_lock_version bigint,
  p_requirement_values jsonb default '[]'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_actor uuid := auth.uid();
  v_role public.membership_role;
  v_opportunity public.opportunities;
  v_lead public.leads;
  v_from_position integer;
  v_to_position integer;
  v_to_is_won boolean;
  v_to_is_lost boolean;
  v_missing_count integer;
  v_seconds_in_stage bigint;
  v_item jsonb;
  v_req record;
  v_transition_id uuid;
  v_rule public.stage_auto_activity_rules;
  v_activity_assignee uuid;
  v_activity_id uuid;
begin
  if v_actor is null then
    raise exception 'authentication_required';
  end if;

  select * into v_opportunity from public.opportunities where id = p_opportunity_id;
  if v_opportunity.id is null then
    raise exception 'opportunity_not_found';
  end if;

  select * into v_lead from public.leads where id = v_opportunity.lead_id;

  if not private.has_workspace_role(
    v_opportunity.workspace_id, array['owner', 'admin', 'manager', 'lawyer', 'sales']::public.membership_role[]
  ) then
    raise exception 'insufficient_permission';
  end if;

  select role into v_role from public.memberships
  where workspace_id = v_opportunity.workspace_id and user_id = v_actor and status = 'active';

  if not private.lead_accessible_to_role(v_role, v_lead.assigned_to, v_actor) then
    raise exception 'opportunity_not_found';
  end if;

  if v_opportunity.status <> 'open' then
    raise exception 'opportunity_closed';
  end if;

  if v_opportunity.stage_id <> p_from_stage_id then
    raise exception 'stage_mismatch';
  end if;

  select position, is_won, is_lost into v_to_position, v_to_is_won, v_to_is_lost
  from public.pipeline_stages
  where id = p_to_stage_id and pipeline_id = v_opportunity.pipeline_id;

  if v_to_position is null then
    raise exception 'stage_not_in_pipeline';
  end if;

  if v_to_is_won or v_to_is_lost then
    raise exception 'stage_is_terminal';
  end if;

  select position into v_from_position from public.pipeline_stages where id = p_from_stage_id;

  if v_from_position = v_to_position then
    raise exception 'stage_unchanged';
  end if;

  for v_item in select * from jsonb_array_elements(coalesce(p_requirement_values, '[]'::jsonb))
  loop
    select * into v_req from public.stage_requirements
    where id = (v_item ->> 'requirement_id')::uuid and workspace_id = v_opportunity.workspace_id;
    if v_req.id is null then
      continue;
    end if;

    insert into public.opportunity_requirement_values (
      workspace_id, opportunity_id, requirement_id, value_text, value_bool
    )
    values (
      v_opportunity.workspace_id, p_opportunity_id, v_req.id,
      case when v_req.field_type <> 'checkbox' then nullif(btrim(coalesce(v_item ->> 'value_text', '')), '') end,
      case when v_req.field_type = 'checkbox' then (v_item ->> 'value_bool')::boolean end
    )
    on conflict (opportunity_id, requirement_id) do update
      set value_text = excluded.value_text, value_bool = excluded.value_bool, updated_at = now();
  end loop;

  if v_to_position > v_from_position then
    select count(*) into v_missing_count
    from public.stage_requirements sr
    where sr.workspace_id = v_opportunity.workspace_id
      and sr.stage_id in (
        select id from public.pipeline_stages
        where pipeline_id = v_opportunity.pipeline_id
          and position > v_from_position and position <= v_to_position
      )
      and not exists (
        select 1 from public.opportunity_requirement_values orv
        where orv.opportunity_id = p_opportunity_id
          and orv.requirement_id = sr.id
          and (
            (sr.field_type = 'checkbox' and orv.value_bool is true)
            or (sr.field_type <> 'checkbox' and orv.value_text is not null and btrim(orv.value_text) <> '')
          )
      );

    if v_missing_count > 0 then
      raise exception 'stage_requirements_pending';
    end if;
  end if;

  v_seconds_in_stage := extract(epoch from (now() - v_opportunity.stage_entered_at))::bigint;

  update public.opportunities
  set stage_id = p_to_stage_id,
      stage_entered_at = now(),
      lock_version = lock_version + 1
  where id = p_opportunity_id and lock_version = p_lock_version and status = 'open'
  returning * into v_opportunity;

  if not found then
    raise exception 'opportunity_conflict';
  end if;

  insert into public.stage_transitions (
    workspace_id, opportunity_id, from_stage_id, to_stage_id, actor_user_id, seconds_in_previous_stage
  )
  values (
    v_opportunity.workspace_id, p_opportunity_id, p_from_stage_id, p_to_stage_id, v_actor, v_seconds_in_stage
  )
  returning id into v_transition_id;

  -- A6 — atividade automática: no máximo uma regra por etapa de destino.
  -- Nada acontece se não houver regra configurada para p_to_stage_id.
  select * into v_rule from public.stage_auto_activity_rules where stage_id = p_to_stage_id;

  if v_rule.id is not null then
    v_activity_assignee := case when v_rule.assignee_rule = 'lead_owner' then v_lead.assigned_to else null end;

    insert into public.activities (
      workspace_id, lead_id, opportunity_id, type, title, assigned_to, due_at, has_time,
      status, source, source_stage_transition_id, source_rule_id
    )
    values (
      v_opportunity.workspace_id, v_opportunity.lead_id, p_opportunity_id, v_rule.activity_type, v_rule.title,
      v_activity_assignee, now() + make_interval(hours => v_rule.due_offset_hours), true,
      'pending', 'stage_rule', v_transition_id, v_rule.id
    )
    on conflict (source_stage_transition_id) do nothing
    returning id into v_activity_id;

    if v_activity_id is not null then
      insert into public.audit_logs (workspace_id, actor_user_id, action, resource_type, resource_id, metadata)
      values (
        v_opportunity.workspace_id, v_actor, 'activity.auto_created', 'activity', v_activity_id,
        jsonb_build_object('rule_id', v_rule.id, 'stage_transition_id', v_transition_id, 'opportunity_id', p_opportunity_id)
      );
    end if;
  end if;

  insert into public.audit_logs (workspace_id, actor_user_id, action, resource_type, resource_id, metadata)
  values (
    v_opportunity.workspace_id, v_actor, 'opportunity.stage_moved', 'opportunity', p_opportunity_id,
    jsonb_build_object('from_stage_id', p_from_stage_id, 'to_stage_id', p_to_stage_id)
  );

  return jsonb_build_object(
    'id', v_opportunity.id,
    'stage_id', v_opportunity.stage_id,
    'stage_entered_at', v_opportunity.stage_entered_at,
    'lock_version', v_opportunity.lock_version
  );
end;
$body$;

revoke all on function public.move_opportunity_stage(uuid, uuid, uuid, bigint, jsonb) from public;
grant execute on function public.move_opportunity_stage(uuid, uuid, uuid, bigint, jsonb) to authenticated;
