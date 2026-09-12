-- A8 — Clientes e handoff: correções da revisão pré-merge (3 achados).
--
-- Nenhuma das migrations já aplicadas foi reescrita — `create or replace`
-- nas duas com a MESMA assinatura já existente (list_clients/get_client).
--
-- 1) Clientes sem vínculo suficiente para determinar alcance: a regra
--    original só restringia 'lawyer' (documentada em
--    20260911160200_a8_read_functions.sql como "sales/viewer se distinguem
--    pela projeção financeira, não pelo conjunto de linhas visíveis").
--    Revisão: isso valia para uma oportunidade DENTRO do alcance normal de
--    sales/viewer (que sempre é "todas"), mas não cobria o caso de um
--    cliente SEM NENHUMA negociação vinculada — aí não há alcance nenhum
--    a verificar, e o acesso deve ficar restrito à administração (mesmo
--    princípio do plano: "para registros legados sem vínculo suficiente
--    para determinar o alcance, mantenha acesso administrativo" — antes
--    isso só valia implicitamente para lawyer). Agora owner/admin/manager
--    continuam vendo tudo; lawyer/sales/viewer exigem pelo menos uma
--    negociação em seu alcance (para sales/viewer isso é sempre verdade
--    SE existir alguma negociação, já que lead_accessible_to_role só
--    restringe lawyer — o efeito prático é: sales/viewer perdem acesso
--    apenas ao cliente SEM NENHUM handoff).
--
-- 2) Origem: history[0] (ordem cronológica crescente do histórico já
--    FILTRADO por alcance) podia mostrar uma oportunidade que não é a
--    origem real — se a origem verdadeira (primeiro handoff) estiver fora
--    do alcance do advogado mas uma posterior estiver dentro, o filtro
--    client-side pegava a posterior como se fosse a primeira. Corrigido:
--    o servidor identifica o primeiro handoff de VERDADE (sem filtro,
--    ordenação determinística created_at/id — mesmo critério de sempre) e
--    só devolve os dados da oportunidade de origem se o usuário puder
--    acessá-la; caso contrário, 'origin' vem null (omitida da interface,
--    nunca substituída por outra).
--
-- 3) get_client() continua exatamente com os mesmos códigos de erro
--    (client_not_found/insufficient_permission) — a diferenciação entre
--    "não encontrado" e "falha operacional" pedida no item 3 é resolvida
--    inteiramente na camada TypeScript (src/modules/clients/queries.ts),
--    sem mudança de contrato aqui.

create or replace function public.list_clients(
  p_workspace_id uuid,
  p_status public.client_status default null,
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
  with visible_counts as (
    select
      ch.client_id,
      count(*) filter (where private.lead_accessible_to_role(v_role, l.assigned_to, v_actor)) as visible_count,
      bool_or(private.lead_accessible_to_role(v_role, l.assigned_to, v_actor)) as has_visible
    from public.client_handoffs ch
    join public.opportunities o on o.id = ch.opportunity_id
    join public.leads l on l.id = o.lead_id
    where ch.workspace_id = p_workspace_id
    group by ch.client_id
  ),
  ranked as (
    select
      c.id, c.contact_id, c.owner_user_id, c.status, c.created_at, c.updated_at, c.lock_version,
      ct.name as contact_name, u.full_name as owner_name,
      coalesce(vc.visible_count, 0) as visible_opportunity_count,
      count(*) over () as full_count,
      row_number() over (
        order by
          case when p_sort = 'created_at_asc' then c.created_at end asc,
          case when p_sort is null or p_sort = 'created_at_desc' then c.created_at end desc,
          c.id asc
      ) as rn
    from public.clients c
    join public.contacts ct on ct.id = c.contact_id
    left join public.users u on u.id = c.owner_user_id
    left join visible_counts vc on vc.client_id = c.id
    where c.workspace_id = p_workspace_id
      and (p_status is null or c.status = p_status)
      and (p_search is null or btrim(p_search) = '' or ct.name ilike '%' || btrim(p_search) || '%')
      -- Achado 1: restrito a owner/admin/manager antes só excluía
      -- 'lawyer' sem vínculo — agora sales/viewer também precisam de ao
      -- menos uma negociação em seu alcance (na prática, ao menos um
      -- handoff vinculado — lead_accessible_to_role só restringe lawyer).
      and (v_role in ('owner', 'admin', 'manager') or coalesce(vc.has_visible, false))
  ),
  page as (
    select * from ranked where rn > v_offset and rn <= v_offset + v_page_size
  )
  select
    coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', p.id, 'contact_id', p.contact_id, 'contact_name', p.contact_name,
          'owner_user_id', p.owner_user_id, 'owner_name', p.owner_name,
          'status', p.status, 'created_at', p.created_at, 'updated_at', p.updated_at,
          'lock_version', p.lock_version, 'opportunity_count', p.visible_opportunity_count
        )
        order by p.rn
      )
      from page p
    ), '[]'::jsonb),
    coalesce((select r.full_count from ranked r limit 1), 0);
end;
$body$;

revoke all on function public.list_clients(uuid, public.client_status, text, text, integer, integer) from public;
grant execute on function public.list_clients(uuid, public.client_status, text, text, integer, integer) to authenticated;

