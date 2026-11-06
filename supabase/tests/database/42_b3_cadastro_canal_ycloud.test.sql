-- pgTAP — B3: cadastro controlado de canal YCloud
-- (docs/decisoes/b3-whatsapp-real.md §28.17).
--
-- Prova: owner e admin criam; manager, lawyer, viewer e quem é de outro
-- workspace são recusados; ambiente ausente, forjado, vencido ou assinado com a
-- chave do outro ambiente é recusado; o provedor é sempre ycloud; routing key
-- duplicada é recusada com um único código, venha o conflito de onde vier; o
-- localizador do webhook é aleatório e só aparece na criação; as credenciais
-- ficam como o texto cifrado enviado e não aparecem em retorno, listagem,
-- estado, erro nem auditoria; o webhook só alcança o segredo do webhook; a
-- chave de API só sai de canal ativo com envio habilitado; o canal nasce
-- pausado e sem envio; falha no meio desfaz canal, credenciais e auditoria.
-- Nenhuma chave real: valores de teste, só desta transação.

begin;
select plan(54);

\set ana     '20000000-0000-0000-0000-000000000001'
\set bruno   '20000000-0000-0000-0000-000000000002'
\set carla   '20000000-0000-0000-0000-000000000003'
\set daniel  '20000000-0000-0000-0000-000000000004'
\set leitor  '20000000-0000-0000-0000-000000000005'
\set ws_um   '10000000-0000-0000-0000-000000000001'
\set ws_dois '10000000-0000-0000-0000-000000000002'
\set ch_a    '51000000-0000-0000-0000-00000000000a'
\set ch_b    '51000000-0000-0000-0000-00000000000b'
\set ch_c    '51000000-0000-0000-0000-00000000000c'
\set ch_p    '51000000-0000-0000-0000-00000000000d'
\set ch_x    '51000000-0000-0000-0000-00000000000e'
\set cifra_hook 'SE9PS0hPT0tIT09LSE9PS0hPT0tIT09LSE9PS0hPT0tIT09LSE9PS0hPT0s'
\set cifra_api  'QVBJS0VZQVBJS0VZQVBJS0VZQVBJS0VZQVBJS0VZQVBJS0VZQVBJS0VZQVA'
\set cifra_nova 'Tk9WQU5PVkFOT1ZBTk9WQU5PVkFOT1ZBTk9WQU5PVkFOT1ZBTk9WQU5PVkE'

-- daniel: manager no Um, admin no Dois. carla: lawyer no Um. leitor: viewer no Um.
-- bruno: dono do Dois, sem vínculo com o Um.
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

-- Chamada padrão: ator, workspace, rótulo, routing key, número e as duas cifras.
create function pg_temp.criar(p_canal uuid, p_ws uuid, p_ator uuid, p_rk text, p_hook text, p_api text)
returns jsonb language sql as $f$
  select public.whatsapp_create_ycloud_channel(
    p_canal, p_ws, p_ator, ' Canal YCloud ', p_rk, '+55 11 0000-0303', p_hook, '1', p_api, '1'
  )
$f$;

-- ---------------------------------------------------------------------
-- 1) Privilégios
-- ---------------------------------------------------------------------

select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'whatsapp_create_ycloud_channel'
     and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute')
          or exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0))),
  0,
  'a criação de canal YCloud não é executável por anon, authenticated nem public'
);
select ok(
  (select has_function_privilege('service_role', p.oid, 'execute') from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'whatsapp_create_ycloud_channel'),
  'a criação de canal YCloud é executável por service_role'
);
select ok(
  (select p.prosecdef and p.proconfig @> array['search_path=""'] from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'whatsapp_create_ycloud_channel'),
  'SECURITY DEFINER com search_path travado'
);

set local role anon;
select throws_ok(
  format($i$ select public.whatsapp_create_ycloud_channel(%L::uuid, %L::uuid, %L::uuid, 'x', 'rk-anon', '1', %L, '1', %L, '1') $i$, :'ch_x', :'ws_um', :'ana', :'cifra_hook', :'cifra_api'),
  '42501', null, 'anon não chama a criação'
);
reset role;

-- ---------------------------------------------------------------------
-- 2) Ambiente: ausente, forjado, vencido, chave do outro ambiente
-- ---------------------------------------------------------------------

