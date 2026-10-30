-- pgTAP — B3.2d-2b2b2: efeito atômico de STATUS e CUSTO de uma mensagem de
-- saída já gravada (NormalizedStatusUpdate).
--
-- public.whatsapp_effect_message_status, numa transação só e sob a trava
-- da inbox:
--  - inbox no ambiente autenticado, em processing, com o token do claim e a
--    lease vigente; canal da linha ainda ativo; workspace, canal, ambiente,
--    provedor e evento vêm da linha da inbox, nunca do chamador;
--  - reserva message.status no ledger;
--  - localiza a mensagem de saída do mesmo canal pelo id do provedor e pelo
--    wamid, nunca pelo externalId sozinho; identificadores divergentes,
--    mensagem recebida ou outro destinatário → message_conflict;
--  - mensagem ainda inexistente → message_not_found recuperável: nada
--    gravado, claim intacto, reaplicável depois;
--  - status igual a projectWhatsAppMessageStatus; erro do provedor só como
--    código; custo igual a projectWhatsAppProviderCost (o final nunca muda;
--    final conflitante → cost_conflict; só o final é cobrado);
--  - externalId opaco: preenche quando vazio, conflito falha fechado, não
--    muda origem, classificação nem autoria;
--  - nunca cria mensagem, conversa, identidade, contato, lead, oportunidade
--    ou atividade; inbox processed junto com o efeito; qualquer falha
--    desfaz tudo.
--
-- Seção 20 (id do provedor de até 255 caracteres, o contrato interno):
-- escrita antes da correção do adaptador, sobre 7eb4be6.
--
-- Escrito ANTES da implementação, contra a main 7159941. Tudo fictício:
-- nenhum telefone, BSUID, custo ou identidade real. As chamadas passam por
-- funções que capturam o erro: contra a main, o arquivo roda até o fim.

begin;
select plan(66);

\set ana     '20000000-0000-0000-0000-000000000001'
\set ws_um   '10000000-0000-0000-0000-000000000001'
\set ws_dois '10000000-0000-0000-0000-000000000002'
\set ch_o    '3e100000-0000-0000-0000-000000000001'
\set ch_b    '3e100000-0000-0000-0000-000000000002'
\set ch_prod '3e100000-0000-0000-0000-000000000003'
\set ch_s    '3e100000-0000-0000-0000-000000000004'
\set nulo    '00000000-0000-0000-0000-000000000000'
\set inventado '7d1e2f3a-4b5c-4d6e-8f70-819a2b3c4d5f'
\set cifra   'QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFB'
\set bi2     'AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI='
\set bi3     'AwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwM='
\set bi4     'BAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQ='
\set bi5     'BQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQU='
\set bi6     'BgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgY='
\set bi7     'BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc='
\set p1      '+5511900030001'
\set p2      '+5511900030002'
\set p4      '+5511900030004'
\set p7      '+5511900030007'

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
-- um de Production no Escritório Um.
set local role service_role;
select whatsapp_create_simulated_channel(:'ch_o'::uuid, :'ws_um'::uuid, :'ana'::uuid, 'O', 'b3d2b2b2-o', '1', :'cifra', '1') is not null as ok \gset
select whatsapp_create_simulated_channel(:'ch_s'::uuid, :'ws_um'::uuid, :'ana'::uuid, 'S', 'b3d2b2b2-s', '1', :'cifra', '1') is not null as ok \gset
select whatsapp_create_simulated_channel(:'ch_b'::uuid, :'ws_dois'::uuid, '20000000-0000-0000-0000-000000000002'::uuid, 'B', 'b3d2b2b2-b', '1', :'cifra', '1') is not null as ok \gset
select set_config('request.headers', :'h_prod', true);
select whatsapp_create_simulated_channel(:'ch_prod'::uuid, :'ws_um'::uuid, :'ana'::uuid, 'Prod', 'b3d2b2b2-prod', '1', :'cifra', '1') is not null as ok \gset
select set_config('request.headers', :'h_prev', true);
reset role;

