-- pgTAP — A8: clientes e handoff.
--
-- Fixtures do seed (supabase/seed.sql): ana=owner/carla=lawyer/
-- elisa=viewer no Escritório Um (ws_um); bruno=owner/carla=sales no
-- Escritório Dois (ws_dois); user 4 não é membro de workspace nenhum
-- (fixture pronta para "não é membro").
--
-- Mesma disciplina dos arquivos anteriores: `request.jwt.claims` é
-- escopo de TRANSAÇÃO — todo bloco reafirma role+claim antes de cada
-- chamada, nunca confia em estado deixado por um bloco anterior.

begin;
select plan(61);

\set ws_um    '10000000-0000-0000-0000-000000000001'
\set ws_dois  '10000000-0000-0000-0000-000000000002'
\set ana      '20000000-0000-0000-0000-000000000001'
\set bruno    '20000000-0000-0000-0000-000000000002'
\set carla    '20000000-0000-0000-0000-000000000003'
\set naomembro '20000000-0000-0000-0000-000000000004'
\set elisa    '20000000-0000-0000-0000-000000000005'

reset role;
select id as pipe_um from public.pipelines where workspace_id = :'ws_um'::uuid and is_default \gset
select id as pipe_dois from public.pipelines where workspace_id = :'ws_dois'::uuid and is_default \gset

-- -----------------------------------------------------------------
-- Setup ws_um: dois contatos — um com lead atribuído à ANA (fora do
-- alcance do advogado carla), outro SEM responsável (dentro do
-- alcance de qualquer advogado) — para provar o filtro por registro
-- de list_clients()/get_client() reaproveitando
-- private.lead_accessible_to_role() sem duplicar a regra.
-- -----------------------------------------------------------------

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'ana', 'role', 'authenticated')::text, true);
select (create_contact(:'ws_um'::uuid, 'pf', 'Contato A8 Ana', null, null, null)).id as contact_ana \gset
select (create_contact(:'ws_um'::uuid, 'pf', 'Contato A8 Sem Resp', null, null, null)).id as contact_sem_resp \gset
select (create_contact(:'ws_um'::uuid, 'pf', 'Contato A8 Merge Vencedor', null, null, null)).id as contact_merge_vencedor \gset
select (create_contact(:'ws_um'::uuid, 'pf', 'Contato A8 Merge Perdedor', null, null, null)).id as contact_merge_perdedor \gset
select (create_contact(:'ws_um'::uuid, 'pf', 'Contato A8 Sem Handoff', null, null, null)).id as contact_sem_handoff \gset

select create_lead(:'ws_um'::uuid, (:'contact_ana')::uuid, 'Trabalhista', 'Lead A8 Ana', '{}'::text[], 'media', :'ana'::uuid) as lead_ana \gset
select create_lead(:'ws_um'::uuid, (:'contact_sem_resp')::uuid, 'Cível', 'Lead A8 Sem Resp', '{}'::text[], 'media', null) as lead_sem_resp \gset
select create_lead(:'ws_um'::uuid, (:'contact_merge_vencedor')::uuid, 'Família', 'Lead A8 Merge Vencedor', '{}'::text[], 'media', null) as lead_merge_vencedor \gset
select create_lead(:'ws_um'::uuid, (:'contact_merge_perdedor')::uuid, 'Família', 'Lead A8 Merge Perdedor', '{}'::text[], 'media', null) as lead_merge_perdedor \gset

select create_opportunity(:'lead_ana'::uuid) as opp_ana \gset
select create_opportunity(:'lead_sem_resp'::uuid) as opp_sem_resp \gset
select create_opportunity(:'lead_merge_vencedor'::uuid) as opp_merge_vencedor \gset
select create_opportunity(:'lead_merge_perdedor'::uuid) as opp_merge_perdedor \gset

