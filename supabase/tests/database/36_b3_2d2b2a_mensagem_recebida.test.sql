-- pgTAP — B3.2d-2b2a: efeito atômico de mensagem RECEBIDA.
--
-- public.whatsapp_effect_inbound_message, numa transação só e sob a trava
-- da inbox:
--  - inbox no ambiente autenticado, em processing, com o token do claim e
--    a lease vigente; workspace, canal, ambiente, provedor e evento vêm da
--    linha da inbox, nunca do chamador;
--  - reserva message.inbound no ledger; duplicate não repete nada e
--    conflict não grava nada;
--  - resolve a identidade por telefone e BSUID (cria, reutiliza, acrescenta
--    o que falta; telefone e BSUID de identidades diferentes →
--    identity_conflict, sem efeito parcial);
--  - classifica pelo casamento com as identidades internas ativas
--    (internal, external ou unresolved), nunca pelo texto;
--  - conversa, mensagem e, só para inbound + external com telefone,
--    contato, lead, oportunidade e atividade pelas regras da A7;
--  - marca a inbox como processed; qualquer falha desfaz tudo.
--
-- Escrito ANTES da implementação, contra a main 5ba35c4. Tudo fictício:
-- nenhum telefone, BSUID ou identidade real. As chamadas passam por
-- funções que capturam o erro: contra a main, o arquivo roda até o fim.

begin;
select plan(61);

\set ana    '20000000-0000-0000-0000-000000000001'
\set ws_um   '10000000-0000-0000-0000-000000000001'
\set ws_dois '10000000-0000-0000-0000-000000000002'
\set ch_a    '39000000-0000-0000-0000-000000000001'
\set ch_i    '39000000-0000-0000-0000-000000000002'
\set ch_prod '39000000-0000-0000-0000-000000000003'
\set ch_b    '39000000-0000-0000-0000-000000000004'
\set inventado '7d1e2f3a-4b5c-4d6e-8f70-819a2b3c4d5e'
\set cifra   'QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFB'
\set bi1     'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE='
\set bi2     'AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI='
\set bi3     'AwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwM='
\set bi4     'BAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQ='
\set bi5     'BQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQU='
\set bi6     'BgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgY='
\set bi7     'BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc='
\set bi8     'CAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAg='
\set ct      'CQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQ=='

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

select pg_temp.hdr('preview') as h_prev \gset
select pg_temp.hdr('production') as h_prod \gset
select set_config('request.headers', :'h_prev', true);

-- Canais da B3 (simulados): A e I no Escritório Um (I com identidades
-- internas), B no Escritório Dois e um de Production no Escritório Um.
set local role service_role;
select whatsapp_create_simulated_channel(:'ch_a'::uuid, :'ws_um'::uuid, :'ana'::uuid, 'A', 'b3d2b2a-a', '1', :'cifra', '1') is not null as ok \gset
select whatsapp_create_simulated_channel(:'ch_i'::uuid, :'ws_um'::uuid, :'ana'::uuid, 'I', 'b3d2b2a-i', '1', :'cifra', '1') is not null as ok \gset
select whatsapp_create_simulated_channel(:'ch_b'::uuid, :'ws_dois'::uuid, '20000000-0000-0000-0000-000000000002'::uuid, 'B', 'b3d2b2a-b', '1', :'cifra', '1') is not null as ok \gset
select set_config('request.headers', :'h_prod', true);
select whatsapp_create_simulated_channel(:'ch_prod'::uuid, :'ws_um'::uuid, :'ana'::uuid, 'Prod', 'b3d2b2a-prod', '1', :'cifra', '1') is not null as ok \gset
select set_config('request.headers', :'h_prev', true);
reset role;

-- Canal Z, sem nenhuma identidade interna, configurado pelo Bruno (admin
-- só nesta transação): cobre a regra "sem identidade interna ativa" e a
-- autoria técnica.
\set bruno '20000000-0000-0000-0000-000000000002'
\set ch_z  '39000000-0000-0000-0000-000000000005'
insert into public.memberships (workspace_id, user_id, role, status) values (:'ws_um'::uuid, :'bruno'::uuid, 'admin', 'active')
on conflict (workspace_id, user_id) do update set role = excluded.role, status = 'active';
set local role service_role;
select whatsapp_create_simulated_channel(:'ch_z'::uuid, :'ws_um'::uuid, :'bruno'::uuid, 'Z', 'b3d2b2a-z', '1', :'cifra', '1') is not null as ok \gset
reset role;

-- A e B têm uma identidade interna ativa com telefone e BSUID (versão 1):
-- todo remetente é comparável, e quem não casa é external.
\set bi9 'CgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgo='
insert into public.whatsapp_internal_identities (workspace_id, channel_id, environment, provider, label, phone_e164, bsuid_blind_index, bsuid_ciphertext, bsuid_key_version, is_active, created_by) values
  (:'ws_um'::uuid, :'ch_a'::uuid, 'preview', 'simulated', 'Recepção (fictícia)', '+5511900009999', decode(:'bi9', 'base64'), decode(:'ct', 'base64'), '1', true, :'ana'::uuid),
  (:'ws_dois'::uuid, :'ch_b'::uuid, 'preview', 'simulated', 'Recepção (fictícia)', '+5511900009999', decode(:'bi9', 'base64'), decode(:'ct', 'base64'), '1', true, :'bruno'::uuid);

-- Entrada da inbox (cifra fictícia) e claim, como service_role: devolve
-- 'id|token'.
create function pg_temp.entrada(p_ch text, p_ws text, p_routing text, p_evt text, p_claim boolean default true) returns text language plpgsql as $f$
declare
  v_id text;
  v_token text;
begin
  execute 'set local role service_role';
  v_id := public.whatsapp_inbox_store(p_ch::uuid, p_ws::uuid, 'simulated', p_routing, p_evt, 'whatsapp.inbound_message.received',
    repeat('a', 64), '1', 'AAAAAAAAAAAAAAAA', 'Q29ycG8gZmljdGljaW8=', 'AAAAAAAAAAAAAAAAAAAAAA==', 3600) ->> 'inbox_id';
  if p_claim then
    v_token := public.whatsapp_inbox_claim(v_id::uuid, 300) ->> 'claim_token';
  end if;
  execute 'reset role';
  return v_id || '|' || coalesce(v_token, '-');
