-- pgTAP — B3.2d-2b2b1: efeito atômico de mensagem de SAÍDA OBSERVADA (eco
-- do WhatsApp Business App).
--
-- public.whatsapp_effect_outbound_observed, numa transação só e sob a
-- trava da inbox:
--  - inbox no ambiente autenticado, em processing, com o token do claim e
--    a lease vigente; canal da linha ainda ativo; workspace, canal,
--    ambiente, provedor e evento vêm da linha da inbox, nunca do chamador;
--  - reserva message.outbound_observed no ledger;
--  - a mesma mensagem (id do provedor ou wamid) converge; ids de mensagens
--    diferentes → message_conflict sem alterar nada;
--  - identidade do destinatário por telefone e BSUID com as garantias da
--    2b2a (identity_conflict, sem auto-merge);
--  - conversa reutilizada ou criada; vínculo só exato e único; ambiguidade
--    ou desconhecido → revisão; NUNCA cria contato, lead, oportunidade ou
--    atividade;
--  - mensagem outbound / business_app / internal, sem autor;
--  - inbox processed junto com o efeito; qualquer falha desfaz tudo.
--
-- Seções 8b e 8c (destinatário conferido na convergência; limite do wamid
-- igual ao do normalizador): escritas antes da correção, contra 650b48a.
--
-- Escrito ANTES da implementação, contra a main 740f0f8. Tudo fictício:
-- nenhum telefone, BSUID ou identidade real. As chamadas passam por
-- funções que capturam o erro: contra a main, o arquivo roda até o fim.

begin;
select plan(62);

\set ana     '20000000-0000-0000-0000-000000000001'
\set ws_um   '10000000-0000-0000-0000-000000000001'
\set ws_dois '10000000-0000-0000-0000-000000000002'
\set ch_o    '3e000000-0000-0000-0000-000000000001'
\set ch_b    '3e000000-0000-0000-0000-000000000002'
\set ch_prod '3e000000-0000-0000-0000-000000000003'
\set ch_s    '3e000000-0000-0000-0000-000000000004'
\set inventado '7d1e2f3a-4b5c-4d6e-8f70-819a2b3c4d5f'
\set cifra   'QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFB'
\set bi1     'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE='
\set bi2     'AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI='
\set bi3     'AwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwM='
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

-- Canais da B3 (simulados): O e S no Escritório Um, B no Escritório Dois e
-- um de Production no Escritório Um. Nenhuma identidade interna: a saída
-- do aplicativo é interna pela origem, nunca pelo cadastro.
set local role service_role;
select whatsapp_create_simulated_channel(:'ch_o'::uuid, :'ws_um'::uuid, :'ana'::uuid, 'O', 'b3d2b2b1-o', '1', :'cifra', '1') is not null as ok \gset
select whatsapp_create_simulated_channel(:'ch_s'::uuid, :'ws_um'::uuid, :'ana'::uuid, 'S', 'b3d2b2b1-s', '1', :'cifra', '1') is not null as ok \gset
select whatsapp_create_simulated_channel(:'ch_b'::uuid, :'ws_dois'::uuid, '20000000-0000-0000-0000-000000000002'::uuid, 'B', 'b3d2b2b1-b', '1', :'cifra', '1') is not null as ok \gset
select set_config('request.headers', :'h_prod', true);
select whatsapp_create_simulated_channel(:'ch_prod'::uuid, :'ws_um'::uuid, :'ana'::uuid, 'Prod', 'b3d2b2b1-prod', '1', :'cifra', '1') is not null as ok \gset
select set_config('request.headers', :'h_prev', true);
reset role;

-- Entrada da inbox (cifra fictícia) e claim, como service_role: devolve
-- 'id|token'.
create function pg_temp.entrada(p_ch text, p_ws text, p_routing text, p_evt text,
  p_type text default 'whatsapp.smb.message.echoes', p_claim boolean default true) returns text language plpgsql as $f$
declare
  v_id text;
  v_token text;
begin
  execute 'set local role service_role';
  v_id := public.whatsapp_inbox_store(p_ch::uuid, p_ws::uuid, 'simulated', p_routing, p_evt, p_type,
    repeat('a', 64), '1', 'AAAAAAAAAAAAAAAA', 'Q29ycG8gZmljdGljaW8=', 'AAAAAAAAAAAAAAAAAAAAAA==', 3600) ->> 'inbox_id';
  if p_claim then
    v_token := public.whatsapp_inbox_claim(v_id::uuid, 300) ->> 'claim_token';
  end if;
  execute 'reset role';
  return v_id || '|' || coalesce(v_token, '-');
end
$f$;

-- Entrada já no canal O (atalho).
create function pg_temp.eo(p_evt text, p_type text default 'whatsapp.smb.message.echoes') returns text language sql as $f$
  select pg_temp.entrada('3e000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'b3d2b2b1-o', p_evt, p_type)
$f$;

-- Chamada do efeito como service_role: o jsonb devolvido, ou
-- {"erro": <mensagem>}.
create function pg_temp.ob(p_entry text, p_pmid text, p_wamid text, p_phone text, p_lookup text default null,
  p_kind text default 'text', p_body text default 'Mensagem fictícia do escritório',
  p_cipher text default null, p_version text default null, p_token text default null) returns jsonb language plpgsql as $f$
declare
  v jsonb;
begin
  execute 'set local role service_role';
  execute format(
    'select public.whatsapp_effect_outbound_observed(%L::uuid, %L::uuid, %L, %L, %L, %L, now(), %L, %L::jsonb, %L, %L)',
    split_part(p_entry, '|', 1), coalesce(p_token, nullif(split_part(p_entry, '|', 2), '-')), p_pmid, p_wamid, p_kind, p_body,
    p_phone, p_lookup,
    case when p_lookup is null then null else coalesce(p_cipher, 'CQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQ==') end,
    case when p_lookup is null then null else coalesce(p_version, '1') end) into v;
  execute 'reset role';
  return coalesce(v, 'null'::jsonb);
exception when others then
  return jsonb_build_object('erro', sqlerrm);
end
$f$;

-- Efeito de mensagem RECEBIDA da 2b2a (para conversas já existentes).
create function pg_temp.ap(p_entry text, p_pmid text, p_phone text) returns jsonb language plpgsql as $f$
declare
  v jsonb;
begin
  execute 'set local role service_role';
  execute format('select public.whatsapp_effect_inbound_message(%L::uuid, %L::uuid, %L, ''text'', ''Mensagem fictícia recebida'', now(), %L, null, null, null, null)',
    split_part(p_entry, '|', 1), split_part(p_entry, '|', 2), p_pmid, p_phone) into v;
  execute 'reset role';
  return v;
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

-- Retrato de todos os registros comerciais (linhas inteiras): prova que
-- nada foi criado nem alterado.
create function pg_temp.com() returns text language sql as $f$
  select md5(concat_ws('#',
    (select string_agg(x::text, ',' order by x::text) from public.contacts x),
    (select string_agg(x::text, ',' order by x::text) from public.contact_phones x),
    (select string_agg(x::text, ',' order by x::text) from public.contact_identifiers x),
    (select string_agg(x::text, ',' order by x::text) from public.leads x),
    (select string_agg(x::text, ',' order by x::text) from public.opportunities x),
    (select string_agg(x::text, ',' order by x::text) from public.activities x)))
$f$;

-- Vínculos da conversa: contato|lead|oportunidade|revisão|candidatos.
create function pg_temp.vinc(p_conv text) returns text language sql as $f$
  select coalesce((select concat_ws('|', coalesce(c.contact_id::text, '-'), coalesce(c.lead_id::text, '-'), coalesce(c.opportunity_id::text, '-'),
         c.needs_link_review::text, cardinality(c.link_candidate_contact_ids) + cardinality(c.link_candidate_lead_ids))
       from public.conversations c where c.id = p_conv::uuid), 'NULL')
$f$;

-- A mensagem gravada, campo a campo.
create function pg_temp.msg(p_id text) returns text language sql as $f$
  select coalesce((select concat_ws('|', m.direction, m.origin, m.sender_classification, (m.sent_by is null)::text, m.status, m.content_kind,
         coalesce(m.body_text, '-'), coalesce(m.provider::text, '-'), coalesce(m.provider_message_id, '-'), coalesce(m.wa_message_id, '-'),
         (m.client_dedupe_key is null)::text, coalesce(m.origin_correlation_kind, '-'))
       from public.messages m where m.id = p_id::uuid), 'NULL')
$f$;

select pg_temp.com() as com0 \gset

-- ---------------------------------------------------------------------
-- 1) Estrutura e permissões
-- ---------------------------------------------------------------------

