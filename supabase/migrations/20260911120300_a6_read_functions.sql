-- A6 — Atividades: funções de leitura (detalhe, listagem com filtros e
-- contadores, contadores da sidebar).
--
-- Fronteiras de dia/semana (documentadas aqui, únicas no código — usadas
-- por list_activities() e get_activity_counts()):
--   - "hoje": [meia-noite de hoje, meia-noite de amanhã) no fuso
--     America/Sao_Paulo.
--   - "amanhã": [meia-noite de amanhã, meia-noite de depois de amanhã).
--   - "semana": [segunda-feira desta semana, segunda-feira da semana
--     seguinte) — date_trunc('week', ...) do Postgres já trunca para a
--     segunda-feira (semana ISO 8601), exatamente a regra pedida.
--   - "atrasada": status = 'pending' e due_at < now() — devido a due_at já
--     ser sempre um instante real (timestamptz), e devido a uma atividade
--     "só de data" ser normalizada para o FIM do dia (23:59:59) no
--     momento da escrita (create_activity()/reschedule_activity()), essa
--     única comparação funciona igual para compromisso com horário e
--     atividade só de data, sem duplicar lógica de fronteira.
-- Tudo calculado em SQL com "AT TIME ZONE 'America/Sao_Paulo'" explícito
-- — nunca no fuso da máquina que roda o servidor Node (Vercel, UTC) nem
-- no fuso do navegador de quem chama.

create function private.activity_filter_bounds()
returns table (
  today_start timestamptz,
  tomorrow_start timestamptz,
  day_after_tomorrow_start timestamptz,
  week_start timestamptz,
  week_end timestamptz
)
language sql
stable
set search_path = ''
as $body$
  select
    (b.d) at time zone 'America/Sao_Paulo',
    (b.d + interval '1 day') at time zone 'America/Sao_Paulo',
    (b.d + interval '2 day') at time zone 'America/Sao_Paulo',
    (b.w) at time zone 'America/Sao_Paulo',
    (b.w + interval '7 day') at time zone 'America/Sao_Paulo'
  from (
    select
      date_trunc('day', now() at time zone 'America/Sao_Paulo') as d,
      date_trunc('week', now() at time zone 'America/Sao_Paulo') as w
  ) b;
$body$;

comment on function private.activity_filter_bounds() is
  'Fronteiras de hoje/amanhã/semana em America/Sao_Paulo, como instantes reais (timestamptz) — calculadas inteiramente no servidor, nunca a partir do fuso do navegador ou da máquina que roda o Node.';

revoke all on function private.activity_filter_bounds() from public;
grant execute on function private.activity_filter_bounds() to authenticated;

-- ---------------------------------------------------------------------
-- get_activity — detalhe de uma atividade (usado para abrir o formulário
-- de edição já preenchido — "visualizar" desta fase é o próprio item da
-- lista mais este detalhe, sem uma tela de rota própria).
-- ---------------------------------------------------------------------

create function public.get_activity(p_activity_id uuid)
returns jsonb
language plpgsql
security definer
stable
set search_path = ''
as $body$
declare
  v_actor uuid := auth.uid();
  v_role public.membership_role;
  v_activity public.activities;
  v_lead public.leads;
  v_contact_name text;
  v_assigned_to_name text;
begin
  if v_actor is null then
    raise exception 'authentication_required';
  end if;

  select * into v_activity from public.activities where id = p_activity_id;
  if v_activity.id is null then
    raise exception 'activity_not_found';
  end if;

  select * into v_lead from public.leads where id = v_activity.lead_id;

  if not private.has_workspace_role(
    v_activity.workspace_id,
    array['owner', 'admin', 'manager', 'lawyer', 'sales', 'viewer']::public.membership_role[]
  ) then
    raise exception 'insufficient_permission';
  end if;

  select role into v_role from public.memberships
  where workspace_id = v_activity.workspace_id and user_id = v_actor and status = 'active';

  if not private.lead_accessible_to_role(v_role, v_lead.assigned_to, v_actor) then
    raise exception 'activity_not_found';
  end if;

  select c.name into v_contact_name from public.contacts c where c.id = v_lead.contact_id;
  select full_name into v_assigned_to_name from public.users where id = v_activity.assigned_to;

  return jsonb_build_object(
    'id', v_activity.id,
    'workspace_id', v_activity.workspace_id,
    'lead_id', v_activity.lead_id,
    'opportunity_id', v_activity.opportunity_id,
    'contact_name', v_contact_name,
    'legal_area', v_lead.legal_area,
    'type', v_activity.type,
    'title', v_activity.title,
    'notes', v_activity.notes,
    'assigned_to', v_activity.assigned_to,
    'assigned_to_name', v_assigned_to_name,
    'priority', v_activity.priority,
    'due_at', v_activity.due_at,
    'has_time', v_activity.has_time,
    'status', v_activity.status,
    'completed_at', v_activity.completed_at,
    'source', v_activity.source,
    'lock_version', v_activity.lock_version,
    'created_at', v_activity.created_at,
    'updated_at', v_activity.updated_at
  );