-- ---------------------------------------------------------------------
-- get_client
-- ---------------------------------------------------------------------

create or replace function public.get_client(p_client_id uuid)
returns jsonb
language plpgsql
security definer
stable
set search_path = ''
as $body$
declare
  v_actor uuid := auth.uid();
  v_role public.membership_role;
  v_client public.clients;
  v_contact_name text;
  v_owner_name text;
  v_has_visible boolean;
  v_sum_cents bigint;
  v_origin_opportunity_id uuid;
  v_origin_legal_area text;
  v_origin_assigned_to uuid;
begin
  if v_actor is null then
    raise exception 'authentication_required';
  end if;

  select * into v_client from public.clients where id = p_client_id;
  if v_client.id is null then
    raise exception 'client_not_found';
  end if;

  if not private.has_workspace_role(
    v_client.workspace_id,
    array['owner', 'admin', 'manager', 'lawyer', 'sales', 'viewer']::public.membership_role[]
  ) then
    raise exception 'insufficient_permission';
  end if;

  select role into v_role from public.memberships
  where workspace_id = v_client.workspace_id and user_id = v_actor and status = 'active';

  select bool_or(private.lead_accessible_to_role(v_role, l.assigned_to, v_actor)) into v_has_visible
  from public.client_handoffs ch
  join public.opportunities o on o.id = ch.opportunity_id
  join public.leads l on l.id = o.lead_id
  where ch.client_id = p_client_id;

  -- Achado 1: qualquer papel que não seja owner/admin/manager precisa de
  -- ao menos uma negociação em seu alcance — antes só 'lawyer' era
  -- checado aqui, deixando um cliente sem NENHUM handoff visível a
  -- sales/viewer mesmo sem alcance nenhum a mostrar.
  if v_role not in ('owner', 'admin', 'manager') and coalesce(v_has_visible, false) = false then
    raise exception 'client_not_found';
  end if;

  select name into v_contact_name from public.contacts where id = v_client.contact_id;
  select full_name into v_owner_name from public.users where id = v_client.owner_user_id;

  select sum(o.value_cents) filter (where o.value_cents is not null)::bigint into v_sum_cents
  from public.client_handoffs ch
  join public.opportunities o on o.id = ch.opportunity_id
  join public.leads l on l.id = o.lead_id
  where ch.client_id = p_client_id
    and private.lead_accessible_to_role(v_role, l.assigned_to, v_actor);

  -- Achado 2: origem resolvida separadamente do histórico filtrado —
  -- SEMPRE o primeiro handoff de verdade (mesma ordenação determinística
  -- created_at/id de sempre), nunca o primeiro item que sobrou depois do
  -- filtro de alcance. Só entra na resposta se esta oportunidade
  -- específica estiver no alcance de quem pediu; caso contrário 'origin'
  -- fica null (omitida na interface, nunca trocada por outra).
  select o.id, l.legal_area, l.assigned_to
  into v_origin_opportunity_id, v_origin_legal_area, v_origin_assigned_to
  from public.client_handoffs ch
  join public.opportunities o on o.id = ch.opportunity_id
  join public.leads l on l.id = o.lead_id
  where ch.client_id = p_client_id
  order by ch.created_at asc, ch.id asc
  limit 1;

  return jsonb_build_object(
    'id', v_client.id,
    'workspace_id', v_client.workspace_id,
    'contact_id', v_client.contact_id,
    'contact_name', v_contact_name,
    'owner_user_id', v_client.owner_user_id,
    'owner_name', v_owner_name,
    'status', v_client.status,
    'lock_version', v_client.lock_version,
    'created_at', v_client.created_at,
    'updated_at', v_client.updated_at,
    'origin', case
      when v_origin_opportunity_id is not null
        and private.lead_accessible_to_role(v_role, v_origin_assigned_to, v_actor)
      then jsonb_build_object('opportunity_id', v_origin_opportunity_id, 'legal_area', v_origin_legal_area)
      else null
    end,
    'history', (
      select coalesce(jsonb_agg(
        jsonb_build_object(
          'opportunity_id', o.id,
          'legal_area', l.legal_area,
          'won_at', o.won_at,
          'signed_at', o.signed_at,
          'handoff_id', ch.id,
          'handoff_status', ch.status,
          'handoff_target_system', ch.target_system,
          'handoff_awaiting_integration', ch.target_system is null,
          'handoff_attempts', ch.attempts,
          'handoff_completed_at', ch.completed_at,
          'handoff_created_at', ch.created_at
        ) || private.opportunity_financial_projection(v_role, o.value_cents, o.fee_model, o.probability, o.forecast_date)
        order by ch.created_at asc, ch.id asc
      ), '[]'::jsonb)
      from public.client_handoffs ch
      join public.opportunities o on o.id = ch.opportunity_id
      join public.leads l on l.id = o.lead_id
      where ch.client_id = p_client_id
        and private.lead_accessible_to_role(v_role, l.assigned_to, v_actor)
    )
  ) || private.opportunity_column_sum_projection(v_role, v_sum_cents);
end;
$body$;

revoke all on function public.get_client(uuid) from public;
grant execute on function public.get_client(uuid) to authenticated;
