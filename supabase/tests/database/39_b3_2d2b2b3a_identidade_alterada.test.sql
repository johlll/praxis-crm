-- pgTAP — B3.2d-2b2b3a: efeito atômico de IDENTIDADE ALTERADA e TROCA DE
-- NÚMERO (NormalizedIdentityChange).
--
-- public.whatsapp_effect_identity_change, numa transação só e sob a trava
-- da inbox:
--  - inbox no ambiente autenticado, em processing, com o token do claim e a
--    lease vigente; canal da linha ainda ativo; workspace, canal, ambiente,
--    provedor e evento vêm da linha da inbox, nunca do chamador;
--  - reserva contact.identity_changed no ledger;
--  - identidade ANTERIOR só lida, nunca criada: telefone e BSUID dela têm de
--    apontar para a mesma identidade (identity_conflict); nenhuma →
--    identity_not_found, recuperável;
--  - phone_number: o telefone novo substitui o antigo na MESMA identidade;
--    telefone ou BSUID de outra identidade, ou outro BSUID na mesma →
--    identity_conflict; nunca uma segunda identidade, nunca auto-merge;
--  - a conversa da identidade continua a mesma: wa_id acompanha o telefone,
--    vínculos comerciais preservados e marcados para revisão; contato,
--    telefones do contato e identificadores comerciais intactos;
--  - identity sem a identidade nova: nada inventado; conversa para revisão;
--    review_required;
--  - auditoria só com ids técnicos; inbox processed junto com o efeito;
--    qualquer falha desfaz tudo.
--
-- Escrito ANTES da implementação, contra a main d8f7357. Tudo fictício:
-- nenhum telefone, BSUID ou identidade real. As chamadas passam por
-- funções que capturam o erro: contra a main, o arquivo roda até o fim.

begin;
select plan(46);

\set ana     '20000000-0000-0000-0000-000000000001'
\set ws_um   '10000000-0000-0000-0000-000000000001'
\set ws_dois '10000000-0000-0000-0000-000000000002'
\set ch_o    '3e200000-0000-0000-0000-000000000001'
\set ch_b    '3e200000-0000-0000-0000-000000000002'
\set ch_prod '3e200000-0000-0000-0000-000000000003'
\set ch_s    '3e200000-0000-0000-0000-000000000004'
\set nulo    '00000000-0000-0000-0000-000000000000'
\set inventado '7d1e2f3a-4b5c-4d6e-8f70-819a2b3c4d5f'
\set cifra   'QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFB'
\set bi2     'AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI='
\set bi3     'AwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwM='
\set bi4     'BAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQ='
\set bi5     'BQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQU='
\set bi6     'BgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgY='
\set bi7     'BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc='
\set pa      '+5511900040001'
\set na      '+5511900040101'
\set na2     '+5511900040102'
\set pb      '+5511900040002'
\set nb      '+5511900040201'
\set nc      '+5511900040301'
\set pd      '+5511900040004'
\set pk      '+5511900040005'
\set nk      '+5511900040501'
\set pk2     '+5511900040006'
\set pk3     '+5511900040007'
\set nk3     '+5511900040701'

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

set local role service_role;
select whatsapp_create_simulated_channel(:'ch_o'::uuid, :'ws_um'::uuid, :'ana'::uuid, 'O', 'b3d2b2b3a-o', '1', :'cifra', '1') is not null as ok \gset
select whatsapp_create_simulated_channel(:'ch_s'::uuid, :'ws_um'::uuid, :'ana'::uuid, 'S', 'b3d2b2b3a-s', '1', :'cifra', '1') is not null as ok \gset
select whatsapp_create_simulated_channel(:'ch_b'::uuid, :'ws_dois'::uuid, '20000000-0000-0000-0000-000000000002'::uuid, 'B', 'b3d2b2b3a-b', '1', :'cifra', '1') is not null as ok \gset
select set_config('request.headers', :'h_prod', true);
select whatsapp_create_simulated_channel(:'ch_prod'::uuid, :'ws_um'::uuid, :'ana'::uuid, 'Prod', 'b3d2b2b3a-prod', '1', :'cifra', '1') is not null as ok \gset
select set_config('request.headers', :'h_prev', true);
reset role;

-- Entrada da inbox (cifra fictícia) e claim, como service_role: 'id|token'.
create function pg_temp.entrada(p_ch text, p_ws text, p_routing text, p_evt text,
  p_type text default 'whatsapp.inbound_message.received', p_claim boolean default true) returns text language plpgsql as $f$
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

