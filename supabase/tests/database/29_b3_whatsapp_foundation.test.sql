-- pgTAP — B3.1: fundação do canal de WhatsApp
-- (docs/decisoes/b3-whatsapp-real.md §6 B3.1, §7, §7.1).
--
-- Prova: RLS e GRANTs mínimos; chaves e credenciais inalcançáveis por
-- anon/authenticated; funções exclusivas de service_role; ambiente próprio
-- do WhatsApp autenticado (ausente, forjado, vencido, eterno, chave do
-- outro ambiente, formato ou finalidade da B2 → recusado); owner/admin
-- administram só no próprio workspace e ambiente; demais papéis recusados;
-- listagem sem material secreto; integridade e unicidade dos canais; linhas
-- do simulador da A7 preservadas. Nenhuma chave real: valores de teste,
-- só desta transação.

begin;
select plan(74);

\set ana     '20000000-0000-0000-0000-000000000001'
\set bruno   '20000000-0000-0000-0000-000000000002'
\set carla   '20000000-0000-0000-0000-000000000003'
\set daniel  '20000000-0000-0000-0000-000000000004'
\set leitor  '20000000-0000-0000-0000-000000000005'
\set ws_um   '10000000-0000-0000-0000-000000000001'
\set ws_dois '10000000-0000-0000-0000-000000000002'
\set ch_um   '31000000-0000-0000-0000-000000000001'
\set ch_dois '31000000-0000-0000-0000-000000000002'
\set ch_prod '31000000-0000-0000-0000-000000000003'
\set cifra   'QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFB'

-- daniel: manager no Um, admin no Dois. carla: lawyer no Um. leitor: viewer no Um.
insert into public.memberships (workspace_id, user_id, role, status) values
  (:'ws_um'::uuid, :'daniel'::uuid, 'manager', 'active'),
  (:'ws_dois'::uuid, :'daniel'::uuid, 'admin', 'active');

insert into public.whatsapp_environment_keys (environment, signing_key) values
  ('production', 'chave-whatsapp-producao-de-teste-0123456789'),
  ('preview', 'chave-whatsapp-preview-de-teste-0123456789ab');

-- Chaves de CALENDÁRIO iguais às do WhatsApp, de propósito: nem assim o
-- cabeçalho ou o formato da B2 autenticam o WhatsApp.
insert into public.calendar_environment_keys (environment, signing_key) values
  ('production', 'chave-whatsapp-producao-de-teste-0123456789'),
  ('preview', 'chave-whatsapp-preview-de-teste-0123456789ab');

create function pg_temp.wkey(p_env text) returns text language sql as $f$
  select signing_key from public.whatsapp_environment_keys where environment = p_env::public.whatsapp_environment
$f$;

create function pg_temp.hdr(p_env text, p_key_env text default null, p_expires bigint default null, p_version text default 'v1')
returns text language sql as $f$
  select json_build_object(
    'x-praxis-whatsapp-env',
    p_version || '.' || p_env || '.' || e.x || '.' ||
      private.whatsapp_environment_signature(p_env, e.x, pg_temp.wkey(coalesce(p_key_env, p_env)))
  )::text
  from (select coalesce(p_expires, extract(epoch from now())::bigint + 300) as x) e
$f$;

select pg_temp.hdr('preview') as h_prev \gset
select pg_temp.hdr('production') as h_prod \gset
select pg_temp.hdr('production', 'preview') as h_prod_chave_preview \gset
select pg_temp.hdr('preview', 'production') as h_prev_chave_prod \gset
select pg_temp.hdr('preview', null, extract(epoch from now())::bigint - 5) as h_vencido \gset
select pg_temp.hdr('preview', null, extract(epoch from now())::bigint + 3600) as h_eterno \gset
select pg_temp.hdr('preview', null, null, 'v2') as h_versao \gset
select json_build_object('x-praxis-whatsapp-env', 'v1.preview.' || (extract(epoch from now())::bigint + 300) || '.' || repeat('0', 64))::text as h_forjado \gset
-- Formato e finalidade da B2 (`ambiente.expira.hmac(ambiente.expira)`), com a
-- MESMA chave, no cabeçalho do WhatsApp.
select json_build_object(
  'x-praxis-whatsapp-env',
  'preview.' || x || '.' || private.environment_signature('preview', x, pg_temp.wkey('preview'))
)::text as h_formato_b2
from (select extract(epoch from now())::bigint + 300 as x) e \gset
-- Formato v1 do WhatsApp, mas assinando a mensagem da B2 (sem a finalidade).
select json_build_object(
  'x-praxis-whatsapp-env',
  'v1.preview.' || x || '.' || private.environment_signature('preview', x, pg_temp.wkey('preview'))
)::text as h_finalidade_b2
from (select extract(epoch from now())::bigint + 300 as x) e \gset
-- Cabeçalho VÁLIDO da B2 (x-praxis-env), sem o do WhatsApp.
select json_build_object(
  'x-praxis-env',
  'preview.' || x || '.' || private.environment_signature('preview', x, pg_temp.wkey('preview'))
)::text as h_so_calendario
from (select extract(epoch from now())::bigint + 300 as x) e \gset

