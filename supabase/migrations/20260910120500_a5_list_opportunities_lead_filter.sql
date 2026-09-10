-- A5 — correção de rascunho, ainda antes do primeiro commit desta fase:
-- list_opportunities() ganha o filtro p_lead_id (para listar as
-- oportunidades de um lead na própria tela do lead) e passa a incluir
-- lock_version na saída (necessário para mover etapa a partir da
-- listagem). Mudança de ASSINATURA (novo parâmetro) — exige DROP+CREATE,
-- não CREATE OR REPLACE. Nenhuma tabela nem outra função é tocada aqui.

drop function if exists public.list_opportunities(
  uuid, uuid, uuid, public.opportunity_status, text, text, integer, integer
);

create function public.list_opportunities(
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

revoke all on function public.list_opportunities(uuid, uuid, uuid, public.opportunity_status, text, text, integer, integer, uuid) from public;
grant execute on function public.list_opportunities(uuid, uuid, uuid, public.opportunity_status, text, text, integer, integer, uuid) to authenticated;