create function pg_temp.eo(p_evt text, p_type text default 'whatsapp.inbound_message.received') returns text language sql as $f$
  select pg_temp.entrada('3e200000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'b3d2b2b3a-o', p_evt, p_type)
$f$;

-- Saída observada da 2b2b1: cria identidade e conversa pelo caminho real.
create function pg_temp.ob(p_entry text, p_pmid text, p_phone text, p_lookup text default null) returns jsonb language plpgsql as $f$
declare
  v jsonb;
begin
  execute 'set local role service_role';
  execute format(
    'select public.whatsapp_effect_outbound_observed(%L::uuid, %L::uuid, %L, null, ''text'', ''Mensagem fictícia do escritório'', now(), %L, %L::jsonb, %L, %L)',
    split_part(p_entry, '|', 1), split_part(p_entry, '|', 2), p_pmid, p_phone, p_lookup,
    case when p_lookup is null then null else 'CQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQ==' end,
    case when p_lookup is null then null else '1' end) into v;
  execute 'reset role';
  return coalesce(v, 'null'::jsonb);
exception when others then
  return jsonb_build_object('erro', sqlerrm);
end
$f$;

-- Chamada crua do efeito como service_role: o jsonb, ou {"erro": ...}.
create function pg_temp.icr(p_entry text, p_change text, p_at text,
  p_pp text, p_pl text, p_pv text, p_np text, p_nl text, p_nc text, p_nv text, p_token text default null) returns jsonb language plpgsql as $f$
declare
  v jsonb;
begin
  execute 'set local role service_role';
  execute format(
    'select public.whatsapp_effect_identity_change(%L::uuid, %L::uuid, %L, %L::timestamptz, %L, %L::jsonb, %L, %L, %L::jsonb, %L, %L)',
    split_part(p_entry, '|', 1), coalesce(p_token, nullif(split_part(p_entry, '|', 2), '-')), p_change, p_at,
    p_pp, p_pl, p_pv, p_np, p_nl, p_nc, p_nv) into v;
  execute 'reset role';
  return coalesce(v, 'null'::jsonb);
exception when others then
  return jsonb_build_object('erro', sqlerrm);
end
$f$;

-- Atalho: anterior e nova por telefone e índice cego (versão 1).
create function pg_temp.ic(p_entry text, p_change text, p_pp text, p_pb text, p_np text, p_nb text, p_token text default null) returns jsonb language sql as $f$
  select pg_temp.icr(p_entry, p_change, '2026-10-30 12:00:00+00',
    p_pp, case when p_pb is null then null else format('{"1": "%s"}', p_pb) end, case when p_pb is null then null else '1' end,
    p_np, case when p_nb is null then null else format('{"1": "%s"}', p_nb) end,
    case when p_nb is null then null else 'CQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQ==' end,
    case when p_nb is null then null else '1' end, p_token)
$f$;

create function pg_temp.res(p_entry text) returns text language sql as $f$
  select state || '|' || coalesce(claim_token::text, '-') from public.whatsapp_webhook_inbox where id = split_part(p_entry, '|', 1)::uuid
$f$;

create function pg_temp.dom() returns text language sql as $f$
  select concat_ws('|',
    (select count(*) from public.whatsapp_identities), (select count(*) from public.conversations),
    (select count(*) from public.messages), (select count(*) from public.contacts),
    (select count(*) from public.leads), (select count(*) from public.opportunities),
    (select count(*) from public.activities), (select count(*) from public.audit_logs),
    (select count(*) from public.whatsapp_effect_ledger))
$f$;

-- Retrato das identidades e conversas do canal O e dos registros
-- comerciais (linhas inteiras): prova que nada mudou.
create function pg_temp.snap() returns text language sql as $f$
  select md5(concat_ws('#',
    (select string_agg(x::text, ',' order by x.id) from public.whatsapp_identities x),
    (select string_agg(x::text, ',' order by x.id) from public.conversations x)))
$f$;
create function pg_temp.com() returns text language sql as $f$
  select md5(concat_ws('#',
    (select string_agg(x::text, ',' order by x::text) from public.contacts x),
    (select string_agg(x::text, ',' order by x::text) from public.contact_phones x),
    (select string_agg(x::text, ',' order by x::text) from public.contact_identifiers x),
    (select string_agg(x::text, ',' order by x::text) from public.leads x),
    (select string_agg(x::text, ',' order by x::text) from public.opportunities x),
    (select string_agg(x::text, ',' order by x::text) from public.activities x)))
$f$;

-- Identidade: telefone|BSUID (índice cego em base64).
create function pg_temp.idn(p_id text) returns text language sql as $f$
  select coalesce((select coalesce(phone_e164, '-') || '|' || coalesce(encode(bsuid_blind_index, 'base64'), '-')
    from public.whatsapp_identities where id = p_id::uuid), 'NULL')
$f$;

-- Conversa da identidade: wa_id|contato|lead|oportunidade|revisão|candidatos.
create function pg_temp.cv(p_identity text) returns text language sql as $f$
  select coalesce((select concat_ws('|', coalesce(c.wa_id, '-'), coalesce(c.contact_id::text, '-'), coalesce(c.lead_id::text, '-'),
         coalesce(c.opportunity_id::text, '-'), c.needs_link_review::text,
         cardinality(c.link_candidate_contact_ids) || '+' || cardinality(c.link_candidate_lead_ids))
       from public.conversations c where c.identity_id = p_identity::uuid), 'NULL')
$f$;

-- Id da identidade da conversa criada pela saída observada.
create function pg_temp.idc(p_res jsonb) returns text language sql as $f$
  select coalesce((select c.identity_id::text from public.conversations c where c.id = (p_res ->> 'conversation_id')::uuid),
    '00000000-0000-0000-0000-000000000000')
$f$;

-- Cadastro comercial fictício para os vínculos exatos e únicos.
select p.id as pipe, (select s.id from public.pipeline_stages s where s.pipeline_id = p.id order by s.position limit 1) as etapa
from public.pipelines p where p.workspace_id = :'ws_um'::uuid and p.is_default \gset
insert into public.contacts (id, workspace_id, type, name, created_by) values
  ('3f300000-0000-0000-0000-000000000005', :'ws_um'::uuid, 'pf', 'Cliente Fictício K', :'ana'::uuid),
  ('3f300000-0000-0000-0000-000000000006', :'ws_um'::uuid, 'pf', 'Cliente Fictício K2', :'ana'::uuid),
  ('3f300000-0000-0000-0000-000000000007', :'ws_um'::uuid, 'pf', 'Cliente Fictício K3', :'ana'::uuid);
insert into public.contact_phones (workspace_id, contact_id, value_normalized, is_primary) values
  (:'ws_um'::uuid, '3f300000-0000-0000-0000-000000000005', :'pk', true),
  (:'ws_um'::uuid, '3f300000-0000-0000-0000-000000000006', :'pk2', true),
  (:'ws_um'::uuid, '3f300000-0000-0000-0000-000000000007', :'pk3', true);
insert into public.contact_identifiers (workspace_id, contact_id, provider, external_id) values
  (:'ws_um'::uuid, '3f300000-0000-0000-0000-000000000005', 'whatsapp', substr(:'pk', 2)),
  (:'ws_um'::uuid, '3f300000-0000-0000-0000-000000000006', 'whatsapp', substr(:'pk2', 2)),
  (:'ws_um'::uuid, '3f300000-0000-0000-0000-000000000007', 'whatsapp', substr(:'pk3', 2));
insert into public.leads (id, workspace_id, contact_id, legal_area, created_by) values
  ('3f310000-0000-0000-0000-000000000005', :'ws_um'::uuid, '3f300000-0000-0000-0000-000000000005', 'Trabalhista', :'ana'::uuid),
  ('3f310000-0000-0000-0000-000000000006', :'ws_um'::uuid, '3f300000-0000-0000-0000-000000000006', 'Trabalhista', :'ana'::uuid),
  ('3f310000-0000-0000-0000-000000000007', :'ws_um'::uuid, '3f300000-0000-0000-0000-000000000007', 'Trabalhista', :'ana'::uuid);
insert into public.opportunities (id, workspace_id, lead_id, pipeline_id, stage_id, created_by) values
  ('3f320000-0000-0000-0000-000000000005', :'ws_um'::uuid, '3f310000-0000-0000-0000-000000000005', :'pipe'::uuid, :'etapa'::uuid, :'ana'::uuid),
  ('3f320000-0000-0000-0000-000000000006', :'ws_um'::uuid, '3f310000-0000-0000-0000-000000000006', :'pipe'::uuid, :'etapa'::uuid, :'ana'::uuid),
  ('3f320000-0000-0000-0000-000000000007', :'ws_um'::uuid, '3f310000-0000-0000-0000-000000000007', :'pipe'::uuid, :'etapa'::uuid, :'ana'::uuid);

-- Identidades de partida (todas pelo caminho real da B3):
--   A: só telefone pa;            B: telefone pb + BSUID bi2;
--   C: só BSUID bi3;              D: só telefone pd;
--   K, K2, K3: telefone vinculado a contato, lead e oportunidade únicos.
select pg_temp.idc(pg_temp.ob(pg_temp.eo('evt-base-a', 'whatsapp.smb.message.echoes'), 'pm-a', :'pa')) as id_a \gset
select pg_temp.idc(pg_temp.ob(pg_temp.eo('evt-base-b', 'whatsapp.smb.message.echoes'), 'pm-b', :'pb', format('{"1": "%s"}', :'bi2'))) as id_b \gset
select pg_temp.idc(pg_temp.ob(pg_temp.eo('evt-base-c', 'whatsapp.smb.message.echoes'), 'pm-c', null, format('{"1": "%s"}', :'bi3'))) as id_c \gset
select pg_temp.idc(pg_temp.ob(pg_temp.eo('evt-base-d', 'whatsapp.smb.message.echoes'), 'pm-d', :'pd')) as id_d \gset
select pg_temp.idc(pg_temp.ob(pg_temp.eo('evt-base-k', 'whatsapp.smb.message.echoes'), 'pm-k', :'pk')) as id_k \gset
select pg_temp.idc(pg_temp.ob(pg_temp.eo('evt-base-k2', 'whatsapp.smb.message.echoes'), 'pm-k2', :'pk2')) as id_k2 \gset
select pg_temp.idc(pg_temp.ob(pg_temp.eo('evt-base-k3', 'whatsapp.smb.message.echoes'), 'pm-k3', :'pk3')) as id_k3 \gset
select pg_temp.com() as com0 \gset

-- ---------------------------------------------------------------------
-- 1) Estrutura e permissões
-- ---------------------------------------------------------------------

