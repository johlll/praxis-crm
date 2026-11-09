-- pgTAP — C1 mínima: automações internas (regras, simulação, execução
-- idempotente, retry/dead-letter e histórico sanitizado).
--
-- Tudo roda numa transação só, então `now()` é constante: o "tempo passando"
-- (espera entre tentativas, ativação posterior ao evento) é simulado
-- ajustando as colunas de horário como dono do banco, sem mudar a lógica
-- testada. A prova de concorrência real fica em
-- scripts/c1-automations-concurrency-check.sh.

begin;
select plan(141);

\set ana    '20000000-0000-0000-0000-000000000001'
\set bruno  '20000000-0000-0000-0000-000000000002'
\set carla  '20000000-0000-0000-0000-000000000003'
\set daniel '20000000-0000-0000-0000-000000000004'
\set elisa  '20000000-0000-0000-0000-000000000005'
\set ws_um   '10000000-0000-0000-0000-000000000001'
\set ws_dois '10000000-0000-0000-0000-000000000002'

-- Ana: owner no Um. Bruno: admin no Um (owner no Dois). Daniel: manager no Um.
-- Carla: lawyer no Um (sales no Dois). Elisa: viewer no Um.
insert into public.memberships (workspace_id, user_id, role, status) values
  (:'ws_um'::uuid, :'bruno'::uuid, 'admin', 'active'),
  (:'ws_um'::uuid, :'daniel'::uuid, 'manager', 'active');

-- ---------------------------------------------------------------------
-- Ajudantes (só desta transação)
-- ---------------------------------------------------------------------

create function pg_temp.login(p_user uuid) returns void language sql as $f$
  select set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true)
$f$;

-- Fotografia de TUDO o que a simulação não pode tocar.
create function pg_temp.snap_negocio() returns text language sql security definer as $f$
  select md5(
    coalesce((select string_agg(a::text, ',' order by a.id) from public.activities a), '') || '|' ||
    coalesce((select string_agg(l::text, ',' order by l.id) from public.leads l), '') || '|' ||
    coalesce((select string_agg(o::text, ',' order by o.id) from public.opportunities o), '') || '|' ||
    coalesce((select string_agg(e::text, ',' order by e.id) from public.automation_events e), '') || '|' ||
    coalesce((select string_agg(x::text, ',' order by x.id) from public.automation_executions x), '')
  )
$f$;

create function pg_temp.n(p_sql text) returns bigint language plpgsql security definer as $f$
declare v bigint;
begin
  execute p_sql into v;
  return v;
end;
$f$;

create function pg_temp.rule_field(p_rule uuid, p_field text) returns text language plpgsql security definer as $f$
declare v text;
begin
  execute format('select %I::text from public.automation_rules where id = $1', p_field) into v using p_rule;
  return v;
end;
$f$;

create function pg_temp.exec_field(p_exec uuid, p_field text) returns text language plpgsql security definer as $f$
declare v text;
begin
  execute format('select %I::text from public.automation_executions where id = $1', p_field) into v using p_exec;
  return v;
end;
$f$;

-- ---------------------------------------------------------------------
-- Dados de apoio
-- ---------------------------------------------------------------------

select id as pipe_um from public.pipelines where workspace_id = :'ws_um'::uuid and is_default \gset
select id as pipe_dois from public.pipelines where workspace_id = :'ws_dois'::uuid and is_default \gset
select id as st0 from public.pipeline_stages where pipeline_id = :'pipe_um'::uuid and position = 0 \gset
select id as st1 from public.pipeline_stages where pipeline_id = :'pipe_um'::uuid and position = 1 \gset
select id as st2 from public.pipeline_stages where pipeline_id = :'pipe_um'::uuid and position = 2 \gset
select id as st_dois from public.pipeline_stages where pipeline_id = :'pipe_dois'::uuid and position = 1 \gset

-- Efeitos externos: nada disto pode crescer por causa das automações.
select
  (select count(*) from public.messages) + (select count(*) from public.conversations)
  + (select count(*) from public.whatsapp_outbox) + (select count(*) from public.outbox) as externos_antes \gset

set local role authenticated;
select pg_temp.login(:'ana'::uuid);
select (create_contact(:'ws_um'::uuid, 'pf', 'Maria Sigilosa C1', null, null, null)).id as contato \gset
select create_lead(:'ws_um'::uuid, (:'contato')::uuid, 'Trabalhista', 'Resumo sigiloso C1', '{}'::text[], 'alta', :'ana'::uuid) as lead_antigo \gset

reset role;
insert into public.contact_phones (workspace_id, contact_id, value_normalized, is_primary)
  values (:'ws_um'::uuid, (:'contato')::uuid, '+5511977776666', true);
insert into public.contact_emails (workspace_id, contact_id, value_normalized, is_primary)
  values (:'ws_um'::uuid, (:'contato')::uuid, 'maria.sigilosa.c1@exemplo.test', true);

-- Sem regra ativa, criar lead NÃO registra evento (quem não usa automação não acumula).
select is(pg_temp.n('select count(*) from public.automation_events'), 0::bigint, 'sem regra ativa, nenhum evento é registrado');

-- =====================================================================
-- 1) Superfície: RLS forçada, sem grants, funções fechadas
-- =====================================================================

select ok(
  (select bool_and(c.relrowsecurity and c.relforcerowsecurity)
   from pg_class c where c.oid in ('public.automation_rules'::regclass, 'public.automation_events'::regclass, 'public.automation_executions'::regclass)),
  'as 3 tabelas novas têm RLS habilitada E forçada'
);

select ok(
  not exists (
    select 1 from pg_policy where polrelid in ('public.automation_rules'::regclass, 'public.automation_events'::regclass, 'public.automation_executions'::regclass)
  ),
  'e nenhuma policy: o acesso é só pelas funções'
);

select ok(
  not has_table_privilege('authenticated', 'public.automation_rules', 'select,insert,update,delete')
  and not has_table_privilege('anon', 'public.automation_rules', 'select,insert,update,delete')
  and not has_table_privilege('authenticated', 'public.automation_events', 'select,insert,update,delete')
  and not has_table_privilege('anon', 'public.automation_events', 'select,insert,update,delete')
  and not has_table_privilege('authenticated', 'public.automation_executions', 'select,insert,update,delete')
  and not has_table_privilege('anon', 'public.automation_executions', 'select,insert,update,delete'),
  'authenticated e anon não têm nenhum grant nas 3 tabelas'
);

