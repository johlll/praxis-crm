-- pgTAP — Conversas + IA: horário de ORIGEM das mensagens (pré-requisito do aplicador).
--
-- Prova: três instantes separados (origem, chegada, fonte); a origem só entra por
-- whatsapp_record_message_origin_time (service_role, ligada ao ledger do evento) ou pelo gatilho do
-- envio humano; nenhum cliente, usuário ou outro SQL a informa ou a altera; ausente, futuro, antigo
-- demais e unidade trocada viram motivo (a mensagem continua recebida); duplicata igual confirma e
-- contraditória marca sem escolher; evento que não criou a mensagem nunca preenche origem
-- desconhecida; status nunca é origem; legado segue desconhecido; a regra de comparação com
-- manual_decided_at (caso 9h/10h/10h30, empate, precisão, futuro suspeito); exportação e retenção.
--
-- Tudo fictício: nenhum telefone, BSUID ou identidade real. As chamadas passam por funções que
-- capturam o erro, para o arquivo rodar até o fim contra a versão anterior.

begin;
select plan(102);

\set ana    '20000000-0000-0000-0000-000000000001'
\set bruno  '20000000-0000-0000-0000-000000000002'
\set ws_um   '10000000-0000-0000-0000-000000000001'
\set ch_a    '57000000-0000-0000-0000-000000000001'
\set ch_o    '57000000-0000-0000-0000-000000000002'
\set cifra   'QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFB'

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
select set_config('request.headers', :'h_prev', true);

-- Canais da B3 (simulados): A (recebido) e O (eco do aplicativo), no Escritório Um.
set local role service_role;
select whatsapp_create_simulated_channel(:'ch_a'::uuid, :'ws_um'::uuid, :'ana'::uuid, 'A', 'ho-a', '1', :'cifra', '1') is not null as ok \gset
select whatsapp_create_simulated_channel(:'ch_o'::uuid, :'ws_um'::uuid, :'ana'::uuid, 'O', 'ho-o', '1', :'cifra', '1') is not null as ok \gset
reset role;

-- Entrada da inbox (cifra fictícia) e claim, como service_role: 'id|token'.
create function pg_temp.entrada(p_ch text, p_evt text, p_type text default 'whatsapp.inbound_message.received', p_claim boolean default true)
returns text language plpgsql as $f$
declare
  v_id text;
  v_token text;
begin
  execute 'set local role service_role';
  v_id := public.whatsapp_inbox_store(p_ch::uuid, '10000000-0000-0000-0000-000000000001'::uuid, 'simulated',
    case when p_ch like '%0001' then 'ho-a' else 'ho-o' end, p_evt, p_type,
    repeat('a', 64), '1', 'AAAAAAAAAAAAAAAA', 'Q29ycG8gZmljdGljaW8=', 'AAAAAAAAAAAAAAAAAAAAAA==', 3600) ->> 'inbox_id';
  if p_claim then
    v_token := public.whatsapp_inbox_claim(v_id::uuid, 300) ->> 'claim_token';
  end if;
  execute 'reset role';
  return v_id || '|' || coalesce(v_token, '-');
end
$f$;

-- Mensagem RECEBIDA pelo efeito da B3 (telefone sem BSUID), como service_role.
create function pg_temp.recebe(p_entry text, p_pmid text, p_phone text, p_occurred timestamptz default now()) returns jsonb language plpgsql as $f$
declare
  v jsonb;
begin
  execute 'set local role service_role';
  execute format('select public.whatsapp_effect_inbound_message(%L::uuid, %L::uuid, %L, ''text'', ''Mensagem fictícia recebida'', %L::timestamptz, %L, null, null, null, null)',
    split_part(p_entry, '|', 1), split_part(p_entry, '|', 2), p_pmid, p_occurred, p_phone) into v;
  execute 'reset role';
  return coalesce(v, 'null'::jsonb);
exception when others then
  execute 'reset role';
  return jsonb_build_object('erro', sqlerrm);
end
$f$;

-- Eco de mensagem enviada pelo aplicativo do celular, como service_role.
create function pg_temp.eco(p_entry text, p_pmid text, p_wamid text, p_phone text) returns jsonb language plpgsql as $f$
declare
  v jsonb;
begin
  execute 'set local role service_role';
  execute format('select public.whatsapp_effect_outbound_observed(%L::uuid, %L::uuid, %L, %L, ''text'', ''Mensagem fictícia do escritório'', now(), %L, null, null, null)',
    split_part(p_entry, '|', 1), split_part(p_entry, '|', 2), p_pmid, p_wamid, p_phone) into v;
  execute 'reset role';
  return coalesce(v, 'null'::jsonb);
exception when others then
  execute 'reset role';
  return jsonb_build_object('erro', sqlerrm);
end
$f$;

-- Gravação do horário de origem, como service_role: o jsonb devolvido, ou {"erro": mensagem}.
create function pg_temp.origem(p_entry text, p_at timestamptz, p_issue text default null) returns jsonb language plpgsql as $f$
declare
  v jsonb;
begin
  execute 'set local role service_role';
  select public.whatsapp_record_message_origin_time(split_part(p_entry, '|', 1)::uuid, p_at, p_issue) into v;
  execute 'reset role';
  return coalesce(v, 'null'::jsonb);
exception when others then
  execute 'reset role';
  return jsonb_build_object('erro', sqlerrm);
end
$f$;