select is(
  pg_temp.txt($$select pg_get_function_identity_arguments('public.whatsapp_effect_identity_change'::regproc)$$),
  'p_inbox_id uuid, p_claim_token uuid, p_change text, p_occurred_at timestamp with time zone, p_previous_phone_e164 text, p_previous_bsuid_lookup jsonb, p_previous_bsuid_key_version text, p_next_phone_e164 text, p_next_bsuid_lookup jsonb, p_next_bsuid_ciphertext text, p_next_bsuid_key_version text',
  'assinatura: inbox, token e só os dados da mudança — nenhum workspace, canal, ambiente, provedor, evento, contato, lead, usuário ou origem'
);
select is(
  pg_temp.txt($$select (p.prosecdef and exists (select 1 from unnest(p.proconfig) c where c = 'search_path=""'))::text
    from pg_proc p where p.oid = 'public.whatsapp_effect_identity_change'::regproc$$),
  'true', 'SECURITY DEFINER com search_path vazio'
);
select is(
  pg_temp.txt($$select has_function_privilege('service_role', 'public.whatsapp_effect_identity_change'::regproc, 'execute')::text || ' '
    || has_function_privilege('authenticated', 'public.whatsapp_effect_identity_change'::regproc, 'execute')::text || ' '
    || has_function_privilege('anon', 'public.whatsapp_effect_identity_change'::regproc, 'execute')::text$$),
  'true false false', 'EXECUTE só para service_role'
);

-- ---------------------------------------------------------------------
-- 2) Claim: estado, token, lease e ambiente
-- ---------------------------------------------------------------------

select pg_temp.entrada(:'ch_o', :'ws_um', 'b3d2b2b3a-o', 'evt-pend', 'whatsapp.inbound_message.received', false) as e_pend \gset
select pg_temp.eo('evt-tok') as e_tok \gset
select pg_temp.eo('evt-lease') as e_lease \gset
select pg_temp.dom() as dom0 \gset
select pg_temp.snap() as snap0 \gset

