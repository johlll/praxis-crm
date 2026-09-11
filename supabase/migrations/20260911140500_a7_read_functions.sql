-- A7 — funções de leitura. Mesmo padrão de list_activities/list_opportunities
-- (A5/A6): página limitada a 100, total_count via window function, alcance
-- por registro aplicado DENTRO da consulta (nunca confiado à RLS, que aqui
-- é deny-all mesmo).

-- ---------------------------------------------------------------------
-- list_conversations — Central de Conversas.
-- ---------------------------------------------------------------------

create function public.list_conversations(
  p_workspace_id uuid,
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

revoke all on function public.list_conversations(uuid, integer, integer) from public;
grant execute on function public.list_conversations(uuid, integer, integer) to authenticated;

-- ---------------------------------------------------------------------
-- get_conversation — detalhe (ConversationView).
-- ---------------------------------------------------------------------

create function public.get_conversation(p_conversation_id uuid)
returns jsonb
language plpgsql
security definer
stable
set search_path = ''
as $body$
declare
  v_actor uuid := auth.uid();
  v_role public.membership_role;
  v_conv public.conversations;
  v_lead_assigned_to uuid;
begin
  if v_actor is null then
    raise exception 'authentication_required';
  end if;

  select * into v_conv from public.conversations where id = p_conversation_id;
  if v_conv.id is null then
    return null;
  end if;

  if not private.has_workspace_role(
    v_conv.workspace_id, array['owner', 'admin', 'manager', 'lawyer', 'sales', 'viewer']::public.membership_role[]
  ) then
    return null;
  end if;

  select role into v_role from public.memberships
  where workspace_id = v_conv.workspace_id and user_id = v_actor and status = 'active';

  select assigned_to into v_lead_assigned_to from public.leads where id = v_conv.lead_id;

  if not private.conversation_accessible_to_role(v_role, v_conv.lead_id, v_lead_assigned_to, v_actor) then
    return null;
  end if;

  return jsonb_build_object(
    'id', v_conv.id,
    'workspace_id', v_conv.workspace_id,
    'channel_id', v_conv.channel_id,
    'wa_id', v_conv.wa_id,
    'contact_id', v_conv.contact_id,
    'contact_name', (select name from public.contacts where id = v_conv.contact_id),
    'lead_id', v_conv.lead_id,
    'legal_area', (select legal_area from public.leads where id = v_conv.lead_id),
    'opportunity_id', v_conv.opportunity_id,
    'needs_link_review', v_conv.needs_link_review,
    'link_candidate_contacts', (
      select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name)), '[]'::jsonb)
      from public.contacts c where c.id = any(v_conv.link_candidate_contact_ids)
    ),
    'link_candidate_leads', (
      select coalesce(jsonb_agg(jsonb_build_object('id', l.id, 'legal_area', l.legal_area)), '[]'::jsonb)
      from public.leads l where l.id = any(v_conv.link_candidate_lead_ids)
    ),
    'phone_number_id', (select phone_number_id from public.whatsapp_channels where id = v_conv.channel_id),
    'last_message_at', v_conv.last_message_at,
    'created_at', v_conv.created_at
  );
end;
$body$;

revoke all on function public.get_conversation(uuid) from public;
grant execute on function public.get_conversation(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- list_conversation_messages — histórico paginado por cursor
-- (created_at da mensagem mais antiga já carregada). Nunca "carrega tudo"
-- — ver a7-conversas.md §11: falha numa página nunca vira "não há mais
-- mensagens" nem "conversa vazia" (a Server Action que chama isto propaga
-- o erro cru; quem decide a mensagem tratada é a camada de UI).
-- ---------------------------------------------------------------------

create function public.list_conversation_messages(
  p_conversation_id uuid,
  p_before timestamptz default null,
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
  v_conv public.conversations;
  v_lead_assigned_to uuid;
  v_limit integer;
begin
  if v_actor is null then
    raise exception 'authentication_required';
  end if;

  select * into v_conv from public.conversations where id = p_conversation_id;
  if v_conv.id is null then
    raise exception 'conversation_not_found';
  end if;

  if not private.has_workspace_role(
    v_conv.workspace_id, array['owner', 'admin', 'manager', 'lawyer', 'sales', 'viewer']::public.membership_role[]
  ) then
    raise exception 'insufficient_permission';
  end if;

  select role into v_role from public.memberships
  where workspace_id = v_conv.workspace_id and user_id = v_actor and status = 'active';

  select assigned_to into v_lead_assigned_to from public.leads where id = v_conv.lead_id;

  if not private.conversation_accessible_to_role(v_role, v_conv.lead_id, v_lead_assigned_to, v_actor) then
    raise exception 'conversation_not_found';
  end if;

  v_limit := greatest(1, least(coalesce(p_limit, 30), 100));

  return query
  with page as (
    select m.*
    from public.messages m
    where m.conversation_id = p_conversation_id
      and (p_before is null or m.created_at < p_before)
    order by m.created_at desc
    limit v_limit
  ),
  older_count as (
    select count(*) as n
    from public.messages m
    where m.conversation_id = p_conversation_id
      and m.created_at < (select min(created_at) from page)
  )
  select
    coalesce(
      (
        select jsonb_agg(
          jsonb_build_object(
            'id', p.id, 'direction', p.direction, 'body_text', p.body_text, 'status', p.status,
            'status_updated_at', p.status_updated_at, 'error_reason', p.error_reason,
            'sent_by', p.sent_by, 'created_at', p.created_at, 'wa_message_id', p.wa_message_id
          )
          order by p.created_at asc
        )
        from page p
      ),
      '[]'::jsonb
    ),
    coalesce((select n from older_count), 0) > 0;
end;
$body$;

revoke all on function public.list_conversation_messages(uuid, timestamptz, integer) from public;
grant execute on function public.list_conversation_messages(uuid, timestamptz, integer) to authenticated;