select win_opportunity(:'opp_ana'::uuid, 0, 800000, 'fixed') as win_ana \gset
select win_opportunity(:'opp_sem_resp'::uuid, 0, 300000, 'fixed') as win_sem_resp \gset
select win_opportunity(:'opp_merge_vencedor'::uuid, 0, 100000, 'fixed') as win_merge_vencedor \gset
select win_opportunity(:'opp_merge_perdedor'::uuid, 0, 200000, 'fixed') as win_merge_perdedor \gset

reset role;
select (:'win_ana'::jsonb ->> 'client_id') as client_ana \gset
select (:'win_sem_resp'::jsonb ->> 'client_id') as client_sem_resp \gset
select (:'win_merge_vencedor'::jsonb ->> 'client_id') as client_merge_vencedor \gset
select (:'win_merge_perdedor'::jsonb ->> 'client_id') as client_merge_perdedor \gset

-- Setup ws_dois: um contato/lead/oportunidade ganha, para testar a
-- projeção de "sales" (carla é sales neste workspace).
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'bruno', 'role', 'authenticated')::text, true);
select (create_contact(:'ws_dois'::uuid, 'pf', 'Contato A8 Dois', null, null, null)).id as contact_dois \gset
select create_lead(:'ws_dois'::uuid, (:'contact_dois')::uuid, 'Tributário', 'Lead A8 Dois', '{}'::text[], 'media', null) as lead_dois \gset
select create_opportunity(:'lead_dois'::uuid) as opp_dois \gset
select win_opportunity(:'opp_dois'::uuid, 0, 500000, 'fixed') as win_dois \gset
reset role;
select (:'win_dois'::jsonb ->> 'client_id') as client_dois \gset

-- ===================================================================
-- 1) get_opportunity()/list_opportunities() ganham client_id
-- ===================================================================

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'ana', 'role', 'authenticated')::text, true);
select (get_opportunity(:'opp_ana'::uuid) ->> 'client_id') as opp_ana_client_id \gset
select is((:'opp_ana_client_id')::uuid, (:'client_ana')::uuid, 'get_opportunity() traz o client_id da oportunidade ganha');

select items from list_opportunities(:'ws_um'::uuid, null, null, 'won', null, 'created_at_desc', 1, 20, :'lead_ana'::uuid) \gset lo_
select (:'lo_items'::jsonb -> 0 ->> 'client_id') as lo_client_id \gset
select is((:'lo_client_id')::uuid, (:'client_ana')::uuid, 'list_opportunities() também traz client_id por linha');

-- ===================================================================
-- 2) list_clients()/get_client() — alcance por registro (advogado)
-- ===================================================================

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'carla', 'role', 'authenticated')::text, true);
select throws_ok(
  format($i$ select get_client(%L::uuid) $i$, :'client_ana'),
  'P0001', 'client_not_found',
  'Advogado não enxerga cliente cuja ÚNICA oportunidade vinculada é de lead de outro responsável'
);
select lives_ok(
  format($i$ select get_client(%L::uuid) $i$, :'client_sem_resp'),
  'Advogado enxerga cliente com oportunidade de lead SEM responsável'
);

select items, total_count
  from list_clients(:'ws_um'::uuid) \gset lc_
select ok(
  (:'lc_items'::jsonb) @> format('[{"id": "%s"}]', :'client_sem_resp')::jsonb,
  'list_clients() do advogado inclui o cliente dentro do alcance'
);
select ok(
  not ((:'lc_items'::jsonb) @> format('[{"id": "%s"}]', :'client_ana')::jsonb),
  'list_clients() do advogado NÃO inclui o cliente fora do alcance'
);

-- Owner enxerga todos os dois, com valor financeiro exato.
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'ana', 'role', 'authenticated')::text, true);
select items as lco_owner_items from list_clients(:'ws_um'::uuid) \gset
select ok(
  (:'lco_owner_items'::jsonb) @> format('[{"id": "%s"}]', :'client_ana')::jsonb
    and (:'lco_owner_items'::jsonb) @> format('[{"id": "%s"}]', :'client_sem_resp')::jsonb,
  'Owner enxerga todos os clientes do workspace, sem filtro de alcance por registro'
);

