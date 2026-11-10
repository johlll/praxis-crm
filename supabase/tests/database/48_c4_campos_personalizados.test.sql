-- C4 mínima — definições e valores tipados, permissões, isolamento,
-- arquivamento, atomicidade e auditoria sem conteúdo.

begin;
select plan(41);

\set ana    '20000000-0000-0000-0000-000000000001'
\set bruno  '20000000-0000-0000-0000-000000000002'
\set carla  '20000000-0000-0000-0000-000000000003'
\set daniel '20000000-0000-0000-0000-000000000004'
\set elisa  '20000000-0000-0000-0000-000000000005'
\set ws1    '10000000-0000-0000-0000-000000000001'
\set ws2    '10000000-0000-0000-0000-000000000002'
\set c1     'c4000000-0000-0000-0000-000000000001'
\set c2     'c4000000-0000-0000-0000-000000000002'
\set l1     'c4100000-0000-0000-0000-000000000001'
\set l2     'c4100000-0000-0000-0000-000000000002'
\set o1     'c4200000-0000-0000-0000-000000000001'
\set cl1    'c4300000-0000-0000-0000-000000000001'

create function pg_temp.login(p_user uuid) returns void language sql as $f$
  select set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true)
$f$;

insert into public.memberships (workspace_id, user_id, role, status) values
  (:'ws1', :'bruno', 'admin', 'active'),
  (:'ws1', :'daniel', 'manager', 'active');

insert into public.contacts (id, workspace_id, type, name, created_by) values
  (:'c1', :'ws1', 'pf', 'Contato C4 um', :'ana'),
  (:'c2', :'ws2', 'pf', 'Contato C4 dois', :'bruno');
insert into public.leads (id, workspace_id, contact_id, legal_area, created_by, assigned_to) values
  (:'l1', :'ws1', :'c1', 'Cível', :'ana', :'ana'),
  (:'l2', :'ws2', :'c2', 'Cível', :'bruno', :'bruno');
select id as pipe1 from public.pipelines where workspace_id = :'ws1' and is_default limit 1 \gset
select id as stage1 from public.pipeline_stages where pipeline_id = :'pipe1' order by position limit 1 \gset
insert into public.opportunities (id, workspace_id, lead_id, pipeline_id, stage_id, created_by)
values (:'o1', :'ws1', :'l1', :'pipe1', :'stage1', :'ana');
insert into public.clients (id, workspace_id, contact_id, owner_user_id)
values (:'cl1', :'ws1', :'c1', :'ana');

-- Superfície fechada.
select ok((select bool_and(relrowsecurity and relforcerowsecurity) from pg_class where oid in
  ('public.custom_field_definitions'::regclass, 'public.custom_field_options'::regclass, 'public.custom_field_values'::regclass)),
  'RLS habilitada e forçada nas três tabelas');
select ok(not has_table_privilege('authenticated', 'public.custom_field_definitions', 'select,insert,update,delete')
  and not has_table_privilege('authenticated', 'public.custom_field_options', 'select,insert,update,delete')
  and not has_table_privilege('authenticated', 'public.custom_field_values', 'select,insert,update,delete'),
  'authenticated não acessa as tabelas diretamente');
select ok((select bool_and(prosecdef and exists (select 1 from unnest(proconfig) c where c like 'search_path=%'))
  from pg_proc where pronamespace = 'public'::regnamespace and proname in
  ('list_custom_field_definitions','create_custom_field_definition','update_custom_field_definition',
   'archive_custom_field_definition','get_custom_fields_for_record','set_custom_field_value','set_custom_field_values')),
  'RPCs são SECURITY DEFINER com search_path travado');

set local role authenticated;
select pg_temp.login(:'ana');
select create_custom_field_definition(:'ws1','contact','Observação curta','short_text',0) as d_text \gset
select create_custom_field_definition(:'ws1','contact','Número interno','number',1) as d_num \gset
select create_custom_field_definition(:'ws1','contact','Data de referência','date',2) as d_date \gset
select create_custom_field_definition(:'ws1','contact','Confirmado','boolean',3) as d_bool \gset
select create_custom_field_definition(:'ws1','contact','Origem própria','single_select',4,array['Indicação','Evento']) as d_sel \gset
select create_custom_field_definition(:'ws1','lead','Campo do lead','short_text',0) as d_lead \gset
select create_custom_field_definition(:'ws1','opportunity','Campo da oportunidade','short_text',0) as d_opp \gset
select create_custom_field_definition(:'ws1','client','Campo do cliente','short_text',0) as d_client \gset
select is(jsonb_array_length(list_custom_field_definitions(:'ws1')), 8, 'owner cria e lista definições das quatro entidades');

