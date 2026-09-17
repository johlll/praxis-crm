-- pgTAP — A10, revisão da PR #15: os dois defeitos de agregação de
-- public.get_dashboard, com resultados esperados conhecidos.
--
--   A) FUNIL: etapa PULADA não pode aparecer como alcançada; reentrada
--      conta uma vez; reordenar as etapas não muda o histórico já
--      registrado; a taxa de avanço usa a mesma população no numerador e
--      no denominador (nunca passa de 100%).
--   B) EQUIPE: remover um membro (remove_membership apaga a membership e
--      PRESERVA assigned_to) não pode tirar os registros dele da tabela,
--      senão a soma das colunas deixa de bater com os indicadores gerais.
--
-- Escritório criado dentro desta transação, independente do seed.

begin;
select plan(21);

\set otavio '20000000-0000-0000-0000-000000000014'
\set sofia  '20000000-0000-0000-0000-000000000012'
\set lucas  '20000000-0000-0000-0000-000000000011'

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'otavio', 'role', 'authenticated')::text, true);
select (create_workspace_with_owner('Revisão A10', 'revisao-a10-dashboard')).id as ws \gset
reset role;

insert into public.memberships (workspace_id, user_id, role, status) values
  (:'ws'::uuid, :'sofia', 'sales', 'active'),
  (:'ws'::uuid, :'lucas', 'lawyer', 'active');

select id as pipeline from public.pipelines where workspace_id = :'ws'::uuid and is_default \gset
select id as s0 from public.pipeline_stages where pipeline_id = :'pipeline'::uuid and position = 0 \gset
select id as s1 from public.pipeline_stages where pipeline_id = :'pipeline'::uuid and position = 1 \gset
select id as s2 from public.pipeline_stages where pipeline_id = :'pipeline'::uuid and position = 2 \gset
select id as s3 from public.pipeline_stages where pipeline_id = :'pipeline'::uuid and position = 3 \gset

create function pg_temp.noon(p_days integer) returns timestamptz language sql stable as $$
  select (((now() at time zone 'America/Sao_Paulo')::date - p_days)::timestamp + interval '12 hours')
         at time zone 'America/Sao_Paulo'
$$;

