-- pgTAP — B3.2d-1: claim atômico da inbox do webhook de WhatsApp.
--
-- Prova: a entrada só é processada por quem obteve o claim. O claim recebe
-- SÓ o id da inbox e a duração da lease; ambiente, workspace, canal, estado
-- do canal, provedor e routing key saem do banco, nunca do evento interno.
-- Estados: pending → processing → processed | failed, e processing →
-- pending (release); lease vigente responde busy, lease vencida pode ser
-- reclamada com token novo, e o token antigo deixa de valer. Complete, fail
-- e release só com o token atual. Entrada vencida ou expurgada não é
-- reclamada; outro ambiente não é encontrado; canal pausado, desconectado
-- ou desativado depois do recebimento não aprisiona a entrada. As RPCs
-- antigas sem claim (leitura de pendente e marcações) não existem mais, e
-- a tabela não tem privilégio direto nem para service_role. claim_count
-- conta aquisições de processamento e nunca diminui.
--
-- Uma sessão só: a concorrência REAL (duas transações abertas) está em
-- scripts/b3-2d1-inbox-claim-concurrency-check.sh.
--
-- Escrito ANTES da implementação, contra a main 4e7c004. Nenhuma chave
-- real: os valores cifrados são textos base64 fictícios. Leituras e
-- escritas das colunas novas passam por funções que capturam o erro: contra
-- a main, o arquivo roda até o fim e mostra cada asserção que falha.

begin;
select plan(82);

\set ana      '20000000-0000-0000-0000-000000000001'
\set bruno    '20000000-0000-0000-0000-000000000002'
\set ws_um    '10000000-0000-0000-0000-000000000001'
\set ws_dois  '10000000-0000-0000-0000-000000000002'
\set ch_a     '35000000-0000-0000-0000-000000000001'
\set ch_b     '35000000-0000-0000-0000-000000000002'
\set ch_p     '35000000-0000-0000-0000-000000000003'
\set ch_d     '35000000-0000-0000-0000-000000000004'
\set ch_x     '35000000-0000-0000-0000-000000000005'
\set ch_prod  '35000000-0000-0000-0000-000000000006'
\set inventado '7d1e2f3a-4b5c-4d6e-8f70-819a2b3c4d5e'
\set cifra    'QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFB'
\set nonce    'AAAAAAAAAAAAAAAA'
\set tag      'AAAAAAAAAAAAAAAAAAAAAA=='
\set corpo1   'Q29ycG8gZmljdGljaW8gMQ=='

select repeat('a', 64) as h1 \gset

insert into public.whatsapp_environment_keys (environment, signing_key) values
  ('production', 'chave-whatsapp-producao-de-teste-0123456789'),
  ('preview', 'chave-whatsapp-preview-de-teste-0123456789ab');

create function pg_temp.hdr(p_env text) returns text language sql as $f$
  select json_build_object(
    'x-praxis-whatsapp-env',
    'v1.' || p_env || '.' || e.x || '.' || private.whatsapp_environment_signature(
      p_env, e.x, (select signing_key from public.whatsapp_environment_keys where environment = p_env::public.whatsapp_environment)
    )
  )::text
  from (select extract(epoch from now())::bigint + 300 as x) e
$f$;

-- Resultado jsonb de uma chamada, ou {"erro": <mensagem>} se ela falhar
-- (função inexistente, recusa). Mantém a transação utilizável e a contagem
-- estável, inclusive contra a main sem a B3.2d-1.
create function pg_temp.j(p_sql text) returns jsonb language plpgsql as $f$
declare
  v jsonb;
begin
  execute p_sql into v;
  return coalesce(v, 'null'::jsonb);
exception when others then
  return jsonb_build_object('erro', sqlerrm);
end
$f$;

create function pg_temp.claim(p_id uuid, p_lease integer default 60) returns jsonb language sql as $f$
  select pg_temp.j(format('select public.whatsapp_inbox_claim(%L::uuid, %s)', p_id, coalesce(p_lease::text, 'null')))
$f$;

-- Resultado de um claim: o outcome, ou 'ERRO:<mensagem>'.
create function pg_temp.co(p_result jsonb) returns text language sql as $f$
  select coalesce(p_result ->> 'outcome', 'ERRO:' || coalesce(p_result ->> 'erro', p_result::text))
$f$;

-- complete / fail / release: o outcome, ou 'ERRO:<mensagem>'.
create function pg_temp.fin(p_fn text, p_id uuid, p_token uuid, p_code text default null) returns text language plpgsql as $f$
declare
  v jsonb;
begin
  if p_fn = 'complete' then
    execute format('select public.whatsapp_inbox_complete(%L::uuid, %L::uuid)', p_id, p_token) into v;
  else
    execute format('select public.whatsapp_inbox_%s(%L::uuid, %L::uuid, %L)', p_fn, p_id, p_token, p_code) into v;
  end if;
  return coalesce(v ->> 'outcome', 'NULL');
exception when others then
  return 'ERRO:' || sqlerrm;