select ok(
  (select bool_and(p.prosecdef and exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%'))
   from pg_proc p
   where p.pronamespace = 'public'::regnamespace
     and p.proname in ('create_automation_rule', 'update_automation_rule', 'simulate_automation_rule',
                       'set_automation_rule_status', 'list_automation_rules', 'list_automation_executions',
                       'process_automation_events', 'process_automation_events_system')),
  'as 8 funções públicas são SECURITY DEFINER com search_path travado'
);

select ok(
  (select bool_and(p.prosecdef and exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%'))
   from pg_proc p
   where p.pronamespace = 'private'::regnamespace
     and p.proname in ('automation_capture_lead_created', 'automation_capture_stage_change', 'automation_assignee_problem',
                       'automation_validate_rule', 'automation_rule_workspace', 'automation_run_execution', 'automation_process')),
  'as funções privadas que lêem ou gravam dados também'
);

select ok(
  not exists (
    select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
    where p.oid in (
      'public.create_automation_rule(uuid, text, text, text, integer, public.lead_priority, text, uuid, public.lead_priority, text, uuid, uuid)'::regprocedure,
      'public.update_automation_rule(uuid, text, text, text, integer, public.lead_priority, text, uuid, public.lead_priority, text, uuid, uuid)'::regprocedure,
      'public.simulate_automation_rule(uuid)'::regprocedure,
      'public.set_automation_rule_status(uuid, text)'::regprocedure,
      'public.list_automation_rules(uuid)'::regprocedure,
      'public.list_automation_executions(uuid, uuid, integer)'::regprocedure,
      'public.process_automation_events(uuid, integer)'::regprocedure
    ) and a.privilege_type = 'EXECUTE' and (a.grantee = 0 or a.grantee = 'anon'::regrole)
  ),
  'nenhuma RPC pública executável por PUBLIC ou anon'
);

select ok(
  has_function_privilege('authenticated', 'public.process_automation_events(uuid, integer)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.process_automation_events_system(integer)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.process_automation_events_system(integer)', 'EXECUTE')
  and has_function_privilege('service_role', 'public.process_automation_events_system(integer)', 'EXECUTE'),
  'o processamento de todos os workspaces é só do service_role'
);

select ok(
  not has_function_privilege('authenticated', 'private.automation_process(uuid, integer)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'private.automation_run_execution(uuid)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'private.automation_validate_rule(uuid, text, text, text, integer, public.lead_priority, text, uuid, public.lead_priority, text, uuid, uuid)', 'EXECUTE')
  and not has_function_privilege('anon', 'private.automation_process(uuid, integer)', 'EXECUTE'),
  'o núcleo privado não é chamável pelo cliente'
);

-- =====================================================================
-- 2) Papéis: quem gerencia, quem só consulta, quem não entra
-- =====================================================================

set local role authenticated;

select pg_temp.login(:'ana'::uuid);
select create_automation_rule(
  :'ws_um'::uuid, 'Retorno de leads de alta prioridade', 'lead_created', 'Retornar o contato', 2, 'alta', 'lead_owner',
  p_cond_priority => 'alta'
) as r1 \gset
select ok(:'r1' is not null, 'owner cria regra');

select pg_temp.login(:'bruno'::uuid);
select lives_ok(
  format($i$ select create_automation_rule(%L::uuid, 'Regra do admin', 'lead_created', 'Revisar', 1, 'media', 'lead_owner') $i$, :'ws_um'),
  'admin cria regra'
);

select pg_temp.login(:'daniel'::uuid);
select throws_ok(
  format($i$ select create_automation_rule(%L::uuid, 'Regra do gestor', 'lead_created', 'Revisar', 1, 'media', 'lead_owner') $i$, :'ws_um'),
  'P0001', 'insufficient_permission', 'manager NÃO cria regra'
);
select throws_ok(format($i$ select simulate_automation_rule(%L::uuid) $i$, :'r1'), 'P0001', 'insufficient_permission', 'manager NÃO simula');
select throws_ok(format($i$ select set_automation_rule_status(%L::uuid, 'archived') $i$, :'r1'), 'P0001', 'insufficient_permission', 'manager NÃO muda o estado da regra');
select throws_ok(
  format($i$ select update_automation_rule(%L::uuid, 'x', 'lead_created', 'Revisar', 1, 'media', 'lead_owner') $i$, :'r1'),
  'P0001', 'insufficient_permission', 'manager NÃO edita'
);
select is(jsonb_array_length(list_automation_rules(:'ws_um'::uuid)), 2, 'manager CONSULTA as regras');
select is(jsonb_array_length(list_automation_executions(:'ws_um'::uuid)), 0, 'manager CONSULTA o histórico');

select pg_temp.login(:'carla'::uuid);
select throws_ok(format($i$ select list_automation_rules(%L::uuid) $i$, :'ws_um'), 'P0001', 'insufficient_permission', 'advogado não acessa as regras');
select throws_ok(format($i$ select list_automation_executions(%L::uuid) $i$, :'ws_um'), 'P0001', 'insufficient_permission', 'nem o histórico');
select throws_ok(
  format($i$ select create_automation_rule(%L::uuid, 'x', 'lead_created', 'Revisar', 1, 'media', 'lead_owner') $i$, :'ws_um'),
  'P0001', 'insufficient_permission', 'advogado não cria regra'
);

reset role;
update public.memberships set role = 'sales' where workspace_id = :'ws_um'::uuid and user_id = :'carla'::uuid;
set local role authenticated;
select pg_temp.login(:'carla'::uuid);
select throws_ok(format($i$ select list_automation_rules(%L::uuid) $i$, :'ws_um'), 'P0001', 'insufficient_permission', 'atendimento não acessa as regras');

select pg_temp.login(:'elisa'::uuid);
select throws_ok(format($i$ select list_automation_rules(%L::uuid) $i$, :'ws_um'), 'P0001', 'insufficient_permission', 'visualizador não acessa as regras');
select throws_ok(format($i$ select simulate_automation_rule(%L::uuid) $i$, :'r1'), 'P0001', 'insufficient_permission', 'nem simula');

select set_config('request.jwt.claims', '', true);
select throws_ok(format($i$ select list_automation_rules(%L::uuid) $i$, :'ws_um'), 'P0001', 'authentication_required', 'sem sessão: recusado');
select throws_ok(format($i$ select process_automation_events(%L::uuid) $i$, :'ws_um'), 'P0001', 'authentication_required', 'sem sessão não processa');

-- =====================================================================
-- 3) Estrutura fechada e validada
-- =====================================================================

select pg_temp.login(:'ana'::uuid);

