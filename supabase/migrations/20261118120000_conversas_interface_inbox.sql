-- Conversas + IA, PR 2 — leitura da caixa de entrada (lista de conversas com busca,
-- filtro pela situação do atendimento e contagens por situação).
--
-- ADITIVA: uma função nova. Nada é criado em tabela, nada é alterado em função
-- existente e nenhum dado é escrito. `list_conversations` (usada pela aba Conversas do
-- Perfil 360) continua exatamente como está: por isso esta é uma função própria, e não
-- parâmetros novos naquela (que mudariam a leitura que as conferências de atualização
-- da B3 comparam).
--
-- Por que existe: o filtro por situação, a busca e as contagens não podem ser feitos só
-- sobre a página carregada — a lista é paginada no servidor. Aqui o servidor devolve,
-- numa única leitura: a página pedida (já filtrada e buscada), o total do filtro e a
-- contagem de cada situação sobre TODO o conjunto que o papel de quem lê alcança
-- (respeitando a busca, mas não o filtro de situação, para que as abas mostrem quanto
-- há em cada uma).
--
-- Regras iguais às da list_conversations: mesmos papéis de leitura (inclusive viewer) e
-- mesmo alcance por papel (private.conversation_accessible_to_role). A situação do
-- atendimento vem de status_tracks; conversa sem registro é 'nao_informado' (dado
-- legado, nunca inferido como "novo").

create function public.list_conversation_inbox(
  p_workspace_id uuid,
  p_page integer default 1,
  p_page_size integer default 20,
  p_status text default null,
  p_search text default null
)
returns table (items jsonb, total_count bigint, status_counts jsonb)
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
  v_status text := nullif(btrim(coalesce(p_status, '')), '');
  v_search text := nullif(btrim(coalesce(p_search, '')), '');
  v_pattern text;
begin
  if v_actor is null then
    raise exception 'authentication_required';
  end if;

  if not private.has_workspace_role(
    p_workspace_id, array['owner', 'admin', 'manager', 'lawyer', 'sales', 'viewer']::public.membership_role[]
  ) then
    raise exception 'insufficient_permission';
  end if;

  if v_status is not null and v_status not in
     ('nao_informado', 'novo', 'aguardando_escritorio', 'aguardando_cliente', 'encerrado') then
    raise exception 'invalid_status';
  end if;

  select role into v_role from public.memberships
  where workspace_id = p_workspace_id and user_id = v_actor and status = 'active';

  v_page_size := greatest(1, least(coalesce(p_page_size, 20), 100));
  v_offset := (greatest(1, coalesce(p_page, 1)) - 1) * v_page_size;

  -- Busca por trecho (contato, telefone ou área do caso), sem tratar % _ \ do usuário como
  -- curinga. Limitada a 80 caracteres.
  if v_search is not null then
    v_search := left(v_search, 80);
    v_pattern := '%' || replace(replace(replace(v_search, '\', '\\'), '%', '\%'), '_', '\_') || '%';
  end if;

  return query
  with accessible as (
    select
      c.id,
      coalesce(c.wa_id, i.phone_e164) as phone,
      c.contact_id, c.lead_id, c.opportunity_id, c.needs_link_review, c.last_message_at,
      ct.name as contact_name,
      l.legal_area,
      lm.body_text as last_message_text,
      lm.direction as last_message_direction,
      lm.status as last_message_status,
      lm.content_kind as last_message_content_kind,
      lm.created_at as last_message_created_at,
      coalesce(st.attendance_status::text, 'nao_informado') as attendance_status
    from public.conversations c
    left join public.whatsapp_identities i on i.id = c.identity_id
    left join public.contacts ct on ct.id = c.contact_id
    left join public.leads l on l.id = c.lead_id
    left join public.status_tracks st
      on st.conversation_id = c.id and st.track = 'attendance'
    left join lateral (
      select m.body_text, m.direction, m.status, m.content_kind, m.created_at
      from public.messages m
      where m.conversation_id = c.id
      order by m.created_at desc
      limit 1
    ) lm on true
    where c.workspace_id = p_workspace_id
      and private.conversation_accessible_to_role(v_role, c.lead_id, l.assigned_to, v_actor)
      and (
        v_pattern is null
        or ct.name ilike v_pattern escape '\'
        or coalesce(c.wa_id, i.phone_e164, '') ilike v_pattern escape '\'
        or coalesce(l.legal_area, '') ilike v_pattern escape '\'
      )
  ),
  counts as (
    select jsonb_build_object(
      'all', count(*),
      'nao_informado', count(*) filter (where attendance_status = 'nao_informado'),
      'novo', count(*) filter (where attendance_status = 'novo'),
      'aguardando_escritorio', count(*) filter (where attendance_status = 'aguardando_escritorio'),
      'aguardando_cliente', count(*) filter (where attendance_status = 'aguardando_cliente'),
      'encerrado', count(*) filter (where attendance_status = 'encerrado')
    ) as j
    from accessible
  ),
  filtered as (
    select * from accessible where v_status is null or attendance_status = v_status
  ),
  ordered as (
    select filtered.*,
      row_number() over (order by coalesce(last_message_created_at, last_message_at) desc nulls last, id desc) as rn,
      count(*) over () as full_count
    from filtered
  ),
  page as (
    select * from ordered where rn > v_offset and rn <= v_offset + v_page_size
  )
  select
    coalesce(
      (
        select jsonb_agg(
          jsonb_build_object(
            'id', p.id, 'wa_id', p.phone, 'contact_id', p.contact_id, 'contact_name', p.contact_name,
            'lead_id', p.lead_id, 'legal_area', p.legal_area, 'opportunity_id', p.opportunity_id,
            'needs_link_review', p.needs_link_review, 'last_message_at', p.last_message_at,
            'last_message_text', p.last_message_text, 'last_message_direction', p.last_message_direction,
            'last_message_status', p.last_message_status, 'last_message_content_kind', p.last_message_content_kind,
            'attendance_status', p.attendance_status
          )
          order by p.rn
        )
        from page p
      ),
      '[]'::jsonb
    ),
    coalesce((select full_count from ordered limit 1), 0),
    (select j from counts);
end;
$body$;

revoke all on function public.list_conversation_inbox(uuid, integer, integer, text, text) from public;
grant execute on function public.list_conversation_inbox(uuid, integer, integer, text, text) to authenticated;

comment on function public.list_conversation_inbox(uuid, integer, integer, text, text) is
  'Conversas + IA PR 2: página da caixa de entrada com busca e filtro pela situação do atendimento, mais a contagem por situação sobre todo o conjunto alcançável.';
