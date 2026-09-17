-- A10 — Visão geral (dashboard) com dados reais.
--
-- Definições completas de cada indicador (entidade, data, filtros,
-- fórmula, ausência/zero/período anterior, alcance por papel) em
-- docs/decisoes/a10-dashboard.md. Este arquivo implementa exatamente
-- aquelas definições; qualquer mudança aqui muda o documento junto.
--
-- Regras que valem para TODOS os blocos:
--   1. Alcance por registro ANTES de agregar: o conjunto de leads visíveis
--      (CTE `sl`) passa por private.lead_accessible_to_role() — a mesma
--      regra de leitura de leads, oportunidades e atividades desde a A4 —
--      e só depois qualquer contagem, soma, série, ranking ou insight é
--      calculado sobre ele. Nenhuma permissão nova é criada.
--   2. Projeção financeira no servidor: somas, médias e séries em
--      dinheiro só existem no JSON para owner/admin/manager/lawyer (mesma
--      regra de private.opportunity_column_sum_projection, A5). Sales
--      recebe só a faixa de cada oportunidade individual
--      (private.opportunity_financial_projection); viewer não recebe
--      nenhuma chave financeira. Toda chave monetária termina em `_cents`
--      (a faixa é `value_band`), o que os testes de payload verificam.
--   3. Cada indicador de período usa a SUA data (lead.created_at,
--      activity.completed_at, proposal.sent_at, opportunity.won_at) — o
--      período nunca é aplicado globalmente pela criação do lead.
--   4. Tudo é agregado em SQL sobre todos os registros pertinentes: nada
--      depende de página, limite ou total truncado. As duas listas
--      (atenção e agenda de hoje) trazem o total real ao lado dos itens
--      exibidos.

-- ---------------------------------------------------------------------
-- workspaces.is_demo — identifica o escritório exclusivamente
-- demonstrativo (seed e praxis-crm-dev). `authenticated` só tem SELECT em
-- workspaces (20260908040000), então nenhum usuário consegue marcar ou
-- desmarcar a coluna pelo app ou pela API; só quem aplica SQL no banco.
-- ---------------------------------------------------------------------

alter table public.workspaces
  add column is_demo boolean not null default false;

comment on column public.workspaces.is_demo is
  'true = escritório com dados exclusivamente fictícios, criado para demonstração/validação. A interface mostra a marcação "Dados demonstrativos". Só alterável por SQL direto (sem grant de UPDATE).';

-- ---------------------------------------------------------------------
-- private.office_timezone — fuso do escritório. O schema ainda não tem
-- fuso por workspace; o único fuso em uso desde a A6 é America/Sao_Paulo
-- (private.activity_filter_bounds, src/lib/timezone.ts). Centralizado
-- aqui para o dashboard; quando existir fuso por escritório, só esta
-- função muda.
-- ---------------------------------------------------------------------

create function private.office_timezone(p_workspace_id uuid)
returns text
language sql
stable
set search_path = ''
as $body$
  select 'America/Sao_Paulo'::text;
$body$;

comment on function private.office_timezone(uuid) is
  'Fuso do escritório. Hoje fixo em America/Sao_Paulo (mesmo da A6), com o parâmetro já pronto para fuso por workspace.';

