-- pgTAP — B3.2b: caixa de entrada CIFRADA do webhook de WhatsApp.
--
-- Prova: tabela sem texto puro, deny-all, funções só de service_role; a
-- gravação confere ambiente assinado e a identidade inteira do canal
-- (canal, workspace, provedor, routing key) contra a linha real; uma
-- entrega NOVA é aceita em canal ativo, pausado ou desconectado e recusada
-- em canal desativado, outro workspace, outro provedor e outro ambiente; o
-- ACESSO a uma entrada existente (leitura, listagem, marcação) não depende
-- do estado atual do canal; idempotência por (canal, id do evento) com
-- inserted / duplicate / conflict, sem sobrescrever no conflito; tipo
-- BRUTO do provedor como metadado; retenção obrigatória com teto de 30
-- dias; listagem sem texto cifrado; leitura de pendente só com a
-- identidade do canal; estados sem regressão; expurgo que deixa tombstone,
-- idempotente e auditado sem conteúdo; reentrega depois do expurgo não
-- vira evento novo.
--
-- Escrito ANTES da implementação, contra a main 3feedd1; revisado (tipo
-- bruto, estados do canal, teto de 30 dias) ANTES da correção, contra o
-- HEAD 712ee0d; e de novo (retenção em segundos, prazo calculado só pelo
-- banco a partir de um único horário) contra o HEAD 3a9ffff. Nenhuma chave real: os valores cifrados são textos base64
-- fictícios.
--
-- B3.2d-1 (contra a main 4e7c004): a leitura de pendente e as marcações
-- sem claim foram aposentadas, e a tabela perdeu o privilégio direto também
-- para service_role. Os testes delas saíram daqui; o claim, a lease e as
-- finalizações com token estão no pgTAP 33. As leituras diretas da tabela
-- feitas aqui para conferência rodam como postgres.

begin;
select plan(94);

\set ana      '20000000-0000-0000-0000-000000000001'
\set bruno    '20000000-0000-0000-0000-000000000002'
\set ws_um    '10000000-0000-0000-0000-000000000001'
\set ws_dois  '10000000-0000-0000-0000-000000000002'
\set ch_um    '33000000-0000-0000-0000-000000000001'
\set ch_dois  '33000000-0000-0000-0000-000000000002'
\set ch_pausa '33000000-0000-0000-0000-000000000003'
\set ch_off   '33000000-0000-0000-0000-000000000004'
\set ch_desc  '33000000-0000-0000-0000-000000000005'
\set ch_prod  '33000000-0000-0000-0000-000000000006'
\set ch_tp    '33000000-0000-0000-0000-000000000007'
\set ch_td    '33000000-0000-0000-0000-000000000008'
\set ch_toff  '33000000-0000-0000-0000-000000000009'
\set cifra    'QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFB'
\set nonce    'AAAAAAAAAAAAAAAA'
\set tag      'AAAAAAAAAAAAAAAAAAAAAA=='
\set corpo1   'Q29ycG8gZmljdGljaW8gMQ=='
\set corpo2   'Q29ycG8gZmljdGljaW8gMg=='

select repeat('a', 64) as h1 \gset
select repeat('b', 64) as h2 \gset

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

-- Resultado de uma chamada: o texto pedido, ou 'ERRO:<mensagem>' se ela
-- falhar (função inexistente, recusa). Mantém a transação utilizável e a
-- contagem estável, inclusive contra a main sem a B3.2b.
create function pg_temp.run(p_sql text) returns text language plpgsql as $f$
declare
  v text;
begin
  execute p_sql into v;
  return coalesce(v, 'NULL');
exception when others then
  return 'ERRO:' || sqlerrm;
end
$f$;

create function pg_temp.try_count(p_sql text) returns int language plpgsql as $f$
declare
  n int;
begin
  execute 'select count(*)::int from (' || p_sql || ') q' into n;
  return n;
exception when others then
  return -1;
end
$f$;

-- Chamada de gravação, com valores padrão fictícios. O tipo padrão é o
-- tipo BRUTO do simulador (`message.inbound`).
create function pg_temp.store(
  p_channel uuid, p_ws uuid, p_routing text, p_event text, p_hash text,
  p_provider text default 'simulated', p_body text default 'Q29ycG8gZmljdGljaW8gMQ==',
  p_retention text default '3600', p_type text default 'message.inbound',
  p_nonce text default 'AAAAAAAAAAAAAAAA', p_tag text default 'AAAAAAAAAAAAAAAAAAAAAA==', p_key text default '1'
) returns text language sql as $f$
  select pg_temp.run(format(
    'select (public.whatsapp_inbox_store(%L::uuid, %L::uuid, %L::public.whatsapp_provider, %L, %L, %L, %L, %L, %L, %L, %L, %s))::jsonb ->> ''outcome''',
    p_channel, p_ws, p_provider, p_routing, p_event, p_type, p_hash, p_key, p_nonce, p_body, p_tag, p_retention
  ))