-- Linha da mensagem do provedor: 'horário|fonte|motivo' (em ISO, UTC) ou '-'. Dinâmica: o arquivo
-- também roda (e falha) contra a versão anterior, sem as colunas.
create function pg_temp.msg(p_pmid text) returns text language plpgsql as $f$
declare
  v text;
begin
  execute format($q$select concat_ws('|',
    coalesce(to_char(m.origin_time_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), '-'),
    coalesce(m.origin_time_source, '-'), coalesce(m.origin_time_issue, '-'))
    from public.messages m where m.provider_message_id = %L$q$, p_pmid) into v;
  return v;
exception when others then
  return 'ERRO:' || sqlstate || ':' || sqlerrm;
end
$f$;

create function pg_temp.msg_id(p_pmid text) returns uuid language sql as $f$
  select id from public.messages where provider_message_id = p_pmid
$f$;

-- Veredito (dinâmico, pela mesma razão).
create function pg_temp.vd(p1 timestamptz, p2 text, p3 text, p4 timestamptz, p5 timestamptz, p6 timestamptz default null) returns text language plpgsql as $f$
declare
  v text;
begin
  execute format('select private.message_origin_time_verdict(%L::timestamptz, %L, %L, %L::timestamptz, %L::timestamptz, coalesce(%L::timestamptz, clock_timestamp()))', p1, p2, p3, p4, p5, p6) into v;
  return v;
exception when others then
  return 'ERRO:' || sqlstate || ':' || sqlerrm;
end
$f$;

create function pg_temp.ev(p_id uuid, p_decided timestamptz) returns text language plpgsql as $f$
declare
  v text;
begin
  execute format('select private.message_origin_time_evidence_verdict(%L::uuid, %L::timestamptz)', p_id, p_decided) into v;
  return v;
exception when others then
  return 'ERRO:' || sqlstate || ':' || sqlerrm;
end
$f$;

create function pg_temp.iso(p timestamptz) returns text language sql as $f$
  select to_char(p at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
$f$;

-- ---------------------------------------------------------------------
-- 1) Estrutura e permissões
-- ---------------------------------------------------------------------

select is(
  (select string_agg(column_name || ':' || data_type || ':' || is_nullable, ',' order by column_name)
   from information_schema.columns
   where table_schema = 'public' and table_name = 'messages' and column_name like 'origin_time_%'),
  'origin_time_at:timestamp with time zone:YES,origin_time_issue:text:YES,origin_time_source:text:YES',
  'três colunas novas, todas anuláveis: origem desconhecida é o estado normal'
);
select is(
  pg_temp.txt($$select pg_get_function_identity_arguments('public.whatsapp_record_message_origin_time'::regproc)$$),
  'p_inbox_id uuid, p_origin_at timestamp with time zone, p_origin_issue text',
  'assinatura: só a entrada, o horário que o evento trouxe e uma dica de ausência — nenhuma mensagem, fonte ou veredito do chamador'
);
select is(
  pg_temp.txt($$select (p.prosecdef and exists (select 1 from unnest(p.proconfig) c where c = 'search_path=""'))::text
    from pg_proc p where p.oid = 'public.whatsapp_record_message_origin_time'::regproc$$),
  'true', 'SECURITY DEFINER com search_path vazio'
);
select is(
  pg_temp.txt($q$select concat_ws(',',
     has_function_privilege('service_role', 'public.whatsapp_record_message_origin_time(uuid, timestamptz, text)', 'execute'),
     has_function_privilege('authenticated', 'public.whatsapp_record_message_origin_time(uuid, timestamptz, text)', 'execute'),
     has_function_privilege('anon', 'public.whatsapp_record_message_origin_time(uuid, timestamptz, text)', 'execute'))$q$),
  't,f,f', 'só o service_role executa a gravação da origem (nem authenticated, nem anon)'
);
select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'private' and p.proname in ('message_origin_time_issue', 'message_origin_time_verdict',
     'message_origin_time_evidence_verdict', 'messages_origin_time_insert', 'messages_origin_time_guard')
     and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute')
          or has_function_privilege('service_role', p.oid, 'execute'))),
  0, 'as cinco funções privadas não são executáveis por nenhum papel de API'
);
select is(
  (select string_agg(t.tgname, ',' order by t.tgname) from pg_trigger t
   where t.tgrelid = 'public.messages'::regclass and not t.tgisinternal and t.tgname like 'messages_origin_time_%'),
  'messages_origin_time_guard,messages_origin_time_insert', 'os dois gatilhos existem em messages'
);

-- ---------------------------------------------------------------------
-- 2) O efeito da B3 segue como estava: a origem NÃO nasce com a mensagem do provedor
-- ---------------------------------------------------------------------

select pg_temp.entrada(:'ch_a', 'ho-evt-0001') as e1 \gset
select pg_temp.recebe(:'e1', 'ho-pm-0001', '+5511900007001', now() - interval '3 hours') as r1 \gset
select is(:'r1'::jsonb ->> 'outcome', 'applied', 'mensagem recebida aplicada como sempre');
select is(pg_temp.msg('ho-pm-0001'), '-|-|-', 'recém recebida: origem desconhecida (nunca now() nem created_at)');
select is(
  (select (c.last_message_at = now() - interval '3 hours')::text from public.conversations c
   join public.messages m on m.conversation_id = c.id where m.provider_message_id = 'ho-pm-0001'),
  'true', 'last_message_at segue o significado de antes (o horário do evento), sem relação com a origem comprovada'
);

-- ---------------------------------------------------------------------
-- 3) Gravação válida: mensagem atrasada e fora de ordem mantém a origem antiga
-- ---------------------------------------------------------------------