end
$f$;

create function pg_temp.fin_keys(p_fn text, p_id uuid, p_token uuid, p_code text default null) returns text language plpgsql as $f$
declare
  v jsonb;
begin
  if p_fn = 'complete' then
    execute format('select public.whatsapp_inbox_complete(%L::uuid, %L::uuid)', p_id, p_token) into v;
  else
    execute format('select public.whatsapp_inbox_%s(%L::uuid, %L::uuid, %L)', p_fn, p_id, p_token, p_code) into v;
  end if;
  return (select string_agg(k, ',' order by k collate "C") from jsonb_object_keys(v) k);
exception when others then
  return 'ERRO:' || sqlerrm;
end
$f$;

-- Gravação de uma entrega fictícia (B3.2b); devolve o id da inbox.
create function pg_temp.put(p_channel uuid, p_ws uuid, p_routing text, p_event text) returns uuid language sql as $f$
  select (public.whatsapp_inbox_store(
    p_channel, p_ws, 'simulated', p_routing, p_event, 'message.inbound', repeat('a', 64), '1',
    'AAAAAAAAAAAAAAAA', 'Q29ycG8gZmljdGljaW8gMQ==', 'AAAAAAAAAAAAAAAAAAAAAA==', 3600
  ) ->> 'inbox_id')::uuid
$f$;

-- Estado de uma entrada, lido como postgres (a tabela não tem privilégio
-- nem para service_role). Em plpgsql e com captura de erro, para o arquivo
-- rodar até o fim também contra a main sem as colunas do claim.
create function pg_temp.st(p_id uuid) returns text language plpgsql as $f$
declare
  v text;
begin
  select state || '|' || claim_count || '|' || (claim_token is not null)::text || '|' || (claimed_at is not null)::text || '|' || (lease_until is not null)::text
  into v from public.whatsapp_webhook_inbox where id = p_id;
  return coalesce(v, 'NULL');
exception when others then
  return 'ERRO:' || sqlerrm;
end
$f$;

create function pg_temp.tok(p_id uuid) returns text language plpgsql as $f$
declare
  v text;
begin
  select claim_token::text into v from public.whatsapp_webhook_inbox where id = p_id;
  return coalesce(v, 'NULL');
exception when others then
  return 'ERRO:' || sqlerrm;
end
$f$;

-- Texto de uma consulta, ou 'ERRO:<mensagem>'.
create function pg_temp.txt(p_sql text) returns text language plpgsql as $f$
declare
  v text;
begin
  execute p_sql into v;
  return coalesce(v, 'NULL');
exception when others then
  return 'ERRO:' || sqlerrm;
end
$f$;

-- Escrita direta de preparo (como postgres); contra a main sem as colunas
-- do claim, não aborta o arquivo.
create function pg_temp.exec(p_sql text) returns void language plpgsql as $f$
begin
  execute p_sql;
exception when others then
  null;
end
$f$;

select pg_temp.hdr('preview') as h_prev \gset
select pg_temp.hdr('production') as h_prod \gset

-- ---------------------------------------------------------------------
-- Cenário: canais em Preview (dois workspaces e três que mudam de estado
-- depois do recebimento) e um canal em Production; entregas gravadas com
-- o canal ativo.
-- ---------------------------------------------------------------------

set local role service_role;
select set_config('request.jwt.claims', '', true);
select set_config('request.headers', :'h_prev', true);
select whatsapp_create_simulated_channel(:'ch_a'::uuid, :'ws_um'::uuid, :'ana'::uuid, 'A', 'b3c-a', '1', :'cifra', '1') is not null as ok \gset
select whatsapp_create_simulated_channel(:'ch_b'::uuid, :'ws_dois'::uuid, :'bruno'::uuid, 'B', 'b3c-b', '1', :'cifra', '1') is not null as ok \gset
select whatsapp_create_simulated_channel(:'ch_p'::uuid, :'ws_um'::uuid, :'ana'::uuid, 'Vai pausar', 'b3c-p', '1', :'cifra', '1') is not null as ok \gset
select whatsapp_create_simulated_channel(:'ch_d'::uuid, :'ws_um'::uuid, :'ana'::uuid, 'Vai desconectar', 'b3c-d', '1', :'cifra', '1') is not null as ok \gset
select whatsapp_create_simulated_channel(:'ch_x'::uuid, :'ws_um'::uuid, :'ana'::uuid, 'Vai desativar', 'b3c-x', '1', :'cifra', '1') is not null as ok \gset
select pg_temp.put(:'ch_a', :'ws_um', 'b3c-a', 'evt-1') as e1 \gset
select pg_temp.put(:'ch_a', :'ws_um', 'b3c-a', 'evt-2') as e2 \gset
select pg_temp.put(:'ch_a', :'ws_um', 'b3c-a', 'evt-3') as e3 \gset
select pg_temp.put(:'ch_b', :'ws_dois', 'b3c-b', 'evt-1') as e4 \gset
select pg_temp.put(:'ch_a', :'ws_um', 'b3c-a', 'evt-velho') as e_old \gset
select pg_temp.put(:'ch_a', :'ws_um', 'b3c-a', 'evt-pp') as e_pp \gset
select pg_temp.put(:'ch_a', :'ws_um', 'b3c-a', 'evt-rp') as e_rp \gset
select pg_temp.put(:'ch_p', :'ws_um', 'b3c-p', 'evt-p') as e_p \gset
select pg_temp.put(:'ch_d', :'ws_um', 'b3c-d', 'evt-d') as e_d \gset
select pg_temp.put(:'ch_x', :'ws_um', 'b3c-x', 'evt-x') as e_x \gset
select set_config('request.headers', :'h_prod', true);
select whatsapp_create_simulated_channel(:'ch_prod'::uuid, :'ws_um'::uuid, :'ana'::uuid, 'Prod', 'b3c-prod', '1', :'cifra', '1') is not null as ok \gset
select pg_temp.put(:'ch_prod', :'ws_um', 'b3c-prod', 'evt-1') as e_prod \gset
reset role;
update public.whatsapp_channels set status = 'paused', send_enabled = false where id = :'ch_p'::uuid;
update public.whatsapp_channels set status = 'disconnected', send_enabled = false where id = :'ch_d'::uuid;
update public.whatsapp_channels set status = 'disabled', send_enabled = false where id = :'ch_x'::uuid;