$f$;

select pg_temp.hdr('preview') as h_prev \gset
select pg_temp.hdr('production') as h_prod \gset

-- ---------------------------------------------------------------------
-- Cenário (Preview): canal ativo em dois workspaces, um pausado, um
-- desativado, um desconectado; um canal em Production.
-- ---------------------------------------------------------------------

set local role service_role;
select set_config('request.jwt.claims', '', true);
select set_config('request.headers', :'h_prev', true);
select whatsapp_create_simulated_channel(:'ch_um'::uuid, :'ws_um'::uuid, :'ana'::uuid, 'Um', 'b3i-um', '1', :'cifra', '1') is not null as ok \gset
select whatsapp_create_simulated_channel(:'ch_dois'::uuid, :'ws_dois'::uuid, :'bruno'::uuid, 'Dois', 'b3i-dois', '1', :'cifra', '1') is not null as ok \gset
select whatsapp_create_simulated_channel(:'ch_pausa'::uuid, :'ws_um'::uuid, :'ana'::uuid, 'Pausa', 'b3i-pausa', '1', :'cifra', '1') is not null as ok \gset
select whatsapp_create_simulated_channel(:'ch_off'::uuid, :'ws_um'::uuid, :'ana'::uuid, 'Off', 'b3i-off', '1', :'cifra', '1') is not null as ok \gset
select whatsapp_create_simulated_channel(:'ch_desc'::uuid, :'ws_um'::uuid, :'ana'::uuid, 'Desc', 'b3i-desc', '1', :'cifra', '1') is not null as ok \gset
select whatsapp_create_simulated_channel(:'ch_tp'::uuid, :'ws_um'::uuid, :'ana'::uuid, 'Vai pausar', 'b3i-tp', '1', :'cifra', '1') is not null as ok \gset
select whatsapp_create_simulated_channel(:'ch_td'::uuid, :'ws_um'::uuid, :'ana'::uuid, 'Vai desconectar', 'b3i-td', '1', :'cifra', '1') is not null as ok \gset
select whatsapp_create_simulated_channel(:'ch_toff'::uuid, :'ws_um'::uuid, :'ana'::uuid, 'Vai desativar', 'b3i-toff', '1', :'cifra', '1') is not null as ok \gset
select whatsapp_pause_channel(:'ch_pausa'::uuid, :'ws_um'::uuid, :'ana'::uuid) is not null as ok \gset
select set_config('request.headers', :'h_prod', true);
select whatsapp_create_simulated_channel(:'ch_prod'::uuid, :'ws_um'::uuid, :'ana'::uuid, 'Prod', 'b3i-prod', '1', :'cifra', '1') is not null as ok \gset
reset role;
update public.whatsapp_channels set status = 'disabled' where id = :'ch_off'::uuid;
update public.whatsapp_channels set status = 'disconnected' where id = :'ch_desc'::uuid;

-- ---------------------------------------------------------------------
-- 1) Estrutura: sem texto puro, deny-all, unicidade, tombstone
-- ---------------------------------------------------------------------

select ok(to_regclass('public.whatsapp_webhook_inbox') is not null, 'a tabela whatsapp_webhook_inbox existe');

select is(
  (select coalesce(string_agg(column_name::text, ',' order by column_name::text collate "C"), '')
   from information_schema.columns
   where table_schema = 'public' and table_name = 'whatsapp_webhook_inbox'),
  'auth_tag,body_sha256,channel_id,ciphertext,claim_count,claim_token,claimed_at,conflict_count,environment,error_code,failed_at,id,key_version,last_conflict_at,last_conflict_sha256,last_release_code,last_released_at,lease_until,nonce,processed_at,provider,provider_event_id,provider_event_type,purged_at,received_at,retain_until,state,workspace_id',
  'colunas exatas: só metadado (com o tipo BRUTO do provedor, sem tipo normalizado), hash, texto cifrado e o claim da B3.2d-1 (nada de corpo, telefone, BSUID, nome, assinatura ou segredo)'
);

select ok(
  coalesce((select relrowsecurity and relforcerowsecurity from pg_class where oid = to_regclass('public.whatsapp_webhook_inbox')), false),
  'RLS ligada e forçada'
);

