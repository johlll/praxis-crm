-- pgTAP — B3.3: saída humana pelo CRM, provedor simulado
-- (docs/decisoes/b3-whatsapp-real.md §28.18).
--
-- Prova: ambiente assinado obrigatório; owner/admin ligam o envio só de canal
-- ativo e simulado (Production recusado; o YCloud de Preview é provado no 44); send_enabled=false bloqueia;
-- papel, workspace, acesso à conversa, vínculo e consentimento; texto livre só
-- dentro da janela; template só aprovado, utility e com caso vinculado
-- (marketing bloqueado); mensagem do CRM nasce com origin=crm e
-- sender_classification=internal; idempotência por intenção; no máximo uma
-- tentativa e resultado incerto nunca reenviado; envio desligado entre a
-- reserva e a chamada; auditoria sem conteúdo; send_message da A7 recusa canal
-- da B3. Nenhuma chave real e nenhuma rede: valores de teste, só desta transação.

begin;
select plan(100);

\set ana     '20000000-0000-0000-0000-000000000001'
\set bruno   '20000000-0000-0000-0000-000000000002'
\set carla   '20000000-0000-0000-0000-000000000003'
\set daniel  '20000000-0000-0000-0000-000000000004'
\set leitor  '20000000-0000-0000-0000-000000000005'
\set ws_um   '10000000-0000-0000-0000-000000000001'
\set ws_dois '10000000-0000-0000-0000-000000000002'
\set contato '40000000-0000-0000-0000-000000000001'
\set contato2 '40000000-0000-0000-0000-000000000003'
\set ch_sim  '61000000-0000-0000-0000-00000000000a'
\set ch_off  '61000000-0000-0000-0000-00000000000b'
\set ch_yc   '61000000-0000-0000-0000-00000000000c'
\set ch_prod '61000000-0000-0000-0000-00000000000d'
\set ch_paus '61000000-0000-0000-0000-00000000000e'
\set cv_ok   '62000000-0000-0000-0000-00000000000a'
\set cv_old  '62000000-0000-0000-0000-00000000000b'
\set cv_nolink '62000000-0000-0000-0000-00000000000c'
\set cv_nocons '62000000-0000-0000-0000-00000000000d'
\set cv_nolead '62000000-0000-0000-0000-00000000000e'
\set cv_off  '62000000-0000-0000-0000-00000000000f'
\set k1 '63000000-0000-0000-0000-000000000001'
\set k2 '63000000-0000-0000-0000-000000000002'
\set k3 '63000000-0000-0000-0000-000000000003'
\set k4 '63000000-0000-0000-0000-000000000004'
\set k5 '63000000-0000-0000-0000-000000000005'
\set k6 '63000000-0000-0000-0000-000000000006'
\set k7 '63000000-0000-0000-0000-000000000007'
\set k8 '63000000-0000-0000-0000-000000000008'
\set k9 '63000000-0000-0000-0000-000000000009'
\set cifra 'QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFB'

-- daniel: manager no Um. carla: lawyer no Um. leitor: viewer no Um. bruno: dono do Dois.
insert into public.memberships (workspace_id, user_id, role, status) values
  (:'ws_um'::uuid, :'daniel'::uuid, 'manager', 'active'),
  (:'ws_dois'::uuid, :'daniel'::uuid, 'admin', 'active');

insert into public.whatsapp_environment_keys (environment, signing_key) values
  ('production', 'chave-whatsapp-producao-de-teste-0123456789'),
  ('preview', 'chave-whatsapp-preview-de-teste-0123456789ab');

create function pg_temp.hdr(p_env text, p_expires bigint default null)
returns text language sql as $f$
  select json_build_object(
    'x-praxis-whatsapp-env',
    'v1.' || p_env || '.' || e.x || '.' ||
      private.whatsapp_environment_signature(p_env, e.x, (select signing_key from public.whatsapp_environment_keys where environment = p_env::public.whatsapp_environment))
  )::text
  from (select coalesce(p_expires, extract(epoch from now())::bigint + 300) as x) e
$f$;
select pg_temp.hdr('preview') as h_prev \gset
select pg_temp.hdr('production') as h_prod \gset

-- Cenário (como administrador do banco): contato com e sem consentimento, caso (lead) e conversas.
insert into public.contact_consents (workspace_id, contact_id, channel, legal_basis, purpose, purpose_code, granted_at, created_by)
values (:'ws_um'::uuid, :'contato'::uuid, 'whatsapp', 'consentimento', 'Atendimento por WhatsApp', 'whatsapp_atendimento', now() - interval '1 day', :'ana'::uuid);

insert into public.leads (id, workspace_id, contact_id, legal_area, summary, priority, created_by)
values ('64000000-0000-0000-0000-000000000001', :'ws_um'::uuid, :'contato'::uuid, 'Civil', 'Caso de teste da B3.3.', 'media', :'ana'::uuid);

set local role service_role;
select set_config('request.jwt.claims', '', true);
select set_config('request.headers', :'h_prev', true);

