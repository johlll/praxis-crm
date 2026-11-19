-- pgTAP — Conversas + IA, painel do caso, etapa B: número interno do caso, catálogo de tipos de serviço,
-- roteiro aplicado ao caso e marcos concluídos, convivendo com a trilha case_progress.
--
-- Prova: superfície fechada (tabelas deny-all, funções privadas inacessíveis); caso antigo sem número nem
-- roteiro continua assim (nada inventado); número único por escritório, no ganho ou por atribuição
-- explícita, repetível sem gastar outro número; catálogo só para quem configura; o roteiro aplicado é uma
-- CÓPIA (editar ou arquivar o modelo não muda o caso); concluir, avançar, voltar, reabrir e concluir o
-- serviço seguem as regras I1/I2; uma única versão para estado e roteiro (conflito e repetição pela chave);
-- trocar/remover com registros exige confirmação e preserva as conclusões; dois casos do mesmo contato não
-- se misturam; nada muda na situação do atendimento nem na etapa comercial; permissões, alcance e
-- isolamento; esqueleto anonimizado imutável; exclusão em cascata.
--
-- Fixtures do seed: ana=owner, carla=lawyer, elisa=viewer no Escritório Um; bruno=owner no Escritório Dois.
-- Aqui: bruno=sales e daniel=manager no Escritório Um. Dados sintéticos.

begin;
select plan(128);

\set ana    '20000000-0000-0000-0000-000000000001'
\set bruno  '20000000-0000-0000-0000-000000000002'
\set carla  '20000000-0000-0000-0000-000000000003'
\set daniel '20000000-0000-0000-0000-000000000004'
\set elisa  '20000000-0000-0000-0000-000000000005'
\set ws_um   '10000000-0000-0000-0000-000000000001'
\set ws_dois '10000000-0000-0000-0000-000000000002'
\set ninguem '99999999-0000-0000-0000-000000000099'

insert into public.memberships (workspace_id, user_id, role, status) values
  (:'ws_um'::uuid, :'bruno'::uuid, 'sales', 'active'),
  (:'ws_um'::uuid, :'daniel'::uuid, 'manager', 'active');

create function pg_temp.login(p_user uuid) returns void language sql as $f$
  select set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true)
$f$;

-- Leituras de apoio como dono do banco (as tabelas são deny-all para os papéis de API).
create function pg_temp.n(p_sql text) returns bigint language plpgsql security definer as $f$
declare v bigint;
begin
  execute p_sql into v;
  return v;
end;
$f$;
create function pg_temp.t(p_sql text) returns text language plpgsql security definer as $f$
declare v text;
begin
  execute p_sql into v;
  return v;
end;
$f$;
-- Id da etapa N do roteiro ATIVO do caso.
create function pg_temp.etapa(p_opp uuid, p_pos int) returns uuid language sql security definer as $f$
  select s.id from public.case_service_plan_steps s join public.case_service_plans p on p.id = s.plan_id
  where p.opportunity_id = p_opp and p.status = 'active' and s.position = p_pos
$f$;
create function pg_temp.versao(p_opp uuid) returns bigint language sql security definer as $f$
  select coalesce((select version from public.status_tracks where opportunity_id = p_opp and track = 'case_progress'), 0)
$f$;

-- ---------------------------------------------------------------------
-- Dados de apoio
-- ---------------------------------------------------------------------

set local role authenticated;
select pg_temp.login(:'ana'::uuid);
-- Contato S com dois leads (um da Ana, outro sem responsável): A e B ganhos, C aberto, D perdido.
select (create_contact(:'ws_um'::uuid, 'pf', 'Sara Serviço', null, null, null)).id as cs \gset
select create_lead(:'ws_um'::uuid, (:'cs')::uuid, 'Imobiliário', 'S1', '{}'::text[], 'media', :'ana'::uuid) as ls1 \gset
select create_lead(:'ws_um'::uuid, (:'cs')::uuid, 'Família', 'S2', '{}'::text[], 'media', null) as ls2 \gset
select create_opportunity((:'ls1')::uuid) as opa \gset
select create_opportunity((:'ls2')::uuid) as opb \gset
select create_opportunity((:'ls1')::uuid) as opc \gset
select create_opportunity((:'ls1')::uuid) as opd \gset
select create_opportunity((:'ls1')::uuid) as opv \gset
select pg_temp.login(:'bruno'::uuid);
select (create_contact(:'ws_dois'::uuid, 'pf', 'Zeca Serviço', null, null, null)).id as cz \gset
select create_lead(:'ws_dois'::uuid, (:'cz')::uuid, 'Cível', 'Z', '{}'::text[], 'media', :'bruno'::uuid) as lz \gset
select create_opportunity((:'lz')::uuid) as oz \gset
reset role;

-- "Caso antigo": V foi ganho ANTES desta etapa — sem número e sem roteiro. (O ganho é feito agora e o
-- número que o gatilho deu é retirado, reproduzindo exatamente o estado de um caso anterior.)
set local role authenticated;
select pg_temp.login(:'ana'::uuid);
select win_opportunity((:'opv')::uuid, 0, 100000, 'fixed');
reset role;
delete from public.opportunity_case_numbers where opportunity_id = (:'opv')::uuid;
update public.case_number_counters set last_value = 0 where workspace_id = (:'ws_um')::uuid;