select is(
  (select count(*)::int from unnest(array['anon', 'authenticated']) r
   where to_regclass('public.whatsapp_webhook_inbox') is null
      or has_table_privilege(r, 'public.whatsapp_webhook_inbox', 'select')
      or has_table_privilege(r, 'public.whatsapp_webhook_inbox', 'insert')
      or has_table_privilege(r, 'public.whatsapp_webhook_inbox', 'update')
      or has_table_privilege(r, 'public.whatsapp_webhook_inbox', 'delete')),
  0, 'anon e authenticated não têm nenhum privilégio na tabela'
);

select is(
  (select count(*)::int from pg_index i
   join pg_class c on c.oid = i.indexrelid
   where i.indrelid = to_regclass('public.whatsapp_webhook_inbox') and i.indisunique
     and (select array_agg(a.attname::text order by k.ord)
          from unnest(i.indkey) with ordinality k(attnum, ord)
          join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum) = array['channel_id', 'provider_event_id']),
  1, 'unicidade por (canal, id do evento do provedor)'
);

select is(
  (select count(*)::int from pg_constraint
   where conrelid = to_regclass('public.whatsapp_webhook_inbox') and contype = 'f'
     and pg_get_constraintdef(oid) like '%(workspace_id, channel_id, environment, provider)%whatsapp_channels(workspace_id, id, environment, provider)%'),
  1, 'FK prende workspace, canal, ambiente e provedor à linha real do canal'
);

-- ---------------------------------------------------------------------
-- 2) Funções: só service_role, SECURITY DEFINER, search_path travado
-- ---------------------------------------------------------------------

select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname in ('whatsapp_inbox_store', 'whatsapp_inbox_list', 'whatsapp_inbox_purge_expired')
     and has_function_privilege('service_role', p.oid, 'execute')
     and p.prosecdef
     and exists (select 1 from unnest(coalesce(p.proconfig, array[]::text[])) cfg where cfg like 'search_path=%')),
  3, 'gravação, listagem e expurgo existem: service_role, SECURITY DEFINER, search_path travado'
);
select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname in ('whatsapp_inbox_get_pending', 'whatsapp_inbox_mark_processed', 'whatsapp_inbox_mark_failed')),
  0, 'leitura de pendente e marcações sem claim aposentadas na B3.2d-1 (o claim está no pgTAP 33)'
);

select is(
  (select string_agg(p.proargnames[p.pronargs] || ':' || format_type(p.proargtypes[p.pronargs - 1], null) || ':' || p.pronargs, ',')
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'whatsapp_inbox_store'),
  'p_retention_seconds:integer:12', 'a gravação tem uma assinatura só, que termina na retenção em segundos (inteiro)'
);
select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'whatsapp_inbox_store'
     and exists (select 1 from unnest(p.proargtypes::oid[]) a where a in ('timestamptz'::regtype, 'timestamp'::regtype, 'date'::regtype, 'interval'::regtype))),
  0, 'a gravação não recebe horário, data nem intervalo da aplicação'
);

select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname like 'whatsapp\_inbox\_%'
     and (has_function_privilege('anon', p.oid, 'execute')
          or has_function_privilege('authenticated', p.oid, 'execute')
          or has_function_privilege('public', p.oid, 'execute'))),
  0, 'nenhuma é executável por PUBLIC, anon ou authenticated'
);

-- ---------------------------------------------------------------------
-- 3) Gravação: ambiente, identidade do canal, estado do canal
-- ---------------------------------------------------------------------

set local role service_role;
select set_config('request.headers', '', true);
select alike(pg_temp.store(:'ch_um', :'ws_um', 'b3i-um', 'evt-1', :'h1'), 'ERRO:whatsapp_environment_required%', 'sem ambiente assinado: recusa');

select set_config('request.headers', :'h_prev', true);
select is(pg_temp.store(:'ch_um', :'ws_um', 'b3i-um', 'evt-1', :'h1'), 'inserted', 'primeira entrega: inserted');
select is(pg_temp.store(:'ch_um', :'ws_um', 'b3i-um', 'evt-1', :'h1'), 'duplicate', 'mesmo canal, mesmo id, mesmo hash: duplicate');
reset role;
select is(pg_temp.try_count($$select 1 from public.whatsapp_webhook_inbox where channel_id = '33000000-0000-0000-0000-000000000001' and provider_event_id = 'evt-1'$$), 1, 'a duplicata não cria segunda linha');
set local role service_role;