select is(
  pg_temp.txt($$select pg_get_function_identity_arguments('public.whatsapp_effect_outbound_observed'::regproc)$$),
  'p_inbox_id uuid, p_claim_token uuid, p_provider_message_id text, p_wa_message_id text, p_content_kind text, p_body_text text, p_occurred_at timestamp with time zone, p_phone_e164 text, p_bsuid_lookup jsonb, p_bsuid_ciphertext text, p_bsuid_key_version text',
  'assinatura: inbox, token e só os dados do eco — nenhum workspace, canal, ambiente, provedor, evento, origem ou autor do chamador'
);
select is(
  pg_temp.txt($$select (p.prosecdef and exists (select 1 from unnest(p.proconfig) c where c = 'search_path=""'))::text
    from pg_proc p where p.oid = 'public.whatsapp_effect_outbound_observed'::regproc$$),
  'true', 'SECURITY DEFINER com search_path vazio'
);
select is(
  pg_temp.txt($$select has_function_privilege('service_role', 'public.whatsapp_effect_outbound_observed'::regproc, 'execute')::text || ' '
    || has_function_privilege('authenticated', 'public.whatsapp_effect_outbound_observed'::regproc, 'execute')::text || ' '
    || has_function_privilege('anon', 'public.whatsapp_effect_outbound_observed'::regproc, 'execute')::text$$),
  'true false false', 'EXECUTE só para service_role'
);

-- ---------------------------------------------------------------------
-- 2) Claim: estado, token, lease e ambiente
-- ---------------------------------------------------------------------

select pg_temp.entrada(:'ch_o', :'ws_um', 'b3d2b2b1-o', 'evt-pend', 'whatsapp.smb.message.echoes', false) as e_pend \gset
select pg_temp.eo('evt-tok') as e_tok \gset
select pg_temp.eo('evt-lease') as e_lease \gset
select pg_temp.dom() as dom0 \gset

select is(pg_temp.ob(:'e_pend', 'pm-pend', null, '+5511900020001') ->> 'outcome', 'claim_lost', 'entrada sem claim (pending): claim_lost');
select is(
  (pg_temp.ob(:'e_tok', 'pm-tok', null, '+5511900020001', p_token => :'inventado') ->> 'outcome') || ' ' ||
  (pg_temp.ob(split_part(:'e_tok', '|', 1) || '|-', 'pm-tok', null, '+5511900020001') ->> 'outcome'),
  'claim_lost claim_lost', 'token inventado ou ausente: claim_lost'
);
update public.whatsapp_webhook_inbox set claimed_at = clock_timestamp() - interval '10 minutes', lease_until = clock_timestamp() - interval '1 second'
where id = split_part(:'e_lease', '|', 1)::uuid;
select is(pg_temp.ob(:'e_lease', 'pm-lease', null, '+5511900020001') ->> 'outcome', 'claim_lost', 'lease vencida: claim_lost');
select set_config('request.headers', :'h_prod', true);
select is(pg_temp.ob(:'e_tok', 'pm-tok', null, '+5511900020001') ->> 'outcome', 'not_found', 'autenticado em outro ambiente: not_found');
select set_config('request.headers', '', true);
select is(pg_temp.ob(:'e_tok', 'pm-tok', null, '+5511900020001') ->> 'erro', 'whatsapp_environment_required', 'sem ambiente autenticado: recusado');
select set_config('request.headers', :'h_prev', true);
select is(pg_temp.ob(:'inventado' || '|' || :'inventado', 'pm-x', null, '+5511900020001') ->> 'outcome', 'not_found', 'inbox inexistente: not_found');
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
    pg_temp.ob(:'e_tok', 'pm-v1', null, '+5511900020001', p_body => null) ->> 'erro',
    pg_temp.ob(:'e_tok', 'pm-v2', null, '+5511900020001', p_kind => 'holograma') ->> 'erro',
    pg_temp.ob(:'e_tok', 'pm v3', null, '+5511900020001') ->> 'erro',
    pg_temp.ob(:'e_tok', 'pm-v4', null, null) ->> 'erro',
    pg_temp.ob(:'e_tok', 'pm-v5', null, '11900020001') ->> 'erro'),
  'invalid_outbound_message invalid_outbound_message invalid_outbound_message invalid_outbound_message invalid_outbound_message',
  'texto sem corpo, tipo desconhecido, id com espaço, sem telefone nem BSUID, telefone fora do E.164: invalid_outbound_message'
);
select is(
  concat_ws(' ',
    pg_temp.ob(:'e_tok', 'pm-v6', 'HBgNsemprefixo', '+5511900020001') ->> 'erro',
    pg_temp.ob(:'e_tok', 'pm-v7', 'wamid.' || repeat('A', 513), '+5511900020001') ->> 'erro',
    pg_temp.ob(:'e_tok', 'pm-v8', null, null, '{"1": "AQID"}') ->> 'erro',
    pg_temp.ob(:'e_tok', 'pm-v9', null, null, format('{"2": "%s"}', :'bi1')) ->> 'erro'),
  'invalid_outbound_message invalid_outbound_message invalid_outbound_message invalid_outbound_message',
  'wamid sem prefixo ou com mais de 518 caracteres, índice cego fora de 32 bytes, sem a versão ativa: invalid_outbound_message'
);
select is(pg_temp.dom() || ' ' || pg_temp.res(:'e_tok'), :'dom0' || ' processing|' || split_part(:'e_tok', '|', 2), 'entrada inválida: nada escrito, claim intacto');

-- ---------------------------------------------------------------------
-- 4) Primeira mensagem observada, destinatário desconhecido
-- ---------------------------------------------------------------------

