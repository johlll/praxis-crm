-- pgTAP — Agenda mensal: list_activities_in_range().
--
-- Fixtures do seed (supabase/seed.sql): ana=owner/carla=lawyer/
-- elisa=viewer no Escritório Um; bruno=owner/carla=sales no Escritório
-- Dois; daniel=sem membership.
--
-- Prova: fronteiras do intervalo no fuso America/Sao_Paulo (00:00 do
-- primeiro dia entra, 00:00 do dia seguinte ao último não; atividade "só de
-- data" do último dia entra), fevereiro bissexto, virada de ano, pendentes
-- e concluídas, alcance por papel ("seus + sem responsável" do advogado),
-- isolamento entre escritórios, contagem por dia do intervalo inteiro
-- (independente da página), paginação com teto de 100 e validação do
-- intervalo. `request.jwt.claims` é escopo de transação: todo bloco
-- reafirma papel e claim.

begin;
select plan(40);

\set ws_um   '10000000-0000-0000-0000-000000000001'
\set ws_dois '10000000-0000-0000-0000-000000000002'
\set ana     '20000000-0000-0000-0000-000000000001'
\set bruno   '20000000-0000-0000-0000-000000000002'
\set carla   '20000000-0000-0000-0000-000000000003'
\set daniel  '20000000-0000-0000-0000-000000000004'
\set elisa   '20000000-0000-0000-0000-000000000005'

-- -----------------------------------------------------------------
-- Setup
-- -----------------------------------------------------------------

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'ana', 'role', 'authenticated')::text, true);
select (create_contact(:'ws_um'::uuid, 'pf', 'Contato Agenda Mensal Ana', null, null, null)).id as c_ana \gset
select (create_contact(:'ws_um'::uuid, 'pf', 'Contato Agenda Mensal Sem Resp', null, null, null)).id as c_sem \gset
select (create_contact(:'ws_um'::uuid, 'pf', 'Contato Agenda Mensal Carla', null, null, null)).id as c_carla \gset
select create_lead(:'ws_um'::uuid, (:'c_ana')::uuid, 'Trabalhista', 'Agenda mensal Ana', '{}'::text[], 'media', :'ana'::uuid) as l_ana \gset
select create_lead(:'ws_um'::uuid, (:'c_sem')::uuid, 'Cível', 'Agenda mensal sem resp', '{}'::text[], 'media', null) as l_sem \gset
select create_lead(:'ws_um'::uuid, (:'c_carla')::uuid, 'Família', 'Agenda mensal Carla', '{}'::text[], 'media', :'carla'::uuid) as l_carla \gset

-- Fevereiro de 2027 (28 dias).
select create_activity(p_lead_id := (:'l_ana')::uuid, p_type := 'call'::activity_type, p_title := 'AM antes do mês',
  p_due_date := '2027-01-31'::date, p_due_time := '23:59'::time) as a_antes \gset
select create_activity(p_lead_id := (:'l_ana')::uuid, p_type := 'call'::activity_type, p_title := 'AM meia-noite do dia 1',
  p_due_date := '2027-02-01'::date, p_due_time := '00:00'::time) as a_inicio \gset
select create_activity(p_lead_id := (:'l_ana')::uuid, p_type := 'deadline'::activity_type, p_title := 'AM só data no último dia',
  p_due_date := '2027-02-28'::date) as a_fim \gset
select create_activity(p_lead_id := (:'l_ana')::uuid, p_type := 'call'::activity_type, p_title := 'AM meia-noite do mês seguinte',
  p_due_date := '2027-03-01'::date, p_due_time := '00:00'::time) as a_depois \gset
select create_activity(p_lead_id := (:'l_sem')::uuid, p_type := 'meeting'::activity_type, p_title := 'AM sem responsável',
  p_due_date := '2027-02-10'::date, p_due_time := '14:00'::time) as a_sem \gset
select create_activity(p_lead_id := (:'l_carla')::uuid, p_type := 'task'::activity_type, p_title := 'AM da Carla',
  p_due_date := '2027-02-10'::date) as a_carla \gset
select create_activity(p_lead_id := (:'l_ana')::uuid, p_type := 'task'::activity_type, p_title := 'AM concluída',
  p_due_date := '2027-02-10'::date, p_due_time := '09:00'::time) as a_done \gset
