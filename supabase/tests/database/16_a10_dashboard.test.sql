-- pgTAP — A10: get_dashboard (Visão geral).
--
-- Duas partes:
--   A) Resultados esperados CONHECIDOS: um escritório novo, criado dentro
--      desta transação (now() congelado), com fixtures de datas exatas —
--      bordas de período, lead antigo que ganhou agora, reentrada de
--      etapa, lead com duas oportunidades, filtros, papéis e erros.
--   B) Consultas INDEPENDENTES: no Escritório Painel do seed (64 leads,
--      mais que qualquer página da aplicação), cada número da função é
--      comparado com uma consulta escrita à parte, direto nas tabelas.
--
-- Usuários do seed: paula=owner, lucas=lawyer, sofia=sales, vitor=viewer
-- no Escritório Painel; otavio=owner no Escritório Painel B; ana=owner no
-- Escritório Um (fora de tudo aqui).

begin;
select plan(64);

\set ws_painel '10000000-0000-0000-0000-000000000010'
\set ws_painel_b '10000000-0000-0000-0000-000000000011'
\set pipeline_painel '50000000-0000-0000-0000-000000000010'
\set ana    '20000000-0000-0000-0000-000000000001'
\set paula  '20000000-0000-0000-0000-000000000010'
\set lucas  '20000000-0000-0000-0000-000000000011'
\set sofia  '20000000-0000-0000-0000-000000000012'
\set vitor  '20000000-0000-0000-0000-000000000013'
\set otavio '20000000-0000-0000-0000-000000000014'

-- -----------------------------------------------------------------
-- Parte A — setup. Otávio cria o escritório de teste (pipeline padrão
-- com as 8 etapas vem da própria função); Lucas, Sofia e Vitor entram
-- nele com os mesmos papéis que têm no Escritório Painel.
-- -----------------------------------------------------------------

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'otavio', 'role', 'authenticated')::text, true);
select (create_workspace_with_owner('Teste A10', 'teste-a10-dashboard')).id as ws \gset
reset role;

insert into public.memberships (workspace_id, user_id, role, status) values
  (:'ws'::uuid, :'lucas', 'lawyer', 'active'),
  (:'ws'::uuid, :'sofia', 'sales', 'active'),
  (:'ws'::uuid, :'vitor', 'viewer', 'active');

select id as pipeline from public.pipelines where workspace_id = :'ws'::uuid and is_default \gset
select id as s0 from public.pipeline_stages where pipeline_id = :'pipeline'::uuid and position = 0 \gset
select id as s1 from public.pipeline_stages where pipeline_id = :'pipeline'::uuid and position = 1 \gset
select id as s2 from public.pipeline_stages where pipeline_id = :'pipeline'::uuid and position = 2 \gset
select id as reason from public.lost_reasons where workspace_id = :'ws'::uuid order by position limit 1 \gset

-- Bordas do período de 7 dias, calculadas pela mesma função que o
-- dashboard usa (as fixtures ficam exatamente em cima delas).
select current_start as c7, previous_start as p7, today_date as today
from private.dashboard_period_bounds(7, 'America/Sao_Paulo') \gset

-- Meio-dia (horário do escritório) de N dias atrás.
create function pg_temp.noon(p_days integer) returns timestamptz language sql stable as $$
  select (((now() at time zone 'America/Sao_Paulo')::date - p_days)::timestamp + interval '12 hours')
         at time zone 'America/Sao_Paulo'
$$;

insert into public.contacts (id, workspace_id, type, name, created_by) values
  ('a1000000-0000-0000-0000-000000000001', :'ws'::uuid, 'pf', 'Antigo Ganho', :'otavio'),
  ('a1000000-0000-0000-0000-000000000002', :'ws'::uuid, 'pf', 'Duas Oportunidades', :'otavio'),
  ('a1000000-0000-0000-0000-000000000003', :'ws'::uuid, 'pf', 'Ganho Anterior', :'otavio'),
  ('a1000000-0000-0000-0000-000000000004', :'ws'::uuid, 'pf', 'Borda Inicio Atual', :'otavio'),
  ('a1000000-0000-0000-0000-000000000005', :'ws'::uuid, 'pf', 'Borda Fim Anterior', :'otavio'),
  ('a1000000-0000-0000-0000-000000000006', :'ws'::uuid, 'pf', 'Borda Inicio Anterior', :'otavio'),
  ('a1000000-0000-0000-0000-000000000007', :'ws'::uuid, 'pf', 'Antes do Anterior', :'otavio');