select throws_ok(
  format($i$ select create_automation_rule(%L::uuid, 'x', 'delete_everything', 'Revisar', 1, 'media', 'lead_owner') $i$, :'ws_um'),
  'P0001', 'invalid_automation_rule', 'gatilho fora da lista é recusado'
);
select throws_ok(
  format($i$ select create_automation_rule(%L::uuid, '   ', 'lead_created', 'Revisar', 1, 'media', 'lead_owner') $i$, :'ws_um'),
  'P0001', 'invalid_automation_rule', 'nome em branco é recusado'
);
select throws_ok(
  format($i$ select create_automation_rule(%L::uuid, 'x', 'lead_created', 'Revisar', 91, 'media', 'lead_owner') $i$, :'ws_um'),
  'P0001', 'invalid_automation_rule', 'prazo acima de 90 dias é recusado'
);
select throws_ok(
  format($i$ select create_automation_rule(%L::uuid, 'x', 'lead_created', 'Revisar', -1, 'media', 'lead_owner') $i$, :'ws_um'),
  'P0001', 'invalid_automation_rule', 'prazo negativo é recusado'
);
select throws_ok(
  format($i$ select create_automation_rule(%L::uuid, 'x', 'lead_created', 'Revisar', 1, 'media', 'qualquer_coisa') $i$, :'ws_um'),
  'P0001', 'invalid_automation_rule', 'modo de responsável fora da lista é recusado'
);
select throws_ok(
  format($i$ select create_automation_rule(%L::uuid, 'x', 'lead_created', 'Revisar', 1, 'media', 'lead_owner', %L::uuid) $i$, :'ws_um', :'bruno'),
  'P0001', 'invalid_automation_rule', 'responsável informado junto do modo "responsável do lead" é recusado'
);
select throws_ok(
  format($i$ select create_automation_rule(%L::uuid, 'x', 'lead_created', 'Revisar', 1, 'media', 'user') $i$, :'ws_um'),
  'P0001', 'invalid_automation_assignee', 'modo "usuário" sem usuário é recusado'
);
select throws_ok(
  format($i$ select create_automation_rule(%L::uuid, 'x', 'lead_created', 'Revisar', 1, 'media', 'user', %L::uuid) $i$, :'ws_um', '99999999-9999-9999-9999-999999999999'),
  'P0001', 'invalid_automation_assignee', 'usuário de fora do workspace é recusado'
);
select throws_ok(
  format($i$ select create_automation_rule(%L::uuid, 'x', 'lead_created', 'Revisar', 1, 'media', 'lead_owner', null, null, null, %L::uuid) $i$, :'ws_um', :'st1'),
  'P0001', 'invalid_automation_rule', 'condição de etapa não vale para o gatilho de lead criado'
);
select throws_ok(
  format($i$ select create_automation_rule(%L::uuid, 'x', 'opportunity_stage_changed', 'Revisar', 1, 'media', 'lead_owner') $i$, :'ws_um'),
  'P0001', 'invalid_automation_rule', 'o gatilho de etapa exige a etapa de destino'
);
select throws_ok(
  format($i$ select create_automation_rule(%L::uuid, 'x', 'opportunity_stage_changed', 'Revisar', 1, 'media', 'lead_owner', null, 'alta', null, %L::uuid) $i$, :'ws_um', :'st1'),
  'P0001', 'invalid_automation_rule', 'prioridade não é condição do gatilho de etapa'
);
select throws_ok(
  format($i$ select create_automation_rule(%L::uuid, 'x', 'opportunity_stage_changed', 'Revisar', 1, 'media', 'lead_owner', null, null, null, %L::uuid) $i$, :'ws_um', :'st_dois'),
  'P0001', 'invalid_automation_stage', 'etapa de OUTRO workspace é recusada'
);
select throws_ok(
  format($i$ select create_automation_rule(%L::uuid, 'x', 'opportunity_stage_changed', 'Revisar', 1, 'media', 'lead_owner', null, null, null, %L::uuid) $i$, :'ws_um', '99999999-9999-9999-9999-999999999999'),
  'P0001', 'invalid_automation_stage', 'etapa inexistente é recusada'
);
select throws_ok(
  format($i$ select create_automation_rule(%L::uuid, 'x', 'opportunity_stage_changed', 'Revisar', 1, 'media', 'lead_owner', null, null, null, %L::uuid, %L::uuid) $i$, :'ws_um', :'st1', :'st_dois'),
  'P0001', 'invalid_automation_stage', 'etapa de origem de outro workspace é recusada'
);

-- =====================================================================
-- 4) Simulação obrigatória
-- =====================================================================

select is(pg_temp.rule_field(:'r1'::uuid, 'status'), 'draft', 'a regra nasce em rascunho');

select throws_ok(
  format($i$ select set_automation_rule_status(%L::uuid, 'active') $i$, :'r1'),
  'P0001', 'automation_simulation_required', 'ativação RECUSADA sem simulação'
);

-- Um lead dentro da janela de 30 dias, para a prévia ter o que mostrar.
select pg_temp.snap_negocio() as snap_antes \gset
select simulate_automation_rule(:'r1'::uuid) as sim1 \gset

select is(pg_temp.snap_negocio(), :'snap_antes', 'a simulação NÃO gravou atividade, evento, execução nem alterou lead ou oportunidade');
select is((:'sim1'::jsonb ->> 'match_count')::int, 1, 'a simulação conta os registros compatíveis (1 lead de prioridade alta)');
select is(
  (select array_agg(k order by k) from jsonb_object_keys(:'sim1'::jsonb) k),
  array['match_count', 'sample', 'sample_invalid', 'version', 'window_days'],
  'a resposta da simulação tem só as chaves previstas'
);
select is(
  (select array_agg(k order by k) from jsonb_object_keys((:'sim1'::jsonb -> 'sample' -> 0)) k),
  array['assignee', 'date', 'due_date', 'legal_area', 'priority'],
  'e cada item da prévia tem só data, prioridade, área, prazo e situação do responsável'
);
select ok(
  :'sim1' !~* 'Sigilosa|maria|@|\+55|Resumo|lead_id|contact_id|assigned_to',
  'a prévia não expõe nome, telefone, e-mail, resumo nem identificadores'
);
select is(pg_temp.rule_field(:'r1'::uuid, 'simulated_version'), pg_temp.rule_field(:'r1'::uuid, 'version'), 'o único efeito é carimbar a versão simulada na regra');

select lives_ok(format($i$ select set_automation_rule_status(%L::uuid, 'active') $i$, :'r1'), 'com a simulação da versão atual, ativa');
select is(pg_temp.rule_field(:'r1'::uuid, 'status'), 'active', 'a regra está ativa');

-- Alterar gatilho, condição ou ação invalida a simulação.
select update_automation_rule(
  :'r1'::uuid, 'Retorno de leads de alta prioridade', 'lead_created', 'Retornar o contato', 3, 'alta', 'lead_owner',
  p_cond_priority => 'alta'
);
select is(pg_temp.rule_field(:'r1'::uuid, 'version'), '2', 'editar a AÇÃO (prazo) sobe a versão');
select is(pg_temp.rule_field(:'r1'::uuid, 'status'), 'paused', 'a regra que estava ativa fica PAUSADA ao ser alterada');
select throws_ok(
  format($i$ select set_automation_rule_status(%L::uuid, 'active') $i$, :'r1'),
  'P0001', 'automation_simulation_required', 'a simulação anterior não vale mais: ativar de novo exige simular'
);
select ok(
  (select (x ->> 'simulation_current')::boolean is false from jsonb_array_elements(list_automation_rules(:'ws_um'::uuid)) x where x ->> 'id' = :'r1'),
  'a listagem informa que a simulação está desatualizada'
);
select simulate_automation_rule(:'r1'::uuid) is not null as ok_sim \gset
select lives_ok(format($i$ select set_automation_rule_status(%L::uuid, 'active') $i$, :'r1'), 'simulada de novo, ativa');

select update_automation_rule(
  :'r1'::uuid, 'Retorno de leads de ALTA prioridade (renomeada)', 'lead_created', 'Retornar o contato', 3, 'alta', 'lead_owner',
  p_cond_priority => 'alta'
);
select is(pg_temp.rule_field(:'r1'::uuid, 'version'), '2', 'só renomear não muda a versão');
select is(pg_temp.rule_field(:'r1'::uuid, 'status'), 'active', 'nem tira a regra do ar');