select alike(pg_temp.store(:'ch_um', :'ws_dois', 'b3i-um', 'evt-x', :'h1'), 'ERRO:channel_not_found%', 'canal com workspace de outro: não encontrado');
select alike(pg_temp.store(:'ch_dois', :'ws_um', 'b3i-dois', 'evt-x', :'h1'), 'ERRO:channel_not_found%', 'canal de outro workspace com o meu workspace: não encontrado');
select alike(pg_temp.store(:'ch_um', :'ws_um', 'b3i-um', 'evt-x', :'h1', 'ycloud'), 'ERRO:channel_not_found%', 'provedor divergente: não encontrado');
select alike(pg_temp.store(:'ch_um', :'ws_um', 'b3i-dois', 'evt-x', :'h1'), 'ERRO:channel_not_found%', 'routing key divergente: não encontrado');
select alike(pg_temp.store(:'ch_prod', :'ws_um', 'b3i-prod', 'evt-x', :'h1'), 'ERRO:channel_not_found%', 'canal de Production com ambiente Preview: não encontrado');

select set_config('request.headers', :'h_prod', true);
select alike(pg_temp.store(:'ch_um', :'ws_um', 'b3i-um', 'evt-x', :'h1'), 'ERRO:channel_not_found%', 'canal de Preview com ambiente Production: não encontrado');
select is(pg_temp.store(:'ch_prod', :'ws_um', 'b3i-prod', 'evt-1', :'h1'), 'inserted', 'Production grava no próprio canal (mesmo id de evento, outro canal)');

select set_config('request.headers', :'h_prev', true);
select is(pg_temp.store(:'ch_dois', :'ws_dois', 'b3i-dois', 'evt-1', :'h1'), 'inserted', 'o mesmo id de evento em outro canal é outra entrega');
select is(pg_temp.store(:'ch_pausa', :'ws_um', 'b3i-pausa', 'evt-p', :'h1'), 'inserted', 'canal pausado recebe e preserva o evento autêntico');
select alike(pg_temp.store(:'ch_off', :'ws_um', 'b3i-off', 'evt-o', :'h1'), 'ERRO:channel_not_found%', 'canal desativado: entrega nova recusada');
reset role;
select is(pg_temp.try_count(format($$select 1 from public.whatsapp_webhook_inbox where channel_id = %L::uuid$$, :'ch_off')), 0, 'canal desativado: nada gravado');
set local role service_role;
select is(pg_temp.store(:'ch_desc', :'ws_um', 'b3i-desc', 'evt-d', :'h1'), 'inserted', 'canal desconectado: entrega nova aceita e preservada (status atrasado, evento de conta, recuperação)');

-- ---------------------------------------------------------------------
-- 4) Conflito: mesmo id, bytes diferentes
-- ---------------------------------------------------------------------

select is(pg_temp.store(:'ch_um', :'ws_um', 'b3i-um', 'evt-1', :'h2', 'simulated', :'corpo2'), 'conflict', 'mesmo id com hash diferente: conflict');
reset role;
select is(
  (select body_sha256 || '|' || ciphertext from public.whatsapp_webhook_inbox where channel_id = :'ch_um'::uuid and provider_event_id = 'evt-1'),
  :'h1' || '|' || :'corpo1', 'o conflito não sobrescreve hash nem texto cifrado da primeira entrega'
);
select is(
  (select conflict_count || '|' || last_conflict_sha256 || '|' || (last_conflict_at is not null)::text
   from public.whatsapp_webhook_inbox where channel_id = :'ch_um'::uuid and provider_event_id = 'evt-1'),
  '1|' || :'h2' || '|true', 'evidência mínima: contagem, hash e horário do conflito'
);
set local role service_role;
select is(pg_temp.store(:'ch_um', :'ws_um', 'b3i-um', 'evt-1', :'h1'), 'duplicate', 'o original continua sendo reconhecido como duplicata depois do conflito');
reset role;
select is(
  (select count(*)::int from public.audit_logs where action = 'whatsapp.inbox.conflict' and resource_id = (
     select id from public.whatsapp_webhook_inbox where channel_id = :'ch_um'::uuid and provider_event_id = 'evt-1')),
  1, 'o conflito fica na auditoria'
);
select is(
  (select count(*)::int from public.audit_logs a, jsonb_object_keys(a.metadata) k
   where a.action like 'whatsapp.inbox.%' and k not in ('environment', 'provider', 'channel_id', 'code', 'purged')),
  0, 'auditoria da inbox só com metadado (ambiente, provedor, canal, código, contagem)'
);
set local role service_role;

-- ---------------------------------------------------------------------
-- 5) Validação: retenção obrigatória e formatos
-- ---------------------------------------------------------------------