-- ---------------------------------------------------------------------
-- 1) Mesma conta no Node e no SQL; estrutura e privilégios
-- ---------------------------------------------------------------------

select is(
  private.whatsapp_environment_signature('production', 4102444800, 'chave-de-teste-b3-whatsapp-0123456789'),
  '4e688daf0db27ff7e1944efaecdfaf612b511f68b7ef94499322c412d6d14afb',
  'vetor compartilhado com tests/unit/b3-whatsapp-environment.test.ts'
);

select ok(
  (select relrowsecurity and relforcerowsecurity from pg_class where oid = 'public.whatsapp_environment_keys'::regclass),
  'whatsapp_environment_keys: RLS habilitada e forçada'
);
select ok(
  (select relrowsecurity and relforcerowsecurity from pg_class where oid = 'public.whatsapp_channel_credentials'::regclass),
  'whatsapp_channel_credentials: RLS habilitada e forçada'
);
select ok(
  (select relrowsecurity and relforcerowsecurity from pg_class where oid = 'public.whatsapp_channels'::regclass),
  'whatsapp_channels: RLS continua habilitada e forçada'
);

select table_privs_are('public', 'whatsapp_environment_keys', 'authenticated', array[]::text[], 'chaves: authenticated sem privilégio');
select table_privs_are('public', 'whatsapp_environment_keys', 'anon', array[]::text[], 'chaves: anon sem privilégio');
select table_privs_are('public', 'whatsapp_channel_credentials', 'authenticated', array[]::text[], 'credenciais: authenticated sem privilégio');
select table_privs_are('public', 'whatsapp_channel_credentials', 'anon', array[]::text[], 'credenciais: anon sem privilégio');
select table_privs_are('public', 'whatsapp_channels', 'authenticated', array['SELECT'], 'canais: authenticated continua só com SELECT (A7)');

select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname like 'whatsapp\_%'
     and (has_function_privilege('authenticated', p.oid, 'execute') or has_function_privilege('anon', p.oid, 'execute'))),
  0,
  'nenhuma função public.whatsapp_* é executável por anon ou authenticated'
);
select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname like 'whatsapp\_%'
     and has_function_privilege('service_role', p.oid, 'execute')),
  10,
  'as 10 funções public.whatsapp_* são executáveis por service_role'
);
select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'private' and p.proname like '%whatsapp%'
     and (has_function_privilege('authenticated', p.oid, 'execute') or has_function_privilege('anon', p.oid, 'execute'))),
  0,
  'nenhuma função private de WhatsApp é executável por anon ou authenticated'
);
select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where p.prosecdef and p.proname like '%whatsapp%' and n.nspname in ('public', 'private')
     and p.proname not in ('create_whatsapp_channel', 'simulate_inbound_whatsapp_message')
     and not exists (select 1 from unnest(coalesce(p.proconfig, array[]::text[])) cfg where cfg like 'search_path=%')),
  0,
  'toda função SECURITY DEFINER nova da B3 tem search_path travado'
);

-- ---------------------------------------------------------------------
-- 2) anon e authenticated não alcançam chaves, credenciais nem funções
-- ---------------------------------------------------------------------