select whatsapp_create_simulated_channel(:'ch_sim'::uuid, :'ws_um'::uuid, :'ana'::uuid, 'Saída', 'b33-sim', '+55 11 0000-0501', :'cifra', '1') is not null as ok \gset
select whatsapp_create_simulated_channel(:'ch_off'::uuid, :'ws_um'::uuid, :'ana'::uuid, 'Sem envio', 'b33-off', '+55 11 0000-0502', :'cifra', '1') is not null as ok \gset
select whatsapp_create_simulated_channel(:'ch_paus'::uuid, :'ws_um'::uuid, :'ana'::uuid, 'Pausado', 'b33-paus', '+55 11 0000-0503', :'cifra', '1') is not null as ok \gset
select whatsapp_create_ycloud_channel(:'ch_yc'::uuid, :'ws_um'::uuid, :'ana'::uuid, 'YCloud', 'B33WABA:5511000000001', '+55 11 0000-0504', :'cifra', '1', :'cifra', '1') is not null as ok \gset
select set_config('request.headers', :'h_prod', true);
select whatsapp_create_simulated_channel(:'ch_prod'::uuid, :'ws_um'::uuid, :'ana'::uuid, 'Production', 'b33-prod', '+55 11 0000-0505', :'cifra', '1') is not null as ok \gset
select set_config('request.headers', :'h_prev', true);
select whatsapp_pause_channel(:'ch_paus'::uuid, :'ws_um'::uuid, :'ana'::uuid) is not null as ok \gset

reset role;

insert into public.conversations (id, workspace_id, channel_id, wa_id, contact_id, lead_id) values
  (:'cv_ok'::uuid,     :'ws_um'::uuid, :'ch_sim'::uuid,  '+5511900005001', :'contato'::uuid,  '64000000-0000-0000-0000-000000000001'),
  (:'cv_old'::uuid,    :'ws_um'::uuid, :'ch_sim'::uuid,  '+5511900005002', :'contato'::uuid,  '64000000-0000-0000-0000-000000000001'),
  (:'cv_nolink'::uuid, :'ws_um'::uuid, :'ch_sim'::uuid,  '+5511900005003', null, null),
  (:'cv_nocons'::uuid, :'ws_um'::uuid, :'ch_sim'::uuid,  '+5511900005004', :'contato2'::uuid, null),
  (:'cv_nolead'::uuid, :'ws_um'::uuid, :'ch_sim'::uuid,  '+5511900005005', :'contato'::uuid,  null),
  (:'cv_off'::uuid,    :'ws_um'::uuid, :'ch_off'::uuid,  '+5511900005006', :'contato'::uuid,  null);

-- Mensagens recebidas: a janela conta a partir da última.
insert into public.messages (workspace_id, conversation_id, channel_id, direction, origin, sender_classification, content_kind, body_text, provider, provider_message_id, status, created_at)
select :'ws_um'::uuid, c.id, c.channel_id, 'inbound', 'inbound', 'external', 'text', 'Olá', 'simulated', 'in-' || c.wa_id,
       'delivered', case when c.id = :'cv_old'::uuid then now() - interval '25 hours' else now() - interval '10 minutes' end
from public.conversations c where c.id in (:'cv_ok'::uuid, :'cv_old'::uuid, :'cv_nolink'::uuid, :'cv_nocons'::uuid, :'cv_nolead'::uuid, :'cv_off'::uuid);

-- ---------------------------------------------------------------------
-- 1) Estrutura e privilégios
-- ---------------------------------------------------------------------

select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('whatsapp_enable_channel_send', 'whatsapp_upsert_template', 'whatsapp_send_context',
                       'whatsapp_reserve_send', 'whatsapp_outbox_begin', 'whatsapp_outbox_finish')
     and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute')
          or exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0))),
  0,
  'as seis funções novas não são executáveis por anon, authenticated nem public'
);
select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('whatsapp_enable_channel_send', 'whatsapp_upsert_template', 'whatsapp_send_context',
                       'whatsapp_reserve_send', 'whatsapp_outbox_begin', 'whatsapp_outbox_finish')
     and has_function_privilege('service_role', p.oid, 'execute')
     and p.prosecdef and p.proconfig @> array['search_path=""']),
  6,
  'as seis são SECURITY DEFINER, com search_path travado, e executáveis por service_role'
);
select ok(
  (select relrowsecurity and relforcerowsecurity from pg_class where oid = 'public.whatsapp_outbox'::regclass)
    and (select relrowsecurity and relforcerowsecurity from pg_class where oid = 'public.whatsapp_templates'::regclass),
  'outbox e templates: RLS habilitada e forçada'
);
select table_privs_are('public', 'whatsapp_outbox', 'authenticated', array[]::text[], 'outbox: authenticated sem privilégio');
select table_privs_are('public', 'whatsapp_templates', 'authenticated', array[]::text[], 'templates: authenticated sem privilégio');
select table_privs_are('public', 'whatsapp_outbox', 'anon', array[]::text[], 'outbox: anon sem privilégio');

