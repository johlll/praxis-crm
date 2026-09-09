-- A4 — Leads: funções de negócio.
--
-- Toda leitura e escrita de `leads`/`lead_values` passa por aqui — as
-- tabelas não têm nenhuma policy que permita acesso direto (ver
-- 20260909100100_a4_rls.sql). Isso responde à exigência de que a proteção
-- do valor de honorários não pode depender só da página Next.js: mesmo
-- uma chamada direta à Data API do Supabase (REST ou RPC) só enxerga o
-- que estas funções decidirem devolver.

-- ---------------------------------------------------------------------
-- Helpers privados de projeção — usados por get_lead()/list_leads(), nunca
-- expostos a `authenticated` diretamente (não precisam de GRANT: rodam
-- dentro de uma função SECURITY DEFINER, com os privilégios do dono).
-- ---------------------------------------------------------------------

create function private.money_band_label(p_cents bigint)
returns text
language sql
immutable
set search_path = ''
as $body$
  select case
    when p_cents is null then 'Não informado'
    when p_cents < 200000 then 'Até R$ 2.000'
    when p_cents < 500000 then 'R$ 2.000–5.000'
    when p_cents < 1000000 then 'R$ 5.000–10.000'
    when p_cents < 2500000 then 'R$ 10.000–25.000'
    else 'Acima de R$ 25.000'
  end;
$body$;

-- Único ponto que decide "quem vê o quê" do valor: exato (owner/admin/
-- manager/lawyer), faixa (sales — nunca o número exato, conforme a
-- matriz do plano), ausente por completo (viewer — a CHAVE não aparece
-- no jsonb, não é um valor nulo presente).
create function private.lead_value_projection(p_role public.membership_role, p_cents bigint)
returns jsonb
language sql
stable
set search_path = ''
as $body$
  select case
    when p_role = 'viewer' then '{}'::jsonb
    when p_role = 'sales' then jsonb_build_object('estimated_value_band', private.money_band_label(p_cents))
    else jsonb_build_object('estimated_value_cents', p_cents)
  end;
$body$;

-- ---------------------------------------------------------------------
-- create_lead
-- ---------------------------------------------------------------------