-- Entrada da inbox (cifra fictícia) e claim, como service_role: devolve
-- 'id|token'.
create function pg_temp.entrada(p_ch text, p_ws text, p_routing text, p_evt text,
  p_type text default 'whatsapp.message.updated', p_claim boolean default true) returns text language plpgsql as $f$
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
create function pg_temp.eo(p_evt text, p_type text default 'whatsapp.message.updated') returns text language sql as $f$
  select pg_temp.entrada('3e100000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'b3d2b2b2-o', p_evt, p_type)
$f$;

-- Saída observada da 2b2b1 (para mensagens e conversas reais do caminho
-- B3): o jsonb devolvido, ou {"erro": <mensagem>}.
create function pg_temp.ob(p_entry text, p_pmid text, p_wamid text, p_phone text, p_lookup text default null) returns jsonb language plpgsql as $f$
declare
  v jsonb;
begin
  execute 'set local role service_role';
  execute format(
    'select public.whatsapp_effect_outbound_observed(%L::uuid, %L::uuid, %L, %L, ''text'', ''Mensagem fictícia do escritório'', now(), %L, %L::jsonb, %L, %L)',
    split_part(p_entry, '|', 1), split_part(p_entry, '|', 2), p_pmid, p_wamid, p_phone, p_lookup,
    case when p_lookup is null then null else 'CQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQ==' end,
    case when p_lookup is null then null else '1' end) into v;
  execute 'reset role';
  return coalesce(v, 'null'::jsonb);
exception when others then
  return jsonb_build_object('erro', sqlerrm);
end
$f$;

-- Efeito de status como service_role: o jsonb devolvido, ou
-- {"erro": <mensagem>}.
create function pg_temp.st(p_entry text, p_pmid text, p_wamid text, p_status text,
  p_at text default '2026-10-30 12:00:00+00', p_ext text default null, p_err text default null,
  p_phone text default null, p_lookup text default null,
  p_amount text default null, p_cur text default null, p_cat text default null, p_fin text default null,
  p_token text default null) returns jsonb language plpgsql as $f$
declare
  v jsonb;
begin
  execute 'set local role service_role';
  execute format(
    'select public.whatsapp_effect_message_status(%L::uuid, %L::uuid, %L, %L, %L, %L, %L, %L::timestamptz, %L, %L::jsonb, %L, %L, %L::numeric, %L, %L, %L)',
    split_part(p_entry, '|', 1), coalesce(p_token, nullif(split_part(p_entry, '|', 2), '-')), p_pmid, p_wamid, p_ext, p_status, p_err, p_at,
    p_phone, p_lookup,
    case when p_lookup is null then null else 'CQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQ==' end,
    case when p_lookup is null then null else '1' end,
    p_amount, p_cur, p_cat, p_fin) into v;
  execute 'reset role';
  return coalesce(v, 'null'::jsonb);
exception when others then
  return jsonb_build_object('erro', sqlerrm);
end
$f$;

-- Mensagem de saída gravada direto numa conversa existente, no estado
-- pedido (status e custo de partida); devolve o id.
create function pg_temp.mk(p_conv text, p_pm text, p_wamid text, p_status text,
  p_amount text default null, p_cur text default null, p_fin text default null, p_cat text default null,
  p_ext text default null, p_err text default null,
  p_origin text default 'business_app', p_class text default 'internal') returns text language plpgsql as $f$
declare
  v text;
begin
  insert into public.messages (
    workspace_id, conversation_id, channel_id, direction, origin, sender_classification, content_kind, body_text,
    provider, provider_message_id, wa_message_id, provider_external_id, status, status_updated_at, error_reason,
    provider_cost_amount, provider_cost_currency, provider_cost_finality, provider_cost_category
  )
  select c.workspace_id, c.id, c.channel_id, 'outbound', p_origin::public.whatsapp_message_origin,
    p_class::public.whatsapp_sender_classification, 'text', 'Mensagem fictícia (status)',
    ch.provider, p_pm, p_wamid, p_ext, p_status::public.message_status, '2026-10-30 10:00:00+00', p_err,
    p_amount::numeric, p_cur, p_fin, p_cat
  from public.conversations c join public.whatsapp_channels ch on ch.id = c.channel_id
  where c.id = p_conv::uuid
  returning id::text into v;
  return coalesce(v, '00000000-0000-0000-0000-000000000000');
end
$f$;

create function pg_temp.res(p_entry text) returns text language sql as $f$
  select state || '|' || coalesce(claim_token::text, '-') from public.whatsapp_webhook_inbox where id = split_part(p_entry, '|', 1)::uuid
$f$;

-- Contagens do domínio, sem e com o ledger (para provar "nada mudou").
create function pg_temp.domx() returns text language sql as $f$
  select concat_ws('|',
    (select count(*) from public.whatsapp_identities), (select count(*) from public.conversations),
    (select count(*) from public.messages), (select count(*) from public.contacts),
    (select count(*) from public.leads), (select count(*) from public.opportunities),
    (select count(*) from public.activities), (select count(*) from public.audit_logs))
$f$;
create function pg_temp.dom() returns text language sql as $f$
  select pg_temp.domx() || '|' || (select count(*) from public.whatsapp_effect_ledger)
$f$;

-- Retrato de todos os registros comerciais (linhas inteiras).
create function pg_temp.com() returns text language sql as $f$
  select md5(concat_ws('#',
    (select string_agg(x::text, ',' order by x::text) from public.contacts x),
    (select string_agg(x::text, ',' order by x::text) from public.contact_phones x),
    (select string_agg(x::text, ',' order by x::text) from public.contact_identifiers x),
    (select string_agg(x::text, ',' order by x::text) from public.leads x),
    (select string_agg(x::text, ',' order by x::text) from public.opportunities x),
    (select string_agg(x::text, ',' order by x::text) from public.activities x)))
$f$;

-- Linha inteira da mensagem (para provar que nada mudou).
create function pg_temp.mrow(p_id text) returns text language sql as $f$
  select coalesce((select md5(m::text) from public.messages m where m.id = p_id::uuid), 'NULL')
$f$;

-- Status e custo: status|erro|valor|moeda|categoria|finalidade|cobrado.
create function pg_temp.ms(p_id text) returns text language sql as $f$
  select coalesce((select concat_ws('|', m.status, coalesce(m.error_reason, '-'), coalesce(m.provider_cost_amount::text, '-'),
         coalesce(m.provider_cost_currency, '-'), coalesce(m.provider_cost_category, '-'), coalesce(m.provider_cost_finality, '-'),
         coalesce(m.provider_cost_billable_amount::text, '-'))
       from public.messages m where m.id = p_id::uuid), 'NULL')
$f$;

-- Identificadores: id do provedor|wamid|provedor|externalId.
create function pg_temp.mids(p_id text) returns text language sql as $f$
  select coalesce((select concat_ws('|', coalesce(m.provider_message_id, '-'), coalesce(m.wa_message_id, '-'),
         coalesce(m.provider::text, '-'), coalesce(m.provider_external_id, '-'))
       from public.messages m where m.id = p_id::uuid), 'NULL')
$f$;

-- Origem e autoria: direção|origem|classificação|sem autor|correlação|ref|sem chave de reenvio.
create function pg_temp.morig(p_id text) returns text language sql as $f$
  select coalesce((select concat_ws('|', m.direction, m.origin, m.sender_classification, (m.sent_by is null)::text,
         coalesce(m.origin_correlation_kind, '-'), coalesce(m.origin_correlation_ref, '-'), (m.client_dedupe_key is null)::text)
       from public.messages m where m.id = p_id::uuid), 'NULL')
$f$;

-- Horário do status efetivo (UTC, HH:MI).
create function pg_temp.mat(p_id text) returns text language sql as $f$
  select coalesce((select to_char(m.status_updated_at at time zone 'UTC', 'HH24:MI') from public.messages m where m.id = p_id::uuid), 'NULL')
$f$;

create function pg_temp.ident(p_where text) returns text language plpgsql as $f$
declare
  v text;
begin
  execute format('select coalesce(phone_e164, ''-'') || ''|'' || coalesce(encode(bsuid_blind_index, ''base64''), ''-'')
    from public.whatsapp_identities where %s', p_where) into v;
  return coalesce(v, 'NULL');
end
$f$;

-- Conversas e identidades de partida, pelo caminho real da B3:
--   conv1: telefone p1, sem BSUID;
--   conv2: telefone p2 + BSUID bi2;
--   conv3: só BSUID bi3;
--   conv4: telefone p4, sem BSUID;
--   uma mensagem RECEBIDA (2b2a) e uma conversa no canal B (outro workspace).
select coalesce(pg_temp.ob(pg_temp.eo('evt-base1', 'whatsapp.smb.message.echoes'), 'pm-base1', null, :'p1') ->> 'conversation_id', :'nulo') as conv1 \gset
select coalesce(pg_temp.ob(pg_temp.eo('evt-base2', 'whatsapp.smb.message.echoes'), 'pm-base2', null, :'p2', format('{"1": "%s"}', :'bi2')) ->> 'conversation_id', :'nulo') as conv2 \gset
select coalesce(pg_temp.ob(pg_temp.eo('evt-base3', 'whatsapp.smb.message.echoes'), 'pm-base3', null, null, format('{"1": "%s"}', :'bi3')) ->> 'conversation_id', :'nulo') as conv3 \gset
select coalesce(pg_temp.ob(pg_temp.eo('evt-base4', 'whatsapp.smb.message.echoes'), 'pm-base4', null, :'p4') ->> 'conversation_id', :'nulo') as conv4 \gset
set local role service_role;
select pg_temp.eo('evt-in-1', 'whatsapp.inbound_message.received') as e_in \gset
select coalesce(public.whatsapp_effect_inbound_message(split_part(:'e_in', '|', 1)::uuid, split_part(:'e_in', '|', 2)::uuid, 'pm-in-1', 'text',
  'Mensagem fictícia recebida', now(), '+5511900030009', null, null, null, null) ->> 'message_id', :'nulo') as m_in \gset
reset role;
select coalesce(pg_temp.ob(pg_temp.entrada(:'ch_b', :'ws_dois', 'b3d2b2b2-b', 'evt-base-b', 'whatsapp.smb.message.echoes'), 'pm-base-b', null, :'p1') ->> 'conversation_id', :'nulo') as conv_b \gset
select pg_temp.com() as com0 \gset

-- ---------------------------------------------------------------------
-- 1) Estrutura e permissões
-- ---------------------------------------------------------------------

select is(
  pg_temp.txt($$select pg_get_function_identity_arguments('public.whatsapp_effect_message_status'::regproc)$$),
  'p_inbox_id uuid, p_claim_token uuid, p_provider_message_id text, p_wa_message_id text, p_external_id text, p_status text, p_error_code text, p_occurred_at timestamp with time zone, p_phone_e164 text, p_bsuid_lookup jsonb, p_bsuid_ciphertext text, p_bsuid_key_version text, p_cost_amount numeric, p_cost_currency text, p_cost_category text, p_cost_finality text',
  'assinatura: inbox, token e só os dados do status — nenhum workspace, canal, ambiente, provedor, evento, origem ou autor do chamador'
);
select is(
  pg_temp.txt($$select (p.prosecdef and exists (select 1 from unnest(p.proconfig) c where c = 'search_path=""'))::text
    from pg_proc p where p.oid = 'public.whatsapp_effect_message_status'::regproc$$),
  'true', 'SECURITY DEFINER com search_path vazio'
);
select is(
  pg_temp.txt($$select has_function_privilege('service_role', 'public.whatsapp_effect_message_status'::regproc, 'execute')::text || ' '
    || has_function_privilege('authenticated', 'public.whatsapp_effect_message_status'::regproc, 'execute')::text || ' '
    || has_function_privilege('anon', 'public.whatsapp_effect_message_status'::regproc, 'execute')::text$$),
  'true false false', 'EXECUTE só para service_role'
);

-- ---------------------------------------------------------------------
-- 2) Claim: estado, token, lease e ambiente
-- ---------------------------------------------------------------------

select pg_temp.mk(:'conv1', 'pm-claim', null, 'sent') as m_claim \gset
select pg_temp.entrada(:'ch_o', :'ws_um', 'b3d2b2b2-o', 'evt-pend', 'whatsapp.message.updated', false) as e_pend \gset
select pg_temp.eo('evt-tok') as e_tok \gset
select pg_temp.eo('evt-lease') as e_lease \gset
select pg_temp.dom() as dom0 \gset
select pg_temp.mrow(:'m_claim') as row_claim \gset

select is(pg_temp.st(:'e_pend', 'pm-claim', null, 'delivered') ->> 'outcome', 'claim_lost', 'entrada sem claim (pending): claim_lost');
select is(
  (pg_temp.st(:'e_tok', 'pm-claim', null, 'delivered', p_token => :'inventado') ->> 'outcome') || ' ' ||
  (pg_temp.st(split_part(:'e_tok', '|', 1) || '|-', 'pm-claim', null, 'delivered') ->> 'outcome'),
  'claim_lost claim_lost', 'token inventado ou ausente: claim_lost'
);
update public.whatsapp_webhook_inbox set claimed_at = clock_timestamp() - interval '10 minutes', lease_until = clock_timestamp() - interval '1 second'
where id = split_part(:'e_lease', '|', 1)::uuid;
select is(pg_temp.st(:'e_lease', 'pm-claim', null, 'delivered') ->> 'outcome', 'claim_lost', 'lease vencida: claim_lost');
select set_config('request.headers', :'h_prod', true);
select is(pg_temp.st(:'e_tok', 'pm-claim', null, 'delivered') ->> 'outcome', 'not_found', 'autenticado em outro ambiente: not_found');
select set_config('request.headers', '', true);
select is(pg_temp.st(:'e_tok', 'pm-claim', null, 'delivered') ->> 'erro', 'whatsapp_environment_required', 'sem ambiente autenticado: recusado');
select set_config('request.headers', :'h_prev', true);
select is(pg_temp.st(:'inventado' || '|' || :'inventado', 'pm-claim', null, 'delivered') ->> 'outcome', 'not_found', 'inbox inexistente: not_found');
select is(
  pg_temp.dom() || ' ' || pg_temp.mrow(:'m_claim') || ' ' || pg_temp.res(:'e_tok') || ' ' || pg_temp.res(:'e_pend'),
  :'dom0' || ' ' || :'row_claim' || ' processing|' || split_part(:'e_tok', '|', 2) || ' pending|-',
  'nenhuma recusa escreveu nada, mexeu na mensagem ou na inbox'
);

