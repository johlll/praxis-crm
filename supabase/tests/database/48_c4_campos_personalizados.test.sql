-- pgTAP — C4 mínima: campos personalizados (definições, valores tipados,
-- permissão e alcance por entidade, isolamento, arquivamento e auditoria).
--
-- Tudo roda numa transação só. Papéis no workspace Um: Ana owner, Bruno admin,
-- Daniel manager (depois sales), Carla lawyer, Elisa viewer. Workspace Dois:
-- Bruno owner, Carla sales.

begin;
select plan(150);

\set ana    '20000000-0000-0000-0000-000000000001'
\set bruno  '20000000-0000-0000-0000-000000000002'
\set carla  '20000000-0000-0000-0000-000000000003'
\set daniel '20000000-0000-0000-0000-000000000004'
\set elisa  '20000000-0000-0000-0000-000000000005'
\set ws_um   '10000000-0000-0000-0000-000000000001'
\set ws_dois '10000000-0000-0000-0000-000000000002'

insert into public.memberships (workspace_id, user_id, role, status) values
  (:'ws_um'::uuid, :'bruno'::uuid, 'admin', 'active'),
  (:'ws_um'::uuid, :'daniel'::uuid, 'manager', 'active');

-- ---------------------------------------------------------------------
-- Ajudantes (só desta transação)
-- ---------------------------------------------------------------------

create function pg_temp.login(p_user uuid) returns void language sql as $f$
  select set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true)
$f$;

create function pg_temp.n(p_sql text) returns bigint language plpgsql security definer as $f$
declare v bigint;
begin
  execute p_sql into v;
  return v;
end;
$f$;

-- Valor guardado (texto) de uma definição num registro, lido como dono do banco.
create function pg_temp.stored(p_def uuid, p_record uuid) returns text language plpgsql security definer as $f$
declare v text;
begin
  select coalesce(value_text, value_number::text, value_date::text, value_boolean::text, option_id::text) into v
  from public.custom_field_values
  where definition_id = p_def and coalesce(contact_id, lead_id, opportunity_id, client_id) = p_record;
  return v;
end;
$f$;

create function pg_temp.rows_of(p_def uuid, p_record uuid) returns bigint language plpgsql security definer as $f$
declare v bigint;
begin
  select count(*) into v from public.custom_field_values
  where definition_id = p_def and coalesce(contact_id, lead_id, opportunity_id, client_id) = p_record;
  return v;
end;
$f$;

create function pg_temp.def_any(p_ws uuid, p_entity text, p_name text) returns uuid language plpgsql security definer as $f$
declare v uuid;
begin
  select id into v from public.custom_field_definitions
  where workspace_id = p_ws and entity_type = p_entity and name = p_name order by archived_at nulls last limit 1;
  return v;
end;
$f$;

create function pg_temp.def_of(p_ws uuid, p_entity text, p_name text) returns uuid language plpgsql security definer as $f$
declare v uuid;
begin
  select id into v from public.custom_field_definitions
  where workspace_id = p_ws and entity_type = p_entity and name = p_name and archived_at is null;
  return v;
end;
$f$;

-- ---------------------------------------------------------------------
-- Dados de apoio (registros das quatro entidades)
-- ---------------------------------------------------------------------

set local role authenticated;
select pg_temp.login(:'ana'::uuid);
select (create_contact(:'ws_um'::uuid, 'pf', 'Maria Campos C4', null, null, null)).id as contato \gset
select (create_contact(:'ws_um'::uuid, 'pf', 'Joao Cliente A C4', null, null, null)).id as contato_ca \gset
select (create_contact(:'ws_um'::uuid, 'pf', 'Jose Cliente B C4', null, null, null)).id as contato_cb \gset
select create_lead(:'ws_um'::uuid, (:'contato')::uuid, 'Trabalhista', null, '{}'::text[], 'alta', :'ana'::uuid) as lead_ana \gset
select create_lead(:'ws_um'::uuid, (:'contato')::uuid, 'Cível', null, '{}'::text[], 'media', :'carla'::uuid) as lead_carla \gset
select create_lead(:'ws_um'::uuid, (:'contato')::uuid, 'Família', null, '{}'::text[], 'baixa', null) as lead_livre \gset
select create_opportunity((:'lead_ana')::uuid) as opp_ana \gset
select create_opportunity((:'lead_carla')::uuid) as opp_carla \gset

select pg_temp.login(:'bruno'::uuid);
select (create_contact(:'ws_dois'::uuid, 'pf', 'Contato Dois C4', null, null, null)).id as contato_dois \gset
reset role;

insert into public.clients (workspace_id, contact_id, owner_user_id) values (:'ws_um'::uuid, (:'contato_ca')::uuid, :'ana'::uuid)
  returning id as client_a \gset
insert into public.clients (workspace_id, contact_id, owner_user_id) values (:'ws_um'::uuid, (:'contato_cb')::uuid, :'ana'::uuid)
  returning id as client_b \gset
insert into public.client_handoffs (workspace_id, client_id, opportunity_id) values
  (:'ws_um'::uuid, (:'client_a')::uuid, (:'opp_ana')::uuid),
  (:'ws_um'::uuid, (:'client_b')::uuid, (:'opp_carla')::uuid);

-- =====================================================================
-- 1) Superfície: RLS forçada, sem grants, funções fechadas
-- =====================================================================