end
$f$;

-- Chamada do efeito como service_role: o jsonb devolvido, ou
-- {"erro": <mensagem>}.
create function pg_temp.ap(p_entry text, p_pmid text, p_phone text, p_lookup text default null,
  p_kind text default 'text', p_body text default 'Mensagem fictícia', p_profile text default null,
  p_cipher text default null, p_version text default null, p_token text default null) returns jsonb language plpgsql as $f$
declare
  v jsonb;
begin
  execute 'set local role service_role';
  execute format(
    'select public.whatsapp_effect_inbound_message(%L::uuid, %L::uuid, %L, %L, %L, now(), %L, %L::jsonb, %L, %L, %L)',
    split_part(p_entry, '|', 1), coalesce(p_token, nullif(split_part(p_entry, '|', 2), '-')), p_pmid, p_kind, p_body,
    p_phone, p_lookup,
    case when p_lookup is null then null else coalesce(p_cipher, 'CQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQ==') end,
    case when p_lookup is null then null else coalesce(p_version, '1') end,
    p_profile) into v;
  execute 'reset role';
  return coalesce(v, 'null'::jsonb);
exception when others then
  return jsonb_build_object('erro', sqlerrm);
end
$f$;

create function pg_temp.res(p_entry text) returns text language sql as $f$
  select state || '|' || coalesce(claim_token::text, '-') from public.whatsapp_webhook_inbox where id = split_part(p_entry, '|', 1)::uuid
$f$;

-- Contagens do domínio (para provar "nada mudou").
create function pg_temp.dom() returns text language sql as $f$
  select concat_ws('|',
    (select count(*) from public.whatsapp_identities), (select count(*) from public.conversations),
    (select count(*) from public.messages), (select count(*) from public.contacts),
    (select count(*) from public.leads), (select count(*) from public.opportunities),
    (select count(*) from public.activities), (select count(*) from public.whatsapp_effect_ledger))
$f$;

-- ---------------------------------------------------------------------
-- 1) Estrutura e permissões
-- ---------------------------------------------------------------------

select is(
  pg_temp.txt($$select pg_get_function_identity_arguments('public.whatsapp_effect_inbound_message'::regproc)$$),
  'p_inbox_id uuid, p_claim_token uuid, p_provider_message_id text, p_content_kind text, p_body_text text, p_occurred_at timestamp with time zone, p_phone_e164 text, p_bsuid_lookup jsonb, p_bsuid_ciphertext text, p_bsuid_key_version text, p_profile_name text',
  'assinatura: inbox, token e só os dados do efeito — nenhum workspace, canal, ambiente, provedor ou evento do chamador'
);
select is(
  pg_temp.txt($$select (p.prosecdef and exists (select 1 from unnest(p.proconfig) c where c = 'search_path=""'))::text
    from pg_proc p where p.oid = 'public.whatsapp_effect_inbound_message'::regproc$$),
  'true', 'SECURITY DEFINER com search_path vazio'
);
select is(
  pg_temp.txt($$select has_function_privilege('service_role', 'public.whatsapp_effect_inbound_message'::regproc, 'execute')::text || ' '
    || has_function_privilege('authenticated', 'public.whatsapp_effect_inbound_message'::regproc, 'execute')::text || ' '
    || has_function_privilege('anon', 'public.whatsapp_effect_inbound_message'::regproc, 'execute')::text$$),
  'true false false', 'EXECUTE só para service_role'
);
select is(
  pg_temp.txt($$select count(*)::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'private' and p.proname in ('whatsapp_classify_inbound_sender', 'whatsapp_resolve_inbound_identity')
      and not has_function_privilege('service_role', p.oid, 'execute') and not has_function_privilege('authenticated', p.oid, 'execute')$$),
  '2', 'classificação e resolução de identidade: internas, sem EXECUTE para ninguém'
);

-- ---------------------------------------------------------------------
-- 2) Claim: estado, token, lease e ambiente
-- ---------------------------------------------------------------------

select pg_temp.entrada(:'ch_a', :'ws_um', 'b3d2b2a-a', 'evt-pend', false) as e_pend \gset
select pg_temp.entrada(:'ch_a', :'ws_um', 'b3d2b2a-a', 'evt-tok') as e_tok \gset
select pg_temp.entrada(:'ch_a', :'ws_um', 'b3d2b2a-a', 'evt-lease') as e_lease \gset
select pg_temp.dom() as dom0 \gset

select is(pg_temp.ap(:'e_pend', 'pm-pend', '+5511900006001') ->> 'outcome', 'claim_lost', 'entrada sem claim (pending): claim_lost');
select is(
  (pg_temp.ap(:'e_tok', 'pm-tok', '+5511900006001', p_token => :'inventado') ->> 'outcome') || ' ' ||
  (pg_temp.ap(split_part(:'e_tok', '|', 1) || '|-', 'pm-tok', '+5511900006001') ->> 'outcome'),
  'claim_lost claim_lost', 'token inventado ou ausente: claim_lost'
);
update public.whatsapp_webhook_inbox set claimed_at = clock_timestamp() - interval '10 minutes', lease_until = clock_timestamp() - interval '1 second'
where id = split_part(:'e_lease', '|', 1)::uuid;
select is(pg_temp.ap(:'e_lease', 'pm-lease', '+5511900006001') ->> 'outcome', 'claim_lost', 'lease vencida: claim_lost');
select set_config('request.headers', :'h_prod', true);
select is(pg_temp.ap(:'e_tok', 'pm-tok', '+5511900006001') ->> 'outcome', 'not_found', 'autenticado em outro ambiente: not_found');
select set_config('request.headers', '', true);
select is(pg_temp.ap(:'e_tok', 'pm-tok', '+5511900006001') ->> 'erro', 'whatsapp_environment_required', 'sem ambiente autenticado: recusado');
select set_config('request.headers', :'h_prev', true);
select is(pg_temp.ap(:'inventado' || '|' || :'inventado', 'pm-x', '+5511900006001') ->> 'outcome', 'not_found', 'inbox inexistente: not_found');
select is(
  pg_temp.dom() || ' ' || pg_temp.res(:'e_tok') || ' ' || pg_temp.res(:'e_pend'),
  :'dom0' || ' processing|' || split_part(:'e_tok', '|', 2) || ' pending|-',
  'nenhuma recusa escreveu nada nem mexeu na inbox'
);