-- ---------------------------------------------------------------------
-- 3) Entrada inválida: recusada antes de qualquer trava ou escrita
-- ---------------------------------------------------------------------

select is(
  concat_ws(' ',
    pg_temp.st(:'e_tok', 'pm-claim', null, 'queued') ->> 'erro',
    pg_temp.st(:'e_tok', 'pm-claim', null, 'lido') ->> 'erro',
    pg_temp.st(:'e_tok', 'pm-claim', null, null) ->> 'erro',
    pg_temp.st(:'e_tok', 'pm claim', null, 'delivered') ->> 'erro',
    pg_temp.st(:'e_tok', null, null, 'delivered') ->> 'erro'),
  'invalid_status_update invalid_status_update invalid_status_update invalid_status_update invalid_status_update',
  'status queued, desconhecido ou ausente; id do provedor com espaço ou ausente: invalid_status_update'
);
select is(
  concat_ws(' ',
    pg_temp.st(:'e_tok', 'pm-claim', 'HBgNsemprefixo', 'delivered') ->> 'erro',
    pg_temp.st(:'e_tok', 'pm-claim', 'wamid.' || repeat('A', 513), 'delivered') ->> 'erro',
    pg_temp.st(:'e_tok', 'pm-claim', null, 'delivered', p_at => null) ->> 'erro',
    pg_temp.st(:'e_tok', 'pm-claim', null, 'delivered', p_at => 'infinity') ->> 'erro',
    pg_temp.st(:'e_tok', 'pm-claim', null, 'failed', p_err => 'Message failed to send') ->> 'erro',
    pg_temp.st(:'e_tok', 'pm-claim', null, 'failed', p_err => repeat('e', 65)) ->> 'erro'),
  'invalid_status_update invalid_status_update invalid_status_update invalid_status_update invalid_status_update invalid_status_update',
  'wamid sem prefixo ou com 519 caracteres, horário ausente ou infinito, erro com texto livre ou longo demais: invalid_status_update'
);
select is(
  concat_ws(' ',
    pg_temp.st(:'e_tok', 'pm-claim', null, 'delivered', p_ext => 'ext' || chr(10) || 'quebra') ->> 'erro',
    pg_temp.st(:'e_tok', 'pm-claim', null, 'delivered', p_ext => repeat('x', 513)) ->> 'erro',
    pg_temp.st(:'e_tok', 'pm-claim', null, 'delivered', p_ext => '') ->> 'erro',
    pg_temp.st(:'e_tok', 'pm-claim', null, 'delivered', p_lookup => '{"1": "AQID"}') ->> 'erro',
    pg_temp.st(:'e_tok', 'pm-claim', null, 'delivered', p_phone => '11900030001') ->> 'erro'),
  'invalid_status_update invalid_status_update invalid_status_update invalid_status_update invalid_status_update',
  'externalId com caractere de controle, com 513 caracteres ou vazio; índice cego fora de 32 bytes; telefone fora do E.164: invalid_status_update'
);
select is(
  concat_ws(' ',
    pg_temp.st(:'e_tok', 'pm-claim', null, 'delivered', p_amount => '0.01') ->> 'erro',
    pg_temp.st(:'e_tok', 'pm-claim', null, 'delivered', p_cur => 'BRL', p_fin => 'final') ->> 'erro',
    pg_temp.st(:'e_tok', 'pm-claim', null, 'delivered', p_amount => '-0.01', p_cur => 'BRL', p_fin => 'final') ->> 'erro',
    pg_temp.st(:'e_tok', 'pm-claim', null, 'delivered', p_amount => 'NaN', p_cur => 'BRL', p_fin => 'final') ->> 'erro',
    pg_temp.st(:'e_tok', 'pm-claim', null, 'delivered', p_amount => '1000000000000', p_cur => 'BRL', p_fin => 'final') ->> 'erro',
    pg_temp.st(:'e_tok', 'pm-claim', null, 'delivered', p_amount => '0.01', p_cur => 'brl', p_fin => 'final') ->> 'erro',
    pg_temp.st(:'e_tok', 'pm-claim', null, 'delivered', p_amount => '0.01', p_cur => 'BRL', p_fin => 'final', p_cat => 'Marketing') ->> 'erro',
    pg_temp.st(:'e_tok', 'pm-claim', null, 'delivered', p_amount => '0.01', p_cur => 'BRL', p_fin => 'quase') ->> 'erro',
    pg_temp.st(:'e_tok', 'pm-claim', null, 'sent', p_amount => '0.01', p_cur => 'BRL', p_fin => 'final') ->> 'erro',
    pg_temp.st(:'e_tok', 'pm-claim', null, 'delivered', p_cat => 'marketing') ->> 'erro'),
  'invalid_status_update invalid_status_update invalid_status_update invalid_status_update invalid_status_update invalid_status_update invalid_status_update invalid_status_update invalid_status_update invalid_status_update',
  'custo parcial, negativo, NaN, grande demais, moeda fora do ISO 4217, categoria malformada, finalidade desconhecida, final antes da entrega ou categoria sem valor: invalid_status_update'
);
select is(
  pg_temp.dom() || ' ' || pg_temp.mrow(:'m_claim') || ' ' || pg_temp.res(:'e_tok'),
  :'dom0' || ' ' || :'row_claim' || ' processing|' || split_part(:'e_tok', '|', 2),
  'entrada inválida: nada escrito, mensagem e claim intactos'
);

-- ---------------------------------------------------------------------
-- 4) accepted → sent → delivered → read
-- ---------------------------------------------------------------------

select pg_temp.mk(:'conv1', 'pm-prog', 'wamid.PROG', 'accepted') as m_prog \gset
select pg_temp.domx() as domx_p \gset
select pg_temp.eo('evt-p1') as e_p1 \gset
select pg_temp.eo('evt-p2') as e_p2 \gset
select pg_temp.eo('evt-p3') as e_p3 \gset
select pg_temp.st(:'e_p1', 'pm-prog', 'wamid.PROG', 'sent', '2026-10-30 10:01:00+00') as rp1 \gset
select pg_temp.st(:'e_p2', 'pm-prog', null, 'delivered', '2026-10-30 10:02:00+00') as rp2 \gset
select pg_temp.st(:'e_p3', 'pm-prog', 'wamid.PROG', 'read', '2026-10-30 10:03:00+00') as rp3 \gset
select is(
  (:'rp1'::jsonb ->> 'outcome') || ' ' || (:'rp2'::jsonb ->> 'outcome') || ' ' || (:'rp3'::jsonb ->> 'outcome')
  || ' ' || pg_temp.ms(:'m_prog') || ' ' || pg_temp.mat(:'m_prog'),
  'applied applied applied read|-|-|-|-|-|- 10:03',
  'accepted → sent → delivered → read: cada passo aplicado; o horário acompanha o evento'
);
select is(
  pg_temp.txt(format($$select string_agg(k, ',' order by k) from jsonb_object_keys(%L::jsonb) k$$, :'rp3'))
  || ' ' || ((:'rp3'::jsonb ->> 'message_id') = :'m_prog')::text,
  'message_id,outcome true', 'resultado só com o id da mensagem — nenhum telefone, BSUID, custo ou erro'
);
select is(
  pg_temp.txt(format($$select string_agg(l.effect || ':' || (l.message_id = %L::uuid) || ':' || l.provider_event_id || ':' || l.environment || ':' || (l.channel_id = %L::uuid), ',' order by l.provider_event_id)
    from public.whatsapp_effect_ledger l where l.inbox_id in (%L::uuid, %L::uuid, %L::uuid)$$,
    :'m_prog', :'ch_o', split_part(:'e_p1', '|', 1), split_part(:'e_p2', '|', 1), split_part(:'e_p3', '|', 1)))
  || ' ' || pg_temp.res(:'e_p1') || ' ' || pg_temp.res(:'e_p2') || ' ' || pg_temp.res(:'e_p3')
  || ' ' || (pg_temp.domx() = :'domx_p')::text,
  'message.status:true:evt-p1:preview:true,message.status:true:evt-p2:preview:true,message.status:true:evt-p3:preview:true processed|- processed|- processed|- true',
  'ledger message.status com o contexto da inbox e a mensagem; inbox processed; nenhuma mensagem, conversa, identidade ou auditoria nova'
);
select pg_temp.dom() as dom_p3 \gset
select is(
  (pg_temp.st(:'e_p3', 'pm-prog', 'wamid.PROG', 'read', '2026-10-30 10:03:00+00') ->> 'outcome') || ' ' || pg_temp.dom(),
  'already_processed ' || :'dom_p3', 'reentrega da mesma entrada: already_processed, nada repetido'
);

