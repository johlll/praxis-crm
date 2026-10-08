-- pgTAP — B2, fundação do Google Agenda: conexões, vínculos e a barreira de
-- isolamento entre ambientes (docs/decisoes/b2-google-agenda.md §7).
--
-- O ambiente que opera chega ao banco no cabeçalho `x-praxis-env` do
-- PostgREST (`request.headers`), preenchido pelo SERVIDOR. Aqui ele é
-- simulado com set_config. Todos os registros são criados por este teste
-- (workspace de teste, atividades e vínculos próprios): nenhum registro
-- existente é tocado. O caso "vínculo de production" é simulado criando,
-- aqui mesmo, uma atividade cujo vínculo tem ambiente production.
--
-- Funções de escrita (connect/set/disconnect/create_link/get_secrets) são
-- exclusivas do service_role — chamadas sem troca de role (a conexão de
-- teste já tem privilégio total, mesmo padrão de 19_b1_*); a prova de que
-- `authenticated` NÃO as executa é feita à parte.

begin;
select plan(52);

\set dono    '20000000-0000-0000-0000-000000000001'
\set adv     '20000000-0000-0000-0000-000000000002'
\set adv2    '20000000-0000-0000-0000-000000000003'
\set vendas  '20000000-0000-0000-0000-000000000004'
\set leitor  '20000000-0000-0000-0000-000000000005'

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'dono', 'role', 'authenticated')::text, true);
select (create_workspace_with_owner('Teste B2', 'teste-b2-calendario')).id as ws \gset
reset role;

insert into public.memberships (workspace_id, user_id, role, status) values
  (:'ws'::uuid, :'adv', 'lawyer', 'active'),
  (:'ws'::uuid, :'adv2', 'lawyer', 'active'),
  (:'ws'::uuid, :'vendas', 'sales', 'active'),
  (:'ws'::uuid, :'leitor', 'viewer', 'active');

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'dono', 'role', 'authenticated')::text, true);
select (create_contact(:'ws'::uuid, 'pf', 'Cliente B2', null, null, null)).id as contact \gset
select create_lead(:'ws'::uuid, (:'contact')::uuid, 'Trabalhista', 'Lead B2', '{}'::text[], 'media', null) as lead \gset
-- Compromisso (reunião COM horário) e tarefa comum (sem vínculo possível).
select create_activity(
  p_lead_id := (:'lead')::uuid, p_type := 'meeting'::activity_type, p_title := 'Reunião B2',
  p_due_date := (current_date + 5), p_due_time := '15:00'::time
) as reuniao \gset
select create_activity(
  p_lead_id := (:'lead')::uuid, p_type := 'task'::activity_type, p_title := 'Tarefa B2',
  p_due_date := (current_date + 5)
) as tarefa \gset
reset role;

-- ---------------------------------------------------------------------
-- 1) Tabelas e grants
-- ---------------------------------------------------------------------

select is(
  (select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname in ('calendar_connections', 'calendar_event_links')
     and c.relrowsecurity and c.relforcerowsecurity),
  2, 'RLS habilitada E forçada em calendar_connections e calendar_event_links'
);

select is(
  (select count(*)::int from information_schema.role_table_grants
   where table_schema = 'public' and table_name in ('calendar_connections', 'calendar_event_links')
     and grantee in ('anon', 'authenticated')),
  0, 'nenhum GRANT de tabela para anon/authenticated nas duas tabelas'
);

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'dono', 'role', 'authenticated')::text, true);
select throws_ok(
  format($i$ select connect_calendar_account(%L::uuid, %L::uuid, 'a@b.co', array['s'], 'r', 'a', now(), '1') $i$, :'ws', :'dono'),
  '42501', null, 'authenticated NÃO executa connect_calendar_account (nem sendo owner)'
);
select throws_ok(
  format($i$ select disconnect_calendar_connection(gen_random_uuid(), %L::uuid) $i$, :'dono'),
  '42501', null, 'authenticated NÃO executa disconnect_calendar_connection'
);
select throws_ok(
  format($i$ select create_calendar_event_link(gen_random_uuid(), %L::uuid, %L::uuid, 'e') $i$, :'reuniao', :'dono'),
  '42501', null, 'authenticated NÃO executa create_calendar_event_link'
);
select throws_ok(
  format($i$ select * from get_calendar_connection_secrets(gen_random_uuid(), %L::uuid) $i$, :'dono'),
  '42501', null, 'authenticated NÃO executa get_calendar_connection_secrets'
);
reset role;

-- ---------------------------------------------------------------------
-- 2) Conexão: ambiente obrigatório, papéis, uma por usuário e ambiente
-- ---------------------------------------------------------------------

