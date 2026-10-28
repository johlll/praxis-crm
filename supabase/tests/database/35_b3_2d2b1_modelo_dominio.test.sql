-- pgTAP — B3.2d-2b1: modelo do domínio do WhatsApp sobre a A7.
--
-- Prova, sem nenhuma RPC que aplique mensagem real:
--  - estrutura: enums de origem e classificação, `accepted` no status,
--    identidades (telefone, BSUID ou os dois; nunca nenhum), identidades
--    internas e o ledger de efeitos — tabelas sem acesso direto, nem por
--    service_role;
--  - compatibilidade com a A7: o simulador, o envio, o status e as
--    leituras continuam iguais; a conversa ganha a identidade sozinha;
--    mensagens antigas ficam inbound/unresolved e crm/internal, nunca
--    chatbot;
--  - mensagens: texto opcional, mídia sem texto, combinações de origem e
--    classificação, chatbot só com correlação, custo estimado × final;
--  - status: `accepted` e correções depois de `failed` na regra da B3, sem
--    mudar a da A7;
--  - identidades internas: só owner e admin, por workspace, ambiente e
--    canal; listagem sem índice cego nem cifra;
--  - ledger: chave (ambiente, canal, provedor, evento), sem conteúdo,
--    sem colisão entre canal, provedor e ambiente;
--  - backfill determinístico e idempotente.
--
-- Escrito ANTES da implementação, contra a main 6633084. Tudo fictício:
-- nenhum telefone, BSUID ou identidade real. Leituras e escritas das
-- colunas novas passam por funções que capturam o erro: contra a main, o
-- arquivo roda até o fim e mostra cada asserção que falha.

begin;
select plan(82);

\set ana    '20000000-0000-0000-0000-000000000001'
\set bruno  '20000000-0000-0000-0000-000000000002'
\set carla  '20000000-0000-0000-0000-000000000003'
\set daniel '20000000-0000-0000-0000-000000000004'
\set elisa  '20000000-0000-0000-0000-000000000005'
\set ws_um   '10000000-0000-0000-0000-000000000001'
\set ws_dois '10000000-0000-0000-0000-000000000002'
\set ch_a    '38000000-0000-0000-0000-000000000001'
\set ch_b    '38000000-0000-0000-0000-000000000002'
\set ch_prod '38000000-0000-0000-0000-000000000003'
\set ch_a2   '38000000-0000-0000-0000-000000000004'
\set inventado '7d1e2f3a-4b5c-4d6e-8f70-819a2b3c4d5e'
\set cifra   'QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFB'
\set bi1     'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE='
\set bi2     'AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI='
\set bi3     'AwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwM='
\set ct      'BAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBA=='
\set curto   'BQUFBQUFBQUFBQUFBQUFBQ=='

insert into public.whatsapp_environment_keys (environment, signing_key) values
  ('production', 'chave-whatsapp-producao-de-teste-0123456789'),
  ('preview', 'chave-whatsapp-preview-de-teste-0123456789ab');

-- Manager e admin no Escritório Um, só nesta transação.
insert into public.memberships (workspace_id, user_id, role, status) values
  (:'ws_um'::uuid, :'daniel'::uuid, 'manager', 'active'),
  (:'ws_um'::uuid, :'bruno'::uuid, 'admin', 'active')
on conflict (workspace_id, user_id) do update set role = excluded.role, status = 'active';

create function pg_temp.hdr(p_env text) returns text language sql as $f$
  select json_build_object(
    'x-praxis-whatsapp-env',
    'v1.' || p_env || '.' || e.x || '.' || private.whatsapp_environment_signature(
      p_env, e.x, (select signing_key from public.whatsapp_environment_keys where environment = p_env::public.whatsapp_environment)
    )
  )::text
  from (select extract(epoch from now())::bigint + 300 as x) e
$f$;

-- Texto de uma consulta, ou 'ERRO:<sqlstate>:<mensagem>'.
create function pg_temp.txt(p_sql text) returns text language plpgsql as $f$
declare
  v text;
begin
  execute p_sql into v;
  return coalesce(v, 'NULL');
exception when others then
  return 'ERRO:' || sqlstate || ':' || sqlerrm;
end
$f$;

-- Execução: 'ok' ou o SQLSTATE e a mensagem.
create function pg_temp.err(p_sql text) returns text language plpgsql as $f$
begin
  execute p_sql;
  return 'ok';
exception when others then
  return sqlstate || ':' || sqlerrm;
end
$f$;

-- SQLSTATE de uma escrita (sem a mensagem).
create function pg_temp.st(p_sql text) returns text language plpgsql as $f$
begin
  execute p_sql;
  return 'ok';
exception when others then
  return sqlstate;
end
$f$;

-- Resultado jsonb de uma chamada, ou {"erro": <mensagem>}.
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

select pg_temp.hdr('preview') as h_prev \gset
select pg_temp.hdr('production') as h_prod \gset

-- ---------------------------------------------------------------------
-- Cenário: canal legado da A7 (simulador, sem ambiente) e canais da B3
-- (Preview nos dois workspaces e Production no Escritório Um).
-- ---------------------------------------------------------------------

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'ana', 'role', 'authenticated')::text, true);
select (create_whatsapp_channel(:'ws_um'::uuid, 'Legado A7', 'b3d2b1-legado', '+55 11 0000-0101')).id as ch_legado \gset
reset role;

set local role service_role;
select set_config('request.jwt.claims', '', true);
select set_config('request.headers', :'h_prev', true);
select whatsapp_create_simulated_channel(:'ch_a'::uuid, :'ws_um'::uuid, :'ana'::uuid, 'A', 'b3d2b1-a', '1', :'cifra', '1') is not null as ok \gset
select whatsapp_create_simulated_channel(:'ch_a2'::uuid, :'ws_um'::uuid, :'ana'::uuid, 'A2', 'b3d2b1-a2', '1', :'cifra', '1') is not null as ok \gset
select whatsapp_create_simulated_channel(:'ch_b'::uuid, :'ws_dois'::uuid, :'bruno'::uuid, 'B', 'b3d2b1-b', '1', :'cifra', '1') is not null as ok \gset
select set_config('request.headers', :'h_prod', true);
select whatsapp_create_simulated_channel(:'ch_prod'::uuid, :'ws_um'::uuid, :'ana'::uuid, 'Prod', 'b3d2b1-prod', '1', :'cifra', '1') is not null as ok \gset
select set_config('request.headers', :'h_prev', true);
reset role;