-- ---------------------------------------------------------------------
-- 5) Sem regressão; status repetido é no-op
-- ---------------------------------------------------------------------

select pg_temp.eo('evt-l1') as e_l1 \gset
select pg_temp.eo('evt-l2') as e_l2 \gset
select pg_temp.eo('evt-l3') as e_l3 \gset
select pg_temp.eo('evt-l4') as e_l4 \gset
select is(
  concat_ws(' ',
    pg_temp.st(:'e_l1', 'pm-prog', null, 'delivered', '2026-10-30 10:04:00+00') ->> 'outcome',
    pg_temp.st(:'e_l2', 'pm-prog', null, 'sent', '2026-10-30 10:05:00+00') ->> 'outcome',
    pg_temp.st(:'e_l3', 'pm-prog', null, 'accepted', '2026-10-30 10:06:00+00') ->> 'outcome',
    pg_temp.st(:'e_l4', 'pm-prog', null, 'read', '2026-10-30 10:07:00+00') ->> 'outcome',
    pg_temp.ms(:'m_prog'), pg_temp.mat(:'m_prog'),
    pg_temp.res(:'e_l1'), pg_temp.res(:'e_l4'),
    pg_temp.txt(format($$select count(*)::text from public.whatsapp_effect_ledger where message_id = %L::uuid and inbox_id in (%L::uuid, %L::uuid, %L::uuid, %L::uuid)$$,
      :'m_prog', split_part(:'e_l1', '|', 1), split_part(:'e_l2', '|', 1), split_part(:'e_l3', '|', 1), split_part(:'e_l4', '|', 1)))),
  'duplicate duplicate duplicate duplicate read|-|-|-|-|-|- 10:03 processed|- processed|- 4',
  'delivered, sent e accepted tardios e read repetido: duplicate; nada regride; o horário não muda; entradas finalizadas com o ledger na mensagem'
);
select is(
  (pg_temp.st(pg_temp.eo('evt-l5'), 'pm-prog', null, 'failed', '2026-10-30 10:08:00+00', p_err => 'e131026') ->> 'outcome')
  || ' ' || pg_temp.ms(:'m_prog') || ' ' || pg_temp.mat(:'m_prog'),
  'duplicate read|-|-|-|-|-|- 10:03', 'failed tardio depois de read: duplicate; não regride e não grava o erro'
);

-- ---------------------------------------------------------------------
-- 6) failed e a correção por delivered/read
-- ---------------------------------------------------------------------

select pg_temp.mk(:'conv1', 'pm-fail', null, 'sent') as m_fail \gset
select is(
  (pg_temp.st(pg_temp.eo('evt-f1'), 'pm-fail', null, 'failed', '2026-10-30 10:10:00+00', p_err => '131026') ->> 'outcome')
  || ' ' || pg_temp.ms(:'m_fail') || ' ' || pg_temp.mat(:'m_fail'),
  'applied failed|131026|-|-|-|-|- 10:10', 'failed depois de sent: aplicado, com o código do provedor'
);
select is(
  concat_ws(' ',
    pg_temp.st(pg_temp.eo('evt-f2'), 'pm-fail', null, 'accepted', '2026-10-30 10:11:00+00') ->> 'outcome',
    pg_temp.st(pg_temp.eo('evt-f3'), 'pm-fail', null, 'sent', '2026-10-30 10:11:00+00') ->> 'outcome',
    pg_temp.st(pg_temp.eo('evt-f4'), 'pm-fail', null, 'failed', '2026-10-30 10:11:00+00', p_err => '131049',
      p_amount => '0.0100', p_cur => 'BRL', p_fin => 'estimated') ->> 'outcome',
    pg_temp.ms(:'m_fail'), pg_temp.mat(:'m_fail')),
  'duplicate duplicate applied failed|131026|0.010000|BRL|-|estimated|- 10:10',
  'accepted e sent tardios não apagam o failed; failed repetido com outro código e um custo novo grava só o custo: não troca o erro nem o horário'
);
select is(
  (pg_temp.st(pg_temp.eo('evt-f5'), 'pm-fail', null, 'delivered', '2026-10-30 10:12:00+00') ->> 'outcome')
  || ' ' || pg_temp.ms(:'m_fail') || ' ' || pg_temp.mat(:'m_fail'),
  'applied delivered|-|0.010000|BRL|-|estimated|- 10:12', 'delivered corrige o failed e limpa o erro; o custo fica'
);
select pg_temp.mk(:'conv1', 'pm-fail2', null, 'failed', p_err => '131026') as m_fail2 \gset
select pg_temp.mk(:'conv1', 'pm-err', null, 'sent') as m_err \gset
select is(
  (pg_temp.st(pg_temp.eo('evt-f6'), 'pm-fail2', null, 'read', '2026-10-30 10:13:00+00') ->> 'outcome') || ' ' || pg_temp.ms(:'m_fail2')
  || ' ' || (pg_temp.st(pg_temp.eo('evt-f7'), 'pm-err', null, 'delivered', '2026-10-30 10:13:00+00', p_err => '131000') ->> 'outcome') || ' ' || pg_temp.ms(:'m_err'),
  'applied read|-|-|-|-|-|- applied delivered|-|-|-|-|-|-',
  'read corrige o failed e limpa o erro; código junto de um status que não é failed não é gravado'
);

-- ---------------------------------------------------------------------
-- 7) Horário do status: só quando muda, e nunca para trás
-- ---------------------------------------------------------------------

select pg_temp.mk(:'conv1', 'pm-old', null, 'sent') as m_old \gset
select coalesce(pg_temp.st(pg_temp.eo('evt-o1'), 'pm-old', null, 'delivered', '2026-10-30 09:00:00+00') ->> 'outcome', 'erro') || ' ' || pg_temp.mat(:'m_old') as ro1 \gset
select is(
  :'ro1' || ' ' || pg_temp.ms(:'m_old') || ' ' || (pg_temp.st(pg_temp.eo('evt-o2'), 'pm-old', null, 'read', '2026-10-30 11:00:00+00') ->> 'outcome') || ' ' || pg_temp.mat(:'m_old'),
  'applied 10:00 delivered|-|-|-|-|-|- applied 11:00',
  'evento mais antigo que o horário gravado muda o status sem voltar o horário; o seguinte avança'
);

-- ---------------------------------------------------------------------
-- 8) A matriz inteira: a mesma regra de projectWhatsAppMessageStatus
-- ---------------------------------------------------------------------

create function pg_temp.matriz(p_conv text) returns text language plpgsql as $f$
declare
  v_cur text;
  v_inc text;
  v_id text;
  v_out text[] := '{}';
  v jsonb;
begin
  foreach v_cur in array array['queued', 'accepted', 'sent', 'delivered', 'read', 'failed'] loop
    foreach v_inc in array array['accepted', 'sent', 'delivered', 'read', 'failed'] loop
      v_id := pg_temp.mk(p_conv, 'pm-mx-' || v_cur || '-' || v_inc, null, v_cur);
      v := pg_temp.st(pg_temp.eo('evt-mx-' || v_cur || '-' || v_inc), 'pm-mx-' || v_cur || '-' || v_inc, null, v_inc);
      v_out := v_out || (v_cur || '>' || v_inc || '=' || coalesce((select status::text from public.messages where id = v_id::uuid), '?')
        || ':' || coalesce(v ->> 'outcome', 'erro'));
    end loop;
  end loop;
  return array_to_string(v_out, ',');
end
$f$;

select is(
  pg_temp.matriz(:'conv1'),
  'queued>accepted=accepted:applied,queued>sent=sent:applied,queued>delivered=delivered:applied,queued>read=read:applied,queued>failed=failed:applied,'
  || 'accepted>accepted=accepted:duplicate,accepted>sent=sent:applied,accepted>delivered=delivered:applied,accepted>read=read:applied,accepted>failed=failed:applied,'
  || 'sent>accepted=sent:duplicate,sent>sent=sent:duplicate,sent>delivered=delivered:applied,sent>read=read:applied,sent>failed=failed:applied,'
  || 'delivered>accepted=delivered:duplicate,delivered>sent=delivered:duplicate,delivered>delivered=delivered:duplicate,delivered>read=read:applied,delivered>failed=delivered:duplicate,'
  || 'read>accepted=read:duplicate,read>sent=read:duplicate,read>delivered=read:duplicate,read>read=read:duplicate,read>failed=read:duplicate,'
  || 'failed>accepted=failed:duplicate,failed>sent=failed:duplicate,failed>delivered=delivered:applied,failed>read=read:applied,failed>failed=failed:duplicate',
  'matriz completa (status atual × status recebido) igual à de projectWhatsAppMessageStatus; queued da A7 avança como accepted'
);