select pg_temp.origem(:'e1', now() - interval '3 hours') as o1 \gset
select is(:'o1'::jsonb ->> 'outcome', 'recorded', 'horário válido gravado');
select is(
  pg_temp.txt($q$select (m.origin_time_at = now() - interval '3 hours' and m.origin_time_source = 'provider_send_time'
           and m.origin_time_issue is null and m.created_at = now())::text
   from public.messages m where m.provider_message_id = 'ho-pm-0001'$q$),
  'true', 'origem de 3 h atrás com fonte do provedor; created_at (chegada) continua sendo o da chegada'
);
select is(
  pg_temp.txt($q$select (m.origin_time_at < m.created_at)::text from public.messages m where m.provider_message_id = 'ho-pm-0001'$q$),
  'true', 'mensagem que chegou atrasada continua antiga: chegada depois da origem'
);
select pg_temp.origem(:'e1', now() - interval '3 hours') as o1b \gset
select is(:'o1b'::jsonb ->> 'outcome', 'unchanged', 'a mesma gravação repetida (cura de chamada perdida) não muda nada');

-- Fora de ordem: uma mensagem mais antiga que chega DEPOIS de uma mais nova.
select pg_temp.entrada(:'ch_a', 'ho-evt-0002') as e2 \gset
select pg_temp.recebe(:'e2', 'ho-pm-0002', '+5511900007001', now() - interval '5 hours') as r2 \gset
select pg_temp.origem(:'e2', now() - interval '5 hours') as o2 \gset
select is(:'o2'::jsonb ->> 'outcome', 'recorded', 'mensagem mais antiga chegando depois: origem própria gravada');
select is(
  pg_temp.txt($q$select (m2.origin_time_at < m1.origin_time_at and m2.created_at >= m1.created_at)::text
   from public.messages m1, public.messages m2 where m1.provider_message_id = 'ho-pm-0001' and m2.provider_message_id = 'ho-pm-0002'$q$),
  'true', 'a ordem de chegada não vira a ordem de origem'
);

-- ---------------------------------------------------------------------
-- 4) Ausente, futuro, antigo demais, unidade trocada e inválido: motivo, mensagem recebida
-- ---------------------------------------------------------------------

select pg_temp.entrada(:'ch_a', 'ho-evt-0003') as e3 \gset
select pg_temp.recebe(:'e3', 'ho-pm-0003', '+5511900007002') as r3 \gset
select pg_temp.origem(:'e3', null, 'missing') as o3 \gset
select is(:'o3'::jsonb ->> 'outcome', 'unverified', 'ausente: não verificado');
select is(pg_temp.msg('ho-pm-0003'), '-|-|missing', 'ausente: sem horário, motivo missing — nunca vira agora');
select is(
  (select count(*)::int from public.messages where provider_message_id = 'ho-pm-0003'), 1,
  'a mensagem ausente de horário continua recebida e exibível'
);

select pg_temp.entrada(:'ch_a', 'ho-evt-0004') as e4 \gset
select pg_temp.recebe(:'e4', 'ho-pm-0004', '+5511900007003') as r4 \gset
select pg_temp.origem(:'e4', null, null) as o4 \gset
select is(pg_temp.msg('ho-pm-0004'), '-|-|missing', 'horário nulo sem dica também é missing');

select pg_temp.entrada(:'ch_a', 'ho-evt-0005') as e5 \gset
select pg_temp.recebe(:'e5', 'ho-pm-0005', '+5511900007004') as r5 \gset
select pg_temp.origem(:'e5', now() + interval '10 minutes') as o5 \gset
select is(pg_temp.msg('ho-pm-0005'), '-|-|future', 'mais de 5 minutos à frente do relógio do banco: future');

select pg_temp.entrada(:'ch_a', 'ho-evt-0006') as e6 \gset
select pg_temp.recebe(:'e6', 'ho-pm-0006', '+5511900007005') as r6 \gset
select pg_temp.origem(:'e6', now() + interval '4 minutes') as o6 \gset
select is((pg_temp.msg('ho-pm-0006') like '%|provider_send_time|-')::text, 'true', 'até 5 minutos à frente é tolerado (relógios diferentes)');

select pg_temp.entrada(:'ch_a', 'ho-evt-0007') as e7 \gset
select pg_temp.recebe(:'e7', 'ho-pm-0007', '+5511900007006') as r7 \gset
select pg_temp.origem(:'e7', timestamptz '1970-01-01 00:00:00+00') as o7 \gset
select is(pg_temp.msg('ho-pm-0007'), '-|-|too_old', 'epoch zero: too_old');

select pg_temp.entrada(:'ch_a', 'ho-evt-0008') as e8 \gset
select pg_temp.recebe(:'e8', 'ho-pm-0008', '+5511900007007') as r8 \gset
-- segundos lidos como milissegundos: janeiro de 1970
select pg_temp.origem(:'e8', to_timestamp(extract(epoch from now())::bigint / 1000.0)) as o8 \gset
select is(pg_temp.msg('ho-pm-0008'), '-|-|too_old', 'unidade trocada (segundos lidos como milissegundos): too_old');

select pg_temp.entrada(:'ch_a', 'ho-evt-0009') as e9 \gset
select pg_temp.recebe(:'e9', 'ho-pm-0009', '+5511900007008') as r9 \gset
-- milissegundos lidos como segundos: ano ~56.000
select pg_temp.origem(:'e9', make_timestamptz(55000, 1, 1, 0, 0, 0, 'UTC')) as o9 \gset
select is(pg_temp.msg('ho-pm-0009'), '-|-|future', 'unidade trocada (milissegundos lidos como segundos): future');