select pg_temp.login(:'bruno');
select lives_ok(format($q$select create_custom_field_definition(%L,'contact','Campo do admin','short_text',9)$q$, :'ws1'), 'admin cria definição');
select pg_temp.login(:'daniel');
select throws_ok(format($q$select create_custom_field_definition(%L,'contact','Campo do manager','short_text',9)$q$, :'ws1'), 'P0001', 'insufficient_permission', 'manager não administra definições');
select pg_temp.login(:'carla');
select throws_ok(format($q$select list_custom_field_definitions(%L)$q$, :'ws1'), 'P0001', 'insufficient_permission', 'advogado não administra definições');
select pg_temp.login(:'elisa');
select throws_ok(format($q$select list_custom_field_definitions(%L)$q$, :'ws1'), 'P0001', 'insufficient_permission', 'viewer não administra definições');

select pg_temp.login(:'ana');
select lives_ok(format($q$select set_custom_field_value(%L,%L,%L,p_text_value=>'SEGREDO-C4')$q$, :'ws1', :'d_text', :'c1'), 'texto curto aceita texto');
select lives_ok(format($q$select set_custom_field_value(%L,%L,%L,p_number_value=>12.5)$q$, :'ws1', :'d_num', :'c1'), 'número aceita número');
select lives_ok(format($q$select set_custom_field_value(%L,%L,%L,p_date_value=>'2026-11-10')$q$, :'ws1', :'d_date', :'c1'), 'data aceita data');
select lives_ok(format($q$select set_custom_field_value(%L,%L,%L,p_boolean_value=>false)$q$, :'ws1', :'d_bool', :'c1'), 'booleano aceita false');
reset role;
select id as option1 from public.custom_field_options where definition_id = :'d_sel' and label = 'Indicação' \gset
set local role authenticated;
select pg_temp.login(:'ana');
select lives_ok(format($q$select set_custom_field_value(%L,%L,%L,p_option_id=>%L)$q$, :'ws1', :'d_sel', :'c1', :'option1'), 'seleção aceita opção da própria definição');
select is((select count(*) from public.custom_field_values where contact_id = :'c1'), 5::bigint, 'os cinco tipos foram persistidos em colunas tipadas');

select throws_ok(format($q$select set_custom_field_value(%L,%L,%L,p_number_value=>2)$q$, :'ws1', :'d_text', :'c1'), 'P0001', 'custom_field_value_type_mismatch', 'texto recusa número');
select throws_ok(format($q$select set_custom_field_value(%L,%L,%L,p_text_value=>'x')$q$, :'ws1', :'d_num', :'c1'), 'P0001', 'custom_field_value_type_mismatch', 'número recusa texto');
select throws_ok(format($q$select set_custom_field_value(%L,%L,%L,p_text_value=>'x')$q$, :'ws1', :'d_date', :'c1'), 'P0001', 'custom_field_value_type_mismatch', 'data recusa texto');
select throws_ok(format($q$select set_custom_field_value(%L,%L,%L,p_text_value=>'x')$q$, :'ws1', :'d_bool', :'c1'), 'P0001', 'custom_field_value_type_mismatch', 'booleano recusa texto');
select throws_ok(format($q$select set_custom_field_value(%L,%L,%L,p_text_value=>'x')$q$, :'ws1', :'d_sel', :'c1'), 'P0001', 'custom_field_value_type_mismatch', 'seleção recusa texto');

select create_custom_field_definition(:'ws1','contact','Outra seleção','single_select',5,array['Outra']) as d_sel2 \gset
reset role;
select id as option2 from public.custom_field_options where definition_id = :'d_sel2' limit 1 \gset
set local role authenticated;
select pg_temp.login(:'ana');
select throws_ok(format($q$select set_custom_field_value(%L,%L,%L,p_option_id=>%L)$q$, :'ws1', :'d_sel', :'c1', :'option2'), 'P0001', 'custom_field_option_not_found', 'seleção recusa opção de outra definição');
select throws_ok(format($q$select set_custom_field_value(%L,%L,%L,p_text_value=>'x')$q$, :'ws1', :'d_lead', :'c1'), 'P0001', 'custom_field_record_not_found', 'definição de lead recusa contato');
select throws_ok(format($q$select set_custom_field_value(%L,%L,%L,p_text_value=>'x')$q$, :'ws1', :'d_text', :'c2'), 'P0001', 'custom_field_record_not_found', 'definição e registro de workspaces diferentes são recusados');