-- ---------------------------------------------------------------------
-- 9) Localização: id do provedor, wamid, conflitos
-- ---------------------------------------------------------------------

select pg_temp.mk(:'conv1', null, 'wamid.' || repeat('W', 512), 'sent') as m_w \gset
select is(
  (pg_temp.st(pg_temp.eo('evt-w1'), 'pm-w518', 'wamid.' || repeat('W', 512), 'delivered') ->> 'outcome')
  || ' ' || pg_temp.txt(format($$select status || '|' || provider_message_id || '|' || provider || '|' || char_length(wa_message_id) from public.messages where id = %L::uuid$$, :'m_w')),
  'applied delivered|pm-w518|simulated|518', 'pelo wamid de 518 caracteres: aplicado, e o id do provedor que faltava é acrescentado'
);
select pg_temp.mk(:'conv1', 'pm-enr', null, 'delivered') as m_enr \gset
select is(
  (pg_temp.st(pg_temp.eo('evt-n1'), 'pm-enr', 'wamid.ENR', 'delivered') ->> 'outcome') || ' ' || pg_temp.mids(:'m_enr')
  || ' ' || (pg_temp.st(pg_temp.eo('evt-n2'), 'pm-enr', 'wamid.ENR', 'delivered') ->> 'outcome'),
  'applied pm-enr|wamid.ENR|simulated|- duplicate',
  'pelo id do provedor, com o wamid que faltava: acrescentado (alteração efetiva); o mesmo evento outra vez não muda nada'
);

select pg_temp.mk(:'conv1', 'pm-ca', 'wamid.CA', 'sent') as m_ca \gset
select pg_temp.mk(:'conv1', 'pm-cn', null, 'sent') as m_cn \gset
select pg_temp.mk(:'conv1', 'pm-cb', 'wamid.CB', 'sent') as m_cb \gset
select pg_temp.mrow(:'m_ca') as row_ca \gset
select pg_temp.mrow(:'m_cn') as row_cn \gset
select pg_temp.mrow(:'m_cb') as row_cb \gset
select pg_temp.mrow(:'m_in') as row_in \gset
select pg_temp.eo('evt-k1') as e_k1 \gset
select pg_temp.eo('evt-k2') as e_k2 \gset
select pg_temp.eo('evt-k3') as e_k3 \gset
select pg_temp.eo('evt-k4') as e_k4 \gset
select pg_temp.dom() as dom_k \gset
select is(
  (pg_temp.st(:'e_k1', 'pm-cn', 'wamid.CB', 'delivered') ->> 'outcome') || ' ' || pg_temp.mrow(:'m_cn') || ' ' || pg_temp.mrow(:'m_cb')
  || ' ' || pg_temp.res(:'e_k1'),
  'message_conflict ' || :'row_cn' || ' ' || :'row_cb' || ' processing|' || split_part(:'e_k1', '|', 2),
  'id do provedor de uma mensagem (sem wamid) e wamid de outra: message_conflict; o wamid não é acrescentado; nenhuma das duas muda; claim intacto'
);
select is(
  (pg_temp.st(:'e_k2', 'pm-in-1', null, 'read') ->> 'outcome') || ' ' || pg_temp.mrow(:'m_in') || ' ' || pg_temp.res(:'e_k2'),
  'message_conflict ' || :'row_in' || ' processing|' || split_part(:'e_k2', '|', 2),
  'o id do provedor é de uma mensagem RECEBIDA: message_conflict, nada muda'
);
select is(
  (pg_temp.st(:'e_k3', 'pm-ca', 'wamid.OUTRO', 'delivered') ->> 'outcome') || ' ' || (pg_temp.st(:'e_k4', 'pm-outro', 'wamid.CA', 'delivered') ->> 'outcome')
  || ' ' || pg_temp.mrow(:'m_ca') || ' ' || pg_temp.dom(),
  'message_conflict message_conflict ' || :'row_ca' || ' ' || :'dom_k',
  'a mensagem já tem outro wamid, ou outro id do provedor: message_conflict; nenhum ledger, nada alterado'
);
select pg_temp.mk(:'conv1', 'pm-ext0', null, 'sent', p_ext => 'ext-localiza') as m_ext0 \gset
select pg_temp.mk(:'conv_b', 'pm-chb', null, 'sent') as m_chb \gset
select pg_temp.mrow(:'m_ext0') as row_ext0 \gset
select pg_temp.mrow(:'m_chb') as row_chb \gset
select is(
  (pg_temp.st(pg_temp.eo('evt-q1'), 'pm-nada', null, 'delivered', p_ext => 'ext-localiza') ->> 'outcome')
  || ' ' || (pg_temp.st(pg_temp.eo('evt-q2'), 'pm-chb', null, 'delivered') ->> 'outcome')
  || ' ' || pg_temp.mrow(:'m_ext0') || ' ' || pg_temp.mrow(:'m_chb'),
  'message_not_found message_not_found ' || :'row_ext0' || ' ' || :'row_chb',
  'o externalId sozinho não localiza mensagem; o id do provedor de outro canal (outro workspace) também não'
);

-- ---------------------------------------------------------------------
-- 10) Status antes da mensagem: message_not_found recuperável
-- ---------------------------------------------------------------------

select pg_temp.eo('evt-nf') as e_nf \gset
select pg_temp.dom() as dom_nf \gset
select pg_temp.st(:'e_nf', 'pm-futuro', 'wamid.FUTURO', 'delivered', '2026-10-30 10:20:00+00', p_phone => :'p7') as rnf \gset
select is(
  :'rnf' || ' ' || pg_temp.dom() || ' ' || pg_temp.res(:'e_nf')
  || ' ' || pg_temp.txt(format($$select count(*)::text from public.whatsapp_identities where phone_e164 = %L$$, :'p7')),
  '{"outcome": "message_not_found"} ' || :'dom_nf' || ' processing|' || split_part(:'e_nf', '|', 2) || ' 0',
  'status antes da mensagem: message_not_found; nenhum placeholder, identidade ou ledger; inbox não finalizada; claim intacto'
);
select coalesce(pg_temp.ob(pg_temp.eo('evt-nf-ob', 'whatsapp.smb.message.echoes'), 'pm-futuro', 'wamid.FUTURO', :'p7') ->> 'message_id', :'nulo') as m_fut \gset
select is(
  (pg_temp.st(:'e_nf', 'pm-futuro', 'wamid.FUTURO', 'delivered', '2026-10-30 10:20:00+00', p_phone => :'p7') ->> 'outcome')
  || ' ' || pg_temp.ms(:'m_fut') || ' ' || pg_temp.res(:'e_nf')
  || ' ' || pg_temp.txt(format($$select count(*)::text from public.whatsapp_effect_ledger where inbox_id = %L::uuid and message_id = %L::uuid$$, split_part(:'e_nf', '|', 1), :'m_fut')),
  'applied delivered|-|-|-|-|-|- processed|- 1',
  'depois que a mensagem chega, a mesma entrada (o mesmo claim) aplica o status'
);

-- ---------------------------------------------------------------------
-- 11) externalId: correlação opaca
-- ---------------------------------------------------------------------

select pg_temp.mk(:'conv1', 'pm-ext', null, 'sent') as m_x \gset
select is(
  (pg_temp.st(pg_temp.eo('evt-x1'), 'pm-ext', null, 'delivered', p_ext => 'msg-bot_0123456789abcdef01234567') ->> 'outcome')
  || ' ' || pg_temp.mids(:'m_x') || ' ' || pg_temp.morig(:'m_x'),
  'applied pm-ext|-|simulated|msg-bot_0123456789abcdef01234567 outbound|business_app|internal|true|-|-|true',
  'externalId preenchido quando vazio; no formato do chatbot, não muda origem, classificação, autoria nem correlação'
);
select pg_temp.eo('evt-x3') as e_x3 \gset
select is(
  (pg_temp.st(pg_temp.eo('evt-x2'), 'pm-ext', null, 'delivered', p_ext => 'msg-bot_0123456789abcdef01234567') ->> 'outcome')
  || ' ' || (pg_temp.st(:'e_x3', 'pm-ext', null, 'read', p_ext => 'outra-correlacao') ->> 'outcome')
  || ' ' || pg_temp.ms(:'m_x') || ' ' || pg_temp.mids(:'m_x') || ' ' || pg_temp.res(:'e_x3'),
  'duplicate message_conflict delivered|-|-|-|-|-|- pm-ext|-|simulated|msg-bot_0123456789abcdef01234567 processing|' || split_part(:'e_x3', '|', 2),
  'o mesmo externalId de novo: duplicate; outro externalId: message_conflict, sem aplicar o read nem trocar a correlação'
);
select pg_temp.mk(:'conv1', 'pm-ext2', null, 'sent') as m_x2 \gset
select pg_temp.mk(:'conv1', 'pm-api', null, 'sent', p_origin => 'external_api', p_class => 'unresolved') as m_api \gset
select is(
  (pg_temp.st(pg_temp.eo('evt-x4'), 'pm-ext2', null, 'delivered', p_ext => 'correlação opaca ' || repeat('x', 495)) ->> 'outcome')
  || ' ' || pg_temp.txt(format($$select char_length(provider_external_id)::text from public.messages where id = %L::uuid$$, :'m_x2'))
  || ' ' || (pg_temp.st(pg_temp.eo('evt-x5'), 'pm-api', null, 'delivered', p_ext => 'msg-bot_0123456789abcdef01234567') ->> 'outcome')
  || ' ' || pg_temp.morig(:'m_api'),
  'applied 512 applied outbound|external_api|unresolved|true|-|-|true',
  'externalId de 512 caracteres com espaço (o limite do normalizador) gravado inteiro; saída de API com externalId do chatbot continua external_api/unresolved'
);

