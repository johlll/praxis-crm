-- pgTAP — A9: Perfil 360º do lead (proposals, conflict_checks, lead_notes,
-- get_lead_timeline, list_conversations com p_lead_id).
--
-- Fixtures do seed (supabase/seed.sql): ana=owner/carla=lawyer/elisa=viewer
-- no Escritório Um (ws_um); bruno=owner/carla=sales no Escritório Dois
-- (ws_dois). Mesma disciplina dos arquivos anteriores: `request.jwt.claims`
-- é escopo de TRANSAÇÃO — todo bloco reafirma role+claim antes de cada
-- chamada, nunca confia em estado deixado por um bloco anterior.

begin;
select plan(40);

\set ws_um    '10000000-0000-0000-0000-000000000001'
\set ws_dois  '10000000-0000-0000-0000-000000000002'
\set ana      '20000000-0000-0000-0000-000000000001'
\set bruno    '20000000-0000-0000-0000-000000000002'
\set carla    '20000000-0000-0000-0000-000000000003'
\set elisa    '20000000-0000-0000-0000-000000000005'

-- -----------------------------------------------------------------
-- Setup ws_um: lead_a atribuído à Ana (fora do alcance do advogado
-- carla), lead_b sem responsável (dentro do alcance de qualquer
-- advogado) — mesmo desenho da A8 para provar o filtro por registro.
-- -----------------------------------------------------------------

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'ana', 'role', 'authenticated')::text, true);
select (create_contact(:'ws_um'::uuid, 'pf', 'Contato A9 A', null, null, null)).id as contact_a \gset
select (create_contact(:'ws_um'::uuid, 'pf', 'Contato A9 B', null, null, null)).id as contact_b \gset
select create_lead(:'ws_um'::uuid, (:'contact_a')::uuid, 'Trabalhista', 'Lead A9 A', '{}'::text[], 'media', :'ana'::uuid) as lead_a \gset
select create_lead(:'ws_um'::uuid, (:'contact_b')::uuid, 'Cível', 'Lead A9 B', '{}'::text[], 'media', null) as lead_b \gset
select create_opportunity(:'lead_a'::uuid) as opp_a \gset
select create_opportunity(:'lead_b'::uuid) as opp_b \gset
reset role;

-- ===================================================================
-- 1) RLS habilitada e forçada nas 3 tabelas novas.
-- ===================================================================

select is(
  (
    select count(*)::int
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind = 'r'
      and c.relname in ('proposals', 'conflict_checks', 'lead_notes')
      and (c.relrowsecurity is false or c.relforcerowsecurity is false)
  ),
  0,
  'proposals/conflict_checks/lead_notes: RLS habilitada e forçada nas 3'
);

-- ===================================================================
-- 2) create_lead_note — alcance por registro e papel
-- ===================================================================

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'carla', 'role', 'authenticated')::text, true);
select lives_ok(
  format($i$ select create_lead_note(%L::uuid, 'nota do advogado') $i$, :'lead_b'),
  'Advogado cria anotação em lead SEM responsável (dentro do alcance)'
);
select throws_ok(
  format($i$ select create_lead_note(%L::uuid, 'nota fora do alcance') $i$, :'lead_a'),
  'P0001', 'lead_not_found',
  'Advogado NÃO cria anotação em lead de outro responsável'
);

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'elisa', 'role', 'authenticated')::text, true);
select throws_ok(
  format($i$ select create_lead_note(%L::uuid, 'nota do viewer') $i$, :'lead_b'),
  'P0001', 'insufficient_permission',
  'Viewer não cria anotação (papel sem permissão de escrita)'
);

-- ===================================================================
-- 3) proposals — criação, alcance, projeção financeira por papel,
--    ciclo de vida (rascunho -> enviada -> decidida) e concorrência.
-- ===================================================================

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'ana', 'role', 'authenticated')::text, true);
select create_proposal(:'opp_a'::uuid, 500000, 'fixed') as proposal_a \gset
select create_proposal(:'opp_b'::uuid, 300000, 'contingency') as proposal_b \gset
reset role;

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'carla', 'role', 'authenticated')::text, true);
select throws_ok(
  format($i$ select create_proposal(%L::uuid, 100000, 'fixed') $i$, :'opp_a'),
  'P0001', 'lead_not_found',
  'Advogado não cria proposta numa oportunidade fora do seu alcance'
);
select lives_ok(
  format($i$ select create_proposal(%L::uuid, 100000, 'fixed') $i$, :'opp_b'),
  'Advogado cria proposta numa oportunidade dentro do seu alcance'
);

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'elisa', 'role', 'authenticated')::text, true);
select throws_ok(
  format($i$ select create_proposal(%L::uuid, 100000, 'fixed') $i$, :'opp_b'),
  'P0001', 'insufficient_permission',
  'Viewer não cria proposta (papel sem permissão de escrita)'
);
select list_proposals_for_lead(:'lead_a'::uuid) as proposals_viewer \gset
select ok(
  not ((:'proposals_viewer'::jsonb -> 0) ? 'value_cents'),
  'Viewer não recebe value_cents na lista de propostas'
);
select ok(
  (:'proposals_viewer'::jsonb -> 0) ? 'status',
  'Viewer recebe status da proposta normalmente'
);

