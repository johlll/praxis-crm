-- pgTAP — A5: pipeline e oportunidades.
--
-- Fixtures do seed (supabase/seed.sql): ana=owner/carla=lawyer/
-- elisa=viewer no Escritório Um; bruno=owner/carla=sales no Escritório
-- Dois. O pipeline padrão de cada workspace vem do backfill da migration
-- de schema (20260910120000) — não é criado aqui.
--
-- Disciplina do arquivo (mesma da A4): `request.jwt.claims` é escopo de
-- TRANSAÇÃO — todo bloco reafirma o papel do Postgres E o claim antes de
-- cada chamada, nunca confia em estado deixado por um bloco anterior.

begin;
select plan(64);

\set ws_um   '10000000-0000-0000-0000-000000000001'
\set ws_dois '10000000-0000-0000-0000-000000000002'
\set ana     '20000000-0000-0000-0000-000000000001'
\set bruno   '20000000-0000-0000-0000-000000000002'
\set carla   '20000000-0000-0000-0000-000000000003'
\set elisa   '20000000-0000-0000-0000-000000000005'

-- -----------------------------------------------------------------
-- Setup: pipeline padrão de cada workspace (criado pelo backfill),
-- contatos e leads de apoio.
-- -----------------------------------------------------------------

reset role;
select id as pipe_um from public.pipelines where workspace_id = :'ws_um'::uuid and is_default \gset
select id as pipe_dois from public.pipelines where workspace_id = :'ws_dois'::uuid and is_default \gset

select id as stage_um_0 from public.pipeline_stages where pipeline_id = :'pipe_um'::uuid and position = 0 \gset
select id as stage_um_1 from public.pipeline_stages where pipeline_id = :'pipe_um'::uuid and position = 1 \gset
select id as stage_um_2 from public.pipeline_stages where pipeline_id = :'pipe_um'::uuid and position = 2 \gset
select id as stage_um_3 from public.pipeline_stages where pipeline_id = :'pipe_um'::uuid and position = 3 \gset

select id as reason_um from public.lost_reasons where workspace_id = :'ws_um'::uuid order by position limit 1 \gset
select id as reason_dois from public.lost_reasons where workspace_id = :'ws_dois'::uuid order by position limit 1 \gset

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'ana', 'role', 'authenticated')::text, true);
select (create_contact(:'ws_um'::uuid, 'pf', 'Contato A5 Ana', null, null, null)).id as contact_ana \gset
select (create_contact(:'ws_um'::uuid, 'pf', 'Contato A5 Sem Resp', null, null, null)).id as contact_sem_resp \gset
select (create_contact(:'ws_um'::uuid, 'pf', 'Contato A5 Merge Vencedor', null, null, null)).id as contact_merge_vencedor \gset
select (create_contact(:'ws_um'::uuid, 'pf', 'Contato A5 Merge Perdedor', null, null, null)).id as contact_merge_perdedor \gset
select create_lead(:'ws_um'::uuid, (:'contact_ana')::uuid, 'Trabalhista', 'Lead A5 Ana', '{}'::text[], 'media', :'ana'::uuid) as lead_ana \gset
select create_lead(:'ws_um'::uuid, (:'contact_ana')::uuid, 'Trabalhista', 'Lead A5 Ana Dois', '{}'::text[], 'media', :'ana'::uuid) as lead_ana_dois \gset
select create_lead(:'ws_um'::uuid, (:'contact_sem_resp')::uuid, 'Cível', 'Lead A5 Sem Responsável', '{}'::text[], 'media', null) as lead_sem_resp \gset
select create_lead(:'ws_um'::uuid, (:'contact_merge_perdedor')::uuid, 'Família', 'Lead A5 Merge', '{}'::text[], 'media', null) as lead_merge \gset

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'bruno', 'role', 'authenticated')::text, true);
select (create_contact(:'ws_dois'::uuid, 'pf', 'Contato A5 Dois', null, null, null)).id as contact_dois \gset
select create_lead(:'ws_dois'::uuid, (:'contact_dois')::uuid, 'Tributário', 'Lead A5 Dois', '{}'::text[], 'media', null) as lead_dois \gset