select pg_temp.ob(:'e_tok', 'pm-1', 'wamid.FICTICIO1', '+5511900020001') as r1 \gset
select is(:'r1'::jsonb ->> 'outcome', 'applied', 'primeira mensagem observada: aplicada');
select is(
  pg_temp.txt(format($$select string_agg(k, ',' order by k) from jsonb_object_keys(%L::jsonb) k$$, :'r1')),
  'conversation_id,message_id,outcome',
  'resultado só com ids — nenhum telefone, BSUID, texto ou indicador comercial'
);
select is(
  pg_temp.msg(:'r1'::jsonb ->> 'message_id'),
  'outbound|business_app|internal|true|sent|text|Mensagem fictícia do escritório|simulated|pm-1|wamid.FICTICIO1|true|-',
  'mensagem: outbound, business_app, internal, sem autor, sem chave de reenvio nem correlação, com o id do provedor e o wamid'
);
select is(
  pg_temp.txt(format($$select l.environment || '|' || (l.workspace_id = %L::uuid) || '|' || (l.channel_id = %L::uuid) || '|' || l.provider || '|' || l.provider_event_id || '|' || l.effect || '|' || (l.message_id = %L::uuid)
    from public.whatsapp_effect_ledger l where l.inbox_id = %L::uuid$$, :'ws_um', :'ch_o', :'r1'::jsonb ->> 'message_id', split_part(:'e_tok', '|', 1))),
  'preview|true|true|simulated|evt-tok|message.outbound_observed|true', 'ledger: contexto copiado da inbox e a mensagem criada'
);
select is(
  pg_temp.vinc(:'r1'::jsonb ->> 'conversation_id') || ' '
  || pg_temp.txt(format($$select c.wa_id || '|' || (c.channel_id = %L::uuid) || '|' || (i.phone_e164 = c.wa_id) || '|' || (c.last_message_at is not null)
    from public.conversations c join public.whatsapp_identities i on i.id = c.identity_id where c.id = %L::uuid$$, :'ch_o', :'r1'::jsonb ->> 'conversation_id'))
  || ' ' || pg_temp.res(:'e_tok') || ' ' || (pg_temp.com() = :'com0')::text,
  '-|-|-|true|0 +5511900020001|true|true|true processed|- true',
  'destinatário desconhecido: conversa nova para revisão, sem contato; inbox processed; nenhum registro comercial criado'
);
select is(
  pg_temp.txt(format($$select string_agg(action || ':' || (actor_user_id is null) || ':' || (metadata ->> 'origin'), ',') || '|' || bool_and(metadata::text not like '%%5511900020001%%' and metadata::text not like '%%fictícia%%')
    from public.audit_logs where resource_id = %L::uuid$$, :'r1'::jsonb ->> 'message_id')),
  'message.observed:true:business_app|true', 'auditoria sem ator e sem telefone nem texto'
);
select pg_temp.dom() as dom1 \gset
select is(
  (pg_temp.ob(:'e_tok', 'pm-1', 'wamid.FICTICIO1', '+5511900020001') ->> 'outcome') || ' ' || pg_temp.dom(),
  'already_processed ' || :'dom1', 'reentrega da mesma entrada: already_processed, nada repetido'
);

-- ---------------------------------------------------------------------
-- 5) Conversa já existente (criada pela mensagem recebida da 2b2a)
-- ---------------------------------------------------------------------

select pg_temp.ap(pg_temp.eo('evt-in-1', 'whatsapp.inbound_message.received'), 'pm-in-1', '+5511900020002') as rin \gset
select pg_temp.com() as com_in \gset
select pg_temp.dom() as dom_in \gset
select pg_temp.ob(pg_temp.eo('evt-ex-1'), 'pm-ex-1', 'wamid.FICTICIOEX1', '+5511900020002') as rex \gset
select is(
  (:'rex'::jsonb ->> 'outcome') || ' ' || ((:'rex'::jsonb ->> 'conversation_id') = (:'rin'::jsonb ->> 'conversation_id'))::text
  || ' ' || (split_part(pg_temp.dom(), '|', 1) = split_part(:'dom_in', '|', 1))::text || ' ' || (split_part(pg_temp.dom(), '|', 2) = split_part(:'dom_in', '|', 2))::text
  || ' ' || (pg_temp.com() = :'com_in')::text
  || ' ' || pg_temp.txt(format($$select string_agg(direction::text, ',' order by created_at, direction) from public.messages where conversation_id = %L::uuid$$, :'rin'::jsonb ->> 'conversation_id')),
  'applied true true true true inbound,outbound',
  'conversa já existente: reutilizada; nenhuma identidade ou conversa nova; nada comercial; recebida e enviada na mesma conversa'
);

-- ---------------------------------------------------------------------
-- 6) Vínculo comercial: só exato e único; ambiguidade → revisão
-- ---------------------------------------------------------------------

select p.id as pipe, (select s.id from public.pipeline_stages s where s.pipeline_id = p.id order by s.position limit 1) as etapa
from public.pipelines p where p.workspace_id = :'ws_um'::uuid and p.is_default \gset
insert into public.contacts (id, workspace_id, type, name, created_by) values
  ('3f000000-0000-0000-0000-000000000001', :'ws_um'::uuid, 'pf', 'Cliente Fictício 1', :'ana'::uuid),
  ('3f000000-0000-0000-0000-000000000002', :'ws_um'::uuid, 'pf', 'Cliente Fictício 2', :'ana'::uuid),
  ('3f000000-0000-0000-0000-000000000031', :'ws_um'::uuid, 'pf', 'Cliente Fictício 3a', :'ana'::uuid),
  ('3f000000-0000-0000-0000-000000000032', :'ws_um'::uuid, 'pf', 'Cliente Fictício 3b', :'ana'::uuid),
  ('3f000000-0000-0000-0000-000000000004', :'ws_um'::uuid, 'pf', 'Cliente Fictício 4', :'ana'::uuid),
  ('3f000000-0000-0000-0000-000000000005', :'ws_um'::uuid, 'pf', 'Cliente Fictício 5', :'ana'::uuid);
insert into public.contact_phones (workspace_id, contact_id, value_normalized, is_primary) values
  (:'ws_um'::uuid, '3f000000-0000-0000-0000-000000000001', '+5511900021001', true),
  (:'ws_um'::uuid, '3f000000-0000-0000-0000-000000000002', '+5511900021002', true),
  (:'ws_um'::uuid, '3f000000-0000-0000-0000-000000000031', '+5511900021003', true),
  (:'ws_um'::uuid, '3f000000-0000-0000-0000-000000000032', '+5511900021003', true),
  (:'ws_um'::uuid, '3f000000-0000-0000-0000-000000000004', '+5511900021004', true),
  (:'ws_um'::uuid, '3f000000-0000-0000-0000-000000000005', '+5511900021005', true);
insert into public.contact_identifiers (workspace_id, contact_id, provider, external_id) values
  (:'ws_um'::uuid, '3f000000-0000-0000-0000-000000000001', 'whatsapp', '5511900021001'),
  (:'ws_um'::uuid, '3f000000-0000-0000-0000-000000000004', 'whatsapp', '5511900021004'),
  (:'ws_um'::uuid, '3f000000-0000-0000-0000-000000000005', 'whatsapp', '5511900021005');