-- Etapa de um payload do funil, por posição.
create function pg_temp.stage(p_dashboard jsonb, p_position integer) returns jsonb language sql stable as $$
  select s from jsonb_array_elements(p_dashboard #> '{funnel,stages}') s
  where (s ->> 'position')::int = p_position
$$;

insert into public.contacts (id, workspace_id, type, name, created_by) values
  ('a2000000-0000-0000-0000-000000000001', :'ws'::uuid, 'pf', 'Pulou Etapas', :'otavio'),
  ('a2000000-0000-0000-0000-000000000002', :'ws'::uuid, 'pf', 'Voltou e Reentrou', :'otavio'),
  ('a2000000-0000-0000-0000-000000000003', :'ws'::uuid, 'pf', 'Ganhou na Etapa 2', :'otavio'),
  ('a2000000-0000-0000-0000-000000000004', :'ws'::uuid, 'pf', 'Lead da Sofia', :'otavio');

-- Os quatro leads entram no período de 7 dias (criados há 2 dias).
insert into public.leads (id, workspace_id, contact_id, legal_area, assigned_to, created_by, created_at) values
  ('b2000000-0000-0000-0000-000000000001', :'ws'::uuid, 'a2000000-0000-0000-0000-000000000001', 'Cível', :'otavio', :'otavio', pg_temp.noon(2)),
  ('b2000000-0000-0000-0000-000000000002', :'ws'::uuid, 'a2000000-0000-0000-0000-000000000002', 'Cível', :'otavio', :'otavio', pg_temp.noon(2)),
  ('b2000000-0000-0000-0000-000000000003', :'ws'::uuid, 'a2000000-0000-0000-0000-000000000003', 'Cível', :'otavio', :'otavio', pg_temp.noon(2)),
  ('b2000000-0000-0000-0000-000000000004', :'ws'::uuid, 'a2000000-0000-0000-0000-000000000004', 'Cível', :'sofia',  :'otavio', pg_temp.noon(2));

-- O1: criada na etapa 0 e movida DIRETO para a etapa 3 (a A5 permite
--     pular colunas; os requisitos das intermediárias são exigidos, mas
--     nenhuma passagem por elas é registrada).
-- O2: 0 → 1 → 2 → 1 (voltou; está na etapa 1).
-- O3: 0 → 1 → 2 e ganhou na etapa 2.
insert into public.opportunities (id, workspace_id, lead_id, pipeline_id, stage_id, value_cents, fee_model, status, won_at, stage_entered_at, created_by, created_at) values
  ('c2000000-0000-0000-0000-000000000001', :'ws'::uuid, 'b2000000-0000-0000-0000-000000000001', :'pipeline'::uuid, :'s3'::uuid, 100000, 'fixed', 'open', null, pg_temp.noon(1), :'otavio', pg_temp.noon(2)),
  ('c2000000-0000-0000-0000-000000000002', :'ws'::uuid, 'b2000000-0000-0000-0000-000000000002', :'pipeline'::uuid, :'s1'::uuid, 200000, 'fixed', 'open', null, pg_temp.noon(1), :'otavio', pg_temp.noon(2)),
  ('c2000000-0000-0000-0000-000000000003', :'ws'::uuid, 'b2000000-0000-0000-0000-000000000003', :'pipeline'::uuid, :'s2'::uuid, 300000, 'fixed', 'won', pg_temp.noon(1), pg_temp.noon(1), :'otavio', pg_temp.noon(2));

insert into public.stage_transitions (workspace_id, opportunity_id, from_stage_id, to_stage_id, actor_user_id, occurred_at) values
  (:'ws'::uuid, 'c2000000-0000-0000-0000-000000000001', :'s0'::uuid, :'s3'::uuid, :'otavio', pg_temp.noon(1)),
  (:'ws'::uuid, 'c2000000-0000-0000-0000-000000000002', :'s0'::uuid, :'s1'::uuid, :'otavio', pg_temp.noon(2)),
  (:'ws'::uuid, 'c2000000-0000-0000-0000-000000000002', :'s1'::uuid, :'s2'::uuid, :'otavio', pg_temp.noon(2)),
  (:'ws'::uuid, 'c2000000-0000-0000-0000-000000000002', :'s2'::uuid, :'s1'::uuid, :'otavio', pg_temp.noon(1)),
  (:'ws'::uuid, 'c2000000-0000-0000-0000-000000000003', :'s0'::uuid, :'s1'::uuid, :'otavio', pg_temp.noon(2)),
  (:'ws'::uuid, 'c2000000-0000-0000-0000-000000000003', :'s1'::uuid, :'s2'::uuid, :'otavio', pg_temp.noon(1));

-- Registros da Sofia: uma consulta concluída no período e uma atividade
-- pendente atrasada (o lead dela já está atribuído acima).
insert into public.activities (workspace_id, lead_id, opportunity_id, type, title, assigned_to, due_at, status, completed_at, created_by) values
  (:'ws'::uuid, 'b2000000-0000-0000-0000-000000000004', null, 'meeting', 'Consulta da Sofia', :'sofia', pg_temp.noon(1), 'done', pg_temp.noon(1), :'otavio'),
  (:'ws'::uuid, 'b2000000-0000-0000-0000-000000000004', null, 'call', 'Ligação atrasada da Sofia', :'sofia', now() - interval '2 days', 'pending', null, :'otavio');

-- ===================================================================
-- A) Funil: etapas efetivamente registradas
-- ===================================================================

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'otavio', 'role', 'authenticated')::text, true);
select get_dashboard(:'ws'::uuid, 7) as d \gset