-- ---------------------------------------------------------------------
-- 3) Entrada inválida: recusada antes de qualquer escrita
-- ---------------------------------------------------------------------

select is(
  concat_ws(' ',
    pg_temp.ap(:'e_tok', 'pm-v1', '+5511900006001', p_body => null) ->> 'erro',
    pg_temp.ap(:'e_tok', 'pm-v2', '+5511900006001', p_kind => 'holograma') ->> 'erro',
    pg_temp.ap(:'e_tok', 'pm v3', '+5511900006001') ->> 'erro',
    pg_temp.ap(:'e_tok', 'pm-v4', null) ->> 'erro',
    pg_temp.ap(:'e_tok', 'pm-v5', '11900006001') ->> 'erro'),
  'invalid_inbound_message invalid_inbound_message invalid_inbound_message invalid_inbound_message invalid_inbound_message',
  'texto sem corpo, tipo desconhecido, id com espaço, sem telefone nem BSUID, telefone fora do E.164: invalid_inbound_message'
);
select is(
  concat_ws(' ',
    pg_temp.ap(:'e_tok', 'pm-v6', null, '{"1": "AQID"}') ->> 'erro',
    pg_temp.ap(:'e_tok', 'pm-v7', null, format('{"2": "%s"}', :'bi1')) ->> 'erro',
    pg_temp.ap(:'e_tok', 'pm-v8', null, format('{"1": "%s"}', :'bi1'), p_cipher => 'AQID') ->> 'erro',
    pg_temp.ap(:'e_tok', 'pm-v9', '+5511900006001', p_profile => repeat('n', 161)) ->> 'erro'),
  'invalid_inbound_message invalid_inbound_message invalid_inbound_message invalid_inbound_message',
  'índice cego fora de 32 bytes, sem a versão ativa, cifra curta, nome longo: invalid_inbound_message'
);
select is(pg_temp.dom() || ' ' || pg_temp.res(:'e_tok'), :'dom0' || ' processing|' || split_part(:'e_tok', '|', 2), 'entrada inválida: nada escrito, claim intacto');

-- ---------------------------------------------------------------------
-- 4) Aplicação: contexto da inbox, ledger, mensagem, conversa, A7
-- ---------------------------------------------------------------------

select (select count(*) from public.contacts where workspace_id = :'ws_um'::uuid) as contatos0 \gset
select (select count(*) from public.leads where workspace_id = :'ws_um'::uuid) as leads0 \gset
select pg_temp.ap(:'e_tok', 'pm-1', '+5511900006001', p_profile => 'Pessoa Fictícia') as r1 \gset
select is(:'r1'::jsonb ->> 'outcome', 'applied', 'telefone novo, sem identidades internas: aplicado');
select is(
  pg_temp.txt(format($$select string_agg(k, ',' order by k) from jsonb_object_keys(%L::jsonb) k$$, :'r1')),
  'contact_created,conversation_id,lead_created,message_id,outcome,sender_classification',
  'resultado só com ids e indicadores — nenhum telefone, BSUID ou texto'
);
select is(
  pg_temp.txt(format($$select l.environment || '|' || (l.workspace_id = %L::uuid) || '|' || (l.channel_id = %L::uuid) || '|' || l.provider || '|' || l.provider_event_id || '|' || l.effect || '|' || (l.message_id = %L::uuid)
    from public.whatsapp_effect_ledger l where l.inbox_id = %L::uuid$$, :'ws_um', :'ch_a', :'r1'::jsonb ->> 'message_id', split_part(:'e_tok', '|', 1))),
  'preview|true|true|simulated|evt-tok|message.inbound|true', 'ledger: contexto copiado da inbox e a mensagem criada'
);
select is(
  pg_temp.txt(format($$select m.origin || '|' || m.sender_classification || '|' || m.content_kind || '|' || m.body_text || '|' || m.provider || '|' || m.provider_message_id || '|' || m.status || '|' || m.direction
    || '|' || (m.channel_id = %L::uuid) || '|' || (m.workspace_id = %L::uuid) || '|' || (m.sent_by is null)
    from public.messages m where m.id = %L::uuid$$, :'ch_a', :'ws_um', :'r1'::jsonb ->> 'message_id')),
  'inbound|external|text|Mensagem fictícia|simulated|pm-1|delivered|inbound|true|true|true', 'mensagem: inbound/external, provedor e id do provedor, sem autor'
);
select is(
  pg_temp.txt(format($$select c.wa_id || '|' || (i.phone_e164 = c.wa_id) || '|' || (i.bsuid_blind_index is null) || '|' || (c.last_message_at is not null) || '|' || (c.channel_id = %L::uuid)
    from public.conversations c join public.whatsapp_identities i on i.id = c.identity_id where c.id = %L::uuid$$, :'ch_a', :'r1'::jsonb ->> 'conversation_id')),
  '+5511900006001|true|true|true|true', 'conversa da identidade do telefone, no canal da inbox'
);
select is(
  pg_temp.txt(format($$select state || '|' || coalesce(claim_token::text, '-') || '|' || (processed_at is not null) || '|' || coalesce(disposition, '-') from public.whatsapp_webhook_inbox where id = %L::uuid$$, split_part(:'e_tok', '|', 1))),
  'processed|-|true|-', 'inbox finalizada como processed, sem disposição, na mesma transação'
);
select is(
  pg_temp.txt(format($$select (c.contact_id is not null) || '|' || (c.lead_id is not null) || '|' || (c.opportunity_id is not null) || '|' || c.needs_link_review
    || '|' || ct.name || '|' || (select string_agg(value_normalized || ':' || source, ',') from public.contact_phones where contact_id = c.contact_id)
    || '|' || (select string_agg(provider || ':' || external_id, ',') from public.contact_identifiers where contact_id = c.contact_id)
    || '|' || l.legal_area || '|' || o.status
    || '|' || (select count(*) from public.activities a where a.source_conversation_message_id = %L::uuid and a.source = 'whatsapp_inbound' and a.status = 'pending')
    from public.conversations c join public.contacts ct on ct.id = c.contact_id join public.leads l on l.id = c.lead_id join public.opportunities o on o.id = c.opportunity_id
    where c.id = %L::uuid$$, :'r1'::jsonb ->> 'message_id', :'r1'::jsonb ->> 'conversation_id')),
  'true|true|true|false|Pessoa Fictícia|+5511900006001:whatsapp_inbound|whatsapp:5511900006001|A definir|open|1',
  'inbound + external com telefone novo: contato, telefone, identificador, lead, oportunidade e atividade pelas regras da A7'
);
select is(
  (:'r1'::jsonb ->> 'contact_created') || ' ' || (:'r1'::jsonb ->> 'lead_created') || ' ' ||
  ((select count(*) from public.contacts where workspace_id = :'ws_um'::uuid) - :contatos0) || ' ' || ((select count(*) from public.leads where workspace_id = :'ws_um'::uuid) - :leads0),
  'true true 1 1', 'um contato e um lead criados, e o resultado diz isso'
);
select is(
  pg_temp.txt(format($$select (ct.created_by = %L::uuid) || '|' || (l.created_by = %L::uuid) || '|' || (o.created_by = %L::uuid) || '|' || (a.created_by = %L::uuid)
    from public.conversations c join public.contacts ct on ct.id = c.contact_id join public.leads l on l.id = c.lead_id
    join public.opportunities o on o.id = c.opportunity_id join public.activities a on a.source_conversation_message_id = %L::uuid
    where c.id = %L::uuid$$, :'ana', :'ana', :'ana', :'ana', :'r1'::jsonb ->> 'message_id', :'r1'::jsonb ->> 'conversation_id')),
  'true|true|true|true', 'sem usuário no webhook: autoria de quem configurou o canal'
);
select is(
  pg_temp.txt(format($$select string_agg(action || ':' || (actor_user_id is null), ',' order by action) || '|' || bool_and(metadata::text not like '%%5511900006001%%' and metadata::text not like '%%Fictícia%%')
    from public.audit_logs where workspace_id = %L::uuid
      and resource_id in (select contact_id from public.conversations where id = %L::uuid
        union select lead_id from public.conversations where id = %L::uuid
        union select opportunity_id from public.conversations where id = %L::uuid
        union select id from public.activities where source_conversation_message_id = %L::uuid
        union select %L::uuid)$$,
    :'ws_um', :'r1'::jsonb ->> 'conversation_id', :'r1'::jsonb ->> 'conversation_id', :'r1'::jsonb ->> 'conversation_id',
    :'r1'::jsonb ->> 'message_id', :'r1'::jsonb ->> 'message_id')),
  'activity.auto_created:true,contact.created:true,lead.created:true,message.received:true,opportunity.created:true|true',
  'auditoria das criações sem ator e sem telefone nem nome'
);
select pg_temp.dom() as dom1 \gset
select is(
  (pg_temp.ap(:'e_tok', 'pm-1', '+5511900006001') ->> 'outcome') || ' ' || pg_temp.dom(),
  'already_processed ' || :'dom1', 'reentrega da mesma entrada: already_processed, nada repetido'
);