select alike(pg_temp.store(:'ch_um', :'ws_um', 'b3i-um', 'evt-r1', :'h1', p_retention => 'null'), 'ERRO:invalid_retention%', 'sem retenção: falha fechada');
select alike(pg_temp.store(:'ch_um', :'ws_um', 'b3i-um', 'evt-r2', :'h1', p_retention => '0'), 'ERRO:invalid_retention%', 'retenção zero: recusa');
select alike(pg_temp.store(:'ch_um', :'ws_um', 'b3i-um', 'evt-r13', :'h1', p_retention => '-60'), 'ERRO:invalid_retention%', 'retenção negativa: recusa');
select alike(pg_temp.store(:'ch_um', :'ws_um', 'b3i-um', 'evt-r14', :'h1', p_retention => '59'), 'ERRO:invalid_retention%', 'retenção de 59 segundos: abaixo do mínimo, recusa');
select alike(pg_temp.store(:'ch_um', :'ws_um', 'b3i-um', 'evt-r3', :'h1', p_retention => '2592001'), 'ERRO:invalid_retention%', 'retenção de 30 dias mais 1 segundo (2.592.001 s): acima do teto, recusa');
select alike(pg_temp.store(:'ch_um', :'ws_um', 'b3i-um', 'evt-r11', :'h1', p_retention => '315360000'), 'ERRO:invalid_retention%', 'retenção de 3650 dias (teto antigo): recusa');
select alike(pg_temp.store(:'ch_um', :'ws_um', 'b3i-um', 'evt r4', :'h1'), 'ERRO:invalid_inbox_event%', 'id de evento malformado: recusa');
select alike(pg_temp.store(:'ch_um', :'ws_um', 'b3i-um', 'evt-r5', :'h1', p_type => 'Tipo Inválido'), 'ERRO:invalid_inbox_event%', 'tipo bruto malformado: recusa');
select alike(pg_temp.store(:'ch_um', :'ws_um', 'b3i-um', 'evt-r12', :'h1', p_type => null), 'ERRO:invalid_inbox_event%', 'sem tipo bruto: recusa');
select alike(pg_temp.store(:'ch_um', :'ws_um', 'b3i-um', 'evt-r6', 'XYZ'), 'ERRO:invalid_inbox_hash%', 'hash malformado: recusa');
select alike(pg_temp.store(:'ch_um', :'ws_um', 'b3i-um', 'evt-r7', :'h1', p_nonce => 'AAAA'), 'ERRO:invalid_inbox_ciphertext%', 'nonce de tamanho errado: recusa');
select alike(pg_temp.store(:'ch_um', :'ws_um', 'b3i-um', 'evt-r8', :'h1', p_tag => 'AAAA'), 'ERRO:invalid_inbox_ciphertext%', 'tag de tamanho errado: recusa');
select alike(pg_temp.store(:'ch_um', :'ws_um', 'b3i-um', 'evt-r9', :'h1', p_body => 'não é base64!'), 'ERRO:invalid_inbox_ciphertext%', 'texto cifrado fora de base64: recusa');
select alike(pg_temp.store(:'ch_um', :'ws_um', 'b3i-um', 'evt-r10', :'h1', p_key => 'versão inválida'), 'ERRO:invalid_inbox_ciphertext%', 'versão de chave malformada: recusa');
reset role;
select is(pg_temp.try_count($$select 1 from public.whatsapp_webhook_inbox where provider_event_id like 'evt-r%'$$), 0, 'nenhuma gravação recusada deixou linha');
set local role service_role;

select is(pg_temp.store(:'ch_dois', :'ws_dois', 'b3i-dois', 'evt-q30', :'h1', p_retention => '2592000'), 'inserted', 'retenção de exatamente 30 dias (2.592.000 s): aceita');
reset role;
select is(
  pg_temp.run($$select ((retain_until - received_at) = interval '2592000 seconds')::text || '|' || (received_at = now())::text
    from public.whatsapp_webhook_inbox where provider_event_id = 'evt-q30'$$),
  'true|true', '30 dias exatos: recebimento no horário de referência do banco e prazo = recebimento + 2.592.000 s, sem diferença de relógio'
);
set local role service_role;
select is(pg_temp.store(:'ch_dois', :'ws_dois', 'b3i-dois', 'evt-q7', :'h1', p_retention => '604800'), 'inserted', 'retenção de 7 dias (fictícia): aceita');
reset role;
select is(
  pg_temp.run($$select ((retain_until - received_at) = interval '604800 seconds')::text from public.whatsapp_webhook_inbox where provider_event_id = 'evt-q7'$$),
  'true', '7 dias: prazo = recebimento + 604.800 s'
);
set local role service_role;
select is(pg_temp.store(:'ch_dois', :'ws_dois', 'b3i-dois', 'evt-q7', :'h1', p_retention => '2592000'), 'duplicate', 'reentrega idêntica com outra retenção: duplicate');
select is(pg_temp.store(:'ch_dois', :'ws_dois', 'b3i-dois', 'evt-q7', :'h2', p_body => :'corpo2', p_retention => '60'), 'conflict', 'reentrega divergente com outra retenção: conflict');
reset role;
select is(
  pg_temp.run($$select ((retain_until - received_at) = interval '604800 seconds')::text || '|' || body_sha256
    from public.whatsapp_webhook_inbox where provider_event_id = 'evt-q7'$$),
  'true|' || :'h1', 'reentrega (duplicada ou divergente) preserva o primeiro payload e o primeiro prazo'
);
set local role service_role;
select is(pg_temp.store(:'ch_dois', :'ws_dois', 'b3i-dois', 'evt-q-tipo', :'h1', p_type => 'whatsapp.evento_futuro.criado'), 'inserted', 'tipo bruto bem formado e desconhecido do CRM: aceito (o vocabulário do provedor é aberto)');
reset role;
select is(
  pg_temp.run($$select provider_event_type from public.whatsapp_webhook_inbox where provider_event_id = 'evt-q-tipo'$$),
  'whatsapp.evento_futuro.criado', 'o tipo bruto fica gravado como veio, só como metadado'
);
set local role service_role;