select (get_activity((:'a_done')::uuid) ->> 'lock_version') as a_done_lock \gset
select complete_activity((:'a_done')::uuid, (:'a_done_lock')::bigint);

-- Bissexto e virada de ano.
select create_activity(p_lead_id := (:'l_ana')::uuid, p_type := 'task'::activity_type, p_title := 'AM 29 de fevereiro',
  p_due_date := '2028-02-29'::date) as a_bissexto \gset
select create_activity(p_lead_id := (:'l_ana')::uuid, p_type := 'call'::activity_type, p_title := 'AM 31 de dezembro',
  p_due_date := '2027-12-31'::date, p_due_time := '23:30'::time) as a_reveillon \gset

-- Mais de uma página num mês: 101 atividades em maio de 2029.
select set_config('agenda.l_ana', :'l_ana', true);
do $fill$
begin
  for i in 1..101 loop
    perform public.create_activity(
      p_lead_id := (current_setting('agenda.l_ana'))::uuid,
      p_type := 'task'::public.activity_type,
      p_title := 'AM volume ' || i,
      p_due_date := ('2029-05-01'::date + (i % 31)),
      p_due_time := '10:00'::time
    );
  end loop;
end;
$fill$;

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'bruno', 'role', 'authenticated')::text, true);
select (create_contact(:'ws_dois'::uuid, 'pf', 'Contato Agenda Mensal Dois', null, null, null)).id as c_dois \gset
select create_lead(:'ws_dois'::uuid, (:'c_dois')::uuid, 'Tributário', 'Agenda mensal dois', '{}'::text[], 'media', null) as l_dois \gset
select create_activity(p_lead_id := (:'l_dois')::uuid, p_type := 'task'::activity_type, p_title := 'AM outro escritório',
  p_due_date := '2027-02-10'::date) as a_dois \gset

-- ===================================================================
-- 1) Dona: fronteiras, contagem por dia, concluídas, ordem
-- ===================================================================

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'ana', 'role', 'authenticated')::text, true);
select items as fev_items, total_count as fev_total, day_counts as fev_dias
from list_activities_in_range(:'ws_um'::uuid, '2027-02-01'::date, '2027-02-28'::date) \gset

select is((:'fev_total')::bigint, 5::bigint, 'fevereiro/2027: 5 atividades no intervalo (pendentes e concluídas)');
select is(
  (:'fev_dias')::jsonb,
  '{"2027-02-01": 1, "2027-02-10": 3, "2027-02-28": 1}'::jsonb,
  'contagem por dia no fuso do escritório'
);
select ok((:'fev_items')::jsonb @> jsonb_build_array(jsonb_build_object('id', :'a_inicio')),
  '00:00 do primeiro dia entra no intervalo');
select ok((:'fev_items')::jsonb @> jsonb_build_array(jsonb_build_object('id', :'a_fim')),
  'atividade só de data no último dia (23:59:59 local) entra');
select ok(not ((:'fev_items')::jsonb @> jsonb_build_array(jsonb_build_object('id', :'a_antes'))),
  '23:59 do dia anterior ao primeiro fica fora');
select ok(not ((:'fev_items')::jsonb @> jsonb_build_array(jsonb_build_object('id', :'a_depois'))),
  '00:00 do dia seguinte ao último fica fora');
select ok((:'fev_items')::jsonb @> jsonb_build_array(jsonb_build_object('id', :'a_done', 'status', 'done')),
  'concluída aparece, com status done');
select ok(not ((:'fev_items')::jsonb @> jsonb_build_array(jsonb_build_object('id', :'a_dois'))),
  'atividade de outro escritório nunca aparece');