-- ---------------------------------------------------------------------
-- 5) Identidade: matriz de resolução
-- ---------------------------------------------------------------------

create function pg_temp.ident(p_where text) returns text language plpgsql as $f$
declare
  v text;
begin
  execute format('select coalesce(phone_e164, ''-'') || ''|'' || coalesce(encode(bsuid_blind_index, ''base64''), ''-'') || ''|'' || coalesce(bsuid_key_version, ''-'')
    from public.whatsapp_identities where %s', p_where) into v;
  return coalesce(v, 'NULL');
end
$f$;

select pg_temp.entrada(:'ch_a', :'ws_um', 'b3d2b2a-a', 'evt-i1') as e_i1 \gset
select pg_temp.ap(:'e_i1', 'pm-i1', null, format('{"1": "%s"}', :'bi1')) as ri1 \gset
select is(
  (:'ri1'::jsonb ->> 'outcome') || ' ' || pg_temp.ident(format('channel_id = %L and bsuid_blind_index = decode(%L, ''base64'')', :'ch_a', :'bi1'))
  || ' ' || pg_temp.txt(format($$select coalesce(wa_id, '-') || '|' || (contact_id is null) || '|' || needs_link_review from public.conversations where id = %L::uuid$$, :'ri1'::jsonb ->> 'conversation_id'))
  || ' ' || (:'ri1'::jsonb ->> 'lead_created'),
  'applied -|' || :'bi1' || '|1 -|true|true false',
  'nenhum existe, só BSUID: identidade só com BSUID (índice e cifra), conversa sem telefone, sem contato nem lead, para revisão'
);
select is(
  pg_temp.txt(format($$select encode(bsuid_ciphertext, 'base64') from public.whatsapp_identities where channel_id = %L and bsuid_blind_index = decode(%L, 'base64')$$, :'ch_a', :'bi1')),
  :'ct', 'o BSUID é gravado só como índice cego e cifra produzidos no servidor'
);

select pg_temp.entrada(:'ch_a', :'ws_um', 'b3d2b2a-a', 'evt-i2') as e_i2 \gset
select pg_temp.ap(:'e_i2', 'pm-i2', '+5511900006003', format('{"1": "%s"}', :'bi2')) as ri2 \gset
select is(
  (:'ri2'::jsonb ->> 'outcome') || ' ' || pg_temp.ident(format('channel_id = %L and phone_e164 = ''+5511900006003''', :'ch_a'))
  || ' ' || pg_temp.txt(format($$select count(*)::text from public.whatsapp_identities where channel_id = %L and (phone_e164 = '+5511900006003' or bsuid_blind_index = decode(%L, 'base64'))$$, :'ch_a', :'bi2')),
  'applied +5511900006003|' || :'bi2' || '|1 1', 'nenhum existe, telefone e BSUID: uma identidade com os dois'
);

select pg_temp.dom() as dom2 \gset
select pg_temp.entrada(:'ch_a', :'ws_um', 'b3d2b2a-a', 'evt-i3') as e_i3 \gset
select pg_temp.ap(:'e_i3', 'pm-i3', '+5511900006001', format('{"1": "%s"}', :'bi3')) as ri3 \gset
select is(
  (:'ri3'::jsonb ->> 'outcome') || ' ' || pg_temp.ident(format('channel_id = %L and phone_e164 = ''+5511900006001''', :'ch_a'))
  || ' ' || ((:'ri3'::jsonb ->> 'conversation_id') = (:'r1'::jsonb ->> 'conversation_id'))::text
  || ' ' || split_part(pg_temp.dom(), '|', 1) || ' ' || (:'ri3'::jsonb ->> 'lead_created'),
  'applied +5511900006001|' || :'bi3' || '|1 true ' || split_part(:'dom2', '|', 1) || ' false',
  'só o telefone existe: reutiliza e acrescenta o BSUID; mesma conversa, nenhuma identidade nova, nenhum lead'
);

select pg_temp.entrada(:'ch_a', :'ws_um', 'b3d2b2a-a', 'evt-i4') as e_i4 \gset
select pg_temp.ap(:'e_i4', 'pm-i4', '+5511900006004', format('{"1": "%s"}', :'bi1')) as ri4 \gset
select is(
  (:'ri4'::jsonb ->> 'outcome') || ' ' || pg_temp.ident(format('channel_id = %L and bsuid_blind_index = decode(%L, ''base64'')', :'ch_a', :'bi1'))
  || ' ' || ((:'ri4'::jsonb ->> 'conversation_id') = (:'ri1'::jsonb ->> 'conversation_id'))::text
  || ' ' || pg_temp.txt(format($$select coalesce(wa_id, '-') from public.conversations where id = %L::uuid$$, :'ri1'::jsonb ->> 'conversation_id')),
  'applied +5511900006004|' || :'bi1' || '|1 true +5511900006004',
  'só o BSUID existe: reutiliza e acrescenta o telefone; a conversa passa a ter o telefone'
);

select pg_temp.entrada(:'ch_a', :'ws_um', 'b3d2b2a-a', 'evt-i5') as e_i5 \gset
select pg_temp.dom() as dom5 \gset
select pg_temp.ap(:'e_i5', 'pm-i5', '+5511900006003', format('{"1": "%s"}', :'bi2')) as ri5 \gset
select is(
  (:'ri5'::jsonb ->> 'outcome') || ' ' || ((:'ri5'::jsonb ->> 'conversation_id') = (:'ri2'::jsonb ->> 'conversation_id'))::text
  || ' ' || split_part(pg_temp.dom(), '|', 1) || ' ' || split_part(pg_temp.dom(), '|', 2),
  'applied true ' || split_part(:'dom5', '|', 1) || ' ' || split_part(:'dom5', '|', 2),
  'telefone e BSUID resolvem para a mesma identidade: reutiliza; nada novo além da mensagem'
);

-- Conflitos: nada escrito, a entrada continua em processing com o claim.
select pg_temp.entrada(:'ch_a', :'ws_um', 'b3d2b2a-a', 'evt-c1') as e_c1 \gset
select pg_temp.entrada(:'ch_a', :'ws_um', 'b3d2b2a-a', 'evt-c2') as e_c2 \gset
select pg_temp.entrada(:'ch_a', :'ws_um', 'b3d2b2a-a', 'evt-c3') as e_c3 \gset
select pg_temp.dom() as domc \gset
select is(
  pg_temp.ap(:'e_c1', 'pm-c1', '+5511900006001', format('{"1": "%s"}', :'bi2'))::text,
  '{"outcome": "identity_conflict"}', 'telefone e BSUID de identidades diferentes: identity_conflict, sem auto-merge'
);
select is(
  (pg_temp.ap(:'e_c2', 'pm-c2', '+5511900006001', format('{"1": "%s"}', :'bi4')) ->> 'outcome') || ' ' ||
  (pg_temp.ap(:'e_c3', 'pm-c3', '+5511900006005', format('{"1": "%s"}', :'bi2')) ->> 'outcome'),
  'identity_conflict identity_conflict', 'telefone conhecido com outro BSUID, ou BSUID conhecido com outro telefone: identity_conflict'
);
select is(
  pg_temp.dom() || ' ' || pg_temp.res(:'e_c1') || ' ' || pg_temp.res(:'e_c2') || ' ' || pg_temp.res(:'e_c3')
  || ' ' || pg_temp.ident(format('channel_id = %L and phone_e164 = ''+5511900006001''', :'ch_a')),
  :'domc' || ' processing|' || split_part(:'e_c1', '|', 2) || ' processing|' || split_part(:'e_c2', '|', 2) || ' processing|' || split_part(:'e_c3', '|', 2)
  || ' +5511900006001|' || :'bi3' || '|1',
  'conflito: nenhum ledger, identidade, conversa ou mensagem; identidades intactas; claim intacto'
);

-- Versão antiga da chave: o índice da versão 0 ainda encontra a identidade.
insert into public.whatsapp_identities (workspace_id, channel_id, environment, provider, bsuid_blind_index, bsuid_ciphertext, bsuid_key_version)
values (:'ws_um'::uuid, :'ch_a'::uuid, 'preview', 'simulated', decode(:'bi5', 'base64'), decode(:'ct', 'base64'), '0');
select pg_temp.entrada(:'ch_a', :'ws_um', 'b3d2b2a-a', 'evt-i6') as e_i6 \gset
select pg_temp.dom() as dom6 \gset
select pg_temp.ap(:'e_i6', 'pm-i6', null, format('{"0": "%s", "1": "%s"}', :'bi5', :'bi6')) as ri6 \gset
select is(
  (:'ri6'::jsonb ->> 'outcome') || ' ' || split_part(pg_temp.dom(), '|', 1) || ' ' || pg_temp.ident(format('channel_id = %L and bsuid_key_version = ''0''', :'ch_a')),
  'applied ' || split_part(:'dom6', '|', 1) || ' -|' || :'bi5' || '|0',
  'índice de uma versão anterior da chave encontra a identidade; nada é regravado'
);

-- ---------------------------------------------------------------------
-- 6) Classificação: identidades internas ativas, nunca o texto
-- ---------------------------------------------------------------------