-- L1: criado há 100 dias, advogado Lucas, ganhou há 3 dias.
-- L2: criado há 2 dias, Otávio, duas oportunidades (aberta com reentrada; perdida).
-- L3: criado há 10 dias (período ANTERIOR de 7), sem responsável, ganhou há 8 dias.
-- L4..L7: sem responsável, exatamente nas bordas.
insert into public.leads (id, workspace_id, contact_id, legal_area, assigned_to, created_by, created_at) values
  ('b1000000-0000-0000-0000-000000000001', :'ws'::uuid, 'a1000000-0000-0000-0000-000000000001', 'Trabalhista', :'lucas', :'otavio', pg_temp.noon(100)),
  ('b1000000-0000-0000-0000-000000000002', :'ws'::uuid, 'a1000000-0000-0000-0000-000000000002', 'Família', :'otavio', :'otavio', pg_temp.noon(2)),
  ('b1000000-0000-0000-0000-000000000003', :'ws'::uuid, 'a1000000-0000-0000-0000-000000000003', 'Trabalhista', null, :'otavio', pg_temp.noon(10)),
  ('b1000000-0000-0000-0000-000000000004', :'ws'::uuid, 'a1000000-0000-0000-0000-000000000004', 'Cível', null, :'otavio', :'c7'::timestamptz),
  ('b1000000-0000-0000-0000-000000000005', :'ws'::uuid, 'a1000000-0000-0000-0000-000000000005', 'Cível', null, :'otavio', :'c7'::timestamptz - interval '1 microsecond'),
  ('b1000000-0000-0000-0000-000000000006', :'ws'::uuid, 'a1000000-0000-0000-0000-000000000006', 'Cível', null, :'otavio', :'p7'::timestamptz),
  ('b1000000-0000-0000-0000-000000000007', :'ws'::uuid, 'a1000000-0000-0000-0000-000000000007', 'Cível', null, :'otavio', :'p7'::timestamptz - interval '1 microsecond');

insert into public.opportunities (id, workspace_id, lead_id, pipeline_id, stage_id, value_cents, fee_model, status, won_at, lost_reason_id, stage_entered_at, created_by, created_at) values
  ('c1000000-0000-0000-0000-000000000001', :'ws'::uuid, 'b1000000-0000-0000-0000-000000000001', :'pipeline'::uuid, :'s2'::uuid, 1000000, 'fixed', 'won', pg_temp.noon(3), null, pg_temp.noon(3), :'otavio', pg_temp.noon(100)),
  ('c1000000-0000-0000-0000-000000000002', :'ws'::uuid, 'b1000000-0000-0000-0000-000000000002', :'pipeline'::uuid, :'s2'::uuid, 200000, 'fixed', 'open', null, null, now() - interval '1 day', :'otavio', pg_temp.noon(2)),
  ('c1000000-0000-0000-0000-000000000003', :'ws'::uuid, 'b1000000-0000-0000-0000-000000000002', :'pipeline'::uuid, :'s1'::uuid, 300000, 'fixed', 'lost', null, :'reason'::uuid, pg_temp.noon(1), :'otavio', pg_temp.noon(2)),
  ('c1000000-0000-0000-0000-000000000004', :'ws'::uuid, 'b1000000-0000-0000-0000-000000000003', :'pipeline'::uuid, :'s1'::uuid, 500000, 'contingency', 'won', pg_temp.noon(8), null, pg_temp.noon(8), :'otavio', pg_temp.noon(10));