set local role service_role;

select set_config('request.headers', '{}', true);
select throws_ok(
  format($i$ select pg_temp.criar(%L::uuid, %L::uuid, %L::uuid, 'rk-env', %L, %L) $i$, :'ch_x', :'ws_um', :'ana', :'cifra_hook', :'cifra_api'),
  'P0001', 'whatsapp_environment_required', 'sem cabeçalho: recusado'
);
select set_config('request.headers', :'h_forjado', true);
select throws_ok(
  format($i$ select pg_temp.criar(%L::uuid, %L::uuid, %L::uuid, 'rk-env', %L, %L) $i$, :'ch_x', :'ws_um', :'ana', :'cifra_hook', :'cifra_api'),
  'P0001', 'whatsapp_environment_required', 'assinatura forjada: recusada'
);
select set_config('request.headers', :'h_vencido', true);
select throws_ok(
  format($i$ select pg_temp.criar(%L::uuid, %L::uuid, %L::uuid, 'rk-env', %L, %L) $i$, :'ch_x', :'ws_um', :'ana', :'cifra_hook', :'cifra_api'),
  'P0001', 'whatsapp_environment_required', 'assinatura vencida: recusada'
);
select set_config('request.headers', :'h_prod_chave_preview', true);
select throws_ok(
  format($i$ select pg_temp.criar(%L::uuid, %L::uuid, %L::uuid, 'rk-env', %L, %L) $i$, :'ch_x', :'ws_um', :'ana', :'cifra_hook', :'cifra_api'),
  'P0001', 'whatsapp_environment_required', 'Production assinada com a chave de Preview: recusada'
);

-- ---------------------------------------------------------------------
-- 3) Papéis e workspace
-- ---------------------------------------------------------------------

select set_config('request.headers', :'h_prev', true);

select throws_ok(
  format($i$ select pg_temp.criar(%L::uuid, %L::uuid, %L::uuid, 'rk-papel', %L, %L) $i$, :'ch_x', :'ws_um', :'daniel', :'cifra_hook', :'cifra_api'),
  'P0001', 'insufficient_permission', 'manager é recusado'
);
select throws_ok(
  format($i$ select pg_temp.criar(%L::uuid, %L::uuid, %L::uuid, 'rk-papel', %L, %L) $i$, :'ch_x', :'ws_um', :'carla', :'cifra_hook', :'cifra_api'),
  'P0001', 'insufficient_permission', 'lawyer é recusado'
);
select throws_ok(
  format($i$ select pg_temp.criar(%L::uuid, %L::uuid, %L::uuid, 'rk-papel', %L, %L) $i$, :'ch_x', :'ws_um', :'leitor', :'cifra_hook', :'cifra_api'),
  'P0001', 'insufficient_permission', 'viewer é recusado'
);
select throws_ok(
  format($i$ select pg_temp.criar(%L::uuid, %L::uuid, %L::uuid, 'rk-papel', %L, %L) $i$, :'ch_x', :'ws_um', :'bruno', :'cifra_hook', :'cifra_api'),
  'P0001', 'insufficient_permission', 'dono de outro workspace não cria no Um'
);
select throws_ok(
  format($i$ select pg_temp.criar(%L::uuid, %L::uuid, %L::uuid, 'rk-papel', %L, %L) $i$, :'ch_x', :'ws_dois', :'ana', :'cifra_hook', :'cifra_api'),
  'P0001', 'insufficient_permission', 'dono do Um não cria no Dois'
);
select throws_ok(
  format($i$ select pg_temp.criar(%L::uuid, %L::uuid, null, 'rk-papel', %L, %L) $i$, :'ch_x', :'ws_um', :'cifra_hook', :'cifra_api'),
  'P0001', 'actor_required', 'sem ator: recusado'
);

-- ---------------------------------------------------------------------
-- 4) Owner e admin criam; estado inicial seguro
-- ---------------------------------------------------------------------

select pg_temp.criar(:'ch_a'::uuid, :'ws_um'::uuid, :'ana'::uuid, 'WABA1:5511000000001', :'cifra_hook', :'cifra_api') as criado_a \gset