insert into public.leads (id, workspace_id, contact_id, legal_area, created_by) values
  ('3f100000-0000-0000-0000-000000000001', :'ws_um'::uuid, '3f000000-0000-0000-0000-000000000001', 'Trabalhista', :'ana'::uuid),
  ('3f100000-0000-0000-0000-000000000002', :'ws_um'::uuid, '3f000000-0000-0000-0000-000000000002', 'Trabalhista', :'ana'::uuid),
  ('3f100000-0000-0000-0000-000000000041', :'ws_um'::uuid, '3f000000-0000-0000-0000-000000000004', 'Trabalhista', :'ana'::uuid),
  ('3f100000-0000-0000-0000-000000000042', :'ws_um'::uuid, '3f000000-0000-0000-0000-000000000004', 'Família', :'ana'::uuid),
  ('3f100000-0000-0000-0000-000000000005', :'ws_um'::uuid, '3f000000-0000-0000-0000-000000000005', 'Trabalhista', :'ana'::uuid);
insert into public.opportunities (id, workspace_id, lead_id, pipeline_id, stage_id, created_by) values
  ('3f200000-0000-0000-0000-000000000001', :'ws_um'::uuid, '3f100000-0000-0000-0000-000000000001', :'pipe'::uuid, :'etapa'::uuid, :'ana'::uuid),
  ('3f200000-0000-0000-0000-000000000002', :'ws_um'::uuid, '3f100000-0000-0000-0000-000000000002', :'pipe'::uuid, :'etapa'::uuid, :'ana'::uuid),
  ('3f200000-0000-0000-0000-000000000051', :'ws_um'::uuid, '3f100000-0000-0000-0000-000000000005', :'pipe'::uuid, :'etapa'::uuid, :'ana'::uuid),
  ('3f200000-0000-0000-0000-000000000052', :'ws_um'::uuid, '3f100000-0000-0000-0000-000000000005', :'pipe'::uuid, :'etapa'::uuid, :'ana'::uuid);
select pg_temp.com() as com_k \gset

select coalesce(pg_temp.ob(pg_temp.eo('evt-k1'), 'pm-k1', null, '+5511900021001') ->> 'conversation_id', '00000000-0000-0000-0000-000000000000') as conv_k1 \gset
select is(pg_temp.vinc(:'conv_k1'),
  '3f000000-0000-0000-0000-000000000001|3f100000-0000-0000-0000-000000000001|3f200000-0000-0000-0000-000000000001|false|1',
  'contato conhecido pelo identificador whatsapp, lead e oportunidade únicos: vinculados, sem revisão');
select coalesce(pg_temp.ob(pg_temp.eo('evt-k2'), 'pm-k2', null, '+5511900021002') ->> 'conversation_id', '00000000-0000-0000-0000-000000000000') as conv_k2 \gset
select is(pg_temp.vinc(:'conv_k2'),
  '3f000000-0000-0000-0000-000000000002|3f100000-0000-0000-0000-000000000002|3f200000-0000-0000-0000-000000000002|false|2',
  'contato conhecido pelo telefone único: vinculado, com lead e oportunidade únicos');
select coalesce(pg_temp.ob(pg_temp.eo('evt-k3'), 'pm-k3', null, '+5511900021003') ->> 'conversation_id', '00000000-0000-0000-0000-000000000000') as conv_k3 \gset
select is(pg_temp.vinc(:'conv_k3'), '-|-|-|true|2', 'dois contatos com o mesmo telefone: nenhum vínculo, revisão com os candidatos');
select coalesce(pg_temp.ob(pg_temp.eo('evt-k4'), 'pm-k4', null, '+5511900021004') ->> 'conversation_id', '00000000-0000-0000-0000-000000000000') as conv_k4 \gset
select is(pg_temp.vinc(:'conv_k4'), '3f000000-0000-0000-0000-000000000004|-|-|true|2', 'contato único com dois leads ativos: só o contato, revisão do lead');
select coalesce(pg_temp.ob(pg_temp.eo('evt-k5'), 'pm-k5', null, '+5511900021005') ->> 'conversation_id', '00000000-0000-0000-0000-000000000000') as conv_k5 \gset
select is(pg_temp.vinc(:'conv_k5'), '3f000000-0000-0000-0000-000000000005|3f100000-0000-0000-0000-000000000005|-|true|1',
  'lead único com duas oportunidades abertas: nenhuma oportunidade, revisão');
select is((pg_temp.com() = :'com_k')::text, 'true',
  'nenhum contato, telefone, identificador, lead, oportunidade ou atividade criado ou alterado pelos vínculos');

-- ---------------------------------------------------------------------
-- 7) Destinatário por telefone, BSUID ou os dois; conflito
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

select pg_temp.ob(pg_temp.eo('evt-b1'), 'pm-b1', null, null, format('{"1": "%s"}', :'bi1')) as rb1 \gset
select is(
  (:'rb1'::jsonb ->> 'outcome') || ' ' || pg_temp.ident(format('channel_id = %L and bsuid_blind_index = decode(%L, ''base64'')', :'ch_o', :'bi1'))
  || ' ' || pg_temp.txt(format($$select coalesce(wa_id, '-') from public.conversations where id = %L::uuid$$, :'rb1'::jsonb ->> 'conversation_id'))
  || ' ' || pg_temp.vinc(:'rb1'::jsonb ->> 'conversation_id'),
  'applied -|' || :'bi1' || '|1 - -|-|-|true|0',
  'só BSUID: identidade só com BSUID, nenhum telefone derivado, conversa sem telefone, para revisão'
);
select pg_temp.ob(pg_temp.eo('evt-b2'), 'pm-b2', null, '+5511900020003', format('{"1": "%s"}', :'bi2')) as rb2 \gset
select is(
  (:'rb2'::jsonb ->> 'outcome') || ' ' || pg_temp.ident(format('channel_id = %L and phone_e164 = ''+5511900020003''', :'ch_o'))
  || ' ' || pg_temp.txt(format($$select count(*)::text from public.whatsapp_identities where channel_id = %L and (phone_e164 = '+5511900020003' or bsuid_blind_index = decode(%L, 'base64'))$$, :'ch_o', :'bi2')),
  'applied +5511900020003|' || :'bi2' || '|1 1', 'telefone e BSUID: uma identidade com os dois'
);
select pg_temp.ob(pg_temp.eo('evt-b3'), 'pm-b3', null, '+5511900020001', format('{"1": "%s"}', :'bi3')) as rb3 \gset
select is(
  (:'rb3'::jsonb ->> 'outcome') || ' ' || ((:'rb3'::jsonb ->> 'conversation_id') = (:'r1'::jsonb ->> 'conversation_id'))::text
  || ' ' || pg_temp.ident(format('channel_id = %L and phone_e164 = ''+5511900020001''', :'ch_o')),
  'applied true +5511900020001|' || :'bi3' || '|1', 'telefone conhecido sem BSUID: reutiliza e acrescenta o BSUID; mesma conversa'
);