set local role service_role;
select set_config('request.headers', '{}', true);
select throws_ok(
  format($i$ select whatsapp_reserve_send(%L::uuid, %L::uuid, %L::uuid, %L::uuid, 'text', 'x', null, null) $i$, :'cv_ok', :'ws_um', :'ana', :'k1'),
  'P0001', 'whatsapp_environment_required', 'sem ambiente assinado: a reserva é recusada'
);
select throws_ok(
  format($i$ select whatsapp_send_context(%L::uuid, %L::uuid, %L::uuid) $i$, :'cv_ok', :'ws_um', :'ana'),
  'P0001', 'whatsapp_environment_required', 'sem ambiente assinado: o contexto é recusado'
);
select set_config('request.headers', :'h_prev', true);

-- ---------------------------------------------------------------------
-- 2) Ligar o envio: só canal ativo e simulado, por owner/admin
-- ---------------------------------------------------------------------

select throws_ok(
  format($i$ select whatsapp_enable_channel_send(%L::uuid, %L::uuid, %L::uuid) $i$, :'ch_sim', :'ws_um', :'daniel'),
  'P0001', 'insufficient_permission', 'manager não liga o envio'
);
select throws_ok(
  format($i$ select whatsapp_enable_channel_send(%L::uuid, %L::uuid, %L::uuid) $i$, :'ch_sim', :'ws_um', :'bruno'),
  'P0001', 'insufficient_permission', 'dono de outro workspace não liga o envio'
);
select throws_ok(
  format($i$ select whatsapp_enable_channel_send(%L::uuid, %L::uuid, %L::uuid) $i$, :'ch_yc', :'ws_um', :'ana'),
  'P0001', 'invalid_channel_state', 'canal YCloud pausado (como nasce) não liga o envio; o portão do YCloud de Preview está em 44_b3_3_portao_ycloud_preview'
);
select throws_ok(
  format($i$ select whatsapp_enable_channel_send(%L::uuid, %L::uuid, %L::uuid) $i$, :'ch_paus', :'ws_um', :'ana'),
  'P0001', 'invalid_channel_state', 'canal pausado não liga o envio'
);
select set_config('request.headers', :'h_prod', true);
select throws_ok(
  format($i$ select whatsapp_enable_channel_send(%L::uuid, %L::uuid, %L::uuid) $i$, :'ch_prod', :'ws_um', :'ana'),
  'P0001', 'invalid_channel_state', 'canal simulado de Production nunca liga o envio'
);
select set_config('request.headers', :'h_prev', true);
reset role;
select throws_ok(
  format($i$ update public.whatsapp_channels set send_enabled = true where id = %L::uuid $i$, :'ch_prod'),
  '23514', null, 'a restrição do banco: canal simulado de Production nunca habilita envio'
);
set local role service_role;
select set_config('request.headers', :'h_prev', true);
select is(
  (select send_enabled from public.whatsapp_channels where id = :'ch_yc'::uuid)
    or (select send_enabled from public.whatsapp_channels where id = :'ch_prod'::uuid)
    or (select send_enabled from public.whatsapp_channels where id = :'ch_paus'::uuid),
  false,
  'nenhuma das recusas ligou o envio'
);

-- ---------------------------------------------------------------------
-- 3) send_enabled=false bloqueia
-- ---------------------------------------------------------------------

select is(
  (whatsapp_send_context(:'cv_ok'::uuid, :'ws_um'::uuid, :'ana'::uuid)) ->> 'blocked_reason',
  'send_disabled',
  'contexto: envio desligado aparece como motivo do bloqueio'
);
select throws_ok(
  format($i$ select whatsapp_reserve_send(%L::uuid, %L::uuid, %L::uuid, %L::uuid, 'text', 'Olá', null, null) $i$, :'cv_ok', :'ws_um', :'ana', :'k1'),
  'P0001', 'send_disabled', 'send_enabled=false bloqueia o texto'
);
select is((select count(*)::int from public.whatsapp_outbox), 0, 'o bloqueio não deixou outbox');
select is((select count(*)::int from public.messages where direction = 'outbound' and origin = 'crm'), 0, 'o bloqueio não deixou mensagem do CRM');

select whatsapp_enable_channel_send(:'ch_sim'::uuid, :'ws_um'::uuid, :'ana'::uuid) as ligado \gset
select is((:'ligado'::jsonb) -> 'send_enabled', 'true'::jsonb, 'owner liga o envio do canal simulado ativo');
select is(
  (select count(*)::int from public.audit_logs where action = 'whatsapp.channel.send_enabled' and resource_id = :'ch_sim'::uuid),
  1, 'ligar o envio é auditado'
);

-- ---------------------------------------------------------------------
-- 4) Papéis, workspace e acesso à conversa
-- ---------------------------------------------------------------------