revoke all on function private.office_timezone(uuid) from public;
grant execute on function private.office_timezone(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- private.dashboard_period_bounds — período atual e anterior, em dias
-- de calendário do fuso do escritório, intervalos meio-abertos [início,
-- fim) sem sobreposição:
--   atual    = [meia-noite de (hoje - N + 1), meia-noite de amanhã)
--   anterior = [meia-noite de (hoje - 2N + 1), início do atual)
-- Os dois têm exatamente N dias de calendário. O atual inclui hoje, que
-- ainda está em andamento (eventos futuros não existem para as datas
-- usadas: criação, conclusão, envio e ganho são sempre "agora" ou antes).
-- ---------------------------------------------------------------------

create function private.dashboard_period_bounds(p_days integer, p_timezone text)
returns table (
  current_start timestamptz,
  current_end timestamptz,
  previous_start timestamptz,
  previous_end timestamptz,
  today_date date
)
language sql
stable
set search_path = ''
as $body$
  select
    (b.d - make_interval(days => p_days - 1)) at time zone p_timezone,
    (b.d + interval '1 day') at time zone p_timezone,
    (b.d - make_interval(days => 2 * p_days - 1)) at time zone p_timezone,
    (b.d - make_interval(days => p_days - 1)) at time zone p_timezone,
    b.d::date
  from (select date_trunc('day', now() at time zone p_timezone) as d) b;
$body$;

revoke all on function private.dashboard_period_bounds(integer, text) from public;
grant execute on function private.dashboard_period_bounds(integer, text) to authenticated;

-- ---------------------------------------------------------------------
-- get_dashboard — tudo o que a Visão geral mostra, numa única consulta
-- (mesmo instante `now()` e mesmo snapshot para todos os blocos).
--
-- Filtros:
--   p_period_days     7, 30 ou 90 (qualquer outro valor: invalid_period)
--   p_assigned_to     responsável ATUAL do lead (null = todos)
--   p_only_unassigned só leads sem responsável (não combina com o acima)
--   p_legal_area      área jurídica do lead, igualdade exata (null = todas)
--   p_pipeline_id     pipeline do funil (null = pipeline padrão). Só o
--                     bloco do funil é por pipeline: etapas de pipelines
--                     diferentes nunca são somadas entre si.
-- Os três filtros de lead valem para todos os blocos, porque todo
-- indicador parte de `sl`.
-- ---------------------------------------------------------------------

create function public.get_dashboard(
  p_workspace_id uuid,
  p_period_days integer default 30,
  p_assigned_to uuid default null,
  p_only_unassigned boolean default false,
  p_legal_area text default null,
  p_pipeline_id uuid default null
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
  v_money boolean;
  v_tz text;
  v_is_demo boolean;
  v_pipeline public.pipelines;
  v_bucket_days integer;
  v_stalled_days constant integer := 5;
  v_attention_limit constant integer := 20;
  v_agenda_limit constant integer := 50;
  v_legal_area text := nullif(btrim(coalesce(p_legal_area, '')), '');
  v_result jsonb;
begin
  if v_actor is null then
    raise exception 'authentication_required';
  end if;

  if p_period_days is null or p_period_days not in (7, 30, 90) then
    raise exception 'invalid_period';
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

  v_money := v_role in ('owner', 'admin', 'manager', 'lawyer');
  v_tz := private.office_timezone(p_workspace_id);
  select is_demo into v_is_demo from public.workspaces where id = p_workspace_id;

  if p_pipeline_id is not null then
    select * into v_pipeline from public.pipelines
    where id = p_pipeline_id and workspace_id = p_workspace_id;
    if v_pipeline.id is null then
      raise exception 'pipeline_not_found';
    end if;
  else
    select * into v_pipeline from public.pipelines
    where workspace_id = p_workspace_id and is_default
    limit 1;
  end if;

  -- 7 dias: barras diárias; 30 e 90: seis barras de 5 e de 15 dias.
  v_bucket_days := case p_period_days when 7 then 1 when 30 then 5 else 15 end;

  with
  b as (
    select * from private.dashboard_period_bounds(p_period_days, v_tz)
  ),
  t as (
    select
      (b.today_date::timestamp) at time zone v_tz as today_start,
      ((b.today_date + 1)::timestamp) at time zone v_tz as tomorrow_start
    from b
  ),
  -- Leads visíveis para quem chama (alcance) E dentro dos filtros.
  sl as (
    select l.id, l.contact_id, l.legal_area, l.assigned_to, l.created_at
    from public.leads l
    where l.workspace_id = p_workspace_id
      and private.lead_accessible_to_role(v_role, l.assigned_to, v_actor)
      and (p_assigned_to is null or l.assigned_to = p_assigned_to)
      and (not coalesce(p_only_unassigned, false) or l.assigned_to is null)
      and (v_legal_area is null or l.legal_area = v_legal_area)
  ),
  opp as (
    select o.*, l.assigned_to as lead_assigned_to, l.created_at as lead_created_at, l.contact_id, l.legal_area
    from public.opportunities o
    join sl l on l.id = o.lead_id
    where o.workspace_id = p_workspace_id
  ),
  act as (
    select a.*
    from public.activities a
    join sl l on l.id = a.lead_id
    where a.workspace_id = p_workspace_id
  ),
  prop as (
    select p.*
    from public.proposals p
    join sl l on l.id = p.lead_id
    where p.workspace_id = p_workspace_id
  ),
  won_cur as (
    select o.* from opp o, b
    where o.status = 'won' and o.won_at >= b.current_start and o.won_at < b.current_end
  ),
  won_prev as (
    select o.* from opp o, b
    where o.status = 'won' and o.won_at >= b.previous_start and o.won_at < b.previous_end
  ),
  open_opp as (
    select
      o.*,
      o.stage_entered_at < now() - make_interval(days => v_stalled_days) as is_stalled,
      o.lead_assigned_to is null as is_unassigned,
      (
        select count(*) from act a
        where a.opportunity_id = o.id and a.status = 'pending' and a.due_at < now()
      ) as overdue_count,
      exists (
        select 1 from act a
        where a.opportunity_id = o.id and a.status = 'pending' and a.due_at >= now()
      ) as has_next_action
    from opp o
    where o.status = 'open'
  ),
  attention as (
    select * from open_opp
    where is_stalled or is_unassigned or overdue_count > 0
  ),
  cohort_leads as (
    select l.id from sl l, b
    where l.created_at >= b.current_start and l.created_at < b.current_end
  ),
  buckets as (
    select
      g as idx,
      ((b.today_date - (p_period_days - 1) + g * v_bucket_days)::timestamp) at time zone v_tz as bucket_start,
      ((b.today_date - (p_period_days - 1) + (g + 1) * v_bucket_days)::timestamp) at time zone v_tz as bucket_end,
      (b.today_date - (p_period_days - 1) + g * v_bucket_days) as start_date,
      (b.today_date - (p_period_days - 1) + (g + 1) * v_bucket_days - 1) as last_date
    from b, generate_series(0, p_period_days / v_bucket_days - 1) g
  ),
  forecast_buckets as (
    select
      g as idx,
      (b.today_date + g * v_bucket_days) as start_date,
      (b.today_date + (g + 1) * v_bucket_days - 1) as last_date
    from b, generate_series(0, p_period_days / v_bucket_days - 1) g
  ),
  members as (
    select m.user_id, m.role, u.full_name
    from public.memberships m
    join public.users u on u.id = m.user_id
    where m.workspace_id = p_workspace_id and m.status = 'active'
  ),
  team_rows as (
    select
      x.user_id,
      (select count(*) from sl l, b where l.assigned_to is not distinct from x.user_id
         and l.created_at >= b.current_start and l.created_at < b.current_end) as leads_received,
      (select count(*) from act a, b where a.assigned_to is not distinct from x.user_id
         and a.type = 'meeting' and a.status = 'done'
         and a.completed_at >= b.current_start and a.completed_at < b.current_end) as consultations_done,
      (select count(*) from won_cur w where w.lead_assigned_to is not distinct from x.user_id) as opportunities_won,
      (select count(*) from act a where a.assigned_to is not distinct from x.user_id
         and a.status = 'pending' and a.due_at < now()) as overdue_activities
    from (select user_id from members union all select null::uuid) x
  ),
  fstages as (
    select ps.id, ps.name, ps.position
    from public.pipeline_stages ps
    where ps.pipeline_id = v_pipeline.id
  ),
  -- Coorte do funil: oportunidades do pipeline criadas no período. Para
  -- cada uma, a maior posição de etapa já ocupada: etapa atual, e origem
  -- e destino de cada transição registrada (a etapa de criação é a origem
  -- da primeira transição; sem transição, é a etapa atual). Uma
  -- oportunidade conta UMA vez por etapa, por mais que tenha voltado e
  -- reentrado.
  cohort as (
    select
      o.id, o.status, o.stage_id,
      (
        select max(fs.position)
        from fstages fs
        where fs.id = o.stage_id
           or fs.id in (select st.from_stage_id from public.stage_transitions st where st.opportunity_id = o.id)
           or fs.id in (select st.to_stage_id from public.stage_transitions st where st.opportunity_id = o.id)
      ) as max_position
    from opp o, b
    where o.pipeline_id = v_pipeline.id
      and o.created_at >= b.current_start and o.created_at < b.current_end
  )
  select jsonb_build_object(
    'role', v_role,
    'is_demo', coalesce(v_is_demo, false),
    'generated_at', now(),
    'timezone', v_tz,
    'stalled_days', v_stalled_days,
    'period', (
      select jsonb_build_object(
        'days', p_period_days,
        'current_start', b.current_start, 'current_end', b.current_end,
        'previous_start', b.previous_start, 'previous_end', b.previous_end,
        'today', b.today_date
      ) from b
    ),
    'filters', jsonb_build_object(
      'assigned_to', p_assigned_to,
      'only_unassigned', coalesce(p_only_unassigned, false),
      'legal_area', v_legal_area,
      'pipeline_id', v_pipeline.id
    ),
    -- Áreas existentes entre os leads VISÍVEIS (alcance, sem os demais
    -- filtros), para o seletor.
    'legal_areas', (
      select coalesce(jsonb_agg(x.legal_area order by x.legal_area), '[]'::jsonb)
      from (
        select distinct l.legal_area
        from public.leads l
        where l.workspace_id = p_workspace_id
          and private.lead_accessible_to_role(v_role, l.assigned_to, v_actor)
      ) x
    ),
    'period_metrics', (
      select jsonb_build_object(
        'leads_received', jsonb_build_object(
          'current', (select count(*) from sl l where l.created_at >= b.current_start and l.created_at < b.current_end),
          'previous', (select count(*) from sl l where l.created_at >= b.previous_start and l.created_at < b.previous_end)
        ),
        'consultations_done', jsonb_build_object(
          'current', (select count(*) from act a where a.type = 'meeting' and a.status = 'done'
                        and a.completed_at >= b.current_start and a.completed_at < b.current_end),
          'previous', (select count(*) from act a where a.type = 'meeting' and a.status = 'done'
                        and a.completed_at >= b.previous_start and a.completed_at < b.previous_end)
        ),
        'proposals_sent', jsonb_build_object(
          'current', (select count(*) from prop p where p.sent_at >= b.current_start and p.sent_at < b.current_end),
          'previous', (select count(*) from prop p where p.sent_at >= b.previous_start and p.sent_at < b.previous_end)
        ),
        'opportunities_won', jsonb_build_object(
          'current', (select count(*) from won_cur),
          'previous', (select count(*) from won_prev)
        ),
        'days_to_win', jsonb_build_object(
          'current', (select round(avg(extract(epoch from (w.won_at - w.lead_created_at)) / 86400.0), 1) from won_cur w),
          'previous', (select round(avg(extract(epoch from (w.won_at - w.lead_created_at)) / 86400.0), 1) from won_prev w)
        )
      ) || case when v_money then jsonb_build_object(
        'won_value_cents', jsonb_build_object(
          'current', (select coalesce(sum(w.value_cents), 0)::bigint from won_cur w),
          'previous', (select coalesce(sum(w.value_cents), 0)::bigint from won_prev w)
        )
      ) else '{}'::jsonb end
      from b
    ),
    'cohort', jsonb_build_object(
      'leads', (select count(*) from cohort_leads),
      'leads_with_won', (
        select count(*) from cohort_leads c
        where exists (select 1 from opp o where o.lead_id = c.id and o.status = 'won')
      )
    ),
    'positions', jsonb_build_object(
      'open_opportunities', (select count(*) from open_opp),
      'stalled_opportunities', (select count(*) from open_opp where is_stalled),
      'unassigned_open_opportunities', (select count(*) from open_opp where is_unassigned),
      'open_without_next_action', (select count(*) from open_opp where not has_next_action),
      'overdue_activities', (select count(*) from act a where a.status = 'pending' and a.due_at < now()),
      'opportunities_with_overdue', (select count(*) from open_opp where overdue_count > 0),
      'attention_opportunities', (select count(*) from attention),
      'today_activities', (select count(*) from act a, t where a.due_at >= t.today_start and a.due_at < t.tomorrow_start),
      'today_activities_pending', (select count(*) from act a, t where a.due_at >= t.today_start and a.due_at < t.tomorrow_start and a.status = 'pending')
    ) || case when v_money then jsonb_build_object(
      'open_value_cents', (select coalesce(sum(value_cents), 0)::bigint from open_opp),
      'open_without_value', (select count(*) from open_opp where value_cents is null),
      'attention_value_cents', (select coalesce(sum(value_cents), 0)::bigint from attention)
    ) else '{}'::jsonb end,
    'attention', jsonb_build_object(
      'total', (select count(*) from attention),
      'items', (
        select coalesce(jsonb_agg(x.item order by x.ord), '[]'::jsonb)
        from (
          select
            row_number() over (
              order by (a.overdue_count > 0) desc, a.is_stalled desc, a.stage_entered_at asc, a.id asc
            ) as ord,
            jsonb_build_object(
              'id', a.id, 'lead_id', a.lead_id, 'contact_name', c.name,
              'legal_area', a.legal_area, 'stage_id', a.stage_id, 'stage_name', ps.name,
              'pipeline_id', a.pipeline_id,
              'assigned_to', a.lead_assigned_to, 'assigned_to_name', u.full_name,
              'stage_entered_at', a.stage_entered_at,
              'is_stalled', a.is_stalled, 'is_unassigned', a.is_unassigned
            ) || private.opportunity_next_action(a.id)
              || private.opportunity_financial_projection(v_role, a.value_cents, a.fee_model, a.probability, a.forecast_date)
            as item
          from attention a
          join public.contacts c on c.id = a.contact_id
          join public.pipeline_stages ps on ps.id = a.stage_id
          left join public.users u on u.id = a.lead_assigned_to
          order by 1
          limit v_attention_limit
        ) x
      )
    ),
    'agenda_today', jsonb_build_object(
      'total', (select count(*) from act a, t where a.due_at >= t.today_start and a.due_at < t.tomorrow_start),
      'items', (
        select coalesce(jsonb_agg(x.item order by x.due_at, x.id), '[]'::jsonb)
        from (
          select a.due_at, a.id, jsonb_build_object(
            'id', a.id, 'lead_id', a.lead_id, 'opportunity_id', a.opportunity_id,
            'contact_name', c.name, 'type', a.type, 'title', a.title,
            'due_at', a.due_at, 'has_time', a.has_time, 'status', a.status,
            'assigned_to', a.assigned_to, 'assigned_to_name', u.full_name,
            'lock_version', a.lock_version
          ) as item
          from act a
          cross join t
          join public.leads l on l.id = a.lead_id
          join public.contacts c on c.id = l.contact_id
          left join public.users u on u.id = a.assigned_to
          where a.due_at >= t.today_start and a.due_at < t.tomorrow_start
          order by a.due_at, a.id
          limit v_agenda_limit
        ) x
      )
    ),
    'series', jsonb_build_object(
      'bucket_days', v_bucket_days,
      'won', (
        select jsonb_agg(
          jsonb_build_object(
            'start_date', bk.start_date, 'last_date', bk.last_date,
            'count', (select count(*) from won_cur w where w.won_at >= bk.bucket_start and w.won_at < bk.bucket_end)
          ) || case when v_money then jsonb_build_object(
            'value_cents', (select coalesce(sum(w.value_cents), 0)::bigint from won_cur w
                            where w.won_at >= bk.bucket_start and w.won_at < bk.bucket_end)
          ) else '{}'::jsonb end
          order by bk.idx
        )
        from buckets bk
      )
    ) || case when v_money then jsonb_build_object(
      -- Posição atual: oportunidades abertas por data prevista, nos
      -- próximos N dias. Data prevista e valor são campos da projeção
      -- financeira (sales/viewer não os recebem), então o bloco inteiro
      -- só existe para os papéis com valor exato.
      'forecast', jsonb_build_object(
        'buckets', (
          select jsonb_agg(jsonb_build_object(
            'start_date', fb.start_date, 'last_date', fb.last_date,
            'count', (select count(*) from open_opp o where o.forecast_date between fb.start_date and fb.last_date),
            'value_cents', (select coalesce(sum(o.value_cents), 0)::bigint from open_opp o
                            where o.forecast_date between fb.start_date and fb.last_date)
          ) order by fb.idx)
          from forecast_buckets fb
        ),
        'past_due', (select count(*) from open_opp o, b where o.forecast_date < b.today_date),
        'without_date', (select count(*) from open_opp o where o.forecast_date is null),
        'without_value', (select count(*) from open_opp o where o.value_cents is null)
      )
    ) else '{}'::jsonb end,
    'team', (
      select coalesce(jsonb_agg(
        jsonb_build_object(
          'user_id', tr.user_id,
          'full_name', mb.full_name,
          'leads_received', tr.leads_received,
          'consultations_done', tr.consultations_done,
          'opportunities_won', tr.opportunities_won,
          'overdue_activities', tr.overdue_activities
        ) order by tr.user_id is null, mb.full_name, tr.user_id
      ), '[]'::jsonb)
      from team_rows tr
      left join members mb on mb.user_id = tr.user_id
      -- Visualizador (nunca responsável por nada) e a linha "sem
      -- responsável" só aparecem quando têm algo a mostrar.
      where (tr.user_id is not null and mb.role <> 'viewer')
         or tr.leads_received + tr.consultations_done + tr.opportunities_won + tr.overdue_activities > 0
    ),
    'pipelines', (
      select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name, 'is_default', p.is_default)
        order by p.is_default desc, p.name), '[]'::jsonb)
      from public.pipelines p
      where p.workspace_id = p_workspace_id
    ),
    'funnel', case when v_pipeline.id is null then null else jsonb_build_object(
      'pipeline_id', v_pipeline.id,
      'pipeline_name', v_pipeline.name,
      'cohort_size', (select count(*) from cohort),
      'cohort_won', (select count(*) from cohort where status = 'won'),
      'cohort_lost', (select count(*) from cohort where status = 'lost'),
      'cohort_open', (select count(*) from cohort where status = 'open'),
      'stages', (
        select coalesce(jsonb_agg(
          jsonb_build_object(
            'stage_id', fs.id,
            'name', fs.name,
            'position', fs.position,
            'open_now', (select count(*) from open_opp o where o.stage_id = fs.id),
            'reached', (select count(*) from cohort c where c.max_position >= fs.position),
            'cohort_open_here', (select count(*) from cohort c where c.stage_id = fs.id and c.status = 'open'),
            'cohort_lost_here', (select count(*) from cohort c where c.stage_id = fs.id and c.status = 'lost')
          ) || private.opportunity_column_sum_projection(
            v_role,
            (select coalesce(sum(o.value_cents), 0)::bigint from open_opp o where o.stage_id = fs.id)
          )
          order by fs.position
        ), '[]'::jsonb)
        from fstages fs
      )
    ) end,
    -- Dados brutos dos insights: o texto é montado na aplicação, e cada
    -- insight só aparece acima do mínimo de casos documentado.
    'insight_data', jsonb_build_object(
      'stalled_top_stage', (
        select jsonb_build_object('stage_name', ps.name, 'count', count(*))
        from open_opp o
        join public.pipeline_stages ps on ps.id = o.stage_id
        where o.is_stalled
        group by ps.id, ps.name
        order by count(*) desc, ps.name
        limit 1
      ),
      'cohort_lost_top_reason', (
        select jsonb_build_object('label', lr.label, 'count', count(*))
        from opp o, b, public.lost_reasons lr
        where lr.id = o.lost_reason_id
          and o.status = 'lost'
          and o.created_at >= b.current_start and o.created_at < b.current_end
        group by lr.id, lr.label
        order by count(*) desc, lr.label
        limit 1
      ),
      'cohort_lost_total', (
        select count(*) from opp o, b
        where o.status = 'lost' and o.created_at >= b.current_start and o.created_at < b.current_end
      )
    )
  )
  into v_result;

  return v_result;
end;
$body$;

comment on function public.get_dashboard(uuid, integer, uuid, boolean, text, uuid) is
  'Visão geral (A10). Alcance por registro antes de agregar; valores em dinheiro só para owner/admin/manager/lawyer; definições em docs/decisoes/a10-dashboard.md.';

revoke all on function public.get_dashboard(uuid, integer, uuid, boolean, text, uuid) from public;
grant execute on function public.get_dashboard(uuid, integer, uuid, boolean, text, uuid) to authenticated;