select pg_temp.entrada(:'ch_a', 'ho-evt-0010') as e10 \gset
select pg_temp.recebe(:'e10', 'ho-pm-0010', '+5511900007009') as r10 \gset
select pg_temp.origem(:'e10', null, 'invalid') as o10 \gset
select is(pg_temp.msg('ho-pm-0010'), '-|-|invalid', 'dica invalid do servidor vira o motivo invalid');

select pg_temp.entrada(:'ch_a', 'ho-evt-0011') as e11 \gset
select pg_temp.recebe(:'e11', 'ho-pm-0011', '+5511900007010') as r11 \gset
select pg_temp.origem(:'e11', 'infinity'::timestamptz) as o11 \gset
select is(pg_temp.msg('ho-pm-0011'), '-|-|invalid', 'infinito não é horário: invalid');

-- Chamada malformada falha fechado, sem gravar nada.
select is(pg_temp.origem(:'e3', now(), 'missing') ->> 'erro', 'invalid_origin_time', 'horário e motivo juntos: recusado');
select is(pg_temp.origem(:'e3', null, 'future') ->> 'erro', 'invalid_origin_time', 'dica fora de {missing, invalid}: recusada (limites são do banco)');
select is(pg_temp.origem(:'e3', null, 'contradictory') ->> 'erro', 'invalid_origin_time', 'o servidor não declara contradição: ela é do banco');
select is(
  pg_temp.txt($$select public.whatsapp_record_message_origin_time(null, now(), null)$$),
  'ERRO:P0001:invalid_origin_time', 'entrada nula: recusada'
);

-- O primeiro julgamento prevalece: um horário válido depois de um motivo não o troca.
select pg_temp.origem(:'e3', now() - interval '1 hour') as o3b \gset
select is(:'o3b'::jsonb ->> 'outcome', 'unchanged', 'depois de missing, horário válido do mesmo evento não troca o julgamento');
select is(pg_temp.msg('ho-pm-0003'), '-|-|missing', 'continua missing');

-- ---------------------------------------------------------------------
-- 5) Duplicata e contradição
-- ---------------------------------------------------------------------

-- Outro evento (outra entrada), mesma mensagem do provedor, mesmo horário: confirma.
select pg_temp.entrada(:'ch_a', 'ho-evt-0101') as e101 \gset
select pg_temp.recebe(:'e101', 'ho-pm-0001', '+5511900007001', now() - interval '3 hours') as r101 \gset
select is(:'r101'::jsonb ->> 'outcome', 'duplicate', 'a mesma mensagem por outro evento: duplicate, como na B3');
select pg_temp.origem(:'e101', now() - interval '3 hours') as o101 \gset
select is(:'o101'::jsonb ->> 'outcome', 'unchanged', 'duplicata com o mesmo horário confirma, sem renovar nada');
select is(
  pg_temp.txt($q$select (m.origin_time_at = now() - interval '3 hours' and m.origin_time_issue is null)::text
   from public.messages m where m.provider_message_id = 'ho-pm-0001'$q$), 'true', 'a evidência não foi renovada pela duplicata');

-- Duplicata com horário MAIS RECENTE e contraditório: não escolhe, marca.
select pg_temp.entrada(:'ch_a', 'ho-evt-0102') as e102 \gset
select pg_temp.recebe(:'e102', 'ho-pm-0001', '+5511900007001') as r102 \gset
select pg_temp.origem(:'e102', now() - interval '1 hour') as o102 \gset
select is(:'o102'::jsonb ->> 'outcome', 'contradictory', 'duplicata com horário diferente: contraditório');
select is(
  pg_temp.msg('ho-pm-0001'), pg_temp.iso(now() - interval '3 hours') || '|provider_send_time|contradictory',
  'o horário gravado não é trocado (nem pelo mais recente) e a mensagem fica marcada'
);
select is(pg_temp.origem(:'e102', now() - interval '1 hour') ->> 'outcome', 'unchanged', 'depois de contraditória, nada mais muda');
select is(
  pg_temp.ev(pg_temp.msg_id('ho-pm-0001'), null), 'origin_contradictory',
  'mensagem contraditória não é elegível, nem sem decisão humana registrada'
);

-- Duplicata SEM horário válido não contradiz nem desfaz.
select pg_temp.entrada(:'ch_a', 'ho-evt-0103') as e103 \gset
select pg_temp.recebe(:'e103', 'ho-pm-0002', '+5511900007001') as r103 \gset
select pg_temp.origem(:'e103', null, 'missing') as o103 \gset
select is(:'o103'::jsonb ->> 'outcome', 'unchanged', 'duplicata sem horário não desfaz a origem verificada');
select is(pg_temp.msg('ho-pm-0002'), pg_temp.iso(now() - interval '5 hours') || '|provider_send_time|-', 'a origem verificada segue intacta');

