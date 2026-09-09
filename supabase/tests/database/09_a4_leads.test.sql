-- pgTAP — A4: leads (CRUD, vínculo com contato no mesmo workspace,
-- permissões por papel, projeção do valor de honorários, integração com
-- merge/undo de contatos, RLS/grants exatos). Fixtures do seed
-- (supabase/seed.sql): ana=owner/carla=lawyer/elisa=viewer no Escritório
-- Um; bruno=owner do Escritório Dois. Uma membership 'sales' temporária
-- é criada só para este teste (nenhum usuário do seed tem esse papel no
-- Escritório Um) — mesmo padrão já usado em 06_a3_contacts_isolation.

begin;
select plan(34);

\set ws_um   '10000000-0000-0000-0000-000000000001'
\set ws_dois '10000000-0000-0000-0000-000000000002'
\set ana     '20000000-0000-0000-0000-000000000001'
\set bruno   '20000000-0000-0000-0000-000000000002'
\set carla   '20000000-0000-0000-0000-000000000003'
\set elisa   '20000000-0000-0000-0000-000000000005'

-- Membership 'sales' temporária de Bruno no Escritório Um, só para testar
-- a projeção "faixa" do valor — ele já é owner do Escritório Dois, então
-- usar outro workspace evitaria conflito de papel duplicado na mesma
-- linha; um segundo membership (workspace diferente) é o caso normal de
-- multi-workspace já coberto pela A2.
insert into public.memberships (workspace_id, user_id, role, status)
values (:'ws_um'::uuid, :'bruno'::uuid, 'sales', 'active');

-- Contato de apoio no Escritório Um, criado como ana (owner).
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'ana', 'role', 'authenticated')::text, true);

select (create_contact(:'ws_um'::uuid, 'pf', 'Contato A4 Um', null, null, null)).id as contact_um \gset
select (create_contact(:'ws_um'::uuid, 'pf', 'Contato A4 Dois', null, null, null)).id as contact_outro_um \gset

reset role;
select (create_contact(:'ws_dois'::uuid, 'pf', 'Contato A4 Workspace Dois', null, null, null)).id as contact_dois \gset
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'bruno', 'role', 'authenticated')::text, true);
select (create_contact(:'ws_dois'::uuid, 'pf', 'Contato A4 Workspace Dois criado por bruno', null, null, null)).id as contact_dois2 \gset
reset role;

-- -----------------------------------------------------------------
-- 1) Criação com persistência (owner), valor em centavos.
-- -----------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'ana', 'role', 'authenticated')::text, true);

select create_lead(
  :'ws_um'::uuid, (:'contact_um')::uuid, 'Trabalhista', 'Rescisão indireta', array['urgente'],
  'alta', :'ana'::uuid, 550000
) as lead_um \gset

select ok(:'lead_um' is not null, 'create_lead() retorna o id do lead criado');

reset role;
select is(
  (select legal_area from public.leads where id = (:'lead_um')::uuid),
  'Trabalhista',
  'Lead persistido com a área jurídica informada'
);
select is(
  (select estimated_value_cents from public.lead_values where lead_id = (:'lead_um')::uuid),
  550000::bigint,
  'Valor estimado persistido em centavos, sem ponto flutuante'
);

-- -----------------------------------------------------------------
-- 2) Vínculo obrigatório com contato do MESMO workspace — a FK composta
--    barra no banco, não só na validação da aplicação.
-- -----------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'ana', 'role', 'authenticated')::text, true);

select throws_ok(
  format(
    $i$ select create_lead(%L::uuid, %L::uuid, 'Cível', null, '{}', 'media', null, null) $i$,
    :'ws_um', :'contact_dois'
  ),
  'P0001',
  'contact_not_found',
  'Criar lead com contato de outro workspace é recusado (contato não encontrado NESTE workspace)'
);

-- -----------------------------------------------------------------
-- 3) Edição com persistência + concorrência: segunda edição com
--    updated_at desatualizado é recusada, não sobrescreve silenciosamente.
-- -----------------------------------------------------------------
select (update_lead_basic_fields(
  (:'lead_um')::uuid, 'Trabalhista', 'Resumo atualizado', array['urgente', 'audiencia_marcada'], 'alta', null
)).updated_at as lead_um_updated_at \gset

select is(
  (select summary from public.leads where id = (:'lead_um')::uuid),
  'Resumo atualizado',
  'Edição básica persistida'
);

select throws_ok(
  format(
    $i$ select update_lead_basic_fields(%L::uuid, 'Trabalhista', 'Outra edição', '{}', 'media', now() - interval '1 hour') $i$,
    :'lead_um'
  ),
  'P0001',
  'lead_conflict',
  'Edição concorrente com updated_at desatualizado é recusada, não sobrescreve'
);

select lives_ok(
  format(
    $i$ select update_lead_basic_fields(%L::uuid, 'Trabalhista', 'Edição correta', '{}', 'media', %L::timestamptz) $i$,
    :'lead_um', :'lead_um_updated_at'
  ),
  'Edição com updated_at correto é aceita'
);

-- -----------------------------------------------------------------
-- 4) Permissão por papel: viewer não cria nem edita; todos os outros
--    (menos viewer) criam.
-- -----------------------------------------------------------------
select set_config('request.jwt.claims', json_build_object('sub', :'elisa', 'role', 'authenticated')::text, true);