select pg_temp.eo('evt-c1') as e_c1 \gset
select pg_temp.eo('evt-c2') as e_c2 \gset
select pg_temp.dom() as domc \gset
select pg_temp.com() as comc \gset
select is(
  (pg_temp.ob(:'e_c1', 'pm-c1', null, '+5511900020001', format('{"1": "%s"}', :'bi2')) ->> 'outcome') || ' '
  || (pg_temp.ob(:'e_c2', 'pm-c2', null, '+5511900020003', format('{"1": "%s"}', :'bi1')) ->> 'outcome'),
  'identity_conflict identity_conflict', 'telefone e BSUID de identidades diferentes: identity_conflict, sem auto-merge'
);
select is(
  pg_temp.dom() || ' ' || pg_temp.res(:'e_c1') || ' ' || pg_temp.res(:'e_c2') || ' ' || (pg_temp.com() = :'comc')::text
  || ' ' || pg_temp.ident(format('channel_id = %L and phone_e164 = ''+5511900020001''', :'ch_o')),
  :'domc' || ' processing|' || split_part(:'e_c1', '|', 2) || ' processing|' || split_part(:'e_c2', '|', 2) || ' true +5511900020001|' || :'bi3' || '|1',
  'conflito de identidade: nenhum ledger, identidade, conversa ou mensagem; identidades intactas; claim intacto'
);

-- ---------------------------------------------------------------------
-- 8) Idempotência dos identificadores da mensagem
-- ---------------------------------------------------------------------

-- Mesmo id do provedor por outro evento.
select pg_temp.eo('evt-d1') as e_d1 \gset
select pg_temp.dom() as domd1 \gset
select pg_temp.ob(:'e_d1', 'pm-1', null, '+5511900020001') as rd1 \gset
select is(
  (:'rd1'::jsonb ->> 'outcome') || ' ' || split_part(pg_temp.dom(), '|', 3) || ' ' || pg_temp.res(:'e_d1') || ' '
  || pg_temp.txt(format($$select (message_id = %L::uuid)::text from public.whatsapp_effect_ledger where inbox_id = %L::uuid$$, :'r1'::jsonb ->> 'message_id', split_part(:'e_d1', '|', 1))),
  'duplicate ' || split_part(:'domd1', '|', 3) || ' processed|- true',
  'mesmo id do provedor por outro evento: duplicate, uma mensagem só, ledger aponta para ela'
);

-- Mesmo wamid; a mensagem existente só tinha o wamid: ganha o id do provedor.
-- (Sem a função, a conversa do r1 não existe: usa a da mensagem recebida.)
insert into public.messages (id, workspace_id, conversation_id, channel_id, direction, origin, sender_classification, content_kind, body_text, wa_message_id, status)
values ('3f300000-0000-0000-0000-000000000001', :'ws_um'::uuid,
  coalesce((:'r1'::jsonb ->> 'conversation_id')::uuid, (:'rin'::jsonb ->> 'conversation_id')::uuid), :'ch_o'::uuid, 'outbound', 'business_app', 'internal',
  'text', 'Mensagem fictícia só com wamid', 'wamid.FICTICIOSOWAMID', 'sent');
select pg_temp.dom() as domd2 \gset
select pg_temp.ob(pg_temp.eo('evt-d2'), 'pm-so-wamid', 'wamid.FICTICIOSOWAMID', '+5511900020001') as rd2 \gset
select is(
  (:'rd2'::jsonb ->> 'outcome') || ' ' || split_part(pg_temp.dom(), '|', 3) || ' ' || pg_temp.msg('3f300000-0000-0000-0000-000000000001'),
  'duplicate ' || split_part(:'domd2', '|', 3) || ' outbound|business_app|internal|true|sent|text|Mensagem fictícia só com wamid|simulated|pm-so-wamid|wamid.FICTICIOSOWAMID|true|-',
  'mesmo wamid por outro evento: duplicate, uma mensagem só; o id do provedor que faltava é acrescentado'
);

-- echoes e created da mesma mensagem convergem (eventos diferentes).
select pg_temp.eo('evt-e1', 'whatsapp.smb.message.echoes') as e_e1 \gset
select pg_temp.eo('evt-e2', 'whatsapp.smb.message.created') as e_e2 \gset
select pg_temp.dom() as dome \gset
select pg_temp.ob(:'e_e1', 'pm-eco', null, '+5511900020001') as re1 \gset
select pg_temp.ob(:'e_e2', 'pm-eco', 'wamid.FICTICIOECO', '+5511900020001') as re2 \gset
select is(
  (:'re1'::jsonb ->> 'outcome') || ' ' || (:'re2'::jsonb ->> 'outcome')
  || ' ' || (split_part(pg_temp.dom(), '|', 3)::int - split_part(:'dome', '|', 3)::int)
  || ' ' || pg_temp.txt(format($$select count(distinct message_id) || '|' || count(*) from public.whatsapp_effect_ledger where inbox_id in (%L::uuid, %L::uuid)$$, split_part(:'e_e1', '|', 1), split_part(:'e_e2', '|', 1)))
  || ' ' || pg_temp.txt(format($$select coalesce(wa_message_id, '-') from public.messages where id = %L::uuid$$, :'re1'::jsonb ->> 'message_id'))
  || ' ' || pg_temp.res(:'e_e1') || ' ' || pg_temp.res(:'e_e2'),
  'applied duplicate 1 1|2 wamid.FICTICIOECO processed|- processed|-',
  'echoes e created da mesma mensagem: uma mensagem, os dois ledgers nela, o wamid acrescentado, as duas entradas processadas'
);

-- Identificadores que apontam para mensagens diferentes: conflito, nada muda.
select pg_temp.ob(pg_temp.eo('evt-m1'), 'pm-m1', null, '+5511900020001') as rm1 \gset
select pg_temp.ob(pg_temp.eo('evt-m2'), 'pm-m2', 'wamid.FICTICIOM2', '+5511900020001') as rm2 \gset
select pg_temp.eo('evt-m3') as e_m3 \gset
select pg_temp.eo('evt-m4') as e_m4 \gset
select pg_temp.eo('evt-m5') as e_m5 \gset
select pg_temp.dom() as domm \gset
select coalesce(md5(string_agg(m::text, ',' order by m.id)), '-') as msgs_m from public.messages m where m.channel_id = :'ch_o'::uuid \gset
select is(
  pg_temp.ob(:'e_m3', 'pm-m1', 'wamid.FICTICIOM2', '+5511900020001')::text,
  '{"outcome": "message_conflict"}', 'id do provedor de uma mensagem e wamid de outra: message_conflict'
);
select is(
  (pg_temp.ob(:'e_m4', 'pm-outro', 'wamid.FICTICIOM2', '+5511900020001') ->> 'outcome') || ' '
  || (pg_temp.ob(:'e_m5', 'pm-in-1', null, '+5511900020002') ->> 'outcome'),
  'message_conflict message_conflict',
  'wamid de uma mensagem que já tem outro id do provedor, ou id de uma mensagem RECEBIDA: message_conflict'
);
select is(
  pg_temp.dom() || ' ' || (select coalesce(md5(string_agg(m::text, ',' order by m.id)), '-') from public.messages m where m.channel_id = :'ch_o'::uuid)
  || ' ' || pg_temp.res(:'e_m3') || ' ' || pg_temp.res(:'e_m4') || ' ' || pg_temp.res(:'e_m5'),
  :'domm' || ' ' || :'msgs_m' || ' processing|' || split_part(:'e_m3', '|', 2) || ' processing|' || split_part(:'e_m4', '|', 2) || ' processing|' || split_part(:'e_m5', '|', 2),
  'message_conflict: nenhum ledger, mensagem alterada ou acrescentada; claim intacto'
);