select is(((:'fev_items')::jsonb -> 0 ->> 'id'), :'a_inicio'::text, 'ordem cronológica: a primeira é a da meia-noite do dia 1');
select is(((:'fev_items')::jsonb -> 4 ->> 'id'), :'a_fim'::text, 'ordem cronológica: a última é a do dia 28');
select is(jsonb_array_length((:'fev_items')::jsonb), 5, 'itens da página batem com o total quando cabem numa página');
select ok(
  ((:'fev_items')::jsonb -> 0) ?& array['id', 'lead_id', 'opportunity_id', 'contact_name', 'legal_area', 'type', 'title',
    'notes', 'assigned_to', 'assigned_to_name', 'priority', 'due_at', 'has_time', 'status', 'completed_at', 'source',
    'lock_version', 'created_at', 'updated_at'],
  'item com o mesmo formato de list_activities()'
);

-- Bissexto e virada de ano.
select is(
  (select day_counts from list_activities_in_range(:'ws_um'::uuid, '2028-02-01'::date, '2028-02-29'::date)),
  '{"2028-02-29": 1}'::jsonb,
  '29 de fevereiro de 2028 é um dia válido e conta'
);
select is(
  (select day_counts from list_activities_in_range(:'ws_um'::uuid, '2027-12-01'::date, '2027-12-31'::date)),
  '{"2027-12-31": 1}'::jsonb,
  '31/12 às 23:30 conta em dezembro'
);
select is(
  (select total_count from list_activities_in_range(:'ws_um'::uuid, '2028-01-01'::date, '2028-01-31'::date)),
  0::bigint,
  'e não vaza para janeiro do ano seguinte'
);
select is(
  (select items from list_activities_in_range(:'ws_um'::uuid, '2028-01-01'::date, '2028-01-31'::date)),
  '[]'::jsonb,
  'mês sem atividades: lista vazia (não nula)'
);
select is(
  (select day_counts from list_activities_in_range(:'ws_um'::uuid, '2028-01-01'::date, '2028-01-31'::date)),
  '{}'::jsonb,
  'mês sem atividades: contagem vazia (não nula)'
);

-- ===================================================================
-- 2) Paginação: a contagem por dia e o total nunca são os da página
-- ===================================================================

select is(
  (select total_count from list_activities_in_range(:'ws_um'::uuid, '2029-05-01'::date, '2029-05-31'::date, 1, 500)),
  101::bigint,
  'maio/2029: total do intervalo inteiro (101)'
);
select is(
  (select jsonb_array_length(items) from list_activities_in_range(:'ws_um'::uuid, '2029-05-01'::date, '2029-05-31'::date, 1, 500)),
  100,
  'página limitada a 100 mesmo pedindo 500'
);
select is(
  (select jsonb_array_length(items) from list_activities_in_range(:'ws_um'::uuid, '2029-05-01'::date, '2029-05-31'::date, 2, 100)),
  1,
  'a segunda página traz a que faltava'
);
select is(
  (select sum(value::int)::int from list_activities_in_range(:'ws_um'::uuid, '2029-05-01'::date, '2029-05-31'::date, 1, 100) r,
     jsonb_each_text(r.day_counts)),
  101,
  'a soma da contagem por dia é o total do mês, não o da página'
);
select is(
  (select count(distinct x ->> 'id')::int from (
     select jsonb_array_elements(items) as x from list_activities_in_range(:'ws_um'::uuid, '2029-05-01'::date, '2029-05-31'::date, 1, 100)
     union all
     select jsonb_array_elements(items) from list_activities_in_range(:'ws_um'::uuid, '2029-05-01'::date, '2029-05-31'::date, 2, 100)
   ) t),
  101,
  'as duas páginas juntas cobrem as 101, sem repetir'
);
select is(
  (select jsonb_array_length(items) from list_activities_in_range(:'ws_um'::uuid, '2027-02-01'::date, '2027-02-28'::date, 2, 2)),
  2,
  'página 2 de tamanho 2'
);
select is(
  (select items from list_activities_in_range(:'ws_um'::uuid, '2027-02-01'::date, '2027-02-28'::date, 4, 2)),
  '[]'::jsonb,
  'página além do fim: lista vazia'
);
select is(
  (select total_count from list_activities_in_range(:'ws_um'::uuid, '2027-02-01'::date, '2027-02-28'::date, 4, 2)),
  5::bigint,
  'página além do fim: total continua o do intervalo'
);