select set_config('request.headers', '', true);
select throws_ok(
  format($i$ select connect_calendar_account(%L::uuid, %L::uuid, 'dono@v.test', array['s'], 'r', 'a', now(), '1') $i$, :'ws', :'dono'),
  'P0001', 'environment_required', 'sem o cabeçalho de ambiente, conectar é recusado (falha fechada)'
);

select set_config('request.headers', '{"x-praxis-env":"staging"}', true);
select throws_ok(
  format($i$ select connect_calendar_account(%L::uuid, %L::uuid, 'dono@v.test', array['s'], 'r', 'a', now(), '1') $i$, :'ws', :'dono'),
  'P0001', 'environment_required', 'ambiente desconhecido no cabeçalho também é recusado'
);

select set_config('request.headers', '{"x-praxis-env":"production"}', true);
select throws_ok(
  format($i$ select connect_calendar_account(%L::uuid, %L::uuid, 'v@v.test', array['s'], 'r', 'a', now(), '1') $i$, :'ws', :'leitor'),
  'P0001', 'insufficient_permission', 'viewer não conecta conta (calendar.connect_own)'
);
select throws_ok(
  format($i$ select connect_calendar_account(%L::uuid, %L::uuid, 'dono@v.test', array['s'], '', 'a', now(), '1') $i$, :'ws', :'dono'),
  'P0001', 'tokens_required', 'refresh token vazio é recusado'
);

select connect_calendar_account(:'ws'::uuid, :'dono'::uuid, 'Dono@V.test', array['escopo'], 'refresh-cifrado', 'access-cifrado', now() + interval '1 hour', '1') as conn_prod \gset
select ok(:'conn_prod' is not null, 'owner conecta em production');

select is(
  (select google_account_email from public.calendar_connections where id = (:'conn_prod')::uuid),
  'dono@v.test', 'e-mail da conta normalizado em minúsculas'
);

select is(
  connect_calendar_account(:'ws'::uuid, :'dono'::uuid, 'dono@v.test', array['escopo'], 'novo-refresh', 'novo-access', now(), '1'),
  (:'conn_prod')::uuid, 'reconectar no mesmo ambiente reaproveita a MESMA conexão'
);

select set_config('request.headers', '{"x-praxis-env":"preview"}', true);
select connect_calendar_account(:'ws'::uuid, :'dono'::uuid, 'dono@v.test', array['escopo'], 'refresh-prev', 'access-prev', now(), '1') as conn_prev \gset
select isnt((:'conn_prev')::uuid, (:'conn_prod')::uuid, 'o mesmo usuário tem conexão SEPARADA em preview');

select is(
  (select count(*)::int from public.calendar_connections where user_id = :'dono'::uuid and status <> 'disconnected'),
  2, 'uma conexão ativa por usuário em cada ambiente'
);

select set_config('request.headers', '{"x-praxis-env":"production"}', true);
select connect_calendar_account(:'ws'::uuid, :'adv'::uuid, 'adv@v.test', array['escopo'], 'refresh-adv', 'access-adv', now(), '1') as conn_adv \gset
select ok(:'conn_adv' is not null, 'advogado conecta a PRÓPRIA conta');

-- ---------------------------------------------------------------------
-- 3) Escolha da agenda e leitura dos segredos: só o dono, só no ambiente
-- ---------------------------------------------------------------------

select throws_ok(
  format($i$ select set_calendar_connection_calendar(%L::uuid, %L::uuid, 'cal@x', 'Principal') $i$, :'conn_prod', :'vendas'),
  'P0001', 'connection_not_found', 'outro usuário não escolhe a agenda da conexão alheia'
);

select set_config('request.headers', '{"x-praxis-env":"preview"}', true);
select throws_ok(
  format($i$ select set_calendar_connection_calendar(%L::uuid, %L::uuid, 'cal@x', 'Principal') $i$, :'conn_prod', :'dono'),
  'P0001', 'calendar_environment_mismatch', 'preview não escolhe agenda de conexão de production'
);
select throws_ok(
  format($i$ select * from get_calendar_connection_secrets(%L::uuid, %L::uuid) $i$, :'conn_prod', :'dono'),
  'P0001', 'calendar_environment_mismatch', 'preview não lê os segredos de uma conexão de production'
);
select set_calendar_connection_calendar(:'conn_prev'::uuid, :'dono'::uuid, 'cal-prev@x', 'Agenda de teste');

select set_config('request.headers', '{"x-praxis-env":"production"}', true);
select set_calendar_connection_calendar(:'conn_prod'::uuid, :'dono'::uuid, 'cal-prod@x', 'Agenda de produção');
select is(
  (select calendar_id from public.calendar_connections where id = (:'conn_prod')::uuid),
  'cal-prod@x', 'o dono escolhe a agenda da própria conexão'
);

