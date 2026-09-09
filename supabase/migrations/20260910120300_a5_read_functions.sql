-- A5 — funções de leitura: detalhe, tabela, board do kanban.
--
-- As três aplicam o MESMO alcance por registro (private.
-- lead_accessible_to_role, herdado do lead pai) e a MESMA projeção
-- financeira por papel (private.opportunity_financial_projection /
-- private.opportunity_column_sum_projection, migration anterior) — em
-- TODOS os caminhos: detalhe, card, tabela e agregados de coluna.

-- ---------------------------------------------------------------------
-- get_opportunity — detalhe completo, incluindo requisitos preenchidos
-- e o histórico de transições (ambos escopados pelo mesmo alcance,
-- porque só chegam aqui depois do 'opportunity_not_found' acima).
-- ---------------------------------------------------------------------

create function public.get_opportunity(p_opportunity_id uuid)
returns jsonb
language plpgsql
security definer
stable
set search_path = ''
as $body$
declare
  v_actor uuid := auth.uid();
  v_role public.membership_role;
  v_opportunity public.opportunities;
  v_lead public.leads;
  v_contact_name text;
  v_assigned_to_name text;
  v_stage_name text;
  v_pipeline_name text;
  v_lost_reason_label text;
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
    v_opportunity.workspace_id,
    array['owner', 'admin', 'manager', 'lawyer', 'sales', 'viewer']::public.membership_role[]
  ) then
    raise exception 'insufficient_permission';
  end if;

  select role into v_role from public.memberships
  where workspace_id = v_opportunity.workspace_id and user_id = v_actor and status = 'active';

  if not private.lead_accessible_to_role(v_role, v_lead.assigned_to, v_actor) then
    raise exception 'opportunity_not_found';
  end if;

  select c.name into v_contact_name from public.contacts c where c.id = v_lead.contact_id;
  select u.full_name into v_assigned_to_name from public.users u where u.id = v_lead.assigned_to;
  select name into v_stage_name from public.pipeline_stages where id = v_opportunity.stage_id;
  select name into v_pipeline_name from public.pipelines where id = v_opportunity.pipeline_id;
  select label into v_lost_reason_label from public.lost_reasons where id = v_opportunity.lost_reason_id;

  return jsonb_build_object(
    'id', v_opportunity.id,
    'workspace_id', v_opportunity.workspace_id,
    'lead_id', v_opportunity.lead_id,
    'contact_name', v_contact_name,
    'legal_area', v_lead.legal_area,
    'assigned_to', v_lead.assigned_to,
    'assigned_to_name', v_assigned_to_name,
    'pipeline_id', v_opportunity.pipeline_id,
    'pipeline_name', v_pipeline_name,
    'stage_id', v_opportunity.stage_id,
    'stage_name', v_stage_name,
    'stage_entered_at', v_opportunity.stage_entered_at,
    'status', v_opportunity.status,
    'lost_reason_id', v_opportunity.lost_reason_id,
    'lost_reason_label', v_lost_reason_label,
    'lost_note', v_opportunity.lost_note,
    'lost_followup_date', v_opportunity.lost_followup_date,
    'won_at', v_opportunity.won_at,
    'signed_at', v_opportunity.signed_at,
    'lock_version', v_opportunity.lock_version,
    'created_at', v_opportunity.created_at,
    'updated_at', v_opportunity.updated_at,
    'requirement_values', (
      -- Todo requisito já preenchido para esta oportunidade, de qualquer
      -- etapa do pipeline (histórico completo, não só da etapa atual) —
      -- para exibir no perfil da oportunidade. Para saber o que FALTA
      -- antes de avançar para uma etapa específica, ver
      -- get_stage_requirements_status().
      select coalesce(jsonb_agg(jsonb_build_object(
        'requirement_id', sr.id,
        'stage_id', sr.stage_id,
        'label', sr.label,
        'field_type', sr.field_type,
        'value_text', orv.value_text,
        'value_bool', orv.value_bool
      ) order by sr.position), '[]'::jsonb)
      from public.opportunity_requirement_values orv
      join public.stage_requirements sr on sr.id = orv.requirement_id
      where orv.opportunity_id = v_opportunity.id
    ),
    'history', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'from_stage_id', st.from_stage_id,
        'to_stage_id', st.to_stage_id,
        'actor_user_id', st.actor_user_id,
        'occurred_at', st.occurred_at,
        'seconds_in_previous_stage', st.seconds_in_previous_stage
      ) order by st.occurred_at desc), '[]'::jsonb)
      from public.stage_transitions st
      where st.opportunity_id = v_opportunity.id
    )
  ) || private.opportunity_financial_projection(
    v_role, v_opportunity.value_cents, v_opportunity.fee_model, v_opportunity.probability, v_opportunity.forecast_date
  );
end;
$body$;