select is(
  (select array_agg(c.relname::text order by c.relname) from pg_class c
   where c.relnamespace = 'public'::regnamespace and c.relname in ('custom_field_definitions', 'custom_field_options', 'custom_field_values')
     and c.relrowsecurity and c.relforcerowsecurity),
  array['custom_field_definitions', 'custom_field_options', 'custom_field_values'],
  'as três tabelas têm RLS habilitada e forçada'
);
select is(
  (select count(*) from pg_policy p where p.polrelid in ('public.custom_field_definitions'::regclass, 'public.custom_field_options'::regclass, 'public.custom_field_values'::regclass)),
  0::bigint, 'nenhuma policy: o cliente não lê nem escreve direto'
);
select ok(
  not exists (
    select 1 from unnest(array['custom_field_definitions', 'custom_field_options', 'custom_field_values']) t(name),
                  unnest(array['anon', 'authenticated']) r(role)
    where has_table_privilege(r.role, 'public.' || t.name, 'select,insert,update,delete,truncate,references,trigger')
  ),
  'anon e authenticated não têm nenhum privilégio de tabela'
);
select is(
  (select array_agg(p.proname::text order by p.proname) from pg_proc p
   where p.pronamespace = 'public'::regnamespace and p.proname like '%custom_field%'
     and has_function_privilege('authenticated', p.oid, 'execute') and not has_function_privilege('anon', p.oid, 'execute') and not has_function_privilege('public', p.oid, 'execute')),
  array['create_custom_field', 'get_custom_field_values', 'list_custom_field_definitions', 'set_custom_field_archived', 'set_custom_field_values', 'update_custom_field'],
  'as seis RPCs executam só para authenticated (nem anon nem public)'
);
select is(
  (select count(*) from pg_proc p
   where p.pronamespace = 'private'::regnamespace and p.proname like 'custom_field%'
     and (has_function_privilege('authenticated', p.oid, 'execute') or has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('public', p.oid, 'execute'))),
  0::bigint, 'as funções privadas não executam para o cliente'
);
select ok(
  (select bool_and(p.prosecdef and p.proconfig = array['search_path=""'])
   from pg_proc p where p.pronamespace in ('public'::regnamespace, 'private'::regnamespace) and p.proname like '%custom_field%'
     and p.proname <> 'custom_field_normalize_options'),
  'toda função de campo personalizado é SECURITY DEFINER com search_path vazio (exceto o normalizador puro, só com search_path vazio)'
);
select ok(
  (select p.proconfig = array['search_path=""'] from pg_proc p where p.proname = 'custom_field_normalize_options'),
  'o normalizador puro também tem search_path vazio'
);
-- =====================================================================
-- 2) Definições: owner e admin administram; os demais não
-- =====================================================================

set local role authenticated;
select pg_temp.login(:'ana'::uuid);

select create_custom_field(:'ws_um'::uuid, 'contact', 'Origem do indicador', 'text') as def_contact_texto \gset
select create_custom_field(:'ws_um'::uuid, 'lead', 'Valor da causa', 'number') as def_lead_numero \gset
select create_custom_field(:'ws_um'::uuid, 'lead', 'Data da audiência', 'date') as def_lead_data \gset
select create_custom_field(:'ws_um'::uuid, 'opportunity', 'Prioridade interna', 'boolean') as def_opp_bool \gset
select create_custom_field(:'ws_um'::uuid, 'lead', 'Fase processual', 'select', null, '[{"label": "Conhecimento"}, {"label": "Recursal"}, {"label": "Execução"}]'::jsonb) as def_lead_sel \gset
select create_custom_field(:'ws_um'::uuid, 'client', 'Nível de atendimento', 'select', 5, '[{"label": "Ouro"}, {"label": "Prata"}]'::jsonb) as def_client_sel \gset
select create_custom_field(:'ws_um'::uuid, 'client', 'Observação interna', 'text') as def_client_texto \gset
select create_custom_field(:'ws_um'::uuid, 'contact', 'Número da pasta', 'number') as def_contact_numero \gset

select ok(:'def_lead_numero' is not null, 'owner cria definição (número)');
reset role;
select is(
  (select format('%s|%s|%s', entity_type, field_type, position) from public.custom_field_definitions where id = (:'def_lead_sel')::uuid),
  'lead|select|2', 'seleção única criada com entidade, tipo e posição automática (a próxima da entidade)'
);
select is(
  (select array_agg(label order by position) from public.custom_field_options where definition_id = (:'def_lead_sel')::uuid),
  array['Conhecimento', 'Recursal', 'Execução'], 'as opções nascem na ordem recebida'
);

set local role authenticated;
select pg_temp.login(:'bruno'::uuid);
select create_custom_field(:'ws_um'::uuid, 'opportunity', 'Reunião agendada', 'boolean') as def_opp_bool2 \gset
select ok(:'def_opp_bool2' is not null, 'admin também cria definição');
select lives_ok(format($i$ select update_custom_field(%L::uuid, 'Reunião marcada', 7) $i$, :'def_opp_bool2'), 'admin edita nome e posição');

-- Quem não é owner/admin não administra nada.
select pg_temp.login(:'daniel'::uuid);
select throws_ok(format($i$ select create_custom_field(%L::uuid, 'lead', 'Campo do gestor', 'text') $i$, :'ws_um'), 'P0001', 'insufficient_permission', 'manager não cria definição');
select throws_ok(format($i$ select update_custom_field(%L::uuid, 'Renomeado') $i$, :'def_lead_numero'), 'P0001', 'insufficient_permission', 'manager não edita definição');
select throws_ok(format($i$ select set_custom_field_archived(%L::uuid, true) $i$, :'def_lead_numero'), 'P0001', 'insufficient_permission', 'manager não arquiva definição');
select throws_ok(format($i$ select list_custom_field_definitions(%L::uuid) $i$, :'ws_um'), 'P0001', 'insufficient_permission', 'manager não lista a administração');
select pg_temp.login(:'carla'::uuid);
select throws_ok(format($i$ select create_custom_field(%L::uuid, 'lead', 'Campo da advogada', 'text') $i$, :'ws_um'), 'P0001', 'insufficient_permission', 'advogado não cria definição');
select pg_temp.login(:'elisa'::uuid);
select throws_ok(format($i$ select create_custom_field(%L::uuid, 'lead', 'Campo do viewer', 'text') $i$, :'ws_um'), 'P0001', 'insufficient_permission', 'visualizador não cria definição');
select throws_ok(format($i$ select set_custom_field_archived(%L::uuid, true) $i$, :'def_lead_numero'), 'P0001', 'insufficient_permission', 'visualizador não arquiva definição');

-- Papel de atendimento: Daniel passa a sales.
reset role;
update public.memberships set role = 'sales' where workspace_id = :'ws_um'::uuid and user_id = :'daniel'::uuid;
set local role authenticated;
select pg_temp.login(:'daniel'::uuid);
select throws_ok(format($i$ select create_custom_field(%L::uuid, 'lead', 'Campo do atendimento', 'text') $i$, :'ws_um'), 'P0001', 'insufficient_permission', 'atendimento não cria definição');

