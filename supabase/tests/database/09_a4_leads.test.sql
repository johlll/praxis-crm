-- pgTAP — A4: leads (CRUD, vínculo com contato no mesmo workspace,
-- permissões por papel — leitura E escrita —, concorrência atômica,
-- integração com merge/undo de contatos, RLS/grants exatos). Fixtures do
-- seed (supabase/seed.sql): ana=owner/carla=lawyer/elisa=viewer no
-- Escritório Um; bruno=owner do Escritório Dois (usado para o teste de
-- isolamento entre workspaces, seção 10).
--
-- Revisão pós-commit 1c6e753 (antes do merge do PR #4) — três correções
-- cobertas aqui:
--   1) alcance "seus + sem responsável" do advogado agora vale também
--      para update_lead_basic_fields/assign_lead/set_lead_status, não só
--      leitura (seção 8);
--   2) a versão esperada (p_expected_updated_at) passa a ser obrigatória
--      nas três funções de edição, e a checagem é atômica — parte do
--      próprio WHERE do UPDATE, não um SELECT+comparar separado (seção
--      3). pgTAP roda numa sessão só, então NÃO prova duas transações
--      concorrentes de verdade — isso é o teste e2e novo em
--      leads.spec.ts (duas chamadas HTTP reais via Promise.all contra o
--      Supabase local). O que dá pra provar aqui é o contrato: versão
--      omitida é recusada, versão desatualizada é recusada, versão
--      correta é aceita — a mecânica que faz a corrida real (seção 2 do
--      teste e2e) resolver para exatamente um vencedor;
--   3) honorários saiu do contrato ativo de leads — get_lead()/
--      list_leads() nunca mais projetam nenhuma chave de valor, para
--      nenhum papel, e set_lead_value() teve o EXECUTE revogado de
--      authenticated (seção 6). A seção antiga de projeção por papel
--      (exato/faixa/ausente) foi removida — não existe mais o que
--      projetar.
--
-- Disciplina do arquivo: `request.jwt.claims` é escopo de TRANSAÇÃO, não
-- de papel — trocar o papel do Postgres (`reset role`/`set local role
-- authenticated`) nunca troca sozinho quem `auth.uid()` enxerga. Por
-- isso, todo bloco reafirma explicitamente OS DOIS antes de cada chamada
-- (RPC como um ator específico, ou leitura direta como papel privilegiado
-- pra conferir o banco) — nunca confia em estado deixado por um bloco
-- anterior.

begin;
select plan(40);

\set ws_um   '10000000-0000-0000-0000-000000000001'
\set ws_dois '10000000-0000-0000-0000-000000000002'
\set ana     '20000000-0000-0000-0000-000000000001'
\set bruno   '20000000-0000-0000-0000-000000000002'
\set carla   '20000000-0000-0000-0000-000000000003'
\set elisa   '20000000-0000-0000-0000-000000000005'

-- Contatos de apoio, cada um criado por quem legitimamente pertence ao
-- workspace de destino.
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'ana', 'role', 'authenticated')::text, true);
select (create_contact(:'ws_um'::uuid, 'pf', 'Contato A4 Um', null, null, null)).id as contact_um \gset
select (create_contact(:'ws_um'::uuid, 'pf', 'Contato A4 Dois', null, null, null)).id as contact_outro_um \gset

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'bruno', 'role', 'authenticated')::text, true);
select (create_contact(:'ws_dois'::uuid, 'pf', 'Contato A4 Workspace Dois', null, null, null)).id as contact_dois \gset

-- -----------------------------------------------------------------
-- 1) Criação com persistência (owner). create_lead() não aceita mais
--    valor de honorários (achado 3 da revisão) — 7 parâmetros, não 8.
-- -----------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'ana', 'role', 'authenticated')::text, true);
select create_lead(
  :'ws_um'::uuid, (:'contact_um')::uuid, 'Trabalhista', 'Rescisão indireta', array['urgente'],
  'alta', :'ana'::uuid
) as lead_um \gset

select ok(:'lead_um' is not null, 'create_lead() retorna o id do lead criado');

reset role;
select is(
  (select legal_area from public.leads where id = (:'lead_um')::uuid),
  'Trabalhista',
  'Lead persistido com a área jurídica informada'
);
select (select updated_at from public.leads where id = (:'lead_um')::uuid) as lead_um_v0 \gset

-- -----------------------------------------------------------------
-- 2) Vínculo obrigatório com contato do MESMO workspace — a FK composta
--    barra no banco, não só na validação da aplicação.
-- -----------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'ana', 'role', 'authenticated')::text, true);
select throws_ok(
  format(
    $i$ select create_lead(%L::uuid, %L::uuid, 'Cível', null, '{}', 'media', null) $i$,
    :'ws_um', :'contact_dois'
  ),
  'P0001',
  'contact_not_found',
  'Criar lead com contato de outro workspace é recusado (contato não encontrado NESTE workspace)'
);

