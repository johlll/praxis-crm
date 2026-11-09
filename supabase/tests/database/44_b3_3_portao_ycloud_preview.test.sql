-- pgTAP — B3.3: portão do envio — canal YCloud de Preview pode ligar o envio
-- (docs/decisoes/b3-whatsapp-real.md §28.20).
--
-- Prova: owner e admin ligam o envio de canal YCloud ATIVO do Preview que tem a
-- api_key do mesmo canal; manager, lawyer, sales, viewer e quem é de outro
-- workspace são recusados; YCloud em Production, Meta (qualquer ambiente),
-- canal pausado/desconectado/desativado, canal sem api_key e canal só com
-- webhook_secret são recusados; credencial de outro workspace, ambiente ou
-- provedor nem chega a existir (chave estrangeira); ambiente ausente, forjado,
-- vencido, malformado ou assinado com a chave do outro ambiente é recusado;
-- o simulado no Preview mantém o comportamento; a função continua
-- SECURITY DEFINER, com search_path vazio e só service_role executa; nada de
-- credencial no retorno, erro ou auditoria; nenhuma rede. Nenhuma chave real:
-- valores de teste, só desta transação.

begin;
select plan(46);

\set ana     '20000000-0000-0000-0000-000000000001'
\set bruno   '20000000-0000-0000-0000-000000000002'
\set carla   '20000000-0000-0000-0000-000000000003'
\set daniel  '20000000-0000-0000-0000-000000000004'
\set leitor  '20000000-0000-0000-0000-000000000005'
\set ws_um   '10000000-0000-0000-0000-000000000001'
\set ws_dois '10000000-0000-0000-0000-000000000002'
\set yc_ok   '66000000-0000-0000-0000-00000000000a'
\set yc_adm  '66000000-0000-0000-0000-00000000000b'
\set yc_whk  '66000000-0000-0000-0000-00000000000c'
\set yc_nada '66000000-0000-0000-0000-00000000000d'
\set yc_paus '66000000-0000-0000-0000-00000000000e'
\set yc_disc '66000000-0000-0000-0000-00000000000f'
\set yc_off  '66000000-0000-0000-0000-000000000010'
\set yc_prod '66000000-0000-0000-0000-000000000011'
\set meta_pv '66000000-0000-0000-0000-000000000012'
\set meta_pd '66000000-0000-0000-0000-000000000013'
\set sim_pv  '66000000-0000-0000-0000-000000000014'
\set sim_pd  '66000000-0000-0000-0000-000000000015'
\set cifra_hook 'SE9PS0hPT0tIT09LSE9PS0hPT0tIT09LSE9PS0hPT0tIT09LSE9PS0hPT0s'
\set cifra_api  'QVBJS0VZQVBJS0VZQVBJS0VZQVBJS0VZQVBJS0VZQVBJS0VZQVBJS0VZQVA'

-- daniel: manager no Um, admin no Dois. carla: lawyer no Um, sales no Dois (seed).
-- leitor: viewer no Um. bruno: dono do Dois. ana: dona do Um.
insert into public.memberships (workspace_id, user_id, role, status) values
  (:'ws_um'::uuid, :'daniel'::uuid, 'manager', 'active'),
  (:'ws_dois'::uuid, :'daniel'::uuid, 'admin', 'active');

insert into public.whatsapp_environment_keys (environment, signing_key) values
  ('production', 'chave-whatsapp-producao-de-teste-0123456789'),
  ('preview', 'chave-whatsapp-preview-de-teste-0123456789ab');

create function pg_temp.wkey(p_env text) returns text language sql as $f$
  select signing_key from public.whatsapp_environment_keys where environment = p_env::public.whatsapp_environment
$f$;

create function pg_temp.hdr(p_env text, p_key_env text default null, p_expires bigint default null)
returns text language sql as $f$
  select json_build_object(
    'x-praxis-whatsapp-env',
    'v1.' || p_env || '.' || e.x || '.' ||
      private.whatsapp_environment_signature(p_env, e.x, pg_temp.wkey(coalesce(p_key_env, p_env)))
  )::text
  from (select coalesce(p_expires, extract(epoch from now())::bigint + 300) as x) e
$f$;

select pg_temp.hdr('preview') as h_prev \gset
select pg_temp.hdr('production') as h_prod \gset
select pg_temp.hdr('production', 'preview') as h_prod_chave_preview \gset
select pg_temp.hdr('preview', null, extract(epoch from now())::bigint - 5) as h_vencido \gset
select json_build_object('x-praxis-whatsapp-env', 'v1.preview.' || (extract(epoch from now())::bigint + 300) || '.' || repeat('0', 64))::text as h_forjado \gset
select json_build_object('x-praxis-whatsapp-env', 'lixo')::text as h_lixo \gset

