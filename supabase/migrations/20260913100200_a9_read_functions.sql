-- A9 — funções de leitura: timeline unificada do lead + filtro de
-- conversas por lead (aditivo, para a aba "Conversas" do Perfil 360).

-- ---------------------------------------------------------------------
-- list_conversations — parâmetro novo p_lead_id (aditivo, com default
-- null: nenhum chamador existente muda de comportamento). Mesma
-- assinatura de antes + um parâmetro no final, conforme o padrão já usado
-- para list_conversation_messages ganhar p_before_id na A7.
-- ---------------------------------------------------------------------

create or replace function public.list_conversations(
  p_workspace_id uuid,
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
    p_workspace_id, array['owner', 'admin', 'manager', 'lawyer', 'sales', 'viewer']::public.membership_role[]
  ) then
    raise exception 'insufficient_permission';
  end if;

  select role into v_role from public.memberships
  where workspace_id = p_workspace_id and user_id = v_actor and status = 'active';

  v_page_size := greatest(1, least(coalesce(p_page_size, 20), 100));
  v_offset := (greatest(1, coalesce(p_page, 1)) - 1) * v_page_size;

  return query
  with accessible as (
    select
      c.id, c.wa_id, c.contact_id, c.lead_id, c.opportunity_id, c.needs_link_review, c.last_message_at,
      ct.name as contact_name,
      l.legal_area,
      lm.body_text as last_message_text,
      lm.direction as last_message_direction,
      lm.status as last_message_status,
      lm.created_at as last_message_created_at
    from public.conversations c
    left join public.contacts ct on ct.id = c.contact_id
    left join public.leads l on l.id = c.lead_id
    left join lateral (
      select m.body_text, m.direction, m.status, m.created_at
      from public.messages m
      where m.conversation_id = c.id
      order by m.created_at desc
      limit 1
    ) lm on true
    where c.workspace_id = p_workspace_id
      and (p_lead_id is null or c.lead_id = p_lead_id)
      and private.conversation_accessible_to_role(v_role, c.lead_id, l.assigned_to, v_actor)
  ),
  ordered as (
    select accessible.*,
      row_number() over (order by coalesce(last_message_created_at, last_message_at) desc nulls last, id desc) as rn,
      count(*) over () as full_count
    from accessible
  ),
  page as (
    select * from ordered where rn > v_offset and rn <= v_offset + v_page_size
  )
  select
    coalesce(
      (
        select jsonb_agg(
          jsonb_build_object(
            'id', p.id, 'wa_id', p.wa_id, 'contact_id', p.contact_id, 'contact_name', p.contact_name,
            'lead_id', p.lead_id, 'legal_area', p.legal_area, 'opportunity_id', p.opportunity_id,
            'needs_link_review', p.needs_link_review, 'last_message_at', p.last_message_at,
            'last_message_text', p.last_message_text, 'last_message_direction', p.last_message_direction,
            'last_message_status', p.last_message_status
          )
          order by p.rn
        )
        from page p
      ),
      '[]'::jsonb
    ),
    coalesce((select full_count from ordered limit 1), 0);
end;
$body$;

revoke all on function public.list_conversations(uuid, integer, integer, uuid) from public;
grant execute on function public.list_conversations(uuid, integer, integer, uuid) to authenticated;

