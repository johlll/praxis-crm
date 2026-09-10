-- A5 — correção de rascunho: move_opportunity_stage() checava requisitos
-- pendentes ANTES de gravar os valores recebidos na mesma chamada — a
-- primeira tentativa de "preencher e avançar" (a UI não faz duas idas ao
-- servidor) sempre via os requisitos como pendentes, porque o que
-- acabara de chegar ainda não tinha sido gravado quando a checagem
-- rodou. Corrigido invertendo a ordem: grava primeiro, checa depois —
-- ainda na mesma transação da função, então uma recusa continua sem
-- efeito parcial (tudo reverte junto). Mesma assinatura, só o corpo
-- muda (CREATE OR REPLACE).

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
  v_missing_count integer;
  v_seconds_in_stage bigint;
  v_item jsonb;
  v_req record;
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

  if not exists (
    select 1 from public.pipeline_stages where id = p_to_stage_id and pipeline_id = v_opportunity.pipeline_id
  ) then
    raise exception 'stage_not_in_pipeline';
  end if;

  select position into v_from_position from public.pipeline_stages where id = p_from_stage_id;
  select position into v_to_position from public.pipeline_stages where id = p_to_stage_id;

  if v_from_position = v_to_position then
    raise exception 'stage_unchanged';
  end if;

  -- Grava os valores de requisito enviados junto com o movimento ANTES
  -- de checar o que está pendente — preencher e avançar são a mesma
  -- chamada (a UI não faz duas idas ao servidor), então a checagem
  -- precisa enxergar o que acabou de chegar, não só o que já existia de
  -- tentativas anteriores. O servidor não confia que o que chegou é
  -- suficiente: quem decide isso é a checagem logo abaixo.
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

  -- Só ao AVANÇAR: os requisitos de toda etapa entre a atual (exclusive)
  -- e o destino (inclusive) precisam estar satisfeitos — pular colunas
  -- não contorna o requisito de nenhuma delas. Voltar nunca é bloqueado.
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
  );

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