select get_client(:'client_ana'::uuid) as client_ana_detail \gset
select ok(
  ((:'client_ana_detail'::jsonb -> 'history' -> 0) ? 'value_cents'),
  'Owner recebe valor_cents exato no histórico do cliente'
);
select is(
  (:'client_ana_detail'::jsonb ->> 'contact_name'), 'Contato A8 Ana',
  'get_client() traz o nome do contato'
);
select is(
  ((:'client_ana_detail'::jsonb -> 'history') -> 0 ->> 'opportunity_id'),
  :'opp_ana', 'history[0] traz a oportunidade que gerou o cliente'
);
select is(
  ((:'client_ana_detail'::jsonb -> 'origin') ->> 'opportunity_id'),
  :'opp_ana', 'origin (resolvida no servidor, achado da revisão) também aponta pra mesma oportunidade quando só existe uma'
);
select is(
  ((:'client_ana_detail'::jsonb -> 'history') -> 0 ->> 'handoff_status'), 'pendente',
  'Handoff do histórico começa pendente'
);
select is(
  ((:'client_ana_detail'::jsonb -> 'history') -> 0 ->> 'handoff_awaiting_integration')::boolean, true,
  'Handoff sem target_system é sinalizado como aguardando integração'
);
select ok(
  not ((:'client_ana_detail'::jsonb -> 'history' -> 0) ? 'payload'),
  'get_client() nunca expõe o payload bruto do handoff'
);
select ok(
  not ((:'client_ana_detail'::jsonb -> 'history' -> 0) ? 'last_error'),
  'get_client() nunca expõe last_error do handoff'
);
select is(
  (:'client_ana_detail'::jsonb ->> 'value_sum_cents')::bigint, 800000::bigint,
  'Owner recebe o total financeiro agregado (value_sum_cents)'
);

-- ===================================================================
-- 3) Viewer vê o cliente, mas sem NENHUM campo financeiro
-- ===================================================================

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'elisa', 'role', 'authenticated')::text, true);
select lives_ok(
  format($i$ select get_client(%L::uuid) $i$, :'client_ana'),
  'Viewer também enxerga o cliente (mesmo alcance de owner/admin/manager/sales, só a projeção financeira muda)'
);
select get_client(:'client_ana'::uuid) as client_ana_detail_v \gset
select ok(
  not ((:'client_ana_detail_v'::jsonb -> 'history' -> 0) ? 'value_cents'),
  'Viewer não recebe value_cents no histórico'
);
select ok(
  not ((:'client_ana_detail_v'::jsonb -> 'history' -> 0) ? 'value_band'),
  'Viewer não recebe nem a faixa de valor'
);
select ok(
  not ((:'client_ana_detail_v'::jsonb) ? 'value_sum_cents'),
  'Viewer não recebe o total agregado'
);

-- ===================================================================
-- 4) Sales (carla, ws_dois) — recebe a FAIXA, nunca o valor exato nem
-- o total agregado.
-- ===================================================================

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'carla', 'role', 'authenticated')::text, true);
select get_client(:'client_dois'::uuid) as client_dois_detail \gset
select ok(
  not ((:'client_dois_detail'::jsonb -> 'history' -> 0) ? 'value_cents'),
  'Sales não recebe value_cents exato'
);
select ok(
  ((:'client_dois_detail'::jsonb -> 'history' -> 0) ? 'value_band'),
  'Sales recebe a faixa de valor (value_band)'
);
select ok(
  not ((:'client_dois_detail'::jsonb) ? 'value_sum_cents'),
  'Sales não recebe o total agregado (nunca deriva estimativa de faixas)'
);