select is(pg_temp.ic(:'e_pend', 'phone_number', :'pa', null, :'na', null) ->> 'outcome', 'claim_lost', 'entrada sem claim (pending): claim_lost');
select is(
  (pg_temp.ic(:'e_tok', 'phone_number', :'pa', null, :'na', null, :'inventado') ->> 'outcome') || ' ' ||
  (pg_temp.ic(split_part(:'e_tok', '|', 1) || '|-', 'phone_number', :'pa', null, :'na', null) ->> 'outcome'),
  'claim_lost claim_lost', 'token inventado ou ausente: claim_lost'
);
update public.whatsapp_webhook_inbox set claimed_at = clock_timestamp() - interval '10 minutes', lease_until = clock_timestamp() - interval '1 second'
where id = split_part(:'e_lease', '|', 1)::uuid;
select is(pg_temp.ic(:'e_lease', 'phone_number', :'pa', null, :'na', null) ->> 'outcome', 'claim_lost', 'lease vencida: claim_lost');
select set_config('request.headers', :'h_prod', true);
select is(pg_temp.ic(:'e_tok', 'phone_number', :'pa', null, :'na', null) ->> 'outcome', 'not_found', 'autenticado em outro ambiente: not_found');
select set_config('request.headers', '', true);
select is(pg_temp.ic(:'e_tok', 'phone_number', :'pa', null, :'na', null) ->> 'erro', 'whatsapp_environment_required', 'sem ambiente autenticado: recusado');
select set_config('request.headers', :'h_prev', true);
select is(pg_temp.ic(:'inventado' || '|' || :'inventado', 'phone_number', :'pa', null, :'na', null) ->> 'outcome', 'not_found', 'inbox inexistente: not_found');
select is(
  pg_temp.dom() || ' ' || pg_temp.snap() || ' ' || pg_temp.res(:'e_tok') || ' ' || pg_temp.res(:'e_pend'),
  :'dom0' || ' ' || :'snap0' || ' processing|' || split_part(:'e_tok', '|', 2) || ' pending|-',
  'nenhuma recusa escreveu nada nem mexeu em identidade, conversa ou inbox'
);

-- ---------------------------------------------------------------------
-- 3) Validação fechada, antes de qualquer trava ou escrita
-- ---------------------------------------------------------------------

select is(
  concat_ws(' ',
    pg_temp.ic(:'e_tok', 'number', :'pa', null, :'na', null) ->> 'erro',
    pg_temp.ic(:'e_tok', null, :'pa', null, :'na', null) ->> 'erro',
    pg_temp.ic(:'e_tok', 'phone_number', :'pa', null, null, null) ->> 'erro',
    pg_temp.ic(:'e_tok', 'phone_number', :'pa', null, null, :'bi4') ->> 'erro',
    pg_temp.ic(:'e_tok', 'identity', :'pa', null, :'na', null) ->> 'erro',
    pg_temp.ic(:'e_tok', 'identity', :'pa', null, null, :'bi4') ->> 'erro'),
  'invalid_identity_change invalid_identity_change invalid_identity_change invalid_identity_change invalid_identity_change invalid_identity_change',
  'mudança desconhecida ou ausente; phone_number sem a nova ou sem telefone novo; identity com a nova: invalid_identity_change'
);
select is(
  concat_ws(' ',
    pg_temp.ic(:'e_tok', 'phone_number', null, null, :'na', null) ->> 'erro',
    pg_temp.ic(:'e_tok', 'phone_number', '11900040001', null, :'na', null) ->> 'erro',
    pg_temp.ic(:'e_tok', 'phone_number', :'pa', null, '11900040101', null) ->> 'erro',
    pg_temp.icr(:'e_tok', 'phone_number', '2026-10-30 12:00:00+00', :'pa', '{"1": "AQID"}', '1', :'na', null, null, null) ->> 'erro',
    pg_temp.icr(:'e_tok', 'phone_number', '2026-10-30 12:00:00+00', :'pa', format('{"1": "%s"}', :'bi2'), '2', :'na', null, null, null) ->> 'erro',
    pg_temp.icr(:'e_tok', 'phone_number', '2026-10-30 12:00:00+00', :'pa', null, '1', :'na', null, null, null) ->> 'erro'),
  'invalid_identity_change invalid_identity_change invalid_identity_change invalid_identity_change invalid_identity_change invalid_identity_change',
  'anterior vazia; telefone anterior ou novo fora do E.164; índice cego malformado; versão ausente do índice; versão sem índice: invalid_identity_change'
);
select is(
  concat_ws(' ',
    pg_temp.icr(:'e_tok', 'phone_number', '2026-10-30 12:00:00+00', :'pa', null, null, :'na', format('{"1": "%s"}', :'bi4'), null, '1') ->> 'erro',
    pg_temp.icr(:'e_tok', 'phone_number', '2026-10-30 12:00:00+00', :'pa', null, null, :'na', null, 'CQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQ==', '1') ->> 'erro',
    pg_temp.icr(:'e_tok', 'phone_number', '2026-10-30 12:00:00+00', :'pa', null, null, :'na', format('{"1": "%s"}', :'bi4'), 'curta', '1') ->> 'erro',
    pg_temp.icr(:'e_tok', 'phone_number', null, :'pa', null, null, :'na', null, null, null) ->> 'erro',
    pg_temp.icr(:'e_tok', 'phone_number', 'infinity', :'pa', null, null, :'na', null, null, null) ->> 'erro'),
  'invalid_identity_change invalid_identity_change invalid_identity_change invalid_identity_change invalid_identity_change',
  'BSUID novo sem cifra, cifra sem índice, cifra malformada; horário ausente ou infinito: invalid_identity_change'
);
select is(
  pg_temp.dom() || ' ' || pg_temp.snap() || ' ' || pg_temp.res(:'e_tok'),
  :'dom0' || ' ' || :'snap0' || ' processing|' || split_part(:'e_tok', '|', 2),
  'entrada inválida: nada escrito, claim intacto'
);

-- ---------------------------------------------------------------------
-- 4) Troca de número simples (só telefone)
-- ---------------------------------------------------------------------