-- ---------------------------------------------------------------------
-- 1) Estrutura: colunas do claim, combinações coerentes, sem atalho direto
-- ---------------------------------------------------------------------

select is(
  (select coalesce(string_agg(column_name::text, ',' order by column_name::text collate "C"), '')
   from information_schema.columns
   where table_schema = 'public' and table_name = 'whatsapp_webhook_inbox'),
  'auth_tag,body_sha256,channel_id,ciphertext,claim_count,claim_token,claimed_at,conflict_count,environment,error_code,failed_at,id,key_version,last_conflict_at,last_conflict_sha256,last_release_code,last_released_at,lease_until,nonce,processed_at,provider,provider_event_id,provider_event_type,purged_at,received_at,retain_until,state,workspace_id',
  'colunas: as da B3.2b mais token, horário e lease do claim, contagem de claims e evidência sanitizada da última liberação'
);
select is(
  (select coalesce(data_type || '|' || is_nullable || '|' || column_default, 'ausente') from information_schema.columns
   where table_schema = 'public' and table_name = 'whatsapp_webhook_inbox' and column_name = 'claim_count'),
  'integer|NO|0', 'claim_count: inteiro obrigatório, começa em 0'
);
select is(
  (select coalesce(string_agg(column_name::text || ':' || data_type, ',' order by column_name::text collate "C"), '')
   from information_schema.columns
   where table_schema = 'public' and table_name = 'whatsapp_webhook_inbox' and column_name in ('claim_token', 'claimed_at', 'lease_until')),
  'claim_token:uuid,claimed_at:timestamp with time zone,lease_until:timestamp with time zone', 'token uuid; horário do claim e lease com fuso'
);
select throws_ok(
  format($$update public.whatsapp_webhook_inbox set state = 'em_andamento' where id = %L::uuid$$, :'e2'),
  '23514', null, 'restrição: estado só pending, processing, processed ou failed'
);
select throws_ok(
  format($$update public.whatsapp_webhook_inbox set state = 'processing' where id = %L::uuid$$, :'e2'),
  '23514', null, 'restrição: processing exige token, horário do claim e lease'
);
select throws_ok(
  format($$update public.whatsapp_webhook_inbox set claim_token = gen_random_uuid(), claimed_at = now(), lease_until = now() + interval '1 minute' where id = %L::uuid$$, :'e2'),
  '23514', null, 'restrição: pending não conserva token nem lease'
);
select throws_ok(
  format($$update public.whatsapp_webhook_inbox set state = 'processing', claim_count = 1, claim_token = gen_random_uuid(), claimed_at = now(), lease_until = now() where id = %L::uuid$$, :'e2'),
  '23514', null, 'restrição: a lease termina depois do claim'
);
select throws_ok(
  format($$update public.whatsapp_webhook_inbox set state = 'processing', claim_token = gen_random_uuid(), claimed_at = now(), lease_until = now() + interval '1 minute' where id = %L::uuid$$, :'e2'),
  '23514', null, 'restrição: processing conta pelo menos um claim'
);
select throws_ok(
  format($$update public.whatsapp_webhook_inbox set last_release_code = 'banco_indisponivel' where id = %L::uuid$$, :'e2'),
  '23514', null, 'restrição: evidência da liberação vem com código e horário juntos'
);
select throws_ok(
  format($$update public.whatsapp_webhook_inbox set last_release_code = 'Erro bruto: +5511999990000', last_released_at = now() where id = %L::uuid$$, :'e2'),
  '23514', null, 'restrição: a evidência da liberação é só código simbólico'
);
select is(
  (select count(*)::int from unnest(array['anon', 'authenticated', 'service_role']) r
   where has_table_privilege(r, 'public.whatsapp_webhook_inbox', 'select')
      or has_table_privilege(r, 'public.whatsapp_webhook_inbox', 'insert')
      or has_table_privilege(r, 'public.whatsapp_webhook_inbox', 'update')
      or has_table_privilege(r, 'public.whatsapp_webhook_inbox', 'delete')),
  0, 'nem anon, nem authenticated, nem service_role acessam a tabela diretamente: só pelas funções'
);

