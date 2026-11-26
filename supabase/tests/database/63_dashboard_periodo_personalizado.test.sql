-- pgTAP — Visão geral com período personalizado (20261127120000).
--
--   A) Assinaturas: uma só de cada função, sem execução anônima.
--   B) Validação do período: atalhos, datas, ordem, futuro e limite de 366 dias.
--   C) Limites no fuso do escritório: início incluído, fim exclusivo no começo do dia seguinte, último
--      instante do último dia dentro, horário UTC que ainda é o dia anterior em São Paulo, e o período
--      anterior com a mesma quantidade de dias.
--   D) Um dia só, fevereiro bissexto, virada de ano e faixas da série.
--   E) Atalho e intervalo equivalente dão o mesmo resultado; "Agora", agenda de hoje e previsão não mudam.
--   F) Painel e atribuição contam a mesma coisa.
--   G) Papéis e isolamento entre escritórios com o intervalo.
--
-- Escritório criado dentro desta transação. Datas fixas no passado; só a parte E usa "hoje".

begin;
select plan(81);

\set ana    '20000000-0000-0000-0000-000000000001'
\set lucas  '20000000-0000-0000-0000-000000000011'
\set sofia  '20000000-0000-0000-0000-000000000012'
\set vitor  '20000000-0000-0000-0000-000000000013'
\set otavio '20000000-0000-0000-0000-000000000014'

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'otavio', 'role', 'authenticated')::text, true);
select (create_workspace_with_owner('Período A10', 'periodo-a10-dashboard')).id as ws \gset
reset role;

insert into public.memberships (workspace_id, user_id, role, status) values
  (:'ws'::uuid, :'lucas', 'lawyer', 'active'),
  (:'ws'::uuid, :'sofia', 'sales', 'active'),
  (:'ws'::uuid, :'vitor', 'viewer', 'active');

select id as pipeline from public.pipelines where workspace_id = :'ws'::uuid and is_default \gset
select id as s1 from public.pipeline_stages where pipeline_id = :'pipeline'::uuid and position = 1 \gset
select id as reason from public.lost_reasons where workspace_id = :'ws'::uuid order by position limit 1 \gset
select (now() at time zone 'America/Sao_Paulo')::date as today \gset

-- Horário de parede de São Paulo → instante.
create function pg_temp.sp(p_local text) returns timestamptz language sql stable as $$
  select p_local::timestamp at time zone 'America/Sao_Paulo'
$$;

-- Um lead por instante, cada um com o seu contato. O número do lead identifica as peças ligadas a ele.
create function pg_temp.lead_id(p_n integer) returns uuid language sql immutable as $$
  select ('b6300000-0000-0000-0000-' || lpad(p_n::text, 12, '0'))::uuid
$$;
create temporary table casos (n integer primary key, criado timestamptz, quem uuid, nota text) on commit drop;
insert into casos values
  -- Período 22 a 26/03/2025 (atual) e 17 a 21/03/2025 (anterior).
  (1, pg_temp.sp('2025-03-22 00:00:00'), :'lucas', 'primeiro instante do atual'),
  (2, pg_temp.sp('2025-03-26 23:59:59.999999'), :'otavio', 'último instante do atual'),
  (3, '2025-03-27 01:00:00+00', null, '26/03 22h em São Paulo, já 27 em UTC: atual'),
  (4, pg_temp.sp('2025-03-27 00:00:00'), null, 'meia-noite do dia seguinte: fora'),
  (5, pg_temp.sp('2025-03-21 23:59:59.999999'), :'otavio', 'último instante do anterior'),
  (6, '2025-03-22 02:00:00+00', null, '21/03 23h em São Paulo, já 22 em UTC: anterior'),
  (7, pg_temp.sp('2025-03-17 00:00:00'), :'lucas', 'primeiro instante do anterior'),
  (8, pg_temp.sp('2025-03-16 23:59:59.999999'), null, 'antes do anterior: fora'),
  -- Fevereiro bissexto e virada de ano.
  (9, pg_temp.sp('2024-02-29 12:00:00'), null, 'dia bissexto'),
  (10, pg_temp.sp('2024-02-27 12:00:00'), null, 'anterior do bissexto'),
  (11, pg_temp.sp('2025-12-31 23:30:00'), null, 'antes da virada'),
  (12, pg_temp.sp('2026-01-01 00:30:00'), null, 'depois da virada'),
  (13, pg_temp.sp('2025-12-29 12:00:00'), null, 'anterior da virada');