-- Evento que NÃO criou a mensagem nunca preenche origem desconhecida.
select pg_temp.entrada(:'ch_a', 'ho-evt-0104') as e104 \gset
select pg_temp.recebe(:'e104', 'ho-pm-0104', '+5511900007011') as r104 \gset
select pg_temp.entrada(:'ch_a', 'ho-evt-0105') as e105 \gset
select pg_temp.recebe(:'e105', 'ho-pm-0104', '+5511900007011') as r105 \gset
select is(:'r105'::jsonb ->> 'outcome', 'duplicate', 'segundo evento da mesma mensagem recém criada');
-- O ledger do segundo evento nasceu numa instrução posterior? No pgTAP tudo é UMA transação: força a
-- diferença de instante como na realidade (outra transação).
update public.whatsapp_effect_ledger set recorded_at = recorded_at + interval '1 second'
where inbox_id = split_part(:'e105', '|', 1)::uuid;
select pg_temp.origem(:'e105', now() - interval '2 hours') as o105 \gset
select is(:'o105'::jsonb ->> 'outcome', 'unchanged', 'evento duplicado não preenche origem desconhecida');
select is(pg_temp.msg('ho-pm-0104'), '-|-|-', 'a mensagem segue desconhecida até o evento que a criou gravar');
select pg_temp.origem(:'e104', now() - interval '2 hours') as o104 \gset
select is(:'o104'::jsonb ->> 'outcome', 'recorded', 'o evento que criou a mensagem a preenche (cura de chamada perdida)');

-- ---------------------------------------------------------------------
-- 6) Saída observada (eco do aplicativo): mesma regra
-- ---------------------------------------------------------------------

select pg_temp.entrada(:'ch_o', 'ho-evt-0201', 'whatsapp.smb.message.echoes') as e201 \gset
select pg_temp.eco(:'e201', 'ho-pm-0201', 'wamid.HOECO0201', '+5511900007020') as r201 \gset
select is(:'r201'::jsonb ->> 'outcome', 'applied', 'eco aplicado como sempre');
select is(pg_temp.msg('ho-pm-0201'), '-|-|-', 'o eco também nasce com origem desconhecida');
select pg_temp.origem(:'e201', now() - interval '2 hours') as o201 \gset
select is(:'o201'::jsonb ->> 'outcome', 'recorded', 'o eco recebe o horário do provedor');
select is(
  pg_temp.txt($q$select m.origin::text || '|' || m.origin_time_source from public.messages m where m.provider_message_id = 'ho-pm-0201'$q$),
  'business_app|provider_send_time', 'origem business_app, fonte provider_send_time'
);

-- Mensagem do CRM que ganha um eco do mesmo provedor: nunca vira origem de provedor.
insert into public.messages (workspace_id, conversation_id, channel_id, direction, origin, sender_classification, content_kind, body_text, status, provider, provider_message_id, sent_by, client_dedupe_key)
select workspace_id, conversation_id, channel_id, 'outbound', 'crm', 'internal', 'text', 'Resposta fictícia do escritório', 'sent', 'simulated', 'ho-pm-crm', :'ana'::uuid, gen_random_uuid()
from public.messages where provider_message_id = 'ho-pm-0001';
select pg_temp.entrada(:'ch_a', 'ho-evt-0401', 'whatsapp.smb.message.echoes') as e401 \gset
select pg_temp.eco(:'e401', 'ho-pm-crm', 'wamid.HOCRM', '+5511900007001') as r401 \gset
select is(:'r401'::jsonb ->> 'outcome', 'duplicate', 'o eco de uma mensagem que o CRM enviou é reconhecido como duplicada');
select is(pg_temp.origem(:'e401', now() - interval '1 hour') ->> 'outcome', 'not_applicable', 'mensagem do CRM não recebe horário de provedor');
select is((pg_temp.msg('ho-pm-crm') like '%|crm_accepted|-')::text, 'true', 'a origem da mensagem do CRM segue sendo a do próprio CRM');

-- ---------------------------------------------------------------------
-- 7) Quem pode (e quem não pode) informar ou alterar o horário
-- ---------------------------------------------------------------------

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'ana', 'role', 'authenticated')::text, true);
select is(
  pg_temp.txt(format($$select public.whatsapp_record_message_origin_time(%L::uuid, now(), null)$$, split_part(:'e104', '|', 1))),
  'ERRO:42501:permission denied for function whatsapp_record_message_origin_time',
  'usuário autenticado (até owner) não grava origem'
);
select is(
  pg_temp.txt($$update public.messages set origin_time_at = now()$$),
  'ERRO:42501:permission denied for table messages', 'usuário autenticado não escreve em messages'
);
reset role;
set local role anon;
select is(
  pg_temp.txt(format($$select public.whatsapp_record_message_origin_time(%L::uuid, now(), null)$$, split_part(:'e104', '|', 1))),
  'ERRO:42501:permission denied for function whatsapp_record_message_origin_time', 'anon não grava origem'
);
reset role;