set local role anon;
select throws_ok($i$ select * from public.whatsapp_channel_credentials $i$, '42501', null, 'anon não lê credenciais');
reset role;

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'ana', 'role', 'authenticated')::text, true);
select set_config('request.headers', :'h_prev', true);
select throws_ok($i$ select * from public.whatsapp_environment_keys $i$, '42501', null, 'owner autenticado não lê as chaves do WhatsApp');
select throws_ok($i$ select * from public.whatsapp_channel_credentials $i$, '42501', null, 'owner autenticado não lê credenciais');
select throws_ok(
  format($i$ select whatsapp_list_channels(%L::uuid, %L::uuid) $i$, :'ws_um', :'ana'),
  '42501', null, 'owner autenticado, mesmo com cabeçalho válido, não chama a função de service_role'
);
select throws_ok($i$ select private.whatsapp_request_environment() $i$, '42501', null, 'authenticated não chama o verificador de ambiente');
reset role;
-- Daqui em diante, chamadas de servidor: sem identidade de usuário no JWT.
select set_config('request.jwt.claims', '', true);

-- ---------------------------------------------------------------------
-- 3) Ambiente: ausente, forjado, vencido, eterno, chave errada, B2 → recusado
-- ---------------------------------------------------------------------

set local role service_role;

select set_config('request.headers', '{}', true);
select throws_ok(format($i$ select whatsapp_list_channels(%L::uuid, %L::uuid) $i$, :'ws_um', :'ana'),
  'P0001', 'whatsapp_environment_required', 'sem cabeçalho: recusado');

select set_config('request.headers', '{"x-praxis-whatsapp-env":"v1.preview.1.' || repeat('a', 64) || '"}', true);
select throws_ok(format($i$ select whatsapp_list_channels(%L::uuid, %L::uuid) $i$, :'ws_um', :'ana'),
  'P0001', 'whatsapp_environment_required', 'cabeçalho declarado sem assinatura válida: recusado');

select set_config('request.headers', :'h_forjado', true);
select throws_ok(format($i$ select whatsapp_list_channels(%L::uuid, %L::uuid) $i$, :'ws_um', :'ana'),
  'P0001', 'whatsapp_environment_required', 'assinatura forjada: recusada');

select set_config('request.headers', :'h_vencido', true);
select throws_ok(format($i$ select whatsapp_list_channels(%L::uuid, %L::uuid) $i$, :'ws_um', :'ana'),
  'P0001', 'whatsapp_environment_required', 'assinatura vencida: recusada');

select set_config('request.headers', :'h_eterno', true);
select throws_ok(format($i$ select whatsapp_list_channels(%L::uuid, %L::uuid) $i$, :'ws_um', :'ana'),
  'P0001', 'whatsapp_environment_required', 'validade excessiva: recusada');

select set_config('request.headers', :'h_prod_chave_preview', true);
select throws_ok(format($i$ select whatsapp_list_channels(%L::uuid, %L::uuid) $i$, :'ws_um', :'ana'),
  'P0001', 'whatsapp_environment_required', 'Production assinada com a chave de Preview: recusada');

select set_config('request.headers', :'h_prev_chave_prod', true);
select throws_ok(format($i$ select whatsapp_list_channels(%L::uuid, %L::uuid) $i$, :'ws_um', :'ana'),
  'P0001', 'whatsapp_environment_required', 'Preview assinada com a chave de Production: recusada');

select set_config('request.headers', :'h_versao', true);
select throws_ok(format($i$ select whatsapp_list_channels(%L::uuid, %L::uuid) $i$, :'ws_um', :'ana'),
  'P0001', 'whatsapp_environment_required', 'versão de formato desconhecida: recusada');

select set_config('request.headers', :'h_formato_b2', true);
select throws_ok(format($i$ select whatsapp_list_channels(%L::uuid, %L::uuid) $i$, :'ws_um', :'ana'),
  'P0001', 'whatsapp_environment_required', 'formato da B2 no cabeçalho do WhatsApp, mesma chave: recusado');

select set_config('request.headers', :'h_finalidade_b2', true);
select throws_ok(format($i$ select whatsapp_list_channels(%L::uuid, %L::uuid) $i$, :'ws_um', :'ana'),
  'P0001', 'whatsapp_environment_required', 'finalidade que não é WhatsApp (mensagem da B2), mesma chave: recusada');

select set_config('request.headers', :'h_so_calendario', true);
select throws_ok(format($i$ select whatsapp_list_channels(%L::uuid, %L::uuid) $i$, :'ws_um', :'ana'),
  'P0001', 'whatsapp_environment_required', 'cabeçalho VÁLIDO do calendário não autentica o WhatsApp');