-- ===================================================================
-- 5) update_client_status — concorrência, permissão, reativação
-- conflitante
-- ===================================================================

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'elisa', 'role', 'authenticated')::text, true);
select throws_ok(
  format($i$ select update_client_status(%L::uuid, 'suspenso'::public.client_status, 0) $i$, :'client_ana'),
  'P0001', 'insufficient_permission',
  'Viewer não altera status de cliente'
);

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'carla', 'role', 'authenticated')::text, true);
select throws_ok(
  format($i$ select update_client_status(%L::uuid, 'suspenso'::public.client_status, 0) $i$, :'client_sem_resp'),
  'P0001', 'insufficient_permission',
  'Advogado não altera status de cliente, mesmo dentro do seu alcance de visualização'
);

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'ana', 'role', 'authenticated')::text, true);
select throws_ok(
  format($i$ select update_client_status(%L::uuid, 'suspenso'::public.client_status, 999) $i$, :'client_ana'),
  'P0001', 'client_conflict',
  'lock_version divergente é recusado como conflito tratado'
);
select lives_ok(
  format($i$ select update_client_status(%L::uuid, 'encerrado'::public.client_status, 0) $i$, :'client_sem_resp'),
  'Owner encerra o cliente com lock_version correto'
);

reset role;
select status::text as client_sem_resp_status_1, lock_version as client_sem_resp_lock_1
  from public.clients where id = (:'client_sem_resp')::uuid \gset
select is((:'client_sem_resp_status_1')::text, 'encerrado'::text, 'Status realmente muda para encerrado');
select is(:'client_sem_resp_lock_1'::int, 1, 'lock_version incrementa a cada mudança bem-sucedida');

-- Ganhar uma NOVA oportunidade do mesmo contato (que só tem cliente
-- encerrado) cria um cliente ATIVO novo — comportamento já vigente da
-- A5, documentado (não alterado) pelo item 4 do pedido da A8.
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'ana', 'role', 'authenticated')::text, true);
select create_lead(:'ws_um'::uuid, (:'contact_sem_resp')::uuid, 'Cível', 'Lead A8 Sem Resp 2', '{}'::text[], 'media', null) as lead_sem_resp_2 \gset
select create_opportunity(:'lead_sem_resp_2'::uuid) as opp_sem_resp_2 \gset
select win_opportunity(:'opp_sem_resp_2'::uuid, 0, 150000, 'fixed') as win_sem_resp_2 \gset
reset role;
select (:'win_sem_resp_2'::jsonb ->> 'client_id') as client_sem_resp_2 \gset
select ok(
  (:'client_sem_resp_2')::uuid <> (:'client_sem_resp')::uuid,
  'Contato só com cliente encerrado/suspenso: ganhar cria um NOVO cliente ativo, não reabre o antigo (regra A5 preservada)'
);
select is(
  (select count(*)::int from public.clients where workspace_id = :'ws_um'::uuid and contact_id = (:'contact_sem_resp')::uuid),
  2, 'Contato acumula dois registros de cliente (um encerrado, um ativo) — nenhum union automático'
);

-- Reativar o encerrado agora colide com o ativo novo.
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'ana', 'role', 'authenticated')::text, true);
select throws_ok(
  format($i$ select update_client_status(%L::uuid, 'ativo'::public.client_status, 1) $i$, :'client_sem_resp'),
  'P0001', 'active_client_conflict',
  'Reativar um cliente encerrado é recusado quando já existe outro cliente ativo para o mesmo contato — nunca mescla nem apaga'
);