-- Isolamento: outro workspace.
select pg_temp.login(:'ana'::uuid);
select throws_ok(format($i$ select create_custom_field(%L::uuid, 'lead', 'Invasor', 'text') $i$, :'ws_dois'), 'P0001', 'insufficient_permission', 'owner do Um não cria definição no Dois');
select pg_temp.login(:'bruno'::uuid);
select create_custom_field(:'ws_dois'::uuid, 'contact', 'Campo do Dois', 'text') as def_dois_texto \gset
select pg_temp.login(:'ana'::uuid);
select throws_ok(format($i$ select update_custom_field(%L::uuid, 'Sequestrado') $i$, :'def_dois_texto'), 'P0001', 'custom_field_not_found', 'definição de outro workspace responde "não encontrada" ao editar');
select throws_ok(format($i$ select set_custom_field_archived(%L::uuid, true) $i$, :'def_dois_texto'), 'P0001', 'custom_field_not_found', 'e ao arquivar');
select is(jsonb_array_length(list_custom_field_definitions(:'ws_um'::uuid)), 9, 'a lista de administração traz só as definições do próprio workspace');
select pg_temp.login(:'bruno'::uuid);
select is((list_custom_field_definitions(:'ws_dois'::uuid) -> 0 ->> 'name'), 'Campo do Dois', 'e o Dois vê só as dele');

-- =====================================================================
-- 3) Validação das definições
-- =====================================================================

select pg_temp.login(:'ana'::uuid);
select throws_ok(format($i$ select create_custom_field(%L::uuid, 'documento', 'X', 'text') $i$, :'ws_um'), 'P0001', 'custom_field_invalid_entity', 'entidade fora da lista fechada é recusada');
select throws_ok(format($i$ select create_custom_field(%L::uuid, 'lead', 'X', 'multiselect') $i$, :'ws_um'), 'P0001', 'custom_field_invalid_type', 'tipo fora da lista fechada é recusado (nada de múltipla seleção, fórmula, arquivo, texto rico)');
select throws_ok(format($i$ select create_custom_field(%L::uuid, 'lead', '   ', 'text') $i$, :'ws_um'), 'P0001', 'custom_field_invalid_name', 'nome em branco é recusado');
select throws_ok(format($i$ select create_custom_field(%L::uuid, 'lead', %L, 'text') $i$, :'ws_um', repeat('a', 81)), 'P0001', 'custom_field_invalid_name', 'nome com mais de 80 caracteres é recusado');
select throws_ok(format($i$ select create_custom_field(%L::uuid, 'lead', 'Posição ruim', 'text', 5000) $i$, :'ws_um'), 'P0001', 'custom_field_invalid_position', 'posição fora do intervalo é recusada');
select throws_ok(format($i$ select create_custom_field(%L::uuid, 'lead', 'Sem opções', 'select') $i$, :'ws_um'), 'P0001', 'custom_field_invalid_options', 'seleção única exige opções');
select throws_ok(format($i$ select create_custom_field(%L::uuid, 'lead', 'Texto com opções', 'text', null, '[{"label":"a"}]'::jsonb) $i$, :'ws_um'), 'P0001', 'custom_field_invalid_options', 'só seleção única aceita opções');
select throws_ok(format($i$ select create_custom_field(%L::uuid, 'lead', 'Rótulos iguais', 'select', null, '[{"label":"Sim"},{"label":" sim "}]'::jsonb) $i$, :'ws_um'), 'P0001', 'custom_field_invalid_options', 'opções repetidas (sem diferenciar maiúscula) são recusadas');
select throws_ok(format($i$ select create_custom_field(%L::uuid, 'lead', 'Chave extra', 'select', null, '[{"label":"a","peso":1}]'::jsonb) $i$, :'ws_um'), 'P0001', 'custom_field_invalid_options', 'a opção só aceita rótulo (sem chave extra)');
select throws_ok(format($i$ select create_custom_field(%L::uuid, 'lead', 'Opção com id', 'select', null, '[{"id":"00000000-0000-0000-0000-0000000000aa","label":"a"}]'::jsonb) $i$, :'ws_um'), 'P0001', 'custom_field_invalid_options', 'opção nova não pode trazer id');
select throws_ok(format($i$ select create_custom_field(%L::uuid, 'lead', 'valor DA causa', 'text') $i$, :'ws_um'), 'P0001', 'custom_field_name_taken', 'nome repetido entre as definições ativas da entidade é recusado (sem diferenciar maiúscula)');
select lives_ok(format($i$ select create_custom_field(%L::uuid, 'contact', 'Valor da causa', 'text') $i$, :'ws_um'), 'o mesmo nome em OUTRA entidade é permitido');

-- O tipo e a entidade não mudam: a RPC nem aceita o parâmetro, e o banco recusa por trigger.
select is(
  (select pg_get_function_identity_arguments(p.oid) from pg_proc p where p.proname = 'update_custom_field' and p.pronamespace = 'public'::regnamespace),
  'p_definition_id uuid, p_name text, p_position integer, p_options jsonb',
  'update_custom_field não recebe tipo nem entidade'
);
reset role;
select throws_ok(
  format($i$ update public.custom_field_definitions set field_type = 'text' where id = %L::uuid $i$, :'def_lead_numero'),
  'P0001', 'custom_field_immutable', 'o tipo não pode ser alterado nem direto no banco'
);
select throws_ok(
  format($i$ update public.custom_field_definitions set entity_type = 'contact' where id = %L::uuid $i$, :'def_lead_numero'),
  'P0001', 'custom_field_immutable', 'nem a entidade'
);

-- Limite de 50 ativos por entidade e workspace.
set local role authenticated;
select pg_temp.login(:'ana'::uuid);
select count(create_custom_field(:'ws_um'::uuid, 'client', 'Campo cliente ' || g, 'text')) as criados_cliente from generate_series(1, 48) g \gset
select throws_ok(
  format($i$ select create_custom_field(%L::uuid, 'client', 'Campo cliente 51', 'text') $i$, :'ws_um'),
  'P0001', 'custom_field_limit_reached', 'o 51º campo ativo da entidade é recusado'
);
select lives_ok(format($i$ select create_custom_field(%L::uuid, 'opportunity', 'Em outra entidade o limite é separado', 'text') $i$, :'ws_um'), 'o limite é por entidade');
select set_custom_field_archived(pg_temp.def_of(:'ws_um'::uuid, 'client', 'Campo cliente 1'), true);
select lives_ok(format($i$ select create_custom_field(%L::uuid, 'client', 'Campo cliente 51', 'text') $i$, :'ws_um'), 'arquivar libera uma vaga');
select throws_ok(
  format($i$ select set_custom_field_archived(%L::uuid, false) $i$, pg_temp.def_any(:'ws_um'::uuid, 'client', 'Campo cliente 1')),
  'P0001', 'custom_field_limit_reached', 'restaurar com a entidade cheia também respeita o limite'
);

-- =====================================================================
-- 4) Opções: edição e "opção usada não sai em silêncio"
-- =====================================================================