select throws_ok(
  format($i$ select whatsapp_reserve_send(%L::uuid, %L::uuid, %L::uuid, %L::uuid, 'text', 'Olá', null, null) $i$, :'cv_ok', :'ws_um', :'leitor', :'k1'),
  'P0001', 'insufficient_permission', 'viewer não envia'
);
select throws_ok(
  format($i$ select whatsapp_reserve_send(%L::uuid, %L::uuid, %L::uuid, %L::uuid, 'text', 'Olá', null, null) $i$, :'cv_ok', :'ws_um', :'bruno', :'k1'),
  'P0001', 'insufficient_permission', 'usuário de outro workspace não envia'
);
select throws_ok(
  format($i$ select whatsapp_reserve_send(%L::uuid, %L::uuid, %L::uuid, %L::uuid, 'text', 'Olá', null, null) $i$, :'cv_ok', :'ws_dois', :'bruno', :'k1'),
  'P0001', 'conversation_not_found', 'conversa de outro workspace é recusada, mesmo pelo dono do outro'
);
select throws_ok(
  format($i$ select whatsapp_reserve_send(%L::uuid, %L::uuid, %L::uuid, %L::uuid, 'text', 'Olá', null, null) $i$, :'cv_nolead', :'ws_um', :'carla', :'k1'),
  'P0001', 'conversation_not_found', 'advogado não alcança conversa sem caso vinculado'
);
select throws_ok(
  format($i$ select whatsapp_reserve_send(%L::uuid, %L::uuid, null, %L::uuid, 'text', 'Olá', null, null) $i$, :'cv_ok', :'ws_um', :'k1'),
  'P0001', 'actor_required', 'sem ator: recusado'
);
select throws_ok(
  format($i$ select whatsapp_reserve_send(%L::uuid, %L::uuid, %L::uuid, %L::uuid, 'text', 'Olá', null, null) $i$, '62000000-0000-0000-0000-0000000000ff', :'ws_um', :'ana', :'k1'),
  'P0001', 'conversation_not_found', 'conversa inexistente: recusada'
);
select throws_ok(
  format($i$ select whatsapp_send_context(%L::uuid, %L::uuid, %L::uuid) $i$, :'cv_ok', :'ws_um', :'leitor'),
  'P0001', 'insufficient_permission', 'viewer nem vê o contexto de envio'
);

-- ---------------------------------------------------------------------
-- 5) Vínculo e consentimento de atendimento
-- ---------------------------------------------------------------------

select throws_ok(
  format($i$ select whatsapp_reserve_send(%L::uuid, %L::uuid, %L::uuid, %L::uuid, 'text', 'Olá', null, null) $i$, :'cv_nolink', :'ws_um', :'ana', :'k1'),
  'P0001', 'conversation_not_linked', 'conversa sem contato vinculado: recusada'
);
select throws_ok(
  format($i$ select whatsapp_reserve_send(%L::uuid, %L::uuid, %L::uuid, %L::uuid, 'text', 'Olá', null, null) $i$, :'cv_nocons', :'ws_um', :'ana', :'k1'),
  'P0001', 'consent_required', 'sem consentimento de atendimento: recusada'
);
select is(
  (whatsapp_send_context(:'cv_nocons'::uuid, :'ws_um'::uuid, :'ana'::uuid)) ->> 'blocked_reason',
  'consent_required', 'contexto: consentimento ausente aparece como motivo'
);
select is(
  (whatsapp_send_context(:'cv_ok'::uuid, :'ws_um'::uuid, :'ana'::uuid)) ->> 'route', 'b3', 'contexto de canal da B3 usa a outbox'
);

-- ---------------------------------------------------------------------
-- 6) Texto livre: só dentro da janela
-- ---------------------------------------------------------------------

select throws_ok(
  format($i$ select whatsapp_reserve_send(%L::uuid, %L::uuid, %L::uuid, %L::uuid, 'text', 'Olá', null, null) $i$, :'cv_old', :'ws_um', :'ana', :'k1'),
  'P0001', 'window_closed', 'texto livre fora da janela de 24 h: bloqueado'
);
select is(
  (whatsapp_send_context(:'cv_old'::uuid, :'ws_um'::uuid, :'ana'::uuid)) -> 'window_open', 'false'::jsonb,
  'contexto: janela fechada'
);
select is(
  (whatsapp_send_context(:'cv_ok'::uuid, :'ws_um'::uuid, :'ana'::uuid)) -> 'window_open', 'true'::jsonb,
  'contexto: janela aberta'
);
select throws_ok(
  format($i$ select whatsapp_reserve_send(%L::uuid, %L::uuid, %L::uuid, %L::uuid, 'text', '   ', null, null) $i$, :'cv_ok', :'ws_um', :'ana', :'k1'),
  'P0001', 'invalid_message_body', 'texto em branco: recusado'
);
select throws_ok(
  format($i$ select whatsapp_reserve_send(%L::uuid, %L::uuid, %L::uuid, %L::uuid, 'audio', 'x', null, null) $i$, :'cv_ok', :'ws_um', :'ana', :'k1'),
  'P0001', 'invalid_message_kind', 'só texto e template: outro tipo é recusado'
);

select whatsapp_reserve_send(:'cv_ok'::uuid, :'ws_um'::uuid, :'ana'::uuid, :'k1'::uuid, 'text', '  Olá, tudo bem?  ', null, null) as r1 \gset