insert into public.whatsapp_channels (workspace_id, label, display_phone_number, created_by, provider, is_simulator, environment, routing_key) values
  (:'ws_um'::uuid, 'Canal serviço', '+5541900005900', :'ana'::uuid, 'ycloud', false, 'preview', 'rota-59-um')
  returning id as canal \gset
insert into public.whatsapp_identities (workspace_id, channel_id, provider, environment, phone_e164)
  values (:'ws_um'::uuid, (:'canal')::uuid, 'ycloud', 'preview', '+5541999995901') returning id as ident \gset
insert into public.conversations (workspace_id, channel_id, identity_id, contact_id, lead_id, opportunity_id)
  values (:'ws_um'::uuid, (:'canal')::uuid, (:'ident')::uuid, (:'cs')::uuid, (:'ls1')::uuid, (:'opv')::uuid) returning id as conv \gset

-- =====================================================================
-- 1) Superfície
-- =====================================================================

select is(
  pg_temp.n($q$select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname in ('case_number_counters', 'opportunity_case_numbers', 'service_types',
      'service_type_steps', 'case_service_plans', 'case_service_plan_steps', 'case_service_events')
      and c.relrowsecurity and c.relforcerowsecurity$q$),
  7::bigint, 'as sete tabelas novas têm RLS ligada e forçada');
select is(
  pg_temp.n($q$select count(*) from information_schema.role_table_grants
    where table_schema = 'public' and grantee in ('anon', 'authenticated')
      and table_name in ('case_number_counters', 'opportunity_case_numbers', 'service_types',
        'service_type_steps', 'case_service_plans', 'case_service_plan_steps', 'case_service_events')$q$),
  0::bigint, 'nenhum privilégio de tabela para anon ou authenticated');
select is(
  pg_temp.n($q$select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'private' and (p.proname like 'case_service%' or p.proname like 'case_number%' or p.proname like 'service_type%'
      or p.proname in ('service_text_clean', 'user_display_name'))
      and (has_function_privilege('authenticated', p.oid, 'execute') or has_function_privilege('anon', p.oid, 'execute')
        or has_function_privilege('service_role', p.oid, 'execute'))$q$),
  0::bigint, 'nenhuma função privada nova é chamável por papel de API');
select is(
  pg_temp.n($q$select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ('assign_opportunity_case_number', 'create_service_type', 'update_service_type',
      'set_service_type_archived', 'list_service_types', 'get_case_service', 'list_case_service_history',
      'apply_case_service_plan', 'replace_case_service_plan', 'remove_case_service_plan', 'complete_case_service_step',
      'reopen_case_service_step', 'set_case_service_current_step')
      and p.prosecdef and p.proconfig = array['search_path=""']
      and has_function_privilege('authenticated', p.oid, 'execute') and not has_function_privilege('anon', p.oid, 'execute')$q$),
  13::bigint, 'as 13 funções públicas: SECURITY DEFINER, search_path vazio, authenticated sim, anon não');
select ok(has_function_privilege('authenticated', 'public.set_opportunity_case_progress(uuid,public.case_progress_status,bigint,uuid[],uuid)', 'execute')
  and not has_function_privilege('anon', 'public.set_opportunity_case_progress(uuid,public.case_progress_status,bigint,uuid[],uuid)', 'execute'),
  'a correção do andamento recriada mantém a ACL');

-- =====================================================================
-- 2) Caso antigo: nada inventado
-- =====================================================================

set local role authenticated;
select pg_temp.login(:'ana'::uuid);
select get_case_service((:'opv')::uuid) as legado \gset
select is(:'legado'::jsonb -> 'case_number', 'null'::jsonb, 'caso antigo: sem número interno');
select is(:'legado'::jsonb -> 'plan', 'null'::jsonb, 'caso antigo: sem roteiro');
select is(:'legado'::jsonb ->> 'status', 'nao_informado', 'caso antigo: andamento não informado');
select is((:'legado'::jsonb ->> 'version')::int, 0, 'caso antigo: versão 0');
select is((:'legado'::jsonb ->> 'previous_plans')::int, 0, 'caso antigo: nenhum roteiro anterior');
select ok(
  (select e ? 'case_number' and e -> 'case_number' = 'null'::jsonb and e -> 'service_type_name' = 'null'::jsonb
     and e -> 'service_step_name' = 'null'::jsonb and e -> 'service_steps_total' = 'null'::jsonb
   from jsonb_array_elements(public.list_conversation_case_options((:'conv')::uuid) -> 'items') e
   where e ->> 'opportunity_id' = :'opv'),
  'item de caso do painel: chaves novas presentes e nulas para o caso antigo');
select is(
  (select e -> 'case' ->> 'case_number' from public.list_conversation_inbox(:'ws_um'::uuid, 1, 100) r, jsonb_array_elements(r.items) e
   where e ->> 'id' = :'conv'),
  null, 'lista de conversas: caso antigo sem número');

-- =====================================================================
-- 3) Número interno
-- =====================================================================