-- ---------------------------------------------------------------------
-- 6) Listagem: nunca o texto cifrado
-- ---------------------------------------------------------------------

select is(
  pg_temp.run($$select (select string_agg(k, ',' order by k collate "C") from jsonb_object_keys((public.whatsapp_inbox_list('33000000-0000-0000-0000-000000000001'::uuid, '10000000-0000-0000-0000-000000000001'::uuid, 'simulated', 'b3i-um', 50))->0) k)$$),
  'body_sha256,claim_count,claimed_at,conflict_count,error_code,failed_at,id,last_conflict_at,last_release_code,last_released_at,lease_until,processed_at,provider_event_id,provider_event_type,purged_at,received_at,retain_until,state',
  'a listagem só traz metadado: sem nonce, texto cifrado, tag, versão de chave ou token do claim'
);
select is(
  pg_temp.run($$select jsonb_array_length(public.whatsapp_inbox_list('33000000-0000-0000-0000-000000000001'::uuid, '10000000-0000-0000-0000-000000000001'::uuid, 'simulated', 'b3i-um', 50))::text$$),
  '1', 'a listagem do canal traz só as entregas dele'
);
select alike(
  pg_temp.run($$select public.whatsapp_inbox_list('33000000-0000-0000-0000-000000000001'::uuid, '10000000-0000-0000-0000-000000000002'::uuid, 'simulated', 'b3i-um', 50)::text$$),
  'ERRO:channel_not_found%', 'listagem com workspace de outro: não encontrado'
);
select alike(
  pg_temp.run($$select public.whatsapp_inbox_list('33000000-0000-0000-0000-000000000001'::uuid, '10000000-0000-0000-0000-000000000001'::uuid, 'simulated', 'b3i-um', 0)::text$$),
  'ERRO:invalid_limit%', 'limite fora da faixa: recusa'
);

-- ---------------------------------------------------------------------
-- 7) Leitura de pendente e marcações sem claim: aposentadas na B3.2d-1
--    (o claim, a lease e as finalizações com token estão no pgTAP 33)
-- ---------------------------------------------------------------------

reset role;
select id as inbox_um from public.whatsapp_webhook_inbox where channel_id = :'ch_um'::uuid and provider_event_id = 'evt-1' \gset
select id as inbox_dois from public.whatsapp_webhook_inbox where channel_id = :'ch_dois'::uuid and provider_event_id = 'evt-1' \gset
set local role service_role;

-- ---------------------------------------------------------------------
-- 8) Expurgo com tombstone
-- ---------------------------------------------------------------------

select is(pg_temp.store(:'ch_um', :'ws_um', 'b3i-um', 'evt-velho', :'h1'), 'inserted', 'entrega que vai vencer');
reset role;
update public.whatsapp_webhook_inbox set received_at = now() - interval '2 days', retain_until = now() - interval '1 day'
where channel_id = :'ch_um'::uuid and provider_event_id = 'evt-velho';
select id as inbox_velho from public.whatsapp_webhook_inbox where channel_id = :'ch_um'::uuid and provider_event_id = 'evt-velho' \gset

set local role service_role;
select set_config('request.headers', :'h_prod', true);
select is(pg_temp.run($$select (public.whatsapp_inbox_purge_expired(100))::jsonb ->> 'purged'$$), '0', 'expurgo em Production não toca Preview');
select set_config('request.headers', '', true);
select alike(pg_temp.run($$select public.whatsapp_inbox_purge_expired(100)::text$$), 'ERRO:whatsapp_environment_required%', 'expurgo sem ambiente: recusa');
select set_config('request.headers', :'h_prev', true);
select is(pg_temp.run($$select (public.whatsapp_inbox_purge_expired(100))::jsonb ->> 'purged'$$), '1', 'expurgo apaga a entrega vencida');
reset role;
select is(
  (select (nonce is null and ciphertext is null and auth_tag is null and key_version is null)::text
     || '|' || body_sha256 || '|' || provider_event_id || '|' || (purged_at is not null)::text || '|' || (received_at is not null)::text
   from public.whatsapp_webhook_inbox where id = :'inbox_velho'::uuid),
  'true|' || :'h1' || '|evt-velho|true|true', 'tombstone: sem nonce, texto cifrado, tag e chave; mantém canal, id, hash e datas'
);
select purged_at::text as purged_1 from public.whatsapp_webhook_inbox where id = :'inbox_velho'::uuid \gset