-- Canais pelo caminho real (criação e reativação), no Preview; o de Production sob o cabeçalho de Production.
create function pg_temp.yc(p_canal uuid, p_ws uuid, p_ator uuid, p_rk text)
returns jsonb language sql as $f$
  select public.whatsapp_create_ycloud_channel(p_canal, p_ws, p_ator, 'Canal YCloud', p_rk, '+55 11 0000-0044', 'SE9PS0hPT0tIT09LSE9PS0hPT0tIT09LSE9PS0hPT0tIT09LSE9PS0hPT0s', '1', 'QVBJS0VZQVBJS0VZQVBJS0VZQVBJS0VZQVBJS0VZQVBJS0VZQVBJS0VZQVA', '1')
$f$;

set local role service_role;
select set_config('request.jwt.claims', '', true);
select set_config('request.headers', :'h_prev', true);

select pg_temp.yc(:'yc_ok'::uuid,   :'ws_um'::uuid,   :'ana'::uuid,   'B44WABA:5511000000a1') is not null as ok \gset
select pg_temp.yc(:'yc_adm'::uuid,  :'ws_dois'::uuid, :'bruno'::uuid, 'B44WABA:5511000000a2') is not null as ok \gset
select pg_temp.yc(:'yc_whk'::uuid,  :'ws_um'::uuid,   :'ana'::uuid,   'B44WABA:5511000000a3') is not null as ok \gset
select pg_temp.yc(:'yc_nada'::uuid, :'ws_um'::uuid,   :'ana'::uuid,   'B44WABA:5511000000a4') is not null as ok \gset
select pg_temp.yc(:'yc_paus'::uuid, :'ws_um'::uuid,   :'ana'::uuid,   'B44WABA:5511000000a5') is not null as ok \gset
select pg_temp.yc(:'yc_disc'::uuid, :'ws_um'::uuid,   :'ana'::uuid,   'B44WABA:5511000000a6') is not null as ok \gset
select pg_temp.yc(:'yc_off'::uuid,  :'ws_um'::uuid,   :'ana'::uuid,   'B44WABA:5511000000a7') is not null as ok \gset
select whatsapp_reactivate_channel(:'yc_ok'::uuid,   :'ws_um'::uuid,   :'ana'::uuid)   is not null as ok \gset
select whatsapp_reactivate_channel(:'yc_adm'::uuid,  :'ws_dois'::uuid, :'bruno'::uuid) is not null as ok \gset
select whatsapp_reactivate_channel(:'yc_whk'::uuid,  :'ws_um'::uuid,   :'ana'::uuid)   is not null as ok \gset
select whatsapp_reactivate_channel(:'yc_nada'::uuid, :'ws_um'::uuid,   :'ana'::uuid)   is not null as ok \gset
select whatsapp_reactivate_channel(:'yc_disc'::uuid, :'ws_um'::uuid,   :'ana'::uuid)   is not null as ok \gset
select whatsapp_reactivate_channel(:'yc_off'::uuid,  :'ws_um'::uuid,   :'ana'::uuid)   is not null as ok \gset
select whatsapp_create_simulated_channel(:'sim_pv'::uuid, :'ws_um'::uuid, :'ana'::uuid, 'Simulado', 'b44-sim-pv', '+55 11 0000-0045', :'cifra_hook', '1') is not null as ok \gset

select set_config('request.headers', :'h_prod', true);
select pg_temp.yc(:'yc_prod'::uuid, :'ws_um'::uuid, :'ana'::uuid, 'B44WABA:5511000000b1') is not null as ok \gset
select whatsapp_reactivate_channel(:'yc_prod'::uuid, :'ws_um'::uuid, :'ana'::uuid) is not null as ok \gset
select whatsapp_create_simulated_channel(:'sim_pd'::uuid, :'ws_um'::uuid, :'ana'::uuid, 'Simulado Production', 'b44-sim-pd', '+55 11 0000-0046', :'cifra_hook', '1') is not null as ok \gset
select set_config('request.headers', :'h_prev', true);

reset role;