insert into public.whatsapp_internal_identities (workspace_id, channel_id, environment, provider, label, phone_e164, bsuid_blind_index, bsuid_ciphertext, bsuid_key_version, is_active, created_by) values
  (:'ws_um'::uuid, :'ch_i'::uuid, 'preview', 'simulated', 'Advogado (fictício)', '+5511900007010', null, null, null, true, :'ana'::uuid),
  (:'ws_um'::uuid, :'ch_i'::uuid, 'preview', 'simulated', 'Aparelho do escritório (fictício)', null, decode(:'bi7', 'base64'), decode(:'ct', 'base64'), '1', true, :'ana'::uuid),
  (:'ws_um'::uuid, :'ch_i'::uuid, 'preview', 'simulated', 'Ex-estagiário (fictício)', '+5511900007011', null, null, null, false, :'ana'::uuid);

create function pg_temp.cls(p_evt text, p_pmid text, p_phone text, p_lookup text default null, p_body text default 'Mensagem fictícia',
  p_profile text default null, p_ch text default '39000000-0000-0000-0000-000000000002', p_routing text default 'b3d2b2a-i')
returns text language plpgsql as $f$
declare
  v_entry text := pg_temp.entrada(p_ch, '10000000-0000-0000-0000-000000000001', p_routing, p_evt);
  v_contacts bigint := (select count(*) from public.contacts);
  v_leads bigint := (select count(*) from public.leads);
  v jsonb;
