-- A5 — correção de rascunho: get_pipeline_board() falhava com
-- "function private.opportunity_column_sum_projection(membership_role,
-- numeric) does not exist" — sum(bigint) retorna numeric no Postgres,
-- não bigint, e a função privada só aceita bigint. Cast explícito.
-- Mesma assinatura, só o corpo muda (CREATE OR REPLACE).

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