reset role;
select id as opt_conhec from public.custom_field_options where definition_id = (:'def_lead_sel')::uuid and label = 'Conhecimento' \gset
select id as opt_recurs from public.custom_field_options where definition_id = (:'def_lead_sel')::uuid and label = 'Recursal' \gset
select id as opt_exec from public.custom_field_options where definition_id = (:'def_lead_sel')::uuid and label = 'Execução' \gset
select id as opt_ouro from public.custom_field_options where definition_id = (:'def_client_sel')::uuid and label = 'Ouro' \gset

-- Valores de lead para a Ana (usa a opção "Recursal").
set local role authenticated;
select pg_temp.login(:'ana'::uuid);
select set_custom_field_values('lead', (:'lead_ana')::uuid, jsonb_build_array(jsonb_build_object('definition_id', :'def_lead_sel', 'value', :'opt_recurs'))) as gravou_sel \gset
select is((:'gravou_sel')::int, 1, 'seleção gravada com uma opção da própria definição');

select throws_ok(
  format($i$ select update_custom_field(%L::uuid, 'Fase processual', null, jsonb_build_array(jsonb_build_object('id', %L, 'label', 'Conhecimento'), jsonb_build_object('id', %L, 'label', 'Execução'))) $i$, :'def_lead_sel', :'opt_conhec', :'opt_exec'),
  'P0001', 'custom_field_option_in_use', 'opção já usada não pode ser removida da lista'
);
reset role;
select is((select count(*) from public.custom_field_options where definition_id = (:'def_lead_sel')::uuid), 3::bigint, 'e a recusa não removeu nenhuma opção (nada silencioso)');
select is(pg_temp.stored((:'def_lead_sel')::uuid, (:'lead_ana')::uuid), :'opt_recurs', 'nem apagou o valor');

set local role authenticated;
select pg_temp.login(:'ana'::uuid);
select lives_ok(
  format($i$ select update_custom_field(%L::uuid, 'Fase do processo', 2, jsonb_build_array(jsonb_build_object('id', %L, 'label', 'Conhecimento (1º grau)'), jsonb_build_object('id', %L, 'label', 'Recursal'), jsonb_build_object('label', 'Cumprimento'))) $i$, :'def_lead_sel', :'opt_conhec', :'opt_recurs'),
  'renomear opção, manter a usada, remover a não usada (Execução) e acrescentar nova funciona'
);
reset role;
select is(
  (select array_agg(label order by position) from public.custom_field_options where definition_id = (:'def_lead_sel')::uuid),
  array['Conhecimento (1º grau)', 'Recursal', 'Cumprimento'], 'a lista de opções ficou como pedido, na ordem'
);
select is((select id::text from public.custom_field_options where definition_id = (:'def_lead_sel')::uuid and label = 'Recursal'), :'opt_recurs', 'a opção usada manteve o mesmo identificador');
set local role authenticated;
select pg_temp.login(:'ana'::uuid);
select throws_ok(
  format($i$ select update_custom_field(%L::uuid, 'Fase do processo', null, jsonb_build_array(jsonb_build_object('id', %L, 'label', 'Roubada'))) $i$, :'def_lead_sel', :'opt_ouro'),
  'P0001', 'custom_field_invalid_options', 'opção de OUTRA definição não pode entrar na lista'
);
select throws_ok(format($i$ select update_custom_field(%L::uuid, 'Número', null, '[{"label":"a"}]'::jsonb) $i$, :'def_lead_numero'), 'P0001', 'custom_field_invalid_options', 'definição que não é seleção não aceita opções');

-- =====================================================================
-- 5) Valores: cada tipo aceita o válido e recusa o incorreto
-- =====================================================================

select is(set_custom_field_values('contact', (:'contato')::uuid, jsonb_build_array(
    jsonb_build_object('definition_id', :'def_contact_texto', 'value', '  Indicação da Dra. Marta  '),
    jsonb_build_object('definition_id', :'def_contact_numero', 'value', 1234.5))), 2, 'contato: texto e número gravados');
reset role;
select is(pg_temp.stored((:'def_contact_texto')::uuid, (:'contato')::uuid), 'Indicação da Dra. Marta', 'o texto é guardado sem os espaços das pontas');
select is(pg_temp.stored((:'def_contact_numero')::uuid, (:'contato')::uuid), '1234.5000', 'o número é guardado com precisão fixa');

set local role authenticated;
select pg_temp.login(:'ana'::uuid);
select is(set_custom_field_values('lead', (:'lead_ana')::uuid, jsonb_build_array(
    jsonb_build_object('definition_id', :'def_lead_numero', 'value', 50000),
    jsonb_build_object('definition_id', :'def_lead_data', 'value', '2026-12-15'))), 2, 'lead: número e data gravados');
select is(set_custom_field_values('opportunity', (:'opp_ana')::uuid, jsonb_build_array(jsonb_build_object('definition_id', :'def_opp_bool', 'value', false))), 1, 'oportunidade: booleano falso é um valor (não é "vazio")');
select is(set_custom_field_values('client', (:'client_a')::uuid, jsonb_build_array(jsonb_build_object('definition_id', :'def_client_sel', 'value', :'opt_ouro'))), 1, 'cliente: seleção gravada');
reset role;
select is(pg_temp.stored((:'def_lead_data')::uuid, (:'lead_ana')::uuid), '2026-12-15', 'data guardada como data');
select is(pg_temp.stored((:'def_opp_bool')::uuid, (:'opp_ana')::uuid), 'false', 'booleano guardado como booleano');