-- Promove elisa temporariamente a sales só para o teste de faixa —
-- reset ao fim (mesmo padrão já usado na A8 para os testes de papel
-- que o seed não cobre sozinho).
reset role;
update public.memberships set role = 'sales' where workspace_id = :'ws_um'::uuid and user_id = :'elisa'::uuid;

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'elisa', 'role', 'authenticated')::text, true);
select list_proposals_for_lead(:'lead_a'::uuid) as proposals_sales \gset
select ok(
  (:'proposals_sales'::jsonb -> 0) ? 'value_band',
  'Sales recebe value_band (faixa) na lista de propostas'
);
select ok(
  not ((:'proposals_sales'::jsonb -> 0) ? 'value_cents'),
  'Sales NÃO recebe value_cents exato na lista de propostas'
);

reset role;
update public.memberships set role = 'viewer' where workspace_id = :'ws_um'::uuid and user_id = :'elisa'::uuid;

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'ana', 'role', 'authenticated')::text, true);
select list_proposals_for_lead(:'lead_a'::uuid) as proposals_owner \gset
select ok(
  (:'proposals_owner'::jsonb -> 0 ->> 'value_cents')::bigint = 500000,
  'Owner recebe value_cents exato na lista de propostas'
);

select lives_ok(
  format($i$ select send_proposal(%L::uuid, 0, array['whatsapp']::public.proposal_channel[]) $i$, :'proposal_a'),
  'Owner envia a proposta (rascunho -> enviada)'
);
select throws_ok(
  format($i$ select send_proposal(%L::uuid, 0, array['whatsapp']::public.proposal_channel[]) $i$, :'proposal_a'),
  'P0001', 'proposal_already_sent',
  'Proposta já enviada não pode ser enviada de novo'
);
select throws_ok(
  format($i$ select send_proposal(%L::uuid, 99, array['whatsapp']::public.proposal_channel[]) $i$, :'proposal_b'),
  'P0001', 'stale_version',
  'send_proposal com lock_version desatualizado falha (concorrência)'
);
select lives_ok(
  format($i$ select decide_proposal(%L::uuid, 1, 'aceita', 'cliente aceitou por telefone') $i$, :'proposal_a'),
  'Owner decide a proposta enviada (enviada -> aceita)'
);
select throws_ok(
  format($i$ select decide_proposal(%L::uuid, 2, 'recusada', null) $i$, :'proposal_a'),
  'P0001', 'proposal_not_sent',
  'Proposta já decidida não aceita nova decisão'
);

-- ===================================================================
-- 4) conflict_checks — escrita restrita, leitura ampla, 1 por lead
-- ===================================================================

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'elisa', 'role', 'authenticated')::text, true);
select get_conflict_check(:'lead_b'::uuid) as conflict_default \gset
select is(
  (:'conflict_default'::jsonb ->> 'status'), 'nao_verificado',
  'Sem registro ainda, get_conflict_check() devolve "não verificado" (nunca 404)'
);
select throws_ok(
  format($i$ select upsert_conflict_check(%L::uuid, 'sem_conflito', null, null) $i$, :'lead_b'),
  'P0001', 'insufficient_permission',
  'Viewer não registra verificação de conflito (só lê)'
);

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'carla', 'role', 'authenticated')::text, true);
select throws_ok(
  format($i$ select upsert_conflict_check(%L::uuid, 'sem_conflito', null, null) $i$, :'lead_a'),
  'P0001', 'lead_not_found',
  'Advogado não registra conflito em lead fora do seu alcance'
);
select upsert_conflict_check(:'lead_b'::uuid, 'sem_conflito', 'nenhuma coincidência encontrada', null) as conflict_created \gset
select is(
  (:'conflict_created'::jsonb ->> 'status'), 'sem_conflito',
  'Advogado registra verificação de conflito em lead dentro do alcance'
);
select throws_ok(
  format($i$ select upsert_conflict_check(%L::uuid, 'em_analise', null, 5) $i$, :'lead_b'),
  'P0001', 'stale_version',
  'upsert_conflict_check com lock_version desatualizado falha (concorrência)'
);