-- ---------------------------------------------------------------------
-- 2) Funções: só as do claim e as seguras da B3.2b; caminho antigo removido
-- ---------------------------------------------------------------------

select is(
  (select count(*)::int from unnest(array[
     'public.whatsapp_inbox_claim(uuid, integer)',
     'public.whatsapp_inbox_complete(uuid, uuid)',
     'public.whatsapp_inbox_fail(uuid, uuid, text)',
     'public.whatsapp_inbox_release(uuid, uuid, text)']) f
   join pg_proc p on p.oid = to_regprocedure(f)
   where has_function_privilege('service_role', p.oid, 'execute')
     and p.prosecdef
     and exists (select 1 from unnest(coalesce(p.proconfig, array[]::text[])) cfg where cfg like 'search_path=%')),
  4, 'claim, complete, fail e release: service_role, SECURITY DEFINER, search_path travado'
);
select is(
  (select string_agg(p.proname || '(' || array_to_string(p.proargnames, ',') || ')', ' ' order by p.proname collate "C")
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname in ('whatsapp_inbox_claim', 'whatsapp_inbox_complete', 'whatsapp_inbox_fail', 'whatsapp_inbox_release')),
  'whatsapp_inbox_claim(p_inbox_id,p_lease_seconds) whatsapp_inbox_complete(p_inbox_id,p_claim_token) whatsapp_inbox_fail(p_inbox_id,p_claim_token,p_error_code) whatsapp_inbox_release(p_inbox_id,p_claim_token,p_error_code)',
  'o claim recebe só o id da inbox e a lease; as finalizações, só o id, o token e (fail, release) o código: nada de workspace, canal, ambiente, provedor ou routing key'
);
select is(
  (select string_agg(p.proname, ',' order by p.proname collate "C")
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname like 'whatsapp\_inbox\_%'),
  'whatsapp_inbox_claim,whatsapp_inbox_complete,whatsapp_inbox_fail,whatsapp_inbox_list,whatsapp_inbox_purge_expired,whatsapp_inbox_release,whatsapp_inbox_store',
  'funções da inbox: gravação, listagem segura, expurgo e as do claim; nenhuma outra'
);
select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where (n.nspname = 'public' and p.proname in ('whatsapp_inbox_get_pending', 'whatsapp_inbox_mark_processed', 'whatsapp_inbox_mark_failed'))
      or (n.nspname = 'private' and p.proname = 'whatsapp_inbox_lock_entry')),
  0, 'leitura de pendente e marcações sem claim aposentadas, com qualquer assinatura'
);
select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname like 'whatsapp\_inbox\_%'
     and (has_function_privilege('anon', p.oid, 'execute')
          or has_function_privilege('authenticated', p.oid, 'execute')
          or has_function_privilege('public', p.oid, 'execute'))),
  0, 'nenhuma função da inbox é executável por PUBLIC, anon ou authenticated'
);

-- ---------------------------------------------------------------------
-- 3) Primeiro claim: contexto resolvido no banco, só pelo id da inbox
-- ---------------------------------------------------------------------

set local role service_role;
select set_config('request.headers', '', true);
select alike(pg_temp.co(pg_temp.claim(:'e1')), 'ERRO:whatsapp_environment_required%', 'sem ambiente assinado: recusa');