-- ---------------------------------------------------------------------
-- 12) Destinatário
-- ---------------------------------------------------------------------

select pg_temp.mk(:'conv1', 'pm-r1', null, 'sent') as m_r1 \gset
select pg_temp.mk(:'conv2', 'pm-r2', null, 'sent') as m_r2 \gset
select pg_temp.mk(:'conv3', 'pm-r3', null, 'sent') as m_r3 \gset
select pg_temp.mk(:'conv1', 'pm-r4', null, 'sent') as m_r4 \gset
select pg_temp.domx() as domx_r \gset
select is(
  concat_ws(' ',
    pg_temp.st(pg_temp.eo('evt-r1'), 'pm-r1', null, 'delivered', p_phone => :'p1') ->> 'outcome',
    pg_temp.st(pg_temp.eo('evt-r2'), 'pm-r2', null, 'delivered', p_phone => :'p2', p_lookup => format('{"1": "%s"}', :'bi2')) ->> 'outcome',
    pg_temp.st(pg_temp.eo('evt-r3'), 'pm-r3', null, 'delivered', p_lookup => format('{"1": "%s"}', :'bi3')) ->> 'outcome',
    pg_temp.st(pg_temp.eo('evt-r4'), 'pm-r4', null, 'delivered') ->> 'outcome',
    (pg_temp.domx() = :'domx_r')::text),
  'applied applied applied applied true',
  'destinatário igual (telefone; telefone + BSUID; só BSUID) ou ausente: aplicado; nenhuma identidade nova'
);
select pg_temp.mk(:'conv1', 'pm-r5', null, 'sent') as m_r5 \gset
select pg_temp.mk(:'conv2', 'pm-r6', null, 'sent') as m_r6 \gset
select pg_temp.mrow(:'m_r5') as row_r5 \gset
select pg_temp.mrow(:'m_r6') as row_r6 \gset
select pg_temp.eo('evt-r5') as e_r5 \gset
select pg_temp.dom() as dom_r5 \gset
select is(
  (pg_temp.st(:'e_r5', 'pm-r5', null, 'delivered', p_phone => '+5511900039999') ->> 'outcome') || ' ' || pg_temp.dom()
  || ' ' || pg_temp.mrow(:'m_r5') || ' ' || pg_temp.res(:'e_r5'),
  'message_conflict ' || :'dom_r5' || ' ' || :'row_r5' || ' processing|' || split_part(:'e_r5', '|', 2),
  'outro telefone: message_conflict; a identidade desse telefone não fica criada; nada gravado; claim intacto'
);
select is(
  concat_ws(' ',
    pg_temp.st(pg_temp.eo('evt-r6'), 'pm-r6', null, 'delivered', p_lookup => format('{"1": "%s"}', :'bi4')) ->> 'outcome',
    pg_temp.st(pg_temp.eo('evt-r7'), 'pm-r6', null, 'delivered', p_lookup => format('{"1": "%s"}', :'bi3')) ->> 'outcome',
    pg_temp.txt(format($$select count(*)::text from public.whatsapp_identities where bsuid_blind_index = decode(%L, 'base64')$$, :'bi4')),
    (pg_temp.mrow(:'m_r6') = :'row_r6')::text),
  'message_conflict message_conflict 0 true',
  'outro BSUID (nunca visto, ou de outra identidade): message_conflict; nenhuma identidade nova; a mensagem não muda'
);
select pg_temp.mk(:'conv1', 'pm-r7', null, 'sent') as m_r7 \gset
select pg_temp.mk(:'conv1', 'pm-r8', null, 'sent') as m_r8 \gset
select is(
  (pg_temp.st(pg_temp.eo('evt-r8'), 'pm-r7', null, 'delivered', p_phone => :'p1', p_lookup => format('{"1": "%s"}', :'bi5')) ->> 'outcome')
  || ' ' || pg_temp.ident(format('channel_id = %L and phone_e164 = %L', :'ch_o', :'p1'))
  || ' ' || (pg_temp.st(pg_temp.eo('evt-r9'), 'pm-r8', null, 'delivered', p_lookup => format('{"1": "%s"}', :'bi5')) ->> 'outcome'),
  'applied ' || :'p1' || '|' || :'bi5' || ' applied',
  'telefone da identidade + BSUID complementar: converge e a identidade ganha o BSUID; depois, só o BSUID também converge'
);
select pg_temp.mk(:'conv1', 'pm-r9', null, 'sent') as m_r9 \gset
select pg_temp.mk(:'conv1', 'pm-r10', null, 'sent') as m_r10 \gset
select pg_temp.mrow(:'m_r9') as row_r9 \gset
select is(
  (pg_temp.st(pg_temp.eo('evt-r10'), 'pm-r9', null, 'delivered', p_phone => :'p1', p_lookup => format('{"1": "%s"}', :'bi2')) ->> 'outcome')
  || ' ' || pg_temp.mrow(:'m_r9'),
  'message_conflict ' || :'row_r9',
  'telefone e BSUID de identidades diferentes: message_conflict, sem auto-merge; a mensagem não muda'
);
select is(
  (pg_temp.st(pg_temp.eo('evt-r11'), 'pm-r10', null, 'delivered', p_phone => :'p4', p_lookup => format('{"1": "%s"}', :'bi6')) ->> 'outcome')
  || ' ' || pg_temp.ident(format('channel_id = %L and phone_e164 = %L', :'ch_o', :'p4'))
  || ' ' || pg_temp.txt(format($$select count(*)::text from public.whatsapp_identities where bsuid_blind_index = decode(%L, 'base64')$$, :'bi6')),
  'message_conflict ' || :'p4' || '|- 0',
  'destinatário de outra conversa, com BSUID novo: message_conflict, e o BSUID acrescentado durante a tentativa é desfeito'
);

-- ---------------------------------------------------------------------
-- 13) Custo informado pelo provedor
-- ---------------------------------------------------------------------