begin
  v := pg_temp.ap(v_entry, p_pmid, p_phone, p_lookup, 'text', p_body, p_profile);
  return concat_ws('|', coalesce(v ->> 'outcome', v ->> 'erro'), v ->> 'sender_classification', v ->> 'contact_created', v ->> 'lead_created',
    (select count(*) from public.contacts) - v_contacts, (select count(*) from public.leads) - v_leads,
    (select m.sender_classification::text from public.messages m where m.id = (v ->> 'message_id')::uuid),
    (select (c.contact_id is null) || ':' || c.needs_link_review from public.conversations c where c.id = (v ->> 'conversation_id')::uuid));
end
$f$;

select is(pg_temp.cls('evt-k1', 'pm-k1', '+5511900007010'), 'applied|internal|false|false|0|0|internal|true:false',
  'telefone de identidade interna ativa: inbound/internal; nenhum contato ou lead; conversa sem revisão');
select is(pg_temp.cls('evt-k2', 'pm-k2', null, format('{"1": "%s"}', :'bi7')), 'applied|internal|false|false|0|0|internal|true:false',
  'BSUID de identidade interna ativa: inbound/internal');
select is(pg_temp.cls('evt-k3', 'pm-k3', '+5511900007012'), 'applied|unresolved|false|false|0|0|unresolved|true:true',
  'só telefone, e uma identidade interna só com BSUID (incomparável): unresolved; nenhum contato ou lead; para revisão');
select is(pg_temp.cls('evt-k4', 'pm-k4', '+5511900007013', null, 'Sou o advogado do escritório, uso interno', 'Advogado (interno)'),
  'applied|unresolved|false|false|0|0|unresolved|true:true',
  'texto e nome de perfil "internos" não mudam nada: continua unresolved');
select is(pg_temp.cls('evt-k5', 'pm-k5', '+5511900007011', format('{"1": "%s"}', :'bi8')), 'applied|external|true|true|1|1|external|false:false',
  'comparável com todas as ativas e sem casamento (a inativa não conta): inbound/external, contato e lead pela A7');
select is(pg_temp.cls('evt-k6', 'pm-k6', '+5511900007010', null, 'Mensagem fictícia', null, :'ch_a', 'b3d2b2a-a'), 'applied|external|true|true|1|1|external|false:false',
  'a identidade interna de outro canal não vale aqui');
select is(
  pg_temp.txt($$select count(*)::text from public.messages m join public.conversations c on c.id = m.conversation_id
    where m.sender_classification in ('internal', 'unresolved') and m.provider = 'simulated' and (c.lead_id is not null or c.contact_id is not null)$$),
  '0', 'nenhuma mensagem internal ou unresolved deu origem a contato ou lead'
);

-- ---------------------------------------------------------------------
-- 6b) Canal sem identidade interna ativa: nunca vira cliente sozinho
-- ---------------------------------------------------------------------

select pg_temp.dom() as domz \gset
select is(
  pg_temp.cls('evt-z1', 'pm-z1', '+5511900010001', null, 'Mensagem fictícia', null, :'ch_z', 'b3d2b2a-z')
  || ' ' || ((split_part(pg_temp.dom(), '|', 2)::int - split_part(:'domz', '|', 2)::int) || ',' || (split_part(pg_temp.dom(), '|', 3)::int - split_part(:'domz', '|', 3)::int))
  || ' ' || (split_part(pg_temp.dom(), '|', 4) || split_part(pg_temp.dom(), '|', 5) || split_part(pg_temp.dom(), '|', 6) || split_part(pg_temp.dom(), '|', 7)
             = split_part(:'domz', '|', 4) || split_part(:'domz', '|', 5) || split_part(:'domz', '|', 6) || split_part(:'domz', '|', 7))::text,
  'applied|unresolved|false|false|0|0|unresolved|true:true 1,1 true',
  'nenhuma identidade interna ativa: unresolved; conversa e mensagem gravadas, para revisão; nenhum contato, lead, oportunidade ou atividade'
);
insert into public.whatsapp_internal_identities (workspace_id, channel_id, environment, provider, label, phone_e164, is_active, created_by)
values (:'ws_um'::uuid, :'ch_z'::uuid, 'preview', 'simulated', 'Antigo (fictício)', '+5511900010098', false, :'bruno'::uuid);
select is(pg_temp.cls('evt-z2', 'pm-z2', '+5511900010002', null, 'Mensagem fictícia', null, :'ch_z', 'b3d2b2a-z'),
  'applied|unresolved|false|false|0|0|unresolved|true:true', 'só identidade interna desativada: não conta como configuração; continua unresolved');