-- Nem o próprio dono do banco altera origem por SQL comum.
select is(
  pg_temp.txt($$update public.messages set origin_time_at = now() where provider_message_id = 'ho-pm-0002'$$),
  'ERRO:P0001:origin_time_immutable', 'UPDATE direto do horário é recusado'
);
select is(
  pg_temp.txt($$update public.messages set origin_time_issue = 'contradictory' where provider_message_id = 'ho-pm-0002'$$),
  'ERRO:P0001:origin_time_immutable', 'UPDATE direto do motivo também'
);
select is(
  pg_temp.txt($$update public.messages set origin_time_at = null, origin_time_source = null where provider_message_id = 'ho-pm-0002'$$),
  'ERRO:P0001:origin_time_immutable', 'UPDATE direto não apaga a origem'
);
-- Mesmo com a chave interna ligada, as transições são fechadas: horário gravado nunca é trocado.
select set_config('praxis.message_origin_writer', 'on', true);
select is(
  pg_temp.txt($$update public.messages set origin_time_at = now() where provider_message_id = 'ho-pm-0002'$$),
  'ERRO:P0001:origin_time_immutable', 'com a chave interna ligada, um horário verificado ainda não pode ser trocado'
);
select is(
  pg_temp.txt($$update public.messages set origin_time_at = null, origin_time_source = null, origin_time_issue = 'missing' where provider_message_id = 'ho-pm-0002'$$),
  'ERRO:P0001:origin_time_immutable', 'nem rebaixado para um motivo'
);
select is(
  pg_temp.txt($$update public.messages set origin_time_issue = null where provider_message_id = 'ho-pm-0001'$$),
  'ERRO:P0001:origin_time_immutable', 'nem uma mensagem contraditória volta a verificada'
);
select is(
  pg_temp.txt($$update public.messages set origin_time_at = now(), origin_time_source = 'provider_send_time', origin_time_issue = 'contradictory' where provider_message_id = 'ho-pm-0003'$$),
  'ERRO:P0001:origin_time_immutable', 'nem desconhecido -> contraditório; e missing não é revertido'
);
select set_config('praxis.message_origin_writer', '', true);
select is(
  pg_temp.txt($q$select count(*)::int from public.messages where provider_message_id = 'ho-pm-0002'
   and origin_time_at = now() - interval '5 hours'$q$), '1', 'depois de todas as tentativas, a origem verificada segue exatamente igual'
);

-- A fonte é fechada.
select is(
  pg_temp.txt($$update public.messages set origin_time_source = 'user_typed' where provider_message_id = 'ho-pm-0104'$$),
  'ERRO:P0001:origin_time_immutable', 'fonte fora da lista nem chega a ser avaliada'
);
select is(
  (select count(*)::int from pg_constraint where conname = 'messages_origin_time_shape' and conrelid = 'public.messages'::regclass), 1,
  'restrição de formato presente (fonte, motivo, par horário/fonte e limites)'
);

-- Inserção nunca carrega origem.
select is(
  pg_temp.txt(format($$insert into public.messages (workspace_id, conversation_id, channel_id, direction, origin, sender_classification, content_kind, body_text, provider, provider_message_id, status, origin_time_at, origin_time_source)
    select workspace_id, conversation_id, channel_id, 'inbound', 'inbound', 'external', 'text', 'x', provider, 'ho-pm-forjada', 'delivered', now(), 'provider_send_time'
    from public.messages where id = %L::uuid$$, pg_temp.msg_id('ho-pm-0002'))),
  'ERRO:P0001:origin_time_not_insertable', 'inserir mensagem já com origem é recusado'
);

-- ---------------------------------------------------------------------
-- 8) Simulador da A7 (o chamador escolhe o horário): nunca comprova origem
-- ---------------------------------------------------------------------

insert into public.memberships (workspace_id, user_id, role, status)
values (:'ws_um'::uuid, :'ana'::uuid, 'owner', 'active')
on conflict (workspace_id, user_id) do update set role = 'owner', status = 'active';
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'ana', 'role', 'authenticated')::text, true);
select (create_whatsapp_channel(:'ws_um'::uuid, 'Canal A7', 'ho-a7-phone', '+55 11 0000-5701')).id as ch_a7 \gset
select simulate_inbound_whatsapp_message('ho-a7-phone', '5511900007099', '+5511900007099', 'wamid.ho.a7.001', now() - interval '30 minutes', 'oi', null) ->> 'conversation_id' as cv_a7 \gset
reset role;
select is(
  pg_temp.txt($q$select concat_ws('|', coalesce(m.origin_time_at::text, '-'), coalesce(m.origin_time_source, '-'), coalesce(m.origin_time_issue, '-'))
   from public.messages m where m.wa_message_id = 'wamid.ho.a7.001'$q$),
  '-|-|-', 'simulador (horário escolhido por quem chama): origem desconhecida, nunca comprovada'
);
select is(
  (select (c.last_message_at = now() - interval '30 minutes')::text from public.conversations c where c.id = :'cv_a7'::uuid),
  'true', 'last_message_at do simulador segue como antes'
);

-- ---------------------------------------------------------------------
-- 9) Envio humano do CRM: o instante é o do banco, gravado por gatilho
-- ---------------------------------------------------------------------

insert into public.messages (workspace_id, conversation_id, channel_id, direction, origin, sender_classification, content_kind, body_text, status, sent_by, client_dedupe_key, wa_message_id)
select workspace_id, id, channel_id, 'outbound', 'crm', 'internal', 'text', 'Resposta fictícia do escritório', 'sent', :'ana'::uuid, gen_random_uuid(), 'wamid.ho.crm.001'
from public.conversations where id = :'cv_a7'::uuid;
select is(
  pg_temp.txt($q$select concat_ws('|', (m.origin_time_at = m.created_at)::text, m.origin_time_source, coalesce(m.origin_time_issue, '-'))
   from public.messages m where m.wa_message_id = 'wamid.ho.crm.001'$q$),
  'true|crm_accepted|-', 'envio humano do CRM: origem = instante em que o CRM aceitou, fonte crm_accepted'
);
-- Saída do chatbot/API e automação não ganham origem do CRM.
select is(
  pg_temp.txt($q$select count(*)::int from public.messages where origin <> 'crm' and origin_time_source = 'crm_accepted'$q$), '0',
  'nenhuma mensagem de outra origem recebe crm_accepted'
);

-- ---------------------------------------------------------------------
-- 10) Status nunca é origem
-- ---------------------------------------------------------------------