revoke all on function public.get_opportunity(uuid) from public;
grant execute on function public.get_opportunity(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- get_stage_requirements_status — o que falta preencher para avançar de
-- p_from_stage_id até p_to_stage_id (todas as etapas no caminho, mesma
-- regra de bloqueio de move_opportunity_stage — chamada pela UI ANTES
-- de tentar mover, para desenhar o StageAdvanceDialog do protótipo).
-- Voltar (destino com position menor) nunca tem requisito: retorna lista
-- vazia.
-- ---------------------------------------------------------------------

create function public.get_stage_requirements_status(
  p_opportunity_id uuid,
  p_to_stage_id uuid
)
returns jsonb
language plpgsql
security definer
stable
set search_path = ''
as $body$
declare
  v_actor uuid := auth.uid();
  v_role public.membership_role;
  v_opportunity public.opportunities;
  v_lead public.leads;
  v_from_position integer;
  v_to_position integer;
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
    v_opportunity.workspace_id,
    array['owner', 'admin', 'manager', 'lawyer', 'sales', 'viewer']::public.membership_role[]
  ) then
    raise exception 'insufficient_permission';
  end if;

  select role into v_role from public.memberships
  where workspace_id = v_opportunity.workspace_id and user_id = v_actor and status = 'active';

  if not private.lead_accessible_to_role(v_role, v_lead.assigned_to, v_actor) then
    raise exception 'opportunity_not_found';
  end if;

  select position into v_from_position from public.pipeline_stages where id = v_opportunity.stage_id;
  select position into v_to_position from public.pipeline_stages where id = p_to_stage_id;

  if v_to_position is null or v_to_position <= v_from_position then
    return '[]'::jsonb;
  end if;

  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'requirement_id', sr.id,
      'stage_id', sr.stage_id,
      'stage_name', ps.name,
      'label', sr.label,
      'field_type', sr.field_type,
      'hint', sr.hint,
      'value_text', orv.value_text,
      'value_bool', orv.value_bool,
      'filled', case
        when sr.field_type = 'checkbox' then orv.value_bool is true
        else orv.value_text is not null and btrim(orv.value_text) <> ''
      end
    ) order by ps.position, sr.position)
    from public.stage_requirements sr
    join public.pipeline_stages ps on ps.id = sr.stage_id
    left join public.opportunity_requirement_values orv
      on orv.requirement_id = sr.id and orv.opportunity_id = p_opportunity_id
    where ps.pipeline_id = v_opportunity.pipeline_id
      and ps.position > v_from_position and ps.position <= v_to_position
  ), '[]'::jsonb);
end;
$body$;