insert into public.whatsapp_internal_identities (workspace_id, channel_id, environment, provider, label, phone_e164, is_active, created_by)
values (:'ws_um'::uuid, :'ch_z'::uuid, 'preview', 'simulated', 'Advogado (fictício)', '+5511900010099', true, :'bruno'::uuid);
select is(pg_temp.cls('evt-z3', 'pm-z3', '+5511900010003', null, 'Mensagem fictícia', null, :'ch_z', 'b3d2b2a-z'),
  'applied|external|true|true|1|1|external|false:false', 'primeira identidade interna ativa + outro telefone comparável: external, com criação comercial');
select is(pg_temp.cls('evt-z4', 'pm-z4', '+5511900010099', null, 'Mensagem fictícia', null, :'ch_z', 'b3d2b2a-z'),
  'applied|internal|false|false|0|0|internal|true:false', 'telefone da identidade interna: internal, sem criação comercial');
select is(pg_temp.cls('evt-z5', 'pm-z5', null, format('{"1": "%s"}', :'bi4'), 'Mensagem fictícia', null, :'ch_z', 'b3d2b2a-z'),
  'applied|unresolved|false|false|0|0|unresolved|true:true', 'identidade interna ativa só com telefone, remetente só com BSUID: unresolved');

-- Autoria técnica: o responsável que configurou o canal, nunca um ator.
select pg_temp.txt($$select conversation_id::text from public.messages where provider_message_id = 'pm-z3'$$) as conv_z3 \gset
select is(
  pg_temp.txt(format($$select (ct.created_by = %L::uuid) || '|' || (l.created_by = %L::uuid) || '|' || (o.created_by = %L::uuid) || '|' || (a.created_by = %L::uuid) || '|' || (ct.created_by <> %L::uuid)
    from public.conversations c join public.contacts ct on ct.id = c.contact_id join public.leads l on l.id = c.lead_id
    join public.opportunities o on o.id = c.opportunity_id join public.activities a on a.opportunity_id = o.id and a.source = 'whatsapp_inbound'
    where c.id = %L::uuid$$, :'bruno', :'bruno', :'bruno', :'bruno', :'ana', :'conv_z3')),
  'true|true|true|true|true', 'contato, lead, oportunidade e atividade com o created_by do canal (Bruno), não de outro usuário'
);
select is(
  pg_temp.txt(format($$select string_agg(action || ':' || (actor_user_id is null) || ':' || coalesce(metadata ->> 'source', '-'), ',' order by action)
    from public.audit_logs where resource_id in (
      select contact_id from public.conversations where id = %L::uuid union select lead_id from public.conversations where id = %L::uuid
      union select opportunity_id from public.conversations where id = %L::uuid
      union select a.id from public.activities a join public.conversations c on c.opportunity_id = a.opportunity_id where c.id = %L::uuid)$$,
    :'conv_z3', :'conv_z3', :'conv_z3', :'conv_z3')),
  'activity.auto_created:true:whatsapp_inbound,contact.created:true:whatsapp_inbound,lead.created:true:whatsapp_inbound,opportunity.created:true:whatsapp_inbound',
  'auditoria sem ator humano e com a origem automática whatsapp_inbound'
);

-- ---------------------------------------------------------------------
-- 7) Idempotência e conflito de efeito
-- ---------------------------------------------------------------------

select pg_temp.entrada(:'ch_a', :'ws_um', 'b3d2b2a-a', 'evt-d1') as e_d1 \gset
select pg_temp.entrada(:'ch_a', :'ws_um', 'b3d2b2a-a', 'evt-d2') as e_d2 \gset
select pg_temp.entrada(:'ch_a', :'ws_um', 'b3d2b2a-a', 'evt-d3') as e_d3 \gset
insert into public.whatsapp_effect_ledger (environment, workspace_id, channel_id, provider, provider_event_id, effect, inbox_id)
values ('preview', :'ws_um'::uuid, :'ch_a'::uuid, 'simulated', 'evt-d1', 'message.status', split_part(:'e_d1', '|', 1)::uuid),
       ('preview', :'ws_um'::uuid, :'ch_a'::uuid, 'simulated', 'evt-d2', 'message.inbound', split_part(:'e_d2', '|', 1)::uuid);
select pg_temp.dom() as domd \gset
select is(
  pg_temp.ap(:'e_d1', 'pm-d1', '+5511900006001')::text || ' ' || pg_temp.dom() || ' ' || pg_temp.res(:'e_d1'),
  '{"outcome": "effect_conflict"}' || ' ' || :'domd' || ' processing|' || split_part(:'e_d1', '|', 2),
  'a chave estável já tem outro efeito: effect_conflict, nada escrito, claim intacto'
);
select is(
  (pg_temp.ap(:'e_d2', 'pm-d2', '+5511900006001') ->> 'outcome') || ' ' || pg_temp.dom() || ' ' || pg_temp.res(:'e_d2'),
  'duplicate ' || :'domd' || ' processed|-',
  'o mesmo efeito já reservado para a entrada: duplicate, nada repetido, entrada finalizada'
);
select pg_temp.ap(:'e_d3', 'pm-1', '+5511900006001') as rd3 \gset
select is(
  (:'rd3'::jsonb ->> 'outcome') || ' ' || split_part(pg_temp.dom(), '|', 3) || ' ' || pg_temp.res(:'e_d3') || ' '
  || pg_temp.txt(format($$select (message_id = %L::uuid)::text from public.whatsapp_effect_ledger where inbox_id = %L::uuid$$, :'r1'::jsonb ->> 'message_id', split_part(:'e_d3', '|', 1))),
  'duplicate ' || split_part(:'domd', '|', 3) || ' processed|- true',
  'outro evento com o mesmo id de mensagem do provedor: duplicate, uma mensagem só, ledger aponta para ela'
);

-- ---------------------------------------------------------------------
-- 8) Mídia sem texto (nada baixado)
-- ---------------------------------------------------------------------