-- ===================================================================
-- 1) Pipeline padrão por workspace
-- ===================================================================

reset role;
select is(
  (select count(*)::int from public.pipeline_stages where pipeline_id = :'pipe_um'::uuid),
  8, 'Pipeline padrão do workspace nasce com as 8 etapas do protótipo aprovado'
);
select is(
  (select name from public.pipeline_stages where id = (:'stage_um_0')::uuid),
  'Fazer primeiro contato', 'Primeira etapa tem o nome exato do protótipo'
);
select is(
  (select count(*)::int from public.lost_reasons where workspace_id = :'ws_um'::uuid),
  5, 'Motivos de perda padrão (5) criados por workspace'
);

-- ===================================================================
-- 2) Vínculos e integridade entre entidades
-- ===================================================================

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'ana', 'role', 'authenticated')::text, true);
select create_opportunity(:'lead_ana'::uuid) as opp_ana \gset
select ok(:'opp_ana' is not null, 'create_opportunity() sem pipeline/etapa explícitos usa o padrão e a primeira etapa');

reset role;
select is(
  (select stage_id from public.opportunities where id = (:'opp_ana')::uuid),
  (:'stage_um_0')::uuid, 'Oportunidade nasce na primeira etapa do pipeline padrão'
);

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'ana', 'role', 'authenticated')::text, true);
select throws_ok(
  format($i$ select create_opportunity(%L::uuid, %L::uuid) $i$, :'lead_ana', :'pipe_dois'),
  'P0001', 'pipeline_not_found',
  'Pipeline de outro workspace não é aceito, mesmo que o lead seja válido'
);

-- Pipeline extra "manual" no mesmo workspace, só para provar a FK
-- composta (pipeline_id, stage_id): uma etapa desse segundo pipeline não
-- pode ser usada com o pipeline padrão.
reset role;
insert into public.pipelines (workspace_id, name, is_default, created_by)
values (:'ws_um'::uuid, 'Extra Teste', false, :'ana'::uuid)
returning id as pipe_extra \gset
insert into public.pipeline_stages (workspace_id, pipeline_id, name, position)
values (:'ws_um'::uuid, :'pipe_extra'::uuid, 'Etapa Extra', 0)
returning id as stage_extra \gset

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'ana', 'role', 'authenticated')::text, true);
select throws_ok(
  format($i$ select create_opportunity(%L::uuid, %L::uuid, %L::uuid) $i$, :'lead_ana', :'pipe_um', :'stage_extra'),
  'P0001', 'stage_not_in_pipeline',
  'Etapa que pertence a OUTRO pipeline do mesmo workspace é recusada — a etapa precisa pertencer ao pipeline escolhido'
);

-- ===================================================================
-- 3) Alcance de leitura e escrita (advogado — herdado do lead pai)
-- ===================================================================

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'ana', 'role', 'authenticated')::text, true);
select create_opportunity(:'lead_sem_resp'::uuid) as opp_sem_resp \gset

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'carla', 'role', 'authenticated')::text, true);
select throws_ok(
  format($i$ select get_opportunity(%L::uuid) $i$, :'opp_ana'),
  'P0001', 'opportunity_not_found',
  'Advogado não enxerga oportunidade de lead de outro responsável (não revela nem que existe)'
);
select lives_ok(
  format($i$ select get_opportunity(%L::uuid) $i$, :'opp_sem_resp'),
  'Advogado enxerga oportunidade de lead SEM responsável'
);

reset role;
select id as opp_ana_stage0 from public.opportunities where id = (:'opp_ana')::uuid \gset
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'carla', 'role', 'authenticated')::text, true);
select throws_ok(
  format(
    $i$ select move_opportunity_stage(%L::uuid, %L::uuid, %L::uuid, 0) $i$,
    :'opp_ana', :'stage_um_0', :'stage_um_1'
  ),
  'P0001', 'opportunity_not_found',
  'Advogado não move oportunidade de lead de outro responsável via RPC direta'
);