insert into public.contacts (id, workspace_id, type, name, created_by)
select ('a6300000-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid, :'ws'::uuid, 'pf', 'Período ' || n, :'otavio' from casos;

insert into public.leads (id, workspace_id, contact_id, legal_area, assigned_to, created_by, created_at)
select pg_temp.lead_id(n), :'ws'::uuid, ('a6300000-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid,
       'Cível', quem, :'otavio', criado
from casos;

-- Oportunidades: criadas no instante do lead. Ganhas nos instantes de borda dos casos 1, 2, 4, 5 e 7; a do
-- caso 3 está perdida; a do 6 segue aberta (posição atual), com data prevista daqui a 3 dias.
insert into public.opportunities (id, workspace_id, lead_id, pipeline_id, stage_id, value_cents, fee_model, status, won_at, lost_reason_id, forecast_date, stage_entered_at, created_by, created_at)
select ('c6300000-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid, :'ws'::uuid, pg_temp.lead_id(n), :'pipeline'::uuid, :'s1'::uuid,
       n * 100000, 'fixed',
       (case when n in (1, 2, 4, 5, 7) then 'won' when n = 3 then 'lost' else 'open' end)::public.opportunity_status,
       case when n in (1, 2, 4, 5, 7) then criado end,
       case when n = 3 then :'reason'::uuid end,
       case when n = 6 then :'today'::date + 3 end,
       criado, :'otavio', criado
from casos where n <= 7;

-- Consulta concluída e proposta enviada nos mesmos instantes de borda.
insert into public.activities (workspace_id, lead_id, opportunity_id, type, title, assigned_to, due_at, status, completed_at, created_by)
select :'ws'::uuid, pg_temp.lead_id(n), null, 'meeting', 'Consulta ' || n, quem, criado, 'done', criado, :'otavio'
from casos where n <= 8;

insert into public.proposals (workspace_id, lead_id, opportunity_id, number, value_cents, fee_model, status, sent_channels, sent_at, created_by)
select :'ws'::uuid, pg_temp.lead_id(n), ('c6300000-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid, 'P63-' || n, 1000, 'fixed', 'enviada', '{email}', criado, :'otavio'
from casos where n <= 7;

-- Agenda de hoje e uma atividade atrasada: posições atuais.
insert into public.activities (workspace_id, lead_id, opportunity_id, type, title, assigned_to, due_at, status, created_by) values
  (:'ws'::uuid, pg_temp.lead_id(6), 'c6300000-0000-0000-0000-000000000006', 'deadline', 'Prazo de hoje', null, pg_temp.sp(:'today' || ' 23:00:00'), 'pending', :'otavio'),
  (:'ws'::uuid, pg_temp.lead_id(6), 'c6300000-0000-0000-0000-000000000006', 'call', 'Ligação atrasada', null, now() - interval '3 days', 'pending', :'otavio');

-- ===================================================================
-- A) Assinaturas
-- ===================================================================
select is((select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'get_dashboard'), 1,
  'Existe uma única get_dashboard (sem sobrecarga ambígua)');
select is((select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'get_dashboard_attribution'), 1,
  'Existe uma única get_dashboard_attribution');
select is((select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname in ('get_dashboard', 'get_dashboard_attribution') and p.prosecdef
     and exists (select 1 from unnest(coalesce(p.proconfig, array[]::text[])) cfg where cfg like 'search_path=%')), 2,
  'As duas continuam SECURITY DEFINER com search_path travado');
select ok(not has_function_privilege('anon', 'public.get_dashboard(uuid, integer, uuid, boolean, text, uuid, date, date)', 'execute'),
  'Anônimo não executa get_dashboard');
select ok(not has_function_privilege('anon', 'public.get_dashboard_attribution(uuid, integer, text, text, uuid, boolean, text, date, date)', 'execute'),
  'Anônimo não executa get_dashboard_attribution');
select ok(has_function_privilege('authenticated', 'public.get_dashboard(uuid, integer, uuid, boolean, text, uuid, date, date)', 'execute')
  and has_function_privilege('authenticated', 'public.get_dashboard_attribution(uuid, integer, text, text, uuid, boolean, text, date, date)', 'execute'),
  'Autenticado executa as duas');

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'otavio', 'role', 'authenticated')::text, true);

-- ===================================================================
-- B) Validação
-- ===================================================================
select throws_ok(format($i$ select get_dashboard(%L::uuid, p_start_date => '2025-03-22') $i$, :'ws'), 'P0001', 'invalid_period', 'Só a data inicial é recusada');
select throws_ok(format($i$ select get_dashboard(%L::uuid, p_end_date => '2025-03-22') $i$, :'ws'), 'P0001', 'invalid_period', 'Só a data final é recusada');
select throws_ok(format($i$ select get_dashboard(%L::uuid, p_start_date => '2025-03-26', p_end_date => '2025-03-22') $i$, :'ws'), 'P0001', 'invalid_period', 'Datas invertidas são recusadas');
select throws_ok(format($i$ select get_dashboard(%L::uuid, p_start_date => %L::date, p_end_date => %L::date + 1) $i$, :'ws', :'today', :'today'), 'P0001', 'invalid_period', 'Terminar amanhã é recusado');
select throws_ok(format($i$ select get_dashboard(%L::uuid, p_start_date => '2024-01-01', p_end_date => '2025-01-01') $i$, :'ws'), 'P0001', 'invalid_period', '367 dias são recusados');
select lives_ok(format($i$ select get_dashboard(%L::uuid, p_start_date => '2024-01-01', p_end_date => '2024-12-31') $i$, :'ws'), '366 dias (ano bissexto inteiro) são aceitos');
select throws_ok(format($i$ select get_dashboard(%L::uuid, p_start_date => '-infinity', p_end_date => '-infinity') $i$, :'ws'), 'P0001', 'invalid_period', 'Data infinita é recusada');
select throws_ok(format($i$ select get_dashboard(%L::uuid, 15) $i$, :'ws'), 'P0001', 'invalid_period', 'Atalho desconhecido continua recusado');
select throws_ok(format($i$ select get_dashboard(%L::uuid, null::integer) $i$, :'ws'), 'P0001', 'invalid_period', 'Sem atalho e sem datas é recusado');
select throws_ok(format($i$ select get_dashboard_attribution(%L::uuid, p_start_date => '2025-03-26', p_end_date => '2025-03-22') $i$, :'ws'), 'P0001', 'invalid_period', 'A atribuição recusa as mesmas datas');
select throws_ok(format($i$ select get_dashboard_attribution(%L::uuid, p_start_date => '2024-01-01', p_end_date => '2025-01-01') $i$, :'ws'), 'P0001', 'invalid_period', 'A atribuição tem o mesmo limite');