select update_automation_rule(
  :'r1'::uuid, 'Retorno de leads de ALTA prioridade (renomeada)', 'lead_created', 'Retornar o contato', 3, 'alta', 'lead_owner',
  p_cond_priority => 'media'
);
select is(pg_temp.rule_field(:'r1'::uuid, 'version'), '3', 'editar a CONDIÇÃO sobe a versão');
select update_automation_rule(
  :'r1'::uuid, 'Retorno de leads de ALTA prioridade (renomeada)', 'lead_created', 'Retornar o contato', 3, 'alta', 'lead_owner',
  p_cond_priority => 'alta'
);
select is(pg_temp.rule_field(:'r1'::uuid, 'version'), '4', 'voltar à condição anterior também é uma alteração (nova versão)');
select simulate_automation_rule(:'r1'::uuid) is not null as ok_sim2 \gset
select set_automation_rule_status(:'r1'::uuid, 'active');

-- Arquivar é terminal.
select create_automation_rule(:'ws_um'::uuid, 'Para arquivar', 'lead_created', 'Revisar', 1, 'media', 'lead_owner') as r_arq \gset
select set_automation_rule_status(:'r_arq'::uuid, 'archived');
select is(pg_temp.rule_field(:'r_arq'::uuid, 'status'), 'archived', 'um rascunho pode ser arquivado');
select throws_ok(format($i$ select set_automation_rule_status(%L::uuid, 'active') $i$, :'r_arq'), 'P0001', 'invalid_automation_transition', 'arquivada não volta');
select throws_ok(
  format($i$ select update_automation_rule(%L::uuid, 'x', 'lead_created', 'Revisar', 1, 'media', 'lead_owner') $i$, :'r_arq'),
  'P0001', 'automation_rule_archived', 'arquivada não é editada'
);
select throws_ok(format($i$ select simulate_automation_rule(%L::uuid) $i$, :'r_arq'), 'P0001', 'automation_rule_archived', 'nem simulada');
select throws_ok(format($i$ select set_automation_rule_status(%L::uuid, 'banana') $i$, :'r1'), 'P0001', 'invalid_automation_transition', 'estado desconhecido é recusado');
select throws_ok(format($i$ select set_automation_rule_status(%L::uuid, 'paused') $i$, :'r_arq'), 'P0001', 'invalid_automation_transition', 'arquivada não pausa');

-- Defesa no banco: mesmo por fora das funções, regra ativa sem simulação da versão atual não existe.
reset role;
select throws_ok(
  format($i$ insert into public.automation_rules (workspace_id, name, status, trigger_type, action_title, action_due_days, action_assignee_mode, created_by, updated_by, activated_at)
            values (%L::uuid, 'burla', 'active', 'lead_created', 'x', 1, 'lead_owner', %L::uuid, %L::uuid, now()) $i$, :'ws_um', :'ana', :'ana'),
  '23514', null, 'o próprio banco recusa regra ativa sem simulação (CHECK)'
);
select throws_ok(
  format($i$ update public.automation_rules set status = 'active', activated_at = now(), simulated_version = version - 1 where id = %L::uuid $i$, :'r_arq'),
  '23514', null, '... e regra ativa com simulação de versão antiga (CHECK)'
);
set local role authenticated;
select pg_temp.login(:'ana'::uuid);

-- =====================================================================
-- 5) Gatilho: lead criado -> uma atividade
-- =====================================================================

select pg_temp.n('select count(*) from public.automation_events') as ev_antes \gset

-- O evento nasce na MESMA transação da operação: desfeita a operação, some o evento.
savepoint sp_atomico;
select create_lead(:'ws_um'::uuid, (:'contato')::uuid, 'Trabalhista', null, '{}'::text[], 'alta', :'ana'::uuid) as lead_desfeito \gset
select pg_temp.n('select count(*) from public.automation_events') as ev_dentro \gset
rollback to savepoint sp_atomico;
-- (a asserção fica FORA do savepoint: o contador do pgTAP também seria desfeito.)
select is((:'ev_dentro')::bigint, (:'ev_antes')::bigint + 1, 'criar um lead registra UM evento, na mesma transação');
select is(pg_temp.n('select count(*) from public.automation_events'), (:'ev_antes')::bigint, 'desfeita a operação de origem, o evento também some (nada fica órfão)');

select create_lead(:'ws_um'::uuid, (:'contato')::uuid, 'Trabalhista', null, '{}'::text[], 'alta', :'ana'::uuid) as lead_a \gset
select create_lead(:'ws_um'::uuid, (:'contato')::uuid, 'Cível', null, '{}'::text[], 'baixa', :'ana'::uuid) as lead_b \gset

reset role;
select is(pg_temp.n('select count(*) from public.automation_events where status = ''pending'''), 2::bigint, 'dois leads criados, dois eventos pendentes (a condição só vale na execução)');
-- A regra foi ativada "agora": para os leads novos valerem, a ativação precisa ser anterior aos eventos.
update public.automation_rules set activated_at = now() - interval '1 hour' where id = (:'r1')::uuid;
set local role authenticated;
select pg_temp.login(:'ana'::uuid);

select process_automation_events(:'ws_um'::uuid) as proc1 \gset
select is((:'proc1'::jsonb ->> 'events')::int, 2, 'o processamento consumiu os 2 eventos');

reset role;
select is(pg_temp.n('select count(*) from public.automation_executions'), 1::bigint, 'só o lead de prioridade alta gerou execução (a condição foi respeitada)');
select is(pg_temp.n('select count(*) from public.automation_executions where state = ''succeeded'''), 1::bigint, 'e ela foi bem-sucedida');
select is(pg_temp.n(format('select count(*) from public.activities where lead_id = %L and title = ''Retornar o contato''', :'lead_a')), 1::bigint, 'lead criado dispara UMA atividade');
select is(pg_temp.n(format('select count(*) from public.activities where lead_id = %L', :'lead_b')), 0::bigint, 'o lead que não casa a condição não ganha atividade');
select is(
  (select assigned_to::text || '|' || priority::text || '|' || type::text || '|' || has_time::text || '|' || status::text
   from public.activities where lead_id = (:'lead_a')::uuid),
  :'ana' || '|alta|task|false|pending',
  'a atividade nasce como tarefa pendente, com a prioridade da regra e o responsável ATUAL do lead'
);
select is(
  (select to_char(due_at at time zone 'America/Sao_Paulo', 'YYYY-MM-DD HH24:MI:SS') from public.activities where lead_id = (:'lead_a')::uuid),
  to_char((now() at time zone 'America/Sao_Paulo')::date + 3, 'YYYY-MM-DD') || ' 23:59:59',
  'o prazo é em dias: fim do dia, no fuso do escritório'
);
select ok(
  (select notes from public.activities where lead_id = (:'lead_a')::uuid) like 'Criada pela automação "%"%',
  'a atividade registra a origem na própria observação'
);
select is(pg_temp.n('select count(*) from public.audit_logs where action = ''activity.auto_created'' and metadata ? ''rule_id'' and actor_user_id is null'), 1::bigint, 'a criação automática fica na trilha de auditoria, sem pessoa (sistema)');

-- Idempotência: o MESMO evento reprocessado (ou processar de novo) não duplica.
update public.automation_events set status = 'pending', processed_at = null;
set local role authenticated;
select pg_temp.login(:'ana'::uuid);
select process_automation_events(:'ws_um'::uuid);
select process_automation_events(:'ws_um'::uuid);
reset role;
select is(pg_temp.n('select count(*) from public.automation_executions'), 1::bigint, 'reprocessar o evento não cria outra execução');
select is(pg_temp.n(format('select count(*) from public.activities where lead_id = %L and title = ''Retornar o contato''', :'lead_a')), 1::bigint, 'nem outra atividade (evento repetido não duplica)');