set local role authenticated;
select pg_temp.login(:'ana'::uuid);
-- Tipo incorreto.
select throws_ok(format($i$ select set_custom_field_values('lead', %L::uuid, jsonb_build_array(jsonb_build_object('definition_id', %L, 'value', 'muito'))) $i$, :'lead_ana', :'def_lead_numero'), 'P0001', 'custom_field_invalid_value', 'número recusa texto');
select throws_ok(format($i$ select set_custom_field_values('lead', %L::uuid, jsonb_build_array(jsonb_build_object('definition_id', %L, 'value', 12))) $i$, :'lead_ana', :'def_lead_data'), 'P0001', 'custom_field_invalid_value', 'data recusa número');
select throws_ok(format($i$ select set_custom_field_values('opportunity', %L::uuid, jsonb_build_array(jsonb_build_object('definition_id', %L, 'value', 'true'))) $i$, :'opp_ana', :'def_opp_bool'), 'P0001', 'custom_field_invalid_value', 'booleano recusa o texto "true"');
select throws_ok(format($i$ select set_custom_field_values('contact', %L::uuid, jsonb_build_array(jsonb_build_object('definition_id', %L, 'value', true))) $i$, :'contato', :'def_contact_texto'), 'P0001', 'custom_field_invalid_value', 'texto recusa booleano');
select throws_ok(format($i$ select set_custom_field_values('lead', %L::uuid, jsonb_build_array(jsonb_build_object('definition_id', %L, 'value', '2026-02-30'))) $i$, :'lead_ana', :'def_lead_data'), 'P0001', 'custom_field_invalid_value', 'data impossível é recusada');
select throws_ok(format($i$ select set_custom_field_values('lead', %L::uuid, jsonb_build_array(jsonb_build_object('definition_id', %L, 'value', '15/12/2026'))) $i$, :'lead_ana', :'def_lead_data'), 'P0001', 'custom_field_invalid_value', 'data fora do formato AAAA-MM-DD é recusada');
select throws_ok(format($i$ select set_custom_field_values('lead', %L::uuid, jsonb_build_array(jsonb_build_object('definition_id', %L, 'value', '1800-01-01'))) $i$, :'lead_ana', :'def_lead_data'), 'P0001', 'custom_field_invalid_value', 'data fora do intervalo é recusada');
select throws_ok(format($i$ select set_custom_field_values('lead', %L::uuid, jsonb_build_array(jsonb_build_object('definition_id', %L, 'value', 1.23456))) $i$, :'lead_ana', :'def_lead_numero'), 'P0001', 'custom_field_invalid_value', 'número com mais de 4 casas é recusado');
select throws_ok(format($i$ select set_custom_field_values('lead', %L::uuid, jsonb_build_array(jsonb_build_object('definition_id', %L, 'value', 1e15))) $i$, :'lead_ana', :'def_lead_numero'), 'P0001', 'custom_field_invalid_value', 'número fora do intervalo é recusado');
select throws_ok(format($i$ select set_custom_field_values('contact', %L::uuid, jsonb_build_array(jsonb_build_object('definition_id', %L, 'value', %L))) $i$, :'contato', :'def_contact_texto', repeat('x', 501)), 'P0001', 'custom_field_invalid_value', 'texto com mais de 500 caracteres é recusado');
select throws_ok(format($i$ select set_custom_field_values('lead', %L::uuid, jsonb_build_array(jsonb_build_object('definition_id', %L, 'value', '{"a":1}'::jsonb))) $i$, :'lead_ana', :'def_lead_numero'), 'P0001', 'custom_field_invalid_value', 'objeto JSON livre é recusado');
-- Seleção.
select throws_ok(format($i$ select set_custom_field_values('lead', %L::uuid, jsonb_build_array(jsonb_build_object('definition_id', %L, 'value', %L))) $i$, :'lead_ana', :'def_lead_sel', :'opt_ouro'), 'P0001', 'custom_field_invalid_option', 'seleção recusa opção de OUTRA definição');
select throws_ok(format($i$ select set_custom_field_values('lead', %L::uuid, jsonb_build_array(jsonb_build_object('definition_id', %L, 'value', 'Recursal'))) $i$, :'lead_ana', :'def_lead_sel'), 'P0001', 'custom_field_invalid_option', 'seleção recusa texto que não é identificador de opção');
select throws_ok(format($i$ select set_custom_field_values('lead', %L::uuid, jsonb_build_array(jsonb_build_object('definition_id', %L, 'value', '00000000-0000-0000-0000-0000000000bb'))) $i$, :'lead_ana', :'def_lead_sel'), 'P0001', 'custom_field_invalid_option', 'seleção recusa opção inexistente');
-- Forma do envio.
select throws_ok(format($i$ select set_custom_field_values('lead', %L::uuid, jsonb_build_array(jsonb_build_object('definition_id', %L, 'value', 1), jsonb_build_object('definition_id', %L, 'value', 2))) $i$, :'lead_ana', :'def_lead_numero', :'def_lead_numero'), 'P0001', 'custom_field_invalid_value', 'a mesma definição duas vezes no mesmo envio é recusada');
select throws_ok(format($i$ select set_custom_field_values('lead', %L::uuid, '{"definition_id":"x"}'::jsonb) $i$, :'lead_ana'), 'P0001', 'custom_field_invalid_value', 'envio que não é lista é recusado');
select throws_ok(format($i$ select set_custom_field_values('lead', %L::uuid, jsonb_build_array(jsonb_build_object('definition_id', %L, 'value', 1, 'workspace_id', %L))) $i$, :'lead_ana', :'def_lead_numero', :'ws_dois'), 'P0001', 'custom_field_invalid_value', 'o envio não aceita workspace nem outra chave');

-- =====================================================================
-- 6) Entidade, workspace e registro
-- =====================================================================

-- Definição de uma entidade não aceita registro de outra.
select throws_ok(format($i$ select set_custom_field_values('contact', %L::uuid, jsonb_build_array(jsonb_build_object('definition_id', %L, 'value', 1))) $i$, :'contato', :'def_lead_numero'), 'P0001', 'custom_field_not_found', 'definição de lead não grava em contato');
select throws_ok(format($i$ select set_custom_field_values('lead', %L::uuid, jsonb_build_array(jsonb_build_object('definition_id', %L, 'value', 'x'))) $i$, :'lead_ana', :'def_contact_texto'), 'P0001', 'custom_field_not_found', 'definição de contato não grava em lead');
-- Definição de outro workspace.
select throws_ok(format($i$ select set_custom_field_values('contact', %L::uuid, jsonb_build_array(jsonb_build_object('definition_id', %L, 'value', 'x'))) $i$, :'contato', :'def_dois_texto'), 'P0001', 'custom_field_not_found', 'definição de OUTRO workspace é recusada (responde como inexistente)');
-- Registro de outro workspace / inexistente / entidade inválida.
select throws_ok(format($i$ select set_custom_field_values('contact', %L::uuid, jsonb_build_array(jsonb_build_object('definition_id', %L, 'value', 'x'))) $i$, :'contato_dois', :'def_contact_texto'), 'P0001', 'custom_field_record_not_found', 'registro de outro workspace responde "não encontrado"');
select throws_ok(format($i$ select get_custom_field_values('contact', %L::uuid) $i$, :'contato_dois'), 'P0001', 'custom_field_record_not_found', 'e na leitura também');
select throws_ok($i$ select get_custom_field_values('lead', '00000000-0000-0000-0000-0000000000cc') $i$, 'P0001', 'custom_field_record_not_found', 'registro inexistente responde "não encontrado"');
select throws_ok(format($i$ select get_custom_field_values('proposal', %L::uuid) $i$, :'contato'), 'P0001', 'custom_field_invalid_entity', 'entidade fora da lista fechada é recusada na leitura');
select throws_ok(format($i$ select get_custom_field_values('lead', %L::uuid) $i$, :'contato'), 'P0001', 'custom_field_record_not_found', 'id de contato com entidade "lead" não é encontrado (a entidade vem da chamada, não do registro)');