select pg_temp.dom() as dom_a \gset
select pg_temp.ic(:'e_tok', 'phone_number', :'pa', null, :'na', null) as ra \gset
select is(
  (:'ra'::jsonb ->> 'outcome') || ' ' || ((:'ra'::jsonb ->> 'identity_id') = :'id_a')::text || ' ' || pg_temp.idn(:'id_a')
  || ' ' || split_part(pg_temp.cv(:'id_a'), '|', 1)
  || ' ' || (split_part(pg_temp.dom(), '|', 1) = split_part(:'dom_a', '|', 1))::text
  || ' ' || pg_temp.txt(format($$select count(*)::text from public.whatsapp_identities where phone_e164 in (%L, %L)$$, :'pa', :'na')),
  'applied true ' || :'na' || '|- ' || :'na' || ' true 1',
  'telefone novo livre: a MESMA identidade troca de telefone, a conversa acompanha; nenhuma identidade nova, nenhuma sobra do telefone antigo'
);
select is(
  pg_temp.txt(format($$select string_agg(k, ',' order by k) from jsonb_object_keys(%L::jsonb) k$$, :'ra'))
  || ' ' || pg_temp.txt(format($$select l.effect || '|' || l.environment || '|' || (l.channel_id = %L::uuid) || '|' || l.provider_event_id || '|' || (l.message_id is null)
      from public.whatsapp_effect_ledger l where l.inbox_id = %L::uuid$$, :'ch_o', split_part(:'e_tok', '|', 1)))
  || ' ' || pg_temp.res(:'e_tok'),
  'identity_id,outcome contact.identity_changed|preview|true|evt-tok|true processed|-',
  'resultado só com o id da identidade; ledger contact.identity_changed com o contexto da inbox; inbox processed'
);
select is(
  pg_temp.txt(format($$select string_agg(a.action || '|' || (a.actor_user_id is null) || '|' || a.resource_type || '|' || (a.metadata ->> 'source') || '|' || (a.metadata ->> 'change')
      || '|' || (a.metadata ->> 'outcome'), ',') from public.audit_logs a where a.resource_id = %L::uuid$$, :'id_a'))
  || ' ' || pg_temp.txt(format($$select bool_and(a.metadata::text not like '%%5511900040%%' and a.metadata::text not like '%%AgIC%%' and a.metadata::text not like '%%CQkJ%%')::text
      from public.audit_logs a where a.resource_id = %L::uuid$$, :'id_a')),
  'whatsapp.identity.changed|true|whatsapp_identity|whatsapp_webhook|phone_number|applied true',
  'auditoria técnica, sem ator, sem telefone, BSUID nem material cifrado'
);
select pg_temp.dom() as dom_a2 \gset
select is(
  (pg_temp.ic(:'e_tok', 'phone_number', :'pa', null, :'na', null) ->> 'outcome') || ' ' || pg_temp.dom(),
  'already_processed ' || :'dom_a2', 'reentrega da mesma entrada: already_processed, nada repetido'
);

-- ---------------------------------------------------------------------
-- 5) Idempotência
-- ---------------------------------------------------------------------

select pg_temp.eo('evt-idem1') as e_i1 \gset
select pg_temp.snap() as snap_i \gset
select pg_temp.txt($$select count(*)::text from public.audit_logs$$) as aud_i \gset
select is(
  (pg_temp.ic(:'e_i1', 'phone_number', :'na', null, :'na', null) ->> 'outcome') || ' ' || (pg_temp.snap() = :'snap_i')::text
  || ' ' || pg_temp.res(:'e_i1') || ' ' || (pg_temp.txt($$select count(*)::text from public.audit_logs$$) = :'aud_i')::text,
  'duplicate true processed|- true',
  'telefone novo já é o da própria identidade: duplicate, nada alterado, sem auditoria, inbox processed'
);
select pg_temp.ic(pg_temp.eo('evt-b1'), 'phone_number', :'pb', :'bi2', :'nb', null) as rb1 \gset
select is(
  (:'rb1'::jsonb ->> 'outcome') || ' ' || (pg_temp.ic(pg_temp.eo('evt-b2'), 'phone_number', :'pb', :'bi2', :'nb', null) ->> 'outcome')
  || ' ' || pg_temp.idn(:'id_b'),
  'applied duplicate ' || :'nb' || '|' || :'bi2',
  'a mesma troca por outro evento (o telefone antigo já saiu, o BSUID a reconhece): duplicate'
);

-- ---------------------------------------------------------------------
-- 6) Telefone e BSUID novos de outra identidade; outro BSUID
-- ---------------------------------------------------------------------

select pg_temp.eo('evt-x1') as e_x1 \gset
select pg_temp.eo('evt-x2') as e_x2 \gset
select pg_temp.eo('evt-x3') as e_x3 \gset
select pg_temp.eo('evt-x4') as e_x4 \gset
select pg_temp.dom() as dom_x \gset
select pg_temp.snap() as snap_x \gset
select is(
  concat_ws(' ',
    pg_temp.ic(:'e_x1', 'phone_number', :'na', null, :'pd', null) ->> 'outcome',
    pg_temp.ic(:'e_x2', 'phone_number', :'na', null, :'na2', :'bi3') ->> 'outcome',
    pg_temp.ic(:'e_x3', 'phone_number', :'nb', :'bi2', :'nb', :'bi5') ->> 'outcome',
    pg_temp.ic(:'e_x4', 'phone_number', :'na', null, :'pd', :'bi3') ->> 'outcome',
    pg_temp.dom(), pg_temp.snap(), pg_temp.res(:'e_x1'), pg_temp.res(:'e_x4')),
  'identity_conflict identity_conflict identity_conflict identity_conflict ' || :'dom_x' || ' ' || :'snap_x'
    || ' processing|' || split_part(:'e_x1', '|', 2) || ' processing|' || split_part(:'e_x4', '|', 2),
  'telefone novo de outra identidade; BSUID novo de outra identidade; outro BSUID na identidade que já tem um; telefone e BSUID de identidades diferentes: identity_conflict, nada alterado, claim intacto'
);
select is(
  (pg_temp.ic(pg_temp.eo('evt-x5'), 'phone_number', :'na', null, :'na2', :'bi4') ->> 'outcome') || ' ' || pg_temp.idn(:'id_a')
  || ' ' || pg_temp.txt(format($$select count(*)::text from public.whatsapp_identities where bsuid_blind_index = decode(%L, 'base64')$$, :'bi4')),
  'applied ' || :'na2' || '|' || :'bi4' || ' 1',
  'identidade sem BSUID e BSUID novo livre: a mesma identidade troca o telefone e ganha o BSUID'
);
select is(
  (pg_temp.ic(pg_temp.eo('evt-x6'), 'phone_number', :'nb', :'bi2', :'nb', :'bi2') ->> 'outcome') || ' ' || pg_temp.idn(:'id_b'),
  'duplicate ' || :'nb' || '|' || :'bi2', 'o mesmo telefone e o mesmo BSUID: duplicate'
);