select set_config('request.headers', :'h_prev', true);
select pg_temp.claim(:'e1') as c1 \gset
select is(pg_temp.co(:'c1'::jsonb), 'claimed', 'entrada pendente: claimed');
select is(
  (select string_agg(k, ',' order by k collate "C") from jsonb_object_keys(:'c1'::jsonb) k),
  'auth_tag,body_sha256,channel_id,channel_status,ciphertext,claim_count,claim_token,claimed_at,environment,inbox_id,key_version,lease_until,nonce,outcome,provider,provider_event_id,provider_event_type,received_at,retain_until,routing_key,workspace_id',
  'o claim devolve o contexto interno e a cifra; nunca corpo, segredo do webhook, chave de API ou credencial'
);
select is(
  (select c ->> 'inbox_id' || '|' || (c ->> 'environment') || '|' || (c ->> 'workspace_id') || '|' || (c ->> 'channel_id') || '|' || (c ->> 'channel_status')
     || '|' || (c ->> 'provider') || '|' || (c ->> 'routing_key') || '|' || (c ->> 'provider_event_id') || '|' || (c ->> 'provider_event_type')
   from (select :'c1'::jsonb as c) q),
  :'e1' || '|preview|' || :'ws_um' || '|' || :'ch_a' || '|active|simulated|b3c-a|evt-1|message.inbound',
  'ambiente, workspace, canal, estado do canal, provedor, routing key, id e tipo bruto saem do banco'
);
select is(
  (select (c ->> 'body_sha256') || '|' || (c ->> 'key_version') || '|' || (c ->> 'nonce') || '|' || (c ->> 'ciphertext') || '|' || (c ->> 'auth_tag')
   from (select :'c1'::jsonb as c) q),
  :'h1' || '|1|' || :'nonce' || '|' || :'corpo1' || '|' || :'tag', 'hash e campos cifrados da entrada, para decifrar no servidor'
);
select is(
  (select ((c ->> 'claim_count')::int = 1 and (c ->> 'claim_token')::uuid is not null)::text from (select :'c1'::jsonb as c) q),
  'true', 'primeiro claim: token novo e claim_count 1'
);
select is(
  (select (((c ->> 'lease_until')::timestamptz - (c ->> 'claimed_at')::timestamptz) = interval '60 seconds')::text from (select :'c1'::jsonb as c) q),
  'true', 'a lease dura exatamente os segundos pedidos'
);
select is(position(:'cifra' in :'c1') + position('webhook_secret' in :'c1') + position('api_key' in :'c1'), 0, 'nenhum texto cifrado de credencial do canal no retorno');
select coalesce(:'c1'::jsonb ->> 'claim_token', '00000000-0000-0000-0000-000000000000') as t1 \gset

select pg_temp.claim(:'e1') as c1b \gset
select is(pg_temp.co(:'c1b'::jsonb), 'busy', 'lease vigente: busy');
select is((select string_agg(k, ',') from jsonb_object_keys(:'c1b'::jsonb) k), 'outcome', 'busy não devolve token, contexto nem cifra');
reset role;
select is(
  pg_temp.st(:'e1') || '|' || pg_temp.tok(:'e1'),
  'processing|1|true|true|true|' || :'t1', 'busy não troca o token nem conta outro claim'
);
set local role service_role;

select is(
  pg_temp.co(pg_temp.claim(:'e2', 0)) || ' ' || pg_temp.co(pg_temp.claim(:'e2', null)) || ' ' || pg_temp.co(pg_temp.claim(:'e2', 14)) || ' ' || pg_temp.co(pg_temp.claim(:'e2', 901)),
  'ERRO:invalid_lease ERRO:invalid_lease ERRO:invalid_lease ERRO:invalid_lease', 'lease fora de 15 a 900 segundos: recusa'
);
reset role;
select is(pg_temp.st(:'e2'), 'pending|0|false|false|false', 'lease inválida não reclama nada');
set local role service_role;
select pg_temp.claim(:'e2', 15) as c2 \gset
select pg_temp.claim(:'e3', 900) as c3 \gset
select is(pg_temp.co(:'c2'::jsonb) || ' ' || pg_temp.co(:'c3'::jsonb), 'claimed claimed', 'lease de 15 e de 900 segundos: aceitas');
select coalesce(:'c2'::jsonb ->> 'claim_token', '00000000-0000-0000-0000-000000000000') as t2 \gset
select coalesce(:'c3'::jsonb ->> 'claim_token', '00000000-0000-0000-0000-000000000000') as t3 \gset

-- ---------------------------------------------------------------------
-- 4) Lease vencida: novo claim, token novo, o antigo não vale mais
-- ---------------------------------------------------------------------

reset role;
select pg_temp.exec(format($$update public.whatsapp_webhook_inbox set claimed_at = now() - interval '2 minutes', lease_until = now() - interval '1 minute' where id = %L::uuid$$, :'e1'));
set local role service_role;
select pg_temp.claim(:'e1') as c1c \gset
select is(pg_temp.co(:'c1c'::jsonb), 'claimed', 'lease vencida: pode ser reclamada');
select coalesce(:'c1c'::jsonb ->> 'claim_token', '00000000-0000-0000-0000-000000000000') as t1b \gset
select is(
  (select ((c ->> 'claim_count')::int = 2 and c ->> 'claim_token' <> :'t1')::text from (select :'c1c'::jsonb as c) q),
  'true', 'novo claim: token novo e claim_count 2'
);
select is(pg_temp.fin('complete', :'e1', :'t1'), 'claim_lost', 'o token antigo não completa');
select is(pg_temp.fin('fail', :'e1', :'t1', 'qualquer_codigo') || ' ' || pg_temp.fin('release', :'e1', :'t1', 'qualquer_codigo'), 'claim_lost claim_lost', 'o token antigo não falha nem libera');
select is(
  pg_temp.fin('complete', :'e1', :'inventado') || ' ' || pg_temp.fin('complete', :'e1', null) || ' ' || pg_temp.fin('complete', :'e1', :'t3') || ' ' || pg_temp.fin('complete', :'e3', :'t1b'),
  'claim_lost claim_lost claim_lost claim_lost', 'token inventado, ausente ou de outra entrada: nada muda'
);
select is(pg_temp.fin('fail', :'e1', null, 'qualquer_codigo') || ' ' || pg_temp.fin('release', :'e1', null, 'qualquer_codigo'), 'claim_lost claim_lost', 'fail e release sem token: nada muda');
reset role;
select is(
  pg_temp.st(:'e1') || '|' || pg_temp.tok(:'e1') || ' ' || pg_temp.st(:'e3') || '|' || pg_temp.tok(:'e3'),
  'processing|2|true|true|true|' || :'t1b' || ' processing|1|true|true|true|' || :'t3', 'tokens errados não alteraram nenhuma das duas entradas'
);
set local role service_role;