select is(
  (select count(*)::int from public.messages m where m.wa_message_id = 'wamid.ho.crm.001' and m.status = 'sent'), 1,
  'pré-condição: a mensagem do CRM está em sent'
);
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'ana', 'role', 'authenticated')::text, true);
select apply_message_status_event('ho-a7-phone', 'wamid.ho.crm.001', 'delivered', now() + interval '2 minutes') is not null as ok \gset
reset role;
select is(
  pg_temp.txt($q$select concat_ws('|', (m.origin_time_at = m.created_at)::text, m.origin_time_source)
   from public.messages m where m.wa_message_id = 'wamid.ho.crm.001'$q$),
  'true|crm_accepted', 'um status de entrega (horário diferente) não toca a origem da mensagem'
);
select is(
  (select (m.status = 'delivered')::text from public.messages m where m.wa_message_id = 'wamid.ho.crm.001'), 'true',
  'o status foi aplicado (a gravação da origem não o impediu)'
);

-- ---------------------------------------------------------------------
-- 11) Regra de comparação com manual_decided_at (contrato do aplicador)
-- ---------------------------------------------------------------------

-- O caso obrigatório: enviada às 9h, decisão manual às 10h, recebida às 10h30.
select is(
  pg_temp.vd(
    timestamptz '2026-11-18 09:00:00+00', 'provider_send_time', null,
    timestamptz '2026-11-18 10:30:00+00', timestamptz '2026-11-18 10:00:00+00', timestamptz '2026-11-18 11:00:00+00'),
  'not_after_decision', 'enviada 9h, decisão 10h, recebida 10h30: NÃO é posterior à decisão'
);
select is(
  pg_temp.vd(
    timestamptz '2026-11-18 10:20:00+00', 'provider_send_time', null,
    timestamptz '2026-11-18 10:30:00+00', timestamptz '2026-11-18 10:00:00+00', timestamptz '2026-11-18 11:00:00+00'),
  'eligible', 'enviada 10h20, depois da decisão das 10h: elegível (só no tempo; não prova mais nada)'
);
select is(
  pg_temp.vd(
    timestamptz '2026-11-18 10:00:00+00', 'provider_send_time', null,
    timestamptz '2026-11-18 10:30:00+00', timestamptz '2026-11-18 10:00:00+00', timestamptz '2026-11-18 11:00:00+00'),
  'not_after_decision', 'empate exato: não autoriza'
);
select is(
  pg_temp.vd(
    timestamptz '2026-11-18 10:00:05+00', 'provider_send_time', null,
    timestamptz '2026-11-18 10:30:00+00', timestamptz '2026-11-18 10:00:00+00', timestamptz '2026-11-18 11:00:00+00'),
  'not_after_decision', 'exatamente a margem de 5 s: ainda não autoriza (precisa passar)'
);
select is(
  pg_temp.vd(
    timestamptz '2026-11-18 10:00:05.001+00', 'provider_send_time', null,
    timestamptz '2026-11-18 10:30:00+00', timestamptz '2026-11-18 10:00:00+00', timestamptz '2026-11-18 11:00:00+00'),
  'eligible', '1 ms além da margem: elegível'
);
select is(
  pg_temp.vd(
    timestamptz '2026-11-18 10:00:03+00', 'provider_send_time', null,
    timestamptz '2026-11-18 10:30:00+00', timestamptz '2026-11-18 10:00:00.700+00', timestamptz '2026-11-18 11:00:00+00'),
  'not_after_decision', 'precisão: horário do provedor em segundos e marco em microssegundos, dentro da margem, não autorizam'
);
select is(
  pg_temp.vd(
    timestamptz '2026-11-18 09:00:00+00', 'provider_send_time', null,
    timestamptz '2026-11-18 10:30:00+00', null, timestamptz '2026-11-18 11:00:00+00'),
  'eligible', 'sem decisão humana registrada não há com o que comparar: basta a origem válida'
);
select is(
  pg_temp.vd(
    timestamptz '2026-11-18 10:20:00+00', 'provider_send_time', null,
    timestamptz '2026-11-18 10:30:00+00', timestamptz '2026-11-18 12:00:00+00', timestamptz '2026-11-18 11:00:00+00'),
  'decision_marker_suspect', 'marco da decisão no futuro (mais de 5 min): suspeito, não autoriza'
);
select is(
  pg_temp.vd(
    timestamptz '2026-11-18 10:20:00+00', 'provider_send_time', null,
    timestamptz '2026-11-18 10:30:00+00', 'infinity'::timestamptz, timestamptz '2026-11-18 11:00:00+00'),
  'decision_marker_suspect', 'marco infinito: suspeito'
);
select is(
  pg_temp.vd(
    timestamptz '2026-11-18 12:00:00+00', 'provider_send_time', null,
    timestamptz '2026-11-18 12:00:01+00', timestamptz '2026-11-18 10:00:00+00', timestamptz '2026-11-18 11:00:00+00'),
  'origin_future', 'origem à frente do relógio (mais de 5 min): futuro suspeito'
);
select is(
  pg_temp.vd(
    timestamptz '2026-11-18 10:50:00+00', 'provider_send_time', null,
    timestamptz '2026-11-18 10:30:00+00', timestamptz '2026-11-18 10:00:00+00', timestamptz '2026-11-18 11:00:00+00'),
  'origin_future', 'origem mais de 5 min DEPOIS da chegada ao CRM: incoerente'
);
select is(
  pg_temp.vd(
    timestamptz '2026-11-18 10:20:00+00', 'provider_send_time', null,
    null, timestamptz '2026-11-18 10:00:00+00', timestamptz '2026-11-18 11:00:00+00'),
  'arrival_unknown', 'sem horário de chegada: não autoriza'
);
select is(
  pg_temp.vd(null, null, null, timestamptz '2026-11-18 10:30:00+00', timestamptz '2026-11-18 10:00:00+00', timestamptz '2026-11-18 11:00:00+00'),
  'origin_unknown', 'origem desconhecida (legado, simulador): não autoriza'
);
select is(
  pg_temp.vd(null, null, 'missing', timestamptz '2026-11-18 10:30:00+00', null, timestamptz '2026-11-18 11:00:00+00'),
  'origin_missing', 'motivo missing: não autoriza, nem sem decisão registrada'
);
select is(
  pg_temp.vd(timestamptz '2026-11-18 10:20:00+00', 'provider_send_time', 'contradictory',
    timestamptz '2026-11-18 10:30:00+00', null, timestamptz '2026-11-18 11:00:00+00'),
  'origin_contradictory', 'contraditória: não autoriza'
);
select is(
  pg_temp.vd(timestamptz '2000-01-01 00:00:00+00', 'provider_send_time', null,
    timestamptz '2026-11-18 10:30:00+00', null, timestamptz '2026-11-18 11:00:00+00'),
  'origin_too_old', 'origem anterior a 2009 que escapou do gatilho: não autoriza'
);
select is(
  pg_temp.vd(timestamptz '2026-11-18 10:20:00+00', 'crm_accepted', null,
    timestamptz '2026-11-18 10:20:00+00', timestamptz '2026-11-18 10:00:00+00', timestamptz '2026-11-18 11:00:00+00'),
  'eligible', 'envio humano do CRM compara do mesmo jeito'
);
select is(
  pg_temp.ev(pg_temp.msg_id('ho-pm-0002'), now() - interval '6 hours'), 'eligible',
  'mensagem gravada: origem de 5 h atrás vs decisão de 6 h atrás'
);
select is(
  pg_temp.ev(pg_temp.msg_id('ho-pm-0002'), now() - interval '4 hours'), 'not_after_decision',
  'mensagem gravada: origem de 5 h atrás vs decisão de 4 h atrás — a chegada (agora) não a faz posterior'
);
select is(
  pg_temp.ev(pg_temp.msg_id('ho-pm-0104'), null), 'eligible',
  'mensagem preenchida pelo evento que a criou: elegível sem decisão registrada'
);
select is(
  pg_temp.ev(pg_temp.msg_id('ho-pm-0003'), null), 'origin_missing', 'mensagem gravada sem horário: origin_missing'
);
select is(
  pg_temp.ev(gen_random_uuid(), null), 'message_not_found', 'mensagem inexistente'
);