-- ---------------------------------------------------------------------
-- 1) Estrutura
-- ---------------------------------------------------------------------

select is(
  pg_temp.txt($$select string_agg(e.enumlabel, ',' order by e.enumsortorder) from pg_enum e join pg_type t on t.oid = e.enumtypid where t.typname = 'whatsapp_message_origin'$$),
  'inbound,crm,business_app,chatbot,external_api,history', 'origem: exatamente as seis; internal nunca é origem'
);
select is(
  pg_temp.txt($$select string_agg(e.enumlabel, ',' order by e.enumsortorder) from pg_enum e join pg_type t on t.oid = e.enumtypid where t.typname = 'whatsapp_sender_classification'$$),
  'external,internal,automation,unresolved', 'classificação do remetente: exatamente as quatro'
);
select is(
  pg_temp.txt($$select string_agg(e.enumlabel, ',' order by e.enumsortorder) from pg_enum e join pg_type t on t.oid = e.enumtypid where t.typname = 'message_status'$$),
  'queued,accepted,sent,delivered,read,failed', 'status: accepted entra antes de sent; os antigos continuam'
);
select is(
  pg_temp.txt($$select string_agg(column_name::text, ',' order by column_name::text collate "C") from information_schema.columns where table_schema = 'public' and table_name = 'whatsapp_identities'$$),
  'bsuid_blind_index,bsuid_ciphertext,bsuid_key_version,channel_id,created_at,environment,id,phone_e164,provider,updated_at,workspace_id',
  'identidades: telefone e BSUID (só índice cego e cifra), por canal, ambiente e provedor'
);
select is(
  pg_temp.txt($$select string_agg(column_name::text, ',' order by column_name::text collate "C") from information_schema.columns where table_schema = 'public' and table_name = 'whatsapp_internal_identities'$$),
  'bsuid_blind_index,bsuid_ciphertext,bsuid_key_version,channel_id,created_at,created_by,environment,id,is_active,label,phone_e164,provider,updated_at,workspace_id',
  'identidades internas: workspace, ambiente, canal, telefone e/ou BSUID, ativa, datas'
);
select is(
  pg_temp.txt($$select string_agg(column_name::text, ',' order by column_name::text collate "C") from information_schema.columns where table_schema = 'public' and table_name = 'whatsapp_effect_ledger'$$),
  'channel_id,effect,environment,id,inbox_id,message_id,provider,provider_event_id,recorded_at,workspace_id',
  'ledger: só a chave, o efeito e referências — nenhuma coluna de corpo, telefone, BSUID, mídia ou payload'
);
select is(
  pg_temp.txt($$select pg_get_indexdef(i.indexrelid) from pg_index i join pg_class c on c.oid = i.indrelid where c.relname = 'whatsapp_effect_ledger' and i.indisunique and not i.indisprimary$$),
  'CREATE UNIQUE INDEX whatsapp_effect_ledger_event_key ON public.whatsapp_effect_ledger USING btree (environment, channel_id, provider, provider_event_id)',
  'ledger: único por ambiente, canal, provedor e id estável do evento'
);
select is(
  pg_temp.txt($$select string_agg(column_name::text || ':' || is_nullable, ',' order by column_name::text collate "C") from information_schema.columns
    where table_schema = 'public' and table_name = 'messages'
      and column_name in ('body_text', 'content_kind', 'origin', 'sender_classification', 'wa_message_id', 'provider_message_id', 'provider_cost_billable_amount')$$),
  'body_text:YES,content_kind:NO,origin:NO,provider_cost_billable_amount:YES,provider_message_id:YES,sender_classification:NO,wa_message_id:YES',
  'mensagens: texto opcional; tipo de conteúdo, origem e classificação obrigatórios; ids do provedor e total cobrado'
);
select is(
  pg_temp.txt($$select string_agg(column_name::text || ':' || is_nullable, ',' order by column_name::text collate "C") from information_schema.columns
    where table_schema = 'public' and table_name = 'conversations' and column_name in ('wa_id', 'identity_id')$$),
  'identity_id:NO,wa_id:YES', 'conversas: identidade obrigatória; telefone opcional (BSUID sem telefone)'
);
select is(
  pg_temp.txt($$select (count(*) filter (where to_regclass(t) is not null))::text || '|' ||
      (select count(*) from unnest(array['public.whatsapp_identities', 'public.whatsapp_internal_identities', 'public.whatsapp_effect_ledger']) t2
       cross join unnest(array['anon', 'authenticated', 'service_role']) r
       where has_table_privilege(r, t2, 'select') or has_table_privilege(r, t2, 'insert')
          or has_table_privilege(r, t2, 'update') or has_table_privilege(r, t2, 'delete'))::text
    from unnest(array['public.whatsapp_identities', 'public.whatsapp_internal_identities', 'public.whatsapp_effect_ledger']) t$$),
  '3|0', 'as três tabelas novas existem e não têm acesso direto, nem por service_role'
);
select is(
  pg_temp.txt($$select string_agg(relname || ':' || relrowsecurity || ':' || relforcerowsecurity, ',' order by relname) from pg_class
    where relname in ('whatsapp_identities', 'whatsapp_internal_identities', 'whatsapp_effect_ledger') and relnamespace = 'public'::regnamespace$$),
  'whatsapp_effect_ledger:true:true,whatsapp_identities:true:true,whatsapp_internal_identities:true:true', 'RLS ligada e forçada nas três'
);
select is(
  pg_temp.txt($$select string_agg(p.proname, ',' order by p.proname collate "C") from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname like 'whatsapp\_%internal\_identit%'
      and has_function_privilege('service_role', p.oid, 'execute')
      and not has_function_privilege('authenticated', p.oid, 'execute') and not has_function_privilege('anon', p.oid, 'execute')
      and not has_function_privilege('public', p.oid, 'execute')
      and p.prosecdef and exists (select 1 from unnest(coalesce(p.proconfig, array[]::text[])) cfg where cfg = 'search_path=""')$$),
  'whatsapp_create_internal_identity,whatsapp_list_internal_identities,whatsapp_set_internal_identity_active',
  'identidades internas: três RPCs, só service_role, SECURITY DEFINER e search_path vazio'
);
select is(
  pg_temp.txt($$select count(*)::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'private' and p.proname in ('whatsapp_effect_ledger_reserve', 'whatsapp_is_internal_identity', 'whatsapp_domain_backfill', 'whatsapp_message_status_should_apply', 'whatsapp_may_create_lead')
      and not has_function_privilege('anon', p.oid, 'execute') and not has_function_privilege('authenticated', p.oid, 'execute')
      and not has_function_privilege('service_role', p.oid, 'execute') and not has_function_privilege('public', p.oid, 'execute')$$),
  '5', 'funções internas (ledger, identidade interna, backfill, status, lead): ninguém executa direto, nem service_role'
);