-- Conflito de efeito e efeito já reservado.
select pg_temp.eo('evt-f1') as e_f1 \gset
select pg_temp.eo('evt-f2') as e_f2 \gset
insert into public.whatsapp_effect_ledger (environment, workspace_id, channel_id, provider, provider_event_id, effect, inbox_id)
values ('preview', :'ws_um'::uuid, :'ch_o'::uuid, 'simulated', 'evt-f1', 'message.inbound', split_part(:'e_f1', '|', 1)::uuid),
       ('preview', :'ws_um'::uuid, :'ch_o'::uuid, 'simulated', 'evt-f2', 'message.outbound_observed', split_part(:'e_f2', '|', 1)::uuid);
select pg_temp.dom() as domf \gset
select is(
  pg_temp.ob(:'e_f1', 'pm-f1', null, '+5511900020001')::text || ' ' || pg_temp.dom() || ' ' || pg_temp.res(:'e_f1'),
  '{"outcome": "effect_conflict"}' || ' ' || :'domf' || ' processing|' || split_part(:'e_f1', '|', 2),
  'a chave estável já tem outro efeito: effect_conflict, nada escrito, claim intacto'
);
select is(
  (pg_temp.ob(:'e_f2', 'pm-f2', null, '+5511900020001') ->> 'outcome') || ' ' || pg_temp.dom() || ' ' || pg_temp.res(:'e_f2'),
  'duplicate ' || :'domf' || ' processed|-',
  'o mesmo efeito já reservado para a entrada: duplicate, nada repetido, entrada finalizada'
);

-- ---------------------------------------------------------------------
-- 8b) Convergência: o destinatário tem de ser a mesma identidade
-- ---------------------------------------------------------------------

-- Linha da mensagem e da conversa (para provar que nada mudou).
create function pg_temp.mc(p_msg text) returns text language sql as $f$
  select coalesce((select md5(m::text || '#' || c::text) from public.messages m join public.conversations c on c.id = m.conversation_id
    where m.id = p_msg::uuid), 'NULL')
$f$;

select pg_temp.mc(:'r1'::jsonb ->> 'message_id') as mc_r1 \gset
select pg_temp.eo('evt-x1') as e_x1 \gset
select pg_temp.dom() as domx1 \gset
select is(
  (pg_temp.ob(:'e_x1', 'pm-1', null, '+5511900024001') ->> 'outcome') || ' ' || pg_temp.dom() || ' ' || pg_temp.res(:'e_x1')
  || ' ' || pg_temp.txt($$select count(*)::text from public.whatsapp_identities where phone_e164 = '+5511900024001'$$)
  || ' ' || pg_temp.mc(:'r1'::jsonb ->> 'message_id'),
  'message_conflict ' || :'domx1' || ' processing|' || split_part(:'e_x1', '|', 2) || ' 0 ' || :'mc_r1',
  'mesmo id do provedor com outro telefone: message_conflict; nenhuma identidade, conversa, mensagem ou ledger; mensagem e conversa intactas; claim intacto'
);

-- Mensagem só com wamid (sem id do provedor): a busca é só pelo wamid.
insert into public.messages (id, workspace_id, conversation_id, channel_id, direction, origin, sender_classification, content_kind, body_text, wa_message_id, status)
values ('3f300000-0000-0000-0000-000000000002', :'ws_um'::uuid,
  coalesce((:'r1'::jsonb ->> 'conversation_id')::uuid, (:'rin'::jsonb ->> 'conversation_id')::uuid), :'ch_o'::uuid, 'outbound', 'business_app', 'internal',
  'text', 'Mensagem fictícia só com wamid (2)', 'wamid.FICTICIOSOWAMID2', 'sent');
select pg_temp.mc('3f300000-0000-0000-0000-000000000002') as mc_w2 \gset
select pg_temp.eo('evt-x2') as e_x2 \gset
select pg_temp.dom() as domx2 \gset
select is(
  (pg_temp.ob(:'e_x2', 'pm-x2', 'wamid.FICTICIOSOWAMID2', '+5511900024002') ->> 'outcome') || ' ' || pg_temp.dom() || ' ' || pg_temp.res(:'e_x2')
  || ' ' || pg_temp.txt($$select count(*)::text from public.whatsapp_identities where phone_e164 = '+5511900024002'$$)
  || ' ' || pg_temp.mc('3f300000-0000-0000-0000-000000000002'),
  'message_conflict ' || :'domx2' || ' processing|' || split_part(:'e_x2', '|', 2) || ' 0 ' || :'mc_w2',
  'mesmo wamid com outro telefone: message_conflict; o id do provedor não é acrescentado; nada gravado; claim intacto'
);

select pg_temp.mc(:'rb2'::jsonb ->> 'message_id') as mc_b2 \gset
select pg_temp.eo('evt-x3') as e_x3 \gset
select pg_temp.eo('evt-x4') as e_x4 \gset
select pg_temp.dom() as domx3 \gset
select is(
  (pg_temp.ob(:'e_x3', 'pm-b2', null, null, format('{"1": "%s"}', 'BQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQU=')) ->> 'outcome') || ' '
  || (pg_temp.ob(:'e_x4', 'pm-b2', null, null, format('{"1": "%s"}', :'bi1')) ->> 'outcome') || ' ' || pg_temp.dom()
  || ' ' || pg_temp.txt($$select count(*)::text from public.whatsapp_identities where bsuid_blind_index = decode('BQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQU=', 'base64')$$)
  || ' ' || pg_temp.mc(:'rb2'::jsonb ->> 'message_id') || ' ' || pg_temp.res(:'e_x3') || ' ' || pg_temp.res(:'e_x4'),
  'message_conflict message_conflict ' || :'domx3' || ' 0 ' || :'mc_b2' || ' processing|' || split_part(:'e_x3', '|', 2) || ' processing|' || split_part(:'e_x4', '|', 2),
  'mesmo id com outro BSUID (nunca visto, ou de outra identidade): message_conflict; a identidade divergente não fica criada'
);

-- A mesma identidade, apresentada de jeitos diferentes, converge.
select pg_temp.ob(pg_temp.eo('evt-y1'), 'pm-cv1', null, '+5511900024004') as ry1 \gset
select pg_temp.ob(pg_temp.eo('evt-y2'), 'pm-cv1', null, '+5511900024004', format('{"1": "%s"}', 'BgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgY=')) as ry2 \gset
select is(
  (:'ry1'::jsonb ->> 'outcome') || ' ' || (:'ry2'::jsonb ->> 'outcome')
  || ' ' || pg_temp.ident(format('channel_id = %L and phone_e164 = ''+5511900024004''', :'ch_o'))
  || ' ' || pg_temp.txt($$select count(*)::text from public.messages where provider_message_id = 'pm-cv1'$$),
  'applied duplicate +5511900024004|BgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgY=|1 1',
  'primeiro por telefone, depois por telefone + BSUID: converge; a identidade ganha o BSUID; uma mensagem'
);
select pg_temp.ob(pg_temp.eo('evt-y3'), 'pm-cv1', null, null, format('{"1": "%s"}', 'BgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgY=')) as ry3 \gset
select pg_temp.ob(pg_temp.eo('evt-y4'), 'pm-cv1', null, '+5511900024004', format('{"1": "%s"}', :'bi1')) as ry4 \gset
select is(
  (:'ry3'::jsonb ->> 'outcome') || ' ' || (:'ry4'::jsonb ->> 'outcome')
  || ' ' || pg_temp.txt($$select count(*)::text from public.whatsapp_identities where phone_e164 = '+5511900024004' or bsuid_blind_index = decode('BgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgY=', 'base64')$$)
  || ' ' || pg_temp.txt($$select count(*)::text from public.messages where provider_message_id = 'pm-cv1'$$),
  'duplicate identity_conflict 1 1',
  'só o BSUID já ligado à mesma identidade: converge; telefone e BSUID de identidades diferentes continuam identity_conflict; uma identidade, uma mensagem'
);