select pg_temp.entrada(:'ch_a', :'ws_um', 'b3d2b2a-a', 'evt-m1') as e_m1 \gset
select pg_temp.entrada(:'ch_a', :'ws_um', 'b3d2b2a-a', 'evt-m2') as e_m2 \gset
select pg_temp.ap(:'e_m1', 'pm-m1', '+5511900006001', null, 'image', null) as rm1 \gset
select pg_temp.ap(:'e_m2', 'pm-m2', '+5511900006001', null, 'document', 'Contrato (legenda fictícia)') as rm2 \gset
select is(
  pg_temp.txt(format($$select string_agg(content_kind || ':' || coalesce(body_text, '-'), ',' order by provider_message_id desc) from public.messages where id in (%L::uuid, %L::uuid)$$,
    :'rm1'::jsonb ->> 'message_id', :'rm2'::jsonb ->> 'message_id')),
  'document:Contrato (legenda fictícia),image:-', 'mídia sem texto e com legenda: aceitas, sem arquivo'
);

-- ---------------------------------------------------------------------
-- 9) Atomicidade: falha depois da reserva desfaz tudo
-- ---------------------------------------------------------------------

create function public.t36_falha_simulada() returns trigger language plpgsql as $f$
begin
  if new.provider_message_id = 'pm-falha' then
    raise exception 'falha_simulada';
  end if;
  return new;
end
$f$;
create trigger t36_falha_simulada before insert on public.messages for each row execute function public.t36_falha_simulada();

select pg_temp.entrada(:'ch_a', :'ws_um', 'b3d2b2a-a', 'evt-f1') as e_f1 \gset
select pg_temp.dom() as domf \gset
select is(
  (pg_temp.ap(:'e_f1', 'pm-falha', '+5511900006020', format('{"1": "%s"}', :'bi8')) ->> 'erro') || ' ' || pg_temp.dom() || ' ' || pg_temp.res(:'e_f1')
  || ' ' || pg_temp.txt($$select count(*)::text from public.whatsapp_identities where phone_e164 = '+5511900006020'$$),
  'falha_simulada ' || :'domf' || ' processing|' || split_part(:'e_f1', '|', 2) || ' 0',
  'falha ao gravar a mensagem, depois do ledger e da identidade: nada sobrevive e o claim continua'
);
drop trigger t36_falha_simulada on public.messages;
select is(
  pg_temp.ap(:'e_f1', 'pm-depois', '+5511900006020', format('{"1": "%s"}', :'bi8')) ->> 'outcome',
  'applied', 'sem a falha, a mesma entrada aplica normalmente'
);

-- ---------------------------------------------------------------------
-- 10) Isolamento: outro workspace e Production
-- ---------------------------------------------------------------------

select pg_temp.entrada(:'ch_b', :'ws_dois', 'b3d2b2a-b', 'evt-tok') as e_b \gset
select pg_temp.ap(:'e_b', 'pm-1', '+5511900006001') as rb \gset
select is(
  (:'rb'::jsonb ->> 'outcome') || ' ' || pg_temp.txt($$select count(distinct workspace_id)::text || '|' || count(*) from public.whatsapp_identities where phone_e164 = '+5511900006001'$$)
  || ' ' || pg_temp.txt(format($$select (workspace_id = %L::uuid)::text from public.contacts where id = (select contact_id from public.conversations where id = %L::uuid)$$, :'ws_dois', :'rb'::jsonb ->> 'conversation_id')),
  'applied 2|2 true', 'mesmo telefone, mesmo id de evento e de mensagem em outro workspace: outra identidade, outro contato, sem colisão'
);
select set_config('request.headers', :'h_prod', true);
select pg_temp.entrada(:'ch_prod', :'ws_um', 'b3d2b2a-prod', 'evt-tok') as e_p \gset
select pg_temp.ap(:'e_p', 'pm-1', '+5511900006001') as rp \gset
select is(
  (:'rp'::jsonb ->> 'outcome') || ' ' || pg_temp.txt(format($$select i.environment::text from public.whatsapp_identities i join public.conversations c on c.identity_id = i.id where c.id = %L::uuid$$, :'rp'::jsonb ->> 'conversation_id')),
  'applied production', 'Production: identidade e efeito no próprio ambiente'
);
select set_config('request.headers', :'h_prev', true);
select is(pg_temp.ap(:'e_p', 'pm-1', '+5511900006001') ->> 'outcome', 'not_found', 'a entrada de Production não é alcançada a partir de Preview');

-- ---------------------------------------------------------------------
-- 11) A7: leituras e permissões
-- ---------------------------------------------------------------------

select pg_temp.txt($$select conversation_id::text from public.messages where provider_message_id = 'pm-k2'$$) as conv_k2 \gset
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'ana', 'role', 'authenticated')::text, true);
select is(
  pg_temp.txt(format($$select (get_conversation(%L::uuid) ->> 'wa_id') || '|' || (select jsonb_array_length(items) from list_conversation_messages(%L::uuid, null, 30, null))
    || '|' || (select count(*) from list_conversations(%L::uuid, 1, 100) lc, jsonb_array_elements(lc.items) e where e ->> 'id' = %L)$$,
    :'r1'::jsonb ->> 'conversation_id', :'r1'::jsonb ->> 'conversation_id', :'ws_um', :'r1'::jsonb ->> 'conversation_id')),
  '+5511900006001|4|1', 'leituras da A7 mostram a conversa e as mensagens aplicadas'
);
select is(
  pg_temp.txt(format($$select coalesce(get_conversation(%L::uuid) ->> 'wa_id', 'sem telefone')$$, :'conv_k2')),
  'sem telefone', 'conversa só com BSUID: a A7 lê, sem telefone'
);
select is(
  pg_temp.txt(format($$select public.whatsapp_effect_inbound_message(%L::uuid, %L::uuid, 'pm-x', 'text', 'x', now(), '+5511900006001', null, null, null, null)::text$$, :'inventado', :'inventado')) like 'ERRO:42501%',
  true, 'authenticated não executa o efeito, nem como owner'
);
reset role;

select * from finish();
rollback;