select is((:'criado_a'::jsonb) ->> 'provider', 'ycloud', 'o provedor é ycloud');
select is((:'criado_a'::jsonb) ->> 'environment', 'preview', 'ambiente vem do cabeçalho assinado (preview)');
select is((:'criado_a'::jsonb) ->> 'status', 'paused', 'o canal nasce pausado');
select is((:'criado_a'::jsonb) -> 'send_enabled', 'false'::jsonb, 'o canal nasce com envio desligado');
select is((:'criado_a'::jsonb) -> 'is_simulator', 'false'::jsonb, 'o canal não é simulador');
select is((:'criado_a'::jsonb) ->> 'label', 'Canal YCloud', 'nome gravado sem espaços nas pontas');
select is((:'criado_a'::jsonb) -> 'credential_purposes', '["api_key", "webhook_secret"]'::jsonb, 'as duas credenciais gravadas; só os propósitos aparecem');

select ok(
  (select c.phone_number_id is null and c.created_by = :'ana'::uuid and c.status_changed_at is not null
   from public.whatsapp_channels c where c.id = :'ch_a'::uuid),
  'canal da B3: sem phone_number_id (a A7 nunca o alcança), criado pelo ator'
);

select ok(
  (whatsapp_create_ycloud_channel(
    :'ch_b'::uuid, :'ws_dois'::uuid, :'daniel'::uuid, 'Canal Dois', 'WABA2:5511000000002', '+55 11 0000-0404', :'cifra_hook', '1', :'cifra_api', '1'
  )) ->> 'id' = :'ch_b',
  'admin cria no próprio workspace'
);

-- ---------------------------------------------------------------------
-- 5) Routing key duplicada: um único código, de onde vier o conflito
-- ---------------------------------------------------------------------

select throws_ok(
  format($i$ select pg_temp.criar(%L::uuid, %L::uuid, %L::uuid, 'WABA1:5511000000001', %L, %L) $i$, :'ch_x', :'ws_um', :'ana', :'cifra_hook', :'cifra_api'),
  'P0001', 'channel_routing_key_taken', 'mesma routing key no mesmo workspace e ambiente'
);
select throws_ok(
  format($i$ select pg_temp.criar(%L::uuid, %L::uuid, %L::uuid, ' WABA1:5511000000001 ', %L, %L) $i$, :'ch_x', :'ws_um', :'ana', :'cifra_hook', :'cifra_api'),
  'P0001', 'channel_routing_key_taken', 'espaços nas pontas não escapam da unicidade'
);
select throws_ok(
  format($i$ select pg_temp.criar(%L::uuid, %L::uuid, %L::uuid, 'WABA1:5511000000001', %L, %L) $i$, :'ch_x', :'ws_dois', :'bruno', :'cifra_hook', :'cifra_api'),
  'P0001', 'channel_routing_key_taken', 'outro workspace recebe o mesmo código, sem saber de quem é'
);
select set_config('request.headers', :'h_prod', true);
select throws_ok(
  format($i$ select pg_temp.criar(%L::uuid, %L::uuid, %L::uuid, 'WABA1:5511000000001', %L, %L) $i$, :'ch_x', :'ws_um', :'ana', :'cifra_hook', :'cifra_api'),
  'P0001', 'channel_routing_key_taken', 'outro ambiente também recebe o mesmo código'
);
select set_config('request.headers', :'h_prev', true);

-- ---------------------------------------------------------------------
-- 6) Localizador do webhook: aleatório, gerado pelo banco, só na criação
-- ---------------------------------------------------------------------

select ok(
  (:'criado_a'::jsonb) ->> 'webhook_route_id' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
  'o localizador é um UUID aleatório (versão 4)'
);
select isnt((:'criado_a'::jsonb) ->> 'webhook_route_id', :'ch_a', 'o localizador não é o id do canal');
select ok(
  (select c.webhook_route_id::text not in (
      md5(c.routing_key)::uuid::text, md5(lower(c.routing_key))::uuid::text, md5(c.id::text)::uuid::text,
      md5(c.routing_key || c.id::text)::uuid::text)
     and c.webhook_route_id <> c.id and c.webhook_route_id <> c.workspace_id
   from public.whatsapp_channels c where c.id = :'ch_a'::uuid),
  'o localizador não é derivado da routing key (nem é o id do canal ou do workspace)'
);
select is(
  (select count(distinct c.webhook_route_id)::int from public.whatsapp_channels c where c.id in (:'ch_a'::uuid, :'ch_b'::uuid)),
  2,
  'cada canal tem o seu localizador'
);
select ok(
  not (whatsapp_get_channel_state(:'ch_a'::uuid, :'ws_um'::uuid, :'ana'::uuid) ? 'webhook_route_id')
    and position((:'criado_a'::jsonb) ->> 'webhook_route_id' in whatsapp_list_channels(:'ws_um'::uuid, :'ana'::uuid)::text) = 0,
  'nem o estado nem a listagem trazem o localizador'
);