-- ---------------------------------------------------------------------
-- 2) A7 continua igual: simulador, envio, status e leituras
-- ---------------------------------------------------------------------

select count(*) as contatos_antes from public.contacts where workspace_id = :'ws_um'::uuid \gset
select count(*) as leads_antes from public.leads where workspace_id = :'ws_um'::uuid \gset
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'ana', 'role', 'authenticated')::text, true);
select simulate_inbound_whatsapp_message('b3d2b1-legado', '5511900001001', '+5511900001001', 'wamid.b3d2b1.1', now(), 'Mensagem fictícia', 'Pessoa Fictícia') as sim1 \gset
select register_contact_consent((:'sim1'::jsonb ->> 'contact_id')::uuid, 'whatsapp', 'consentimento', 'Atendimento (teste)', null, null, 'whatsapp_atendimento') as consent \gset
select send_message((:'sim1'::jsonb ->> 'conversation_id')::uuid, 'Resposta fictícia', '88888888-8888-8888-8888-888888888888'::uuid) as env1 \gset
reset role;
select wa_message_id as wamid_env1 from public.messages where id = (:'env1'::jsonb ->> 'message_id')::uuid \gset
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'ana', 'role', 'authenticated')::text, true);
select apply_message_status_event('b3d2b1-legado', :'wamid_env1', 'delivered', now()) ->> 'status' as st_env1 \gset
select is(:'st_env1'::text, 'delivered'::text, 'status da A7 continua sendo aplicado');
select is(
  (select (items -> 0 ->> 'wa_id') || '|' || jsonb_array_length(items)::text from list_conversations(:'ws_um'::uuid) limit 1),
  '+5511900001001|1', 'list_conversations continua igual (telefone da conversa)'
);
select is(
  (select jsonb_array_length(items)::text || '|' || (items -> 0 ->> 'body_text') || '|' || (items -> 1 ->> 'body_text') || '|' || has_more::text
   from list_conversation_messages((:'sim1'::jsonb ->> 'conversation_id')::uuid, null, 30, null)),
  '2|Mensagem fictícia|Resposta fictícia|false', 'list_conversation_messages continua paginando como antes'
);
select is(
  (select jsonb_array_length(items)::text || '|' || has_more::text from list_conversation_messages((:'sim1'::jsonb ->> 'conversation_id')::uuid, null, 1, null)),
  '1|true', 'paginação com limite 1: uma mensagem e has_more'
);
select is(get_conversation((:'sim1'::jsonb ->> 'conversation_id')::uuid) ->> 'wa_id', '+5511900001001', 'get_conversation continua com o telefone');
reset role;
select is(
  pg_temp.txt(format($$select c.identity_id is not null and i.phone_e164 = c.wa_id and i.channel_id = c.channel_id and i.environment is null and i.provider = 'simulated' and i.bsuid_blind_index is null
    from public.conversations c join public.whatsapp_identities i on i.id = c.identity_id where c.id = %L::uuid$$, :'sim1'::jsonb ->> 'conversation_id')),
  'true', 'conversa nova do simulador ganha a identidade (telefone, canal legado, sem BSUID) sozinha'
);
select is(
  pg_temp.txt(format($$select string_agg(direction || ':' || origin || ':' || sender_classification || ':' || content_kind, ',' order by direction)
    from public.messages where conversation_id = %L::uuid$$, :'sim1'::jsonb ->> 'conversation_id')),
  'inbound:inbound:unresolved:text,outbound:crm:internal:text', 'recebida: inbound/unresolved; enviada pelo CRM: crm/internal; nunca chatbot'
);

-- ---------------------------------------------------------------------
-- 3) Identidades: telefone, BSUID ou os dois — nunca nenhum
-- ---------------------------------------------------------------------

