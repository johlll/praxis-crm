-- A6 — redistribuição da correção de list_activities() como migration.
--
-- A correção em si (achado real na validação manual de preview: os ramos
-- 'today'/'tomorrow'/'week'/'unassigned' do CASE de filtro traziam
-- "status = 'pending' and" embutido neles mesmos, então um chamador
-- pedindo p_status='all' — a Agenda semanal pede isso de propósito, pra
-- mostrar concluídas também — tinha essas atividades escondidas pelo
-- próprio filtro de data antes mesmo da cláusula externa p_status entrar
-- em jogo) já foi aplicada editando diretamente
-- 20260911120300_a6_read_functions.sql (ainda não mergeado — sem
-- problema editar um arquivo que nenhum outro ambiente aplicou pela
-- primeira vez ainda) e replicada manualmente via SQL direto no
-- praxis-crm-dev hospedado, já que "supabase db push" não reaplica um
-- arquivo de migration cujo nome já consta como aplicado, mesmo com
-- conteúdo diferente.
--
-- Esta migration nova formaliza a mesma correção como um passo do
-- histórico, de modo que qualquer banco que já tenha rodado a versão
-- ANTERIOR do arquivo original (aplicado sem passar por este ajuste
-- manual) fique correto com um "supabase db push" normal — sem
-- "db reset", sem apagar dado nenhum. Em um banco que já aplicou a
-- versão CORRIGIDA do arquivo original (caso do CI, que sempre aplica os
-- arquivos do zero, em ordem), este CREATE OR REPLACE é um no-op: recria
-- a função com o mesmo corpo que já estava valendo.
--
-- Corpo idêntico ao vigente em 20260911120300_a6_read_functions.sql,
-- só como CREATE OR REPLACE em vez de CREATE (mesma assinatura, mesmos
-- 8 parâmetros — nenhuma mudança de contrato).

create or replace function public.list_activities(
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