revoke all on function public.get_stage_requirements_status(uuid, uuid) from public;
grant execute on function public.get_stage_requirements_status(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------
-- list_opportunities — visão tabela. Mesmo alcance e mesma projeção
-- financeira do board (mesmas consultas e regras, diferente só a forma
-- de apresentação, como pedido).
-- ---------------------------------------------------------------------

create function public.list_opportunities(
  p_workspace_id uuid,
  p_pipeline_id uuid default null,
  p_stage_id uuid default null,
  p_status public.opportunity_status default null,
  p_search text default null,
  p_sort text default 'created_at_desc',
  p_page integer default 1,
  p_page_size integer default 20
)
returns table (items jsonb, total_count bigint)
language plpgsql
security definer
stable
set search_path = ''
as $body$
declare
  v_actor uuid := auth.uid();
  v_role public.membership_role;
  v_page_size integer;
  v_offset integer;
begin
  if v_actor is null then
    raise exception 'authentication_required';
  end if;

  if not private.has_workspace_role(
    p_workspace_id,
    array['owner', 'admin', 'manager', 'lawyer', 'sales', 'viewer']::public.membership_role[]
  ) then
    raise exception 'insufficient_permission';
  end if;

  select role into v_role from public.memberships
  where workspace_id = p_workspace_id and user_id = v_actor and status = 'active';

  v_page_size := greatest(1, least(coalesce(p_page_size, 20), 100));
  v_offset := (greatest(1, coalesce(p_page, 1)) - 1) * v_page_size;

  return query
  with ranked as (
    select
      o.id, o.lead_id, o.pipeline_id, o.stage_id, o.status,
      o.value_cents, o.fee_model, o.probability, o.forecast_date,
      o.stage_entered_at, o.created_at, o.updated_at,
      l.legal_area, l.assigned_to, c.name as contact_name, u.full_name as assigned_to_name,
      ps.name as stage_name,
      count(*) over () as full_count,
      row_number() over (
        order by
          case when p_sort = 'created_at_asc' then o.created_at end asc,
          case when p_sort is null or p_sort = 'created_at_desc' then o.created_at end desc,
          o.id asc
      ) as rn
    from public.opportunities o
    join public.leads l on l.id = o.lead_id
    join public.contacts c on c.id = l.contact_id
    join public.pipeline_stages ps on ps.id = o.stage_id
    left join public.users u on u.id = l.assigned_to
    where o.workspace_id = p_workspace_id
      and private.lead_accessible_to_role(v_role, l.assigned_to, v_actor)
      and (p_pipeline_id is null or o.pipeline_id = p_pipeline_id)
      and (p_stage_id is null or o.stage_id = p_stage_id)
      and (p_status is null or o.status = p_status)
      and (
        p_search is null or btrim(p_search) = ''
        or c.name ilike '%' || btrim(p_search) || '%'
        or l.legal_area ilike '%' || btrim(p_search) || '%'
      )
  ),
  page as (
    select * from ranked where rn > v_offset and rn <= v_offset + v_page_size
  )
  select
    coalesce(
      (
        select jsonb_agg(
          jsonb_build_object(
            'id', p.id, 'lead_id', p.lead_id, 'contact_name', p.contact_name,
            'legal_area', p.legal_area, 'assigned_to', p.assigned_to, 'assigned_to_name', p.assigned_to_name,
            'pipeline_id', p.pipeline_id, 'stage_id', p.stage_id, 'stage_name', p.stage_name,
            'status', p.status, 'stage_entered_at', p.stage_entered_at,
            'created_at', p.created_at, 'updated_at', p.updated_at
          ) || private.opportunity_financial_projection(v_role, p.value_cents, p.fee_model, p.probability, p.forecast_date)
          order by p.rn
        )
        from page p
      ),
      '[]'::jsonb
    ),
    coalesce((select r.full_count from ranked r limit 1), 0);
end;
$body$;

revoke all on function public.list_opportunities(uuid, uuid, uuid, public.opportunity_status, text, text, integer, integer) from public;
grant execute on function public.list_opportunities(uuid, uuid, uuid, public.opportunity_status, text, text, integer, integer) to authenticated;

-- ---------------------------------------------------------------------
-- get_pipeline_board — visão kanban: uma entrada por etapa, com os
-- cards já filtrados pelo alcance e a soma financeira projetada pelo
-- papel de quem chama (nunca uma média de faixas, nunca inventada —
-- omitida por completo quando o papel não tem projeção agregada
-- aprovada). Tempo médio na etapa vem de stage_entered_at, dado real; SEM
-- contagem de atrasadas (não existe fonte de atividades antes da A6).
-- ---------------------------------------------------------------------

create function public.get_pipeline_board(p_pipeline_id uuid)
returns jsonb
language plpgsql
security definer
stable
set search_path = ''
as $body$
declare
  v_actor uuid := auth.uid();
  v_role public.membership_role;
  v_workspace_id uuid;
begin
  if v_actor is null then
    raise exception 'authentication_required';
  end if;

  select workspace_id into v_workspace_id from public.pipelines where id = p_pipeline_id;
  if v_workspace_id is null then
    raise exception 'pipeline_not_found';
  end if;

  if not private.has_workspace_role(
    v_workspace_id,
    array['owner', 'admin', 'manager', 'lawyer', 'sales', 'viewer']::public.membership_role[]
  ) then
    raise exception 'insufficient_permission';
  end if;

  select role into v_role from public.memberships
  where workspace_id = v_workspace_id and user_id = v_actor and status = 'active';

  return coalesce((
    select jsonb_agg(
      jsonb_build_object(
        'stage_id', ps.id,
        'stage_name', ps.name,
        'position', ps.position,
        'color', ps.color,
        'is_won', ps.is_won,
        'is_lost', ps.is_lost,
        'count', coalesce(visible.card_count, 0),
        'avg_seconds_in_stage', visible.avg_seconds_in_stage,
        'cards', coalesce(visible.cards, '[]'::jsonb)
      ) || private.opportunity_column_sum_projection(v_role, visible.sum_cents)
      order by ps.position
    )
    from public.pipeline_stages ps
    left join lateral (
      select
        count(*) as card_count,
        sum(o.value_cents) filter (where o.value_cents is not null)::bigint as sum_cents,
        avg(extract(epoch from (now() - o.stage_entered_at)))::bigint as avg_seconds_in_stage,
        jsonb_agg(
          jsonb_build_object(
            'id', o.id, 'lead_id', o.lead_id, 'contact_name', c.name,
            'legal_area', l.legal_area, 'assigned_to', l.assigned_to, 'assigned_to_name', u.full_name,
            'stage_entered_at', o.stage_entered_at, 'lock_version', o.lock_version
          ) || private.opportunity_financial_projection(v_role, o.value_cents, o.fee_model, o.probability, o.forecast_date)
          order by o.stage_entered_at asc
        ) as cards
      from public.opportunities o
      join public.leads l on l.id = o.lead_id
      join public.contacts c on c.id = l.contact_id
      left join public.users u on u.id = l.assigned_to
      where o.stage_id = ps.id
        and o.status = 'open'
        and private.lead_accessible_to_role(v_role, l.assigned_to, v_actor)
    ) visible on true
    where ps.pipeline_id = p_pipeline_id
  ), '[]'::jsonb);
end;
$body$;

revoke all on function public.get_pipeline_board(uuid) from public;
grant execute on function public.get_pipeline_board(uuid) to authenticated;