-- ---------------------------------------------------------------------
-- 4) Owner e admin administram no próprio workspace e ambiente
-- ---------------------------------------------------------------------

select set_config('request.headers', :'h_prev', true);

select (whatsapp_create_simulated_channel(
  :'ch_um'::uuid, :'ws_um'::uuid, :'ana'::uuid, ' Canal B3 Um ', 'b3-sim-um', '+55 11 0000-0101', :'cifra', '1'
)) as criado_um \gset

select is((:'criado_um'::jsonb) ->> 'environment', 'preview', 'owner cria canal simulado no ambiente autenticado (preview)');
select is((:'criado_um'::jsonb) ->> 'label', 'Canal B3 Um', 'nome gravado sem espaços nas pontas');
select is((:'criado_um'::jsonb) -> 'send_enabled', 'false'::jsonb, 'canal nasce com envio desligado');
select is((:'criado_um'::jsonb) -> 'credential_purposes', '["webhook_secret"]'::jsonb, 'segredo simulado gravado junto, só o propósito aparece');
select ok(
  not ((:'criado_um'::jsonb) ? 'ciphertext') and not ((:'criado_um'::jsonb) ? 'key_version')
    and position(:'cifra' in :'criado_um') = 0,
  'a resposta da criação não carrega texto cifrado nem versão de chave'
);

select ok(
  (whatsapp_create_simulated_channel(
    :'ch_dois'::uuid, :'ws_dois'::uuid, :'daniel'::uuid, 'Canal B3 Dois', 'b3-sim-dois', '+55 11 0000-0202', :'cifra', '1'
  )) ->> 'id' = :'ch_dois',
  'admin cria canal no próprio workspace'
);

select is(jsonb_array_length(whatsapp_list_channels(:'ws_um'::uuid, :'ana'::uuid)), 1, 'listagem do Um traz só o canal do Um');
select ok(
  position(:'cifra' in whatsapp_list_channels(:'ws_um'::uuid, :'ana'::uuid)::text) = 0
    and position('ciphertext' in whatsapp_list_channels(:'ws_um'::uuid, :'ana'::uuid)::text) = 0
    and position('key_version' in whatsapp_list_channels(:'ws_um'::uuid, :'ana'::uuid)::text) = 0,
  'listagem nunca retorna material secreto'
);

select is((whatsapp_pause_channel(:'ch_um'::uuid, :'ws_um'::uuid, :'ana'::uuid)) ->> 'status', 'paused', 'owner pausa');
select throws_ok(format($i$ select whatsapp_pause_channel(%L::uuid, %L::uuid, %L::uuid) $i$, :'ch_um', :'ws_um', :'ana'),
  'P0001', 'invalid_channel_state', 'pausar canal já pausado: recusado');
select is((whatsapp_reactivate_channel(:'ch_um'::uuid, :'ws_um'::uuid, :'ana'::uuid)) ->> 'status', 'active', 'owner reativa');
select throws_ok(format($i$ select whatsapp_reactivate_channel(%L::uuid, %L::uuid, %L::uuid) $i$, :'ch_um', :'ws_um', :'ana'),
  'P0001', 'invalid_channel_state', 'reativar canal ativo: recusado');
select is((whatsapp_disable_channel_send(:'ch_um'::uuid, :'ws_um'::uuid, :'ana'::uuid)) -> 'send_enabled', 'false'::jsonb, 'desligar envio');
select is(
  (whatsapp_update_channel_settings(:'ch_um'::uuid, :'ws_um'::uuid, :'ana'::uuid, 'Canal Renomeado', '+55 11 0000-0102')) ->> 'label',
  'Canal Renomeado', 'owner altera só nome e número exibido'
);
select throws_ok(
  format($i$ select whatsapp_store_channel_credential(%L::uuid, %L::uuid, %L::uuid, 'api_key', %L, '1') $i$, :'ch_um', :'ws_um', :'ana', :'cifra'),
  'P0001', 'credential_purpose_not_allowed', 'canal simulado não aceita chave de API'
);
select is(
  (select count(*)::int from whatsapp_get_channel_credential(:'ch_um'::uuid, :'ws_um'::uuid, 'simulated', 'b3-sim-um', 'webhook_secret')),
  1, 'servidor lê a credencial cifrada no mesmo ambiente, com o contexto do canal'
);