-- ===================================================================
-- 6) transfer_client_owner
-- ===================================================================

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'elisa', 'role', 'authenticated')::text, true);
select throws_ok(
  format($i$ select transfer_client_owner(%L::uuid, 0, %L::uuid) $i$, :'client_ana', :'elisa'),
  'P0001', 'insufficient_permission',
  'Viewer não transfere responsável de cliente'
);

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'ana', 'role', 'authenticated')::text, true);
select throws_ok(
  format($i$ select transfer_client_owner(%L::uuid, 0, %L::uuid) $i$, :'client_ana', :'naomembro'),
  'P0001', 'assignee_not_a_member',
  'Não é possível transferir para quem não é membro ativo do workspace'
);
select lives_ok(
  format($i$ select transfer_client_owner(%L::uuid, 0, %L::uuid) $i$, :'client_ana', :'elisa'),
  'Owner transfere o responsável do cliente para outro membro ativo'
);
reset role;
select owner_user_id, lock_version from public.clients where id = (:'client_ana')::uuid \gset client_ana_
select is((:'client_ana_owner_user_id')::uuid, (:'elisa')::uuid, 'Responsável foi transferido de verdade');
select is(:'client_ana_lock_version'::int, 1, 'lock_version incrementa na transferência também');

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'ana', 'role', 'authenticated')::text, true);
select throws_ok(
  format($i$ select transfer_client_owner(%L::uuid, 0, %L::uuid) $i$, :'client_ana', :'ana'),
  'P0001', 'client_conflict',
  'lock_version divergente também é recusado na transferência de responsável'
);

-- ===================================================================
-- 7) Merge/undo de contatos integrando `clients` (A8)
-- ===================================================================

-- Os dois lados já têm cliente ATIVO — mesclar é recusado, sem
-- mesclar nem apagar nenhum dos dois cadastros de cliente.
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'ana', 'role', 'authenticated')::text, true);
select throws_ok(
  format($i$ select merge_contacts(%L::uuid, %L::uuid) $i$, :'contact_merge_vencedor', :'contact_merge_perdedor'),
  'P0001', 'client_merge_conflict_active_client',
  'Mesclar dois contatos que já têm, cada um, cliente ativo é recusado com erro tratado'
);

-- Encerra o cliente do contato perdedor — agora a mesclagem pode
-- reparentar sem colidir com o índice de "um ativo por contato".
select update_client_status(:'client_merge_perdedor'::uuid, 'encerrado'::public.client_status, 0);
select merge_contacts(:'contact_merge_vencedor'::uuid, :'contact_merge_perdedor'::uuid) as merge_result \gset

reset role;
select contact_id as client_merge_perdedor_contact_id
  from public.clients where id = (:'client_merge_perdedor')::uuid \gset
select is(
  (:'client_merge_perdedor_contact_id')::uuid, (:'contact_merge_vencedor')::uuid,
  'Cliente do contato perdedor é reparentado para o contato vencedor na mesclagem — vínculo não se perde'
);

select id as merge_id from public.contact_merges
  where merged_contact_id = (:'contact_merge_perdedor')::uuid
  order by merged_at desc limit 1 \gset

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'ana', 'role', 'authenticated')::text, true);
select unmerge_contact(:'merge_id'::uuid);

reset role;
select contact_id as client_merge_perdedor_contact_id_undo
  from public.clients where id = (:'client_merge_perdedor')::uuid \gset
select is(
  (:'client_merge_perdedor_contact_id_undo')::uuid, (:'contact_merge_perdedor')::uuid,
  'Desfazer a mesclagem restaura o vínculo do cliente ao contato original'
);

-- ===================================================================
-- 8) Paginação de list_clients()
-- ===================================================================

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'ana', 'role', 'authenticated')::text, true);
select total_count as lcp_page_total from list_clients(:'ws_um'::uuid, null, null, 'created_at_asc', 1, 1) \gset
select ok((:'lcp_page_total')::int >= 4, 'total_count reflete todos os clientes do workspace, não só a página pedida');

select items as lcp_page1_items from list_clients(:'ws_um'::uuid, null, null, 'created_at_asc', 1, 1) \gset
select items as lcp_page2_items from list_clients(:'ws_um'::uuid, null, null, 'created_at_asc', 2, 1) \gset
select is(jsonb_array_length((:'lcp_page1_items')::jsonb), 1, 'Página 1 com page_size=1 devolve exatamente 1 item');
select ok(
  ((:'lcp_page1_items')::jsonb -> 0 ->> 'id') <> ((:'lcp_page2_items')::jsonb -> 0 ->> 'id'),
  'Páginas diferentes trazem clientes diferentes — nenhum item repetido nem pulado'
);