-- Cenário que as funções não criam (como administrador do banco): canais só com
-- webhook_secret e sem credencial nenhuma, estados desconectado/desativado, e
-- canais da Meta (não há função de cadastro) com api_key, no Preview e em Production.
delete from public.whatsapp_channel_credentials where channel_id = :'yc_whk'::uuid and purpose = 'api_key';
delete from public.whatsapp_channel_credentials where channel_id = :'yc_nada'::uuid;
update public.whatsapp_channels set status = 'disconnected', send_enabled = false where id = :'yc_disc'::uuid;
update public.whatsapp_channels set status = 'disabled', send_enabled = false where id = :'yc_off'::uuid;
insert into public.whatsapp_channels (id, workspace_id, label, phone_number_id, display_phone_number, is_simulator, status, created_by, provider, environment, routing_key, send_enabled, status_changed_at) values
  (:'meta_pv'::uuid, :'ws_um'::uuid, 'Meta Preview', null, '+55 11 0000-0047', false, 'active', :'ana'::uuid, 'meta', 'preview', 'b44-meta-pv', false, now()),
  (:'meta_pd'::uuid, :'ws_um'::uuid, 'Meta Production', null, '+55 11 0000-0048', false, 'active', :'ana'::uuid, 'meta', 'production', 'b44-meta-pd', false, now());
insert into public.whatsapp_channel_credentials (channel_id, workspace_id, environment, provider, purpose, ciphertext, key_version) values
  (:'meta_pv'::uuid, :'ws_um'::uuid, 'preview', 'meta', 'api_key', :'cifra_api', '1'),
  (:'meta_pd'::uuid, :'ws_um'::uuid, 'production', 'meta', 'api_key', :'cifra_api', '1');

-- ---------------------------------------------------------------------
-- 1) Estrutura e privilégios
-- ---------------------------------------------------------------------

select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'whatsapp_enable_channel_send'
     and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute')
          or exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0))),
  0,
  'o portão não é executável por anon, authenticated nem public'
);
select ok(
  (select has_function_privilege('service_role', p.oid, 'execute') and p.prosecdef and p.proconfig @> array['search_path=""']
   from pg_proc p where p.oid = 'public.whatsapp_enable_channel_send(uuid, uuid, uuid)'::regprocedure),
  'continua SECURITY DEFINER, com search_path vazio, executável por service_role'
);
select is(
  (select pg_get_function_identity_arguments(p.oid) from pg_proc p where p.oid = 'public.whatsapp_enable_channel_send(uuid, uuid, uuid)'::regprocedure),
  'p_channel_id uuid, p_workspace_id uuid, p_actor_user_id uuid',
  'a assinatura não mudou: sem provedor, ambiente ou credencial como parâmetro'
);
select ok(
  (select position('http' in lower(p.prosrc)) = 0 and position('pg_net' in lower(p.prosrc)) = 0
   from pg_proc p where p.oid = 'public.whatsapp_enable_channel_send(uuid, uuid, uuid)'::regprocedure),
  'a função não faz chamada de rede'
);

set local role anon;
select throws_ok(
  format($i$ select public.whatsapp_enable_channel_send(%L::uuid, %L::uuid, %L::uuid) $i$, :'yc_ok', :'ws_um', :'ana'),
  '42501', null, 'anon não chama o portão'
);
reset role;
set local role service_role;
select set_config('request.jwt.claims', '', true);
select set_config('request.headers', :'h_prev', true);

-- ---------------------------------------------------------------------
-- 2) Ambiente: ausente, forjado, vencido, malformado, chave do outro ambiente
-- ---------------------------------------------------------------------

select set_config('request.headers', '{}', true);
select throws_ok(
  format($i$ select whatsapp_enable_channel_send(%L::uuid, %L::uuid, %L::uuid) $i$, :'yc_ok', :'ws_um', :'ana'),
  'P0001', 'whatsapp_environment_required', 'sem cabeçalho de ambiente: recusado'
);
select set_config('request.headers', :'h_forjado', true);
select throws_ok(
  format($i$ select whatsapp_enable_channel_send(%L::uuid, %L::uuid, %L::uuid) $i$, :'yc_ok', :'ws_um', :'ana'),
  'P0001', 'whatsapp_environment_required', 'assinatura forjada: recusada'
);
select set_config('request.headers', :'h_vencido', true);
select throws_ok(
  format($i$ select whatsapp_enable_channel_send(%L::uuid, %L::uuid, %L::uuid) $i$, :'yc_ok', :'ws_um', :'ana'),
  'P0001', 'whatsapp_environment_required', 'assinatura vencida: recusada'
);
select set_config('request.headers', :'h_lixo', true);
select throws_ok(
  format($i$ select whatsapp_enable_channel_send(%L::uuid, %L::uuid, %L::uuid) $i$, :'yc_ok', :'ws_um', :'ana'),
  'P0001', 'whatsapp_environment_required', 'cabeçalho malformado: recusado'
);
select set_config('request.headers', :'h_prod_chave_preview', true);
select throws_ok(
  format($i$ select whatsapp_enable_channel_send(%L::uuid, %L::uuid, %L::uuid) $i$, :'yc_prod', :'ws_um', :'ana'),
  'P0001', 'whatsapp_environment_required', 'Production assinada com a chave de Preview: recusada, mesmo para o canal de Production'
);
select set_config('request.headers', :'h_prev', true);