select win_opportunity((:'opa')::uuid, 0, 100000, 'fixed');
select win_opportunity((:'opb')::uuid, 0, 50000, 'fixed');
select is((get_case_service((:'opa')::uuid) -> 'case_number' ->> 'number')::int, 1, 'o primeiro ganho recebe o número 1');
select is((get_case_service((:'opb')::uuid) -> 'case_number' ->> 'number')::int, 2, 'o segundo ganho recebe o número 2');
select is(get_case_service((:'opa')::uuid) -> 'case_number' ->> 'assigned_via', 'win', 'atribuído no ganho');
select is((assign_opportunity_case_number((:'opv')::uuid) ->> 'number')::int, 3, 'caso antigo: número só por atribuição explícita');
select is(assign_opportunity_case_number((:'opv')::uuid) ->> 'assigned_now', 'false', 'repetir devolve o mesmo número (assigned_now=false)');
select is((assign_opportunity_case_number((:'opv')::uuid) ->> 'number')::int, 3, 'repetir não gasta outro número');
select is((assign_opportunity_case_number((:'opc')::uuid) ->> 'number')::int, 4, 'caso aberto também pode receber número, por escolha');
reset role;
select is(pg_temp.n($q$select count(*) from public.audit_logs where action = 'opportunity.case_number_assigned'$q$), 2::bigint,
  'auditoria só nas duas atribuições explícitas efetivas');
select is(pg_temp.n(format('select last_value from public.case_number_counters where workspace_id = %L', :'ws_um')), 4::bigint,
  'o contador do escritório está no último número usado');
update public.opportunities set status = 'lost', lost_reason_id = (select id from public.lost_reasons where workspace_id = (:'ws_um')::uuid order by position limit 1) where id = (:'opd')::uuid;
set local role authenticated;
select pg_temp.login(:'ana'::uuid);
select throws_ok(format('select assign_opportunity_case_number(%L)', :'opd'), 'P0001', 'opportunity_closed', 'caso perdido não recebe número');
select pg_temp.login(:'elisa'::uuid);
select throws_ok(format('select assign_opportunity_case_number(%L)', :'opd'), 'P0001', 'insufficient_permission', 'visualizador não atribui número');
select pg_temp.login(:'carla'::uuid);
select throws_ok(format('select assign_opportunity_case_number(%L)', :'opc'), 'P0001', 'opportunity_not_found', 'advogada fora do alcance: não encontrado');
-- O escritório Dois (bruno é dono lá) numera do 1, independente do Um.
select pg_temp.login(:'bruno'::uuid);
select is((assign_opportunity_case_number((:'oz')::uuid) ->> 'number')::int, 1, 'outro escritório: numeração própria, começando em 1');
select pg_temp.login(:'ana'::uuid);
select throws_ok(format('select assign_opportunity_case_number(%L)', :'oz'), 'P0001', 'insufficient_permission', 'caso de outro escritório: recusado');
select throws_ok(format('select get_case_service(%L)', :'oz'), 'P0001', 'insufficient_permission', 'leitura de outro escritório: recusada');
reset role;
select throws_ok(format('update public.opportunity_case_numbers set number = 99 where opportunity_id = %L', :'opa'), 'P0001', 'case_number_immutable', 'número interno é imutável');
select throws_ok(
  format('insert into public.opportunity_case_numbers (opportunity_id, workspace_id, number, assigned_via, assigned_by) values (%L, %L, 1, %L, %L)', :'opd', :'ws_um', 'manual', :'ana'),
  '23505', null, 'número repetido no mesmo escritório: recusado pelo índice único');

-- =====================================================================
-- 4) Catálogo
-- =====================================================================

set local role authenticated;
select pg_temp.login(:'daniel'::uuid);
select (create_service_type(:'ws_um'::uuid, '  Usucapião   extrajudicial ', array['Documentos', 'Análise', 'Ata notarial', 'Registro'], 'usucapiao_extrajudicial')) ->> 'id' as tipo1 \gset
select is(pg_temp.t(format('select name from public.service_types where id = %L', :'tipo1')), 'Usucapião extrajudicial', 'gestor cria tipo; nome normalizado');
select (create_service_type(:'ws_um'::uuid, 'Consultoria', array['Recebimento', 'Parecer'])) ->> 'id' as tipo2 \gset
select (create_service_type(:'ws_um'::uuid, 'Arquivado depois', array['Única'])) ->> 'id' as tipo3 \gset
select throws_ok(format('select create_service_type(%L, %L, array[%L])', :'ws_um', 'consultoria', 'X'), 'P0001', 'service_type_name_taken', 'nome repetido (ignorando maiúsculas)');
select throws_ok(format('select create_service_type(%L, %L, array[]::text[])', :'ws_um', 'Sem etapas'), 'P0001', 'service_type_invalid_steps', 'sem etapas: recusado');
select throws_ok(format('select create_service_type(%L, %L, array[%L, %L])', :'ws_um', 'Repetidas', 'Análise', 'análise'), 'P0001', 'service_type_invalid_steps', 'etapas repetidas: recusado');
select throws_ok(format('select create_service_type(%L, %L, array[%L])', :'ws_um', 'Longa', repeat('x', 81)), 'P0001', 'service_type_invalid_steps', 'etapa com mais de 80 caracteres: recusada');
select throws_ok(format('select create_service_type(%L, %L, (select array_agg(%L || g) from generate_series(1, 31) g))', :'ws_um', 'Muitas', 'Etapa '), 'P0001', 'service_type_invalid_steps', 'mais de 30 etapas: recusado');
select throws_ok(format('select create_service_type(%L, %L, array[%L])', :'ws_um', '   ', 'X'), 'P0001', 'service_type_invalid_name', 'nome vazio: recusado');
select pg_temp.login(:'carla'::uuid);
select throws_ok(format('select create_service_type(%L, %L, array[%L])', :'ws_um', 'Da advogada', 'X'), 'P0001', 'insufficient_permission', 'advogada não configura o catálogo');
select is(jsonb_array_length(list_service_types(:'ws_um'::uuid)), 3, 'advogada lê o catálogo');
select pg_temp.login(:'elisa'::uuid);
select is(jsonb_array_length(list_service_types(:'ws_um'::uuid)), 3, 'visualizador lê o catálogo');
select throws_ok(format('select update_service_type(%L, %L, array[%L], 1)', :'tipo2', 'Consultoria', 'X'), 'P0001', 'insufficient_permission', 'visualizador não edita');
select pg_temp.login(:'daniel'::uuid);
select throws_ok(format('select list_service_types(%L)', :'ws_dois'), 'P0001', 'insufficient_permission', 'catálogo de outro escritório: recusado a quem não é membro dele');
reset role;