reset role;
select assigned_to from public.leads where id = (:'lead_ana')::uuid \gset lead_ana_
select is((:'lead_ana_assigned_to')::uuid, (:'ana')::uuid, 'Dado preservado: tentativa fora do alcance não alterou o responsável do lead');

-- ===================================================================
-- 4) Requisitos de avanço — bloqueio no servidor, pular colunas não
--    contorna requisito de etapa intermediária.
-- ===================================================================

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'ana', 'role', 'authenticated')::text, true);
select create_stage_requirement(:'stage_um_2'::uuid, 'Conflito verificado', 'checkbox') as req_checkbox \gset
select create_stage_requirement(:'stage_um_3'::uuid, 'Data da consulta', 'date') as req_data \gset

select throws_ok(
  format(
    $i$ select move_opportunity_stage(%L::uuid, %L::uuid, %L::uuid, 0) $i$,
    :'opp_ana', :'stage_um_0', :'stage_um_3'
  ),
  'P0001', 'stage_requirements_pending',
  'Pular direto da etapa 1 para a 4 é recusado — requisitos das etapas 3 e 4 no caminho não estão preenchidos'
);

reset role;
select lock_version from public.opportunities where id = (:'opp_ana')::uuid \gset opp_ana_
select is((:'opp_ana_lock_version')::bigint, 0::bigint, 'lock_version não mudou na tentativa recusada — nenhum efeito parcial');

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'ana', 'role', 'authenticated')::text, true);
select lives_ok(
  format(
    $i$ select move_opportunity_stage(%L::uuid, %L::uuid, %L::uuid, 0, %L::jsonb) $i$,
    :'opp_ana', :'stage_um_0', :'stage_um_3',
    json_build_array(
      json_build_object('requirement_id', :'req_checkbox', 'value_bool', true),
      json_build_object('requirement_id', :'req_data', 'value_text', '2026-10-01')
    )::text
  ),
  'Preenchendo os requisitos de TODAS as etapas no caminho, avançar direto da 1 para a 4 funciona'
);

reset role;
select stage_id from public.opportunities where id = (:'opp_ana')::uuid \gset opp_ana_
select is((:'opp_ana_stage_id')::uuid, (:'stage_um_3')::uuid, 'Oportunidade está de fato na etapa 4 após o avanço');
select is(
  (select count(*)::int from public.stage_transitions where opportunity_id = (:'opp_ana')::uuid),
  1, 'Exatamente uma transição registrada no histórico (append-only) para este movimento'
);

-- Voltar nunca exige requisito, mesmo que a etapa de origem os tenha.
reset role;
select lock_version from public.opportunities where id = (:'opp_ana')::uuid \gset opp_ana_
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'ana', 'role', 'authenticated')::text, true);
select lives_ok(
  format(
    $i$ select move_opportunity_stage(%L::uuid, %L::uuid, %L::uuid, %s) $i$,
    :'opp_ana', :'stage_um_3', :'stage_um_0', :'opp_ana_lock_version'
  ),
  'Retroceder da etapa 4 para a 1 nunca exige requisito'
);

-- ===================================================================
-- 5) Concorrência e mensagens de erro específicas
-- ===================================================================

reset role;
select lock_version from public.opportunities where id = (:'opp_ana')::uuid \gset opp_ana_
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'ana', 'role', 'authenticated')::text, true);
select throws_ok(
  format(
    $i$ select move_opportunity_stage(%L::uuid, %L::uuid, %L::uuid, %s) $i$,
    :'opp_ana', :'stage_um_0', :'stage_um_1', (:'opp_ana_lock_version')::bigint + 1
  ),
  'P0001', 'opportunity_conflict',
  'lock_version incorreto é recusado com mensagem específica de conflito'
);
select throws_ok(
  format(
    $i$ select move_opportunity_stage(%L::uuid, %L::uuid, %L::uuid, %s) $i$,
    :'opp_ana', :'stage_um_1', :'stage_um_2', :'opp_ana_lock_version'
  ),
  'P0001', 'stage_mismatch',
  'Etapa de origem informada errada (a real é a 0, não a 1) é recusada antes mesmo de checar lock_version'
);
select lives_ok(
  format(
    $i$ select move_opportunity_stage(%L::uuid, %L::uuid, %L::uuid, %s) $i$,
    :'opp_ana', :'stage_um_0', :'stage_um_1', :'opp_ana_lock_version'
  ),
  'Etapa de origem e lock_version corretos: movimento aceito'
);
reset role;
select lock_version from public.opportunities where id = (:'opp_ana')::uuid \gset opp_ana_novo_
select is(
  (:'opp_ana_novo_lock_version')::bigint, (:'opp_ana_lock_version')::bigint + 1,
  'lock_version incrementado exatamente em 1 pelo movimento aceito'
);