-- ---------------------------------------------------------------------
-- 7) Identidade anterior: só telefone, só BSUID, os dois, inexistente
-- ---------------------------------------------------------------------

select is(
  (pg_temp.ic(pg_temp.eo('evt-c1'), 'phone_number', null, :'bi3', :'nc', null) ->> 'outcome') || ' ' || pg_temp.idn(:'id_c')
  || ' ' || split_part(pg_temp.cv(:'id_c'), '|', 1),
  'applied ' || :'nc' || '|' || :'bi3' || ' ' || :'nc',
  'anterior só com BSUID: a identidade ganha o telefone novo, e a conversa também'
);
select pg_temp.eo('evt-n1') as e_n1 \gset
select pg_temp.eo('evt-n2') as e_n2 \gset
select pg_temp.eo('evt-n3') as e_n3 \gset
select pg_temp.dom() as dom_n \gset
select pg_temp.snap() as snap_n \gset
select is(
  concat_ws(' ',
    pg_temp.ic(:'e_n1', 'phone_number', '+5511900049999', null, '+5511900049998', null) ->> 'outcome',
    pg_temp.ic(:'e_n2', 'phone_number', null, :'bi6', '+5511900049997', null) ->> 'outcome',
    pg_temp.ic(:'e_n3', 'identity', '+5511900049996', :'bi7', null, null) ->> 'outcome',
    pg_temp.dom(), pg_temp.snap(), pg_temp.res(:'e_n1'), pg_temp.res(:'e_n3'),
    pg_temp.txt($$select count(*)::text from public.whatsapp_identities where phone_e164 like '+55119000499%'$$)),
  'identity_not_found identity_not_found identity_not_found ' || :'dom_n' || ' ' || :'snap_n'
    || ' processing|' || split_part(:'e_n1', '|', 2) || ' processing|' || split_part(:'e_n3', '|', 2) || ' 0',
  'anterior inexistente (telefone, BSUID, os dois): identity_not_found; nada criado, nenhum ledger, inbox em processing, claim intacto'
);
select is(
  (pg_temp.ic(:'e_n1', 'phone_number', :'pd', null, '+5511900040401', null) ->> 'outcome') || ' ' || pg_temp.res(:'e_n1'),
  'applied processed|-', 'identity_not_found é recuperável: o mesmo claim aplica quando a anterior existe'
);
select pg_temp.eo('evt-p1') as e_p1 \gset
select pg_temp.eo('evt-p2') as e_p2 \gset
select pg_temp.snap() as snap_p \gset
select is(
  concat_ws(' ',
    pg_temp.ic(:'e_p1', 'phone_number', :'nb', :'bi3', '+5511900049995', null) ->> 'outcome',
    pg_temp.ic(:'e_p2', 'phone_number', :'nb', :'bi5', '+5511900049995', null) ->> 'outcome',
    (pg_temp.snap() = :'snap_p')::text),
  'identity_conflict identity_conflict true',
  'anterior com telefone e BSUID de identidades diferentes, ou com um BSUID que não é o da identidade do telefone: identity_conflict, sem auto-merge'
);
select is(
  (pg_temp.ic(pg_temp.eo('evt-p3'), 'phone_number', :'nb', :'bi2', '+5511900040202', null) ->> 'outcome') || ' ' || pg_temp.idn(:'id_b'),
  'applied +5511900040202|' || :'bi2', 'anterior com telefone e BSUID da mesma identidade: aplicado, o BSUID fica'
);

-- ---------------------------------------------------------------------
-- 8) Vínculos comerciais: preservados e marcados para revisão
-- ---------------------------------------------------------------------

select pg_temp.cv(:'id_k') as cv_k0 \gset
select is(
  :'cv_k0', :'pk' || '|3f300000-0000-0000-0000-000000000005|3f310000-0000-0000-0000-000000000005|3f320000-0000-0000-0000-000000000005|false|0+1',
  'controle: a conversa K está vinculada a contato, lead e oportunidade, sem revisão'
);
select is(
  (pg_temp.ic(pg_temp.eo('evt-k1'), 'phone_number', :'pk', null, :'nk', null) ->> 'outcome') || ' ' || pg_temp.cv(:'id_k'),
  'applied ' || :'nk' || '|3f300000-0000-0000-0000-000000000005|3f310000-0000-0000-0000-000000000005|3f320000-0000-0000-0000-000000000005|true|0+1',
  'troca de número numa conversa vinculada: vínculos e candidatos preservados, conversa marcada para revisão'
);
select is(
  (pg_temp.com() = :'com0')::text
  || ' ' || pg_temp.txt(format($$select string_agg(value_normalized, ',') from public.contact_phones where contact_id = '3f300000-0000-0000-0000-000000000005'$$))
  || ' ' || pg_temp.txt($$select string_agg(external_id, ',') from public.contact_identifiers where contact_id = '3f300000-0000-0000-0000-000000000005'$$),
  'true ' || :'pk' || ' ' || substr(:'pk', 2),
  'contato, telefones do contato, identificadores, leads, oportunidades e atividades intactos: o telefone do contato não muda sozinho'
);

-- ---------------------------------------------------------------------
-- 9) identity sem a identidade nova: revisão humana
-- ---------------------------------------------------------------------

