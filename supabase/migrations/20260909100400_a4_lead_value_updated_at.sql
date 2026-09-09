-- A4 — get_lead()/list_leads() precisavam expor `value_updated_at`
-- (o updated_at de lead_values, não o de leads) — achado escrevendo o
-- formulário de editar valor: set_lead_value() trava por concorrência
-- comparando contra o updated_at de LEAD_VALUES, mas o jsonb só carregava
-- o updated_at de LEADS (linha diferente, timestamp diferente). Sem isso,
-- o formulário sempre mandaria o timestamp errado e set_lead_value()
-- recusaria por "conflito" mesmo sem edição concorrente nenhuma — mesma
-- classe de bug do achado 7 da A3, pego aqui ANTES de chegar ao usuário
-- porque a interface exigiu ter o dado certo em mãos.
--
-- Não é segredo: é só a DATA/HORA da última alteração do valor, nunca o
-- valor em si — por isso pode ir no jsonb base, incondicional de papel
-- (mesmo raciocínio de expor `updated_at`/`created_at` sem restrição).

create or replace function public.get_lead(p_lead_id uuid)
returns jsonb
language plpgsql
security definer
stable
set search_path = ''
as $body$
declare
  v_actor uuid := auth.uid();
  v_role public.membership_role;
  v_lead public.leads;
  v_contact_name text;
  v_assigned_to_name text;
  v_cents bigint;
  v_value_updated_at timestamptz;
begin
  if v_actor is null then
    raise exception 'authentication_required';
  end if;

  select * into v_lead from public.leads where id = p_lead_id;
  if v_lead.id is null then
    raise exception 'lead_not_found';
  end if;

  if not private.has_workspace_role(
    v_lead.workspace_id,
    array['owner', 'admin', 'manager', 'lawyer', 'sales', 'viewer']::public.membership_role[]
  ) then
    raise exception 'insufficient_permission';
  end if;

  select role into v_role from public.memberships
  where workspace_id = v_lead.workspace_id and user_id = v_actor and status = 'active';

  if v_role = 'lawyer' and not (v_lead.assigned_to = v_actor or v_lead.assigned_to is null) then
    raise exception 'lead_not_found';
  end if;

  select c.name into v_contact_name from public.contacts c where c.id = v_lead.contact_id;
  select u.full_name into v_assigned_to_name from public.users u where u.id = v_lead.assigned_to;
  select estimated_value_cents, updated_at into v_cents, v_value_updated_at
  from public.lead_values where lead_id = v_lead.id;

  return jsonb_build_object(
    'id', v_lead.id,
    'workspace_id', v_lead.workspace_id,
    'contact_id', v_lead.contact_id,
    'contact_name', v_contact_name,
    'legal_area', v_lead.legal_area,
    'summary', v_lead.summary,
    'tags', to_jsonb(v_lead.tags),
    'priority', v_lead.priority,
    'status', v_lead.status,
    'assigned_to', v_lead.assigned_to,
    'assigned_to_name', v_assigned_to_name,
    'created_at', v_lead.created_at,
    'updated_at', v_lead.updated_at,
    'value_updated_at', v_value_updated_at
  ) || private.lead_value_projection(v_role, v_cents);
end;
$body$;

create or replace function public.list_leads(
  p_workspace_id uuid,
  p_search text default null,
  p_status public.lead_status default null,
  p_priority public.lead_priority default null,
  p_assigned_to uuid default null,
  p_legal_area text default null,
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
      l.id, l.contact_id, l.legal_area, l.summary, l.tags, l.priority, l.status,
      l.assigned_to, l.created_at, l.updated_at,
      c.name as contact_name,
      u.full_name as assigned_to_name,
      lv.estimated_value_cents,
      lv.updated_at as value_updated_at,
      count(*) over () as full_count,
      row_number() over (
        order by
          case when p_sort = 'created_at_asc' then l.created_at end asc,
          case when p_sort is null or p_sort = 'created_at_desc' then l.created_at end desc,
          l.id asc
      ) as rn
    from public.leads l
    join public.contacts c on c.id = l.contact_id
    left join public.users u on u.id = l.assigned_to
    left join public.lead_values lv on lv.lead_id = l.id
    where l.workspace_id = p_workspace_id
      and (v_role <> 'lawyer' or l.assigned_to = v_actor or l.assigned_to is null)
      and (p_status is null or l.status = p_status)
      and (p_priority is null or l.priority = p_priority)
      and (p_assigned_to is null or l.assigned_to = p_assigned_to)
      and (p_legal_area is null or l.legal_area = p_legal_area)
      and (
        p_search is null or btrim(p_search) = ''
        or c.name ilike '%' || btrim(p_search) || '%'
        or l.summary ilike '%' || btrim(p_search) || '%'
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
            'id', p.id, 'contact_id', p.contact_id, 'contact_name', p.contact_name,
            'legal_area', p.legal_area, 'summary', p.summary, 'tags', to_jsonb(p.tags),
            'priority', p.priority, 'status', p.status,
            'assigned_to', p.assigned_to, 'assigned_to_name', p.assigned_to_name,
            'created_at', p.created_at, 'updated_at', p.updated_at,
            'value_updated_at', p.value_updated_at
          ) || private.lead_value_projection(v_role, p.estimated_value_cents)
          order by p.rn
        )
        from page p
      ),
      '[]'::jsonb
    ),
    coalesce((select r.full_count from ranked r limit 1), 0);
end;
$body$;