select lives_ok(format($q$select set_custom_field_value(%L,%L,%L,p_text_value=>'novo')$q$, :'ws1', :'d_text', :'c1'), 'regravar a mesma definição atualiza');
select is((select count(*) from public.custom_field_values where definition_id = :'d_text' and contact_id = :'c1'), 1::bigint, 'há no máximo um valor por definição e registro');

select pg_temp.login(:'elisa');
select lives_ok(format($q$select get_custom_fields_for_record(%L,'contact',%L)$q$, :'ws1', :'c1'), 'viewer lê valores da entidade');
select throws_ok(format($q$select set_custom_field_value(%L,%L,%L,p_text_value=>'negado')$q$, :'ws1', :'d_text', :'c1'), 'P0001', 'custom_field_record_not_found', 'viewer não edita valores');
select pg_temp.login(:'carla');
select lives_ok(format($q$select set_custom_field_value(%L,%L,%L,p_text_value=>'advogado')$q$, :'ws1', :'d_text', :'c1'), 'papel com edição da entidade edita o valor');

reset role;
select throws_ok(format($q$update public.custom_field_definitions set field_type='number' where id=%L$q$, :'d_text'), 'P0001', 'custom_field_type_immutable', 'tipo não pode ser alterado após a criação');
set local role authenticated;
select pg_temp.login(:'ana');
select throws_ok(format($q$select update_custom_field_definition(%L,'Origem própria',4,'[]')$q$, :'d_sel'), 'P0001', 'custom_field_option_in_use', 'opção usada não é removida silenciosamente');

select lives_ok(format($q$select archive_custom_field_definition(%L)$q$, :'d_text'), 'owner arquiva definição');
select is((select count(*) from public.custom_field_values where definition_id = :'d_text'), 1::bigint, 'arquivamento preserva o valor');
select is(jsonb_array_length(get_custom_fields_for_record(:'ws1','contact', :'c1')), 6, 'campo arquivado sai do formulário ativo');
select throws_ok(format($q$select set_custom_field_value(%L,%L,%L,p_text_value=>'x')$q$, :'ws1', :'d_text', :'c1'), 'P0001', 'custom_field_definition_not_found', 'campo arquivado não aceita nova edição');

-- Uma falha no segundo item reverte o primeiro item do lote.
select create_custom_field_definition(:'ws1','contact','Lote A','short_text',20) as d_batch1 \gset
select create_custom_field_definition(:'ws1','contact','Lote B','number',21) as d_batch2 \gset
select throws_ok(format($q$select set_custom_field_values(%L, %L, %L::jsonb)$q$, :'ws1', :'c1',
  jsonb_build_array(jsonb_build_object('definition_id', :'d_batch1', 'text_value', 'não pode ficar'),
                    jsonb_build_object('definition_id', :'d_batch2', 'text_value', 'tipo errado'))::text),
  'P0001', 'custom_field_value_type_mismatch', 'falha no lote desfaz tudo');
select is((select count(*) from public.custom_field_values where definition_id = :'d_batch1'), 0::bigint, 'nenhum valor parcial ficou após a falha');

select ok(not exists(select 1 from public.audit_logs where metadata::text like '%SEGREDO-C4%' or metadata::text like '%advogado%'), 'auditoria nunca contém o valor');
select ok((select bool_and(metadata ? 'definition_id' and metadata ? 'entity') from public.audit_logs where action like 'custom_field.%'), 'auditoria contém somente metadados estruturais esperados');
select is(jsonb_array_length(get_custom_fields_for_record(:'ws1','opportunity', :'o1')), 1, 'oportunidade lista apenas seus campos ativos');
select is(jsonb_array_length(get_custom_fields_for_record(:'ws1','client', :'cl1')), 1, 'cliente lista apenas seus campos ativos');
select is(jsonb_array_length(get_custom_fields_for_record(:'ws1','lead', :'l1')), 1, 'lead lista apenas seus campos ativos');
select pg_temp.login(:'bruno');
select is(jsonb_array_length(get_custom_fields_for_record(:'ws2','contact', :'c2')), 0, 'workspace sem definições continua funcionando com lista vazia');

select * from finish();
rollback;