-- ---------------------------------------------------------------------
-- 7) Credenciais: guardadas como enviadas, nunca devolvidas
-- ---------------------------------------------------------------------

select is(
  (select ciphertext from public.whatsapp_channel_credentials where channel_id = :'ch_a'::uuid and purpose = 'webhook_secret'),
  :'cifra_hook',
  'segredo do webhook guardado exatamente como o servidor o cifrou'
);
select is(
  (select ciphertext from public.whatsapp_channel_credentials where channel_id = :'ch_a'::uuid and purpose = 'api_key'),
  :'cifra_api',
  'chave de API guardada exatamente como o servidor a cifrou'
);
select ok(
  position(:'cifra_hook' in (:'criado_a'::jsonb)::text) = 0 and position(:'cifra_api' in (:'criado_a'::jsonb)::text) = 0
    and not ((:'criado_a'::jsonb) ? 'ciphertext') and not ((:'criado_a'::jsonb) ? 'key_version'),
  'o retorno da criação não carrega texto cifrado nem versão de chave'
);
select ok(
  position(:'cifra_hook' in whatsapp_list_channels(:'ws_um'::uuid, :'ana'::uuid)::text) = 0
    and position(:'cifra_api' in whatsapp_list_channels(:'ws_um'::uuid, :'ana'::uuid)::text) = 0
    and position(:'cifra_api' in whatsapp_get_channel_state(:'ch_a'::uuid, :'ws_um'::uuid, :'ana'::uuid)::text) = 0
    and position('key_version' in whatsapp_list_channels(:'ws_um'::uuid, :'ana'::uuid)::text) = 0,
  'listagem e estado nunca retornam credencial'
);
select ok(
  (select count(*) = 1 and bool_and(
      position(:'cifra_hook' in a.metadata::text) = 0 and position(:'cifra_api' in a.metadata::text) = 0
      and position('WABA1' in a.metadata::text) = 0 and position((:'criado_a'::jsonb) ->> 'webhook_route_id' in a.metadata::text) = 0
      and a.metadata = jsonb_build_object('environment', 'preview', 'provider', 'ycloud'))
   from public.audit_logs a where a.resource_id = :'ch_a'::uuid),
  'a auditoria tem uma linha, só com ambiente e provedor'
);
select throws_ok(
  format($i$ select pg_temp.criar(%L::uuid, %L::uuid, %L::uuid, 'rk-erro', 'x', %L) $i$, :'ch_x', :'ws_um', :'ana', :'cifra_api'),
  'P0001', 'invalid_credential', 'cifra inválida: erro simbólico, sem eco do valor'
);

-- ---------------------------------------------------------------------
-- 8) O webhook só alcança o segredo do webhook
-- ---------------------------------------------------------------------

select is(
  (select count(*)::int from whatsapp_resolve_webhook_channel('ycloud', 'WABA1:5511000000001')),
  1,
  'a resolução do webhook devolve uma linha (canal pausado continua resolvido)'
);
select is(
  (select ciphertext from whatsapp_resolve_webhook_channel('ycloud', 'WABA1:5511000000001')),
  :'cifra_hook',
  'e ela é o segredo do webhook, nunca a chave de API'
);
select is(
  (select count(*)::int from whatsapp_resolve_webhook_channel('ycloud', 'WABA1:5511000000001') r where r.ciphertext = :'cifra_api'),
  0,
  'a chave de API não sai pela resolução do webhook'
);

-- ---------------------------------------------------------------------
-- 9) A chave de API só sai de canal ativo com envio habilitado
-- ---------------------------------------------------------------------