-- ===================================================================
-- 6) Ganho, perda e idempotência
-- ===================================================================

reset role;
select lock_version from public.opportunities where id = (:'opp_sem_resp')::uuid \gset opp_sem_resp_
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'ana', 'role', 'authenticated')::text, true);
select win_opportunity(:'opp_sem_resp'::uuid, (:'opp_sem_resp_lock_version')::bigint, 550000, 'fixed', '2026-10-05') as win_result \gset

reset role;
select (:'win_result'::jsonb ->> 'client_id') as client_id_1 \gset
select status from public.opportunities where id = (:'opp_sem_resp')::uuid \gset opp_sem_resp_
select is((:'opp_sem_resp_status')::text, 'won'::text, 'Oportunidade fica com status won');
select is(
  (select status::text from public.clients where id = (:'client_id_1')::uuid),
  'ativo', 'Cliente criado com status ativo ao ganhar'
);
select is(
  (select status::text from public.client_handoffs where opportunity_id = (:'opp_sem_resp')::uuid),
  'pendente', 'Handoff criado com status pendente (sem integração real, tela avisa)'
);

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'ana', 'role', 'authenticated')::text, true);
select throws_ok(
  format(
    $i$ select win_opportunity(%L::uuid, 0, 999900, 'fixed') $i$, :'opp_sem_resp'
  ),
  'P0001', 'opportunity_conflict',
  'Ganhar de novo uma oportunidade já ganha é recusado — não é possível duplicar client/handoff'
);

reset role;
select is(
  (select count(*)::int from public.client_handoffs where opportunity_id = (:'opp_sem_resp')::uuid),
  1, 'Ainda existe exatamente UM handoff para esta oportunidade após a tentativa repetida'
);

-- Segunda oportunidade do MESMO contato, ao ganhar, reaproveita o
-- cliente ativo já existente (não cria um segundo).
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'ana', 'role', 'authenticated')::text, true);
select create_opportunity(:'lead_ana_dois'::uuid) as opp_ana_dois \gset
reset role;
update public.leads set contact_id = (:'contact_sem_resp')::uuid where id = (:'lead_ana_dois')::uuid;
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'ana', 'role', 'authenticated')::text, true);
select win_opportunity(:'opp_ana_dois'::uuid, 0, 200000, 'contingency') as win_result_2 \gset
reset role;
select (:'win_result_2'::jsonb ->> 'client_id') as client_id_2 \gset
select is((:'client_id_2')::uuid, (:'client_id_1')::uuid, 'Segunda oportunidade do mesmo contato reaproveita o cliente ativo já existente, não duplica');
select is(
  (select count(*)::int from public.clients where workspace_id = :'ws_um'::uuid and contact_id = (:'contact_sem_resp')::uuid),
  1, 'Continua existindo exatamente um cliente ativo para este contato'
);

-- Perda: motivo precisa ser do MESMO workspace e estar ativo.
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'ana', 'role', 'authenticated')::text, true);
select create_opportunity(:'lead_merge'::uuid) as opp_merge \gset
select throws_ok(
  format(
    $i$ select lose_opportunity(%L::uuid, 0, %L::uuid) $i$, :'opp_merge', :'reason_dois'
  ),
  'P0001', 'invalid_lost_reason',
  'Motivo de perda de OUTRO workspace é recusado'
);
select lives_ok(
  format(
    $i$ select lose_opportunity(%L::uuid, 0, %L::uuid, 'sem verba', '2026-11-01'::date) $i$, :'opp_merge', :'reason_um'
  ),
  'Motivo válido do próprio workspace é aceito'
);
reset role;
select status from public.opportunities where id = (:'opp_merge')::uuid \gset opp_merge_
select is((:'opp_merge_status')::text, 'lost'::text, 'Oportunidade fica com status lost');

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'ana', 'role', 'authenticated')::text, true);
select throws_ok(
  format($i$ select win_opportunity(%L::uuid, 1, 100000, 'fixed') $i$, :'opp_merge'),
  'P0001', 'opportunity_conflict',
  'Não é possível ganhar uma oportunidade já perdida'
);