select is(
  pg_temp.st(format($$insert into public.whatsapp_identities (workspace_id, channel_id, environment, provider, phone_e164) values (%L, %L, 'preview', 'simulated', '+5511900002001')$$, :'ws_um', :'ch_a')),
  'ok', 'só telefone'
);
select is(
  pg_temp.st(format($$insert into public.whatsapp_identities (workspace_id, channel_id, environment, provider, bsuid_blind_index, bsuid_ciphertext, bsuid_key_version)
    values (%L, %L, 'preview', 'simulated', decode(%L, 'base64'), decode(%L, 'base64'), '1')$$, :'ws_um', :'ch_a', :'bi1', :'ct')),
  'ok', 'só BSUID (índice cego e cifra), sem telefone'
);
select is(
  pg_temp.st(format($$insert into public.whatsapp_identities (workspace_id, channel_id, environment, provider, phone_e164, bsuid_blind_index, bsuid_ciphertext, bsuid_key_version)
    values (%L, %L, 'preview', 'simulated', '+5511900002002', decode(%L, 'base64'), decode(%L, 'base64'), '1')$$, :'ws_um', :'ch_a', :'bi2', :'ct')),
  'ok', 'telefone e BSUID juntos'
);
select is(
  pg_temp.st(format($$insert into public.whatsapp_identities (workspace_id, channel_id, environment, provider) values (%L, %L, 'preview', 'simulated')$$, :'ws_um', :'ch_a')),
  '23514', 'identidade vazia: recusada'
);
select is(
  pg_temp.st(format($$insert into public.whatsapp_identities (workspace_id, channel_id, environment, provider, bsuid_blind_index, bsuid_key_version)
    values (%L, %L, 'preview', 'simulated', decode(%L, 'base64'), '1')$$, :'ws_um', :'ch_a', :'bi3')) || ' ' ||
  pg_temp.st(format($$insert into public.whatsapp_identities (workspace_id, channel_id, environment, provider, bsuid_blind_index, bsuid_ciphertext, bsuid_key_version)
    values (%L, %L, 'preview', 'simulated', decode(%L, 'base64'), decode(%L, 'base64'), '1')$$, :'ws_um', :'ch_a', :'curto', :'ct')),
  '23514 23514', 'BSUID incompleto (sem cifra) ou com índice fora de 32 bytes: recusado'
);
select is(
  pg_temp.st(format($$insert into public.whatsapp_identities (workspace_id, channel_id, environment, provider, phone_e164) values (%L, %L, 'preview', 'simulated', '11900002003')$$, :'ws_um', :'ch_a')),
  '23514', 'telefone fora do E.164: recusado (nunca um BSUID no lugar do telefone)'
);
select is(
  pg_temp.st(format($$insert into public.whatsapp_identities (workspace_id, channel_id, environment, provider, phone_e164) values (%L, %L, 'preview', 'simulated', '+5511900002001')$$, :'ws_um', :'ch_a')) || ' ' ||
  pg_temp.st(format($$insert into public.whatsapp_identities (workspace_id, channel_id, environment, provider, bsuid_blind_index, bsuid_ciphertext, bsuid_key_version)
    values (%L, %L, 'preview', 'simulated', decode(%L, 'base64'), decode(%L, 'base64'), '1')$$, :'ws_um', :'ch_a', :'bi1', :'ct')),
  '23505 23505', 'mesmo telefone ou mesmo índice cego no mesmo canal: único'
);
select is(
  pg_temp.st(format($$insert into public.whatsapp_identities (workspace_id, channel_id, environment, provider, phone_e164) values (%L, %L, 'preview', 'simulated', '+5511900002001')$$, :'ws_um', :'ch_a2')),
  'ok', 'o mesmo telefone em outro canal é outra identidade'
);
select is(
  pg_temp.st(format($$insert into public.whatsapp_identities (workspace_id, channel_id, environment, provider, phone_e164) values (%L, %L, 'production', 'simulated', '+5511900002009')$$, :'ws_um', :'ch_a')) || ' ' ||
  pg_temp.st(format($$insert into public.whatsapp_identities (workspace_id, channel_id, environment, provider, phone_e164) values (%L, %L, 'preview', 'simulated', '+5511900002009')$$, :'ws_dois', :'ch_a')) || ' ' ||
  pg_temp.st(format($$insert into public.whatsapp_identities (workspace_id, channel_id, environment, provider, phone_e164) values (%L, %L, 'preview', 'ycloud', '+5511900002009')$$, :'ws_um', :'ch_a')),
  '23503 23503 23503', 'ambiente, workspace ou provedor diferentes do canal: recusados'
);
select is(
  pg_temp.st(format($$update public.whatsapp_identities set phone_e164 = '+5511900002999' where channel_id = %L and phone_e164 = '+5511900002001'$$, :'ch_a')) || ' ' ||
  pg_temp.st(format($$update public.whatsapp_identities set bsuid_blind_index = null, bsuid_ciphertext = null, bsuid_key_version = null where channel_id = %L and bsuid_blind_index = decode(%L, 'base64')$$, :'ch_a', :'bi2')) || ' ' ||
  pg_temp.st(format($$update public.whatsapp_identities set channel_id = %L where channel_id = %L and phone_e164 = '+5511900002001'$$, :'ch_a2', :'ch_a')),
  'P0001 P0001 P0001', 'telefone, BSUID e canal da identidade não mudam depois de gravados'
);
select is(
  pg_temp.st(format($$update public.whatsapp_identities set phone_e164 = '+5511900002005' where channel_id = %L and bsuid_blind_index = decode(%L, 'base64')$$, :'ch_a', :'bi1')),
  'ok', 'um identificador que faltava pode ser acrescentado (BSUID ganha o telefone quando o provedor informa)'
);
-- Conversa só com BSUID, sem telefone.
select pg_temp.txt(format($$select id::text from public.whatsapp_identities where channel_id = %L and bsuid_blind_index = decode(%L, 'base64')$$, :'ch_a', :'bi2')) as ident_ambos \gset
select pg_temp.txt(format($$insert into public.whatsapp_identities (workspace_id, channel_id, environment, provider, bsuid_blind_index, bsuid_ciphertext, bsuid_key_version)
  values (%L, %L, 'preview', 'simulated', decode(%L, 'base64'), decode(%L, 'base64'), '1') returning id::text$$, :'ws_um', :'ch_a', :'bi3', :'ct')) as ident_bsuid \gset
select is(
  pg_temp.st(format($$insert into public.conversations (workspace_id, channel_id, identity_id) values (%L, %L, %L)$$, :'ws_um', :'ch_a', :'ident_bsuid')),
  'ok', 'conversa só com BSUID (sem telefone)'
);
select is(
  pg_temp.st(format($$insert into public.conversations (workspace_id, channel_id, wa_id, identity_id) values (%L, %L, '+5511900002777', %L)$$, :'ws_um', :'ch_a', :'ident_ambos')) || ' ' ||
  pg_temp.st(format($$insert into public.conversations (workspace_id, channel_id) values (%L, %L)$$, :'ws_um', :'ch_a')) || ' ' ||
  pg_temp.st(format($$insert into public.conversations (workspace_id, channel_id, identity_id) values (%L, %L, %L)$$, :'ws_um', :'ch_a2', :'ident_bsuid')),
  'P0001 P0001 P0001', 'conversa com telefone diferente da identidade, sem identidade nenhuma, ou com identidade de outro canal: recusada'
);
select is(
  pg_temp.st(format($$insert into public.conversations (workspace_id, channel_id, identity_id) values (%L, %L, %L)$$, :'ws_um', :'ch_a', :'ident_bsuid')),
  '23505', 'uma conversa por identidade'
);

-- ---------------------------------------------------------------------
-- 4) Mensagens: conteúdo, origem e classificação
-- ---------------------------------------------------------------------

select pg_temp.txt(format($$select id::text from public.conversations where identity_id = %L$$, :'ident_bsuid')) as conv_b \gset