select pg_temp.mk(:'conv1', 'pm-c1', null, 'accepted') as m_c1 \gset
select is(
  concat_ws(' ',
    pg_temp.st(pg_temp.eo('evt-c1'), 'pm-c1', null, 'accepted', p_amount => '0.0100', p_cur => 'BRL', p_cat => 'marketing', p_fin => 'estimated') ->> 'outcome',
    pg_temp.st(pg_temp.eo('evt-c2'), 'pm-c1', null, 'sent', p_amount => '0.0200', p_cur => 'BRL', p_cat => 'marketing', p_fin => 'estimated') ->> 'outcome',
    pg_temp.ms(:'m_c1')),
  'applied applied sent|-|0.020000|BRL|marketing|estimated|-',
  'estimativa → estimativa: a nova substitui; estimativa não é cobrada'
);
select is(
  (pg_temp.st(pg_temp.eo('evt-c3'), 'pm-c1', null, 'delivered', p_amount => '0.0315', p_cur => 'BRL', p_cat => 'marketing', p_fin => 'final') ->> 'outcome')
  || ' ' || pg_temp.ms(:'m_c1'),
  'applied delivered|-|0.031500|BRL|marketing|final|0.031500', 'estimativa → final: o final substitui e entra no valor cobrado'
);
select is(
  concat_ws(' ',
    pg_temp.st(pg_temp.eo('evt-c4'), 'pm-c1', null, 'read', p_amount => '0.0500', p_cur => 'BRL', p_cat => 'marketing', p_fin => 'estimated') ->> 'outcome',
    pg_temp.st(pg_temp.eo('evt-c5'), 'pm-c1', null, 'read', p_amount => '0.0500', p_cur => 'BRL', p_fin => 'estimated') ->> 'outcome',
    pg_temp.st(pg_temp.eo('evt-c6'), 'pm-c1', null, 'read', p_amount => '0.0315', p_cur => 'BRL', p_cat => 'marketing', p_fin => 'final') ->> 'outcome',
    pg_temp.st(pg_temp.eo('evt-c7'), 'pm-c1', null, 'read', p_amount => '0.031500', p_cur => 'BRL', p_fin => 'final') ->> 'outcome',
    pg_temp.st(pg_temp.eo('evt-c8'), 'pm-c1', null, 'read') ->> 'outcome',
    pg_temp.ms(:'m_c1')),
  'applied duplicate duplicate duplicate duplicate read|-|0.031500|BRL|marketing|final|0.031500',
  'final → estimativa: o final fica (o read aplica só o status); o mesmo final, com ou sem categoria, e custo ausente: duplicate'
);
select pg_temp.mrow(:'m_c1') as row_c1 \gset
select pg_temp.eo('evt-c9') as e_c9 \gset
select pg_temp.eo('evt-c10') as e_c10 \gset
select pg_temp.eo('evt-c11') as e_c11 \gset
select pg_temp.dom() as dom_c \gset
select is(
  concat_ws(' ',
    pg_temp.st(:'e_c9', 'pm-c1', null, 'read', p_amount => '0.0400', p_cur => 'BRL', p_cat => 'marketing', p_fin => 'final') ->> 'outcome',
    pg_temp.st(:'e_c10', 'pm-c1', null, 'read', p_amount => '0.0315', p_cur => 'USD', p_cat => 'marketing', p_fin => 'final') ->> 'outcome',
    pg_temp.st(:'e_c11', 'pm-c1', null, 'read', p_amount => '0.0315', p_cur => 'BRL', p_cat => 'utility', p_fin => 'final') ->> 'outcome',
    pg_temp.mrow(:'m_c1'), pg_temp.dom(), pg_temp.res(:'e_c9'), pg_temp.res(:'e_c11')),
  'cost_conflict cost_conflict cost_conflict ' || :'row_c1' || ' ' || :'dom_c' || ' processing|' || split_part(:'e_c9', '|', 2) || ' processing|' || split_part(:'e_c11', '|', 2),
  'outro custo final (valor, moeda ou categoria): cost_conflict; o final não é sobrescrito; nenhum ledger; claim intacto'
);
select pg_temp.mk(:'conv1', 'pm-c2', null, 'sent') as m_c2 \gset
select pg_temp.mk(:'conv1', 'pm-c3', null, 'sent') as m_c3 \gset
select is(
  (pg_temp.st(pg_temp.eo('evt-c12'), 'pm-c2', null, 'failed', p_err => '131026', p_amount => '0.0100', p_cur => 'BRL', p_fin => 'estimated') ->> 'outcome')
  || ' ' || pg_temp.ms(:'m_c2')
  || ' ' || (pg_temp.st(pg_temp.eo('evt-c13'), 'pm-c3', null, 'failed', p_amount => '0.0300', p_cur => 'BRL', p_fin => 'final') ->> 'outcome')
  || ' ' || pg_temp.ms(:'m_c3'),
  'applied failed|131026|0.010000|BRL|-|estimated|- applied failed|-|0.030000|BRL|-|estimated|-',
  'failed com custo: fica estimativa (mesmo se vier como final) e não é cobrado'
);
select is(
  (pg_temp.st(pg_temp.eo('evt-c14'), 'pm-c2', null, 'delivered') ->> 'outcome') || ' ' || pg_temp.ms(:'m_c2')
  || ' ' || (pg_temp.st(pg_temp.eo('evt-c15'), 'pm-c2', null, 'read', p_amount => '0.0100', p_cur => 'BRL', p_fin => 'final') ->> 'outcome') || ' ' || pg_temp.ms(:'m_c2'),
  'applied delivered|-|0.010000|BRL|-|estimated|- applied read|-|0.010000|BRL|-|final|0.010000',
  'custo ausente preserva o atual; o final que chega depois do failed corrigido passa a ser cobrado'
);
select pg_temp.mk(:'conv1', 'pm-c4', null, 'read', p_amount => '0.0200', p_cur => 'BRL', p_fin => 'estimated') as m_c4 \gset
select is(
  (pg_temp.st(pg_temp.eo('evt-c16'), 'pm-c4', null, 'delivered', p_amount => '0.0315', p_cur => 'BRL', p_fin => 'final') ->> 'outcome')
  || ' ' || pg_temp.ms(:'m_c4') || ' ' || pg_temp.mat(:'m_c4'),
  'applied read|-|0.031500|BRL|-|final|0.031500 10:00', 'delivered tardio não regride o read nem o horário, mas o custo final que ele traz é aplicado'
);
select is(
  pg_temp.txt($$select count(*)::text from public.messages
    where (provider_cost_billable_amount is not null) is distinct from coalesce(provider_cost_finality = 'final', false)$$)
  || ' ' || pg_temp.txt(format($$select sum(provider_cost_billable_amount)::text from public.messages where id in (%L::uuid, %L::uuid, %L::uuid, %L::uuid)$$,
    :'m_c1', :'m_c2', :'m_c3', :'m_c4')),
  '0 0.073000', 'só o custo final entra em provider_cost_billable_amount'
);

-- ---------------------------------------------------------------------
-- 14) Status ATUAL do canal, reconferido no efeito
-- ---------------------------------------------------------------------

select coalesce(pg_temp.ob(pg_temp.entrada(:'ch_s', :'ws_um', 'b3d2b2b2-s', 'evt-s0', 'whatsapp.smb.message.echoes'), 'pm-s0', null, '+5511900033001') ->> 'message_id', :'nulo') as m_s0 \gset

create function pg_temp.chs(p_status text, p_evt text) returns text language plpgsql as $f$
declare
  v_entry text;
  v_dom text;
  v_row text;
  v jsonb;
begin
  update public.whatsapp_channels set status = 'active', status_changed_at = now() where id = '3e100000-0000-0000-0000-000000000004';
  v_entry := pg_temp.entrada('3e100000-0000-0000-0000-000000000004', '10000000-0000-0000-0000-000000000001', 'b3d2b2b2-s', p_evt);
  update public.whatsapp_channels set status = p_status, send_enabled = false, status_changed_at = now()
  where id = '3e100000-0000-0000-0000-000000000004';
  v_dom := pg_temp.dom();
  v_row := (select md5(m::text) from public.messages m where m.provider_message_id = 'pm-s0');
  v := pg_temp.st(v_entry, 'pm-s0', null, 'delivered');
  return coalesce(v::text, 'NULL') || ' ' || (pg_temp.dom() = v_dom and (select md5(m::text) from public.messages m where m.provider_message_id = 'pm-s0') = v_row)::text
    || ' ' || (pg_temp.res(v_entry) = 'processing|' || split_part(v_entry, '|', 2))::text;
end
$f$;

select is(
  concat_ws(' / ', pg_temp.chs('paused', 'evt-s1'), pg_temp.chs('disconnected', 'evt-s2'), pg_temp.chs('disabled', 'evt-s3')),
  '{"outcome": "channel_paused"} true true / {"outcome": "channel_disconnected"} true true / {"outcome": "channel_disabled"} true true',
  'canal pausado, desconectado ou desativado depois do claim: channel_*; nenhum ledger, mensagem ou auditoria; claim intacto'
);
select id::text || '|' || coalesce(claim_token::text, :'nulo') as e_s3
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
  (pg_temp.st(pg_temp.entrada(:'ch_s', :'ws_um', 'b3d2b2b2-s', 'evt-s4'), 'pm-s0', null, 'delivered') ->> 'outcome') || ' ' || pg_temp.ms(:'m_s0'),
  'applied delivered|-|-|-|-|-|-', 'controle: canal ativo no momento do efeito aplica normalmente'
);

-- ---------------------------------------------------------------------
-- 15) Ledger: a chave estável com outro efeito, ou o mesmo já reservado
-- ---------------------------------------------------------------------

select pg_temp.mk(:'conv1', 'pm-lg', null, 'sent') as m_lg \gset
select pg_temp.mrow(:'m_lg') as row_lg \gset
select pg_temp.eo('evt-g1') as e_g1 \gset
select pg_temp.eo('evt-g2') as e_g2 \gset
insert into public.whatsapp_effect_ledger (environment, workspace_id, channel_id, provider, provider_event_id, effect, inbox_id) values
  ('preview', :'ws_um'::uuid, :'ch_o'::uuid, 'simulated', 'evt-g1', 'message.outbound_observed', split_part(:'e_g1', '|', 1)::uuid),
  ('preview', :'ws_um'::uuid, :'ch_o'::uuid, 'simulated', 'evt-g2', 'message.status', split_part(:'e_g2', '|', 1)::uuid);
select pg_temp.dom() as dom_g \gset
select is(
  pg_temp.st(:'e_g1', 'pm-lg', null, 'delivered')::text || ' ' || pg_temp.dom() || ' ' || pg_temp.res(:'e_g1') || ' ' || pg_temp.mrow(:'m_lg'),
  '{"outcome": "effect_conflict"} ' || :'dom_g' || ' processing|' || split_part(:'e_g1', '|', 2) || ' ' || :'row_lg',
  'a chave estável já tem outro efeito: effect_conflict, nada escrito, claim intacto'
);
select is(
  (pg_temp.st(:'e_g2', 'pm-lg', null, 'delivered') ->> 'outcome') || ' ' || pg_temp.dom() || ' ' || pg_temp.res(:'e_g2') || ' ' || pg_temp.mrow(:'m_lg'),
  'duplicate ' || :'dom_g' || ' processed|- ' || :'row_lg',
  'o mesmo efeito já reservado para a entrada: duplicate, nada repetido, entrada finalizada'
);