end;
$body$;

revoke all on function public.get_activity(uuid) from public;
grant execute on function public.get_activity(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- list_activities — a Central de Atividades. p_filter é um chip único
-- (não combinável, mesmo modelo de aba do protótipo): 'overdue' | 'today'
-- | 'tomorrow' | 'week' | 'unassigned' | null (todas). p_status filtra
-- pendente/concluída independentemente do chip (default 'pending' — a
-- tela principal só mostra o que ainda não foi concluído).
--
-- `counts` no retorno reflete SEMPRE as pendentes dentro do escopo de
-- p_lead_id/p_opportunity_id (não do p_status/p_filter aplicado à
-- listagem) — é o número que os próprios chips mostram ao lado do rótulo,
-- então precisa ser estável independente de qual chip está selecionado
-- agora.
-- ---------------------------------------------------------------------

create function public.list_activities(
  p_workspace_id uuid,
  p_filter text default null,
  p_lead_id uuid default null,
  p_opportunity_id uuid default null,
  p_status public.activity_status default 'pending',
  p_sort text default 'due_at_asc',
  p_page integer default 1,
  p_page_size integer default 20
)
returns table (items jsonb, total_count bigint, counts jsonb)
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
  v_today_start timestamptz;
  v_tomorrow_start timestamptz;
  v_day_after timestamptz;
  v_week_start timestamptz;
  v_week_end timestamptz;
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

  select today_start, tomorrow_start, day_after_tomorrow_start, week_start, week_end
    into v_today_start, v_tomorrow_start, v_day_after, v_week_start, v_week_end
  from private.activity_filter_bounds();

  v_page_size := greatest(1, least(coalesce(p_page_size, 20), 100));
  v_offset := (greatest(1, coalesce(p_page, 1)) - 1) * v_page_size;

  return query
  with accessible as (
    select
      a.id, a.lead_id, a.opportunity_id, a.type, a.title, a.notes,
      a.assigned_to, a.priority, a.due_at, a.has_time, a.status, a.completed_at,
      a.source, a.lock_version, a.created_at, a.updated_at,
      c.name as contact_name, l.legal_area, u.full_name as assigned_to_name
    from public.activities a
    join public.leads l on l.id = a.lead_id
    join public.contacts c on c.id = l.contact_id
    left join public.users u on u.id = a.assigned_to
    where a.workspace_id = p_workspace_id
      and private.lead_accessible_to_role(v_role, l.assigned_to, v_actor)
      and (p_lead_id is null or a.lead_id = p_lead_id)
      and (p_opportunity_id is null or a.opportunity_id = p_opportunity_id)
  ),
  counts as (
    select
      count(*) filter (where status = 'pending' and due_at < now()) as overdue,
      count(*) filter (
        where status = 'pending' and due_at >= v_today_start and due_at < v_tomorrow_start
      ) as today,
      count(*) filter (
        where status = 'pending' and due_at >= v_tomorrow_start and due_at < v_day_after
      ) as tomorrow,
      count(*) filter (
        where status = 'pending' and due_at >= v_week_start and due_at < v_week_end
      ) as week,
      count(*) filter (where status = 'pending' and assigned_to is null) as unassigned
    from accessible
  ),
  filtered as (
    select
      accessible.*,
      row_number() over (
        order by
          case when p_sort = 'due_at_desc' then due_at end desc,
          case when p_sort is null or p_sort = 'due_at_asc' then due_at end asc,
          id asc
      ) as rn,
      count(*) over () as full_count
    from accessible
    where (p_status is null or status = p_status)
      -- "overdue" continua exigindo status='pending' aqui dentro mesmo
      -- quando o chamador pede p_status='all' (agenda semanal) — uma
      -- atividade concluída nunca é "atrasada", é só uma atividade que
      -- foi concluída (isOverdue nunca é true para status='done', mesmo
      -- critério usado em toda a aplicação). Os outros filtros (hoje/
      -- amanhã/semana/sem responsável) são só sobre DATA/atribuição —
      -- quem decide quais status entram é exclusivamente a cláusula
      -- p_status acima, não o filtro; sem isso, a agenda semanal
      -- (p_status='all') nunca mostraria uma atividade já concluída na
      -- coluna do dia certo (achado real na validação manual no preview).
      and (
        case p_filter
          when 'overdue' then (status = 'pending' and due_at < now())
          when 'today' then (due_at >= v_today_start and due_at < v_tomorrow_start)
          when 'tomorrow' then (due_at >= v_tomorrow_start and due_at < v_day_after)
          when 'week' then (due_at >= v_week_start and due_at < v_week_end)
          when 'unassigned' then (assigned_to is null)
          else true
        end
      )
  ),
  page as (
    select * from filtered where rn > v_offset and rn <= v_offset + v_page_size
  )
  select
    coalesce(
      (
        select jsonb_agg(
          jsonb_build_object(
            'id', p.id, 'lead_id', p.lead_id, 'opportunity_id', p.opportunity_id,
            'contact_name', p.contact_name, 'legal_area', p.legal_area,
            'type', p.type, 'title', p.title, 'notes', p.notes,
            'assigned_to', p.assigned_to, 'assigned_to_name', p.assigned_to_name,
            'priority', p.priority, 'due_at', p.due_at, 'has_time', p.has_time,
            'status', p.status, 'completed_at', p.completed_at,
            'source', p.source, 'lock_version', p.lock_version,
            'created_at', p.created_at, 'updated_at', p.updated_at
          )
          order by p.rn
        )
        from page p
      ),
      '[]'::jsonb
    ),
    coalesce((select full_count from filtered limit 1), 0),
    (
      select jsonb_build_object(
        'overdue', overdue, 'today', today, 'tomorrow', tomorrow, 'week', week, 'unassigned', unassigned
      )
      from counts
    );
end;
$body$;

revoke all on function public.list_activities(uuid, text, uuid, uuid, public.activity_status, text, integer, integer) from public;
grant execute on function public.list_activities(uuid, text, uuid, uuid, public.activity_status, text, integer, integer) to authenticated;

-- ---------------------------------------------------------------------
-- get_activity_counts — mesmos 5 números de list_activities(), sem
-- listagem nenhuma (usado pelo badge da sidebar, chamado em toda
-- navegação pelo layout — precisa ser barato e não carregar itens).
-- ---------------------------------------------------------------------

create function public.get_activity_counts(p_workspace_id uuid)
returns jsonb
language plpgsql
security definer
stable
set search_path = ''
as $body$
declare
  v_actor uuid := auth.uid();
  v_role public.membership_role;
  v_today_start timestamptz;
  v_tomorrow_start timestamptz;
  v_day_after timestamptz;
  v_week_start timestamptz;
  v_week_end timestamptz;
  v_result jsonb;
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

  select today_start, tomorrow_start, day_after_tomorrow_start, week_start, week_end
    into v_today_start, v_tomorrow_start, v_day_after, v_week_start, v_week_end
  from private.activity_filter_bounds();

  select jsonb_build_object(
    'overdue', count(*) filter (where a.status = 'pending' and a.due_at < now()),
    'today', count(*) filter (
      where a.status = 'pending' and a.due_at >= v_today_start and a.due_at < v_tomorrow_start
    ),
    'tomorrow', count(*) filter (
      where a.status = 'pending' and a.due_at >= v_tomorrow_start and a.due_at < v_day_after
    ),
    'week', count(*) filter (
      where a.status = 'pending' and a.due_at >= v_week_start and a.due_at < v_week_end
    ),
    'unassigned', count(*) filter (where a.status = 'pending' and a.assigned_to is null)
  )
  into v_result
  from public.activities a
  join public.leads l on l.id = a.lead_id
  where a.workspace_id = p_workspace_id
    and private.lead_accessible_to_role(v_role, l.assigned_to, v_actor);

  return v_result;
end;
$body$;

revoke all on function public.get_activity_counts(uuid) from public;
grant execute on function public.get_activity_counts(uuid) to authenticated;