-- ---------------------------------------------------------------------
-- 5) Demais papéis recusados
-- ---------------------------------------------------------------------

select throws_ok(format($i$ select whatsapp_list_channels(%L::uuid, %L::uuid) $i$, :'ws_um', :'daniel'),
  'P0001', 'insufficient_permission', 'manager não lista');
select throws_ok(format($i$ select whatsapp_pause_channel(%L::uuid, %L::uuid, %L::uuid) $i$, :'ch_um', :'ws_um', :'daniel'),
  'P0001', 'insufficient_permission', 'manager não pausa');
select throws_ok(
  format($i$ select whatsapp_create_simulated_channel(gen_random_uuid(), %L::uuid, %L::uuid, 'x', 'b3-manager', '1', %L, '1') $i$, :'ws_um', :'daniel', :'cifra'),
  'P0001', 'insufficient_permission', 'manager não cria canal');
select throws_ok(format($i$ select whatsapp_pause_channel(%L::uuid, %L::uuid, %L::uuid) $i$, :'ch_um', :'ws_um', :'carla'),
  'P0001', 'insufficient_permission', 'advogado não pausa');
select throws_ok(format($i$ select whatsapp_get_channel_state(%L::uuid, %L::uuid, %L::uuid) $i$, :'ch_um', :'ws_um', :'leitor'),
  'P0001', 'insufficient_permission', 'visualizador não consulta');
select throws_ok(format($i$ select whatsapp_list_channels(%L::uuid, %L::uuid) $i$, :'ws_dois', :'carla'),
  'P0001', 'insufficient_permission', 'atendimento (sales) não lista');
select throws_ok(format($i$ select whatsapp_list_channels(%L::uuid, null) $i$, :'ws_um'),
  'P0001', 'actor_required', 'sem ator: recusado');

-- ---------------------------------------------------------------------
-- 6) Workspace e ambiente diferentes
-- ---------------------------------------------------------------------

select throws_ok(format($i$ select whatsapp_pause_channel(%L::uuid, %L::uuid, %L::uuid) $i$, :'ch_um', :'ws_dois', :'bruno'),
  'P0001', 'channel_not_found', 'owner do Dois, com o workspace dele, não alcança canal do Um');
select throws_ok(format($i$ select whatsapp_pause_channel(%L::uuid, %L::uuid, %L::uuid) $i$, :'ch_um', :'ws_um', :'bruno'),
  'P0001', 'insufficient_permission', 'owner do Dois afirmando o workspace Um: recusado');
select throws_ok(format($i$ select whatsapp_get_channel_state(%L::uuid, %L::uuid, %L::uuid) $i$, :'ch_dois', :'ws_dois', :'ana'),
  'P0001', 'insufficient_permission', 'owner do Um não consulta canal do Dois');

select set_config('request.headers', :'h_prod', true);
select is(jsonb_array_length(whatsapp_list_channels(:'ws_um'::uuid, :'ana'::uuid)), 0, 'Production não lista canal de Preview');
select throws_ok(format($i$ select whatsapp_pause_channel(%L::uuid, %L::uuid, %L::uuid) $i$, :'ch_um', :'ws_um', :'ana'),
  'P0001', 'channel_not_found', 'Production não pausa canal de Preview');
select throws_ok(format($i$ select whatsapp_update_channel_settings(%L::uuid, %L::uuid, %L::uuid, 'x', '1') $i$, :'ch_um', :'ws_um', :'ana'),
  'P0001', 'channel_not_found', 'Production não altera canal de Preview');
select throws_ok(
  format($i$ select * from whatsapp_get_channel_credential(%L::uuid, %L::uuid, 'simulated', 'b3-sim-um', 'webhook_secret') $i$, :'ch_um', :'ws_um'),
  'P0001', 'channel_not_found', 'Production não lê credencial de Preview');
select throws_ok(
  format($i$ select whatsapp_store_channel_credential(%L::uuid, %L::uuid, %L::uuid, 'webhook_secret', %L, '1') $i$, :'ch_um', :'ws_um', :'ana', :'cifra'),
  'P0001', 'channel_not_found', 'Production não grava credencial em canal de Preview');
select throws_ok(
  format($i$ select whatsapp_create_simulated_channel(%L::uuid, %L::uuid, %L::uuid, 'x', 'b3-sim-um', '1', %L, '1') $i$, :'ch_prod', :'ws_um', :'ana', :'cifra'),
  'P0001', 'channel_routing_key_taken', 'a mesma chave de roteamento não existe em dois ambientes');