-- Constraints do banco (por fora das funções), como dono do banco.
reset role;
select throws_ok(
  format($i$ insert into public.custom_field_values (workspace_id, definition_id, entity_type, field_type, contact_id, value_text)
             values (%L::uuid, %L::uuid, 'contact', 'text', %L::uuid, 'x') $i$, :'ws_um', :'def_contact_texto', :'contato_dois'),
  '23503', null, 'no banco: definição e registro de workspaces diferentes são recusados (FK composta)'
);
select throws_ok(
  format($i$ insert into public.custom_field_values (workspace_id, definition_id, entity_type, field_type, contact_id, value_text)
             values (%L::uuid, %L::uuid, 'contact', 'text', %L::uuid, 'x') $i$, :'ws_um', :'def_lead_numero', :'contato'),
  '23503', null, 'no banco: definição de lead gravada como contato é recusada (entidade presa à definição)'
);
select throws_ok(
  format($i$ insert into public.custom_field_values (workspace_id, definition_id, entity_type, field_type, lead_id, value_text)
             values (%L::uuid, %L::uuid, 'lead', 'text', %L::uuid, 'x') $i$, :'ws_um', :'def_lead_data', :'lead_carla'),
  '23503', null, 'no banco: o tipo do valor é preso ao tipo da definição'
);
select throws_ok(
  format($i$ insert into public.custom_field_values (workspace_id, definition_id, entity_type, field_type, client_id, option_id)
             values (%L::uuid, %L::uuid, 'client', 'select', %L::uuid, %L::uuid) $i$, :'ws_um', :'def_client_sel', :'client_b', :'opt_recurs'),
  '23503', null, 'no banco: opção de outra definição é recusada (FK composta)'
);
select throws_ok(
  format($i$ insert into public.custom_field_values (workspace_id, definition_id, entity_type, field_type, lead_id, value_number)
             values (%L::uuid, %L::uuid, 'lead', 'number', '00000000-0000-0000-0000-0000000000dd', 1) $i$, :'ws_um', :'def_lead_numero'),
  '23503', null, 'no banco: registro inexistente é recusado'
);
select throws_ok(
  format($i$ insert into public.custom_field_values (workspace_id, definition_id, entity_type, field_type, lead_id, value_number)
             values (%L::uuid, %L::uuid, 'lead', 'number', %L::uuid, 2) $i$, :'ws_um', :'def_lead_numero', :'lead_ana'),
  '23505', null, 'no banco: no máximo um valor por definição e registro'
);
select throws_ok(
  format($i$ insert into public.custom_field_values (workspace_id, definition_id, entity_type, field_type, lead_id, value_number, value_text)
             values (%L::uuid, %L::uuid, 'lead', 'number', %L::uuid, 2, 'misturado') $i$, :'ws_um', :'def_lead_numero', :'lead_carla'),
  '23514', null, 'no banco: duas colunas de valor ao mesmo tempo são recusadas (nada de JSON misturado)'
);
select throws_ok(
  format($i$ insert into public.custom_field_values (workspace_id, definition_id, entity_type, field_type, lead_id, contact_id, value_number)
             values (%L::uuid, %L::uuid, 'lead', 'number', %L::uuid, %L::uuid, 2) $i$, :'ws_um', :'def_lead_numero', :'lead_carla', :'contato'),
  '23514', null, 'no banco: dois registros ao mesmo tempo são recusados'
);

-- =====================================================================
-- 7) Atomicidade: falha no meio não deixa valor parcial
-- =====================================================================

set local role authenticated;
select pg_temp.login(:'ana'::uuid);
select throws_ok(
  format($i$ select set_custom_field_values('lead', %L::uuid, jsonb_build_array(
        jsonb_build_object('definition_id', %L, 'value', 99999),
        jsonb_build_object('definition_id', %L, 'value', '2027-01-01'),
        jsonb_build_object('definition_id', %L, 'value', 'invalido'))) $i$,
        :'lead_ana', :'def_lead_numero', :'def_lead_data', :'def_lead_sel'),
  'P0001', 'custom_field_invalid_option', 'um item inválido no fim desfaz a chamada inteira'
);
reset role;
select is(pg_temp.stored((:'def_lead_numero')::uuid, (:'lead_ana')::uuid), '50000.0000', 'o primeiro item NÃO ficou gravado (valor anterior intacto)');
select is(pg_temp.stored((:'def_lead_data')::uuid, (:'lead_ana')::uuid), '2026-12-15', 'o segundo item também não');

-- Valor igual ao atual não grava nem audita; vazio limpa sem apagar a linha.
select pg_temp.n('select count(*) from public.audit_logs where action = ''custom_field.value_set''') as aud_antes \gset
set local role authenticated;
select pg_temp.login(:'ana'::uuid);
select is(set_custom_field_values('lead', (:'lead_ana')::uuid, jsonb_build_array(jsonb_build_object('definition_id', :'def_lead_numero', 'value', 50000))), 0, 'regravar o mesmo valor não muda nada');
select is(set_custom_field_values('lead', (:'lead_ana')::uuid, jsonb_build_array(jsonb_build_object('definition_id', :'def_lead_data', 'value', null))), 1, 'valor vazio limpa o campo');
reset role;
select is(pg_temp.rows_of((:'def_lead_data')::uuid, (:'lead_ana')::uuid), 1::bigint, 'limpar mantém a linha (nada é apagado pela interface)');
select is(pg_temp.stored((:'def_lead_data')::uuid, (:'lead_ana')::uuid), null, 'e o valor fica vazio');
select is(pg_temp.n('select count(*) from public.audit_logs where action = ''custom_field.value_set'''), (:'aud_antes')::bigint + 1, 'só a alteração real foi auditada');

-- =====================================================================
-- 8) Leitura: campos ativos com o valor atual
-- =====================================================================