-- ---------------------------------------------------------------------
-- 5) complete
-- ---------------------------------------------------------------------

select is(pg_temp.fin('complete', :'e1', :'t1b'), 'completed', 'complete com o token atual: completed');
reset role;
select is(
  pg_temp.st(:'e1') || '|' || (select (processed_at is not null)::text || '|' || coalesce(error_code, '-') from public.whatsapp_webhook_inbox where id = :'e1'::uuid),
  'processed|2|false|false|false|true|-', 'processed: horário registrado, token e lease limpos, claim_count preservado'
);
set local role service_role;
select is(pg_temp.fin('complete', :'e1', :'t1b'), 'already_processed', 'complete repetido: already_processed');
select is(pg_temp.co(pg_temp.claim(:'e1')), 'already_processed', 'claim de entrada processada: already_processed');
select is(pg_temp.fin('fail', :'e1', :'t1b', 'qualquer_codigo') || ' ' || pg_temp.fin('release', :'e1', :'t1b', 'qualquer_codigo'), 'already_processed already_processed', 'processada não vira falha nem volta a pendente');
select is(pg_temp.fin_keys('complete', :'e1', :'t1b'), 'outcome', 'complete devolve só o resultado');

-- ---------------------------------------------------------------------
-- 6) fail: terminal, só código sanitizado
-- ---------------------------------------------------------------------

select is(
  pg_temp.fin('fail', :'e3', :'t3', 'Telefone +5511999990000 inválido') || ' ' || pg_temp.fin('fail', :'e3', :'t3', 'Error: connection refused at 10.0.0.1')
    || ' ' || pg_temp.fin('fail', :'e3', :'t3', '') || ' ' || pg_temp.fin('fail', :'e3', :'t3', repeat('x', 65)) || ' ' || pg_temp.fin('fail', :'e3', :'t3', null),
  'ERRO:invalid_error_code ERRO:invalid_error_code ERRO:invalid_error_code ERRO:invalid_error_code ERRO:invalid_error_code',
  'fail com mensagem bruta, vazia, longa ou ausente: recusa sem repetir o texto'
);
reset role;
select is(pg_temp.st(:'e3'), 'processing|1|true|true|true', 'a recusa do código não mexeu na entrada');
set local role service_role;
select is(pg_temp.fin('fail', :'e3', :'t3', 'normalizacao_invalida'), 'failed', 'fail com o token atual e código sanitizado: failed');
reset role;
select is(
  pg_temp.st(:'e3') || '|' || (select error_code || '|' || (failed_at is not null)::text from public.whatsapp_webhook_inbox where id = :'e3'::uuid),
  'failed|1|false|false|false|normalizacao_invalida|true', 'failed: código e horário registrados, token e lease limpos'
);
set local role service_role;
select is(
  pg_temp.co(pg_temp.claim(:'e3')) || ' ' || pg_temp.fin('fail', :'e3', :'t3', 'normalizacao_invalida') || ' ' || pg_temp.fin('complete', :'e3', :'t3') || ' ' || pg_temp.fin('release', :'e3', :'t3', 'banco_indisponivel'),
  'terminal_failed terminal_failed terminal_failed terminal_failed', 'falha é terminal: não é reclamada, completada nem liberada'
);
select is(pg_temp.fin_keys('fail', :'e3', :'t3', 'normalizacao_invalida'), 'outcome', 'fail devolve só o resultado');
reset role;
select is(
  (select count(*)::int from public.audit_logs
   where action = 'whatsapp.inbox.failed' and resource_id = :'e3'::uuid and metadata ->> 'code' = 'normalizacao_invalida'
     and (select string_agg(k, ',' order by k collate "C") from jsonb_object_keys(metadata) k) = 'channel_id,code,environment,provider'),
  1, 'a falha terminal é auditada uma vez, só com ambiente, provedor, canal e código'
);
select is(
  (select count(*)::int from public.audit_logs a
   where a.action like 'whatsapp.inbox.%'
     and (a.metadata::text ~ '\+?55119' or position('Telefone' in a.metadata::text) > 0 or position('Error:' in a.metadata::text) > 0
          or position('b3c-a' in a.metadata::text) > 0 or position(:'corpo1' in a.metadata::text) > 0)),
  0, 'auditoria sem telefone, routing key, erro bruto ou conteúdo'
);
set local role service_role;