-- Oportunidade aberta: 0→1→2→1→2 (reentrou na etapa 2). Perdida: 0→1.
insert into public.stage_transitions (workspace_id, opportunity_id, from_stage_id, to_stage_id, actor_user_id, occurred_at) values
  (:'ws'::uuid, 'c1000000-0000-0000-0000-000000000002', :'s0'::uuid, :'s1'::uuid, :'otavio', now() - interval '40 hours'),
  (:'ws'::uuid, 'c1000000-0000-0000-0000-000000000002', :'s1'::uuid, :'s2'::uuid, :'otavio', now() - interval '36 hours'),
  (:'ws'::uuid, 'c1000000-0000-0000-0000-000000000002', :'s2'::uuid, :'s1'::uuid, :'otavio', now() - interval '30 hours'),
  (:'ws'::uuid, 'c1000000-0000-0000-0000-000000000002', :'s1'::uuid, :'s2'::uuid, :'otavio', now() - interval '1 day'),
  (:'ws'::uuid, 'c1000000-0000-0000-0000-000000000003', :'s0'::uuid, :'s1'::uuid, :'otavio', pg_temp.noon(1));

insert into public.activities (workspace_id, lead_id, opportunity_id, type, title, assigned_to, due_at, status, completed_at, created_by) values
  -- Consulta concluída ontem (atual) pelo Lucas, num lead antigo.
  (:'ws'::uuid, 'b1000000-0000-0000-0000-000000000001', 'c1000000-0000-0000-0000-000000000001', 'meeting', 'Consulta L1', :'lucas', pg_temp.noon(2), 'done', pg_temp.noon(1), :'otavio'),
  -- Consulta concluída há 9 dias (período anterior).
  (:'ws'::uuid, 'b1000000-0000-0000-0000-000000000003', 'c1000000-0000-0000-0000-000000000004', 'meeting', 'Consulta L3', null, pg_temp.noon(9), 'done', pg_temp.noon(9), :'otavio'),
  -- Reunião futura (próxima ação da aberta) e ligação atrasada do Otávio.
  (:'ws'::uuid, 'b1000000-0000-0000-0000-000000000002', 'c1000000-0000-0000-0000-000000000002', 'meeting', 'Consulta L2', :'otavio', now() + interval '2 days', 'pending', null, :'otavio'),
  (:'ws'::uuid, 'b1000000-0000-0000-0000-000000000002', 'c1000000-0000-0000-0000-000000000002', 'call', 'Ligação atrasada', :'otavio', now() - interval '1 day', 'pending', null, :'otavio'),
  -- Hoje: último instante do dia e primeiro instante de amanhã.
  (:'ws'::uuid, 'b1000000-0000-0000-0000-000000000004', null, 'deadline', 'Prazo hoje', null,
     ((:'today'::date + 1)::timestamp at time zone 'America/Sao_Paulo') - interval '1 microsecond', 'pending', null, :'otavio'),
  (:'ws'::uuid, 'b1000000-0000-0000-0000-000000000004', null, 'deadline', 'Prazo amanhã', null,
     (:'today'::date + 1)::timestamp at time zone 'America/Sao_Paulo', 'pending', null, :'otavio');

insert into public.proposals (workspace_id, lead_id, opportunity_id, number, value_cents, fee_model, status, sent_channels, sent_at, created_by) values
  (:'ws'::uuid, 'b1000000-0000-0000-0000-000000000002', 'c1000000-0000-0000-0000-000000000002', 'T-1', 200000, 'fixed', 'enviada', '{email}', now() - interval '1 hour', :'otavio'),
  (:'ws'::uuid, 'b1000000-0000-0000-0000-000000000002', 'c1000000-0000-0000-0000-000000000002', 'T-2', 200000, 'fixed', 'rascunho', '{}', null, :'otavio');

select is(
  (
    select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'get_dashboard' and p.prosecdef
      and exists (select 1 from unnest(coalesce(p.proconfig, array[]::text[])) cfg where cfg like 'search_path=%')
  ),
  1, 'get_dashboard é SECURITY DEFINER com search_path travado'
);

-- ===================================================================
-- A1) Owner, 7 dias — cada indicador pela sua própria data.
-- ===================================================================

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'otavio', 'role', 'authenticated')::text, true);
select get_dashboard(:'ws'::uuid, 7) as d7 \gset