-- -----------------------------------------------------------------
-- 3) Edição com persistência + concorrência atômica (achado 2 da
--    revisão): versão esperada obrigatória; desatualizada é recusada;
--    correta é aceita e nunca sobrescreve silenciosamente.
-- -----------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'ana', 'role', 'authenticated')::text, true);
select throws_ok(
  format(
    $i$ select update_lead_basic_fields(%L::uuid, 'Trabalhista', 'Tentativa sem versão', '{}', 'media', null) $i$,
    :'lead_um'
  ),
  'P0001',
  'expected_version_required',
  'Omitir a versão esperada é recusado — não existe atalho pra pular a checagem numa edição normal'
);

reset role;
select is(
  (select summary from public.leads where id = (:'lead_um')::uuid),
  'Rescisão indireta',
  'Tentativa sem versão não alterou nada (dado preservado)'
);

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'ana', 'role', 'authenticated')::text, true);
select (update_lead_basic_fields(
  (:'lead_um')::uuid, 'Trabalhista', 'Resumo atualizado', array['urgente', 'audiencia_marcada'], 'alta',
  (:'lead_um_v0')::timestamptz
)).updated_at as lead_um_v1 \gset

reset role;
select is(
  (select summary from public.leads where id = (:'lead_um')::uuid),
  'Resumo atualizado',
  'Edição com a versão correta é aceita e persistida'
);

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'ana', 'role', 'authenticated')::text, true);
select throws_ok(
  format(
    $i$ select update_lead_basic_fields(%L::uuid, 'Trabalhista', 'Edição concorrente perdedora', '{}', 'media', %L::timestamptz) $i$,
    :'lead_um', :'lead_um_v0'
  ),
  'P0001',
  'lead_conflict',
  'Reusar a versão JÁ SUBSTITUÍDA (lead_um_v0, não a atual lead_um_v1) é recusado — a checagem é contra o valor atual, não o que o chamador acha que é'
);

reset role;
select is(
  (select summary from public.leads where id = (:'lead_um')::uuid),
  'Resumo atualizado',
  'Tentativa com versão desatualizada NÃO sobrescreveu a edição anterior — sem "ganhador silencioso"'
);

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'ana', 'role', 'authenticated')::text, true);
select lives_ok(
  format(
    -- Prioridade preservada como 'alta' de propósito: esta asserção testa
    -- a mecânica de concorrência, não uma mudança de prioridade — o
    -- filtro por prioridade da seção 9 depende de lead_um continuar
    -- 'alta'.
    $i$ select update_lead_basic_fields(%L::uuid, 'Trabalhista', 'Edição correta', '{}', 'alta', %L::timestamptz) $i$,
    :'lead_um', :'lead_um_v1'
  ),
  'Edição com a versão atual (não a original) é aceita'
);

-- -----------------------------------------------------------------
-- 4) Permissão por papel: viewer não cria nem edita (versão sempre
--    presente e válida aqui — o teste quer provar insufficient_permission,
--    não expected_version_required).
-- -----------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'elisa', 'role', 'authenticated')::text, true);
select throws_ok(
  format(
    $i$ select create_lead(%L::uuid, %L::uuid, 'Cível', null, '{}', 'media', null) $i$,
    :'ws_um', :'contact_um'
  ),
  'P0001',
  'insufficient_permission',
  'Visualizador não cria lead'
);

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'elisa', 'role', 'authenticated')::text, true);
select throws_ok(
  format(
    $i$ select update_lead_basic_fields(%L::uuid, 'Cível', null, '{}', 'media', now()::timestamptz) $i$,
    :'lead_um'
  ),
  'P0001',
  'insufficient_permission',
  'Visualizador não edita lead'
);

-- -----------------------------------------------------------------
-- 5) Honorários fora do contrato ativo de leads (achado 3) — nenhum
--    papel, nem o proprietário, recebe qualquer chave de valor.
-- -----------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'ana', 'role', 'authenticated')::text, true);
select ok(
  not (get_lead((:'lead_um')::uuid) ? 'estimated_value_cents')
  and not (get_lead((:'lead_um')::uuid) ? 'estimated_value_band'),
  'get_lead() não projeta nenhuma chave de valor — nem para o proprietário — honorários pertence a opportunities (A5)'
);