create function pg_temp.msg(p_conv text, p_ws text, p_ch text, p_dir text, p_origin text, p_cls text, p_kind text, p_body text, p_pmid text, p_extra text default '') returns text language plpgsql as $f$
begin
  execute format(
    'insert into public.messages (workspace_id, conversation_id, channel_id, direction, origin, sender_classification, content_kind, body_text, provider, provider_message_id, status%s) values (%L, %L, %L, %L, %L, %L, %L, %L, ''simulated'', %L, ''accepted''%s)',
    case when p_extra = '' then '' else ', ' || split_part(p_extra, '=', 1) end,
    p_ws, p_conv, p_ch, p_dir, p_origin, p_cls, p_kind, p_body, p_pmid,
    case when p_extra = '' then '' else ', ' || split_part(p_extra, '=', 2) end
  );
  return 'ok';
exception when others then
  return sqlstate;
end
$f$;

select is(pg_temp.msg(:'conv_b', :'ws_um', :'ch_a', 'inbound', 'inbound', 'external', 'image', null, 'pm-1'), 'ok', 'mídia sem texto, recebida, com status accepted');
select is(pg_temp.msg(:'conv_b', :'ws_um', :'ch_a', 'inbound', 'inbound', 'external', 'document', 'Contrato (legenda)', 'pm-2'), 'ok', 'mídia com legenda');
select is(pg_temp.msg(:'conv_b', :'ws_um', :'ch_a', 'inbound', 'inbound', 'external', 'text', null, 'pm-3'), '23514', 'texto sem corpo: recusado');
select is(pg_temp.msg(:'conv_b', :'ws_um', :'ch_a', 'inbound', 'inbound', 'external', 'holograma', null, 'pm-4'), '23514', 'tipo de conteúdo desconhecido: recusado');
select is(
  pg_temp.msg(:'conv_b', :'ws_um', :'ch_a', 'outbound', 'business_app', 'internal', 'text', 'Eco do aplicativo', 'pm-5') || ' ' ||
  pg_temp.msg(:'conv_b', :'ws_um', :'ch_a', 'outbound', 'external_api', 'unresolved', 'text', 'Saída por API', 'pm-6') || ' ' ||
  pg_temp.msg(:'conv_b', :'ws_um', :'ch_a', 'inbound', 'inbound', 'internal', 'text', 'Comando interno', 'pm-7') || ' ' ||
  pg_temp.msg(:'conv_b', :'ws_um', :'ch_a', 'inbound', 'history', 'unresolved', 'text', 'Histórico', 'pm-8'),
  'ok ok ok ok', 'business_app+internal, external_api+unresolved, inbound+internal e history: aceitos'
);
select is(
  pg_temp.msg(:'conv_b', :'ws_um', :'ch_a', 'outbound', 'chatbot', 'automation', 'text', 'Bot sem prova', 'pm-9') || ' ' ||
  pg_temp.msg(:'conv_b', :'ws_um', :'ch_a', 'outbound', 'chatbot', 'automation', 'text', 'Bot com prova', 'pm-10', 'origin_correlation_kind, origin_correlation_ref=''chatbot_request'', ''req-1''') || ' ' ||
  pg_temp.msg(:'conv_b', :'ws_um', :'ch_a', 'outbound', 'external_api', 'unresolved', 'text', 'API com prova de chatbot', 'pm-11', 'origin_correlation_kind, origin_correlation_ref=''chatbot_request'', ''req-2'''),
  '23514 ok 23514', 'chatbot só com correlação positiva; correlação de chatbot só com origem chatbot'
);
select is(
  pg_temp.msg(:'conv_b', :'ws_um', :'ch_a', 'inbound', 'inbound', 'automation', 'text', 'x', 'pm-12') || ' ' ||
  pg_temp.msg(:'conv_b', :'ws_um', :'ch_a', 'outbound', 'business_app', 'external', 'text', 'x', 'pm-13') || ' ' ||
  pg_temp.msg(:'conv_b', :'ws_um', :'ch_a', 'outbound', 'external_api', 'external', 'text', 'x', 'pm-14') || ' ' ||
  pg_temp.msg(:'conv_b', :'ws_um', :'ch_a', 'outbound', 'inbound', 'external', 'text', 'x', 'pm-15') || ' ' ||
  pg_temp.msg(:'conv_b', :'ws_um', :'ch_a', 'inbound', 'crm', 'internal', 'text', 'x', 'pm-16') || ' ' ||
  pg_temp.msg(:'conv_b', :'ws_um', :'ch_a', 'outbound', 'crm', 'internal', 'text', 'x', 'pm-17'),
  '23514 23514 23514 23514 23514 23514', 'combinações proibidas e direção incoerente: recusadas (crm/internal exige autor)'
);
select is(
  pg_temp.msg(:'conv_b', :'ws_um', :'ch_a', 'outbound', 'internal', 'internal', 'text', 'x', 'pm-18'),
  '22P02', 'internal nunca é origem (valor fora do enum)'
);
select is(
  pg_temp.st(format($$insert into public.messages (workspace_id, conversation_id, channel_id, direction, origin, sender_classification, content_kind, body_text, status) values (%L, %L, %L, 'inbound', 'inbound', 'external', 'text', 'x', 'delivered')$$, :'ws_um', :'conv_b', :'ch_a')),
  '23514', 'mensagem sem nenhum identificador do provedor: recusada'
);
select is(
  pg_temp.msg(:'conv_b', :'ws_um', :'ch_a', 'inbound', 'inbound', 'external', 'image', null, 'pm-1'),
  '23505', 'mesmo id de mensagem do provedor no mesmo canal: único'
);

-- ---------------------------------------------------------------------
-- 5) Custo do provedor
-- ---------------------------------------------------------------------