-- =====================================================================
-- 5) Roteiro: aplicar (cópia), permissões e versão
-- =====================================================================

set local role authenticated;
select pg_temp.login(:'ana'::uuid);
select throws_ok(format('select apply_case_service_plan(%L, %L, 0)', :'opc', :'tipo1'), 'P0001', 'opportunity_not_won', 'oportunidade aberta não recebe roteiro');
select pg_temp.login(:'bruno'::uuid);
select throws_ok(format('select apply_case_service_plan(%L, %L, 0)', :'opa', :'tipo1'), 'P0001', 'insufficient_permission', 'atendimento não altera o andamento do serviço');
select pg_temp.login(:'elisa'::uuid);
select throws_ok(format('select apply_case_service_plan(%L, %L, 0)', :'opa', :'tipo1'), 'P0001', 'insufficient_permission', 'visualizador não aplica roteiro');
select pg_temp.login(:'daniel'::uuid);
select set_service_type_archived((:'tipo3')::uuid, true, 1);
select pg_temp.login(:'ana'::uuid);
select throws_ok(format('select apply_case_service_plan(%L, %L, 0)', :'opa', :'tipo3'), 'P0001', 'service_type_archived', 'tipo arquivado não é aplicado');
select throws_ok(format('select apply_case_service_plan(%L, %L, 0)', :'opa', :'ninguem'), 'P0001', 'service_type_not_found', 'tipo inexistente');
select throws_ok(format('select apply_case_service_plan(%L, %L, 0, 9)', :'opa', :'tipo1'), 'P0001', 'invalid_request', 'etapa atual inicial fora do roteiro');

select apply_case_service_plan((:'opa')::uuid, (:'tipo1')::uuid, 0, 1, 'a0000000-0000-0000-0000-000000000001'::uuid) as aplicado \gset
select is(jsonb_array_length(:'aplicado'::jsonb -> 'plan' -> 'steps'), 4, 'roteiro aplicado com as 4 etapas copiadas');
select is(:'aplicado'::jsonb -> 'plan' ->> 'current_step_id', pg_temp.etapa((:'opa')::uuid, 1)::text, 'etapa atual inicial escolhida explicitamente (1)');
select is(:'aplicado'::jsonb ->> 'status', 'nao_informado', 'aplicar o roteiro não inventa andamento');
select is((:'aplicado'::jsonb ->> 'version')::int, 1, 'a aplicação incrementa a versão da trilha case_progress');
select is(
  pg_temp.n(format('select count(*) from public.case_service_plan_steps s join public.case_service_plans p on p.id = s.plan_id where p.opportunity_id = %L and s.completed_at is not null', :'opa')),
  0::bigint, 'nenhuma etapa nasce concluída');
-- Repetição com a mesma chave: devolve o mesmo resultado, sem gravar de novo.
select is(apply_case_service_plan((:'opa')::uuid, (:'tipo1')::uuid, 0, 1, 'a0000000-0000-0000-0000-000000000001'::uuid) ->> 'replayed', 'true', 'mesma chave e mesmo pedido: repetição');
select is(pg_temp.n(format('select count(*) from public.case_service_events where opportunity_id = %L', :'opa')), 1::bigint, 'a repetição não gravou outro evento');
select throws_ok(format('select apply_case_service_plan(%L, %L, 1, null, %L)', :'opa', :'tipo2', 'a0000000-0000-0000-0000-000000000001'), 'P0001', 'idempotency_conflict', 'mesma chave com outro pedido: idempotency_conflict');
select throws_ok(format('select apply_case_service_plan(%L, %L, 1)', :'opa', :'tipo2'), 'P0001', 'service_plan_exists', 'já existe roteiro ativo: aplicar recusa (trocar é outra operação)');
select throws_ok(format('select set_case_service_current_step(%L, %L, 0)', :'opa', pg_temp.etapa((:'opa')::uuid, 2)), 'P0001', 'track_conflict', 'versão antiga: track_conflict');