select throws_ok(
  format(
    $i$ select create_lead(%L::uuid, %L::uuid, 'Cível', null, '{}', 'media', null, null) $i$,
    :'ws_um', :'contact_um'
  ),
  'P0001',
  'insufficient_permission',
  'Visualizador não cria lead'
);

select throws_ok(
  format($i$ select update_lead_basic_fields(%L::uuid, 'Cível', null, '{}', 'media', null) $i$, :'lead_um'),
  'P0001',
  'insufficient_permission',
  'Visualizador não edita lead'
);

-- -----------------------------------------------------------------
-- 5) Projeção do valor por papel — a chave só existe no jsonb quando o
--    papel pode vê-la; visualizador não recebe CPF nem honorários (aqui,
--    a chave inteira é ausente, não um valor nulo presente).
-- -----------------------------------------------------------------
select ok(
  not (get_lead((:'lead_um')::uuid) ? 'estimated_value_cents'),
  'Resposta de get_lead() para visualizador NÃO contém a chave estimated_value_cents'
);
select ok(
  not (get_lead((:'lead_um')::uuid) ? 'estimated_value_band'),
  'Resposta de get_lead() para visualizador também não contém a chave de faixa'
);

select set_config('request.jwt.claims', json_build_object('sub', :'bruno', 'role', 'authenticated')::text, true);
select ok(
  (get_lead((:'lead_um')::uuid) ? 'estimated_value_band'),
  'Atendimento (sales) recebe a CHAVE de faixa'
);
select ok(
  not (get_lead((:'lead_um')::uuid) ? 'estimated_value_cents'),
  'Atendimento (sales) NUNCA recebe o valor exato'
);
select is(
  get_lead((:'lead_um')::uuid) ->> 'estimated_value_band',
  'R$ 5.000–10.000',
  'Faixa calculada corretamente para R$ 5.500,00'
);

select set_config('request.jwt.claims', json_build_object('sub', :'ana', 'role', 'authenticated')::text, true);
select is(
  (get_lead((:'lead_um')::uuid) ->> 'estimated_value_cents')::bigint,
  550000::bigint,
  'Proprietário recebe o valor exato'
);

-- -----------------------------------------------------------------
-- 6) Acesso direto às tabelas — sem GRANT nenhum, nem para SELECT.
--    Isso é o que impede o valor de honorários de vazar por fora da
--    função, mesmo pela Data API direta.
-- -----------------------------------------------------------------
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

-- -----------------------------------------------------------------
-- 7) "Seus + equipe": advogado (carla) só vê leads atribuídos a ela ou
--    sem responsável. lead_um está atribuído a Ana — carla não deve
--    enxergá-lo nem por get_lead() nem por list_leads().
-- -----------------------------------------------------------------
select set_config('request.jwt.claims', json_build_object('sub', :'carla', 'role', 'authenticated')::text, true);

select throws_ok(
  format($i$ select get_lead(%L::uuid) $i$, :'lead_um'),
  'P0001',
  'lead_not_found',
  'Advogado sem vínculo com o lead recebe "não encontrado", não um erro de permissão'
);

reset role;
select (create_lead(:'ws_um'::uuid, (:'contact_outro_um')::uuid, 'Cível', null, '{}', 'baixa', null, null))
  as lead_sem_responsavel \gset
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'carla', 'role', 'authenticated')::text, true);

select lives_ok(
  format($i$ select get_lead(%L::uuid) $i$, :'lead_sem_responsavel'),
  'Advogado enxerga lead sem responsável'
);

select is(
  (select (list_leads(:'ws_um'::uuid)).total_count),
  1::bigint,
  'list_leads() para o advogado só conta o lead sem responsável (não o de Ana)'
);

-- -----------------------------------------------------------------
-- 8) Busca, filtro, paginação — como owner (vê todos).
-- -----------------------------------------------------------------
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
-- 9) Isolamento entre workspaces — lead do Escritório Um não aparece em
--    list_leads()/get_lead() do Escritório Dois.
-- -----------------------------------------------------------------
select is(
  (select (list_leads(:'ws_dois'::uuid)).total_count),
  0::bigint,
  'Escritório Dois não vê nenhum lead do Escritório Um'
);

-- -----------------------------------------------------------------
-- 10) Integração com merge/undo de contatos (A3): mesclar reparenta o
--     lead; desfazer restaura, com a mesma trava de conflito.
-- -----------------------------------------------------------------
select (create_lead(
  :'ws_um'::uuid, (:'contact_outro_um')::uuid, 'Cível', null, '{}', 'media', null, null
)) as lead_para_mesclar \gset

select (merge_contacts((:'contact_um')::uuid, (:'contact_outro_um')::uuid)).id as merge_kept \gset
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

select lives_ok(
  format($i$ select unmerge_contact(%L::uuid) $i$, :'merge_id'),
  'Desfazer a mesclagem funciona sem edição posterior'
);
select is(
  (select contact_id from public.leads where id = (:'lead_para_mesclar')::uuid),
  (:'contact_outro_um')::uuid,
  'Desfazer restaura o lead para o contato original'
);

-- -----------------------------------------------------------------
-- 11) RLS habilitada e forçada nas 2 tabelas novas; GRANT exato (nenhum).
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