-- A nota pode conter detalhe sensível sobre partes envolvidas: só quem
-- pode escrever a verificação lê o texto (achado do review pós-CI —
-- get_conflict_check() devolvia a nota para qualquer um dos 6 papéis,
-- inclusive atendimento/visualizador, sem projeção nenhuma).
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'carla', 'role', 'authenticated')::text, true);
select get_conflict_check(:'lead_b'::uuid) as conflict_as_lawyer \gset
select is(
  (:'conflict_as_lawyer'::jsonb ->> 'note'), 'nenhuma coincidência encontrada',
  'Advogado (pode escrever) lê o texto da nota de conflito'
);

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'elisa', 'role', 'authenticated')::text, true);
select get_conflict_check(:'lead_b'::uuid) as conflict_as_viewer \gset
select is(
  (:'conflict_as_viewer'::jsonb ->> 'status'), 'sem_conflito',
  'Visualizador lê o status da verificação de conflito normalmente'
);
select ok(
  (:'conflict_as_viewer'::jsonb ->> 'note') is null,
  'Visualizador NÃO recebe o texto da nota de conflito'
);

-- Promove elisa a sales só para este teste (mesmo padrão já usado acima
-- para o teste de faixa de propostas) — reset ao fim.
reset role;
update public.memberships set role = 'sales' where workspace_id = :'ws_um'::uuid and user_id = :'elisa'::uuid;

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'elisa', 'role', 'authenticated')::text, true);
select get_conflict_check(:'lead_b'::uuid) as conflict_as_sales \gset
select ok(
  (:'conflict_as_sales'::jsonb ->> 'note') is null,
  'Atendimento NÃO recebe o texto da nota de conflito'
);

reset role;
update public.memberships set role = 'viewer' where workspace_id = :'ws_um'::uuid and user_id = :'elisa'::uuid;

-- ===================================================================
-- 5) get_lead_timeline — ordenação determinística e paginação sem
--    furo nem repetição quando eventos empatam no timestamp (mesmo
--    achado já documentado na A7 e corrigido de novo na A8/PR #12).
-- ===================================================================

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'ana', 'role', 'authenticated')::text, true);
select create_lead_note(:'lead_a'::uuid, 'empate 1') as note_e1 \gset
select create_lead_note(:'lead_a'::uuid, 'empate 2') as note_e2 \gset
select create_lead_note(:'lead_a'::uuid, 'empate 3') as note_e3 \gset
reset role;
-- Força o EMPATE de created_at nas 3 notas (now() já é estável por
-- transação, mas fixar explicitamente remove qualquer dependência de
-- quão rápido as 3 chamadas rodaram).
update public.lead_notes set created_at = '2026-01-01T00:00:00Z'::timestamptz
where id in (:'note_e1'::uuid, :'note_e2'::uuid, :'note_e3'::uuid);

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'ana', 'role', 'authenticated')::text, true);
select items, has_more from get_lead_timeline(:'lead_a'::uuid, array['nota'], null, null, 2) \gset pg1_
select is(jsonb_array_length(:'pg1_items'::jsonb), 2, 'Empate de timestamp: primeira página respeita o limite pedido (2)');
select ok((:'pg1_has_more')::boolean, 'Empate de timestamp: has_more=true (resta 1 das 3)');

select (:'pg1_items'::jsonb -> 1 ->> 'occurred_at')::timestamptz as pg1_cursor_at \gset
select (:'pg1_items'::jsonb -> 1 ->> 'id')::uuid as pg1_cursor_id \gset
select items, has_more
  from get_lead_timeline(:'lead_a'::uuid, array['nota'], :'pg1_cursor_at'::timestamptz, :'pg1_cursor_id'::uuid, 2)
  \gset pg2_
select is(jsonb_array_length(:'pg2_items'::jsonb), 1, 'Empate de timestamp: segunda página traz a última nota restante');
select ok(not (:'pg2_has_more')::boolean, 'Empate de timestamp: has_more=false depois da última página');
select ok(
  not exists(
    select 1
    from jsonb_array_elements(:'pg1_items'::jsonb) p1
    join jsonb_array_elements(:'pg2_items'::jsonb) p2 on (p1 ->> 'id') = (p2 ->> 'id')
  ),
  'Nenhuma nota aparece nas duas páginas mesmo com created_at empatado'
);