select is((:'r1'::jsonb) ->> 'state', 'reserved', 'texto dentro da janela: reservado');
select is((:'r1'::jsonb) ->> 'body_text', 'Olá, tudo bem?', 'texto gravado sem espaços nas pontas');
select is((:'r1'::jsonb) ->> 'status', 'queued', 'a mensagem nasce na fila');
select is((:'r1'::jsonb) -> 'duplicate_submit', 'false'::jsonb, 'primeira vez: não é repetição');
select ok(
  (select m.origin = 'crm' and m.sender_classification = 'internal' and m.direction = 'outbound'
          and m.sent_by = :'ana'::uuid and m.client_dedupe_key = :'k1'::uuid and m.content_kind = 'text'
          and m.provider = 'simulated' and m.origin_correlation_kind = 'crm_outbox'
          and m.origin_correlation_ref = (:'r1'::jsonb) ->> 'outbox_id'
   from public.messages m where m.id = ((:'r1'::jsonb) ->> 'message_id')::uuid),
  'a mensagem do CRM tem origin=crm, sender_classification=internal, autor e correlação com a outbox'
);
select ok(
  (select o.attempts = 0 and o.state = 'reserved' and o.kind = 'text' and o.created_by = :'ana'::uuid
   from public.whatsapp_outbox o where o.id = ((:'r1'::jsonb) ->> 'outbox_id')::uuid),
  'a outbox nasce reservada, sem nenhuma tentativa'
);
select is(
  (select count(*)::int from public.audit_logs where action = 'whatsapp.message.queued' and resource_id = ((:'r1'::jsonb) ->> 'message_id')::uuid
     and metadata = jsonb_build_object('conversation_id', :'cv_ok'::uuid, 'environment', 'preview', 'provider', 'simulated', 'kind', 'text')),
  1, 'a auditoria da reserva não leva texto, telefone nem parâmetros'
);

-- ---------------------------------------------------------------------
-- 7) Idempotência por intenção
-- ---------------------------------------------------------------------

select whatsapp_reserve_send(:'cv_ok'::uuid, :'ws_um'::uuid, :'ana'::uuid, :'k1'::uuid, 'text', 'Olá, tudo bem?', null, null) as r1b \gset
select is((:'r1b'::jsonb) ->> 'message_id', (:'r1'::jsonb) ->> 'message_id', 'a mesma intenção devolve a mesma mensagem');
select is((:'r1b'::jsonb) -> 'duplicate_submit', 'true'::jsonb, 'e é marcada como repetição');
select is((:'r1b'::jsonb) -> 'content_conflict', 'false'::jsonb, 'sem conflito quando o texto é o mesmo');
select whatsapp_reserve_send(:'cv_ok'::uuid, :'ws_um'::uuid, :'ana'::uuid, :'k1'::uuid, 'text', 'Outro texto', null, null) as r1c \gset
select is((:'r1c'::jsonb) -> 'content_conflict', 'true'::jsonb, 'a mesma chave com outro texto é conflito');
select is((:'r1c'::jsonb) ->> 'body_text', 'Olá, tudo bem?', 'e devolve o que foi REALMENTE gravado');
select is(
  (select count(*)::int from public.messages where conversation_id = :'cv_ok'::uuid and client_dedupe_key = :'k1'::uuid),
  1, 'repetir a intenção não duplica a mensagem'
);
select is((select count(*)::int from public.whatsapp_outbox where conversation_id = :'cv_ok'::uuid), 1, 'nem a outbox');

-- ---------------------------------------------------------------------
-- 8) Fase 2: begin e finish, no máximo uma tentativa
-- ---------------------------------------------------------------------

select whatsapp_outbox_begin(((:'r1'::jsonb) ->> 'outbox_id')::uuid, 60) as b1 \gset
select is((:'b1'::jsonb) ->> 'outcome', 'begin', 'begin: a tentativa começa');
select ok(
  (:'b1'::jsonb) ->> 'text' = 'Olá, tudo bem?' and (:'b1'::jsonb) ->> 'recipient_phone' = '+5511900005001'
    and (:'b1'::jsonb) ->> 'routing_key' = 'b33-sim' and (:'b1'::jsonb) ->> 'provider' = 'simulated',
  'begin devolve o que o provedor precisa, para o servidor'
);
-- 20261109120000: o begin devolve o canal da intenção, para o envio pedir SÓ a api_key dele.
select is(
  (:'b1'::jsonb) ->> 'channel_id',
  (select o.channel_id::text from public.whatsapp_outbox o where o.id = ((:'r1'::jsonb) ->> 'outbox_id')::uuid),
  'begin devolve o channel_id lido da própria outbox'
);
select is((:'b1'::jsonb) ->> 'channel_id', :'ch_sim', 'e é o canal da conversa da intenção');
select is(
  (select pg_get_function_identity_arguments(p.oid) from pg_proc p where p.oid = 'public.whatsapp_outbox_begin(uuid, integer)'::regprocedure),
  'p_outbox_id uuid, p_lease_seconds integer',
  'o chamador não tem como informar canal: só a intenção e a lease'
);
select is(
  (select count(*)::int from jsonb_object_keys(:'b1'::jsonb) k where k ~* '(credential|secret|token|cipher|api_?key|password|webhook)'),
  0,
  'o retorno do begin não tem nenhuma chave de credencial ou segredo'
);
select is(
  (select count(*)::int from public.whatsapp_channel_credentials c where position(c.ciphertext in (:'b1'::jsonb)::text) > 0),
  0,
  'o retorno do begin não contém texto cifrado de nenhuma credencial'
);
select is((select attempts from public.whatsapp_outbox where id = ((:'r1'::jsonb) ->> 'outbox_id')::uuid), 1, 'uma tentativa registrada');
select whatsapp_outbox_begin(((:'r1'::jsonb) ->> 'outbox_id')::uuid, 60) as b1b \gset
select is((:'b1b'::jsonb) ->> 'outcome', 'in_progress', 'segundo begin dentro da lease: em andamento, sem nova tentativa');