select is((:'d'::jsonb #>> '{funnel,cohort_size}')::int, 3, 'Coorte do funil: as três oportunidades criadas no período');

select is((pg_temp.stage(:'d'::jsonb, 0) ->> 'visited')::int, 3,
  'Etapa 0: as três passaram por ela (é a etapa de criação, origem da primeira transição)');
select is((pg_temp.stage(:'d'::jsonb, 1) ->> 'visited')::int, 2,
  'Etapa 1: só as duas que registraram passagem — a que pulou de 0 para 3 NÃO conta');
select is((pg_temp.stage(:'d'::jsonb, 2) ->> 'visited')::int, 2,
  'Etapa 2: a que voltou e a ganha; a que pulou não conta e a reentrada não duplica');
select is((pg_temp.stage(:'d'::jsonb, 3) ->> 'visited')::int, 1,
  'Etapa 3: só a oportunidade que realmente está nela');
select is((pg_temp.stage(:'d'::jsonb, 4) ->> 'visited')::int, 0,
  'Etapa 4: ninguém passou');

-- Taxa de avanço: mesma população no numerador e no denominador.
select is((pg_temp.stage(:'d'::jsonb, 1) ->> 'advanced')::int, 2,
  'Etapa 1: as duas que passaram por ela seguiram adiante (uma foi à etapa 2, a outra ganhou)');
select is((pg_temp.stage(:'d'::jsonb, 2) ->> 'advanced')::int, 1,
  'Etapa 2: das duas que passaram, só a ganha seguiu adiante — voltar não é avançar');
select is((pg_temp.stage(:'d'::jsonb, 3) ->> 'advanced')::int, 0,
  'Etapa 3: quem está nela ainda não seguiu adiante');
select ok(
  (select bool_and((s ->> 'advanced')::int <= (s ->> 'visited')::int)
   from jsonb_array_elements(:'d'::jsonb #> '{funnel,stages}') s),
  'Nenhuma etapa tem mais avanços do que passagens (taxa nunca passa de 100%)'
);
select is((pg_temp.stage(:'d'::jsonb, 2) ->> 'cohort_won_here')::int, 1,
  'A ganha aparece na etapa em que o ganho foi registrado');

-- Reordenar as etapas não pode reescrever o histórico: a leitura é por
-- identidade de etapa, não por posição.
select is(
  (select (s ->> 'visited')::int from jsonb_array_elements(:'d'::jsonb #> '{funnel,stages}') s
   where s ->> 'stage_id' = :'s3'),
  1, 'Antes de reordenar: a etapa que era a posição 3 tem uma passagem'
);

select reorder_pipeline_stages(
  :'pipeline'::uuid,
  (select array_agg(ps.id order by case ps.id when :'s3'::uuid then -1 else ps.position end)
   from public.pipeline_stages ps where ps.pipeline_id = :'pipeline'::uuid)
);

select get_dashboard(:'ws'::uuid, 7) as dr \gset

select is(
  (select (s ->> 'visited')::int from jsonb_array_elements(:'dr'::jsonb #> '{funnel,stages}') s
   where s ->> 'stage_id' = :'s3'),
  1, 'Depois de reordenar (a mesma etapa foi para a primeira posição): a passagem continua sendo uma'
);
select is(
  (select (s ->> 'visited')::int from jsonb_array_elements(:'dr'::jsonb #> '{funnel,stages}') s
   where s ->> 'stage_id' = :'s1'),
  2, 'Depois de reordenar: a etapa pulada por uma das oportunidades continua com duas passagens'
);

-- ===================================================================
-- B) Equipe: responsável removido do escritório
-- ===================================================================

select is(
  (select (t ->> 'leads_received')::int from jsonb_array_elements(:'d'::jsonb -> 'team') t where t ->> 'user_id' = :'sofia'),
  1, 'Membro ativo: o lead atribuído à Sofia aparece na linha dela'
);

reset role;
select id as sofia_membership from public.memberships where workspace_id = :'ws'::uuid and user_id = :'sofia' \gset

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'otavio', 'role', 'authenticated')::text, true);
select remove_membership(:'sofia_membership'::uuid);
select get_dashboard(:'ws'::uuid, 7) as db \gset

select is(
  (select t from jsonb_array_elements(:'db'::jsonb -> 'team') t where t ->> 'user_id' = :'sofia')
    - 'full_name',
  jsonb_build_object('user_id', :'sofia', 'is_former', true, 'leads_received', 1,
                     'consultations_done', 1, 'opportunities_won', 0, 'overdue_activities', 1),
  'Removido o membro, os registros dele continuam na tabela, marcados como ex-responsável'
);

select is(
  (select sum((t ->> 'leads_received')::int)::int from jsonb_array_elements(:'db'::jsonb -> 'team') t),
  (:'db'::jsonb #>> '{period_metrics,leads_received,current}')::int,
  'A soma da coluna de leads da tabela da equipe bate com o indicador geral do período'
);
select is(
  (select sum((t ->> 'consultations_done')::int)::int from jsonb_array_elements(:'db'::jsonb -> 'team') t),
  (:'db'::jsonb #>> '{period_metrics,consultations_done,current}')::int,
  'A soma da coluna de consultas bate com o indicador geral do período'
);
select is(
  (select sum((t ->> 'overdue_activities')::int)::int from jsonb_array_elements(:'db'::jsonb -> 'team') t),
  (:'db'::jsonb #>> '{positions,overdue_activities}')::int,
  'A soma da coluna de atrasadas bate com a posição atual'
);
select is((:'db'::jsonb #>> '{period_metrics,leads_received,current}')::int, 4,
  'Remover o membro não muda os indicadores gerais: os leads dele continuam visíveis para o proprietário'
);

-- ===================================================================
-- C) Consulta independente (fora da sessão do usuário, direto nas
--    tabelas): a contagem por etapa da função é o número de
--    oportunidades distintas com registro naquela etapa.
-- ===================================================================

reset role;

select is(
  (select (pg_temp.stage(:'d'::jsonb, 1) ->> 'visited')::int),
  (
    select count(distinct x.opportunity_id)::int
    from (
      select o.id as opportunity_id, o.stage_id from public.opportunities o where o.workspace_id = :'ws'::uuid
      union
      select st.opportunity_id, st.from_stage_id from public.stage_transitions st where st.workspace_id = :'ws'::uuid
      union
      select st.opportunity_id, st.to_stage_id from public.stage_transitions st where st.workspace_id = :'ws'::uuid
    ) x
    where x.stage_id = :'s1'::uuid
  ),
  'Etapa 1: a contagem da função bate com a consulta independente nas tabelas'
);

select * from finish();
rollback;