-- =====================================================================
-- 6) Gatilho: oportunidade mudou de etapa -> uma atividade
-- =====================================================================

set local role authenticated;
select pg_temp.login(:'ana'::uuid);

-- Responsável = usuário específico (Bruno, admin: tem acesso ao lead).
select create_automation_rule(
  :'ws_um'::uuid, 'Preparar qualificação', 'opportunity_stage_changed', 'Preparar a qualificação', 1, 'media', 'user',
  :'bruno'::uuid, p_cond_to_stage_id => (:'st1')::uuid
) as r2 \gset
select simulate_automation_rule(:'r2'::uuid) as sim2 \gset
select is((:'sim2'::jsonb ->> 'match_count')::int, 0, 'sem movimentações no período, a simulação do gatilho de etapa conta 0');
select set_automation_rule_status(:'r2'::uuid, 'active');

select create_opportunity(p_lead_id => (:'lead_a')::uuid, p_pipeline_id => (:'pipe_um')::uuid, p_stage_id => (:'st0')::uuid) as opp \gset
reset role;
select is(pg_temp.n('select count(*) from public.automation_events where event_type = ''opportunity_stage_changed'''), 0::bigint, 'criar a oportunidade não é "mudar de etapa": nenhum evento');
update public.automation_rules set activated_at = now() - interval '1 hour' where id = (:'r2')::uuid;

set local role authenticated;
select pg_temp.login(:'ana'::uuid);
select move_opportunity_stage((:'opp')::uuid, (:'st0')::uuid, (:'st1')::uuid, 0) is not null as moveu \gset
reset role;
select is(pg_temp.n('select count(*) from public.automation_events where event_type = ''opportunity_stage_changed'' and status = ''pending'''), 1::bigint, 'mover de etapa registra UM evento, junto da transição');
select is(
  (select count(*) from public.automation_events e join public.stage_transitions t on t.id = e.transition_id and t.opportunity_id = e.opportunity_id),
  1::bigint, 'o evento aponta para a transição que o originou'
);

set local role authenticated;
select pg_temp.login(:'ana'::uuid);
select process_automation_events(:'ws_um'::uuid);
reset role;
select is(
  (select assigned_to::text || '|' || (opportunity_id = (:'opp')::uuid)::text from public.activities where title = 'Preparar a qualificação'),
  :'bruno' || '|true',
  'mudança de etapa dispara UMA atividade, ligada à oportunidade, para o usuário específico'
);

-- Movimentação para outra etapa: o evento existe, mas a regra (destino = etapa 1) não casa.
set local role authenticated;
select pg_temp.login(:'ana'::uuid);
select move_opportunity_stage((:'opp')::uuid, (:'st1')::uuid, (:'st2')::uuid, 1) is not null as moveu2 \gset
select process_automation_events(:'ws_um'::uuid);
reset role;
select is(pg_temp.n('select count(*) from public.activities where title = ''Preparar a qualificação'''), 1::bigint, 'etapa de destino diferente da condição: nenhuma atividade nova');
select is(pg_temp.n('select count(*) from public.automation_executions where rule_id = ''' || :'r2' || ''''), 1::bigint, 'e nenhuma execução nova para a regra');

-- Movimento recusado não deixa evento.
select pg_temp.n('select count(*) from public.automation_events') as ev_total \gset
set local role authenticated;
select pg_temp.login(:'ana'::uuid);
select throws_ok(
  format($i$ select move_opportunity_stage(%L::uuid, %L::uuid, %L::uuid, 99) $i$, :'opp', :'st2', :'st1'),
  'P0001', 'opportunity_conflict', 'movimento recusado (conflito de versão)'
);
reset role;
select is(pg_temp.n('select count(*) from public.automation_events'), (:'ev_total')::bigint, 'e não deixa evento para trás');

-- =====================================================================
-- 7) Regra pausada, arquivada ou alterada não executa
-- =====================================================================

-- (a) pausada ANTES do processamento: o evento é consumido sem execução.
set local role authenticated;
select pg_temp.login(:'ana'::uuid);
select create_lead(:'ws_um'::uuid, (:'contato')::uuid, 'Trabalhista', null, '{}'::text[], 'alta', :'ana'::uuid) as lead_c \gset
reset role;
update public.automation_rules set activated_at = now() - interval '1 hour' where id = (:'r1')::uuid;
set local role authenticated;
select pg_temp.login(:'ana'::uuid);
select set_automation_rule_status(:'r1'::uuid, 'paused');
select process_automation_events(:'ws_um'::uuid);
reset role;
select is(pg_temp.n(format('select count(*) from public.activities where lead_id = %L and title = ''Retornar o contato''', :'lead_c')), 0::bigint, 'regra PAUSADA não executa');
select is(pg_temp.n(format('select count(*) from public.automation_executions x join public.automation_events e on e.id = x.event_id where e.lead_id = %L', :'lead_c')), 0::bigint, 'e nem chega a gerar execução');

-- (b) execução já criada, regra pausada/arquivada/alterada antes de rodar: CANCELADA.
-- (Uma execução por lead de apoio: o evento de origem é único por lead.)
set local role authenticated;
select pg_temp.login(:'ana'::uuid);
select create_lead(:'ws_um'::uuid, (:'contato')::uuid, 'Trabalhista', null, '{}'::text[], 'alta', :'ana'::uuid) as lead_m1 \gset
select create_lead(:'ws_um'::uuid, (:'contato')::uuid, 'Trabalhista', null, '{}'::text[], 'alta', :'ana'::uuid) as lead_m2 \gset
select create_lead(:'ws_um'::uuid, (:'contato')::uuid, 'Trabalhista', null, '{}'::text[], 'alta', :'ana'::uuid) as lead_m3 \gset
reset role;
insert into public.automation_events (workspace_id, event_type, lead_id, lead_priority, lead_legal_area, actor_user_id, status, processed_at)
  values (:'ws_um'::uuid, 'lead_created', (:'lead_m1')::uuid, 'alta', 'Trabalhista', :'ana'::uuid, 'processed', now())
  returning id as ev_manual \gset
insert into public.automation_executions (workspace_id, rule_id, event_id, rule_version)
  values (:'ws_um'::uuid, (:'r1')::uuid, (:'ev_manual')::uuid, (select version from public.automation_rules where id = (:'r1')::uuid))
  returning id as ex_pausada \gset
set local role authenticated;
select pg_temp.login(:'ana'::uuid);
select process_automation_events(:'ws_um'::uuid);
reset role;
select is(pg_temp.exec_field((:'ex_pausada')::uuid, 'state') || '|' || pg_temp.exec_field((:'ex_pausada')::uuid, 'error_code'), 'cancelled|rule_inactive', 'execução de regra pausada é cancelada (rule_inactive)');
select is(pg_temp.n(format('select count(*) from public.activities where lead_id = %L and title = ''Retornar o contato''', :'lead_m1')), 0::bigint, 'sem atividade');