-- ===================================================================
-- 7) Projeção financeira por papel — detalhe, board e agregados
-- ===================================================================

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'bruno', 'role', 'authenticated')::text, true);
select create_opportunity(:'lead_dois'::uuid, null::uuid, null::uuid, 5000000::bigint, 'fixed'::public.fee_model, 60::smallint) as opp_dois \gset
select (get_opportunity(:'opp_dois'::uuid) ? 'value_cents') as owner_ve_exato \gset
select ok(:'owner_ve_exato'::boolean, 'owner vê a chave value_cents (exata)');

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'carla', 'role', 'authenticated')::text, true);
select get_opportunity(:'opp_dois'::uuid) as opp_dois_as_sales \gset
select ok(
  not (:'opp_dois_as_sales'::jsonb ? 'value_cents'),
  'sales NUNCA recebe a chave value_cents, mesmo dentro do seu alcance'
);
select ok((:'opp_dois_as_sales'::jsonb ? 'value_band'), 'sales recebe a faixa (value_band) no lugar do valor exato');

select get_pipeline_board(:'pipe_dois'::uuid) as board_as_sales \gset
select ok(
  not ((:'board_as_sales'::jsonb -> 0) ? 'value_sum_cents'),
  'sales não recebe soma de coluna nenhuma — nem exata nem derivada de faixas'
);
select ok(
  not ((:'board_as_sales'::jsonb -> 0 -> 'cards' -> 0) ? 'value_cents'),
  'Card individual no board também nunca expõe value_cents para sales'
);

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'bruno', 'role', 'authenticated')::text, true);
select get_pipeline_board(:'pipe_dois'::uuid) as board_as_owner \gset
select is(
  ((:'board_as_owner'::jsonb -> 0 ->> 'value_sum_cents'))::bigint, 5000000::bigint,
  'owner vê a soma exata da coluna, batendo com o valor real da única oportunidade nela'
);

-- viewer: nenhuma chave financeira, em nenhum caminho.
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'ana', 'role', 'authenticated')::text, true);
select create_opportunity(:'lead_sem_resp'::uuid, null::uuid, null::uuid, 300000::bigint, 'fixed'::public.fee_model) as opp_viewer_alvo \gset

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'elisa', 'role', 'authenticated')::text, true);
select get_opportunity(:'opp_viewer_alvo'::uuid) as opp_as_viewer \gset
select ok(
  not (:'opp_as_viewer'::jsonb ? 'value_cents') and not (:'opp_as_viewer'::jsonb ? 'value_band'),
  'viewer não recebe NENHUMA chave financeira — nem exata, nem faixa'
);

-- ===================================================================
-- 8) Integração com leads e mesclagem/reversão de contatos
-- ===================================================================

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'ana', 'role', 'authenticated')::text, true);
select create_opportunity(:'lead_merge'::uuid, null::uuid, null::uuid) as opp_para_merge \gset
select (get_opportunity(:'opp_para_merge'::uuid) ->> 'contact_name') as nome_antes_merge \gset
select is((:'nome_antes_merge')::text, 'Contato A5 Merge Perdedor'::text, 'Antes da mesclagem, a oportunidade mostra o nome do contato original');

select (merge_contacts((:'contact_merge_vencedor')::uuid, (:'contact_merge_perdedor')::uuid)).id as merge_kept \gset
reset role;
select id from public.contact_merges
  where kept_contact_id = (:'contact_merge_vencedor')::uuid and merged_contact_id = (:'contact_merge_perdedor')::uuid
  order by merged_at desc limit 1