-- ===================================================================
-- 9) Origem correta quando o histórico é filtrado por alcance
-- (achado 2 da revisão pré-merge): a segunda oportunidade GANHA do
-- MESMO contato_ana reaproveita o cliente ativo já existente
-- (client_ana). Ela é atribuída a NINGUÉM (dentro do alcance do
-- advogado), enquanto a primeira (opp_ana) é atribuída à ana (fora do
-- alcance de carla). Para o advogado, o histórico deve mostrar só a
-- segunda — mas ela NUNCA pode aparecer como origin, porque a origem
-- de verdade (opp_ana) está fora do seu alcance.
-- ===================================================================

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'ana', 'role', 'authenticated')::text, true);
select create_lead(:'ws_um'::uuid, (:'contact_ana')::uuid, 'Trabalhista', 'Lead A8 Ana Segunda Oportunidade', '{}'::text[], 'media', null) as lead_ana_2 \gset
select create_opportunity(:'lead_ana_2'::uuid) as opp_ana_2 \gset
select win_opportunity(:'opp_ana_2'::uuid, 0, 400000, 'fixed') as win_ana_2 \gset
reset role;
select (:'win_ana_2'::jsonb ->> 'client_id') as client_ana_2_check \gset
select is(
  (:'client_ana_2_check')::uuid, (:'client_ana')::uuid,
  'Segunda oportunidade do mesmo contato reaproveita o MESMO cliente ativo (setup do teste de origem)'
);

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'carla', 'role', 'authenticated')::text, true);
select lives_ok(
  format($i$ select get_client(%L::uuid) $i$, :'client_ana'),
  'Advogado agora acessa o cliente — a segunda oportunidade está dentro do seu alcance'
);
select get_client(:'client_ana'::uuid) as client_ana_detail_lawyer \gset
select is(
  jsonb_array_length((:'client_ana_detail_lawyer'::jsonb -> 'history')), 1,
  'Histórico do advogado mostra só a oportunidade dentro do alcance — a de fora continua oculta'
);
select is(
  ((:'client_ana_detail_lawyer'::jsonb -> 'history') -> 0 ->> 'opportunity_id'), :'opp_ana_2',
  'A única oportunidade visível no histórico do advogado é a segunda, não a origem real'
);
select is(
  jsonb_typeof((:'client_ana_detail_lawyer'::jsonb -> 'origin')), 'null',
  'Origem é OMITIDA (jsonb null) para o advogado — a oportunidade de origem real está fora do seu alcance e NUNCA é substituída pela segunda (achado 2 da revisão)'
);

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'ana', 'role', 'authenticated')::text, true);
select get_client(:'client_ana'::uuid) as client_ana_detail_owner_origin \gset
select is(
  ((:'client_ana_detail_owner_origin'::jsonb -> 'origin') ->> 'opportunity_id'), :'opp_ana',
  'Owner vê a origem correta (a PRIMEIRA oportunidade), nunca a segunda, mesmo com dois itens no histórico'
);
select is(
  jsonb_array_length((:'client_ana_detail_owner_origin'::jsonb -> 'history')), 2,
  'Owner vê as DUAS oportunidades no histórico — sem filtro de alcance'
);

-- ===================================================================
-- 10) Cliente sem NENHUM handoff vinculado (alcance indeterminável) —
-- restrito à administração (owner/admin/manager); lawyer/sales/viewer
-- não enxergam mais (achado 1 da revisão pré-merge — antes só 'lawyer'
-- era restrito nesse caso).
-- ===================================================================