-- alterada: a execução nasceu com a versão antiga.
update public.automation_rules set status = 'active', simulated_version = version, activated_at = now() - interval '2 hours' where id = (:'r1')::uuid;
insert into public.automation_events (workspace_id, event_type, lead_id, lead_priority, lead_legal_area, actor_user_id, status, processed_at)
  values (:'ws_um'::uuid, 'lead_created', (:'lead_m2')::uuid, 'alta', 'Trabalhista', :'ana'::uuid, 'processed', now())
  returning id as ev_manual2 \gset
insert into public.automation_executions (workspace_id, rule_id, event_id, rule_version)
  values (:'ws_um'::uuid, (:'r1')::uuid, (:'ev_manual2')::uuid, (select version - 1 from public.automation_rules where id = (:'r1')::uuid))
  returning id as ex_alterada \gset
set local role authenticated;
select pg_temp.login(:'ana'::uuid);
select process_automation_events(:'ws_um'::uuid);
reset role;
select is(pg_temp.exec_field((:'ex_alterada')::uuid, 'state') || '|' || pg_temp.exec_field((:'ex_alterada')::uuid, 'error_code'), 'cancelled|rule_changed', 'execução nascida de uma versão anterior da regra é cancelada (rule_changed)');

-- arquivada.
insert into public.automation_events (workspace_id, event_type, lead_id, lead_priority, lead_legal_area, actor_user_id, status, processed_at)
  values (:'ws_um'::uuid, 'lead_created', (:'lead_m3')::uuid, 'alta', 'Trabalhista', :'ana'::uuid, 'processed', now())
  returning id as ev_manual3 \gset
insert into public.automation_executions (workspace_id, rule_id, event_id, rule_version)
  values (:'ws_um'::uuid, (:'r1')::uuid, (:'ev_manual3')::uuid, (select version from public.automation_rules where id = (:'r1')::uuid))
  returning id as ex_arquivada \gset
update public.automation_rules set status = 'archived' where id = (:'r1')::uuid;
set local role authenticated;
select pg_temp.login(:'ana'::uuid);
select process_automation_events(:'ws_um'::uuid);
reset role;
select is(pg_temp.exec_field((:'ex_arquivada')::uuid, 'error_code'), 'rule_inactive', 'execução de regra ARQUIVADA é cancelada');
select is(pg_temp.n('select count(*) from public.activities where lead_id in (''' || :'lead_m1' || ''',''' || :'lead_m2' || ''',''' || :'lead_m3' || ''') and title = ''Retornar o contato'''), 0::bigint, 'nenhuma atividade nasceu das execuções canceladas');

-- (c) evento anterior à ativação da regra não a dispara.
set local role authenticated;
select pg_temp.login(:'ana'::uuid);
select create_automation_rule(:'ws_um'::uuid, 'Só leads novos', 'lead_created', 'Acompanhar lead novo', 1, 'media', 'lead_owner') as r3 \gset
select simulate_automation_rule(:'r3'::uuid) is not null as s3 \gset
select set_automation_rule_status(:'r3'::uuid, 'active');
select create_lead(:'ws_um'::uuid, (:'contato')::uuid, 'Cível', null, '{}'::text[], 'media', :'ana'::uuid) as lead_d \gset
reset role;
-- "o evento aconteceu antes da ativação": a regra passa a ter sido ativada depois dele.
update public.automation_rules set activated_at = now() + interval '1 minute' where id = (:'r3')::uuid;
set local role authenticated;
select pg_temp.login(:'ana'::uuid);
select process_automation_events(:'ws_um'::uuid);
reset role;
select is(pg_temp.n(format('select count(*) from public.activities where lead_id = %L and title = ''Acompanhar lead novo''', :'lead_d')), 0::bigint, 'evento anterior à ativação da regra não dispara a ação');
update public.automation_rules set status = 'archived' where id = (:'r3')::uuid;

-- =====================================================================
-- 8) Falha recuperável, tentativas e dead-letter
-- =====================================================================

-- Regra com responsável específico: Daniel (manager). Depois ele é suspenso.
set local role authenticated;
select pg_temp.login(:'ana'::uuid);
select create_automation_rule(:'ws_um'::uuid, 'Falha controlada', 'lead_created', 'Tarefa do Daniel', 1, 'media', 'user', :'daniel'::uuid) as r4 \gset
select simulate_automation_rule(:'r4'::uuid) is not null as s4 \gset
select set_automation_rule_status(:'r4'::uuid, 'active');
reset role;
update public.automation_rules set activated_at = now() - interval '1 hour' where id = (:'r4')::uuid;
update public.memberships set status = 'suspended' where workspace_id = :'ws_um'::uuid and user_id = :'daniel'::uuid;

set local role authenticated;
select pg_temp.login(:'ana'::uuid);
select create_lead(:'ws_um'::uuid, (:'contato')::uuid, 'Trabalhista', null, '{}'::text[], 'media', :'ana'::uuid) as lead_falha \gset
select process_automation_events(:'ws_um'::uuid);
reset role;

select x.id as ex_falha from public.automation_executions x join public.automation_events e on e.id = x.event_id
  where x.rule_id = (:'r4')::uuid and e.lead_id = (:'lead_falha')::uuid \gset
select is(
  pg_temp.exec_field((:'ex_falha')::uuid, 'state') || '|' || pg_temp.exec_field((:'ex_falha')::uuid, 'attempt_count') || '|' || pg_temp.exec_field((:'ex_falha')::uuid, 'error_code'),
  'pending|1|assignee_not_member',
  'responsável inativo: falha CONTROLADA, tentativa registrada e nova tentativa agendada'
);
select ok((select next_attempt_at > now() from public.automation_executions where id = (:'ex_falha')::uuid), 'a próxima tentativa fica no futuro (espera entre tentativas)');
select is(pg_temp.n(format('select count(*) from public.activities where lead_id = %L', :'lead_falha')), 0::bigint, 'nenhuma atividade foi criada pela execução que falhou');
select is(pg_temp.n(format('select count(*) from public.leads where id = %L', :'lead_falha')), 1::bigint, 'a falha da regra NÃO desfaz a operação original (o lead continua lá)');

set local role authenticated;
select pg_temp.login(:'ana'::uuid);
select process_automation_events(:'ws_um'::uuid);
reset role;
select is(pg_temp.exec_field((:'ex_falha')::uuid, 'attempt_count'), '1', 'enquanto a espera não vence, nada é tentado de novo');

-- Recuperável: o responsável volta, a espera vence, a nova tentativa funciona.
update public.memberships set status = 'active' where workspace_id = :'ws_um'::uuid and user_id = :'daniel'::uuid;
update public.automation_executions set next_attempt_at = now() where id = (:'ex_falha')::uuid;
set local role authenticated;
select pg_temp.login(:'ana'::uuid);
select process_automation_events(:'ws_um'::uuid);
reset role;
select is(
  pg_temp.exec_field((:'ex_falha')::uuid, 'state') || '|' || pg_temp.exec_field((:'ex_falha')::uuid, 'attempt_count') || '|' || coalesce(pg_temp.exec_field((:'ex_falha')::uuid, 'error_code'), 'sem erro'),
  'succeeded|2|sem erro',
  'falha RECUPERÁVEL: a segunda tentativa funciona, o erro é limpo e a tentativa fica contada'
);
select is(pg_temp.n(format('select count(*) from public.activities where lead_id = %L and title = ''Tarefa do Daniel''', :'lead_falha')), 1::bigint, 'e a atividade existe uma vez só');