-- -----------------------------------------------------------------
-- 6) Acesso direto às tabelas — sem GRANT nenhum, nem para SELECT.
--    Isso é o que impede qualquer dado de leads de vazar por fora das
--    funções, mesmo pela Data API direta. Roda como `authenticated` DE
--    PROPÓSITO — é exatamente o papel que deve ser barrado.
-- -----------------------------------------------------------------
set local role authenticated;
select throws_ok(
  $i$ select count(*) from public.leads $i$,
  '42501',
  null,
  'leads: SELECT direto negado — sem GRANT nenhum'
);
select throws_ok(
  $i$ select count(*) from public.lead_values $i$,
  '42501',
  null,
  'lead_values: SELECT direto negado — sem GRANT nenhum'
);

reset role;
select ok(
  not has_function_privilege('authenticated', 'public.set_lead_value(uuid, bigint, timestamptz)', 'EXECUTE'),
  'set_lead_value(): EXECUTE revogado de authenticated — fluxo de valor fora do contrato ativo da A4'
);

-- -----------------------------------------------------------------
-- 7) "Seus + sem responsável" NA LEITURA: advogado (carla) só vê leads
--    atribuídos a ela ou sem responsável. lead_um está atribuído a Ana —
--    carla não deve enxergá-lo nem por get_lead() nem por list_leads().
-- -----------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'carla', 'role', 'authenticated')::text, true);
select throws_ok(
  format($i$ select get_lead(%L::uuid) $i$, :'lead_um'),
  'P0001',
  'lead_not_found',
  'Advogado sem vínculo com o lead recebe "não encontrado", não um erro de permissão'
);

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'ana', 'role', 'authenticated')::text, true);
select (create_lead(:'ws_um'::uuid, (:'contact_outro_um')::uuid, 'Cível', null, '{}', 'baixa', null))
  as lead_sem_responsavel \gset

reset role;
select (select updated_at from public.leads where id = (:'lead_sem_responsavel')::uuid) as lead_sem_responsavel_v0 \gset

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'carla', 'role', 'authenticated')::text, true);
select lives_ok(
  format($i$ select get_lead(%L::uuid) $i$, :'lead_sem_responsavel'),
  'Advogado enxerga lead sem responsável'
);

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'carla', 'role', 'authenticated')::text, true);
select is(
  (select (list_leads(:'ws_um'::uuid)).total_count),
  1::bigint,
  'list_leads() para o advogado só conta o lead sem responsável (não o de Ana)'
);

-- -----------------------------------------------------------------
-- 8) "Seus + sem responsável" NA ESCRITA (achado 1 da revisão) — o
--    mesmo alcance da leitura agora vale para editar, arquivar e
--    atribuir. Advogado fora do alcance recebe 'lead_not_found' (não
--    revela o conteúdo do registro) e o dado permanece intacto.
-- -----------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'carla', 'role', 'authenticated')::text, true);
select throws_ok(
  format(
    $i$ select update_lead_basic_fields(%L::uuid, 'Hackeado', null, '{}', 'baixa', now()::timestamptz) $i$,
    :'lead_um'
  ),
  'P0001',
  'lead_not_found',
  'Advogado não edita lead fora do alcance via RPC direta, mesmo com uma versão bem formada'
);

reset role;
select is(
  (select legal_area from public.leads where id = (:'lead_um')::uuid),
  'Trabalhista',
  'Tentativa de edição fora do alcance não alterou o lead de Ana'
);

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'carla', 'role', 'authenticated')::text, true);
select throws_ok(
  format(
    $i$ select assign_lead(%L::uuid, %L::uuid, now()::timestamptz) $i$,
    :'lead_um', :'carla'
  ),
  'P0001',
  'lead_not_found',
  'Advogado não consegue se autoatribuir um lead fora do alcance'
);

reset role;
select is(
  (select assigned_to from public.leads where id = (:'lead_um')::uuid),
  (:'ana')::uuid,
  'Tentativa de autoatribuição fora do alcance não mudou o responsável do lead de Ana'
);

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'carla', 'role', 'authenticated')::text, true);
select throws_ok(
  format(
    $i$ select set_lead_status(%L::uuid, 'arquivado', now()::timestamptz) $i$,
    :'lead_um'
  ),
  'P0001',
  'lead_not_found',
  'Advogado não consegue arquivar um lead fora do alcance'
);

reset role;
select is(
  (select status from public.leads where id = (:'lead_um')::uuid),
  'ativo',
  'Tentativa de arquivar fora do alcance não mudou o status do lead de Ana'
);

