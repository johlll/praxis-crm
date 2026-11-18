-- Conversas + IA — painel do caso (PR A da correção de direção da interface).
--
-- ADITIVA e SÓ DE LEITURA: nenhuma tabela, coluna, gatilho ou dado novo, e nenhuma escrita.
-- Uma função privada nova e duas funções públicas recriadas com a MESMA assinatura, o MESMO
-- alcance por papel e as MESMAS chaves de antes, só com chaves novas no JSON:
--
--   private.conversation_case_resolution(conversa, papel, ator)
--     A regra-base de "qual caso representa esta conversa", agora num lugar só, usada pela
--     lista e pelo painel (antes ela existia só no TypeScript do painel). Ordem: o vínculo
--     persistido da conversa, se ele está entre as opções; senão a ÚNICA oportunidade do lead
--     a que a conversa está ligada; senão a ÚNICA oportunidade do contato; senão nenhum — com
--     vários casos e nenhuma ligação inequívoca, nada é escolhido por palpite. As opções são
--     exatamente as de list_conversation_case_options (leads do mesmo contato, no alcance do
--     papel por private.lead_accessible_to_role), então lista e painel nunca divergem em
--     permissão. O foco escolhido na URL fica fora daqui: é estado da tela aberta e nunca
--     altera conversations.opportunity_id.
--
--   public.list_conversation_case_options  (+ case_count, default_opportunity_id, default_source)
--   public.list_conversation_inbox         (+ case_count, case_source, case por item)
--
-- Nada muda em list_conversations, nas trilhas de status, nos efeitos da B3 nem em qualquer
-- escrita. A ordem, a paginação, a busca, o filtro e as contagens da lista são as mesmas.

create function private.conversation_case_resolution(
  p_conversation_id uuid,
  p_role public.membership_role,
  p_actor uuid
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $body$
  with conv as (
    select c.id, c.workspace_id, c.contact_id, c.lead_id, c.opportunity_id
    from public.conversations c
    where c.id = p_conversation_id
  ),
  opts as (
    select o.id, o.lead_id
    from conv
    join public.leads l on l.workspace_id = conv.workspace_id and l.contact_id = conv.contact_id
    join public.opportunities o on o.lead_id = l.id and o.workspace_id = l.workspace_id
    where conv.contact_id is not null
      and private.lead_accessible_to_role(p_role, l.assigned_to, p_actor)
  ),
  pick as (
    select
      (select count(*) from opts) as n,
      (select o.id from opts o join conv on o.id = conv.opportunity_id) as linked_id,
      (select case when count(*) = 1 then min(o.id::text)::uuid end
         from opts o join conv on o.lead_id = conv.lead_id) as lead_only_id,
      (select case when count(*) = 1 then min(o.id::text)::uuid end from opts o) as contact_only_id
  )
  select jsonb_build_object(
    'case_count', pick.n,
    'default_opportunity_id', coalesce(pick.linked_id, pick.lead_only_id, pick.contact_only_id),
    'default_source', case
      when pick.linked_id is not null then 'linked'
      when pick.lead_only_id is not null then 'lead'
      when pick.contact_only_id is not null then 'only'
    end
  )
  from pick;
$body$;

comment on function private.conversation_case_resolution(uuid, public.membership_role, uuid) is
  'Conversas + IA (painel do caso): regra-base do caso padrão de uma conversa (vínculo persistido, única oportunidade do lead, única do contato ou nenhum), compartilhada pela lista e pelo painel. Só leitura; quem chama já conferiu o alcance da conversa.';

revoke all on function private.conversation_case_resolution(uuid, public.membership_role, uuid)
  from public, anon, authenticated, service_role;

create or replace function public.list_conversation_case_options(p_conversation_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $body$
declare
  v_actor uuid := auth.uid();
  v_target record;
  v_conv public.conversations;
  v_resolution jsonb;
begin
  if v_actor is null then
    raise exception 'authentication_required';
  end if;

  select * into v_target from private.status_track_target('attendance', p_conversation_id, v_actor);
  select * into v_conv from public.conversations where id = v_target.conversation_id;
  v_resolution := private.conversation_case_resolution(v_conv.id, v_target.role, v_actor);

  return jsonb_build_object(
    'conversation_id', v_conv.id,
    'contact_resolved', v_conv.contact_id is not null,
    'linked_opportunity_id', v_conv.opportunity_id,
    'case_count', (v_resolution ->> 'case_count')::integer,
    'default_opportunity_id', v_resolution ->> 'default_opportunity_id',
    'default_source', v_resolution ->> 'default_source',
    'items', coalesce((
      select jsonb_agg(private.conversation_case_item(o.id, v_conv.opportunity_id)
                       order by (o.id = v_conv.opportunity_id) desc,
                                case o.status when 'open' then 0 when 'won' then 1 else 2 end,
                                o.created_at desc, o.id)
      from public.opportunities o
      join public.leads l on l.id = o.lead_id and l.workspace_id = o.workspace_id
      where v_conv.contact_id is not null
        and o.workspace_id = v_conv.workspace_id
        and l.contact_id = v_conv.contact_id
        and private.lead_accessible_to_role(v_target.role, l.assigned_to, v_actor)
    ), '[]'::jsonb)
  );
end;
$body$;

comment on function public.list_conversation_case_options(uuid) is
  'Conversas + IA: oportunidades que podem ficar em foco numa conversa (leads do mesmo contato, no alcance do papel) e o caso padrão pela regra compartilhada com a lista. Só leitura; o vínculo persistido não muda.';

create or replace function public.list_conversation_inbox(
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
            'attendance_status', p.attendance_status,
            -- Resumo do caso (painel do caso): MESMA regra do painel
            -- (private.conversation_case_resolution), sem o foco da URL, que é só da tela aberta.
            'case_count', (cr.r ->> 'case_count')::integer,
            'case_source', cr.r ->> 'default_source',
            'case', case when cr.r ->> 'default_opportunity_id' is not null
              then private.conversation_case_item((cr.r ->> 'default_opportunity_id')::uuid, p.opportunity_id) end
          )
          order by p.rn
        )
        from page p
        cross join lateral (select private.conversation_case_resolution(p.id, v_role, v_actor) as r) cr
      ),
      '[]'::jsonb
    ),
    coalesce((select full_count from ordered limit 1), 0),
    (select j from counts);
end;
$body$;

comment on function public.list_conversation_inbox(uuid, integer, integer, text, text) is
  'Conversas + IA: página da caixa de entrada com busca e filtro pela situação do atendimento, contagem por situação sobre todo o conjunto alcançável e o resumo do caso de cada conversa (regra compartilhada com o painel).';
