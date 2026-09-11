-- A8 — Clientes e handoff: funções de leitura.
--
-- Alcance por registro (item 3 do pedido): reaproveita
-- private.lead_accessible_to_role() sem duplicar a regra — a MESMA
-- função que já restringe leads/oportunidades a "seus + sem responsável"
-- para o advogado. Ela só filtra o papel 'lawyer'; owner/admin/manager/
-- sales/viewer enxergam todos os registros do workspace (essa já é a
-- regra vigente desde a A5 para oportunidades — sales/viewer se
-- distinguem pela PROJEÇÃO financeira, não pelo conjunto de linhas
-- visíveis). Documentado explicitamente em docs/decisoes/a8-clientes.md
-- para não ficar implícito.
--
-- "Dentro de um cliente visível, filtre cada oportunidade e handoff pelo
-- alcance do usuário" (item 3): get_client() aplica
-- private.lead_accessible_to_role() de novo, POR LINHA do histórico —
-- ver uma oportunidade não libera as demais do mesmo cliente.
--
-- Registro legado sem nenhum handoff vinculado (alcance indeterminável):
-- fica de fora da lista do advogado (sua checagem é "existe ao menos uma
-- oportunidade em meu alcance" — vacuamente falsa sem nenhuma) e
-- permanece visível para owner/admin/manager/sales/viewer — "mantenha
-- acesso administrativo" (item 3), sem código especial: é só a mesma
-- regra aplicada a um conjunto vazio.

-- ---------------------------------------------------------------------
-- list_clients
-- ---------------------------------------------------------------------

create function public.list_clients(
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
      and (v_role <> 'lawyer' or coalesce(vc.has_visible, false))
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
-- get_client — detalhe. `history` traz cada oportunidade+handoff
-- vinculado (join 1:1 via client_handoffs_one_per_opportunity, A5),
-- filtrado pelo MESMO alcance por registro, em ordem cronológica
-- crescente — o primeiro elemento é a origem (item 5: "a oportunidade de
-- origem pode ser identificada pelo primeiro handoff vinculado, com
-- ordenação determinística"; resolvido no cliente a partir de
-- history[0], sem consulta redundante). Nunca inclui client_handoffs.
-- payload nem last_error (item 6). O total financeiro reaproveita
-- private.opportunity_column_sum_projection() sem duplicar a regra de
-- projeção (mesma função do board/tabela de oportunidades, A5) — soma
-- calculada só sobre as linhas já filtradas pelo alcance, então nunca
-- inclui valor de um registro fora do alcance de quem chama.
-- ---------------------------------------------------------------------

create function public.get_client(p_client_id uuid)
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

  if v_role = 'lawyer' and coalesce(v_has_visible, false) = false then
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

-- ---------------------------------------------------------------------
-- get_opportunity / list_opportunities — ganham client_id (só
-- preenchido quando a oportunidade está 'won' e tem handoff — sempre
-- os dois juntos, por causa de client_handoffs_one_per_opportunity).
-- Mudança ADITIVA: mesma assinatura JÁ VIGENTE (conferida em
-- 20260911120600_a6_next_action_projection.sql, a última a tocar estas
-- duas funções — get_opportunity(uuid) sem mudança de parâmetros,
-- list_opportunities com os 9 parâmetros incluindo p_lead_id), corpo
-- idêntico ao vigente (com a projeção private.opportunity_next_action()
-- da A6 preservada) só acrescentando client_id. CREATE OR REPLACE aqui
-- é seguro porque a assinatura não muda em nada — o achado da revisão
-- do PR #8 (DROP+CREATE obrigatório) só se aplica quando a LISTA DE
-- TIPOS de parâmetro muda, não é o caso aqui.
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
  v_client_id uuid;
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
  select client_id into v_client_id from public.client_handoffs where opportunity_id = v_opportunity.id;

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
    'client_id', v_client_id,
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
      ps.name as stage_name, ch.client_id,
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
    left join public.client_handoffs ch on ch.opportunity_id = o.id
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
            'status', p.status, 'stage_entered_at', p.stage_entered_at, 'client_id', p.client_id,
            'lock_version', p.lock_version,
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