-- Dentro do alcance (sem responsável): editar e se autoatribuir funcionam.
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'carla', 'role', 'authenticated')::text, true);
select lives_ok(
  format(
    $i$ select assign_lead(%L::uuid, %L::uuid, %L::timestamptz) $i$,
    :'lead_sem_responsavel', :'carla', :'lead_sem_responsavel_v0'
  ),
  'Advogado consegue se autoatribuir um lead sem responsável (dentro do alcance)'
);

reset role;
select is(
  (select assigned_to from public.leads where id = (:'lead_sem_responsavel')::uuid),
  (:'carla')::uuid,
  'Autoatribuição dentro do alcance persistiu'
);

-- -----------------------------------------------------------------
-- 9) Busca, filtro, paginação — como owner (vê todos).
-- -----------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'ana', 'role', 'authenticated')::text, true);
select is(
  (select (list_leads(:'ws_um'::uuid)).total_count),
  2::bigint,
  'Proprietário vê os 2 leads do Escritório Um'
);
select is(
  (select (list_leads(:'ws_um'::uuid, p_priority := 'alta')).total_count),
  1::bigint,
  'Filtro por prioridade retorna só o lead de prioridade alta'
);
select is(
  (select (list_leads(:'ws_um'::uuid, p_search := 'A4 Um')).total_count),
  1::bigint,
  'Busca por nome de contato encontra o lead certo'
);
select is(
  (select jsonb_array_length((list_leads(:'ws_um'::uuid, p_page := 1, p_page_size := 1)).items)),
  1,
  'Paginação: page_size=1 devolve exatamente 1 item'
);
select is(
  (select (list_leads(:'ws_um'::uuid, p_page := 1, p_page_size := 1)).total_count),
  2::bigint,
  'total_count reflete o total real mesmo com página menor que o total'
);

-- -----------------------------------------------------------------
-- 10) Isolamento entre workspaces — lead do Escritório Um não aparece em
--     list_leads() do Escritório Dois. Chamado como Bruno (owner de lá):
--     ana não é membro do Escritório Dois, e list_leads() recusaria com
--     insufficient_permission antes mesmo de contar linha nenhuma.
-- -----------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'bruno', 'role', 'authenticated')::text, true);
select is(
  (select (list_leads(:'ws_dois'::uuid)).total_count),
  0::bigint,
  'Escritório Dois não vê nenhum lead do Escritório Um'
);

-- -----------------------------------------------------------------
-- 11) Integração com merge/undo de contatos (A3): mesclar reparenta o
--     lead; desfazer restaura, com a mesma trava de conflito.
-- -----------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'ana', 'role', 'authenticated')::text, true);
select (create_lead(
  :'ws_um'::uuid, (:'contact_outro_um')::uuid, 'Cível', null, '{}', 'media', null
)) as lead_para_mesclar \gset

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'ana', 'role', 'authenticated')::text, true);
select (merge_contacts((:'contact_um')::uuid, (:'contact_outro_um')::uuid)).id as merge_kept \gset

reset role;
select (
  select id from public.contact_merges
  where kept_contact_id = (:'contact_um')::uuid and merged_contact_id = (:'contact_outro_um')::uuid
  order by merged_at desc limit 1
) as merge_id \gset

select is(
  (select contact_id from public.leads where id = (:'lead_para_mesclar')::uuid),
  (:'contact_um')::uuid,
  'Mesclar contatos reparenta o lead do contato perdedor para o vencedor'
);

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'ana', 'role', 'authenticated')::text, true);
select lives_ok(
  format($i$ select unmerge_contact(%L::uuid) $i$, :'merge_id'),
  'Desfazer a mesclagem funciona sem edição posterior'
);

reset role;
select is(
  (select contact_id from public.leads where id = (:'lead_para_mesclar')::uuid),
  (:'contact_outro_um')::uuid,
  'Desfazer restaura o lead para o contato original'
);

-- -----------------------------------------------------------------
-- 12) RLS habilitada e forçada nas 2 tabelas novas; GRANT exato (nenhum).
-- -----------------------------------------------------------------
reset role;
select is(
  (
    select count(*)::int
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind = 'r'
      and c.relname in ('leads', 'lead_values')
      and (c.relrowsecurity is false or c.relforcerowsecurity is false)
  ),
  0,
  'leads e lead_values: RLS habilitada e forçada nas duas'
);
select table_privs_are('public', 'leads', 'authenticated', array[]::text[], 'leads: authenticated nenhum grant');
select table_privs_are('public', 'leads', 'anon', array[]::text[], 'leads: anon nenhum grant');
select table_privs_are('public', 'lead_values', 'authenticated', array[]::text[], 'lead_values: authenticated nenhum grant');
select table_privs_are('public', 'lead_values', 'anon', array[]::text[], 'lead_values: anon nenhum grant');

select * from finish();
rollback;