select is(
  (select count(*)::int from whatsapp_get_channel_credential(:'ch_a'::uuid, :'ws_um'::uuid, 'ycloud', 'WABA1:5511000000001', 'api_key')),
  0,
  'canal pausado e sem envio: a chave de API não sai'
);
select is(
  (select ciphertext from whatsapp_get_channel_credential(:'ch_a'::uuid, :'ws_um'::uuid, 'ycloud', 'WABA1:5511000000001', 'webhook_secret')),
  :'cifra_hook',
  'o segredo do webhook continua saindo, independente do envio'
);

reset role;
update public.whatsapp_channels set status = 'active' where id = :'ch_a'::uuid;
set local role service_role;
select set_config('request.headers', :'h_prev', true);

select is(
  (select count(*)::int from whatsapp_get_channel_credential(:'ch_a'::uuid, :'ws_um'::uuid, 'ycloud', 'WABA1:5511000000001', 'api_key')),
  0,
  'canal ativo, mas com envio desligado: a chave de API não sai'
);

reset role;
update public.whatsapp_channels set send_enabled = true where id = :'ch_a'::uuid;
set local role service_role;
select set_config('request.headers', :'h_prev', true);

select is(
  (select ciphertext from whatsapp_get_channel_credential(:'ch_a'::uuid, :'ws_um'::uuid, 'ycloud', 'WABA1:5511000000001', 'api_key')),
  :'cifra_api',
  'canal ativo com envio habilitado (futuro): a chave de API sai'
);

reset role;
update public.whatsapp_channels set status = 'paused' where id = :'ch_a'::uuid;
set local role service_role;
select set_config('request.headers', :'h_prev', true);

select is(
  (select count(*)::int from whatsapp_get_channel_credential(:'ch_a'::uuid, :'ws_um'::uuid, 'ycloud', 'WABA1:5511000000001', 'api_key')),
  0,
  'envio habilitado, mas canal pausado: a chave de API não sai'
);
select throws_ok(
  format($i$ select * from whatsapp_get_channel_credential(%L::uuid, %L::uuid, 'ycloud', 'WABA2:5511000000002', 'api_key') $i$, :'ch_a', :'ws_um'),
  'P0001', 'channel_not_found', 'identidade que não bate com o canal: não encontrado, sem distinguir o motivo'
);

-- ---------------------------------------------------------------------
-- 10) Substituição do segredo do webhook (a YCloud o entrega depois)
-- ---------------------------------------------------------------------

select ok(
  position(:'cifra_nova' in (whatsapp_store_channel_credential(:'ch_a'::uuid, :'ws_um'::uuid, :'ana'::uuid, 'webhook_secret', :'cifra_nova', '1'))::text) = 0,
  'substituir o segredo do webhook não o devolve'
);
select is(
  (select ciphertext from whatsapp_resolve_webhook_channel('ycloud', 'WABA1:5511000000001')),
  :'cifra_nova',
  'o webhook passa a resolver o segredo novo'
);
select throws_ok(
  format($i$ select whatsapp_store_channel_credential(%L::uuid, %L::uuid, %L::uuid, 'webhook_secret', %L, '1') $i$, :'ch_a', :'ws_um', :'daniel', :'cifra_nova'),
  'P0001', 'insufficient_permission', 'manager não substitui credencial'
);

-- ---------------------------------------------------------------------
-- 11) Falha no meio desfaz tudo
-- ---------------------------------------------------------------------

select throws_ok(
  format($i$ select pg_temp.criar(%L::uuid, %L::uuid, %L::uuid, 'WABA3:5511000000003', %L, 'inválida') $i$, :'ch_p', :'ws_um', :'ana', :'cifra_hook'),
  'P0001', 'invalid_credential', 'chave de API inválida depois do canal criado: erro simbólico'
);

reset role;

select is(
  (select count(*)::int from public.whatsapp_channels where id = :'ch_p'::uuid or routing_key = 'WABA3:5511000000003'),
  0,
  'a falha desfez o canal'
);
select is(
  (select count(*)::int from public.whatsapp_channel_credentials where channel_id = :'ch_p'::uuid),
  0,
  'a falha desfez as credenciais'
);
select is(
  (select count(*)::int from public.audit_logs where resource_id = :'ch_p'::uuid),
  0,
  'a falha não deixou auditoria'
);

select * from finish();
rollback;