select pg_temp.txt(format($$select id::text from public.messages where channel_id = %L and provider_message_id = 'pm-6'$$, :'ch_a')) as m_api \gset
select is(
  pg_temp.st(format($$update public.messages set provider_cost_amount = 0.0625, provider_cost_currency = 'BRL', provider_cost_category = 'utility', provider_cost_finality = 'estimated' where id = %L$$, :'m_api')),
  'ok', 'custo estimado'
);
select is(
  pg_temp.txt(format($$select coalesce(provider_cost_billable_amount::text, 'null') from public.messages where id = %L$$, :'m_api')),
  'null', 'estimado não entra no total cobrado'
);
select is(
  pg_temp.st(format($$update public.messages set provider_cost_amount = 0.05, provider_cost_finality = 'final', status = 'delivered' where id = %L$$, :'m_api')) || '|' ||
  pg_temp.txt(format($$select provider_cost_billable_amount::text from public.messages where id = %L$$, :'m_api')),
  'ok|0.050000', 'custo final substitui a estimativa e entra no total cobrado'
);
select is(
  pg_temp.st(format($$update public.messages set provider_cost_amount = 0.07, provider_cost_finality = 'estimated' where id = %L$$, :'m_api')) || ' ' ||
  pg_temp.st(format($$update public.messages set provider_cost_amount = 0.09 where id = %L$$, :'m_api')),
  'P0001 P0001', 'custo final nunca é substituído, nem por estimativa nem por outro valor'
);
select is(
  pg_temp.st(format($$update public.messages set status = 'failed', provider_cost_amount = 0.04, provider_cost_currency = 'BRL', provider_cost_finality = 'final' where provider_message_id = 'pm-5' and channel_id = %L$$, :'ch_a')),
  '23514', 'custo de failed permanece estimado'
);
select is(
  pg_temp.st(format($$update public.messages set provider_cost_amount = 0.01, provider_cost_currency = 'BRL', provider_cost_category = 'marketing_lite_v2', provider_cost_finality = 'estimated' where provider_message_id = 'pm-5' and channel_id = %L$$, :'ch_a')) || ' ' ||
  pg_temp.st(format($$update public.messages set provider_cost_category = 'Marketing Lite' where provider_message_id = 'pm-5' and channel_id = %L$$, :'ch_a')) || ' ' ||
  pg_temp.st(format($$update public.messages set provider_cost_currency = 'brl' where provider_message_id = 'pm-5' and channel_id = %L$$, :'ch_a')) || ' ' ||
  pg_temp.st(format($$update public.messages set provider_cost_amount = -1 where provider_message_id = 'pm-5' and channel_id = %L$$, :'ch_a')) || ' ' ||
  pg_temp.st(format($$update public.messages set provider_cost_currency = null where provider_message_id = 'pm-5' and channel_id = %L$$, :'ch_a')),
  'ok 23514 23514 23514 23514', 'categoria futura bem formada preservada; categoria, moeda e valor malformados ou incompletos recusados'
);
select is(
  pg_temp.txt(format($$select sum(provider_cost_billable_amount)::text from public.messages where conversation_id = %L$$, :'conv_b')),
  '0.050000', 'total cobrado da conversa: só o custo final'
);

-- ---------------------------------------------------------------------
-- 6) Status: regra da B3 (accepted; delivered/read corrigem failed) sem
--    mudar a da A7
-- ---------------------------------------------------------------------

create function pg_temp.sa(p_cur text, p_new text) returns text language plpgsql as $f$
declare
  v boolean;
begin
  execute format('select private.whatsapp_message_status_should_apply(%s, %L::public.message_status)',
    case when p_cur is null then 'null' else quote_literal(p_cur) || '::public.message_status' end, p_new) into v;
  return coalesce(v::text, 'null');
exception when others then
  return 'ERRO';
end
$f$;

select is(
  pg_temp.sa(null, 'accepted') || pg_temp.sa('accepted', 'sent') || pg_temp.sa('sent', 'delivered') || pg_temp.sa('delivered', 'read') || pg_temp.sa('accepted', 'failed') || pg_temp.sa('sent', 'failed'),
  'truetruetruetruetruetrue', 'avança: accepted → sent → delivered → read, e falha a partir de accepted/sent'
);
select is(
  pg_temp.sa('failed', 'delivered') || pg_temp.sa('failed', 'read'),
  'truetrue', 'delivered e read corrigem failed'
);
select is(
  pg_temp.sa('sent', 'accepted') || pg_temp.sa('read', 'delivered') || pg_temp.sa('delivered', 'failed') || pg_temp.sa('read', 'failed') || pg_temp.sa('failed', 'sent') || pg_temp.sa('failed', 'accepted') || pg_temp.sa('read', 'read'),
  'falsefalsefalsefalsefalsefalsefalse', 'nada regride, e accepted/sent não apagam failed'
);
select is(
  pg_temp.txt($$select string_agg(s || ':' || private.message_status_rank(s::public.message_status), ',' order by s) from unnest(array['queued', 'accepted', 'sent', 'failed', 'delivered', 'read']) s$$),
  'accepted:0,delivered:2,failed:1,queued:0,read:3,sent:1', 'rank da A7 igual para os status antigos; accepted não muda a regra da A7'
);
select is(
  pg_temp.txt($$select string_agg(o || '/' || c, ',' order by o, c) from unnest(enum_range(null::public.whatsapp_message_origin)) o, unnest(enum_range(null::public.whatsapp_sender_classification)) c where private.whatsapp_may_create_lead(o, c)$$),
  'inbound/external', 'lead só para inbound + external (identidade interna, bot, eco, histórico ou status nunca)'
);

-- ---------------------------------------------------------------------
-- 7) Identidades internas: só owner e admin, por workspace, ambiente e canal
-- ---------------------------------------------------------------------

create function pg_temp.ii_create(p_ws text, p_actor text, p_ch text, p_label text, p_phone text, p_bi text, p_ct text, p_kv text) returns jsonb language plpgsql as $f$
declare
  v jsonb;
begin
  execute format('select public.whatsapp_create_internal_identity(%L::uuid, %L::uuid, %L::uuid, %L, %L, %L, %L, %L)', p_ws, p_actor, p_ch, p_label, p_phone, p_bi, p_ct, p_kv) into v;
  return v;
exception when others then
  return jsonb_build_object('erro', sqlerrm);
end
$f$;