-- Dead-letter: o responsável continua inválido; esgotadas as tentativas, é terminal.
update public.memberships set status = 'suspended' where workspace_id = :'ws_um'::uuid and user_id = :'daniel'::uuid;
set local role authenticated;
select pg_temp.login(:'ana'::uuid);
select create_lead(:'ws_um'::uuid, (:'contato')::uuid, 'Trabalhista', null, '{}'::text[], 'media', :'ana'::uuid) as lead_dl \gset
select process_automation_events(:'ws_um'::uuid);
reset role;
select x.id as ex_dl from public.automation_executions x join public.automation_events e on e.id = x.event_id
  where x.rule_id = (:'r4')::uuid and e.lead_id = (:'lead_dl')::uuid \gset

update public.automation_executions set next_attempt_at = now() where id = (:'ex_dl')::uuid;
set local role authenticated; select pg_temp.login(:'ana'::uuid); select process_automation_events(:'ws_um'::uuid); reset role;
select is(pg_temp.exec_field((:'ex_dl')::uuid, 'attempt_count') || '|' || pg_temp.exec_field((:'ex_dl')::uuid, 'state'), '2|pending', 'segunda falha: ainda pendente');
update public.automation_executions set next_attempt_at = now() where id = (:'ex_dl')::uuid;
set local role authenticated; select pg_temp.login(:'ana'::uuid); select process_automation_events(:'ws_um'::uuid); reset role;
select is(pg_temp.exec_field((:'ex_dl')::uuid, 'attempt_count') || '|' || pg_temp.exec_field((:'ex_dl')::uuid, 'state'), '3|pending', 'terceira falha: ainda pendente');
update public.automation_executions set next_attempt_at = now() where id = (:'ex_dl')::uuid;
set local role authenticated; select pg_temp.login(:'ana'::uuid); select process_automation_events(:'ws_um'::uuid); reset role;
select is(
  pg_temp.exec_field((:'ex_dl')::uuid, 'attempt_count') || '|' || pg_temp.exec_field((:'ex_dl')::uuid, 'state') || '|' || pg_temp.exec_field((:'ex_dl')::uuid, 'error_code'),
  '4|dead_letter|assignee_not_member',
  'esgotadas as 4 tentativas, a execução vira DEAD-LETTER, com o código sanitizado'
);
select ok((select finished_at is not null from public.automation_executions where id = (:'ex_dl')::uuid), 'e fica com horário de encerramento (consulta)');
update public.automation_executions set next_attempt_at = now() where id = (:'ex_dl')::uuid;
set local role authenticated; select pg_temp.login(:'ana'::uuid); select process_automation_events(:'ws_um'::uuid); reset role;
select is(pg_temp.exec_field((:'ex_dl')::uuid, 'attempt_count') || '|' || pg_temp.exec_field((:'ex_dl')::uuid, 'state'), '4|dead_letter', 'dead-letter é terminal: nada é tentado de novo');
select is(pg_temp.n(format('select count(*) from public.activities where lead_id = %L', :'lead_dl')), 0::bigint, 'nenhuma atividade para a execução em dead-letter');

-- Responsável sem acesso ao lead (advogado que não é dono): outro código controlado.
update public.memberships set status = 'active' where workspace_id = :'ws_um'::uuid and user_id = :'daniel'::uuid;
update public.memberships set role = 'lawyer' where workspace_id = :'ws_um'::uuid and user_id = :'daniel'::uuid;
set local role authenticated;
select pg_temp.login(:'ana'::uuid);
select create_lead(:'ws_um'::uuid, (:'contato')::uuid, 'Trabalhista', null, '{}'::text[], 'media', :'bruno'::uuid) as lead_sem_acesso \gset
select process_automation_events(:'ws_um'::uuid);
reset role;
select is(
  (select x.error_code from public.automation_executions x join public.automation_events e on e.id = x.event_id
   where x.rule_id = (:'r4')::uuid and e.lead_id = (:'lead_sem_acesso')::uuid),
  'assignee_no_access', 'responsável sem acesso ao lead: falha controlada com código próprio'
);
update public.memberships set role = 'manager' where workspace_id = :'ws_um'::uuid and user_id = :'daniel'::uuid;

-- Erro inesperado de banco: só o código fixo é guardado, nunca a mensagem.
create function pg_temp.explode() returns trigger language plpgsql as $f$
begin
  raise exception 'SEGREDO sk_live_ABC123 cpf 123.456.789-00 maria.sigilosa.c1@exemplo.test';
end;
$f$;
update public.memberships set status = 'active' where workspace_id = :'ws_um'::uuid and user_id = :'daniel'::uuid;
set local role authenticated;
select pg_temp.login(:'ana'::uuid);
select create_lead(:'ws_um'::uuid, (:'contato')::uuid, 'Trabalhista', null, '{}'::text[], 'media', :'ana'::uuid) as lead_boom \gset
reset role;
create trigger c1_explode before insert on public.activities for each row execute function pg_temp.explode();
set local role authenticated;
select pg_temp.login(:'ana'::uuid);
select process_automation_events(:'ws_um'::uuid);
reset role;
drop trigger c1_explode on public.activities;
select is(
  (select x.state || '|' || x.attempt_count || '|' || x.error_code from public.automation_executions x join public.automation_events e on e.id = x.event_id
   where x.rule_id = (:'r4')::uuid and e.lead_id = (:'lead_boom')::uuid),
  'pending|1|unexpected_error',
  'falha inesperada do banco vira o código fixo "unexpected_error" e agenda nova tentativa'
);
select ok(
  not exists (select 1 from public.automation_executions x where to_jsonb(x)::text ~* 'SEGREDO|sk_live|123\.456|sigilosa'),
  'a mensagem do banco (com segredo, CPF e e-mail) não foi guardada em lugar nenhum da execução'
);
select ok(
  not exists (
    select 1 from public.audit_logs a
    where (a.action like 'automation.%' or a.action = 'activity.auto_created')
      and a.metadata::text ~* 'SEGREDO|sk_live|123\.456|sigilosa|@'
  ),
  'nem na auditoria das automações'
);

-- =====================================================================
-- 9) Histórico sem dado pessoal
-- =====================================================================