-- ===================================================================
-- C) 22 a 26/03/2025
-- ===================================================================
select get_dashboard(:'ws'::uuid, p_start_date => '2025-03-22', p_end_date => '2025-03-26') as d \gset

select is(:'d'::jsonb -> 'period' ->> 'days', '5', '22 a 26 são cinco dias');
select is(:'d'::jsonb -> 'period' ->> 'start_date', '2025-03-22', 'Primeiro dia devolvido');
select is(:'d'::jsonb -> 'period' ->> 'end_date', '2025-03-26', 'Último dia devolvido');
select is((:'d'::jsonb -> 'period' ->> 'custom')::boolean, true, 'Marcado como personalizado');
select is((:'d'::jsonb #>> '{period,current_start}')::timestamptz, '2025-03-22 03:00:00+00'::timestamptz, 'Início: meia-noite de São Paulo, não de UTC');
select is((:'d'::jsonb #>> '{period,current_end}')::timestamptz, '2025-03-27 03:00:00+00'::timestamptz, 'Fim exclusivo: começo do dia seguinte em São Paulo');
select is((:'d'::jsonb #>> '{period,previous_start}')::timestamptz, '2025-03-17 03:00:00+00'::timestamptz, 'Anterior começa em 17/03');
select is((:'d'::jsonb #>> '{period,previous_end}')::timestamptz, (:'d'::jsonb #>> '{period,current_start}')::timestamptz, 'Anterior termina onde o atual começa');
select is(:'d'::jsonb #> '{period_metrics,leads_received}', '{"current": 3, "previous": 3}'::jsonb, 'Leads: bordas e horários em UTC no dia certo');
select is(:'d'::jsonb #> '{period_metrics,consultations_done}', '{"current": 3, "previous": 3}'::jsonb, 'Consultas pelas mesmas bordas (data da conclusão)');
select is(:'d'::jsonb #> '{period_metrics,proposals_sent}', '{"current": 3, "previous": 3}'::jsonb, 'Propostas pelas mesmas bordas (data do envio)');
select is(:'d'::jsonb #> '{period_metrics,opportunities_won}', '{"current": 2, "previous": 2}'::jsonb, 'Ganhas: 1 e 2 no atual; 5 e 7 no anterior; a 4 fora');
select is(:'d'::jsonb #> '{period_metrics,won_value_cents}', '{"current": 300000, "previous": 1200000}'::jsonb, 'Honorários das mesmas ganhas');
select is((:'d'::jsonb #>> '{cohort,leads}')::int, 3, 'Coorte de leads do período');
select is((:'d'::jsonb #>> '{cohort,leads_with_won}')::int, 2, 'Conversão da coorte: dois dos três ganharam');
select is((:'d'::jsonb #>> '{funnel,cohort_size}')::int, 3, 'Funil "No período": oportunidades criadas nas datas');
select is((:'d'::jsonb #>> '{insight_data,cohort_lost_total}')::int, 1, 'Perdas da coorte do período');
select is((:'d'::jsonb #>> '{series,bucket_days}')::int, 1, 'Cinco dias: uma faixa por dia');
select is(jsonb_array_length(:'d'::jsonb #> '{series,won}'), 5, 'Cinco faixas');
select is((select string_agg((f ->> 'start_date') || '=' || (f ->> 'count'), ',') from jsonb_array_elements(:'d'::jsonb #> '{series,won}') f),
  '2025-03-22=1,2025-03-23=0,2025-03-24=0,2025-03-25=0,2025-03-26=1', 'Cada ganha na faixa do seu dia, inclusive no último instante');
select is((select sum((t ->> 'leads_received')::int)::int from jsonb_array_elements(:'d'::jsonb -> 'team') t), 3, 'Equipe soma os leads do período');
select is((select sum((t ->> 'consultations_done')::int)::int from jsonb_array_elements(:'d'::jsonb -> 'team') t), 3, 'Equipe soma as consultas do período');
select is((select sum((t ->> 'opportunities_won')::int)::int from jsonb_array_elements(:'d'::jsonb -> 'team') t), 2, 'Equipe soma as ganhas do período');

-- ===================================================================
-- D) Um dia, bissexto, virada de ano e faixas
-- ===================================================================
select get_dashboard(:'ws'::uuid, p_start_date => '2025-03-26', p_end_date => '2025-03-26') as um \gset
select is(:'um'::jsonb -> 'period' ->> 'days', '1', 'Um único dia');
select is(:'um'::jsonb #> '{period_metrics,leads_received}', '{"current": 2, "previous": 0}'::jsonb, 'Dia 26: o último instante e as 22h; o anterior é o dia 25');
select is(jsonb_array_length(:'um'::jsonb #> '{series,won}'), 1, 'Uma faixa');

select get_dashboard(:'ws'::uuid, p_start_date => '2024-02-28', p_end_date => '2024-03-01') as bis \gset
select is(:'bis'::jsonb -> 'period' ->> 'days', '3', '28/02 a 01/03/2024 inclui o dia 29');
select is((:'bis'::jsonb #>> '{period,previous_start}')::timestamptz, pg_temp.sp('2024-02-25 00:00:00'), 'Anterior: 25 a 27/02/2024');
select is(:'bis'::jsonb #> '{period_metrics,leads_received}', '{"current": 1, "previous": 1}'::jsonb, 'Evento do dia 29 contado; o do dia 27 no anterior');

select get_dashboard(:'ws'::uuid, p_start_date => '2025-12-30', p_end_date => '2026-01-02') as ano \gset
select is((:'ano'::jsonb #>> '{period,previous_start}')::timestamptz, pg_temp.sp('2025-12-26 00:00:00'), 'Virada de ano: anterior começa em 26/12/2025');
select is(:'ano'::jsonb #> '{period_metrics,leads_received}', '{"current": 2, "previous": 1}'::jsonb, 'Os dois lados da virada no mesmo período');

select get_dashboard(:'ws'::uuid, p_start_date => '2025-03-01', p_end_date => '2025-03-31') as mes \gset
select is((:'mes'::jsonb #>> '{series,bucket_days}')::int, 6, '31 dias: faixas de 6');
select is(jsonb_array_length(:'mes'::jsonb #> '{series,won}'), 6, 'No máximo seis faixas');
select is(:'mes'::jsonb #>> '{series,won,5,last_date}', '2025-03-31', 'A última faixa termina no fim do período');
select is((select sum((f ->> 'count')::int)::int from jsonb_array_elements(:'mes'::jsonb #> '{series,won}') f),
  (:'mes'::jsonb #>> '{period_metrics,opportunities_won,current}')::int, 'As faixas somam as ganhas do período');

select get_dashboard(:'ws'::uuid, p_start_date => '2025-03-20', p_end_date => '2025-03-27') as oito \gset
select is((select string_agg((f ->> 'start_date') || '..' || (f ->> 'last_date'), ',') from jsonb_array_elements(:'oito'::jsonb #> '{series,won}') f),
  '2025-03-20..2025-03-21,2025-03-22..2025-03-23,2025-03-24..2025-03-25,2025-03-26..2025-03-27', 'Oito dias: quatro faixas de dois, sem buraco nem sobra');

select get_dashboard(:'ws'::uuid, p_start_date => '2024-01-01', p_end_date => '2024-12-31') as longo \gset
select is((:'longo'::jsonb #>> '{series,bucket_days}')::int, 61, '366 dias: faixas de 61');
select is(:'longo'::jsonb #>> '{series,won,5,last_date}', '2024-12-31', 'A sexta faixa fecha o ano');

-- ===================================================================
-- E) Atalho × intervalo equivalente; "Agora" não vira posição histórica
-- ===================================================================
select get_dashboard(:'ws'::uuid, 7) as p7 \gset
select get_dashboard(:'ws'::uuid, p_start_date => :'today'::date - 6, p_end_date => :'today'::date) as c7 \gset
select is((:'c7'::jsonb - 'period' - 'generated_at'), (:'p7'::jsonb - 'period' - 'generated_at'), 'Os últimos 7 dias escolhidos à mão dão o mesmo resultado do atalho');
select is((:'c7'::jsonb -> 'period') - 'custom', (:'p7'::jsonb -> 'period') - 'custom', 'Com os mesmos limites');
select is((:'p7'::jsonb -> 'period' ->> 'custom')::boolean, false, 'O atalho não é marcado como personalizado');

-- Sete dias no passado: o período muda, as posições não.
select get_dashboard(:'ws'::uuid, p_start_date => '2025-03-20', p_end_date => '2025-03-26') as velho \gset
select is(:'velho'::jsonb -> 'positions', :'p7'::jsonb -> 'positions', '"Agora" igual para um período antigo');
select is(:'velho'::jsonb -> 'attention', :'p7'::jsonb -> 'attention', 'Lista de atenção igual');
select is(:'velho'::jsonb -> 'agenda_today', :'p7'::jsonb -> 'agenda_today', 'Agenda de hoje igual');
select is(:'velho'::jsonb #> '{series,forecast}', :'p7'::jsonb #> '{series,forecast}', 'Previsão: próximos 7 dias a partir de hoje, não do período antigo');
select is((select sum((f ->> 'count')::int)::int from jsonb_array_elements(:'velho'::jsonb #> '{series,forecast,buckets}') f), 1, 'A aberta com data prevista em 3 dias aparece');
select is((select jsonb_agg(s -> 'open_now' order by (s ->> 'position')::int) from jsonb_array_elements(:'velho'::jsonb #> '{funnel,stages}') s),
  (select jsonb_agg(s -> 'open_now' order by (s ->> 'position')::int) from jsonb_array_elements(:'p7'::jsonb #> '{funnel,stages}') s), 'Funil "Agora" igual');
select is(:'um'::jsonb #>> '{series,forecast,buckets,0,start_date}', :'today', 'Com um dia escolhido, a previsão ainda começa hoje');
select is(:'longo'::jsonb #>> '{series,forecast,buckets,5,last_date}', (:'today'::date + 365)::text, 'Com 366 dias, a previsão cobre os próximos 366');

-- ===================================================================
-- F) Atribuição no mesmo período
-- ===================================================================
select get_dashboard_attribution(:'ws'::uuid, p_start_date => '2025-03-22', p_end_date => '2025-03-26') as a \gset
select is((:'a'::jsonb ->> 'period_days')::int, 5, 'Atribuição: cinco dias');
select is((:'a'::jsonb ->> 'start_date') || ' ' || (:'a'::jsonb ->> 'end_date'), '2025-03-22 2025-03-26', 'Atribuição: as mesmas datas');
select is((:'a'::jsonb ->> 'created_in_period')::int, (:'d'::jsonb #>> '{funnel,cohort_size}')::int, 'Criadas no período = coorte do funil');
select is((:'a'::jsonb ->> 'won_in_period')::int, (:'d'::jsonb #>> '{period_metrics,opportunities_won,current}')::int, 'Ganhas no período = indicador do painel');
select is((select sum((s ->> 'created')::int)::int from jsonb_array_elements(:'a'::jsonb -> 'sources') s), 3, 'As origens somam as criadas');
select is((select sum((s ->> 'won')::int)::int from jsonb_array_elements(:'a'::jsonb -> 'sources') s), 2, 'E as ganhas');
select is((get_dashboard_attribution(:'ws'::uuid, 7) ->> 'period_days')::int, 7, 'Atribuição pelo atalho continua igual');

-- ===================================================================
-- G) Papéis, filtros e isolamento
-- ===================================================================
select is((get_dashboard(:'ws'::uuid, p_assigned_to => :'lucas'::uuid, p_start_date => '2025-03-22', p_end_date => '2025-03-26') #> '{period_metrics,leads_received}'),
  '{"current": 1, "previous": 1}'::jsonb, 'Filtro de responsável vale no intervalo');
select is((get_dashboard_attribution(:'ws'::uuid, p_assigned_to => :'lucas'::uuid, p_start_date => '2025-03-22', p_end_date => '2025-03-26') ->> 'created_in_period')::int, 1,
  'E na atribuição');

select set_config('request.jwt.claims', json_build_object('sub', :'lucas', 'role', 'authenticated')::text, true);
select get_dashboard(:'ws'::uuid, p_start_date => '2025-03-22', p_end_date => '2025-03-26') as adv \gset
select is(:'adv'::jsonb #> '{period_metrics,leads_received}', '{"current": 2, "previous": 2}'::jsonb, 'Advogado: só os próprios e os sem responsável, nos dois períodos');
select is(:'adv'::jsonb #> '{period_metrics,opportunities_won}', '{"current": 1, "previous": 1}'::jsonb, 'E só as ganhas desse alcance');

select set_config('request.jwt.claims', json_build_object('sub', :'sofia', 'role', 'authenticated')::text, true);
select ok(get_dashboard(:'ws'::uuid, p_start_date => '2025-03-22', p_end_date => '2025-03-26')::text not like '%_cents%', 'Atendimento não recebe valor exato no intervalo');

select set_config('request.jwt.claims', json_build_object('sub', :'vitor', 'role', 'authenticated')::text, true);
select ok(get_dashboard(:'ws'::uuid, p_start_date => '2025-03-22', p_end_date => '2025-03-26')::text not like '%_cents%', 'Visualizador não recebe valor no intervalo');

select set_config('request.jwt.claims', json_build_object('sub', :'ana', 'role', 'authenticated')::text, true);
select throws_ok(format($i$ select get_dashboard(%L::uuid, p_start_date => '2025-03-22', p_end_date => '2025-03-26') $i$, :'ws'), 'P0001', 'insufficient_permission',
  'Quem é de outro escritório não vê o intervalo');
select throws_ok(format($i$ select get_dashboard_attribution(%L::uuid, p_start_date => '2025-03-22', p_end_date => '2025-03-26') $i$, :'ws'), 'P0001', 'insufficient_permission',
  'Nem a atribuição');

reset role;
select * from finish();
rollback;