select pg_temp.idn(:'id_k2') as idn_k2 \gset
select pg_temp.eo('evt-r1') as e_r1 \gset
select is(
  (pg_temp.ic(:'e_r1', 'identity', :'pk2', null, null, null) ->> 'outcome') || ' ' || pg_temp.cv(:'id_k2') || ' ' || pg_temp.idn(:'id_k2')
  || ' ' || pg_temp.res(:'e_r1')
  || ' ' || pg_temp.txt(format($$select count(*)::text from public.whatsapp_effect_ledger where inbox_id = %L::uuid and effect = 'contact.identity_changed'$$, split_part(:'e_r1', '|', 1))),
  'review_required ' || :'pk2' || '|3f300000-0000-0000-0000-000000000006|3f310000-0000-0000-0000-000000000006|3f320000-0000-0000-0000-000000000006|true|0+1 '
    || :'idn_k2' || ' processed|- 1',
  'identity sem a nova: review_required; conversa para revisão, vínculos preservados, telefone e BSUID intactos, ledger gravado, inbox processed'
);
select pg_temp.txt($$select count(*)::text from public.audit_logs$$) as aud_r \gset
select pg_temp.txt($$select count(*)::text from public.whatsapp_identities$$) as nid_r \gset
select is(
  (pg_temp.ic(pg_temp.eo('evt-r2'), 'identity', :'pk2', null, null, null) ->> 'outcome')
  || ' ' || pg_temp.txt(format($$select string_agg(action || '|' || (metadata ->> 'outcome'), ',') from public.audit_logs where resource_id = %L::uuid$$, :'id_k2'))
  || ' ' || (pg_temp.txt($$select count(*)::text from public.audit_logs$$) = :'aud_r')::text
  || ' ' || (pg_temp.txt($$select count(*)::text from public.whatsapp_identities$$) = :'nid_r')::text,
  'review_required whatsapp.identity.review_required|review_required true true',
  'outro identity para a conversa já em revisão: review_required, sem auditoria duplicada, nenhuma identidade nova'
);

-- ---------------------------------------------------------------------
-- 10) Status ATUAL do canal, reconferido no efeito
-- ---------------------------------------------------------------------

select pg_temp.idc(pg_temp.ob(pg_temp.entrada(:'ch_s', :'ws_um', 'b3d2b2b3a-s', 'evt-s0', 'whatsapp.smb.message.echoes'), 'pm-s0', '+5511900043001')) as id_s \gset

create function pg_temp.chs(p_status text, p_evt text) returns text language plpgsql as $f$
declare
  v_entry text;
  v_dom text;
  v_snap text;
  v jsonb;
begin
  update public.whatsapp_channels set status = 'active', status_changed_at = now() where id = '3e200000-0000-0000-0000-000000000004';
  v_entry := pg_temp.entrada('3e200000-0000-0000-0000-000000000004', '10000000-0000-0000-0000-000000000001', 'b3d2b2b3a-s', p_evt);
  update public.whatsapp_channels set status = p_status, send_enabled = false, status_changed_at = now()
  where id = '3e200000-0000-0000-0000-000000000004';
  v_dom := pg_temp.dom();
  v_snap := pg_temp.snap();
  v := pg_temp.ic(v_entry, 'phone_number', '+5511900043001', null, '+5511900043002', null);
  return coalesce(v::text, 'NULL') || ' ' || (pg_temp.dom() = v_dom and pg_temp.snap() = v_snap)::text
    || ' ' || (pg_temp.res(v_entry) = 'processing|' || split_part(v_entry, '|', 2))::text;
end
$f$;

select is(
  concat_ws(' / ', pg_temp.chs('paused', 'evt-s1'), pg_temp.chs('disconnected', 'evt-s2'), pg_temp.chs('disabled', 'evt-s3')),
  '{"outcome": "channel_paused"} true true / {"outcome": "channel_disconnected"} true true / {"outcome": "channel_disabled"} true true',
  'canal pausado, desconectado ou desativado depois do claim: channel_*; nenhum ledger, identidade, conversa ou auditoria; claim intacto'
);
select id::text || '|' || coalesce(claim_token::text, :'nulo') as e_s3
from public.whatsapp_webhook_inbox where provider_event_id = 'evt-s3' and channel_id = :'ch_s'::uuid \gset
set local role service_role;
select coalesce(public.whatsapp_inbox_release(split_part(:'e_s3', '|', 1)::uuid, split_part(:'e_s3', '|', 2)::uuid, 'channel_disabled') ->> 'outcome', 'NULL') as rel_s3 \gset
reset role;
select is(:'rel_s3'::text, 'released', 'o claim recusado pelo estado do canal ainda pode ser liberado');
update public.whatsapp_channels set status = 'active', status_changed_at = now() where id = :'ch_s'::uuid;
select is(
  (pg_temp.ic(pg_temp.entrada(:'ch_s', :'ws_um', 'b3d2b2b3a-s', 'evt-s4'), 'phone_number', '+5511900043001', null, '+5511900043002', null) ->> 'outcome')
  || ' ' || pg_temp.idn(:'id_s'),
  'applied +5511900043002|-', 'controle: canal ativo no momento do efeito aplica normalmente'
);

-- ---------------------------------------------------------------------
-- 11) Ledger: outro efeito na chave estável, ou o mesmo já reservado
-- ---------------------------------------------------------------------

select pg_temp.eo('evt-g1') as e_g1 \gset
select pg_temp.eo('evt-g2') as e_g2 \gset
insert into public.whatsapp_effect_ledger (environment, workspace_id, channel_id, provider, provider_event_id, effect, inbox_id) values
  ('preview', :'ws_um'::uuid, :'ch_o'::uuid, 'simulated', 'evt-g1', 'message.inbound', split_part(:'e_g1', '|', 1)::uuid),
  ('preview', :'ws_um'::uuid, :'ch_o'::uuid, 'simulated', 'evt-g2', 'contact.identity_changed', split_part(:'e_g2', '|', 1)::uuid);
select pg_temp.dom() as dom_g \gset
select pg_temp.snap() as snap_g \gset
select is(
  pg_temp.ic(:'e_g1', 'phone_number', :'pk3', null, :'nk3', null)::text || ' ' || pg_temp.dom() || ' ' || (pg_temp.snap() = :'snap_g')::text || ' ' || pg_temp.res(:'e_g1'),
  '{"outcome": "effect_conflict"} ' || :'dom_g' || ' true processing|' || split_part(:'e_g1', '|', 2),
  'a chave estável já tem outro efeito: effect_conflict, nada escrito, claim intacto'
);
select is(
  (pg_temp.ic(:'e_g2', 'phone_number', :'pk3', null, :'nk3', null) ->> 'outcome') || ' ' || pg_temp.dom() || ' ' || (pg_temp.snap() = :'snap_g')::text || ' ' || pg_temp.res(:'e_g2'),
  'duplicate ' || :'dom_g' || ' true processed|-',
  'o mesmo efeito já reservado para a entrada: duplicate, nada repetido, entrada finalizada'
);