-- ---------------------------------------------------------------------
-- 12) Exportação do titular e retenção
-- ---------------------------------------------------------------------

select is(
  (select jsonb_typeof(x -> 'origin_time') from (
     select jsonb_array_elements(private.privacy_export_payload(:'ws_um'::uuid, c.contact_id) -> 'messages') x
     from public.conversations c where c.id = :'cv_a7'::uuid and c.contact_id is not null limit 1) s limit 1),
  'object', 'a exportação do titular leva origin_time em cada mensagem'
);
select is(
  (select x -> 'origin_time' ->> 'source' from (
     select jsonb_array_elements(private.privacy_export_payload(:'ws_um'::uuid, c.contact_id) -> 'messages') x
     from public.conversations c where c.id = :'cv_a7'::uuid and c.contact_id is not null) s
   where x ->> 'direction' = 'outbound' limit 1),
  'crm_accepted', 'a fonte aparece na exportação'
);
select is(
  (select (x -> 'origin_time' ->> 'at' is null and x -> 'origin_time' ->> 'source' is null)::text from (
     select jsonb_array_elements(private.privacy_export_payload(:'ws_um'::uuid, c.contact_id) -> 'messages') x
     from public.conversations c where c.id = :'cv_a7'::uuid and c.contact_id is not null) s
   where x ->> 'direction' = 'inbound' limit 1),
  'true', 'mensagem de origem desconhecida exporta nulos (nunca inventa horário)'
);
select is(
  (select count(*)::int from (
     select jsonb_array_elements(private.privacy_export_payload(:'ws_um'::uuid, c.contact_id) -> 'messages') x
     from public.conversations c where c.id = :'cv_a7'::uuid and c.contact_id is not null) s
   where not (x ? 'created_at' and x ? 'origin_time' and x ? 'status_updated_at')), 0,
  'a seção de mensagens mantém as chaves de antes e acrescenta só origin_time'
);

-- Retenção (C3b): a mensagem sai com a conversa; a gravação depois disso não acha nada.
select pg_temp.entrada(:'ch_a', 'ho-evt-0301') as e301 \gset
select pg_temp.recebe(:'e301', 'ho-pm-0301', '+5511900007301') as r301 \gset
delete from public.conversations where id = (:'r301'::jsonb ->> 'conversation_id')::uuid;
select is(
  (select count(*)::int from public.messages where provider_message_id = 'ho-pm-0301'), 0,
  'a conversa apagada leva a mensagem e as colunas de origem (cascata)'
);
select is(pg_temp.origem(:'e301', now()) ->> 'outcome', 'not_found', 'gravar origem de mensagem já apagada: not_found, nada ressuscita');
select is(pg_temp.origem(gen_random_uuid()::text || '|x', now()) ->> 'outcome', 'not_found', 'entrada sem efeito de mensagem: not_found');

select * from finish();
rollback;