set local role service_role;
select set_config('request.headers', :'h_prev', true);
select is(pg_temp.run($$select (public.whatsapp_inbox_purge_expired(100))::jsonb ->> 'purged'$$), '0', 'repetir o expurgo não faz nada');
reset role;
select is((select purged_at::text from public.whatsapp_webhook_inbox where id = :'inbox_velho'::uuid), :'purged_1', 'repetir o expurgo não muda a data do expurgo');
select is(
  (select count(*)::int from public.audit_logs where action = 'whatsapp.inbox.purged' and (metadata ->> 'purged')::int = 1 and metadata ->> 'environment' = 'preview'),
  1, 'o expurgo é auditado com a contagem, sem conteúdo'
);

set local role service_role;
select set_config('request.headers', :'h_prev', true);
select is(pg_temp.store(:'ch_um', :'ws_um', 'b3i-um', 'evt-velho', :'h1'), 'duplicate', 'reentrega idêntica depois do expurgo: duplicate, não evento novo');
select is(pg_temp.store(:'ch_um', :'ws_um', 'b3i-um', 'evt-velho', :'h2', 'simulated', :'corpo2'), 'conflict', 'reentrega diferente depois do expurgo: conflict');
reset role;
select is(
  (select (ciphertext is null)::text from public.whatsapp_webhook_inbox where id = :'inbox_velho'::uuid),
  'true', 'o tombstone nunca recebe conteúdo de volta'
);
select is(pg_temp.try_count(format($$select 1 from public.whatsapp_webhook_inbox where channel_id = %L::uuid and provider_event_id = 'evt-velho'$$, :'ch_um')), 1, 'continua uma linha só');


select throws_ok(
  format($$update public.whatsapp_webhook_inbox set ciphertext = 'QUJD' where id = %L::uuid$$, :'inbox_velho'),
  '23514', null, 'restrição: linha expurgada não guarda texto cifrado'
);
select throws_ok(
  format($$update public.whatsapp_webhook_inbox set retain_until = received_at + interval '2592001 seconds' where id = %L::uuid$$, :'inbox_dois'),
  '23514', null, 'restrição: prazo nunca acima de 30 dias depois do recebimento'
);
select throws_ok(
  format($$update public.whatsapp_webhook_inbox set nonce = null where id = %L::uuid$$, :'inbox_dois'),
  '23514', null, 'restrição: linha não expurgada exige nonce, texto cifrado, tag e chave'
);

-- ---------------------------------------------------------------------
-- 9) authenticated não alcança nada
-- ---------------------------------------------------------------------

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'ana', 'role', 'authenticated')::text, true);
select set_config('request.headers', :'h_prev', true);
select is(pg_temp.try_count('select * from public.whatsapp_webhook_inbox'), -1, 'authenticated não lê a tabela');
select alike(pg_temp.store(:'ch_um', :'ws_um', 'b3i-um', 'evt-auth', :'h1'), 'ERRO:%', 'authenticated não grava');
select alike(
  pg_temp.run(format($$select public.whatsapp_inbox_list(%L::uuid, %L::uuid, 'simulated', 'b3i-um', 10)::text$$, :'ch_um', :'ws_um')),
  'ERRO:%', 'authenticated não lista'
);
select alike(pg_temp.run($$select public.whatsapp_inbox_purge_expired(10)::text$$), 'ERRO:%', 'authenticated não expurga');
reset role;

set local role anon;
select is(pg_temp.try_count('select * from public.whatsapp_webhook_inbox'), -1, 'anon não lê a tabela');
reset role;

-- ---------------------------------------------------------------------
-- 10) Nenhuma resposta traz conteúdo
-- ---------------------------------------------------------------------

set local role service_role;
select set_config('request.headers', :'h_prev', true);
select is(
  pg_temp.run(format($$select string_agg(k, ',' order by k) from jsonb_object_keys(public.whatsapp_inbox_store(%L::uuid, %L::uuid, 'simulated', 'b3i-um', 'evt-resp', 'message.inbound', %L, '1', %L, %L, %L, 3600)) k$$,
    :'ch_um', :'ws_um', :'h1', :'nonce', :'corpo1', :'tag')),
  'inbox_id,outcome', 'a gravação devolve só o resultado e o id'
);
select is(
  pg_temp.run($$select string_agg(k, ',' order by k) from jsonb_object_keys(public.whatsapp_inbox_purge_expired(10)) k$$),
  'purged', 'o expurgo devolve só a contagem'
);
reset role;