select throws_ok(
  format($i$ select * from get_calendar_connection_secrets(%L::uuid, %L::uuid) $i$, :'conn_prod', :'adv'),
  'P0001', 'connection_not_found', 'só o dono obtém os segredos (advogado não lê os do owner)'
);
select is(
  (select count(*)::int from get_calendar_connection_secrets(:'conn_prod'::uuid, :'dono'::uuid)),
  1, 'o dono obtém os segredos da própria conexão, no ambiente certo'
);

-- Trocar de conta Google invalida a agenda escolhida antes.
select connect_calendar_account(:'ws'::uuid, :'adv'::uuid, 'outra@v.test', array['escopo'], 'r2', 'a2', now(), '1');
select is(
  (select calendar_id from public.calendar_connections where id = (:'conn_adv')::uuid),
  null, 'outra conta Google: a agenda escolhida deixa de valer'
);

-- ---------------------------------------------------------------------
-- 4) Listagem (authenticated): sem tokens, por ambiente, por papel
-- ---------------------------------------------------------------------

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'dono', 'role', 'authenticated')::text, true);
select is(
  jsonb_array_length(list_calendar_connections(:'ws'::uuid)),
  2, 'owner vê as conexões do workspace NO ambiente atual (production: dele e do advogado, não a de preview)'
);
select ok(
  not (list_calendar_connections(:'ws'::uuid)::text ~* '(ciphertext|token)'),
  'a listagem nunca traz token nem texto cifrado'
);

select set_config('request.jwt.claims', json_build_object('sub', :'adv', 'role', 'authenticated')::text, true);
select is(
  jsonb_array_length(list_calendar_connections(:'ws'::uuid)),
  1, 'advogado vê só a própria conexão'
);

select set_config('request.jwt.claims', json_build_object('sub', :'vendas', 'role', 'authenticated')::text, true);
select is(
  jsonb_array_length(list_calendar_connections(:'ws'::uuid)),
  0, 'atendimento sem conexão própria não vê as dos outros'
);
reset role;

select set_config('request.headers', '', true);
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'dono', 'role', 'authenticated')::text, true);
select throws_ok(
  format($i$ select list_calendar_connections(%L::uuid) $i$, :'ws'),
  'P0001', 'environment_required', 'listar sem o cabeçalho de ambiente é recusado'
);
reset role;

-- ---------------------------------------------------------------------
-- 5) Vínculo atividade ↔ evento
-- ---------------------------------------------------------------------

select set_config('request.headers', '{"x-praxis-env":"production"}', true);
select throws_ok(
  format($i$ select create_calendar_event_link(%L::uuid, %L::uuid, %L::uuid, 'ev-tarefa') $i$, :'conn_prod', :'tarefa', :'dono'),
  'P0001', 'activity_not_appointment', 'só reunião com horário vira compromisso vinculável'
);
select throws_ok(
  format($i$ select create_calendar_event_link(%L::uuid, %L::uuid, %L::uuid, 'ev-adv') $i$, :'conn_adv', :'reuniao', :'adv'),
  'P0001', 'calendar_not_selected', 'sem agenda escolhida não há vínculo'
);

select create_calendar_event_link(:'conn_prod'::uuid, :'reuniao'::uuid, :'dono'::uuid, 'evento-prod-1') as link_prod \gset
select ok(:'link_prod' is not null, 'owner vincula a reunião a um evento em production');

select throws_ok(
  format($i$ select create_calendar_event_link(%L::uuid, %L::uuid, %L::uuid, 'evento-prod-2') $i$, :'conn_prod', :'reuniao', :'dono'),
  '23505', null, 'no máximo um vínculo ativo por atividade'
);

select set_config('request.headers', '{"x-praxis-env":"preview"}', true);
select throws_ok(
  format($i$ select create_calendar_event_link(%L::uuid, %L::uuid, %L::uuid, 'evento-prev-1') $i$, :'conn_prev', :'reuniao', :'dono'),
  'P0001', 'calendar_environment_mismatch', 'preview não vincula atividade que já pertence a um vínculo de production'
);

-- ---------------------------------------------------------------------
-- 6) BARREIRA: atividade vinculada só muda no ambiente dono do vínculo
-- ---------------------------------------------------------------------

select set_config('request.headers', '{"x-praxis-env":"production"}', true);
select lives_ok(
  format($i$ update public.activities set notes = 'ok em production' where id = %L::uuid $i$, :'reuniao'),
  'production altera a atividade vinculada a production'
);