-- ===================================================================
-- 3) Alcance por papel e isolamento
-- ===================================================================

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'carla', 'role', 'authenticated')::text, true);
select items as carla_items, total_count as carla_total, day_counts as carla_dias
from list_activities_in_range(:'ws_um'::uuid, '2027-02-01'::date, '2027-02-28'::date) \gset
select is((:'carla_total')::bigint, 2::bigint, 'advogada: só as dos seus leads e dos sem responsável');
select is((:'carla_dias')::jsonb, '{"2027-02-10": 2}'::jsonb, 'advogada: a contagem por dia também respeita o alcance');
select ok(not ((:'carla_items')::jsonb @> jsonb_build_array(jsonb_build_object('id', :'a_inicio'))),
  'advogada não recebe atividade de lead de outra pessoa');

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'elisa', 'role', 'authenticated')::text, true);
select is(
  (select total_count from list_activities_in_range(:'ws_um'::uuid, '2027-02-01'::date, '2027-02-28'::date)),
  5::bigint,
  'leitura (viewer) enxerga o escritório inteiro, como em list_activities()'
);

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'bruno', 'role', 'authenticated')::text, true);
select throws_ok(
  $q$ select * from list_activities_in_range('10000000-0000-0000-0000-000000000001'::uuid, '2027-02-01'::date, '2027-02-28'::date) $q$,
  'P0001', 'insufficient_permission',
  'quem não é membro do escritório não lê nem a contagem'
);
select is(
  (select day_counts from list_activities_in_range(:'ws_dois'::uuid, '2027-02-01'::date, '2027-02-28'::date)),
  '{"2027-02-10": 1}'::jsonb,
  'no próprio escritório, só as dele'
);

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'daniel', 'role', 'authenticated')::text, true);
select throws_ok(
  $q$ select * from list_activities_in_range('10000000-0000-0000-0000-000000000001'::uuid, '2027-02-01'::date, '2027-02-28'::date) $q$,
  'P0001', 'insufficient_permission',
  'sem membership nenhuma: recusado'
);

set local role authenticated;
select set_config('request.jwt.claims', '{"role": "authenticated"}', true);
select throws_ok(
  $q$ select * from list_activities_in_range('10000000-0000-0000-0000-000000000001'::uuid, '2027-02-01'::date, '2027-02-28'::date) $q$,
  'P0001', 'authentication_required',
  'sem usuário: recusado'
);

set local role anon;
select throws_ok(
  $q$ select * from list_activities_in_range('10000000-0000-0000-0000-000000000001'::uuid, '2027-02-01'::date, '2027-02-28'::date) $q$,
  '42501', null,
  'anon não tem EXECUTE'
);

-- ===================================================================
-- 4) Validação do intervalo
-- ===================================================================

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'ana', 'role', 'authenticated')::text, true);
select throws_ok(
  $q$ select * from list_activities_in_range('10000000-0000-0000-0000-000000000001'::uuid, '2027-02-28'::date, '2027-02-01'::date) $q$,
  'P0001', 'invalid_date_range',
  'fim antes do início: recusado'
);
select throws_ok(
  $q$ select * from list_activities_in_range('10000000-0000-0000-0000-000000000001'::uuid, null, '2027-02-01'::date) $q$,
  'P0001', 'invalid_date_range',
  'início ausente: recusado'
);
select throws_ok(
  $q$ select * from list_activities_in_range('10000000-0000-0000-0000-000000000001'::uuid, '2027-02-01'::date, null) $q$,
  'P0001', 'invalid_date_range',
  'fim ausente: recusado'
);
select throws_ok(
  $q$ select * from list_activities_in_range('10000000-0000-0000-0000-000000000001'::uuid, '2027-01-01'::date, '2027-02-12'::date) $q$,
  'P0001', 'invalid_date_range',
  '43 dias: recusado (não vira leitura do histórico)'
);
select lives_ok(
  $q$ select * from list_activities_in_range('10000000-0000-0000-0000-000000000001'::uuid, '2027-01-01'::date, '2027-02-11'::date) $q$,
  '42 dias (seis semanas): aceito'
);
select lives_ok(
  $q$ select * from list_activities_in_range('10000000-0000-0000-0000-000000000001'::uuid, '2027-02-10'::date, '2027-02-10'::date) $q$,
  'um único dia: aceito'
);

select * from finish();
rollback;