-- ---------------------------------------------------------------------
-- 16) Atomicidade: falha depois da reserva desfaz tudo
-- ---------------------------------------------------------------------

select pg_temp.mk(:'conv4', 'pm-falha', null, 'sent') as m_falha \gset
select pg_temp.mrow(:'m_falha') as row_falha \gset
create function public.t38_falha_simulada() returns trigger language plpgsql as $f$
begin
  if new.provider_message_id = 'pm-falha' then
    raise exception 'falha_simulada';
  end if;
  return new;
end
$f$;
create trigger t38_falha_simulada before update on public.messages for each row execute function public.t38_falha_simulada();

select pg_temp.eo('evt-z1') as e_z1 \gset
select pg_temp.dom() as dom_z \gset
select is(
  (pg_temp.st(:'e_z1', 'pm-falha', null, 'delivered', p_phone => :'p4', p_lookup => format('{"1": "%s"}', :'bi7')) ->> 'erro')
  || ' ' || pg_temp.dom() || ' ' || pg_temp.res(:'e_z1') || ' ' || pg_temp.mrow(:'m_falha')
  || ' ' || pg_temp.ident(format('channel_id = %L and phone_e164 = %L', :'ch_o', :'p4')),
  'falha_simulada ' || :'dom_z' || ' processing|' || split_part(:'e_z1', '|', 2) || ' ' || :'row_falha' || ' ' || :'p4' || '|-',
  'falha ao gravar a mensagem, depois do ledger e do BSUID acrescentado: nada sobrevive e o claim continua'
);
drop trigger t38_falha_simulada on public.messages;
select is(
  (pg_temp.st(:'e_z1', 'pm-falha', null, 'delivered', p_phone => :'p4', p_lookup => format('{"1": "%s"}', :'bi7')) ->> 'outcome')
  || ' ' || pg_temp.ms(:'m_falha') || ' ' || pg_temp.ident(format('channel_id = %L and phone_e164 = %L', :'ch_o', :'p4')),
  'applied delivered|-|-|-|-|-|- ' || :'p4' || '|' || :'bi7', 'sem a falha, a mesma entrada aplica normalmente'
);

-- ---------------------------------------------------------------------
-- 17) Isolamento: outro workspace e Production
-- ---------------------------------------------------------------------

select pg_temp.mk(:'conv_b', 'pm-iso', null, 'sent') as m_iso_b \gset
select pg_temp.mk(:'conv1', 'pm-iso', null, 'sent') as m_iso_o \gset
select is(
  (pg_temp.st(pg_temp.entrada(:'ch_b', :'ws_dois', 'b3d2b2b2-b', 'evt-iso'), 'pm-iso', null, 'read') ->> 'outcome')
  || ' ' || split_part(pg_temp.ms(:'m_iso_b'), '|', 1) || ' ' || split_part(pg_temp.ms(:'m_iso_o'), '|', 1),
  'applied read sent', 'o mesmo id do provedor em outro workspace: só a mensagem do canal da entrada muda'
);
select set_config('request.headers', :'h_prod', true);
select pg_temp.entrada(:'ch_prod', :'ws_um', 'b3d2b2b2-prod', 'evt-prod') as e_prod \gset
select set_config('request.headers', :'h_prev', true);
select is(pg_temp.st(:'e_prod', 'pm-iso', null, 'read') ->> 'outcome', 'not_found', 'a entrada de Production não é alcançada a partir de Preview');

-- ---------------------------------------------------------------------
-- 18) Nada comercial, nada de auditoria com custo ou dado pessoal
-- ---------------------------------------------------------------------

select is(
  (pg_temp.com() = :'com0')::text
  || ' ' || pg_temp.txt($$select count(*)::text from public.audit_logs a join public.messages m on m.id = a.resource_id where m.body_text = 'Mensagem fictícia (status)'$$)
  || ' ' || pg_temp.txt($$select count(*)::text from public.messages where body_text = 'Mensagem fictícia (status)' and (direction <> 'outbound' or sent_by is not null or origin_correlation_kind is not null)$$),
  'true 0 0',
  'nenhum contato, telefone, identificador, lead, oportunidade ou atividade criado ou alterado; nenhuma auditoria com custo ou destinatário; autoria intacta'
);

-- ---------------------------------------------------------------------
-- 19) Colunas: o limite do externalId é o do normalizador; o resto da A7
-- ---------------------------------------------------------------------

create function pg_temp.ins_ext(p_ext text) returns text language plpgsql as $f$
begin
  insert into public.messages (workspace_id, conversation_id, channel_id, direction, origin, sender_classification, content_kind, body_text,
    provider, provider_message_id, provider_external_id, status)
  select c.workspace_id, c.id, c.channel_id, 'outbound', 'business_app', 'internal', 'text', 'Coluna (fictícia)', 'simulated',
    'pm-col-' || md5(p_ext), p_ext, 'sent'
  from public.conversations c where c.id = (select conversation_id from public.messages where provider_message_id = 'pm-base1');
  return 'ok';
exception when others then
  return sqlstate;
end
$f$;
select is(
  concat_ws(' ', pg_temp.ins_ext('correlação com espaço ' || repeat('y', 490)), pg_temp.ins_ext(repeat('y', 513)),
    pg_temp.ins_ext('com' || chr(9) || 'tab'), pg_temp.ins_ext('')),
  'ok 23514 23514 23514',
  'a coluna do externalId aceita até 512 caracteres sem caractere de controle (o normalizador), e recusa o resto'
);
delete from public.messages where body_text = 'Coluna (fictícia)';

-- ---------------------------------------------------------------------
-- 20) Id do provedor: o contrato interno é de até 255 caracteres
-- ---------------------------------------------------------------------

create function pg_temp.ins_pm(p_pm text) returns text language plpgsql as $f$
begin
  insert into public.messages (workspace_id, conversation_id, channel_id, direction, origin, sender_classification, content_kind, body_text,
    provider, provider_message_id, status)
  select c.workspace_id, c.id, c.channel_id, 'outbound', 'business_app', 'internal', 'text', 'Coluna (fictícia)', 'simulated', p_pm, 'sent'
  from public.conversations c where c.id = (select conversation_id from public.messages where provider_message_id = 'pm-base1');
  return 'ok';
exception when others then
  return sqlstate;
end
$f$;
select is(
  pg_temp.ins_pm('C' || repeat('c', 254)) || ' ' || pg_temp.ins_pm('C' || repeat('d', 255)),
  'ok 23514', 'a coluna aceita o id do provedor com 255 caracteres e recusa 256'
);
delete from public.messages where body_text = 'Coluna (fictícia)';
select pg_temp.eo('evt-pm-in255', 'whatsapp.inbound_message.received') as e_pi \gset
select pg_temp.eo('evt-pm-in256', 'whatsapp.inbound_message.received') as e_pj \gset
select is(
  concat_ws(' ',
    pg_temp.txt(format($$select public.whatsapp_effect_inbound_message(%L::uuid, %L::uuid, %L, 'text', 'Mensagem fictícia recebida', now(), '+5511900030011', null, null, null, null) ->> 'outcome'$$,
      split_part(:'e_pi', '|', 1), split_part(:'e_pi', '|', 2), 'I' || repeat('i', 254))),
    pg_temp.txt(format($$select public.whatsapp_effect_inbound_message(%L::uuid, %L::uuid, %L, 'text', 'Mensagem fictícia recebida', now(), '+5511900030011', null, null, null, null) ->> 'outcome'$$,
      split_part(:'e_pj', '|', 1), split_part(:'e_pj', '|', 2), 'I' || repeat('j', 255))) like 'ERRO:%invalid_inbound_message',
    pg_temp.ob(pg_temp.eo('evt-pm-ob255', 'whatsapp.smb.message.echoes'), 'O' || repeat('o', 254), null, :'p1') ->> 'outcome',
    pg_temp.ob(pg_temp.eo('evt-pm-ob256', 'whatsapp.smb.message.echoes'), 'O' || repeat('p', 255), null, :'p1') ->> 'erro',
    pg_temp.st(pg_temp.eo('evt-pm-st255'), 'O' || repeat('o', 254), null, 'delivered') ->> 'outcome',
    pg_temp.st(pg_temp.eo('evt-pm-st256'), 'O' || repeat('p', 255), null, 'delivered') ->> 'erro'),
  'applied true applied invalid_outbound_message applied invalid_status_update',
  'as três RPCs (recebida, saída observada, status) aceitam o id do provedor com 255 caracteres e recusam 256'
);

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'ana', 'role', 'authenticated')::text, true);
select is(
  pg_temp.txt(format($$select public.whatsapp_effect_message_status(%L::uuid, %L::uuid, 'pm-x', null, null, 'read', null, now(), null, null, null, null, null, null, null, null)::text$$, :'inventado', :'inventado')) like 'ERRO:42501%',
  true, 'authenticated não executa o efeito'
);
reset role;

select * from finish();
rollback;