\gset merge_

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'ana', 'role', 'authenticated')::text, true);
select (get_opportunity(:'opp_para_merge'::uuid) ->> 'contact_name') as nome_depois_merge \gset
select is((:'nome_depois_merge')::text, 'Contato A5 Merge Vencedor'::text, 'Depois da mesclagem, a oportunidade (via lead) segue o contato vencedor — sem tocar a oportunidade diretamente');

select lives_ok(
  format($i$ select unmerge_contact(%L::uuid) $i$, :'merge_id'),
  'Desfazer a mesclagem funciona'
);
select (get_opportunity(:'opp_para_merge'::uuid) ->> 'contact_name') as nome_apos_undo \gset
select is((:'nome_apos_undo')::text, 'Contato A5 Merge Perdedor'::text, 'Depois do desfazer, a oportunidade volta a mostrar o contato original');

-- ===================================================================
-- 9) RLS forçada e grants exatos
-- ===================================================================

reset role;
select is(
  has_table_privilege('authenticated', 'public.opportunities', 'SELECT'), false,
  'authenticated não tem SELECT direto em opportunities — só via RPC'
);
select is(
  has_table_privilege('authenticated', 'public.opportunities', 'INSERT'), false,
  'authenticated não tem INSERT direto em opportunities'
);
select is(
  has_table_privilege('authenticated', 'public.clients', 'SELECT'), false,
  'authenticated não tem SELECT direto em clients — só via RPC (win_opportunity)'
);
select is(
  has_table_privilege('authenticated', 'public.client_handoffs', 'SELECT'), false,
  'authenticated não tem SELECT direto em client_handoffs'
);
select is(
  has_table_privilege('authenticated', 'public.pipelines', 'SELECT'), true,
  'authenticated TEM select direto em pipelines (configuração, não sensível — RLS filtra por workspace)'
);
select is(
  has_table_privilege('authenticated', 'public.pipelines', 'INSERT'), false,
  'authenticated não tem INSERT direto em pipelines — mutação só via função de configuração'
);
select is(
  has_function_privilege('authenticated', 'public.move_opportunity_stage(uuid, uuid, uuid, bigint, jsonb)', 'EXECUTE'),
  true, 'authenticated pode chamar move_opportunity_stage'
);
select is(
  has_function_privilege('authenticated', 'public.create_pipeline_stage(uuid, text, text, integer)', 'EXECUTE'),
  true, 'authenticated pode chamar create_pipeline_stage (a checagem de owner/admin/manager é DENTRO da função)'
);

-- Etapa ocupada não pode ser excluída; motivo de perda em uso não é
-- excluído, só desativado.
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'ana', 'role', 'authenticated')::text, true);
select throws_ok(
  format($i$ select delete_pipeline_stage(%L::uuid) $i$, :'stage_um_0'),
  'P0001', 'stage_occupied',
  'Etapa com oportunidade vinculada (mesmo histórica) não pode ser excluída'
);
select lives_ok(
  format($i$ select deactivate_lost_reason(%L::uuid) $i$, :'reason_um'),
  'Motivo de perda em uso é desativado sem erro (não removido)'
);
reset role;
select is(
  (select active from public.lost_reasons where id = (:'reason_um')::uuid), false,
  'Motivo de perda desativado — a linha continua existindo, referenciada pela oportunidade perdida'
);
select is(
  (select count(*)::int from public.lost_reasons where workspace_id = :'ws_um'::uuid),
  5, 'Nenhum motivo de perda foi excluído — desativar preserva a linha'
);

-- ===================================================================
-- 10) Etapa terminal (is_won/is_lost) — move_opportunity_stage() não
--     pode contornar ganhar/perder por ação própria. Achado na revisão
--     pós-A5: o servidor recusava marcar uma etapa OCUPADA como
--     terminal, mas não recusava o espelho — ocupar uma etapa JÁ
--     terminal. Corrigido em 20260910130000; testado aqui.
-- ===================================================================

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'ana', 'role', 'authenticated')::text, true);
select create_pipeline_stage(:'pipe_um'::uuid, 'Etapa terminal (ganho) — teste') as stage_terminal_won \gset
select update_pipeline_stage(:'stage_terminal_won'::uuid, null, null, true, null);
select create_pipeline_stage(:'pipe_um'::uuid, 'Etapa terminal (perda) — teste') as stage_terminal_lost \gset
select update_pipeline_stage(:'stage_terminal_lost'::uuid, null, null, null, true);