set local role service_role;
select pg_temp.ii_create(:'ws_um', :'ana', :'ch_a', 'Advogado (fictício)', '+5511900003001', null, null, null) as ii1 \gset
select pg_temp.ii_create(:'ws_um', :'bruno', :'ch_a', 'Número interno (fictício)', null, :'bi1', :'ct', '1') as ii2 \gset
select is(
  (select string_agg(k, ',' order by k collate "C") from jsonb_object_keys(:'ii1'::jsonb) k),
  'channel_id,created_at,has_bsuid,id,is_active,label,phone_e164,updated_at',
  'owner cria (só telefone); o retorno não traz índice cego, cifra nem versão de chave'
);
select is((:'ii2'::jsonb ->> 'has_bsuid') || '|' || coalesce(:'ii2'::jsonb ->> 'phone_e164', 'null'), 'true|null', 'admin cria (só BSUID)');
select is(
  coalesce(pg_temp.ii_create(:'ws_um', :'daniel', :'ch_a', 'X', '+5511900003002', null, null, null) ->> 'erro', 'criou') || ' ' ||
  coalesce(pg_temp.ii_create(:'ws_um', :'carla', :'ch_a', 'X', '+5511900003003', null, null, null) ->> 'erro', 'criou') || ' ' ||
  coalesce(pg_temp.ii_create(:'ws_um', :'elisa', :'ch_a', 'X', '+5511900003004', null, null, null) ->> 'erro', 'criou'),
  'insufficient_permission insufficient_permission insufficient_permission', 'manager, lawyer e viewer não administram identidades internas'
);
select is(
  coalesce(pg_temp.ii_create(:'ws_dois', :'bruno', :'ch_a', 'X', '+5511900003005', null, null, null) ->> 'erro', 'criou') || ' ' ||
  coalesce(pg_temp.ii_create(:'ws_um', :'ana', :'ch_b', 'X', '+5511900003006', null, null, null) ->> 'erro', 'criou') || ' ' ||
  coalesce(pg_temp.ii_create(:'ws_um', :'ana', :'ch_prod', 'X', '+5511900003007', null, null, null) ->> 'erro', 'criou') || ' ' ||
  coalesce(pg_temp.ii_create(:'ws_um', :'ana', :'ch_legado', 'X', '+5511900003008', null, null, null) ->> 'erro', 'criou'),
  'channel_not_found channel_not_found channel_not_found channel_not_found',
  'canal de outro workspace, de outro ambiente ou legado da A7: não encontrado'
);
select is(
  coalesce(pg_temp.ii_create(:'ws_um', :'ana', :'ch_a', 'Vazia', null, null, null, null) ->> 'erro', 'criou') || ' ' ||
  coalesce(pg_temp.ii_create(:'ws_um', :'ana', :'ch_a', 'Parcial', null, :'bi2', null, '1') ->> 'erro', 'criou') || ' ' ||
  coalesce(pg_temp.ii_create(:'ws_um', :'ana', :'ch_a', 'Telefone ruim', '11900003009', null, null, null) ->> 'erro', 'criou') || ' ' ||
  coalesce(pg_temp.ii_create(:'ws_um', :'ana', :'ch_a', 'Base64 ruim', null, '%%%', :'ct', '1') ->> 'erro', 'criou') || ' ' ||
  coalesce(pg_temp.ii_create(:'ws_um', :'ana', :'ch_a', '   ', '+5511900003010', null, null, null) ->> 'erro', 'criou'),
  'invalid_internal_identity invalid_internal_identity invalid_internal_identity invalid_internal_identity invalid_internal_identity',
  'vazia, BSUID incompleto, telefone fora do E.164, base64 inválido ou sem rótulo: recusadas sem repetir o valor'
);
select is(
  coalesce(pg_temp.ii_create(:'ws_um', :'ana', :'ch_a', 'Duplicada', '+5511900003001', null, null, null) ->> 'erro', 'criou') || ' ' ||
  coalesce(pg_temp.ii_create(:'ws_um', :'ana', :'ch_a', 'Duplicada', null, :'bi1', :'ct', '1') ->> 'erro', 'criou'),
  'internal_identity_taken internal_identity_taken', 'mesmo telefone ou mesmo BSUID no canal: já cadastrado'
);
select is(
  pg_temp.txt(format($$select jsonb_array_length(public.whatsapp_list_internal_identities(%L::uuid, %L::uuid, %L::uuid))::text$$, :'ws_um', :'ana', :'ch_a')),
  '2', 'owner lista as identidades internas do canal'
);
select is(
  pg_temp.txt(format($$select position('blind' in l::text) + position('ciphertext' in l::text) + position('key_version' in l::text) + position(%L in l::text) from (select public.whatsapp_list_internal_identities(%L::uuid, %L::uuid, %L::uuid) as l) q$$, :'ct', :'ws_um', :'ana', :'ch_a')),
  '0', 'a listagem nunca traz índice cego, cifra ou versão de chave'
);
select is(
  pg_temp.txt(format($$select public.whatsapp_list_internal_identities(%L::uuid, %L::uuid, %L::uuid)::text$$, :'ws_um', :'daniel', :'ch_a')) || ' ' ||
  pg_temp.txt(format($$select public.whatsapp_list_internal_identities(%L::uuid, %L::uuid, %L::uuid)::text$$, :'ws_dois', :'bruno', :'ch_a')) || ' ' ||
  pg_temp.txt(format($$select public.whatsapp_list_internal_identities(%L::uuid, %L::uuid, %L::uuid)::text$$, :'ws_um', :'elisa', :'ch_a')),
  'ERRO:P0001:insufficient_permission ERRO:P0001:channel_not_found ERRO:P0001:insufficient_permission',
  'manager e viewer não listam; o owner de outro workspace não alcança o canal'
);
select set_config('request.headers', :'h_prod', true);
select is(
  pg_temp.txt(format($$select public.whatsapp_list_internal_identities(%L::uuid, %L::uuid, %L::uuid)::text$$, :'ws_um', :'ana', :'ch_a')),
  'ERRO:P0001:channel_not_found', 'com o ambiente Production, o canal de Preview não é encontrado'
);
select set_config('request.headers', :'h_prev', true);
select is(
  pg_temp.txt(format($$select (public.whatsapp_set_internal_identity_active(%L::uuid, %L::uuid, %L::uuid, false) ->> 'is_active')$$, :'ii1'::jsonb ->> 'id', :'ws_um', :'ana')) || ' ' ||
  pg_temp.txt(format($$select (public.whatsapp_set_internal_identity_active(%L::uuid, %L::uuid, %L::uuid, false) ->> 'is_active')$$, :'ii2'::jsonb ->> 'id', :'ws_um', :'daniel')) || ' ' ||
  pg_temp.txt(format($$select (public.whatsapp_set_internal_identity_active(%L::uuid, %L::uuid, %L::uuid, false) ->> 'is_active')$$, :'ii2'::jsonb ->> 'id', :'ws_dois', :'bruno')),
  'false ERRO:P0001:insufficient_permission ERRO:P0001:internal_identity_not_found',
  'owner desativa; manager não; outro workspace não encontra'
);
reset role;
select is(
  pg_temp.txt(format($$select private.whatsapp_is_internal_identity(%L::uuid, '+5511900003001', null)::text || ' ' || private.whatsapp_is_internal_identity(%L::uuid, null, decode(%L, 'base64'))::text || ' ' ||
    private.whatsapp_is_internal_identity(%L::uuid, null, decode(%L, 'base64'))::text || ' ' || private.whatsapp_is_internal_identity(%L::uuid, '+5511900009999', null)::text$$,
    :'ch_a', :'ch_a', :'bi1', :'ch_a2', :'bi1', :'ch_a')),
  'false true false false', 'casamento interno: desativada não vale; o mesmo BSUID em outro canal não vale; número desconhecido não vale'
);
select is(
  (select count(*)::int from public.audit_logs where action like 'whatsapp.internal_identity.%'
     and (metadata::text like '%5511900003%' or metadata::text like '%' || :'bi1' || '%' or metadata::text like '%' || :'ct' || '%')),
  0, 'auditoria das identidades internas sem telefone, índice cego ou cifra'
);
select is(
  (select count(*)::int from public.audit_logs where action like 'whatsapp.internal_identity.%' and workspace_id = :'ws_um'::uuid),
  3, 'criação (2) e desativação (1) auditadas'
);
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'ana', 'role', 'authenticated')::text, true);
select is(
  (pg_temp.txt(format($$select public.whatsapp_list_internal_identities(%L::uuid, %L::uuid, %L::uuid)::text$$, :'ws_um', :'ana', :'ch_a')) like 'ERRO:42501%')::text,
  'true', 'authenticated não executa as RPCs de identidade interna, nem como owner'
);
reset role;