set local role authenticated;
select pg_temp.login(:'ana'::uuid);
select get_custom_field_values('lead', (:'lead_ana')::uuid) as lido_lead \gset
select is(
  (select array_agg(e ->> 'name' order by (e ->> 'position')::int, e ->> 'name') from jsonb_array_elements(:'lido_lead'::jsonb) e),
  array['Valor da causa', 'Data da audiência', 'Fase do processo'], 'o lead lista seus campos ativos, por posição'
);
select is((select e -> 'value' from jsonb_array_elements(:'lido_lead'::jsonb) e where e ->> 'name' = 'Valor da causa'), '50000.0000'::jsonb, 'devolve o valor do número');
select is((select e ->> 'value' from jsonb_array_elements(:'lido_lead'::jsonb) e where e ->> 'name' = 'Fase do processo'), :'opt_recurs', 'devolve a opção escolhida (identificador)');
select is((select jsonb_array_length(e -> 'options') from jsonb_array_elements(:'lido_lead'::jsonb) e where e ->> 'name' = 'Fase do processo'), 3, 'e as opções da definição');
select is(get_custom_field_values('lead', (:'lead_livre')::uuid) -> 0 -> 'value', 'null'::jsonb, 'registro sem valor devolve null');

-- =====================================================================
-- 9) Permissão e alcance por entidade
-- =====================================================================

-- Visualizador lê, mas não edita (nenhuma das quatro entidades).
select pg_temp.login(:'elisa'::uuid);
select lives_ok(format($i$ select get_custom_field_values('contact', %L::uuid) $i$, :'contato'), 'visualizador lê os campos do contato');
select lives_ok(format($i$ select get_custom_field_values('lead', %L::uuid) $i$, :'lead_ana'), 'e do lead');
select lives_ok(format($i$ select get_custom_field_values('opportunity', %L::uuid) $i$, :'opp_ana'), 'e da oportunidade');
select lives_ok(format($i$ select get_custom_field_values('client', %L::uuid) $i$, :'client_a'), 'e do cliente');
select throws_ok(format($i$ select set_custom_field_values('contact', %L::uuid, jsonb_build_array(jsonb_build_object('definition_id', %L, 'value', 'x'))) $i$, :'contato', :'def_contact_texto'), 'P0001', 'insufficient_permission', 'visualizador não edita contato');
select throws_ok(format($i$ select set_custom_field_values('lead', %L::uuid, jsonb_build_array(jsonb_build_object('definition_id', %L, 'value', 1))) $i$, :'lead_ana', :'def_lead_numero'), 'P0001', 'insufficient_permission', 'nem lead');
select throws_ok(format($i$ select set_custom_field_values('opportunity', %L::uuid, jsonb_build_array(jsonb_build_object('definition_id', %L, 'value', true))) $i$, :'opp_ana', :'def_opp_bool'), 'P0001', 'insufficient_permission', 'nem oportunidade');
select throws_ok(format($i$ select set_custom_field_values('client', %L::uuid, jsonb_build_array(jsonb_build_object('definition_id', %L, 'value', 'x'))) $i$, :'client_a', :'def_client_texto'), 'P0001', 'insufficient_permission', 'nem cliente');

-- Advogada: só leads/oportunidades "seus + sem responsável"; cliente só com alcance.
select pg_temp.login(:'carla'::uuid);
select throws_ok(format($i$ select get_custom_field_values('lead', %L::uuid) $i$, :'lead_ana'), 'P0001', 'custom_field_record_not_found', 'advogada não lê campos de lead de outro responsável (campo não amplia o acesso)');
select throws_ok(format($i$ select set_custom_field_values('lead', %L::uuid, jsonb_build_array(jsonb_build_object('definition_id', %L, 'value', 1))) $i$, :'lead_ana', :'def_lead_numero'), 'P0001', 'custom_field_record_not_found', 'nem grava');
select throws_ok(format($i$ select get_custom_field_values('opportunity', %L::uuid) $i$, :'opp_ana'), 'P0001', 'custom_field_record_not_found', 'a oportunidade segue o lead pai');
select throws_ok(format($i$ select get_custom_field_values('client', %L::uuid) $i$, :'client_a'), 'P0001', 'custom_field_record_not_found', 'cliente sem negociação ao alcance dela não aparece');
select is(set_custom_field_values('lead', (:'lead_carla')::uuid, jsonb_build_array(jsonb_build_object('definition_id', :'def_lead_numero', 'value', 7))), 1, 'advogada edita o lead que é dela');
select is(set_custom_field_values('lead', (:'lead_livre')::uuid, jsonb_build_array(jsonb_build_object('definition_id', :'def_lead_numero', 'value', 8))), 1, 'e o lead sem responsável');
select is(set_custom_field_values('opportunity', (:'opp_carla')::uuid, jsonb_build_array(jsonb_build_object('definition_id', :'def_opp_bool', 'value', true))), 1, 'e a oportunidade dele');
select lives_ok(format($i$ select get_custom_field_values('client', %L::uuid) $i$, :'client_b'), 'advogada lê o cliente que tem negociação dela');
select throws_ok(format($i$ select set_custom_field_values('client', %L::uuid, jsonb_build_array(jsonb_build_object('definition_id', %L, 'value', 'x'))) $i$, :'client_b', :'def_client_texto'), 'P0001', 'insufficient_permission', 'mas não edita cliente (só owner, admin e manager)');
select is(set_custom_field_values('contact', (:'contato')::uuid, jsonb_build_array(jsonb_build_object('definition_id', :'def_contact_texto', 'value', 'Atualizado pela advogada'))), 1, 'advogada edita contato (contact.edit)');

-- Atendimento (Daniel agora é sales): edita lead/contato; cliente só lê.
select pg_temp.login(:'daniel'::uuid);
select is(set_custom_field_values('lead', (:'lead_ana')::uuid, jsonb_build_array(jsonb_build_object('definition_id', :'def_lead_numero', 'value', 60000))), 1, 'atendimento edita lead (sem a restrição de linha da advogada)');
select throws_ok(format($i$ select set_custom_field_values('client', %L::uuid, jsonb_build_array(jsonb_build_object('definition_id', %L, 'value', 'x'))) $i$, :'client_a', :'def_client_texto'), 'P0001', 'insufficient_permission', 'atendimento não edita cliente');

-- Gestor edita cliente.
reset role;
update public.memberships set role = 'manager' where workspace_id = :'ws_um'::uuid and user_id = :'daniel'::uuid;
set local role authenticated;
select pg_temp.login(:'daniel'::uuid);
select is(set_custom_field_values('client', (:'client_a')::uuid, jsonb_build_array(jsonb_build_object('definition_id', :'def_client_texto', 'value', 'Cliente prioritário'))), 1, 'gestor edita cliente (client.manage)');