-- ---------------------------------------------------------------------
-- 7) release: falha transitória, nova tentativa, claim_count preservado
-- ---------------------------------------------------------------------

select is(pg_temp.fin('release', :'e2', :'t2', 'Timeout ao gravar +5511999990000'), 'ERRO:invalid_error_code', 'release com mensagem bruta: recusa');
select is(pg_temp.fin('release', :'e2', :'t2', 'banco_indisponivel'), 'released', 'release com o token atual: released');
reset role;
select is(
  pg_temp.st(:'e2') || '|' || pg_temp.txt(format($$select last_release_code || '|' || (last_released_at is not null)::text from public.whatsapp_webhook_inbox where id = %L::uuid$$, :'e2')),
  'pending|1|false|false|false|banco_indisponivel|true', 'pending de novo: token e lease limpos, claim_count preservado, evidência sanitizada'
);
set local role service_role;
select pg_temp.claim(:'e2') as c2b \gset
select is(pg_temp.co(:'c2b'::jsonb) || '|' || (:'c2b'::jsonb ->> 'claim_count'), 'claimed|2', 'novo claim depois do release: claim_count 2');
select coalesce(:'c2b'::jsonb ->> 'claim_token', '00000000-0000-0000-0000-000000000000') as t2b \gset
select is(pg_temp.fin('complete', :'e2', :'t2'), 'claim_lost', 'o token liberado não completa o novo claim');
select is(pg_temp.fin_keys('release', :'e2', :'t2', 'banco_indisponivel'), 'outcome', 'release devolve só o resultado');
reset role;
select throws_ok(
  format($$update public.whatsapp_webhook_inbox set claim_count = 1 where id = %L::uuid$$, :'e2'),
  'P0001', 'inbox_claim_count_decreased', 'claim_count nunca diminui'
);
select throws_ok(
  format($$update public.whatsapp_webhook_inbox set state = 'pending', processed_at = null where id = %L::uuid$$, :'e1'),
  'P0001', 'inbox_terminal_state', 'processada não volta a pendente nem por escrita direta'
);
set local role service_role;

-- ---------------------------------------------------------------------
-- 8) Retenção prevalece: vencida ou expurgada não é reclamada
-- ---------------------------------------------------------------------

reset role;
update public.whatsapp_webhook_inbox set received_at = now() - interval '2 days', retain_until = now() - interval '1 day' where id = :'e_old'::uuid;
set local role service_role;
select is(pg_temp.co(pg_temp.claim(:'e_old')), 'expired', 'pendente vencida (ainda não expurgada): expired');
reset role;
select is(pg_temp.st(:'e_old'), 'pending|0|false|false|false', 'a vencida não foi reclamada');
set local role service_role;

select pg_temp.claim(:'e_pp') as cpp \gset
select coalesce(:'cpp'::jsonb ->> 'claim_token', '00000000-0000-0000-0000-000000000000') as tpp \gset
select pg_temp.claim(:'e_rp') as crp \gset
reset role;
update public.whatsapp_webhook_inbox set received_at = now() - interval '2 days', retain_until = now() - interval '1 day' where id = :'e_pp'::uuid;
select pg_temp.exec(format($$update public.whatsapp_webhook_inbox set received_at = now() - interval '2 days', retain_until = now() - interval '1 day',
  claimed_at = now() - interval '2 minutes', lease_until = now() - interval '1 minute' where id = %L::uuid$$, :'e_rp'));
set local role service_role;
select is(pg_temp.co(pg_temp.claim(:'e_rp')), 'expired', 'em processamento com lease e retenção vencidas: não é reclamada de novo');
select is(pg_temp.j($$select public.whatsapp_inbox_purge_expired(100)$$) ->> 'purged', '3', 'o expurgo leva as vencidas, inclusive as que estavam em processamento');
reset role;
select is(
  pg_temp.st(:'e_pp') || '|' || pg_temp.txt(format($$select (purged_at is not null and ciphertext is null)::text from public.whatsapp_webhook_inbox where id = %L::uuid$$, :'e_pp')),
  'pending|1|false|false|false|true', 'expurgada durante o processamento: tombstone sem token nem lease'
);
set local role service_role;
select is(pg_temp.fin('complete', :'e_pp', :'tpp'), 'claim_lost', 'o token de uma entrada expurgada não completa');
select is(pg_temp.co(pg_temp.claim(:'e_pp')) || ' ' || pg_temp.co(pg_temp.claim(:'e_old')), 'expired expired', 'expurgada: expired');

-- ---------------------------------------------------------------------
-- 9) Preview × Production; entrada inexistente
-- ---------------------------------------------------------------------