select whatsapp_outbox_finish(((:'r1'::jsonb) ->> 'outbox_id')::uuid, 'accepted', 'wamid.sim.aceita0001', null) as f1 \gset
select is((:'f1'::jsonb) ->> 'state', 'accepted', 'finish: aceita');
select is((:'f1'::jsonb) ->> 'status', 'accepted', 'a mensagem passa a accepted');
select is((select provider_message_id from public.messages where id = ((:'r1'::jsonb) ->> 'message_id')::uuid), 'wamid.sim.aceita0001', 'o id do provedor fica na mensagem, para os status seguintes');
select is((whatsapp_outbox_finish(((:'r1'::jsonb) ->> 'outbox_id')::uuid, 'accepted', 'wamid.sim.aceita0001', null)) ->> 'state', 'accepted', 'repetir o mesmo desfecho é idempotente');
select throws_ok(
  format($i$ select whatsapp_outbox_finish(%L::uuid, 'rejected', null, 'x') $i$, (:'r1'::jsonb) ->> 'outbox_id'),
  'P0001', 'invalid_outbox_state', 'depois de terminal, outro desfecho é recusado'
);
select is((whatsapp_outbox_begin(((:'r1'::jsonb) ->> 'outbox_id')::uuid, 60)) ->> 'outcome', 'done', 'begin depois de aceita: nada a fazer');
select is((select attempts from public.whatsapp_outbox where id = ((:'r1'::jsonb) ->> 'outbox_id')::uuid), 1, 'e a tentativa continua sendo uma só');

-- Resultado incerto: nunca reenviado.
select whatsapp_reserve_send(:'cv_ok'::uuid, :'ws_um'::uuid, :'ana'::uuid, :'k2'::uuid, 'text', 'Segunda', null, null) as r2 \gset
select whatsapp_outbox_begin(((:'r2'::jsonb) ->> 'outbox_id')::uuid, 60) as b2 \gset
select whatsapp_outbox_finish(((:'r2'::jsonb) ->> 'outbox_id')::uuid, 'uncertain', null, null) as f2 \gset
select is((:'f2'::jsonb) ->> 'state', 'uncertain', 'finish: incerta');
select ok(
  (select m.status = 'queued' and m.error_reason = 'send_uncertain' and m.provider_message_id is null
   from public.messages m where m.id = ((:'r2'::jsonb) ->> 'message_id')::uuid),
  'a mensagem incerta fica na fila, marcada, sem id do provedor'
);
select is((whatsapp_outbox_begin(((:'r2'::jsonb) ->> 'outbox_id')::uuid, 60)) ->> 'outcome', 'done', 'incerta: begin não volta a tentar');
select is((whatsapp_reserve_send(:'cv_ok'::uuid, :'ws_um'::uuid, :'ana'::uuid, :'k2'::uuid, 'text', 'Segunda', null, null)) ->> 'state', 'uncertain', 'a mesma intenção devolve a incerta');
select is((select attempts from public.whatsapp_outbox where id = ((:'r2'::jsonb) ->> 'outbox_id')::uuid), 1, 'incerta: nenhuma tentativa a mais');

-- Processo que some depois do begin: a lease vence e vira incerta, sem reenvio.
select whatsapp_reserve_send(:'cv_ok'::uuid, :'ws_um'::uuid, :'ana'::uuid, :'k3'::uuid, 'text', 'Terceira', null, null) as r3 \gset
select whatsapp_outbox_begin(((:'r3'::jsonb) ->> 'outbox_id')::uuid, 60) as b3 \gset
reset role;
update public.whatsapp_outbox set lease_until = now() - interval '1 second' where id = ((:'r3'::jsonb) ->> 'outbox_id')::uuid;
set local role service_role;
select set_config('request.headers', :'h_prev', true);
select is((whatsapp_outbox_begin(((:'r3'::jsonb) ->> 'outbox_id')::uuid, 60)) ->> 'state', 'uncertain', 'lease vencida: vira incerta');
select is((select attempts from public.whatsapp_outbox where id = ((:'r3'::jsonb) ->> 'outbox_id')::uuid), 1, 'e não houve nova tentativa');