-- ---------------------------------------------------------------------
-- 8c) Limite do wamid: o mesmo do normalizador (wamid. + até 512)
-- ---------------------------------------------------------------------

select is(
  concat_ws(' ',
    pg_temp.ob(pg_temp.eo('evt-w1'), 'pm-w128', 'wamid.' || repeat('A', 122), '+5511900020001') ->> 'outcome',
    pg_temp.ob(pg_temp.eo('evt-w2'), 'pm-w129', 'wamid.' || repeat('B', 123), '+5511900020001') ->> 'outcome',
    pg_temp.ob(pg_temp.eo('evt-w3'), 'pm-w518', 'wamid.' || repeat('C', 512), '+5511900020001') ->> 'outcome')
  || ' ' || pg_temp.txt($$select string_agg(char_length(wa_message_id)::text, ',' order by char_length(wa_message_id)) from public.messages where provider_message_id in ('pm-w128', 'pm-w129', 'pm-w518')$$),
  'applied applied applied 128,129,518', 'wamid com 128, 129 e 518 caracteres: aceito e gravado inteiro'
);
select pg_temp.eo('evt-w4') as e_w4 \gset
select pg_temp.dom() as domw \gset
select is(
  (pg_temp.ob(:'e_w4', 'pm-w519', 'wamid.' || repeat('D', 513), '+5511900020001') ->> 'erro') || ' ' || pg_temp.dom() || ' ' || pg_temp.res(:'e_w4'),
  'invalid_outbound_message ' || :'domw' || ' processing|' || split_part(:'e_w4', '|', 2),
  'wamid com 519 caracteres: recusado antes de qualquer escrita'
);
select is(
  pg_temp.txt(format($$with x as (insert into public.messages (workspace_id, conversation_id, channel_id, direction, origin, sender_classification, content_kind, body_text, wa_message_id, status)
      values (%L, %L, %L, 'outbound', 'business_app', 'internal', 'text', 'Coluna (fictícia)', 'sim-' || repeat('E', 514), 'sent') returning 1) select count(*)::text from x$$,
    :'ws_um', coalesce(:'r1'::jsonb ->> 'conversation_id', :'rin'::jsonb ->> 'conversation_id'), :'ch_o'))
  || ' ' || (pg_temp.txt(format($$with x as (insert into public.messages (workspace_id, conversation_id, channel_id, direction, origin, sender_classification, content_kind, body_text, wa_message_id, status)
      values (%L, %L, %L, 'outbound', 'business_app', 'internal', 'text', 'Coluna (fictícia)', 'sim-' || repeat('F', 515), 'sent') returning 1) select count(*)::text from x$$,
    :'ws_um', coalesce(:'r1'::jsonb ->> 'conversation_id', :'rin'::jsonb ->> 'conversation_id'), :'ch_o')) like 'ERRO:23514:%')::text,
  '1 true', 'a coluna aceita qualquer id de 518 caracteres (os da A7 também) e recusa 519'
);
delete from public.messages where body_text = 'Coluna (fictícia)';

-- ---------------------------------------------------------------------
-- 9) Mídia sem texto (nada baixado)
-- ---------------------------------------------------------------------

select pg_temp.ob(pg_temp.eo('evt-md1'), 'pm-md1', null, '+5511900020001', null, 'image', null) as rmd1 \gset
select pg_temp.ob(pg_temp.eo('evt-md2'), 'pm-md2', null, '+5511900020001', null, 'audio', '   ') as rmd2 \gset
select pg_temp.ob(pg_temp.eo('evt-md3'), 'pm-md3', null, '+5511900020001', null, 'document', 'Contrato (legenda fictícia)') as rmd3 \gset
select is(
  pg_temp.txt(format($$select string_agg(content_kind || ':' || coalesce(body_text, '-'), ',' order by provider_message_id) from public.messages where id in (%L::uuid, %L::uuid, %L::uuid)$$,
    :'rmd1'::jsonb ->> 'message_id', :'rmd2'::jsonb ->> 'message_id', :'rmd3'::jsonb ->> 'message_id')),
  'image:-,audio:-,document:Contrato (legenda fictícia)', 'imagem e áudio sem texto, documento com legenda: aceitos, sem arquivo'
);

-- ---------------------------------------------------------------------
-- 10) Status ATUAL do canal, reconferido no efeito
-- ---------------------------------------------------------------------

create function pg_temp.st(p_status text, p_evt text, p_pmid text) returns text language plpgsql as $f$
declare
  v_entry text;
  v_dom text;
  v_audit bigint;
  v jsonb;
begin
  update public.whatsapp_channels set status = 'active', status_changed_at = now() where id = '3e000000-0000-0000-0000-000000000004';
  v_entry := pg_temp.entrada('3e000000-0000-0000-0000-000000000004', '10000000-0000-0000-0000-000000000001', 'b3d2b2b1-s', p_evt);
  update public.whatsapp_channels set status = p_status, send_enabled = false, status_changed_at = now()
  where id = '3e000000-0000-0000-0000-000000000004';
  v_dom := pg_temp.dom();
  v_audit := (select count(*) from public.audit_logs);
  v := pg_temp.ob(v_entry, p_pmid, null, '+5511900023001');
  return coalesce(v::text, 'NULL') || ' ' || (pg_temp.dom() = v_dom and (select count(*) from public.audit_logs) = v_audit)::text
    || ' ' || (pg_temp.res(v_entry) = 'processing|' || split_part(v_entry, '|', 2))::text;
end
$f$;

