-- A6 — item 3 do pedido: "próxima ação" real nas oportunidades.
--
-- private.opportunity_next_action() — mesma convenção das projeções da
-- A5 (opportunity_financial_projection/opportunity_column_sum_projection):
-- função SQL simples, SEM security definer própria (roda com o privilégio
-- de quem já a chamou — sempre uma função SECURITY DEFINER da A5/A6 que já
-- validou o alcance antes), reaproveitada via "||" no jsonb de saída.
--
-- "Próxima ação" = a atividade PENDENTE mais próxima cujo due_at ainda
-- não passou (due_at >= now()) — nunca uma atrasada (essa aparece à parte,
-- em overdue_count, exatamente como pedido: "atividades vencidas devem
-- aparecer como pendência atrasada, sem desaparecer por estarem no
-- passado" — não devem se DISFARÇAR de próxima ação, mas também não
-- devem sumir; overdue_count garante que elas continuam visíveis).
-- Nenhuma delas conta "cancelada" porque este schema não tem esse status
-- (ver comentário em 20260911120000_a6_schema.sql — activity_status é só
-- pending/done).

create function private.opportunity_next_action(p_opportunity_id uuid)
returns jsonb
language sql
stable
set search_path = ''
as $body$
  select jsonb_build_object(
    'next_action', (
      select jsonb_build_object(
        'id', a.id, 'type', a.type, 'title', a.title, 'due_at', a.due_at, 'has_time', a.has_time
      )
      from public.activities a
      where a.opportunity_id = p_opportunity_id and a.status = 'pending' and a.due_at >= now()
      order by a.due_at asc
      limit 1
    ),
    'overdue_activities_count', (
      select count(*) from public.activities a
      where a.opportunity_id = p_opportunity_id and a.status = 'pending' and a.due_at < now()
    )
  );
$body$;

comment on function private.opportunity_next_action(uuid) is
  'next_action: atividade pendente mais próxima com due_at futuro (null se não houver). overdue_activities_count: pendentes já vencidas — sinal separado, nunca substitui next_action.';

revoke all on function private.opportunity_next_action(uuid) from public;
grant execute on function private.opportunity_next_action(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- get_opportunity — CREATE OR REPLACE, mesma assinatura. Corpo idêntico
-- ao vigente (20260910120300_a5_read_functions.sql), só acrescentando o
-- "||" da nova projeção no retorno.
-- ---------------------------------------------------------------------

create or replace function public.get_opportunity(p_opportunity_id uuid)
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
  ) || private.opportunity_next_action(v_opportunity.id);
end;
$body$;

revoke all on function public.get_opportunity(uuid) from public;
grant execute on function public.get_opportunity(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- list_opportunities — achado real ao rodar o pgTAP no CI: a assinatura
-- vigente NÃO é mais a de 8 parâmetros original da A5
-- (20260910120300) — a própria A5 já tinha corrigido para 9 parâmetros
-- (p_lead_id no fim, para a listagem da tela do lead) via DROP+CREATE em
-- 20260910120500_a5_list_opportunities_lead_filter.sql, incluindo
-- também lock_version na saída. Um CREATE OR REPLACE com a assinatura
-- ANTIGA (8 parâmetros) não substitui essa versão — cria um OVERLOAD
-- novo e separado, e uma chamada com poucos argumentos posicionais fica
-- ambígua entre os dois ("function list_opportunities(uuid) is not
-- unique", erro real visto no CI). Corrigido: primeiro remove o
-- overload de 8 parâmetros que este arquivo criou por engano, depois
-- substitui a versão de 9 parâmetros de verdade (mesma assinatura de
-- 20260910120500, incluindo lock_version, que este arquivo também tinha
-- perdido por engano) com o acréscimo de next_action.

drop function if exists public.list_opportunities(
  uuid, uuid, uuid, public.opportunity_status, text, text, integer, integer
);

create or replace function public.list_opportunities(
  p_workspace_id uuid,
  p_pipeline_id uuid default null,
  p_stage_id uuid default null,
  p_status public.opportunity_status default null,
  p_search text default null,
  p_sort text default 'created_at_desc',
  p_page integer default 1,
  p_page_size integer default 20,
  p_lead_id uuid default null
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
      o.id, o.lead_id, o.pipeline_id, o.stage_id, o.status, o.lock_version,
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
      and (p_lead_id is null or o.lead_id = p_lead_id)
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
            'status', p.status, 'stage_entered_at', p.stage_entered_at, 'lock_version', p.lock_version,
            'created_at', p.created_at, 'updated_at', p.updated_at
          )
          || private.opportunity_financial_projection(v_role, p.value_cents, p.fee_model, p.probability, p.forecast_date)
          || private.opportunity_next_action(p.id)
          order by p.rn
        )
        from page p
      ),
      '[]'::jsonb
    ),
    coalesce((select r.full_count from ranked r limit 1), 0);
end;
$body$;

revoke all on function public.list_opportunities(uuid, uuid, uuid, public.opportunity_status, text, text, integer, integer, uuid) from public;
grant execute on function public.list_opportunities(uuid, uuid, uuid, public.opportunity_status, text, text, integer, integer, uuid) to authenticated;

-- ---------------------------------------------------------------------
-- get_pipeline_board — CREATE OR REPLACE, mesma assinatura. Único
-- acréscimo: "|| private.opportunity_next_action(o.id)" no card.
-- ---------------------------------------------------------------------

create or replace function public.get_pipeline_board(p_pipeline_id uuid)
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
          )
          || private.opportunity_financial_projection(v_role, o.value_cents, o.fee_model, o.probability, o.forecast_date)
          || private.opportunity_next_action(o.id)
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