-- ---------------------------------------------------------------------
-- 7) Integridade, unicidade e simulador da A7 preservado
-- ---------------------------------------------------------------------

reset role;

select throws_ok(format($i$ update public.whatsapp_channels set routing_key = 'outra' where id = %L $i$, :'ch_um'),
  'P0001', 'channel_identity_immutable', 'chave de roteamento é imutável');
select throws_ok(format($i$ update public.whatsapp_channels set environment = 'production' where id = %L $i$, :'ch_um'),
  'P0001', 'channel_identity_immutable', 'ambiente do canal é imutável');
select throws_ok(format($i$ update public.whatsapp_channels set send_enabled = true where id = %L $i$, :'ch_um'),
  '23514', null, 'canal simulado nunca habilita envio');
select throws_ok(
  format($i$ insert into public.whatsapp_channels (workspace_id, label, phone_number_id, display_phone_number, created_by, environment, routing_key)
            values (%L, 'x', 'tel-x', '1', %L, 'preview', 'b3-misto') $i$, :'ws_um', :'ana'),
  '23514', null, 'canal com ambiente E phone_number_id da A7: recusado');
select throws_ok(
  format($i$ insert into public.whatsapp_channels (workspace_id, label, display_phone_number, created_by, provider, is_simulator, routing_key)
            values (%L, 'x', '1', %L, 'ycloud', false, 'b3-real-sem-ambiente') $i$, :'ws_um', :'ana'),
  '23514', null, 'canal real sem ambiente: recusado');
select throws_ok(
  format($i$ insert into public.whatsapp_channel_credentials (channel_id, workspace_id, environment, provider, purpose, ciphertext, key_version)
            values (%L, %L, 'production', 'simulated', 'api_key', %L, '1') $i$, :'ch_um', :'ws_um', :'cifra'),
  '23503', null, 'credencial com ambiente diferente do canal: recusada pela FK');
select throws_ok(
  format($i$ insert into public.whatsapp_channel_credentials (channel_id, workspace_id, environment, provider, purpose, ciphertext, key_version)
            values (%L, %L, 'preview', 'simulated', 'api_key', %L, '1') $i$, :'ch_um', :'ws_dois', :'cifra'),
  '23503', null, 'credencial com workspace diferente do canal: recusada pela FK');

-- Simulador da A7: o caminho antigo continua criando a linha legada.
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'ana', 'role', 'authenticated')::text, true);
select (create_whatsapp_channel(:'ws_um'::uuid, 'Canal A7', 'a7-legado-b3', '+55 11 0000-0303')).id as legado \gset
select is(
  (select count(*)::int from public.whatsapp_channels where id = :'legado'::uuid),
  1, 'canal da A7 continua visível por SELECT direto'
);
select is(
  (select count(*)::int from public.whatsapp_channels where id in (:'ch_um'::uuid, :'ch_dois'::uuid)),
  0, 'canal da B3 é invisível por SELECT direto'
);
select throws_ok(format($i$ select create_whatsapp_channel(%L::uuid, 'Colide', 'b3-sim-um', '1') $i$, :'ws_um'),
  'P0001', 'channel_phone_number_id_taken', 'A7 não reaproveita a chave de roteamento de um canal da B3');
reset role;
select set_config('request.jwt.claims', '', true);

select is(
  (select count(*)::int from public.whatsapp_channels
   where environment is null
     and (routing_key is distinct from phone_number_id or provider <> 'simulated' or not is_simulator or send_enabled)),
  0,
  'toda linha legada da A7 segue simulador, sem envio, com routing_key = phone_number_id'
);

set local role service_role;
select set_config('request.headers', :'h_prev', true);
select throws_ok(format($i$ select whatsapp_pause_channel(%L::uuid, %L::uuid, %L::uuid) $i$, :'legado', :'ws_um', :'ana'),
  'P0001', 'channel_not_found', 'as funções da B3 não administram o canal legado da A7');
reset role;

select ok(
  not exists (
    select 1 from public.audit_logs
    where action like 'whatsapp.channel.%' and position(:'cifra' in metadata::text) > 0
  ),
  'auditoria da B3 nunca leva texto cifrado'
);

select * from finish();
rollback;