-- Rejeição do provedor.
select whatsapp_reserve_send(:'cv_ok'::uuid, :'ws_um'::uuid, :'ana'::uuid, :'k4'::uuid, 'text', 'Quarta', null, null) as r4 \gset
select whatsapp_outbox_begin(((:'r4'::jsonb) ->> 'outbox_id')::uuid, 60) as b4 \gset
select whatsapp_outbox_finish(((:'r4'::jsonb) ->> 'outbox_id')::uuid, 'rejected', null, 'Código Estranho!') as f4 \gset
select is((:'f4'::jsonb) ->> 'error_code', 'send_rejected', 'código fora do formato vira send_rejected');
select ok(
  (select m.status = 'failed' and m.error_reason = 'send_rejected' from public.messages m where m.id = ((:'r4'::jsonb) ->> 'message_id')::uuid),
  'a mensagem rejeitada fica como falha, só com o código'
);

-- Envio desligado entre a reserva e a chamada.
select whatsapp_reserve_send(:'cv_ok'::uuid, :'ws_um'::uuid, :'ana'::uuid, :'k5'::uuid, 'text', 'Quinta', null, null) as r5 \gset
select whatsapp_disable_channel_send(:'ch_sim'::uuid, :'ws_um'::uuid, :'ana'::uuid) is not null as ok \gset
select is((whatsapp_outbox_begin(((:'r5'::jsonb) ->> 'outbox_id')::uuid, 60)) ->> 'state', 'rejected', 'envio desligado depois da reserva: a tentativa nem começa');
select is((select attempts from public.whatsapp_outbox where id = ((:'r5'::jsonb) ->> 'outbox_id')::uuid), 0, 'nenhuma chamada ao provedor');
select is((select error_reason from public.messages where id = ((:'r5'::jsonb) ->> 'message_id')::uuid), 'send_disabled', 'a mensagem mostra o motivo');
select whatsapp_enable_channel_send(:'ch_sim'::uuid, :'ws_um'::uuid, :'ana'::uuid) is not null as ok \gset

-- Restrições da outbox: uma tentativa, no máximo.
reset role;
select throws_ok(
  format($i$ update public.whatsapp_outbox set attempts = 2 where id = %L::uuid $i$, (:'r1'::jsonb) ->> 'outbox_id'),
  '23514', null, 'a outbox não aceita uma segunda tentativa'
);
select throws_ok(
  format($i$ update public.whatsapp_outbox set state = 'reserved' where id = %L::uuid $i$, (:'r1'::jsonb) ->> 'outbox_id'),
  '23514', null, 'reservada exige zero tentativas'
);
set local role service_role;
select set_config('request.headers', :'h_prev', true);

-- ---------------------------------------------------------------------
-- 9) Templates: fora da janela, só aprovado, utility e com caso vinculado
-- ---------------------------------------------------------------------

select throws_ok(
  format($i$ select whatsapp_upsert_template(%L::uuid, %L::uuid, %L::uuid, 'prazo_audiencia', 'pt_BR', 'utility', 'approved', 'Lembrete: sua audiência é em {{1}}.', 1) $i$, :'ch_sim', :'ws_um', :'daniel'),
  'P0001', 'insufficient_permission', 'manager não cadastra template'
);
select throws_ok(
  format($i$ select whatsapp_upsert_template(%L::uuid, %L::uuid, %L::uuid, 'ruim', 'pt_BR', 'utility', 'approved', 'Olá {{1}} e {{3}}', 2) $i$, :'ch_sim', :'ws_um', :'ana'),
  'P0001', 'invalid_template', 'marcadores que não batem com a contagem: recusado'
);
select whatsapp_upsert_template(:'ch_sim'::uuid, :'ws_um'::uuid, :'ana'::uuid, 'lembrete_audiencia', 'pt_BR', 'utility', 'approved', 'Olá {{1}}, sua audiência é em {{2}}.', 2) as t_ok \gset
select whatsapp_upsert_template(:'ch_sim'::uuid, :'ws_um'::uuid, :'ana'::uuid, 'promocao', 'pt_BR', 'marketing', 'approved', 'Oferta para {{1}}!', 1) as t_mkt \gset
select whatsapp_upsert_template(:'ch_sim'::uuid, :'ws_um'::uuid, :'ana'::uuid, 'pendente', 'pt_BR', 'utility', 'pending', 'Aviso {{1}}', 1) as t_pend \gset

select is(
  (select jsonb_agg(t ->> 'name') from jsonb_array_elements((whatsapp_send_context(:'cv_old'::uuid, :'ws_um'::uuid, :'ana'::uuid)) -> 'templates') t),
  '["lembrete_audiencia"]'::jsonb,
  'o contexto lista só template aprovado e utility'
);
select ok(
  position('Olá {{1}}' in (:'t_ok'::jsonb)::text) = 0 and (:'t_ok'::jsonb) ->> 'category' = 'utility',
  'a resposta do cadastro não traz o texto do template'
);