-- ---------------------------------------------------------------------
-- 8) Ledger de efeitos: idempotente e sem colisão
-- ---------------------------------------------------------------------

create function pg_temp.lr(p_env text, p_ws text, p_ch text, p_prov text, p_evt text, p_effect text default 'message.inbound') returns text language plpgsql as $f$
declare
  v uuid;
begin
  execute format('select private.whatsapp_effect_ledger_reserve(%L::public.whatsapp_environment, %L::uuid, %L::uuid, %L::public.whatsapp_provider, %L, %L, null)',
    p_env, p_ws, p_ch, p_prov, p_evt, p_effect) into v;
  return case when v is null then 'duplicado' else 'reservado' end;
exception when others then
  return sqlstate;
end
$f$;

select is(pg_temp.lr('preview', :'ws_um', :'ch_a', 'simulated', 'evt-1'), 'reservado', 'primeiro efeito do evento: reservado');
select is(pg_temp.lr('preview', :'ws_um', :'ch_a', 'simulated', 'evt-1'), 'duplicado', 'o mesmo evento estável de novo: duplicado, nenhum efeito novo');
select is(pg_temp.lr('preview', :'ws_um', :'ch_a', 'simulated', 'evt-1', 'message.status'), 'duplicado', 'o mesmo evento com outro efeito declarado continua duplicado');
select is(
  pg_temp.lr('preview', :'ws_um', :'ch_a2', 'simulated', 'evt-1') || ' ' || pg_temp.lr('preview', :'ws_dois', :'ch_b', 'simulated', 'evt-1') || ' ' || pg_temp.lr('production', :'ws_um', :'ch_prod', 'simulated', 'evt-1'),
  'reservado reservado reservado', 'o mesmo id de evento em outro canal, workspace ou ambiente não colide'
);
select is(
  pg_temp.lr('production', :'ws_um', :'ch_a', 'simulated', 'evt-2') || ' ' || pg_temp.lr('preview', :'ws_dois', :'ch_a', 'simulated', 'evt-2') || ' ' || pg_temp.lr('preview', :'ws_um', :'ch_a', 'ycloud', 'evt-2'),
  '23503 23503 23503', 'ambiente, workspace ou provedor que não são os do canal: recusados'
);
select is(
  pg_temp.lr('preview', :'ws_um', :'ch_a', 'simulated', 'evt com espaço') || ' ' || pg_temp.lr('preview', :'ws_um', :'ch_a', 'simulated', '+5511900001001') || ' ' ||
  pg_temp.lr('preview', :'ws_um', :'ch_a', 'simulated', repeat('e', 129)) || ' ' || pg_temp.lr('preview', :'ws_um', :'ch_a', 'simulated', 'evt-3', 'mensagem com texto'),
  '23514 23514 23514 23514', 'id de evento malformado (inclusive um telefone) ou efeito fora da lista: recusados'
);
select is(
  pg_temp.txt(format($$select count(*)::text from public.whatsapp_effect_ledger where provider_event_id = 'evt-1'$$)),
  '4', 'quatro chaves distintas para evt-1, uma por canal/ambiente'
);
set local role service_role;
select is(
  pg_temp.txt($$select count(*)::text from public.whatsapp_effect_ledger$$) like 'ERRO:42501%' and pg_temp.txt(format($$select private.whatsapp_effect_ledger_reserve('preview', %L::uuid, %L::uuid, 'simulated', 'evt-9', 'message.inbound', null)::text$$, :'ws_um', :'ch_a')) like 'ERRO:42501%',
  true, 'service_role não lê o ledger nem reserva efeito direto'
);
reset role;

-- ---------------------------------------------------------------------
-- 9) Backfill determinístico e idempotente
-- ---------------------------------------------------------------------

select is(
  pg_temp.txt($$select private.whatsapp_domain_backfill()::text$$),
  '{"identities_created": 0, "messages_classified": 0, "conversations_linked": 0}', 'rodar o backfill de novo não muda nada'
);
select is(
  pg_temp.txt($$select count(*)::text from public.messages where origin = 'chatbot' and origin_correlation_kind is distinct from 'chatbot_request'$$),
  '0', 'nenhuma mensagem é chatbot sem correlação'
);
select is(
  (select count(*)::int from public.contacts where workspace_id = :'ws_um'::uuid) - :contatos_antes::int || '|' || ((select count(*)::int from public.leads where workspace_id = :'ws_um'::uuid) - :leads_antes::int),
  '1|1', 'só o simulador da A7 criou contato e lead (como sempre); nada do modelo novo criou contato ou lead'
);

select * from finish();
rollback;