set local role authenticated;
select pg_temp.login(:'daniel'::uuid);
select list_automation_executions(:'ws_um'::uuid) as hist \gset
select list_automation_rules(:'ws_um'::uuid) as regras \gset
select ok(jsonb_array_length(:'hist'::jsonb) >= 6, 'o histórico lista as execuções (sucesso, cancelada, em nova tentativa, dead-letter)');
select is(
  (select array_agg(k order by k) from (select distinct jsonb_object_keys(i) k from jsonb_array_elements(:'hist'::jsonb) i) t),
  array['activity_id', 'attempt_count', 'created_at', 'error_code', 'event_type', 'finished_at', 'id', 'last_attempt_at', 'next_attempt_at', 'rule_id', 'rule_name', 'state'],
  'cada linha do histórico tem só as chaves previstas'
);
select ok(
  :'hist' !~* 'SEGREDO|sk_live|Sigilosa|maria|@|\+55|Resumo|lead_id|contact|cpf',
  'o histórico não contém dado pessoal, segredo nem mensagem de erro'
);
select ok(
  (select bool_and(i ->> 'error_code' is null or i ->> 'error_code' in
     ('assignee_not_member', 'assignee_no_access', 'target_not_found', 'rule_inactive', 'rule_changed', 'unexpected_error'))
   from jsonb_array_elements(:'hist'::jsonb) i),
  'os códigos de erro do histórico são só os fechados'
);
select is(
  (select array_agg(k order by k) from (select distinct jsonb_object_keys(i) k from jsonb_array_elements(:'regras'::jsonb) i) t),
  array['action_assignee_mode', 'action_assignee_user_id', 'action_due_days', 'action_priority', 'action_title', 'activated_at', 'cond_from_stage_id', 'cond_legal_area', 'cond_priority', 'cond_to_stage_id', 'created_at', 'id', 'name', 'simulated_at', 'simulated_count', 'simulation_current', 'status', 'trigger_type', 'updated_at', 'version'],
  'a listagem de regras também tem só as chaves previstas'
);
select is(jsonb_array_length(list_automation_executions(:'ws_um'::uuid, :'r2'::uuid)), 1, 'o histórico pode ser filtrado por regra');
select is(jsonb_array_length(list_automation_executions(:'ws_um'::uuid, p_limit => 2)), 2, 'e limitado');
reset role;

select throws_ok(
  $i$ update public.automation_executions set error_code = 'qualquer texto livre' $i$,
  '23514', null, 'a coluna de erro do banco só aceita códigos fechados (texto livre é recusado)'
);

-- =====================================================================
-- 10) Isolamento entre workspaces
-- =====================================================================

set local role authenticated;
select pg_temp.login(:'bruno'::uuid);
select create_automation_rule(:'ws_dois'::uuid, 'Regra do Dois', 'lead_created', 'Tarefa do Dois', 1, 'media', 'lead_owner') as r_dois \gset
select simulate_automation_rule(:'r_dois'::uuid) is not null as sd \gset
select set_automation_rule_status(:'r_dois'::uuid, 'active');
reset role;
update public.automation_rules set activated_at = now() - interval '1 hour' where id = (:'r_dois')::uuid;

set local role authenticated;
select pg_temp.login(:'ana'::uuid);
select throws_ok(format($i$ select simulate_automation_rule(%L::uuid) $i$, :'r_dois'), 'P0001', 'automation_rule_not_found', 'regra de OUTRO workspace responde como não encontrada (simular)');
select throws_ok(format($i$ select set_automation_rule_status(%L::uuid, 'archived') $i$, :'r_dois'), 'P0001', 'automation_rule_not_found', '... (mudar estado)');
select throws_ok(
  format($i$ select update_automation_rule(%L::uuid, 'x', 'lead_created', 'Revisar', 1, 'media', 'lead_owner') $i$, :'r_dois'),
  'P0001', 'automation_rule_not_found', '... (editar)'
);
select throws_ok(format($i$ select simulate_automation_rule(%L::uuid) $i$, '99999999-9999-9999-9999-999999999999'), 'P0001', 'automation_rule_not_found', 'e é igual a uma regra que não existe');
select throws_ok(format($i$ select list_automation_rules(%L::uuid) $i$, :'ws_dois'), 'P0001', 'insufficient_permission', 'listar regras de outro workspace é recusado');
select throws_ok(format($i$ select list_automation_executions(%L::uuid) $i$, :'ws_dois'), 'P0001', 'insufficient_permission', 'ler o histórico de outro workspace é recusado');
select throws_ok(format($i$ select process_automation_events(%L::uuid) $i$, :'ws_dois'), 'P0001', 'insufficient_permission', 'processar outro workspace é recusado');
select throws_ok(
  format($i$ select create_automation_rule(%L::uuid, 'x', 'lead_created', 'Revisar', 1, 'media', 'lead_owner') $i$, :'ws_dois'),
  'P0001', 'insufficient_permission', 'criar regra em outro workspace é recusado'
);
select ok(
  not exists (select 1 from jsonb_array_elements(list_automation_rules(:'ws_um'::uuid)) x where x ->> 'id' = :'r_dois'),
  'a listagem do Um não traz a regra do Dois'
);

-- Carla é membro dos dois (sem papel de gestão no Dois): "sem permissão", não "não encontrada".
select pg_temp.login(:'carla'::uuid);
select throws_ok(format($i$ select simulate_automation_rule(%L::uuid) $i$, :'r_dois'), 'P0001', 'insufficient_permission', 'membro do workspace sem o papel recebe permissão insuficiente');

-- Um lead no Um nunca dispara a regra do Dois (e vice-versa).
select pg_temp.login(:'ana'::uuid);
select create_lead(:'ws_um'::uuid, (:'contato')::uuid, 'Trabalhista', null, '{}'::text[], 'media', :'ana'::uuid) as lead_iso \gset
reset role;
select is(pg_temp.n(format('select count(*) from public.automation_events where lead_id = %L', :'lead_iso')), 1::bigint, 'o lead do Um gera evento só no Um');
select is(pg_temp.n('select count(*) from public.automation_events where workspace_id = ''' || :'ws_dois' || ''''), 0::bigint, 'e nenhum evento aparece no Dois');
set local role authenticated;
select pg_temp.login(:'bruno'::uuid);
select process_automation_events(:'ws_dois'::uuid);
reset role;
select is(pg_temp.n(format('select count(*) from public.automation_events where lead_id = %L and status = ''pending''', :'lead_iso')), 1::bigint, 'processar o Dois não encosta nos eventos do Um');
select is(pg_temp.n('select count(*) from public.automation_executions where workspace_id = ''' || :'ws_dois' || ''''), 0::bigint, 'e a regra do Dois não executou nada');

-- =====================================================================
-- 11) Rodada do sistema (rota de cron)
-- =====================================================================

set local role service_role;
select process_automation_events_system(50) as sys \gset
reset role;
select ok((:'sys'::jsonb ->> 'events')::int >= 1, 'o processamento do sistema consome eventos pendentes de qualquer workspace');
select is(pg_temp.n(format('select count(*) from public.automation_events where lead_id = %L and status = ''pending''', :'lead_iso')), 0::bigint, 'o evento pendente do Um foi consumido');

set local role authenticated;
select pg_temp.login(:'ana'::uuid);
select throws_ok($i$ select process_automation_events_system(10) $i$, '42501', null, 'authenticated não chama a rodada do sistema');
reset role;

-- =====================================================================
-- 12) Nenhum efeito externo
-- =====================================================================

select is(
  (select (select count(*) from public.messages) + (select count(*) from public.conversations)
     + (select count(*) from public.whatsapp_outbox) + (select count(*) from public.outbox)),
  (:'externos_antes')::bigint,
  'nenhuma mensagem, conversa nem item de outbox (WhatsApp ou formulários) foi criado pelas automações'
);
select ok(
  not exists (
    select 1 from pg_proc p
    where p.pronamespace in ('public'::regnamespace, 'private'::regnamespace)
      and p.proname like '%automation%'
      and p.prosrc ~* 'whatsapp|net\.http|http_post|pg_net|resend|send_message|notify\s|pg_notify'
  ),
  'nenhuma função de automação referencia envio, HTTP ou notificação'
);

select * from finish();
rollback;