create function public.create_lead(
  p_workspace_id uuid,
  p_contact_id uuid,
  p_legal_area text,
  p_summary text default null,
  p_tags text[] default '{}'::text[],
  p_priority public.lead_priority default 'media',
  p_assigned_to uuid default null,
  p_estimated_value_cents bigint default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_actor uuid := auth.uid();
  v_lead_id uuid;
  v_contact record;
begin
  if v_actor is null then
    raise exception 'authentication_required';
  end if;

  if not private.has_workspace_role(
    p_workspace_id, array['owner', 'admin', 'manager', 'lawyer', 'sales']::public.membership_role[]
  ) then
    raise exception 'insufficient_permission';
  end if;

  select id, merged_into_contact_id into v_contact
  from public.contacts
  where id = p_contact_id and workspace_id = p_workspace_id;

  if v_contact.id is null then
    raise exception 'contact_not_found';
  end if;
  if v_contact.merged_into_contact_id is not null then
    raise exception 'contact_already_merged';
  end if;

  if p_assigned_to is not null and not exists (
    select 1 from public.memberships
    where workspace_id = p_workspace_id and user_id = p_assigned_to and status = 'active'
  ) then
    raise exception 'assignee_not_a_member';
  end if;

  insert into public.leads (workspace_id, contact_id, legal_area, summary, tags, priority, assigned_to)
  values (
    p_workspace_id, p_contact_id, btrim(p_legal_area),
    nullif(btrim(coalesce(p_summary, '')), ''), coalesce(p_tags, '{}'::text[]),
    p_priority, p_assigned_to
  )
  returning id into v_lead_id;

  if p_estimated_value_cents is not null then
    if p_estimated_value_cents < 0 then
      raise exception 'invalid_value';
    end if;
    insert into public.lead_values (lead_id, workspace_id, estimated_value_cents)
    values (v_lead_id, p_workspace_id, p_estimated_value_cents);
  end if;

  insert into public.audit_logs (workspace_id, actor_user_id, action, resource_type, resource_id, metadata)
  values (
    p_workspace_id, v_actor, 'lead.created', 'lead', v_lead_id,
    jsonb_build_object('contact_id', p_contact_id)
  );

  return v_lead_id;
end;
$body$;

revoke all on function public.create_lead(
  uuid, uuid, text, text, text[], public.lead_priority, uuid, bigint
) from public;
grant execute on function public.create_lead(
  uuid, uuid, text, text, text[], public.lead_priority, uuid, bigint
) to authenticated;

-- ---------------------------------------------------------------------
-- update_lead_basic_fields — concorrência: se p_expected_updated_at vier
-- preenchido e não bater com o valor atual, recusa (edição concorrente,
-- nunca sobrescreve silenciosamente). Nulo = "não verificar" (chamador
-- não tinha um valor prévio, ex.: primeiro carregamento nunca editado).
-- ---------------------------------------------------------------------

create function public.update_lead_basic_fields(
  p_lead_id uuid,
  p_legal_area text,
  p_summary text default null,
  p_tags text[] default '{}'::text[],
  p_priority public.lead_priority default 'media',
  p_expected_updated_at timestamptz default null
)
returns public.leads
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_actor uuid := auth.uid();
  v_lead public.leads;
  v_updated public.leads;
begin
  if v_actor is null then
    raise exception 'authentication_required';
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

  if p_expected_updated_at is not null and v_lead.updated_at <> p_expected_updated_at then
    raise exception 'lead_conflict';
  end if;

  update public.leads
  set legal_area = btrim(p_legal_area),
      summary = nullif(btrim(coalesce(p_summary, '')), ''),
      tags = coalesce(p_tags, '{}'::text[]),
      priority = p_priority
  where id = p_lead_id
  returning * into v_updated;

  insert into public.audit_logs (workspace_id, actor_user_id, action, resource_type, resource_id, metadata)
  values (v_lead.workspace_id, v_actor, 'lead.updated', 'lead', v_lead.id, '{}'::jsonb);

  return v_updated;
end;
$body$;

revoke all on function public.update_lead_basic_fields(
  uuid, text, text, text[], public.lead_priority, timestamptz
) from public;
grant execute on function public.update_lead_basic_fields(
  uuid, text, text, text[], public.lead_priority, timestamptz
) to authenticated;

-- ---------------------------------------------------------------------
-- assign_lead
-- ---------------------------------------------------------------------

create function public.assign_lead(
  p_lead_id uuid,
  p_assigned_to uuid default null,
  p_expected_updated_at timestamptz default null
)
returns public.leads
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_actor uuid := auth.uid();
  v_lead public.leads;
  v_updated public.leads;
begin
  if v_actor is null then
    raise exception 'authentication_required';
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

  if p_assigned_to is not null and not exists (
    select 1 from public.memberships
    where workspace_id = v_lead.workspace_id and user_id = p_assigned_to and status = 'active'
  ) then
    raise exception 'assignee_not_a_member';
  end if;

  if p_expected_updated_at is not null and v_lead.updated_at <> p_expected_updated_at then
    raise exception 'lead_conflict';
  end if;

  update public.leads set assigned_to = p_assigned_to where id = p_lead_id
  returning * into v_updated;

  insert into public.audit_logs (workspace_id, actor_user_id, action, resource_type, resource_id, metadata)
  values (
    v_lead.workspace_id, v_actor, 'lead.assigned', 'lead', v_lead.id,
    jsonb_build_object('assigned_to', p_assigned_to)
  );

  return v_updated;
end;
$body$;

revoke all on function public.assign_lead(uuid, uuid, timestamptz) from public;
grant execute on function public.assign_lead(uuid, uuid, timestamptz) to authenticated;

-- ---------------------------------------------------------------------
-- set_lead_status
-- ---------------------------------------------------------------------

create function public.set_lead_status(
  p_lead_id uuid,
  p_status public.lead_status,
  p_expected_updated_at timestamptz default null
)
returns public.leads
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_actor uuid := auth.uid();
  v_lead public.leads;
  v_updated public.leads;
begin
  if v_actor is null then
    raise exception 'authentication_required';
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

  if p_expected_updated_at is not null and v_lead.updated_at <> p_expected_updated_at then
    raise exception 'lead_conflict';
  end if;

  update public.leads set status = p_status where id = p_lead_id
  returning * into v_updated;

  insert into public.audit_logs (workspace_id, actor_user_id, action, resource_type, resource_id, metadata)
  values (
    v_lead.workspace_id, v_actor, 'lead.status_changed', 'lead', v_lead.id,
    jsonb_build_object('status', p_status)
  );

  return v_updated;
end;
$body$;

revoke all on function public.set_lead_status(uuid, public.lead_status, timestamptz) from public;
grant execute on function public.set_lead_status(uuid, public.lead_status, timestamptz) to authenticated;

-- ---------------------------------------------------------------------
-- set_lead_value — nunca grava o valor em claro na auditoria, só que foi
-- alterado. Upsert: primeira vez que um lead recebe valor ainda não tem
-- linha em lead_values.
-- ---------------------------------------------------------------------

create function public.set_lead_value(
  p_lead_id uuid,
  p_estimated_value_cents bigint default null,
  p_expected_updated_at timestamptz default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_actor uuid := auth.uid();
  v_lead public.leads;
  v_current_updated_at timestamptz;
begin
  if v_actor is null then
    raise exception 'authentication_required';
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

  if p_estimated_value_cents is not null and p_estimated_value_cents < 0 then
    raise exception 'invalid_value';
  end if;

  select updated_at into v_current_updated_at from public.lead_values where lead_id = p_lead_id;

  if v_current_updated_at is not null and p_expected_updated_at is not null
     and v_current_updated_at <> p_expected_updated_at then
    raise exception 'lead_conflict';
  end if;

  insert into public.lead_values (lead_id, workspace_id, estimated_value_cents)
  values (p_lead_id, v_lead.workspace_id, p_estimated_value_cents)
  on conflict (lead_id) do update set estimated_value_cents = excluded.estimated_value_cents;

  insert into public.audit_logs (workspace_id, actor_user_id, action, resource_type, resource_id, metadata)
  values (v_lead.workspace_id, v_actor, 'lead.value_set', 'lead', v_lead.id, '{}'::jsonb);
end;
$body$;

revoke all on function public.set_lead_value(uuid, bigint, timestamptz) from public;
grant execute on function public.set_lead_value(uuid, bigint, timestamptz) to authenticated;

-- ---------------------------------------------------------------------
-- get_lead — devolve jsonb já projetado pelo papel de quem chama.
-- "Seus + equipe" do advogado: se o lead não for dele nem estiver sem
-- responsável, responde como "não encontrado" (nunca 403 — seção 6.8 do
-- plano: recurso fora do alcance responde 404, não revela existência).
-- ---------------------------------------------------------------------

create function public.get_lead(p_lead_id uuid)
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
  select estimated_value_cents into v_cents from public.lead_values where lead_id = v_lead.id;

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
    'updated_at', v_lead.updated_at
  ) || private.lead_value_projection(v_role, v_cents);
end;
$body$;

revoke all on function public.get_lead(uuid) from public;
grant execute on function public.get_lead(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- list_leads — busca/filtros/ordenação/paginação no servidor, tudo num
-- só round-trip. Ordenação estável: `id` como desempate sempre, para
-- nunca repetir/pular registro trocando de página (ver ADR de
-- ordenação estável nas convenções do projeto).
-- ---------------------------------------------------------------------

create function public.list_leads(
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
            'created_at', p.created_at, 'updated_at', p.updated_at
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

revoke all on function public.list_leads(
  uuid, text, public.lead_status, public.lead_priority, uuid, text, text, integer, integer
) from public;
grant execute on function public.list_leads(
  uuid, text, public.lead_status, public.lead_priority, uuid, text, text, integer, integer
) to authenticated;