select set_config('request.headers', '{"x-praxis-env":"preview"}', true);
select throws_ok(
  format($i$ update public.activities set notes = 'invasão' where id = %L::uuid $i$, :'reuniao'),
  'P0001', 'calendar_environment_mismatch', 'preview NÃO altera atividade vinculada a production'
);
select throws_ok(
  format($i$ delete from public.activities where id = %L::uuid $i$, :'reuniao'),
  'P0001', 'calendar_environment_mismatch', 'preview NÃO exclui atividade vinculada a production'
);
select throws_ok(
  format($i$ delete from public.leads where id = %L::uuid $i$, :'lead'),
  'P0001', 'calendar_environment_mismatch', 'exclusão em cascata (lead) também é barrada'
);

-- Pelos caminhos que JÁ existem (função de atividade, sessão de usuário).
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'dono', 'role', 'authenticated')::text, true);
select throws_ok(
  format($i$ select delete_activity(%L::uuid) $i$, :'reuniao'),
  'P0001', 'calendar_environment_mismatch', 'delete_activity (caminho existente) é barrado em preview'
);
reset role;

select set_config('request.headers', '', true);
select throws_ok(
  format($i$ update public.activities set notes = 'sem cabeçalho' where id = %L::uuid $i$, :'reuniao'),
  'P0001', 'calendar_environment_mismatch', 'sem o cabeçalho de ambiente a atividade vinculada também é recusada (falha fechada)'
);

select is(
  (select notes from public.activities where id = (:'reuniao')::uuid),
  'ok em production', 'depois das recusas a atividade segue exatamente como estava'
);

select lives_ok(
  format($i$ update public.activities set notes = 'tarefa livre' where id = %L::uuid $i$, :'tarefa'),
  'atividade SEM vínculo continua editável, com ou sem cabeçalho'
);

-- ---------------------------------------------------------------------
-- 7) Desconexão
-- ---------------------------------------------------------------------

select set_config('request.headers', '{"x-praxis-env":"preview"}', true);
select throws_ok(
  format($i$ select disconnect_calendar_connection(%L::uuid, %L::uuid) $i$, :'conn_prod', :'dono'),
  'P0001', 'calendar_environment_mismatch', 'preview não desconecta conexão de production'
);

select set_config('request.headers', '{"x-praxis-env":"production"}', true);
select throws_ok(
  format($i$ select disconnect_calendar_connection(%L::uuid, %L::uuid) $i$, :'conn_prod', :'vendas'),
  'P0001', 'connection_not_found', 'atendimento não desconecta a conexão de outro usuário'
);
select throws_ok(
  format($i$ select disconnect_calendar_connection(%L::uuid, %L::uuid) $i$, :'conn_prod', :'adv2'),
  'P0001', 'connection_not_found', 'advogado de fora da conexão não a desconecta'
);

select disconnect_calendar_connection(:'conn_adv'::uuid, :'dono'::uuid);
select is(
  (select status::text from public.calendar_connections where id = (:'conn_adv')::uuid),
  'disconnected', 'owner (calendar.manage) desconecta a conexão de outro usuário'
);

select disconnect_calendar_connection(:'conn_prod'::uuid, :'dono'::uuid);
select is(
  (select (refresh_token_ciphertext is null and access_token_ciphertext is null and disconnected_at is not null)
   from public.calendar_connections where id = (:'conn_prod')::uuid),
  true, 'desconectar apaga os tokens'
);
select is(
  (select status::text from public.calendar_event_links where id = (:'link_prod')::uuid),
  'unlinked', 'desconectar desvincula os eventos'
);
select is(
  (select count(*)::int from public.activities where id = (:'reuniao')::uuid),
  1, 'desconectar NÃO apaga a atividade do CRM'
);

select set_config('request.headers', '{"x-praxis-env":"preview"}', true);
select lives_ok(
  format($i$ update public.activities set notes = 'livre depois de desvincular' where id = %L::uuid $i$, :'reuniao'),
  'sem vínculo ativo, a atividade deixa de pertencer ao ambiente de production'
);

select throws_ok(
  format($i$ select * from get_calendar_connection_secrets(%L::uuid, %L::uuid) $i$, :'conn_prod', :'dono'),
  'P0001', 'connection_not_found', 'conexão desconectada não entrega segredos'
);

-- ---------------------------------------------------------------------
-- 8) Auditoria sem segredo
-- ---------------------------------------------------------------------

select is(
  (select count(*)::int from public.audit_logs
   where workspace_id = :'ws'::uuid and action = 'calendar.connection.disconnected'),
  2, 'cada desconexão fica auditada'
);
select is(
  (select count(*)::int from public.audit_logs
   where workspace_id = :'ws'::uuid and action like 'calendar.%'
     and (metadata::text ~* '(ciphertext|token|@)')),
  0, 'a auditoria de calendário nunca guarda token nem e-mail da conta'
);

select * from finish();
rollback;