-- ---------------------------------------------------------------------
-- 11) Entrada existente: o acesso não depende do estado atual do canal
-- ---------------------------------------------------------------------

set local role service_role;
select set_config('request.headers', :'h_prev', true);
select is(pg_temp.store(:'ch_tp', :'ws_um', 'b3i-tp', 'evt-t', :'h1'), 'inserted', 'gravada com o canal ativo (que depois pausa)');
select is(pg_temp.store(:'ch_td', :'ws_um', 'b3i-td', 'evt-t', :'h1'), 'inserted', 'gravada com o canal ativo (que depois desconecta)');
select is(pg_temp.store(:'ch_toff', :'ws_um', 'b3i-toff', 'evt-t', :'h1'), 'inserted', 'gravada com o canal ativo (que depois é desativado)');
select is(pg_temp.store(:'ch_toff', :'ws_um', 'b3i-toff', 'evt-t2', :'h1'), 'inserted', 'segunda entrada do canal que vai ser desativado');
reset role;
select id as e_tp from public.whatsapp_webhook_inbox where channel_id = :'ch_tp'::uuid and provider_event_id = 'evt-t' \gset
select id as e_td from public.whatsapp_webhook_inbox where channel_id = :'ch_td'::uuid and provider_event_id = 'evt-t' \gset
select id as e_toff from public.whatsapp_webhook_inbox where channel_id = :'ch_toff'::uuid and provider_event_id = 'evt-t' \gset
select id as e_toff2 from public.whatsapp_webhook_inbox where channel_id = :'ch_toff'::uuid and provider_event_id = 'evt-t2' \gset
update public.whatsapp_channels set status = 'paused', send_enabled = false where id = :'ch_tp'::uuid;
update public.whatsapp_channels set status = 'disconnected', send_enabled = false where id = :'ch_td'::uuid;
update public.whatsapp_channels set status = 'disabled', send_enabled = false where id = :'ch_toff'::uuid;

set local role service_role;
select set_config('request.headers', :'h_prev', true);

-- A entrada existente continua no histórico do canal; o claim dela com o
-- canal pausado, desconectado ou desativado está no pgTAP 33.
select is(pg_temp.store(:'ch_td', :'ws_um', 'b3i-td', 'evt-t-nova', :'h1'), 'inserted', 'canal desconectado depois: entrega nova continua preservada');

-- Desativado depois do recebimento: histórico acessível, recebimento fechado
select is(
  pg_temp.run($$select jsonb_array_length(public.whatsapp_inbox_list('33000000-0000-0000-0000-000000000009'::uuid, '10000000-0000-0000-0000-000000000001'::uuid, 'simulated', 'b3i-toff', 50))::text$$),
  '2', 'canal desativado depois: lista as entradas históricas'
);
select alike(pg_temp.store(:'ch_toff', :'ws_um', 'b3i-toff', 'evt-t3', :'h1'), 'ERRO:channel_not_found%', 'canal desativado depois: entrega nova recusada');
select alike(pg_temp.store(:'ch_toff', :'ws_um', 'b3i-toff', 'evt-t', :'h1'), 'ERRO:channel_not_found%', 'canal desativado depois: nem a reentrega idêntica é recebida');
reset role;
select is(pg_temp.try_count(format($$select 1 from public.whatsapp_webhook_inbox where channel_id = %L::uuid$$, :'ch_toff')), 2, 'canal desativado depois: nenhuma linha nova');
set local role service_role;

-- O acesso continua exigindo a identidade inteira e o ambiente
select alike(
  pg_temp.run($$select public.whatsapp_inbox_list('33000000-0000-0000-0000-000000000009'::uuid, '10000000-0000-0000-0000-000000000002'::uuid, 'simulated', 'b3i-toff', 50)::text$$),
  'ERRO:channel_not_found%', 'canal desativado: listagem com workspace de outro, não encontrado'
);
select set_config('request.headers', :'h_prod', true);
select alike(
  pg_temp.run($$select public.whatsapp_inbox_list('33000000-0000-0000-0000-000000000009'::uuid, '10000000-0000-0000-0000-000000000001'::uuid, 'simulated', 'b3i-toff', 50)::text$$),
  'ERRO:channel_not_found%', 'canal desativado de Preview com ambiente Production: não encontrado'
);
reset role;

select * from finish();
rollback;