select throws_ok(
  format($i$ select whatsapp_reserve_send(%L::uuid, %L::uuid, %L::uuid, %L::uuid, 'template', null, %L::uuid, array['Maria','12/12']) $i$, :'cv_old', :'ws_um', :'ana', :'k6', (:'t_mkt'::jsonb) ->> 'id'),
  'P0001', 'template_category_not_allowed', 'marketing é bloqueado'
);
select throws_ok(
  format($i$ select whatsapp_reserve_send(%L::uuid, %L::uuid, %L::uuid, %L::uuid, 'template', null, %L::uuid, array['Maria']) $i$, :'cv_old', :'ws_um', :'ana', :'k6', (:'t_pend'::jsonb) ->> 'id'),
  'P0001', 'template_not_approved', 'template não aprovado: bloqueado'
);
select throws_ok(
  format($i$ select whatsapp_reserve_send(%L::uuid, %L::uuid, %L::uuid, %L::uuid, 'template', null, '65000000-0000-0000-0000-0000000000ff'::uuid, array['Maria']) $i$, :'cv_old', :'ws_um', :'ana', :'k6'),
  'P0001', 'template_not_found', 'template inexistente: recusado'
);
select throws_ok(
  format($i$ select whatsapp_reserve_send(%L::uuid, %L::uuid, %L::uuid, %L::uuid, 'template', null, %L::uuid, array['Maria']) $i$, :'cv_old', :'ws_um', :'ana', :'k6', (:'t_ok'::jsonb) ->> 'id'),
  'P0001', 'invalid_template_params', 'quantidade de parâmetros diferente: recusada'
);
select throws_ok(
  format($i$ select whatsapp_reserve_send(%L::uuid, %L::uuid, %L::uuid, %L::uuid, 'template', null, %L::uuid, array['Maria', '{{1}}']) $i$, :'cv_old', :'ws_um', :'ana', :'k6', (:'t_ok'::jsonb) ->> 'id'),
  'P0001', 'invalid_template_params', 'parâmetro com marcador: recusado'
);
select throws_ok(
  format($i$ select whatsapp_reserve_send(%L::uuid, %L::uuid, %L::uuid, %L::uuid, 'template', null, %L::uuid, array['Maria', E'12\n/12']) $i$, :'cv_old', :'ws_um', :'ana', :'k6', (:'t_ok'::jsonb) ->> 'id'),
  'P0001', 'invalid_template_params', 'parâmetro com quebra de linha: recusado'
);
select throws_ok(
  format($i$ select whatsapp_reserve_send(%L::uuid, %L::uuid, %L::uuid, %L::uuid, 'template', null, %L::uuid, array['Maria', '12/12']) $i$, :'cv_nolead', :'ws_um', :'ana', :'k6', (:'t_ok'::jsonb) ->> 'id'),
  'P0001', 'template_requires_case', 'utility sem caso vinculado: bloqueado'
);

select whatsapp_reserve_send(:'cv_old'::uuid, :'ws_um'::uuid, :'ana'::uuid, :'k7'::uuid, 'template', null, ((:'t_ok'::jsonb) ->> 'id')::uuid, array['  Maria ', '12/12']) as r7 \gset
select is((:'r7'::jsonb) ->> 'state', 'reserved', 'template utility aprovado fora da janela: permitido');
select is((:'r7'::jsonb) ->> 'body_text', 'Olá Maria, sua audiência é em 12/12.', 'o texto do template é montado e mostrado no CRM');
select ok(
  (select m.content_kind = 'template' and m.origin = 'crm' and m.sender_classification = 'internal'
   from public.messages m where m.id = ((:'r7'::jsonb) ->> 'message_id')::uuid),
  'mensagem de template também nasce com origin=crm e internal'
);
select whatsapp_outbox_begin(((:'r7'::jsonb) ->> 'outbox_id')::uuid, 60) as b7 \gset
select ok(
  (:'b7'::jsonb) ->> 'template_name' = 'lembrete_audiencia' and (:'b7'::jsonb) ->> 'template_language' = 'pt_BR'
    and (:'b7'::jsonb) -> 'template_params' = '["Maria","12/12"]'::jsonb and (:'b7'::jsonb) -> 'text' = 'null'::jsonb,
  'begin do template devolve nome, idioma e parâmetros, sem texto livre'
);
select is((whatsapp_reserve_send(:'cv_old'::uuid, :'ws_um'::uuid, :'ana'::uuid, :'k7'::uuid, 'template', null, ((:'t_ok'::jsonb) ->> 'id')::uuid, array['Maria', '12/12'])) -> 'content_conflict', 'false'::jsonb, 'template repetido igual: sem conflito');
select is((whatsapp_reserve_send(:'cv_old'::uuid, :'ws_um'::uuid, :'ana'::uuid, :'k7'::uuid, 'template', null, ((:'t_ok'::jsonb) ->> 'id')::uuid, array['Maria', '13/12'])) -> 'content_conflict', 'true'::jsonb, 'template repetido com outro parâmetro: conflito');

-- ---------------------------------------------------------------------
-- 10) send_message da A7 recusa canal da B3 (não grava saída falsa)
-- ---------------------------------------------------------------------

reset role;
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'ana', 'role', 'authenticated')::text, true);
select throws_ok(
  format($i$ select public.send_message(%L::uuid, 'Olá pela A7', %L::uuid) $i$, :'cv_ok', :'k8'),
  'P0001', 'channel_uses_whatsapp_outbox', 'send_message da A7 não grava saída em conversa de canal da B3'
);
reset role;
select is(
  (select count(*)::int from public.messages where conversation_id = :'cv_ok'::uuid and client_dedupe_key = :'k8'::uuid),
  0, 'e nada foi gravado'
);

select * from finish();
rollback;