-- O modelo muda depois: o caso não muda.
select pg_temp.login(:'daniel'::uuid);
select update_service_type((:'tipo1')::uuid, 'Usucapião extrajudicial', array['Documentos reunidos', 'Análise', 'Registro'], 1);
select pg_temp.login(:'ana'::uuid);
select get_case_service((:'opa')::uuid) as depois_modelo \gset
select is(
  (select string_agg(s ->> 'name', '|' order by (s ->> 'position')::int) from jsonb_array_elements(:'depois_modelo'::jsonb -> 'plan' -> 'steps') s),
  'Documentos|Análise|Ata notarial|Registro', 'editar o modelo não muda as etapas do caso');
select is((:'depois_modelo'::jsonb -> 'plan' ->> 'service_type_version')::int, 1, 'o caso guarda a versão aplicada');
select is((:'depois_modelo'::jsonb -> 'plan' ->> 'template_version')::int, 2, 'e a leitura mostra que o modelo tem versão mais nova');
select pg_temp.login(:'daniel'::uuid);
select throws_ok(format('select update_service_type(%L, %L, array[%L], 1)', :'tipo1', 'X', 'Y'), 'P0001', 'service_type_conflict', 'editar com versão antiga: service_type_conflict');
select pg_temp.login(:'ana'::uuid);

-- =====================================================================
-- 6) Etapas: concluir, avançar, voltar, etapa atual
-- =====================================================================

-- Escolher a etapa 3 como atual NÃO conclui a 1 nem a 2.
select set_case_service_current_step((:'opa')::uuid, pg_temp.etapa((:'opa')::uuid, 3), 1);
select is(
  pg_temp.n(format('select count(*) from public.case_service_plan_steps s join public.case_service_plans p on p.id = s.plan_id where p.opportunity_id = %L and s.completed_at is not null', :'opa')),
  0::bigint, 'etapa posterior escolhida como atual: nenhuma anterior é dada como concluída');
-- Voltar para a 1 (pendente) só muda a posição.
select set_case_service_current_step((:'opa')::uuid, pg_temp.etapa((:'opa')::uuid, 1), 2);
select throws_ok(format('select set_case_service_current_step(%L, %L, 3)', :'opa', pg_temp.etapa((:'opa')::uuid, 1)), 'P0001', 'service_step_unchanged', 'mesma etapa atual: service_step_unchanged');
-- Concluir a 1 (atual) e avançar para a 3: a 2 continua pendente.
select complete_case_service_step((:'opa')::uuid, pg_temp.etapa((:'opa')::uuid, 1), 3, pg_temp.etapa((:'opa')::uuid, 3)) as concl1 \gset
select is(:'concl1'::jsonb -> 'plan' ->> 'current_step_id', pg_temp.etapa((:'opa')::uuid, 3)::text, 'concluir e avançar: a etapa atual passa a ser a escolhida');
select is(
  pg_temp.t(format('select string_agg(position || %L || (completed_at is not null), %L order by position) from public.case_service_plan_steps where plan_id = (select id from public.case_service_plans where opportunity_id = %L and status = %L)', ':', ',', :'opa', 'active')),
  '1:true,2:false,3:false,4:false', 'só a etapa concluída tem conclusão; a 2 continua pendente');
select is(
  pg_temp.t(format('select completed_by::text from public.case_service_plan_steps where id = %L', pg_temp.etapa((:'opa')::uuid, 1))),
  :'ana', 'a conclusão registra quem concluiu');
select throws_ok(format('select complete_case_service_step(%L, %L, 4)', :'opa', pg_temp.etapa((:'opa')::uuid, 1)), 'P0001', 'service_step_already_completed', 'concluir de novo: recusado');
select throws_ok(format('select complete_case_service_step(%L, %L, 4, %L)', :'opa', pg_temp.etapa((:'opa')::uuid, 2), pg_temp.etapa((:'opa')::uuid, 4)), 'P0001', 'invalid_request', 'avançar a partir de uma etapa que não é a atual: recusado');
select throws_ok(format('select set_case_service_current_step(%L, %L, 4)', :'opa', pg_temp.etapa((:'opa')::uuid, 1)), 'P0001', 'service_step_completed', 'etapa concluída não vira atual sem reabrir');
-- Concluir uma etapa que não é a atual mantém a atual.
select complete_case_service_step((:'opa')::uuid, pg_temp.etapa((:'opa')::uuid, 2), 4);
select is(get_case_service((:'opa')::uuid) -> 'plan' ->> 'current_step_id', pg_temp.etapa((:'opa')::uuid, 3)::text, 'concluir outra etapa não move a etapa atual');
-- Concluir a atual sem informar a próxima: fica sem etapa atual (nunca numa etapa concluída).
select complete_case_service_step((:'opa')::uuid, pg_temp.etapa((:'opa')::uuid, 3), 5);
select is(get_case_service((:'opa')::uuid) -> 'plan' -> 'current_step_id', 'null'::jsonb, 'atual concluída sem próxima: nenhuma etapa atual');
select throws_ok(format('select complete_case_service_step(%L, %L, 6, %L)', :'opa', pg_temp.etapa((:'opa')::uuid, 4), pg_temp.etapa((:'opa')::uuid, 1)), 'P0001', 'invalid_request', 'informar próxima sem ser a atual: recusado');