select is((:'d7'::jsonb #>> '{period_metrics,leads_received,current}')::int, 2,
  'Leads recebidos (atual): L2 e o lead criado exatamente no início do período');
select is((:'d7'::jsonb #>> '{period_metrics,leads_received,previous}')::int, 3,
  'Leads recebidos (anterior): L3, o lead 1µs antes do atual e o lead no início do anterior; o de antes fica fora');
select is((:'d7'::jsonb #>> '{period_metrics,opportunities_won,current}')::int, 1,
  'Lead criado há 100 dias que ganhou há 3 dias entra nas ganhas do período atual');
select is((:'d7'::jsonb #>> '{period_metrics,opportunities_won,previous}')::int, 1,
  'Ganho de 8 dias atrás conta no período anterior');
select is((:'d7'::jsonb #>> '{period_metrics,won_value_cents,current}')::bigint, 1000000::bigint,
  'Honorários das ganhas (atual) usam won_at, não a criação do lead');
select is((:'d7'::jsonb #>> '{period_metrics,won_value_cents,previous}')::bigint, 500000::bigint,
  'Honorários das ganhas (anterior)');
select is((:'d7'::jsonb #>> '{period_metrics,days_to_win,current}')::numeric, 97.0,
  'Dias até o ganho: criação do lead (100 dias atrás) até o ganho (3 dias atrás)');
select is((:'d7'::jsonb #>> '{period_metrics,consultations_done,current}')::int, 1,
  'Consultas realizadas usam completed_at (lead antigo, consulta ontem)');
select is((:'d7'::jsonb #>> '{period_metrics,consultations_done,previous}')::int, 1,
  'Consulta concluída há 9 dias conta no período anterior; reunião pendente não conta');
select is((:'d7'::jsonb #>> '{period_metrics,proposals_sent,current}')::int, 1,
  'Propostas com envio registrado usam sent_at; rascunho não conta');
select is((:'d7'::jsonb #>> '{cohort,leads}')::int, 2, 'Coorte: leads recebidos no período');
select is((:'d7'::jsonb #>> '{cohort,leads_with_won}')::int, 0,
  'Coorte: nenhum dos leads recebidos no período ganhou (o ganho do período é de lead antigo)');

-- Posições atuais.
select is((:'d7'::jsonb #>> '{positions,open_opportunities}')::int, 1, 'Posição: uma oportunidade aberta');
select is((:'d7'::jsonb #>> '{positions,open_value_cents}')::bigint, 200000::bigint, 'Posição: valor em negociação');
select is((:'d7'::jsonb #>> '{positions,overdue_activities}')::int, 1, 'Posição: uma atividade atrasada');
select is((:'d7'::jsonb #>> '{positions,stalled_opportunities}')::int, 0, 'Posição: movida há 1 dia não está parada');
select is((:'d7'::jsonb #>> '{positions,open_without_next_action}')::int, 0, 'Posição: a aberta tem próxima ação');
select is((:'d7'::jsonb #>> '{attention,total}')::int, 1, 'Atenção: a aberta com atividade atrasada');
select is((:'d7'::jsonb #>> '{positions,today_activities}')::int, 1,
  'Agenda de hoje: inclui o último instante de hoje e exclui a meia-noite de amanhã');

-- Funil: coorte = oportunidades do pipeline criadas no período.
select is((:'d7'::jsonb #>> '{funnel,cohort_size}')::int, 2, 'Funil: duas oportunidades do mesmo lead na coorte');
select is(
  (select (s ->> 'visited')::int from jsonb_array_elements(:'d7'::jsonb #> '{funnel,stages}') s where (s ->> 'position')::int = 1),
  2, 'Funil: etapa 1 alcançada por 2, sem contar a reentrada duas vezes'
);
select is(
  (select (s ->> 'visited')::int from jsonb_array_elements(:'d7'::jsonb #> '{funnel,stages}') s where (s ->> 'position')::int = 2),
  1, 'Funil: etapa 2 alcançada por 1 (a que voltou e reentrou conta uma vez)'
);
select is(
  (select (s ->> 'visited')::int from jsonb_array_elements(:'d7'::jsonb #> '{funnel,stages}') s where (s ->> 'position')::int = 3),
  0, 'Funil: ninguém alcançou a etapa 3'
);
select is(
  (select (s ->> 'cohort_lost_here')::int from jsonb_array_elements(:'d7'::jsonb #> '{funnel,stages}') s where (s ->> 'position')::int = 1),
  1, 'Funil: a perda registrada aparece na etapa em que aconteceu'
);
select is(
  (select (s ->> 'open_now')::int from jsonb_array_elements(:'d7'::jsonb #> '{funnel,stages}') s where (s ->> 'position')::int = 2),
  1, 'Distribuição atual: a aberta está na etapa 2'
);

-- Equipe: responsável atual do lead (leads, ganhas) e da atividade (consultas, atrasadas).
select is(
  (select t from jsonb_array_elements(:'d7'::jsonb -> 'team') t where t ->> 'user_id' = :'lucas'),
  jsonb_build_object('user_id', :'lucas', 'full_name', 'Lucas Advogado (seed)', 'leads_received', 0,
                     'consultations_done', 1, 'opportunities_won', 1, 'overdue_activities', 0),
  'Equipe: Lucas com a consulta dele e o ganho do lead dele'
);
select is(
  (select (t ->> 'overdue_activities')::int from jsonb_array_elements(:'d7'::jsonb -> 'team') t where t ->> 'user_id' = :'otavio'),
  1, 'Equipe: atrasada agrupada pelo responsável da atividade'
);
select is(
  (select count(*)::int from jsonb_array_elements(:'d7'::jsonb -> 'team') t where t ->> 'user_id' = :'vitor'),
  0, 'Equipe: visualizador sem nada atribuído não aparece'
);

-- ===================================================================
-- A2) Filtros
-- ===================================================================

select is((get_dashboard(:'ws'::uuid, 7, :'otavio'::uuid) #>> '{period_metrics,leads_received,current}')::int, 1,
  'Filtro por responsável: só L2');
select is((get_dashboard(:'ws'::uuid, 7, null, true) #>> '{period_metrics,opportunities_won,previous}')::int, 1,
  'Filtro "sem responsável": ganho anterior de L3');
select is((get_dashboard(:'ws'::uuid, 7, null, false, 'Família') #>> '{positions,open_opportunities}')::int, 1,
  'Filtro por área: Família tem a aberta');
select is((get_dashboard(:'ws'::uuid, 7, null, false, 'Trabalhista') #>> '{positions,open_opportunities}')::int, 0,
  'Filtro por área: Trabalhista não tem aberta');
select throws_ok(
  format($i$ select get_dashboard(%L::uuid, 7, %L::uuid, true) $i$, :'ws'::uuid, :'otavio'),
  'P0001', 'invalid_filter', 'Responsável e "sem responsável" ao mesmo tempo é recusado'
);
select throws_ok(
  format($i$ select get_dashboard(%L::uuid, 15) $i$, :'ws'::uuid),
  'P0001', 'invalid_period', 'Período fora de 7/30/90 é recusado'
);
select throws_ok(
  format($i$ select get_dashboard(%L::uuid, 30, null, false, null, %L::uuid) $i$, :'ws'::uuid, :'pipeline_painel'),
  'P0001', 'pipeline_not_found', 'Pipeline de outro escritório é recusado'
);

-- ===================================================================
-- A3) Alcance e projeção por papel
-- ===================================================================

select set_config('request.jwt.claims', json_build_object('sub', :'lucas', 'role', 'authenticated')::text, true);
select get_dashboard(:'ws'::uuid, 7) as lawyer7 \gset
select is((:'lawyer7'::jsonb #>> '{period_metrics,leads_received,current}')::int, 1,
  'Advogado: só leads dele e sem responsável (L2 fica fora)');
select is((:'lawyer7'::jsonb #>> '{positions,open_opportunities}')::int, 0,
  'Advogado: a aberta de outro responsável não entra na posição');
select is((:'lawyer7'::jsonb #>> '{period_metrics,won_value_cents,current}')::bigint, 1000000::bigint,
  'Advogado recebe a soma exata só do próprio alcance');
select is((:'lawyer7'::jsonb #>> '{funnel,cohort_size}')::int, 0, 'Advogado: funil sem as oportunidades de L2');

select set_config('request.jwt.claims', json_build_object('sub', :'sofia', 'role', 'authenticated')::text, true);
-- Filtro até restar UMA oportunidade: nenhuma soma poderia revelá-la.
select get_dashboard(:'ws'::uuid, 7, :'otavio'::uuid) as sales_one \gset
select is((:'sales_one'::jsonb #>> '{positions,open_opportunities}')::int, 1, 'Sales: filtro deixa uma única aberta');
select is(
  (select count(*)::int from jsonb_path_query(:'sales_one'::jsonb, 'strict $.**') x,
     lateral jsonb_object_keys(case when jsonb_typeof(x) = 'object' then x else '{}'::jsonb end) k
   where k like '%cents%' or k in ('forecast', 'forecast_date', 'probability', 'fee_model')),
  0, 'Sales: nenhuma chave de valor exato, soma, série ou previsão em lugar nenhum do payload'
);
select is(:'sales_one'::jsonb #>> '{attention,items,0,value_band}', 'R$ 2.000–5.000',
  'Sales: a oportunidade individual traz só a faixa');
select is((:'sales_one'::jsonb #>> '{period_metrics,opportunities_won,current}')::int, 0,
  'Sales recebe contagens normalmente');

select set_config('request.jwt.claims', json_build_object('sub', :'vitor', 'role', 'authenticated')::text, true);
select get_dashboard(:'ws'::uuid, 7, :'otavio'::uuid) as viewer_one \gset
select is(
  (select count(*)::int from jsonb_path_query(:'viewer_one'::jsonb, 'strict $.**') x,
     lateral jsonb_object_keys(case when jsonb_typeof(x) = 'object' then x else '{}'::jsonb end) k
   where k like '%cents%' or k in ('value_band', 'forecast', 'forecast_date', 'probability', 'fee_model')),
  0, 'Viewer: nem valor, nem faixa, nem previsão'
);
select is((:'viewer_one'::jsonb #>> '{attention,total}')::int, 1, 'Viewer: vê a oportunidade que exige atenção, sem valores');

-- Isolamento e autenticação.
select set_config('request.jwt.claims', json_build_object('sub', :'paula', 'role', 'authenticated')::text, true);
select throws_ok(
  format($i$ select get_dashboard(%L::uuid, 7) $i$, :'ws'::uuid),
  'P0001', 'insufficient_permission', 'Membro de outro escritório não lê o dashboard deste'
);
select set_config('request.jwt.claims', json_build_object('sub', :'otavio', 'role', 'authenticated')::text, true);
select throws_ok(
  format($i$ select get_dashboard(%L::uuid, 7) $i$, :'ws_painel'),
  'P0001', 'insufficient_permission', 'Owner do Painel B não lê o Escritório Painel'
);
select set_config('request.jwt.claims', json_build_object('role', 'authenticated')::text, true);
select throws_ok(
  format($i$ select get_dashboard(%L::uuid, 7) $i$, :'ws'::uuid),
  'P0001', 'authentication_required', 'Sem sessão: recusado'
);

-- ===================================================================
-- A4) Ganho refletido no painel.
-- ===================================================================

select set_config('request.jwt.claims', json_build_object('sub', :'otavio', 'role', 'authenticated')::text, true);
select win_opportunity('c1000000-0000-0000-0000-000000000002'::uuid, 0, 250000, 'fixed');
select get_dashboard(:'ws'::uuid, 7) as after_win \gset
select is((:'after_win'::jsonb #>> '{period_metrics,opportunities_won,current}')::int, 2, 'Depois do ganho: 2 ganhas no período');
select is((:'after_win'::jsonb #>> '{period_metrics,won_value_cents,current}')::bigint, 1250000::bigint, 'Depois do ganho: soma com o valor do ganho');
select is((:'after_win'::jsonb #>> '{positions,open_opportunities}')::int, 0, 'Depois do ganho: nenhuma aberta');
select is((:'after_win'::jsonb #>> '{cohort,leads_with_won}')::int, 1, 'Depois do ganho: L2 (recebido no período) passa a ter ganho');
reset role;

-- ===================================================================
-- B) Escritório Painel do seed: função x consultas independentes.
-- ===================================================================

create temp table expected as
with b as (
  select
    ((now() at time zone 'America/Sao_Paulo')::date - 89)::timestamp at time zone 'America/Sao_Paulo' as s,
    ((now() at time zone 'America/Sao_Paulo')::date + 1)::timestamp at time zone 'America/Sao_Paulo' as e
)
select
  (select count(*) from public.leads l, b where l.workspace_id = :'ws_painel' and l.created_at >= b.s and l.created_at < b.e)::int as leads,
  (select count(*) from public.opportunities o, b where o.workspace_id = :'ws_painel' and o.status = 'won' and o.won_at >= b.s and o.won_at < b.e)::int as won,
  (select sum(o.value_cents) from public.opportunities o, b where o.workspace_id = :'ws_painel' and o.status = 'won' and o.won_at >= b.s and o.won_at < b.e)::bigint as won_value,
  (select count(*) from public.activities a, b where a.workspace_id = :'ws_painel' and a.type = 'meeting' and a.status = 'done' and a.completed_at >= b.s and a.completed_at < b.e)::int as consultations,
  (select count(*) from public.proposals p, b where p.workspace_id = :'ws_painel' and p.sent_at >= b.s and p.sent_at < b.e)::int as proposals,
  (select count(*) from public.opportunities o where o.workspace_id = :'ws_painel' and o.status = 'open')::int as open_opps,
  (select sum(value_cents) from public.opportunities o where o.workspace_id = :'ws_painel' and o.status = 'open')::bigint as open_value,
  (select count(*) from public.activities a where a.workspace_id = :'ws_painel' and a.status = 'pending' and a.due_at < now())::int as overdue,
  (select count(*) from public.opportunities o where o.workspace_id = :'ws_painel' and o.status = 'open' and o.stage_entered_at < now() - interval '5 days')::int as stalled,
  (select count(*) from public.opportunities o
    where o.workspace_id = :'ws_painel' and o.status = 'open'
      and (o.stage_entered_at < now() - interval '5 days'
           or exists (select 1 from public.leads l where l.id = o.lead_id and l.assigned_to is null)
           or exists (select 1 from public.activities a where a.opportunity_id = o.id and a.status = 'pending' and a.due_at < now())))::int as attention,
  (select count(*) from public.leads l where l.workspace_id = :'ws_painel' and l.assigned_to = :'lucas' or (l.workspace_id = :'ws_painel' and l.assigned_to is null))::int as lawyer_scope_leads_total;
grant select on expected to authenticated;

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'paula', 'role', 'authenticated')::text, true);
select get_dashboard(:'ws_painel'::uuid, 90) as seed90 \gset

select ok((select leads from expected) > 20, 'Seed: o período de 90 dias tem mais leads do que uma página da aplicação');
select is((:'seed90'::jsonb #>> '{period_metrics,leads_received,current}')::int, (select leads from expected), 'Seed: leads recebidos = consulta independente');
select is((:'seed90'::jsonb #>> '{period_metrics,opportunities_won,current}')::int, (select won from expected), 'Seed: ganhas = consulta independente');
select is((:'seed90'::jsonb #>> '{period_metrics,won_value_cents,current}')::bigint, (select coalesce(won_value, 0) from expected), 'Seed: honorários das ganhas = consulta independente');
select is((:'seed90'::jsonb #>> '{period_metrics,consultations_done,current}')::int, (select consultations from expected), 'Seed: consultas = consulta independente');
select is((:'seed90'::jsonb #>> '{period_metrics,proposals_sent,current}')::int, (select proposals from expected), 'Seed: propostas enviadas = consulta independente');
select is((:'seed90'::jsonb #>> '{positions,open_opportunities}')::int, (select open_opps from expected), 'Seed: abertas = consulta independente');
select is((:'seed90'::jsonb #>> '{positions,open_value_cents}')::bigint, (select coalesce(open_value, 0) from expected), 'Seed: valor em negociação = consulta independente');
select is((:'seed90'::jsonb #>> '{positions,overdue_activities}')::int, (select overdue from expected), 'Seed: atrasadas = consulta independente');
select is((:'seed90'::jsonb #>> '{attention,total}')::int, (select attention from expected), 'Seed: total de atenção = consulta independente (a lista mostra no máximo 20)');
select is(
  (select sum((s ->> 'open_now')::int)::int from jsonb_array_elements(:'seed90'::jsonb #> '{funnel,stages}') s),
  (select open_opps from expected),
  'Seed: distribuição atual por etapa soma todas as abertas'
);

select * from finish();
rollback;