-- ===================================================================
-- 5b) get_last_completed_meeting — o cartão "Consulta" não pode depender
--     da primeira página de atividades (50). 55 tarefas com prazo antes
--     das reuniões empurram a reunião mais recente para fora dessa
--     página; a função precisa achá-la mesmo assim.
-- ===================================================================

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'ana', 'role', 'authenticated')::text, true);
select count(*) filter (where created_id is not null) as volume_created from (
  select create_activity(:'lead_a'::uuid, 'task'::activity_type, 'Tarefa de volume ' || g, '2026-01-01'::date + g) as created_id
  from generate_series(1, 55) g
) t \gset
select create_activity(:'lead_a'::uuid, 'meeting'::activity_type, 'Consulta antiga', '2026-06-01'::date) as meeting_old \gset
select create_activity(:'lead_a'::uuid, 'meeting'::activity_type, 'Consulta recente', '2027-12-30'::date) as meeting_new \gset
select create_activity(:'lead_a'::uuid, 'meeting'::activity_type, 'Consulta empatada', '2027-12-31'::date) as meeting_tie \gset
reset role;

-- Conclusões com instante fixo: as tarefas terminam DEPOIS das reuniões
-- (prova que o filtro é por tipo, não só pela conclusão mais recente).
update public.activities set status = 'done', completed_at = '2026-04-01T00:00:00Z'
where lead_id = :'lead_a'::uuid and type = 'task';
update public.activities set status = 'done', completed_at = '2026-02-01T00:00:00Z' where id = :'meeting_old'::uuid;
update public.activities set status = 'done', completed_at = '2026-03-01T00:00:00Z' where id = :'meeting_new'::uuid;

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'ana', 'role', 'authenticated')::text, true);
select items from list_activities(:'ws_um'::uuid, null, :'lead_a'::uuid, null, null, 'due_at_asc', 1, 50) \gset act_pg1_
select ok(
  not exists(select 1 from jsonb_array_elements(:'act_pg1_items'::jsonb) e where (e ->> 'id') = :'meeting_new'),
  'A reunião concluída mais recente está FORA da primeira página de 50 atividades'
);
select is(
  get_last_completed_meeting(:'lead_a'::uuid) ->> 'id', :'meeting_new',
  'get_last_completed_meeting acha a reunião concluída mais recente mesmo fora das primeiras 50'
);
reset role;

-- Empate exato de completed_at: desempate determinístico por id desc.
update public.activities set status = 'done', completed_at = '2026-03-01T00:00:00Z' where id = :'meeting_tie'::uuid;
select id::text as tie_expected from public.activities
where id in (:'meeting_new'::uuid, :'meeting_tie'::uuid) order by id desc limit 1 \gset

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'ana', 'role', 'authenticated')::text, true);
select is(
  get_last_completed_meeting(:'lead_a'::uuid) ->> 'id', :'tie_expected',
  'Empate de completed_at resolve sempre para a mesma reunião (id desc)'
);

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'carla', 'role', 'authenticated')::text, true);
select throws_ok(
  format($i$ select get_last_completed_meeting(%L::uuid) $i$, :'lead_a'),
  'P0001', 'lead_not_found',
  'Advogado fora do alcance do lead não lê a última consulta'
);
select ok(
  get_last_completed_meeting(:'lead_b'::uuid) is null,
  'Lead sem reunião concluída devolve null (não é erro)'
);

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'bruno', 'role', 'authenticated')::text, true);
select throws_ok(
  format($i$ select get_last_completed_meeting(%L::uuid) $i$, :'lead_a'),
  'P0001', 'insufficient_permission',
  'Owner de outro workspace não lê a última consulta de um lead que não é dele'
);
reset role;

-- ===================================================================
-- 6) list_conversations(p_lead_id) — filtro aditivo, sem conversas
-- ===================================================================

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'ana', 'role', 'authenticated')::text, true);

select total_count from list_conversations(:'ws_um'::uuid, 1, 20, :'lead_b'::uuid) \gset lc9_
select is((:'lc9_total_count')::int, 0, 'list_conversations(p_lead_id) sem conversas vinculadas devolve total 0');

-- ===================================================================
-- 7) Isolamento entre workspaces
-- ===================================================================

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'bruno', 'role', 'authenticated')::text, true);
-- Bruno não é membro NENHUM do ws_um — o gate de papel do workspace
-- (private.has_workspace_role) barra antes mesmo de chegar ao alcance por
-- registro, e falha com insufficient_permission (mesmo comportamento já
-- valido na A8 para get_client() com um owner de outro workspace,
-- 13_a8_clients.test.sql §11). lead_not_found é reservado para quem É
-- membro do workspace certo mas não tem alcance sobre ESTE registro.
select throws_ok(
  format($i$ select list_proposals_for_lead(%L::uuid) $i$, :'lead_a'),
  'P0001', 'insufficient_permission',
  'Owner de outro workspace não lista propostas de um lead que não é dele'
);
select throws_ok(
  format($i$ select get_conflict_check(%L::uuid) $i$, :'lead_a'),
  'P0001', 'insufficient_permission',
  'Owner de outro workspace não lê a verificação de conflito de um lead que não é dele'
);

select * from finish();