-- Situação do atendimento e etapa comercial não mudam com nada disso.
select is(public.get_status_track('attendance', (:'conv')::uuid) ->> 'status', 'nao_informado', 'a situação do atendimento não mudou');
select is(pg_temp.n(format('select count(*) from public.stage_transitions where opportunity_id = %L', :'opa')), 0::bigint, 'nenhuma movimentação comercial foi gravada');

-- =====================================================================
-- 7) Convivência com case_progress (I1) e reabertura atômica
-- =====================================================================

select throws_ok(format('select set_opportunity_case_progress(%L, %L, 6)', :'opa', 'concluido'), 'P0001', 'service_steps_pending', 'concluir o serviço com etapa pendente: recusado');
select set_opportunity_case_progress((:'opa')::uuid, 'aguardando_cliente', 6);
select is(get_case_service((:'opa')::uuid) ->> 'status', 'aguardando_cliente', 'aguardar informações não mexe no roteiro');
select complete_case_service_step((:'opa')::uuid, pg_temp.etapa((:'opa')::uuid, 4), 7);
select set_opportunity_case_progress((:'opa')::uuid, 'concluido', 8);
select is(get_case_service((:'opa')::uuid) ->> 'status', 'concluido', 'todas concluídas: o serviço pode ser dado como concluído');
select throws_ok(format('select reopen_case_service_step(%L, %L, 9)', :'opa', pg_temp.etapa((:'opa')::uuid, 2)), 'P0001', 'service_reopen_status_required', 'reabrir etapa de caso concluído exige o novo andamento');
select throws_ok(format('select reopen_case_service_step(%L, %L, 9, true, %L)', :'opa', pg_temp.etapa((:'opa')::uuid, 2), 'concluido'), 'P0001', 'service_reopen_status_required', 'o novo andamento não pode ser concluído');
select throws_ok(format('select apply_case_service_plan(%L, %L, 9)', :'opa', :'tipo2'), 'P0001', 'service_plan_exists', 'caso concluído com roteiro: aplicar recusa');
select throws_ok(format('select replace_case_service_plan(%L, %L, 9, true)', :'opa', :'tipo2'), 'P0001', 'case_concluded', 'caso concluído: trocar o roteiro recusa');
select reopen_case_service_step((:'opa')::uuid, pg_temp.etapa((:'opa')::uuid, 2), 9, true, 'em_execucao') as reab \gset
select is(:'reab'::jsonb ->> 'status', 'em_execucao', 'reabrir: o andamento sai de concluído na mesma operação');
select is(:'reab'::jsonb -> 'plan' ->> 'current_step_id', pg_temp.etapa((:'opa')::uuid, 2)::text, 'reabrir e tornar atual');
select is((:'reab'::jsonb ->> 'version')::int, 10, 'uma operação, uma versão');
select is(
  pg_temp.n(format($q$select count(*) from public.status_track_events e join public.status_tracks t on t.id = e.track_id
    where t.opportunity_id = %L and e.from_status = 'concluido' and e.to_status = 'em_execucao' and e.to_version = 10$q$, :'opa')),
  1::bigint, 'a mudança do andamento entra no histórico da trilha, com a mesma versão');
select is(
  pg_temp.n(format($q$select count(*) from public.case_service_events where opportunity_id = %L and op = 'step_reopened'
    and progress_from = 'concluido' and progress_to = 'em_execucao' and to_version = 10$q$, :'opa')),
  1::bigint, 'e a reabertura entra no histórico do roteiro, com a mesma versão');
select is(
  pg_temp.n(format($q$select count(*) from public.case_service_events where opportunity_id = %L and op = 'step_completed' and step_id = %L$q$, :'opa', pg_temp.etapa((:'opa')::uuid, 2))),
  1::bigint, 'a conclusão anterior continua no histórico');
select throws_ok(format('select reopen_case_service_step(%L, %L, 10, false, %L)', :'opa', pg_temp.etapa((:'opa')::uuid, 1), 'em_analise'), 'P0001', 'invalid_request', 'fora de caso concluído, reabrir não muda o andamento');
select throws_ok(format('select reopen_case_service_step(%L, %L, 10)', :'opa', pg_temp.etapa((:'opa')::uuid, 2)), 'P0001', 'service_step_not_completed', 'reabrir etapa pendente: recusado');
-- Reabrir o SERVIÇO (sair de concluído pela correção do andamento) não reabre etapa nenhuma: testado no caso B.

-- Histórico do roteiro, como a tela lê.
select items as hist from list_case_service_history((:'opa')::uuid, null, null, 100) \gset
select is(jsonb_array_length(:'hist'::jsonb), 8, 'histórico do roteiro: uma linha por operação do roteiro (as correções do andamento ficam na trilha)');
select is(:'hist'::jsonb -> 0 ->> 'op', 'step_reopened', 'mais recente primeiro');
select is(:'hist'::jsonb -> 0 ->> 'step_name', 'Análise', 'o alvo vem com o nome da etapa copiada');
select ok((:'hist'::jsonb -> 0 ->> 'actor_name') is not null, 'o autor vem com o nome');

-- =====================================================================
-- 8) Trocar e remover, com registros
-- =====================================================================

