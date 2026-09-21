-- A11 — correção de vínculo e leituras de atribuição.
--
-- Contrato: docs/decisoes/a11-ingestao-atribuicao.md §9 e §10.

-- ---------------------------------------------------------------------
-- correct_touchpoint_demand_link — ÚNICO caminho de correção
--
-- Concorrência otimista: quem corrige declara qual é a ponta vigente que
-- está enxergando (`p_expected_current_link_id`, nulo quando ainda não há
-- cadeia). Duas correções da MESMA versão: a primeira grava; a segunda
-- perde, ou porque a ponta já mudou, ou porque o índice parcial único de
-- `supersedes_id` recusa suceder a mesma linha duas vezes — nos dois
-- casos vira `link_version_conflict`, nunca uma segunda ponta vigente.
--
-- O histórico NUNCA é apagado: cada correção é uma linha nova.
-- ---------------------------------------------------------------------

create function public.correct_touchpoint_demand_link(
  p_touchpoint_id uuid,
  p_expected_current_link_id uuid,
  p_action public.touchpoint_link_action,
  p_opportunity_id uuid default null,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_actor uuid := auth.uid();
  v_touchpoint public.touchpoints;
  v_current public.touchpoint_demand_links;
  v_new public.touchpoint_demand_links;
  v_opportunity public.opportunities;
begin
  if v_actor is null then
    raise exception 'authentication_required';
  end if;

  select * into v_touchpoint from public.touchpoints where id = p_touchpoint_id;
  if v_touchpoint.id is null then
    raise exception 'touchpoint_not_found';
  end if;

  -- Ação sensível: mesma faixa de contact.merge/conversation.link
  -- (owner/admin/manager). Reescrever atribuição muda número de painel.
  if not private.has_workspace_role(
    v_touchpoint.workspace_id, array['owner', 'admin', 'manager']::public.membership_role[]
  ) then
    raise exception 'insufficient_permission';
  end if;

  if p_action = 'assign' then
    if p_opportunity_id is null then
      raise exception 'opportunity_required';
    end if;
    select * into v_opportunity from public.opportunities
    where id = p_opportunity_id and workspace_id = v_touchpoint.workspace_id;
    if v_opportunity.id is null then
      -- Oportunidade de outro workspace responde como não encontrada.
      raise exception 'opportunity_not_found';
    end if;

    -- INVARIANTE: um touchpoint só pode ser vinculado a uma oportunidade
    -- do PRÓPRIO contato. Sem isto, uma correção poderia emprestar a
    -- origem de uma pessoa para a demanda de outra — e a elegibilidade
    -- deixaria de ser verificável a partir do contato.
    if not exists (
      select 1 from public.leads l
      where l.id = v_opportunity.lead_id and l.contact_id = v_touchpoint.contact_id
    ) then
      raise exception 'opportunity_other_contact';
    end if;
  elsif p_opportunity_id is not null then
    raise exception 'opportunity_not_allowed_on_unassign';
  end if;

  -- Ponta vigente: a linha que ninguém sucede.
  select * into v_current
  from public.touchpoint_demand_links l
  where l.touchpoint_id = p_touchpoint_id
    and not exists (select 1 from public.touchpoint_demand_links c where c.supersedes_id = l.id)
  limit 1;

  if v_current.id is distinct from p_expected_current_link_id then
    raise exception 'link_version_conflict';
  end if;

  begin
    insert into public.touchpoint_demand_links (
      workspace_id, touchpoint_id, opportunity_id, action, supersedes_id, reason, actor_user_id
    )
    values (
      v_touchpoint.workspace_id, p_touchpoint_id, p_opportunity_id, p_action,
      v_current.id, nullif(btrim(p_reason), ''), v_actor
    )
    returning * into v_new;
  exception when unique_violation then
    -- Outra transação sucedeu a mesma ponta primeiro.
    raise exception 'link_version_conflict';
  end;

  insert into public.audit_logs (workspace_id, actor_user_id, action, resource_type, resource_id, metadata)
  values (
    v_touchpoint.workspace_id, v_actor, 'touchpoint.link_corrected', 'touchpoint', p_touchpoint_id,
    jsonb_build_object(
      'action', p_action,
      'opportunity_id', p_opportunity_id,
      'supersedes_id', v_current.id,
      'link_id', v_new.id
    )
  );

  return jsonb_build_object(
    'link_id', v_new.id,
    'effective_opportunity_id', private.touchpoint_effective_opportunity(p_touchpoint_id)
  );
end;
$body$;

-- ---------------------------------------------------------------------
-- get_lead_attribution — sequência de interações + atribuição por
-- oportunidade, para o AttributionPanel do Perfil 360.
--
-- Alcance por registro ANTES de qualquer leitura: parte do lead, que já
-- passa por private.lead_accessible_to_role (advogado só o próprio
-- alcance). Nenhum campo proibido sai daqui — nada de payload cifrado,
-- hash de token de continuidade ou HMAC de IP.
-- ---------------------------------------------------------------------

create function public.get_lead_attribution(p_lead_id uuid)
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
  v_result jsonb;
begin
  if v_actor is null then
    raise exception 'authentication_required';
  end if;

  select * into v_lead from public.leads where id = p_lead_id;
  if v_lead.id is null then
    return null;
  end if;

  select role into v_role from public.memberships
  where workspace_id = v_lead.workspace_id and user_id = v_actor and status = 'active';

  if v_role is null then
    return null;
  end if;

  if not private.lead_accessible_to_role(v_role, v_lead.assigned_to, v_actor) then
    return null;
  end if;

  select jsonb_build_object(
    'lead_id', v_lead.id,
    -- Sequência COMPLETA do contato (o plano pede a sequência inteira),
    -- com a oportunidade vigente de cada interação.
    'sequence', (
      select coalesce(jsonb_agg(
        jsonb_build_object(
          'id', t.id,
          'position', t.position,
          'occurred_at', t.occurred_at,
          'received_at', t.received_at,
          'normalized_occurred_at', t.normalized_occurred_at,
          'normalization_code', w.normalization_code,
          'channel', t.channel,
          'source', t.source,
          'medium', t.medium,
          'campaign', t.campaign,
          'content', t.content,
          'term', t.term,
          'gclid', t.gclid,
          'fbclid', t.fbclid,
          'landing_url', t.landing_url,
          'referrer', t.referrer,
          'lead_id', t.lead_id,
          'original_opportunity_id', t.opportunity_id,
          'effective_opportunity_id', private.touchpoint_effective_opportunity(t.id),
          'current_link_id', (
            select l.id from public.touchpoint_demand_links l
            where l.touchpoint_id = t.id
              and not exists (select 1 from public.touchpoint_demand_links c where c.supersedes_id = l.id)
            limit 1
          ),
          'history', (
            select coalesce(jsonb_agg(jsonb_build_object(
              'id', h.id,
              'action', h.action,
              'opportunity_id', h.opportunity_id,
              'reason', h.reason,
              'actor_name', u.full_name,
              'created_at', h.created_at
            ) order by h.created_at), '[]'::jsonb)
            from public.touchpoint_demand_links h
            left join public.users u on u.id = h.actor_user_id
            where h.touchpoint_id = t.id
          ),
          'consent', (
            select jsonb_build_object('decision', ce.decision, 'purpose_code', ce.purpose_code,
                                      'text_version', ce.text_version, 'decided_at', ce.decided_at)
            from public.consent_evidence ce where ce.id = t.consent_evidence_id
          )
        ) order by t.normalized_occurred_at, t.received_at, t.id
      ), '[]'::jsonb)
      from public.touchpoints t
      left join public.webhook_events w on w.id = t.webhook_event_id
      where t.workspace_id = v_lead.workspace_id and t.contact_id = v_lead.contact_id
    ),
    -- Atribuição por OPORTUNIDADE (nunca por lead: a A5 permite várias
    -- oportunidades no mesmo lead, e uma nunca empresta origem à outra).
    'opportunities', (
      select coalesce(jsonb_agg(
        jsonb_build_object(
          'opportunity_id', o.id,
          'stage_name', s.name,
          'status', o.status,
          'won_at', o.won_at,
          'first_touch_id', a.first_touch_id,
          'last_touch_id', a.last_touch_id,
          'conversion_id', a.conversion_id
        ) order by o.created_at
      ), '[]'::jsonb)
      from public.opportunities o
      join public.pipeline_stages s on s.id = o.stage_id
      cross join lateral private.opportunity_attribution(o.id) a
      where o.lead_id = v_lead.id
    )
  )
  into v_result;

  return v_result;
end;
$body$;

-- ---------------------------------------------------------------------
-- get_dashboard_attribution — bloco de origem do painel
--
-- Função SEPARADA de get_dashboard (A10) de propósito: a unidade aqui é
-- OPORTUNIDADE, não lead. Filtrar "leads recebidos" por origem seria
-- incoerente — um lead pode ter várias oportunidades com origens
-- diferentes, e o número mudaria de unidade sem avisar. O bloco declara a
-- unidade e o modelo na própria interface.
--
-- O filtro de origem é coerente com o MODELO escolhido: filtrar por "X"
-- no primeiro toque mantém as oportunidades cujo PRIMEIRO TOQUE tem
-- origem X; no último toque, cujo ÚLTIMO TOQUE tem origem X.
--
-- Alcance por registro antes de agregar, como em todo o painel da A10.
-- ---------------------------------------------------------------------

create function public.get_dashboard_attribution(
  p_workspace_id uuid,
  p_period_days integer default 30,
  p_model text default 'first_touch',
  p_source text default null,
  p_assigned_to uuid default null,
  p_only_unassigned boolean default false,
  p_legal_area text default null
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
  v_tz text;
  v_source text := nullif(btrim(coalesce(p_source, '')), '');
  v_result jsonb;
begin
  if v_actor is null then
    raise exception 'authentication_required';
  end if;

  if p_period_days is null or p_period_days not in (7, 30, 90) then
    raise exception 'invalid_period';
  end if;

  if p_model is null or p_model not in ('first_touch', 'last_touch', 'conversion') then
    raise exception 'invalid_attribution_model';
  end if;

  if coalesce(p_only_unassigned, false) and p_assigned_to is not null then
    raise exception 'invalid_filter';
  end if;

  if not private.has_workspace_role(
    p_workspace_id,
    array['owner', 'admin', 'manager', 'lawyer', 'sales', 'viewer']::public.membership_role[]
  ) then
    raise exception 'insufficient_permission';
  end if;

  select role into v_role from public.memberships
  where workspace_id = p_workspace_id and user_id = v_actor and status = 'active';

  v_tz := private.office_timezone(p_workspace_id);

  with b as (
    select * from private.dashboard_period_bounds(p_period_days, v_tz)
  ),
  sl as (
    select l.id, l.assigned_to
    from public.leads l
    where l.workspace_id = p_workspace_id
      and private.lead_accessible_to_role(v_role, l.assigned_to, v_actor)
      and (p_assigned_to is null or l.assigned_to = p_assigned_to)
      and (not coalesce(p_only_unassigned, false) or l.assigned_to is null)
      and (nullif(btrim(coalesce(p_legal_area, '')), '') is null or l.legal_area = btrim(p_legal_area))
  ),
  -- Oportunidades do período pela data do próprio evento medido:
  -- criadas no período (população do bloco) e ganhas no período.
  opp as (
    select o.*
    from public.opportunities o
    join sl on sl.id = o.lead_id
    where o.workspace_id = p_workspace_id
  ),
  attributed as (
    select
      o.id,
      o.status,
      o.won_at,
      o.created_at,
      case p_model
        when 'first_touch' then a.first_touch_id
        when 'last_touch' then a.last_touch_id
        else a.conversion_id
      end as touchpoint_id
    from opp o
    cross join lateral private.opportunity_attribution(o.id) a
  ),
  labelled as (
    select
      x.*,
      private.touchpoint_source_label(x.touchpoint_id) as source_label
    from attributed x
  ),
  filtered as (
    select * from labelled
    where v_source is null
      or (v_source = '__sem_origem__' and source_label is null)
      or source_label = v_source
  )
  select jsonb_build_object(
    'model', p_model,
    'period_days', p_period_days,
    'source', v_source,
    -- Unidade declarada no próprio payload, para a interface nunca
    -- apresentar isto como se fosse contagem de leads.
    'unit', 'opportunity',
    'created_in_period', (
      select count(*) from filtered f, b
      where f.created_at >= b.current_start and f.created_at < b.current_end
    ),
    'won_in_period', (
      select count(*) from filtered f, b
      where f.status = 'won' and f.won_at >= b.current_start and f.won_at < b.current_end
    ),
    'unattributed_created', (
      select count(*) from filtered f, b
      where f.touchpoint_id is null
        and f.created_at >= b.current_start and f.created_at < b.current_end
    ),
    'sources', (
      select coalesce(jsonb_agg(row_to_json(r)::jsonb order by r.won desc, r.created desc, r.source nulls last), '[]'::jsonb)
      from (
        select
          l.source_label as source,
          count(*) filter (
            where l.created_at >= (select current_start from b)
              and l.created_at < (select current_end from b)
          ) as created,
          count(*) filter (
            where l.status = 'won'
              and l.won_at >= (select current_start from b)
              and l.won_at < (select current_end from b)
          ) as won
        from labelled l
        where l.created_at >= (select current_start from b) and l.created_at < (select current_end from b)
           or (l.status = 'won' and l.won_at >= (select current_start from b) and l.won_at < (select current_end from b))
        group by l.source_label
      ) r
    )
  )
  into v_result;

  return v_result;
end;
$body$;

revoke all on function public.correct_touchpoint_demand_link(uuid, uuid, public.touchpoint_link_action, uuid, text) from public;
grant execute on function public.correct_touchpoint_demand_link(uuid, uuid, public.touchpoint_link_action, uuid, text) to authenticated;

revoke all on function public.get_lead_attribution(uuid) from public;
grant execute on function public.get_lead_attribution(uuid) to authenticated;

revoke all on function public.get_dashboard_attribution(uuid, integer, text, text, uuid, boolean, text) from public;
grant execute on function public.get_dashboard_attribution(uuid, integer, text, text, uuid, boolean, text) to authenticated;