-- ---------------------------------------------------------------------
-- 3) Papéis e workspace: só owner e admin do workspace do canal
-- ---------------------------------------------------------------------

select throws_ok(
  format($i$ select whatsapp_enable_channel_send(%L::uuid, %L::uuid, %L::uuid) $i$, :'yc_ok', :'ws_um', :'daniel'),
  'P0001', 'insufficient_permission', 'manager não liga o envio'
);
select throws_ok(
  format($i$ select whatsapp_enable_channel_send(%L::uuid, %L::uuid, %L::uuid) $i$, :'yc_ok', :'ws_um', :'carla'),
  'P0001', 'insufficient_permission', 'lawyer não liga o envio'
);
select throws_ok(
  format($i$ select whatsapp_enable_channel_send(%L::uuid, %L::uuid, %L::uuid) $i$, :'yc_adm', :'ws_dois', :'carla'),
  'P0001', 'insufficient_permission', 'sales não liga o envio'
);
select throws_ok(
  format($i$ select whatsapp_enable_channel_send(%L::uuid, %L::uuid, %L::uuid) $i$, :'yc_ok', :'ws_um', :'leitor'),
  'P0001', 'insufficient_permission', 'viewer não liga o envio'
);
select throws_ok(
  format($i$ select whatsapp_enable_channel_send(%L::uuid, %L::uuid, %L::uuid) $i$, :'yc_ok', :'ws_um', :'bruno'),
  'P0001', 'insufficient_permission', 'dono de OUTRO workspace não liga o envio'
);
select throws_ok(
  format($i$ select whatsapp_enable_channel_send(%L::uuid, %L::uuid, %L::uuid) $i$, :'yc_adm', :'ws_dois', :'ana'),
  'P0001', 'insufficient_permission', 'dona do Um, sem vínculo com o Dois, não liga o envio do canal do Dois'
);
select throws_ok(
  format($i$ select whatsapp_enable_channel_send(%L::uuid, %L::uuid, %L::uuid) $i$, :'yc_adm', :'ws_um', :'ana'),
  'P0001', 'channel_not_found', 'canal de outro workspace, pedido com o workspace do ator: não encontrado'
);

-- ---------------------------------------------------------------------
-- 4) Provedor e ambiente: YCloud só no Preview; Meta nunca
-- ---------------------------------------------------------------------

select throws_ok(
  format($i$ select whatsapp_enable_channel_send(%L::uuid, %L::uuid, %L::uuid) $i$, :'meta_pv', :'ws_um', :'ana'),
  'P0001', 'provider_send_not_available', 'Meta no Preview, com api_key, continua recusada'
);
select set_config('request.headers', :'h_prod', true);
select throws_ok(
  format($i$ select whatsapp_enable_channel_send(%L::uuid, %L::uuid, %L::uuid) $i$, :'yc_prod', :'ws_um', :'ana'),
  'P0001', 'provider_send_not_available', 'YCloud em Production, ativo e com api_key, é recusado'
);
select throws_ok(
  format($i$ select whatsapp_enable_channel_send(%L::uuid, %L::uuid, %L::uuid) $i$, :'meta_pd', :'ws_um', :'ana'),
  'P0001', 'provider_send_not_available', 'Meta em Production é recusada'
);
select throws_ok(
  format($i$ select whatsapp_enable_channel_send(%L::uuid, %L::uuid, %L::uuid) $i$, :'yc_ok', :'ws_um', :'ana'),
  'P0001', 'channel_not_found', 'cabeçalho de Production não alcança o canal de Preview'
);
select set_config('request.headers', :'h_prev', true);
select throws_ok(
  format($i$ select whatsapp_enable_channel_send(%L::uuid, %L::uuid, %L::uuid) $i$, :'yc_prod', :'ws_um', :'ana'),
  'P0001', 'channel_not_found', 'cabeçalho de Preview não alcança o canal de Production'
);