select throws_ok(format('select replace_case_service_plan(%L, %L, 10)', :'opa', :'tipo2'), 'P0001', 'service_plan_has_records', 'trocar roteiro com conclusões exige confirmação');
select throws_ok(format('select remove_case_service_plan(%L, 10)', :'opa'), 'P0001', 'service_plan_has_records', 'remover roteiro com conclusões exige confirmação');
select pg_temp.t(format('select id::text from public.case_service_plans where opportunity_id = %L and status = %L', :'opa', 'active')) as plano_antigo \gset
select replace_case_service_plan((:'opa')::uuid, (:'tipo2')::uuid, 10, true) as trocado \gset
select is(:'trocado'::jsonb -> 'plan' ->> 'service_type_name', 'Consultoria', 'troca confirmada: roteiro novo ativo');
select is((:'trocado'::jsonb ->> 'previous_plans')::int, 1, 'o roteiro anterior fica no histórico');
select is(
  pg_temp.n(format('select count(*) from public.case_service_plan_steps where plan_id = %L and completed_at is not null', :'plano_antigo')),
  3::bigint, 'as conclusões do roteiro anterior foram preservadas');
select is(pg_temp.t(format('select status from public.case_service_plans where id = %L', :'plano_antigo')), 'replaced', 'roteiro anterior: replaced');
select is(:'trocado'::jsonb ->> 'status', 'em_execucao', 'trocar o roteiro não muda o andamento');
reset role;
select throws_ok(format('update public.case_service_plan_steps set completed_at = null, completed_by = null where plan_id = %L', :'plano_antigo'), 'P0001', 'service_plan_immutable', 'roteiro encerrado é histórico: não recebe mudança');
select throws_ok(format('update public.case_service_events set op = %L where opportunity_id = %L', 'plan_removed', :'opa'), 'P0001', 'service_history_immutable', 'histórico do roteiro é imutável');
set local role authenticated;
select pg_temp.login(:'ana'::uuid);
select remove_case_service_plan((:'opa')::uuid, 11) as removido \gset
select is(:'removido'::jsonb -> 'plan', 'null'::jsonb, 'roteiro sem conclusões removido sem confirmação');
select is((:'removido'::jsonb ->> 'previous_plans')::int, 2, 'e fica no histórico');

-- =====================================================================
-- 9) Dois casos do mesmo contato; reabrir o serviço
-- =====================================================================

select apply_case_service_plan((:'opb')::uuid, (:'tipo2')::uuid, 0, 1);
select throws_ok(format('select complete_case_service_step(%L, %L, 12)', :'opa', pg_temp.etapa((:'opb')::uuid, 1)), 'P0001', 'service_plan_missing', 'etapa do caso B não é concluída pelo caso A (sem roteiro)');
select apply_case_service_plan((:'opa')::uuid, (:'tipo2')::uuid, 12, 1);
select throws_ok(format('select complete_case_service_step(%L, %L, 13)', :'opa', pg_temp.etapa((:'opb')::uuid, 1)), 'P0001', 'service_step_not_found', 'etapa de outro caso do mesmo contato: não encontrada');
select is(pg_temp.n(format('select count(*) from public.case_service_plan_steps where plan_id = (select id from public.case_service_plans where opportunity_id = %L and status = %L) and completed_at is not null', :'opb', 'active')), 0::bigint,
  'o caso B continua sem conclusões');
select complete_case_service_step((:'opb')::uuid, pg_temp.etapa((:'opb')::uuid, 1), 1, pg_temp.etapa((:'opb')::uuid, 2));
select complete_case_service_step((:'opb')::uuid, pg_temp.etapa((:'opb')::uuid, 2), 2);
select set_opportunity_case_progress((:'opb')::uuid, 'concluido', 3);
select set_opportunity_case_progress((:'opb')::uuid, 'em_execucao', 4);
select is(pg_temp.n(format('select count(*) from public.case_service_plan_steps where plan_id = (select id from public.case_service_plans where opportunity_id = %L and status = %L) and completed_at is not null', :'opb', 'active')), 2::bigint,
  'reabrir o serviço (sair de concluído) não reabre etapa nenhuma');
select is(
  (select e ->> 'service_step_name' from jsonb_array_elements(public.list_conversation_case_options((:'conv')::uuid) -> 'items') e where e ->> 'opportunity_id' = :'opa'),
  'Recebimento', 'item de caso: etapa atual do roteiro');
select is(
  (select (e ->> 'service_steps_completed') || '/' || (e ->> 'service_steps_total') from jsonb_array_elements(public.list_conversation_case_options((:'conv')::uuid) -> 'items') e where e ->> 'opportunity_id' = :'opb'),
  '2/2', 'item de caso: contagem de etapas concluídas');
select is(
  (select (e ->> 'case_number')::int from jsonb_array_elements(public.list_conversation_case_options((:'conv')::uuid) -> 'items') e where e ->> 'opportunity_id' = :'opb'),
  2, 'item de caso: número interno');