select (create_contact(:'ws_um'::uuid, 'pf', 'Contato A5 Terminal', null, null, null)).id as contact_terminal \gset
select create_lead(:'ws_um'::uuid, (:'contact_terminal')::uuid, 'Cível', 'Lead A5 Terminal', '{}'::text[], 'media', :'ana'::uuid) as lead_terminal \gset
select create_opportunity(:'lead_terminal'::uuid) as opp_terminal \gset
select create_opportunity(:'lead_terminal'::uuid) as opp_terminal_2 \gset

select throws_ok(
  format(
    $i$ select move_opportunity_stage(%L::uuid, %L::uuid, %L::uuid, 0) $i$,
    :'opp_terminal', :'stage_um_0', :'stage_terminal_won'
  ),
  'P0001', 'stage_is_terminal',
  'Mover oportunidade ABERTA para etapa marcada is_won é recusado — ganhar é uma ação própria, não um destino de move'
);

reset role;
select lock_version, stage_id from public.opportunities where id = (:'opp_terminal')::uuid \gset opp_terminal_
select is((:'opp_terminal_lock_version')::bigint, 0::bigint, 'lock_version não mudou na tentativa recusada de ocupar etapa terminal');
select is((:'opp_terminal_stage_id')::uuid, (:'stage_um_0')::uuid, 'Oportunidade continua na etapa original — sem efeito parcial');

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'ana', 'role', 'authenticated')::text, true);
select lives_ok(
  format(
    $i$ select move_opportunity_stage(%L::uuid, %L::uuid, %L::uuid, 0) $i$,
    :'opp_terminal', :'stage_um_0', :'stage_um_1'
  ),
  'Sem regressão: mover para uma etapa NORMAL (não terminal) continua funcionando'
);

select throws_ok(
  format(
    $i$ select move_opportunity_stage(%L::uuid, %L::uuid, %L::uuid, 0) $i$,
    :'opp_terminal_2', :'stage_um_0', :'stage_terminal_lost'
  ),
  'P0001', 'stage_is_terminal',
  'Mesmo bloqueio para etapa marcada is_lost — perder também é ação própria'
);

-- Espelho: agora que stage_um_1 tem uma oportunidade aberta (opp_terminal,
-- movido acima), marcá-la como terminal continua recusado — a proteção
-- já existente de update_pipeline_stage() não foi afetada pela correção.
select throws_ok(
  format($i$ select update_pipeline_stage(%L::uuid, null, null, true, null) $i$, :'stage_um_1'),
  'P0001', 'stage_has_open_opportunities',
  'update_pipeline_stage() continua recusando marcar como terminal uma etapa OCUPADA (proteção já existente, não afetada por esta correção)'
);

-- Enviar requirement_values junto não contorna o bloqueio — a checagem
-- de etapa terminal vale independente do que mais vier na chamada.
select throws_ok(
  format(
    $i$ select move_opportunity_stage(%L::uuid, %L::uuid, %L::uuid, 0, %L::jsonb) $i$,
    :'opp_terminal_2', :'stage_um_0', :'stage_terminal_won',
    json_build_array(json_build_object('requirement_id', gen_random_uuid()::text, 'value_bool', true))::text
  ),
  'P0001', 'stage_is_terminal',
  'Bloqueio de etapa terminal vale mesmo com requirement_values na mesma chamada'
);

reset role;
select is(
  (select is_won from public.pipeline_stages where id = (:'stage_terminal_won')::uuid), true,
  'Etapa de teste continua marcada is_won — nada reverteu a configuração'
);
select is(
  (select count(*)::int from public.opportunities where stage_id = (:'stage_terminal_won')::uuid), 0,
  'Nenhuma oportunidade ficou na etapa terminal apesar das tentativas — todas foram recusadas de verdade'
);

select * from finish();
rollback;