-- ---------------------------------------------------------------------
-- 5) Canal que não está ativo
-- ---------------------------------------------------------------------

select throws_ok(
  format($i$ select whatsapp_enable_channel_send(%L::uuid, %L::uuid, %L::uuid) $i$, :'yc_paus', :'ws_um', :'ana'),
  'P0001', 'invalid_channel_state', 'canal pausado (como nasce) não liga o envio'
);
select throws_ok(
  format($i$ select whatsapp_enable_channel_send(%L::uuid, %L::uuid, %L::uuid) $i$, :'yc_disc', :'ws_um', :'ana'),
  'P0001', 'invalid_channel_state', 'canal desconectado não liga o envio'
);
select throws_ok(
  format($i$ select whatsapp_enable_channel_send(%L::uuid, %L::uuid, %L::uuid) $i$, :'yc_off', :'ws_um', :'ana'),
  'P0001', 'invalid_channel_state', 'canal desativado não liga o envio'
);

-- ---------------------------------------------------------------------
-- 6) Credencial: só a api_key do mesmo canal habilita
-- ---------------------------------------------------------------------

select throws_ok(
  format($i$ select whatsapp_enable_channel_send(%L::uuid, %L::uuid, %L::uuid) $i$, :'yc_nada', :'ws_um', :'ana'),
  'P0001', 'credential_not_found', 'canal ativo sem nenhuma credencial não liga o envio'
);
select throws_ok(
  format($i$ select whatsapp_enable_channel_send(%L::uuid, %L::uuid, %L::uuid) $i$, :'yc_whk', :'ws_um', :'ana'),
  'P0001', 'credential_not_found', 'só o webhook_secret NÃO habilita o envio, mesmo havendo api_key em outros canais (do mesmo e de outro workspace)'
);
select is(
  (select count(*)::int from public.whatsapp_channel_credentials where channel_id = :'yc_whk'::uuid and purpose = 'webhook_secret'),
  1,
  'e o segredo do webhook continua lá: ele só não conta como chave de envio'
);

reset role;
select throws_ok(
  format($i$ insert into public.whatsapp_channel_credentials (channel_id, workspace_id, environment, provider, purpose, ciphertext, key_version) values (%L::uuid, %L::uuid, 'preview', 'ycloud', 'api_key', %L, '1') $i$, :'yc_whk', :'ws_dois', :'cifra_api'),
  '23503', null, 'api_key com o workspace de outro canal não pode ser gravada para este canal'
);
select throws_ok(
  format($i$ insert into public.whatsapp_channel_credentials (channel_id, workspace_id, environment, provider, purpose, ciphertext, key_version) values (%L::uuid, %L::uuid, 'production', 'ycloud', 'api_key', %L, '1') $i$, :'yc_whk', :'ws_um', :'cifra_api'),
  '23503', null, 'api_key de outro ambiente não pode ser gravada para este canal'
);
select throws_ok(
  format($i$ insert into public.whatsapp_channel_credentials (channel_id, workspace_id, environment, provider, purpose, ciphertext, key_version) values (%L::uuid, %L::uuid, 'preview', 'meta', 'api_key', %L, '1') $i$, :'yc_whk', :'ws_um', :'cifra_api'),
  '23503', null, 'api_key de outro provedor não pode ser gravada para este canal'
);
set local role service_role;
select set_config('request.jwt.claims', '', true);
select set_config('request.headers', :'h_prev', true);

select is(
  (select count(*)::int from public.whatsapp_channels
   where id in (:'yc_ok'::uuid, :'yc_adm'::uuid, :'yc_whk'::uuid, :'yc_nada'::uuid, :'yc_paus'::uuid, :'yc_disc'::uuid, :'yc_off'::uuid,
                :'yc_prod'::uuid, :'meta_pv'::uuid, :'meta_pd'::uuid, :'sim_pv'::uuid, :'sim_pd'::uuid) and send_enabled),
  0,
  'nenhuma das recusas ligou o envio'
);

-- ---------------------------------------------------------------------
-- 7) Quem pode: owner e admin, canal YCloud ativo do Preview com api_key
-- ---------------------------------------------------------------------

select is(
  (select count(*)::int from public.whatsapp_get_channel_credential(:'yc_ok'::uuid, :'ws_um'::uuid, 'ycloud', 'B44WABA:5511000000a1', 'api_key')),
  0,
  'antes de ligar o envio, a api_key do canal não sai do banco'
);