reset role;
insert into public.clients (workspace_id, contact_id, status)
values (:'ws_um'::uuid, (:'contact_sem_handoff')::uuid, 'suspenso')
returning id as client_sem_handoff \gset

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'ana', 'role', 'authenticated')::text, true);
select lives_ok(
  format($i$ select get_client(%L::uuid) $i$, :'client_sem_handoff'),
  'Owner acessa cliente sem NENHUM handoff vinculado (alcance indeterminável, acesso administrativo mantido)'
);
select items as ch_owner_items from list_clients(:'ws_um'::uuid) \gset
select ok(
  (:'ch_owner_items'::jsonb) @> format('[{"id": "%s"}]', :'client_sem_handoff')::jsonb,
  'Owner também vê esse cliente na listagem'
);

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'carla', 'role', 'authenticated')::text, true);
select throws_ok(
  format($i$ select get_client(%L::uuid) $i$, :'client_sem_handoff'),
  'P0001', 'client_not_found',
  'Lawyer NÃO acessa cliente sem nenhum handoff vinculado'
);
select items as ch_lawyer_items from list_clients(:'ws_um'::uuid) \gset
select ok(
  not ((:'ch_lawyer_items'::jsonb) @> format('[{"id": "%s"}]', :'client_sem_handoff')::jsonb),
  'Lawyer não vê esse cliente na listagem'
);

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'elisa', 'role', 'authenticated')::text, true);
select throws_ok(
  format($i$ select get_client(%L::uuid) $i$, :'client_sem_handoff'),
  'P0001', 'client_not_found',
  'Viewer NÃO acessa cliente sem nenhum handoff vinculado (achado 1 da revisão — antes ficava visível)'
);
select items as ch_viewer_items from list_clients(:'ws_um'::uuid) \gset
select ok(
  not ((:'ch_viewer_items'::jsonb) @> format('[{"id": "%s"}]', :'client_sem_handoff')::jsonb),
  'Viewer não vê esse cliente na listagem (achado 1 da revisão — antes ficava visível)'
);

-- Promove elisa temporariamente (sales → manager → admin) só para
-- exercitar os seis papéis contra o MESMO cliente sem handoff; devolvida
-- a 'viewer' (seu papel real no seed) ao final desta seção.
reset role;
update public.memberships set role = 'sales' where workspace_id = :'ws_um'::uuid and user_id = :'elisa'::uuid;
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'elisa', 'role', 'authenticated')::text, true);
select throws_ok(
  format($i$ select get_client(%L::uuid) $i$, :'client_sem_handoff'),
  'P0001', 'client_not_found',
  'Sales NÃO acessa cliente sem nenhum handoff vinculado (achado 1 da revisão)'
);

reset role;
update public.memberships set role = 'manager' where workspace_id = :'ws_um'::uuid and user_id = :'elisa'::uuid;
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'elisa', 'role', 'authenticated')::text, true);
select lives_ok(
  format($i$ select get_client(%L::uuid) $i$, :'client_sem_handoff'),
  'Manager acessa cliente sem nenhum handoff vinculado (papel administrativo)'
);

reset role;
update public.memberships set role = 'admin' where workspace_id = :'ws_um'::uuid and user_id = :'elisa'::uuid;
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'elisa', 'role', 'authenticated')::text, true);
select lives_ok(
  format($i$ select get_client(%L::uuid) $i$, :'client_sem_handoff'),
  'Admin acessa cliente sem nenhum handoff vinculado (papel administrativo)'
);

reset role;
update public.memberships set role = 'viewer' where workspace_id = :'ws_um'::uuid and user_id = :'elisa'::uuid;

-- ===================================================================
-- 11) Isolamento entre workspaces
-- ===================================================================

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'bruno', 'role', 'authenticated')::text, true);
select throws_ok(
  format($i$ select get_client(%L::uuid) $i$, :'client_ana'),
  'P0001', 'insufficient_permission',
  'Owner de OUTRO workspace não acessa cliente que não é do seu workspace'
);

select * from finish();