select set_config('request.headers', :'h_prod', true);
select is(pg_temp.co(pg_temp.claim(:'e4')), 'not_found', 'entrada de Preview com ambiente Production: not_found');
select is(
  pg_temp.fin('complete', :'e2', :'t2b') || ' ' || pg_temp.fin('fail', :'e2', :'t2b', 'qualquer_codigo') || ' ' || pg_temp.fin('release', :'e2', :'t2b', 'qualquer_codigo'),
  'not_found not_found not_found', 'o token certo com ambiente Production não finaliza a entrada de Preview'
);
select pg_temp.claim(:'e_prod') as cprod \gset
select is(
  pg_temp.co(:'cprod'::jsonb) || '|' || (:'cprod'::jsonb ->> 'environment') || '|' || (:'cprod'::jsonb ->> 'channel_id'),
  'claimed|production|' || :'ch_prod', 'Production reclama a própria entrada'
);
select set_config('request.headers', :'h_prev', true);
select is(pg_temp.co(pg_temp.claim(:'e_prod')), 'not_found', 'entrada de Production com ambiente Preview: not_found');
reset role;
select is(pg_temp.st(:'e2') || '|' || pg_temp.tok(:'e2'), 'processing|2|true|true|true|' || :'t2b', 'a entrada de Preview continua com o claim dela');
set local role service_role;
select is(pg_temp.co(pg_temp.claim(:'inventado')) || ' ' || pg_temp.co(pg_temp.claim(null)), 'not_found not_found', 'entrada inexistente ou id nulo: not_found');
select is(pg_temp.fin('complete', :'inventado', :'t2b'), 'not_found', 'finalizar entrada inexistente: not_found');

-- ---------------------------------------------------------------------
-- 10) Canal que mudou de estado depois do recebimento não aprisiona a
--     entrada (a decisão de aplicar ao domínio é da B3.2d-2)
-- ---------------------------------------------------------------------

select pg_temp.claim(:'e_p') as cp \gset
select pg_temp.claim(:'e_d') as cd \gset
select pg_temp.claim(:'e_x') as cx \gset
select is(pg_temp.co(:'cp'::jsonb) || '|' || (:'cp'::jsonb ->> 'channel_status') || '|' || (:'cp'::jsonb ->> 'routing_key'), 'claimed|paused|b3c-p', 'canal pausado depois: claim com o estado atual do canal');
select is(pg_temp.co(:'cd'::jsonb) || '|' || (:'cd'::jsonb ->> 'channel_status'), 'claimed|disconnected', 'canal desconectado depois: claim com o estado atual do canal');
select is(pg_temp.co(:'cx'::jsonb) || '|' || (:'cx'::jsonb ->> 'channel_status'), 'claimed|disabled', 'canal desativado depois: claim com o estado atual do canal');
select is(pg_temp.fin('complete', :'e_x', coalesce(:'cx'::jsonb ->> 'claim_token', '00000000-0000-0000-0000-000000000000')::uuid), 'completed', 'canal desativado depois: a entrada antiga é finalizada');

-- ---------------------------------------------------------------------
-- 11) Listagem segura: sem token, sem cifra
-- ---------------------------------------------------------------------

select is(
  (select string_agg(k, ',' order by k collate "C") from jsonb_object_keys(
     (public.whatsapp_inbox_list(:'ch_a'::uuid, :'ws_um'::uuid, 'simulated', 'b3c-a', 50)) -> 0) k),
  'body_sha256,claim_count,claimed_at,conflict_count,error_code,failed_at,id,last_conflict_at,last_release_code,last_released_at,lease_until,processed_at,provider_event_id,provider_event_type,purged_at,received_at,retain_until,state',
  'a listagem mostra estado, contagem e lease; nunca o token, a versão de chave, o nonce, o texto cifrado ou a tag'
);
select is(
  (select position(:'t2b' in l::text) + position(:'corpo1' in l::text) from (select public.whatsapp_inbox_list(:'ch_a'::uuid, :'ws_um'::uuid, 'simulated', 'b3c-a', 50) as l) q),
  0, 'nenhum token vigente nem texto cifrado na listagem'
);
reset role;

-- ---------------------------------------------------------------------
-- 12) authenticated e anon não alcançam nada
-- ---------------------------------------------------------------------

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'ana', 'role', 'authenticated')::text, true);
select set_config('request.headers', :'h_prev', true);
select is(
  (pg_temp.co(pg_temp.claim(:'e4')) like 'ERRO:%')::text || ' ' || (pg_temp.fin('complete', :'e2', :'t2b') like 'ERRO:%')::text || ' '
    || (pg_temp.fin('fail', :'e2', :'t2b', 'qualquer_codigo') like 'ERRO:%')::text || ' ' || (pg_temp.fin('release', :'e2', :'t2b', 'qualquer_codigo') like 'ERRO:%')::text,
  'true true true true', 'authenticated não reclama, completa, falha nem libera'
);
reset role;
set local role anon;
select is((pg_temp.co(pg_temp.claim(:'e4')) like 'ERRO:%')::text, 'true', 'anon não reclama');
reset role;
select is(pg_temp.st(:'e4') || ' ' || pg_temp.st(:'e2'), 'pending|0|false|false|false processing|2|true|true|true', 'as tentativas sem service_role não mudaram nada');

select * from finish();
rollback;