select is(
  concat_ws(' / ', pg_temp.st('paused', 'evt-s1', 'pm-s1'), pg_temp.st('disconnected', 'evt-s2', 'pm-s2'), pg_temp.st('disabled', 'evt-s3', 'pm-s3')),
  '{"outcome": "channel_paused"} true true / {"outcome": "channel_disconnected"} true true / {"outcome": "channel_disabled"} true true',
  'canal pausado, desconectado ou desativado depois do claim: channel_*; nenhum ledger, identidade, conversa, mensagem ou auditoria; claim intacto'
);
select id::text || '|' || coalesce(claim_token::text, '00000000-0000-0000-0000-000000000000') as e_s3
from public.whatsapp_webhook_inbox where provider_event_id = 'evt-s3' and channel_id = :'ch_s'::uuid \gset
set local role service_role;
select public.whatsapp_inbox_release(split_part(:'e_s3', '|', 1)::uuid, split_part(:'e_s3', '|', 2)::uuid, 'channel_disabled') ->> 'outcome' as rel_s3 \gset
reset role;
select is(
  :'rel_s3' || ' ' || pg_temp.txt(format($$select state || '|' || coalesce(claim_token::text, '-') || '|' || last_release_code from public.whatsapp_webhook_inbox where id = %L::uuid$$, split_part(:'e_s3', '|', 1))),
  'released pending|-|channel_disabled', 'o claim recusado pelo estado do canal ainda pode ser liberado'
);
update public.whatsapp_channels set status = 'active', status_changed_at = now() where id = :'ch_s'::uuid;
select is(
  pg_temp.ob(pg_temp.entrada(:'ch_s', :'ws_um', 'b3d2b2b1-s', 'evt-s4'), 'pm-s4', null, '+5511900023001') ->> 'outcome',
  'applied', 'controle: canal ativo no momento do efeito aplica normalmente'
);

-- ---------------------------------------------------------------------
-- 11) Atomicidade: falha depois da reserva desfaz tudo
-- ---------------------------------------------------------------------

create function public.t37_falha_simulada() returns trigger language plpgsql as $f$
begin
  if new.provider_message_id = 'pm-falha' then
    raise exception 'falha_simulada';
  end if;
  return new;
end
$f$;
create trigger t37_falha_simulada before insert on public.messages for each row execute function public.t37_falha_simulada();

select pg_temp.eo('evt-r1') as e_r1 \gset
select pg_temp.dom() as domr \gset
select is(
  (pg_temp.ob(:'e_r1', 'pm-falha', 'wamid.FICTICIOFALHA', '+5511900020009', format('{"1": "%s"}', 'BAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQ=')) ->> 'erro')
  || ' ' || pg_temp.dom() || ' ' || pg_temp.res(:'e_r1')
  || ' ' || pg_temp.txt($$select count(*)::text from public.whatsapp_identities where phone_e164 = '+5511900020009'$$),
  'falha_simulada ' || :'domr' || ' processing|' || split_part(:'e_r1', '|', 2) || ' 0',
  'falha ao gravar a mensagem, depois do ledger, da identidade e da conversa: nada sobrevive e o claim continua'
);
drop trigger t37_falha_simulada on public.messages;
select is(
  pg_temp.ob(:'e_r1', 'pm-depois', 'wamid.FICTICIOFALHA', '+5511900020009', format('{"1": "%s"}', 'BAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQ=')) ->> 'outcome',
  'applied', 'sem a falha, a mesma entrada aplica normalmente'
);

-- ---------------------------------------------------------------------
-- 12) Isolamento: outro workspace e Production
-- ---------------------------------------------------------------------

select pg_temp.ob(pg_temp.entrada(:'ch_b', :'ws_dois', 'b3d2b2b1-b', 'evt-tok'), 'pm-1', 'wamid.FICTICIO1', '+5511900020001') as rb \gset
select is(
  (:'rb'::jsonb ->> 'outcome') || ' ' || pg_temp.txt($$select count(distinct workspace_id)::text || '|' || count(*) from public.whatsapp_identities where phone_e164 = '+5511900020001'$$)
  || ' ' || pg_temp.txt(format($$select (workspace_id = %L::uuid and channel_id = %L::uuid)::text from public.messages where id = %L::uuid$$, :'ws_dois', :'ch_b', :'rb'::jsonb ->> 'message_id')),
  'applied 2|2 true', 'mesmo telefone, mesmo evento, id do provedor e wamid em outro workspace: outra identidade e outra mensagem, sem colisão'
);
select set_config('request.headers', :'h_prod', true);
select pg_temp.entrada(:'ch_prod', :'ws_um', 'b3d2b2b1-prod', 'evt-tok') as e_p \gset
select pg_temp.ob(:'e_p', 'pm-1', 'wamid.FICTICIO1', '+5511900020001') as rp \gset
select is(
  (:'rp'::jsonb ->> 'outcome') || ' ' || pg_temp.txt(format($$select i.environment::text from public.whatsapp_identities i join public.conversations c on c.identity_id = i.id where c.id = %L::uuid$$, :'rp'::jsonb ->> 'conversation_id')),
  'applied production', 'Production: identidade e efeito no próprio ambiente'
);
select set_config('request.headers', :'h_prev', true);
select is(pg_temp.ob(:'e_p', 'pm-1', 'wamid.FICTICIO1', '+5511900020001') ->> 'outcome', 'not_found', 'a entrada de Production não é alcançada a partir de Preview');

-- ---------------------------------------------------------------------
-- 13) Nada comercial nesta etapa; A7: leituras e permissões
-- ---------------------------------------------------------------------

select is(
  pg_temp.txt($$select count(*)::text from public.messages m where m.origin = 'business_app'
    and (m.sender_classification <> 'internal' or m.sent_by is not null or m.direction <> 'outbound' or m.origin_correlation_kind is not null)$$)
  || ' ' || pg_temp.txt($$select count(*)::text from public.activities a join public.messages m on m.id = a.source_conversation_message_id where m.origin = 'business_app'$$),
  '0 0', 'toda saída observada é outbound/business_app/internal, sem autor nem correlação, e nenhuma deu origem a atividade'
);
select is(
  pg_temp.txt($$select count(*)::text from public.contacts c where c.created_at >= now() and c.name like 'Contato WhatsApp%'$$)
  || ' ' || pg_temp.txt($$select count(*)::text from public.audit_logs where action in ('contact.created', 'lead.created', 'opportunity.created', 'activity.auto_created') and created_at >= now()$$),
  '0 0', 'nenhuma saída observada criou contato, lead, oportunidade ou atividade'
);

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'ana', 'role', 'authenticated')::text, true);
select is(
  pg_temp.txt(format($$select (get_conversation(%L::uuid) ->> 'wa_id') || '|' || (select jsonb_array_length(items) from list_conversation_messages(%L::uuid, null, 30, null))
    || '|' || (select count(*) from list_conversations(%L::uuid, 1, 100) lc, jsonb_array_elements(lc.items) e where e ->> 'id' = %L)$$,
    :'rin'::jsonb ->> 'conversation_id', :'rin'::jsonb ->> 'conversation_id', :'ws_um', :'rin'::jsonb ->> 'conversation_id')),
  '+5511900020002|2|1', 'leituras da A7 mostram a conversa com a mensagem recebida e a enviada pelo aplicativo'
);
select is(
  pg_temp.txt(format($$select coalesce(get_conversation(%L::uuid) ->> 'wa_id', 'sem telefone')$$, :'rb1'::jsonb ->> 'conversation_id')),
  'sem telefone', 'conversa só com BSUID: a A7 lê, sem telefone'
);
select is(
  pg_temp.txt(format($$select public.whatsapp_effect_outbound_observed(%L::uuid, %L::uuid, 'pm-x', null, 'text', 'x', now(), '+5511900020001', null, null, null)::text$$, :'inventado', :'inventado')) like 'ERRO:42501%',
  true, 'authenticated não executa o efeito'
);
reset role;

select * from finish();
rollback;