-- ---------------------------------------------------------------------
-- 12) Atomicidade: falha depois do ledger, ao atualizar a conversa
-- ---------------------------------------------------------------------

create function public.t39_falha_simulada() returns trigger language plpgsql as $f$
begin
  if old.wa_id = '+5511900040007' then
    raise exception 'falha_simulada';
  end if;
  return new;
end
$f$;
create trigger t39_falha_simulada before update on public.conversations for each row execute function public.t39_falha_simulada();
select pg_temp.eo('evt-z1') as e_z1 \gset
select pg_temp.dom() as dom_z \gset
select pg_temp.snap() as snap_z \gset
select is(
  (pg_temp.ic(:'e_z1', 'phone_number', :'pk3', null, :'nk3', :'bi6') ->> 'erro') || ' ' || pg_temp.dom() || ' ' || (pg_temp.snap() = :'snap_z')::text
  || ' ' || pg_temp.res(:'e_z1') || ' ' || pg_temp.idn(:'id_k3'),
  'falha_simulada ' || :'dom_z' || ' true processing|' || split_part(:'e_z1', '|', 2) || ' ' || :'pk3' || '|-',
  'falha ao atualizar a conversa, depois do ledger, do telefone e do BSUID: nada sobrevive e o claim continua'
);
drop trigger t39_falha_simulada on public.conversations;
select is(
  (pg_temp.ic(:'e_z1', 'phone_number', :'pk3', null, :'nk3', :'bi6') ->> 'outcome') || ' ' || pg_temp.idn(:'id_k3') || ' ' || split_part(pg_temp.cv(:'id_k3'), '|', 1),
  'applied ' || :'nk3' || '|' || :'bi6' || ' ' || :'nk3', 'sem a falha, a mesma entrada aplica normalmente'
);

-- ---------------------------------------------------------------------
-- 13) A guarda das identidades continua valendo fora do efeito
-- ---------------------------------------------------------------------

select is(
  pg_temp.txt(format($$with x as (update public.whatsapp_identities set phone_e164 = '+5511900049990' where id = %L::uuid returning 1) select count(*)::text from x$$, :'id_d'))
  || ' ' || pg_temp.txt(format($$with x as (update public.whatsapp_identities set bsuid_blind_index = decode(%L, 'base64'), bsuid_ciphertext = decode('CQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQ==', 'base64'), bsuid_key_version = '1'
      where id = %L::uuid returning 1) select count(*)::text from x$$, :'bi7', :'id_b')),
  'ERRO:P0001:identity_immutable ERRO:P0001:identity_immutable',
  'fora do efeito, trocar o telefone ou o BSUID de uma identidade continua proibido'
);

-- ---------------------------------------------------------------------
-- 14) Isolamento: outro workspace e Production
-- ---------------------------------------------------------------------

select pg_temp.idc(pg_temp.ob(pg_temp.entrada(:'ch_b', :'ws_dois', 'b3d2b2b3a-b', 'evt-base-bb', 'whatsapp.smb.message.echoes'), 'pm-bb', :'pk2')) as id_bb \gset
select is(
  (pg_temp.ic(pg_temp.entrada(:'ch_b', :'ws_dois', 'b3d2b2b3a-b', 'evt-iso'), 'phone_number', :'pk2', null, '+5511900040601', null) ->> 'outcome')
  || ' ' || pg_temp.idn(:'id_bb') || ' ' || pg_temp.idn(:'id_k2'),
  'applied +5511900040601|- ' || :'idn_k2',
  'o mesmo telefone em outro workspace: só a identidade do canal da entrada muda'
);
select set_config('request.headers', :'h_prod', true);
select pg_temp.entrada(:'ch_prod', :'ws_um', 'b3d2b2b3a-prod', 'evt-prod') as e_prod \gset
select set_config('request.headers', :'h_prev', true);
select is(pg_temp.ic(:'e_prod', 'phone_number', :'pk2', null, '+5511900040602', null) ->> 'outcome', 'not_found',
  'a entrada de Production não é alcançada a partir de Preview');

-- ---------------------------------------------------------------------
-- 15) Nada comercial; auditoria e respostas sem dado pessoal
-- ---------------------------------------------------------------------

select is(
  (pg_temp.com() = :'com0')::text
  || ' ' || pg_temp.txt($$select count(*)::text from public.audit_logs where action like 'whatsapp.identity.%'
      and (metadata::text ~ '\+?55119000[0-9]{5}' or metadata::text ~ '[A-Za-z0-9+/]{40,}={0,2}' or actor_user_id is not null)$$)
  || ' ' || pg_temp.txt($$select count(*)::text from public.audit_logs where action in ('contact.created', 'lead.created', 'opportunity.created', 'activity.auto_created') and created_at >= now()$$),
  'true 0 0',
  'nenhum registro comercial criado ou alterado; nenhuma auditoria com telefone, BSUID, cifra ou ator'
);
select is(
  pg_temp.txt($$select count(*)::text from public.whatsapp_effect_ledger where effect = 'contact.identity_changed' and message_id is not null$$),
  '0', 'o ledger da mudança de identidade não aponta para mensagem'
);

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'ana', 'role', 'authenticated')::text, true);
select is(
  pg_temp.txt(format($$select public.whatsapp_effect_identity_change(%L::uuid, %L::uuid, 'identity', now(), '+5511900040001', null, null, null, null, null, null)::text$$, :'inventado', :'inventado')) like 'ERRO:42501%',
  true, 'authenticated não executa o efeito'
);
reset role;

select * from finish();
rollback;