-- Chave de idempotência usada numa correção de andamento não serve para o roteiro, e vice-versa.
select set_opportunity_case_progress((:'opb')::uuid, 'em_analise', 5, '{}'::uuid[], 'b0000000-0000-0000-0000-000000000001'::uuid);
select throws_ok(format('select set_case_service_current_step(%L, %L, 6, %L)', :'opb', pg_temp.etapa((:'opb')::uuid, 1), 'b0000000-0000-0000-0000-000000000001'), 'P0001', 'idempotency_conflict', 'chave da correção não vale para o roteiro');
select throws_ok(format('select set_opportunity_case_progress(%L, %L, 6, %L, %L)', :'opa', 'em_analise', '{}', 'a0000000-0000-0000-0000-000000000001'), 'P0001', 'idempotency_conflict', 'chave do roteiro não vale para a correção');

-- =====================================================================
-- 10) Alcance e permissões nas escritas e leituras
-- =====================================================================

select pg_temp.login(:'carla'::uuid);
select throws_ok(format('select get_case_service(%L)', :'opa'), 'P0001', 'opportunity_not_found', 'advogada: caso de lead alheio não aparece');
select is((get_case_service((:'opb')::uuid) -> 'case_number' ->> 'number')::int, 2, 'advogada lê o caso de lead sem responsável');
select ok((select (r.items -> 0) is not null from list_case_service_history((:'opb')::uuid) r), 'advogada lê o histórico no alcance');
select reopen_case_service_step((:'opb')::uuid, pg_temp.etapa((:'opb')::uuid, 1), pg_temp.versao((:'opb')::uuid), true);
select is(get_case_service((:'opb')::uuid) -> 'plan' ->> 'current_step_id', pg_temp.etapa((:'opb')::uuid, 1)::text, 'advogada altera o roteiro de caso no alcance');
select throws_ok(format('select remove_case_service_plan(%L, %s, true)', :'opa', pg_temp.versao((:'opa')::uuid)), 'P0001', 'opportunity_not_found', 'advogada não altera caso fora do alcance');
select pg_temp.login(:'elisa'::uuid);
select is((get_case_service((:'opa')::uuid) -> 'plan' ->> 'service_type_name'), 'Consultoria', 'visualizador lê');
select throws_ok(format('select set_case_service_current_step(%L, null, %s)', :'opa', pg_temp.versao((:'opa')::uuid)), 'P0001', 'insufficient_permission', 'visualizador não escreve');
select pg_temp.login(:'bruno'::uuid);
select throws_ok(format('select complete_case_service_step(%L, %L, %s)', :'opa', pg_temp.etapa((:'opa')::uuid, 1), pg_temp.versao((:'opa')::uuid)), 'P0001', 'insufficient_permission', 'atendimento não conclui etapa');
reset role;
select ok(
  not exists (select 1 from public.case_service_events e where e.workspace_id <> (select o.workspace_id from public.opportunities o where o.id = e.opportunity_id)),
  'todo evento é do escritório do próprio caso');

-- =====================================================================
-- 11) Esqueleto anonimizado imutável e exclusão em cascata
-- =====================================================================

-- Contato com um caso perdido numerado: a anonimização roda e o número fica no esqueleto.
set local role authenticated;
select pg_temp.login(:'ana'::uuid);
select (create_contact(:'ws_um'::uuid, 'pf', 'Antônio Anônimo', null, null, null)).id as can \gset
select create_lead(:'ws_um'::uuid, (:'can')::uuid, 'Trabalhista', 'AN', '{}'::text[], 'media', :'ana'::uuid) as lan \gset
select create_opportunity((:'lan')::uuid) as oan \gset
select assign_opportunity_case_number((:'oan')::uuid);
reset role;
update public.opportunities set status = 'lost', lost_reason_id = (select id from public.lost_reasons where workspace_id = (:'ws_um')::uuid order by position limit 1) where id = (:'oan')::uuid;
select lives_ok(format('select private.privacy_anonymize_contact(%L, %L)', :'ws_um', :'can'), 'anonimização roda com o caso numerado');
select is(pg_temp.n(format('select count(*) from public.opportunity_case_numbers where opportunity_id = %L', :'oan')), 1::bigint, 'o número fica no esqueleto');
select throws_ok(
  format('insert into public.case_service_plans (workspace_id, opportunity_id, service_type_name, service_type_version, applied_by) values (%L, %L, %L, 1, %L)', :'ws_um', :'oan', 'X', :'ana'),
  'P0001', 'contact_anonymized', 'esqueleto anonimizado: nada novo entra');
select throws_ok(
  format('insert into public.case_service_events (workspace_id, opportunity_id, plan_id, op, from_version, to_version, actor_user_id, request_fingerprint) values (%L, %L, %L, %L, 0, 1, %L, %L)',
    :'ws_um', :'oan', :'plano_antigo', 'plan_removed', :'ana', 'x'),
  'P0001', 'contact_anonymized', 'histórico do esqueleto anonimizado: nada novo entra');

select lives_ok(format('delete from public.opportunities where id = %L', :'opa'), 'excluir a oportunidade leva roteiros, etapas e eventos em cascata');
select is(
  pg_temp.n(format('select (select count(*) from public.case_service_plans where opportunity_id = %1$L) + (select count(*) from public.case_service_events where opportunity_id = %1$L) + (select count(*) from public.opportunity_case_numbers where opportunity_id = %1$L)', :'opa')),
  0::bigint, 'nada do caso excluído sobra');

select * from finish();
rollback;