-- ---------------------------------------------------------------------
-- get_lead_timeline — cruza lead_notes + activities + messages (via
-- conversations do lead) + stage_transitions (via oportunidades do lead)
-- + proposals + conflict_checks num único feed cronológico.
--
-- Ordenação/paginação: cursor composto (occurred_at, id), NUNCA
-- occurred_at sozinho — mesmo padrão já corrigido e validado em
-- list_conversation_messages (A7) e na correção de flakiness da A8 (PR
-- #12 desta mesma sessão): vários eventos podem nascer na MESMA transação
-- (ex.: lead criado + primeira atividade automática), e um desempate só
-- por timestamp deixaria a ordem entre eles efetivamente aleatória de
-- página em página.
--
-- Alcance: um único private.lead_accessible_to_role() no início decide
-- se o ator vê a timeline deste lead — todos os eventos agregados aqui
-- (notas, atividades, transições de etapa, propostas, conflito) penduram
-- diretamente do MESMO lead_id, então não há necessidade de checar cada
-- linha de novo (ao contrário do histórico de cliente da A8, que cruza
-- MÚLTIPLOS leads/oportunidades por cliente). A única exceção são as
-- mensagens, que passam por private.conversation_accessible_to_role() por
-- completude/defesa em profundidade, mesmo sendo redundante aqui (a
-- conversa já está filtrada por lead_id = p_lead_id).
-- ---------------------------------------------------------------------

create function public.get_lead_timeline(
  p_lead_id uuid,
  p_types text[] default null,
  p_before timestamptz default null,
  p_before_id uuid default null,
  p_limit integer default 30
)
returns table (items jsonb, has_more boolean)
language plpgsql
security definer
stable
set search_path = ''
as $body$
declare
  v_actor uuid := auth.uid();
  v_role public.membership_role;
  v_lead public.leads;
  v_limit integer;
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

  if not private.lead_accessible_to_role(v_role, v_lead.assigned_to, v_actor) then
    raise exception 'lead_not_found';
  end if;

  if p_before is not null and p_before_id is null then
    raise exception 'invalid_cursor';
  end if;

  v_limit := greatest(1, least(coalesce(p_limit, 30), 100));

  return query
  with source as (
    select 'nota'::text as event_type, n.created_at as occurred_at, n.id as row_id,
      jsonb_build_object('body', n.body, 'created_by', n.created_by) as payload
    from public.lead_notes n
    where n.lead_id = p_lead_id

    union all

    select 'atividade', coalesce(a.completed_at, a.created_at), a.id,
      jsonb_build_object(
        'type', a.type, 'title', a.title, 'status', a.status, 'opportunity_id', a.opportunity_id,
        'assigned_to', a.assigned_to, 'due_at', a.due_at, 'completed_at', a.completed_at
      )
    from public.activities a
    where a.lead_id = p_lead_id

    union all

    select 'mensagem', m.created_at, m.id,
      jsonb_build_object(
        'direction', m.direction, 'body_text', m.body_text, 'status', m.status,
        'conversation_id', m.conversation_id
      )
    from public.messages m
    join public.conversations c on c.id = m.conversation_id
    where c.lead_id = p_lead_id
      and private.conversation_accessible_to_role(v_role, c.lead_id, v_lead.assigned_to, v_actor)

    union all

    select 'etapa', st.occurred_at, st.id,
      jsonb_build_object(
        'opportunity_id', st.opportunity_id, 'from_stage_id', st.from_stage_id, 'to_stage_id', st.to_stage_id,
        'from_stage_name', fs.name, 'to_stage_name', ts.name
      )
    from public.stage_transitions st
    join public.opportunities o on o.id = st.opportunity_id
    left join public.pipeline_stages fs on fs.id = st.from_stage_id
    join public.pipeline_stages ts on ts.id = st.to_stage_id
    where o.lead_id = p_lead_id

    union all

    select 'proposta', coalesce(p.decided_at, p.sent_at, p.created_at), p.id,
      jsonb_build_object('number', p.number, 'status', p.status, 'opportunity_id', p.opportunity_id)
        || private.proposal_financial_projection(v_role, p.value_cents, p.fee_model)
    from public.proposals p
    where p.lead_id = p_lead_id

    union all

    select 'conflito', cc.checked_at, cc.id,
      jsonb_build_object('status', cc.status)
    from public.conflict_checks cc
    where cc.lead_id = p_lead_id and cc.checked_at is not null
  ),
  filtered as (
    select * from source where p_types is null or event_type = any(p_types)
  ),
  page as (
    select *
    from filtered
    where p_before is null or (occurred_at, row_id) < (p_before, p_before_id)
    order by occurred_at desc, row_id desc
    limit v_limit
  ),
  cursor_point as (
    select occurred_at, row_id from page order by occurred_at asc, row_id asc limit 1
  ),
  older_count as (
    select count(*) as n
    from filtered f, cursor_point cp
    where (f.occurred_at, f.row_id) < (cp.occurred_at, cp.row_id)
  )
  select
    coalesce(
      (
        select jsonb_agg(
          jsonb_build_object(
            'event_type', p.event_type, 'occurred_at', p.occurred_at, 'id', p.row_id, 'payload', p.payload
          )
          order by p.occurred_at desc, p.row_id desc
        )
        from page p
      ),
      '[]'::jsonb
    ),
    coalesce((select n from older_count), 0) > 0;
end;
$body$;

revoke all on function public.get_lead_timeline(uuid, text[], timestamptz, uuid, integer) from public;
grant execute on function public.get_lead_timeline(uuid, text[], timestamptz, uuid, integer) to authenticated;