-- Quem não é membro do workspace do registro.
select pg_temp.login(:'elisa'::uuid);
select throws_ok(format($i$ select get_custom_field_values('contact', %L::uuid) $i$, :'contato_dois'), 'P0001', 'custom_field_record_not_found', 'não membro: registro do outro workspace responde "não encontrado"');
select throws_ok(format($i$ select list_custom_field_definitions(%L::uuid) $i$, :'ws_dois'), 'P0001', 'insufficient_permission', 'e não lista as definições dele');

-- =====================================================================
-- 10) Arquivamento
-- =====================================================================

select pg_temp.login(:'ana'::uuid);
select set_custom_field_archived(:'def_lead_numero'::uuid, true);
reset role;
select is(pg_temp.stored((:'def_lead_numero')::uuid, (:'lead_ana')::uuid), '60000.0000', 'arquivar preserva os valores existentes');
select is((select archived_at is not null from public.custom_field_definitions where id = (:'def_lead_numero')::uuid), true, 'a definição fica arquivada (não é apagada)');
set local role authenticated;
select pg_temp.login(:'ana'::uuid);
select is(
  (select array_agg(e ->> 'name') from jsonb_array_elements(get_custom_field_values('lead', (:'lead_ana')::uuid)) e where e ->> 'name' = 'Valor da causa'),
  null, 'o campo arquivado some dos formulários ativos'
);
select throws_ok(format($i$ select set_custom_field_values('lead', %L::uuid, jsonb_build_array(jsonb_build_object('definition_id', %L, 'value', 1))) $i$, :'lead_ana', :'def_lead_numero'), 'P0001', 'custom_field_archived', 'não se grava em campo arquivado');
select throws_ok(format($i$ select update_custom_field(%L::uuid, 'Outro nome') $i$, :'def_lead_numero'), 'P0001', 'custom_field_archived', 'nem se edita a definição arquivada');
select lives_ok(format($i$ select create_custom_field(%L::uuid, 'lead', 'Valor da causa', 'text') $i$, :'ws_um'), 'o nome do campo arquivado pode ser reutilizado');
select throws_ok(format($i$ select set_custom_field_archived(%L::uuid, false) $i$, :'def_lead_numero'), 'P0001', 'custom_field_name_taken', 'restaurar com o nome já ocupado por um ativo é recusado');
select is(jsonb_array_length(list_custom_field_definitions(:'ws_um'::uuid)) > 9, true, 'a administração ainda lista a arquivada');
select is((select e ->> 'archived' from jsonb_array_elements(list_custom_field_definitions(:'ws_um'::uuid)) e where e ->> 'id' = :'def_lead_numero'), 'true', 'marcada como arquivada');
select set_custom_field_archived(pg_temp.def_of(:'ws_um'::uuid, 'lead', 'Valor da causa'), true);
select set_custom_field_archived(:'def_lead_numero'::uuid, false);
select is(
  (select e -> 'value' from jsonb_array_elements(get_custom_field_values('lead', (:'lead_ana')::uuid)) e where e ->> 'name' = 'Valor da causa'),
  '60000.0000'::jsonb, 'restaurar devolve o campo com o valor que estava guardado'
);

-- =====================================================================
-- 11) Auditoria: só ids e a ação, nunca o valor
-- =====================================================================

select set_custom_field_values('contact', (:'contato')::uuid, jsonb_build_array(
  jsonb_build_object('definition_id', :'def_contact_texto', 'value', 'SEGREDO-CAMPO-C4 maria@exemplo.test +5511988887777'),
  jsonb_build_object('definition_id', :'def_contact_numero', 'value', 987654.321)));
reset role;
select is(
  (select array_agg(distinct action order by action) from public.audit_logs where action like 'custom_field.%'),
  array['custom_field.archived', 'custom_field.created', 'custom_field.restored', 'custom_field.updated', 'custom_field.value_set'],
  'as cinco ações são registradas (criada, alterada, arquivada, restaurada, valor)'
);
select ok(
  not exists (
    select 1 from public.audit_logs a
    where a.action like 'custom_field.%'
      and (a.metadata::text ~* 'SEGREDO|maria@|5511988887777|987654|Recursal|Conhecimento|Ouro|Cliente priorit|Atualizado pela|50000|2026-12-15'
           or a.metadata::text ~* '"(value|new_value|old_value|previous|text|label|option|name)"')
  ),
  'nenhuma auditoria contém o valor, a opção, o texto digitado, valor anterior ou novo'
);
select is(
  (select array_agg(distinct k order by k) from public.audit_logs a, jsonb_object_keys(a.metadata) k where a.action = 'custom_field.value_set'),
  array['definition_id', 'entity_type', 'record_id'], 'a auditoria do valor guarda só definição, entidade e registro'
);
select is(
  (select array_agg(distinct k order by k) from public.audit_logs a, jsonb_object_keys(a.metadata) k where a.action in ('custom_field.created', 'custom_field.updated', 'custom_field.archived', 'custom_field.restored')),
  array['entity_type'], 'a auditoria da definição guarda só a entidade (e o id no recurso)'
);
select ok(
  not exists (select 1 from public.audit_logs a where a.action like 'custom_field.%' and a.actor_user_id is null),
  'toda auditoria de campo tem a pessoa que agiu'
);

-- =====================================================================
-- 12) Telas existentes sem campos definidos continuam funcionando
-- =====================================================================

set local role authenticated;
select pg_temp.login(:'bruno'::uuid);
select lives_ok(format($i$ select get_lead(%L::uuid) $i$, :'lead_ana'), 'get_lead segue igual (campos personalizados não mudam as RPCs existentes)');
select lives_ok(format($i$ select get_opportunity(%L::uuid) $i$, :'opp_ana'), 'get_opportunity segue igual');
select lives_ok(format($i$ select get_client(%L::uuid) $i$, :'client_a'), 'get_client segue igual');
select is(get_custom_field_values('lead', (:'lead_ana')::uuid) -> 0 ->> 'name' is not null, true, 'no Um (que tem campos) a leitura devolve a lista');

-- Workspace sem nenhuma definição na entidade: lista vazia, não erro.
select pg_temp.login(:'bruno'::uuid);
select create_lead(:'ws_dois'::uuid, (:'contato_dois')::uuid, 'Trabalhista', null, '{}'::text[], 'media', null) as lead_dois \gset
select is(get_custom_field_values('lead', (:'lead_dois')::uuid), '[]'::jsonb, 'entidade sem nenhuma definição: lista vazia (a tela não mostra seção)');
reset role;

select * from finish();
rollback;