select whatsapp_enable_channel_send(:'yc_ok'::uuid, :'ws_um'::uuid, :'ana'::uuid) as ligado \gset
select is((:'ligado'::jsonb) -> 'send_enabled', 'true'::jsonb, 'owner liga o envio do canal YCloud ativo do Preview com api_key');
select ok(
  (:'ligado'::jsonb) ->> 'provider' = 'ycloud' and (:'ligado'::jsonb) ->> 'environment' = 'preview' and (:'ligado'::jsonb) ->> 'status' = 'active',
  'o retorno é a projeção segura do canal: ycloud, preview, ativo'
);
select ok(
  position(:'cifra_api' in (:'ligado'::jsonb)::text) = 0 and position(:'cifra_hook' in (:'ligado'::jsonb)::text) = 0,
  'o retorno não traz nenhum texto cifrado de credencial'
);
select is(
  (select count(*)::int from public.whatsapp_get_channel_credential(:'yc_ok'::uuid, :'ws_um'::uuid, 'ycloud', 'B44WABA:5511000000a1', 'api_key')),
  1,
  'com o envio ligado e o canal ativo, a api_key do canal (e só dele) passa a sair para o servidor'
);
select is(
  (select count(*)::int from public.whatsapp_get_channel_credential(:'yc_adm'::uuid, :'ws_dois'::uuid, 'ycloud', 'B44WABA:5511000000a2', 'api_key')),
  0,
  'e nenhum outro canal ganhou a chave'
);

select whatsapp_enable_channel_send(:'yc_adm'::uuid, :'ws_dois'::uuid, :'daniel'::uuid) as ligado_adm \gset
select is((:'ligado_adm'::jsonb) -> 'send_enabled', 'true'::jsonb, 'admin liga o envio do canal YCloud do seu workspace');

select is(
  (select jsonb_agg(metadata order by resource_id) from public.audit_logs
   where action = 'whatsapp.channel.send_enabled' and resource_id in (:'yc_ok'::uuid, :'yc_adm'::uuid)),
  '[{"provider": "ycloud", "environment": "preview"}, {"provider": "ycloud", "environment": "preview"}]'::jsonb,
  'a auditoria registra só ambiente e provedor'
);
select is(
  (select count(*)::int from public.audit_logs where metadata::text like '%' || :'cifra_api' || '%' or metadata::text like '%' || :'cifra_hook' || '%'),
  0,
  'nenhuma auditoria contém texto cifrado de credencial'
);

select whatsapp_disable_channel_send(:'yc_ok'::uuid, :'ws_um'::uuid, :'ana'::uuid) is not null as ok \gset
select is(
  (select count(*)::int from public.whatsapp_get_channel_credential(:'yc_ok'::uuid, :'ws_um'::uuid, 'ycloud', 'B44WABA:5511000000a1', 'api_key')),
  0,
  'desligar o envio fecha de novo o acesso à api_key'
);
select throws_ok(
  format($i$ select whatsapp_enable_channel_send(%L::uuid, %L::uuid, %L::uuid) $i$, :'yc_ok', :'ws_um', :'daniel'),
  'P0001', 'insufficient_permission', 'e o manager continua sem poder religar'
);

-- ---------------------------------------------------------------------
-- 8) Provedor simulado: comportamento mantido
-- ---------------------------------------------------------------------

select is(
  (whatsapp_enable_channel_send(:'sim_pv'::uuid, :'ws_um'::uuid, :'ana'::uuid)) -> 'send_enabled',
  'true'::jsonb,
  'simulado no Preview: owner liga o envio, como antes'
);
select set_config('request.headers', :'h_prod', true);
select throws_ok(
  format($i$ select whatsapp_enable_channel_send(%L::uuid, %L::uuid, %L::uuid) $i$, :'sim_pd', :'ws_um', :'ana'),
  'P0001', 'invalid_channel_state', 'simulado em Production continua recusado'
);
select set_config('request.headers', :'h_prev', true);
select is(
  (select count(*)::int from public.whatsapp_channels where send_enabled and id in (:'yc_prod'::uuid, :'meta_pv'::uuid, :'meta_pd'::uuid, :'sim_pd'::uuid, :'yc_whk'::uuid, :'yc_nada'::uuid)),
  0,
  'Production, Meta e canais sem api_key seguem com o envio desligado'
);

select * from finish();
rollback;
