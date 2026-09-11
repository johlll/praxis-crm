-- pgTAP — A7: conversas + simulador de WhatsApp. Fixtures próprias desta
-- transação (não depende do seed) — exercita as funções RPC de verdade.
--
-- Concorrência de verdade (duas chamadas simultâneas) NÃO é testada aqui:
-- pgTAP roda numa única conexão/transação por arquivo, então não existe
-- corrida real para observar. Isso é coberto à parte, contra o Supabase
-- local de verdade (duas requisições HTTP concorrentes via
-- @supabase/supabase-js), em scripts/a7-concurrency-check.mjs — rodado como
-- passo próprio do CI, logo depois deste arquivo.

begin;
select plan(55);

-- ---------------------------------------------------------------------
-- Fixtures: dois workspaces (isolamento), pipeline+etapa em cada (a criação
-- automática de oportunidade em simulate_inbound_whatsapp_message() precisa
-- de um pipeline padrão — workspaces de teste não passam por
-- create_workspace_with_owner(), então isto é replicado à mão, mesmo padrão
-- já usado em supabase/seed.sql).
-- ---------------------------------------------------------------------

insert into public.workspaces (id, name, slug, created_by)
values
  ('a7000000-0000-0000-0000-000000000001', 'A7 Teste WS Um', 'a7-teste-ws-um', (select id from auth.users limit 1)),
  ('a7000000-0000-0000-0000-000000000002', 'A7 Teste WS Dois', 'a7-teste-ws-dois', (select id from auth.users limit 1));

\set ws_um   'a7000000-0000-0000-0000-000000000001'
\set ws_dois 'a7000000-0000-0000-0000-000000000002'

-- Usuários do seed já existente (mesma convenção da A3/A6): ana (owner),
-- bruno (owner, workspace separado), carla (lawyer no ws_um), daniel
-- (sem membership em lugar nenhum), elisa (viewer no ws_um).
\set ana    '20000000-0000-0000-0000-000000000001'
\set bruno  '20000000-0000-0000-0000-000000000002'
\set carla  '20000000-0000-0000-0000-000000000003'
\set daniel '20000000-0000-0000-0000-000000000004'
\set elisa  '20000000-0000-0000-0000-000000000005'

insert into public.memberships (workspace_id, user_id, role, status)
values
  (:'ws_um'::uuid, :'ana'::uuid, 'owner', 'active'),
  (:'ws_dois'::uuid, :'bruno'::uuid, 'owner', 'active'),
  (:'ws_um'::uuid, :'carla'::uuid, 'lawyer', 'active'),
  (:'ws_um'::uuid, :'elisa'::uuid, 'viewer', 'active')
on conflict (workspace_id, user_id) do update set role = excluded.role, status = 'active';

insert into public.pipelines (id, workspace_id, name, is_default, created_by)
values
  ('a7050000-0000-0000-0000-000000000001', :'ws_um'::uuid, 'Comercial', true, :'ana'::uuid),
  ('a7050000-0000-0000-0000-000000000002', :'ws_dois'::uuid, 'Comercial', true, :'bruno'::uuid);

insert into public.pipeline_stages (workspace_id, pipeline_id, name, position)
values
  (:'ws_um'::uuid, 'a7050000-0000-0000-0000-000000000001'::uuid, 'Fazer primeiro contato', 0),
  (:'ws_dois'::uuid, 'a7050000-0000-0000-0000-000000000002'::uuid, 'Fazer primeiro contato', 0);

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'ana', 'role', 'authenticated')::text, true);

-- ---------------------------------------------------------------------
-- 1) Canal — criação e isolamento.
-- ---------------------------------------------------------------------

select (create_whatsapp_channel(:'ws_um'::uuid, 'Canal Um', 'a7-phone-um', '+55 11 0000-0001')).id as channel_um \gset

select throws_ok(
  format($i$ select create_whatsapp_channel(%L::uuid, 'Duplicado', 'a7-phone-um', '+55 11 0000-0009') $i$, :'ws_um'),
  'P0001', 'channel_phone_number_id_taken',
  'phone_number_id é globalmente único — não dá para criar dois canais com o mesmo'
);

reset role;
select set_config('request.jwt.claims', json_build_object('sub', :'bruno', 'role', 'authenticated')::text, true);
set local role authenticated;

select (create_whatsapp_channel(:'ws_dois'::uuid, 'Canal Dois', 'a7-phone-dois', '+55 11 0000-0002')).id as channel_dois \gset

select is(
  (select count(*)::int from public.whatsapp_channels where workspace_id = :'ws_dois'::uuid),
  1,
  'Workspace Dois enxerga só o próprio canal (SELECT direto, RLS)'
);
select is(
  (select count(*)::int from public.whatsapp_channels where workspace_id = :'ws_um'::uuid),
  0,
  'Workspace Dois NÃO enxerga o canal do Um (isolamento via RLS)'
);

reset role;
select set_config('request.jwt.claims', json_build_object('sub', :'ana', 'role', 'authenticated')::text, true);
set local role authenticated;

-- ---------------------------------------------------------------------
-- 2) Acesso negado via chamada direta (deny-all) às tabelas de conversa.
-- ---------------------------------------------------------------------

select throws_ok(
  $i$ select count(*) from public.conversations $i$, '42501', null,
  'conversations: SELECT direto negado — sem GRANT nenhum'
);
select throws_ok(
  $i$ select count(*) from public.messages $i$, '42501', null,
  'messages: SELECT direto negado — sem GRANT nenhum'
);
select throws_ok(
  $i$ select count(*) from public.message_status_events $i$, '42501', null,
  'message_status_events: SELECT direto negado — sem GRANT nenhum'
);

-- ---------------------------------------------------------------------
-- 3) O simulador exige owner/admin — lawyer/sales/viewer são negados,
--    mesmo tendo acesso normal de leitura/envio de mensagem.
-- ---------------------------------------------------------------------

reset role;
select set_config('request.jwt.claims', json_build_object('sub', :'carla', 'role', 'authenticated')::text, true);
set local role authenticated;

select throws_ok(
  format(
    $i$ select simulate_inbound_whatsapp_message('a7-phone-um', '5511900000001', '+5511900000001', 'wamid.a7.carla', now(), 'oi', null) $i$
  ),
  'P0001', 'insufficient_permission',
  'lawyer não pode acionar o simulador (simulate_inbound_whatsapp_message)'
);
select throws_ok(
  $i$ select apply_message_status_event('a7-phone-um', 'wamid.qualquer', 'delivered', now()) $i$,
  'P0001', 'insufficient_permission',
  'lawyer não pode acionar o simulador (apply_message_status_event)'
);

reset role;
select set_config('request.jwt.claims', json_build_object('sub', :'ana', 'role', 'authenticated')::text, true);
set local role authenticated;

-- ---------------------------------------------------------------------
-- 4) Primeiro contato — número desconhecido cria contato+lead+oportunidade
--    +atividade, e o evento repetido não duplica nada disso.
-- ---------------------------------------------------------------------

select simulate_inbound_whatsapp_message(
  'a7-phone-um', '5511911112222', '+5511911112222', 'wamid.a7.novo.001',
  now(), 'Olá, preciso de um advogado', 'Novo Contato A7'
) as novo_r1 \gset

select ok((:'novo_r1'::jsonb ->> 'was_new_contact')::boolean, 'Número desconhecido: was_new_contact=true');
select ok(not (:'novo_r1'::jsonb ->> 'needs_link_review')::boolean, 'Número desconhecido: já sai totalmente resolvido (needs_link_review=false)');

select is(
  (select count(*)::int from public.contacts where id = (:'novo_r1'::jsonb ->> 'contact_id')::uuid),
  1,
  'Contato foi criado de verdade'
);
select is(
  (select count(*)::int from public.leads where contact_id = (:'novo_r1'::jsonb ->> 'contact_id')::uuid),
  1,
  'Exatamente 1 lead criado para o contato novo'
);
select is(
  (select count(*)::int from public.opportunities where lead_id = (:'novo_r1'::jsonb ->> 'lead_id')::uuid),
  1,
  'Exatamente 1 oportunidade criada'
);
select is(
  (select count(*)::int from public.activities where source_conversation_message_id = (:'novo_r1'::jsonb ->> 'message_id')::uuid),
  1,
  'Exatamente 1 atividade automática criada, rastreável até a mensagem'
);
select is(
  (select source from public.activities where source_conversation_message_id = (:'novo_r1'::jsonb ->> 'message_id')::uuid),
  'whatsapp_inbound',
  'Atividade automática tem source=whatsapp_inbound'
);

-- Evento repetido (mesmo wa_message_id): idempotente, nada novo.
select simulate_inbound_whatsapp_message(
  'a7-phone-um', '5511911112222', '+5511911112222', 'wamid.a7.novo.001',
  now(), 'Olá, preciso de um advogado', 'Novo Contato A7'
) as novo_r1_repeat \gset

select ok((:'novo_r1_repeat'::jsonb ->> 'duplicate_event')::boolean, 'Reenvio do mesmo evento: duplicate_event=true');
select is(
  (select count(*)::int from public.contacts where id = (:'novo_r1'::jsonb ->> 'contact_id')::uuid),
  1,
  'Reenvio do mesmo evento não duplicou o contato'
);
select is(
  (select count(*)::int from public.messages where conversation_id = (:'novo_r1'::jsonb ->> 'conversation_id')::uuid),
  1,
  'Reenvio do mesmo evento não duplicou a mensagem'
);

-- Nova transição/mensagem DEPOIS do reenvio: continua funcionando (mesmo
-- espírito do "nova transição após desativar regra" pedido na A6 — aqui,
-- "reenviar não quebra o que vem depois").
select simulate_inbound_whatsapp_message(
  'a7-phone-um', '5511911112222', '+5511911112222', 'wamid.a7.novo.002',
  now(), 'Ainda estou aguardando retorno', 'Novo Contato A7'
) as novo_r2 \gset

select is(
  (:'novo_r2'::jsonb ->> 'conversation_id'), (:'novo_r1'::jsonb ->> 'conversation_id'),
  'Mensagem seguinte do mesmo número cai na MESMA conversa'
);
select ok(not (:'novo_r2'::jsonb ->> 'was_new_contact')::boolean, 'Mensagem seguinte não cria outro contato');
select is(
  (select count(*)::int from public.leads where contact_id = (:'novo_r1'::jsonb ->> 'contact_id')::uuid),
  1,
  'Mensagem seguinte não cria outro lead (reaproveita)'
);

-- ---------------------------------------------------------------------
-- 5) Contato conhecido — telefone já cadastrado reaproveita; vínculo
--    ambíguo (2 contatos com o mesmo telefone) não escolhe a esmo.
-- ---------------------------------------------------------------------

select id as contato_conhecido_id from create_contact(
  :'ws_um'::uuid, 'pf', 'Contato Conhecido A7', null, null, 'whatsapp',
  jsonb_build_array(jsonb_build_object('value_normalized', '+5511933334444', 'is_primary', true))
) \gset

select simulate_inbound_whatsapp_message(
  'a7-phone-um', '5511933334444', '+5511933334444', 'wamid.a7.conhecido.001',
  now(), 'Aqui é o Contato Conhecido', 'Contato Conhecido A7'
) as conhecido_r1 \gset

select is(
  (:'conhecido_r1'::jsonb ->> 'contact_id'), :'contato_conhecido_id',
  'Contato conhecido pelo telefone é reaproveitado (não cria um novo)'
);
select ok((:'conhecido_r1'::jsonb ->> 'needs_link_review')::boolean, 'Contato conhecido sem lead ativo: fica pendente de vínculo (não cria lead sozinho)');
select is((:'conhecido_r1'::jsonb ->> 'lead_id'), null, 'Contato conhecido sem lead ativo: lead_id null');
select is(
  (select count(*)::int from public.contact_identifiers where contact_id = :'contato_conhecido_id'::uuid and provider = 'whatsapp'),
  1,
  'contact_identifiers foi gravado — próxima mensagem já acha por identidade forte'
);

-- Dois contatos diferentes com o MESMO telefone: ambíguo, não escolhe.
select id as ambiguo_a_id from create_contact(:'ws_um'::uuid, 'pf', 'Ambíguo A', null, null, 'whatsapp',
  jsonb_build_array(jsonb_build_object('value_normalized', '+5511955556666', 'is_primary', true))) \gset
select id as ambiguo_b_id from create_contact(:'ws_um'::uuid, 'pf', 'Ambíguo B', null, null, 'whatsapp',
  jsonb_build_array(jsonb_build_object('value_normalized', '+5511955556666', 'is_primary', true))) \gset

select simulate_inbound_whatsapp_message(
  'a7-phone-um', '5511955556666', '+5511955556666', 'wamid.a7.ambiguo.001',
  now(), 'Quem sou eu?', null
) as ambiguo_r1 \gset

select is((:'ambiguo_r1'::jsonb ->> 'contact_id'), null, 'Telefone com 2 contatos: contact_id fica nulo — nunca escolhe a esmo');
select ok((:'ambiguo_r1'::jsonb ->> 'needs_link_review')::boolean, 'Telefone ambíguo: needs_link_review=true');
select is(
  (select count(*)::int from public.contacts where preferred_channel = 'whatsapp' and name like 'Ambíguo%'),
  2,
  'Nenhum terceiro contato foi criado para "resolver" a ambiguidade — continuam só os 2 originais'
);
select is(
  (select count(*)::int from public.messages where conversation_id = (:'ambiguo_r1'::jsonb ->> 'conversation_id')::uuid),
  1,
  'A mensagem foi preservada mesmo com o vínculo pendente — nunca descartada'
);

-- resolve_conversation_link() resolve a ambiguidade pela interface.
select resolve_conversation_link(
  (:'ambiguo_r1'::jsonb ->> 'conversation_id')::uuid, :'ambiguo_a_id'::uuid
) as resolvido \gset

select is((:'resolvido'::jsonb ->> 'contact_id'), :'ambiguo_a_id', 'resolve_conversation_link() vincula ao contato escolhido');
select is(
  (select needs_link_review::text from public.conversations where id = (:'ambiguo_r1'::jsonb ->> 'conversation_id')::uuid),
  'false',
  'Depois de resolvido, needs_link_review volta a false'
);

-- ---------------------------------------------------------------------
-- 6) Consentimento — bloqueia envio, registra, permite, revoga, bloqueia
--    de novo. Nunca inventado pela criação automática do contato.
-- ---------------------------------------------------------------------

select is(
  (select count(*)::int from public.contact_consents where contact_id = (:'novo_r1'::jsonb ->> 'contact_id')::uuid),
  0,
  'Criar contato a partir de mensagem recebida NUNCA registra consentimento sozinho'
);

select throws_ok(
  format($i$ select send_message(%L::uuid, 'Oi, tudo bem?', gen_random_uuid()) $i$, (:'novo_r1'::jsonb ->> 'conversation_id')),
  'P0001', 'consent_required',
  'Envio ativo sem consentimento vigente é bloqueado'
);

select register_contact_consent(
  (:'novo_r1'::jsonb ->> 'contact_id')::uuid, 'whatsapp', 'consentimento', 'Atendimento via WhatsApp (teste)'
) as consent_id \gset

select lives_ok(
  format($i$ select send_message(%L::uuid, 'Oi! Recebemos sua mensagem.', gen_random_uuid()) $i$, (:'novo_r1'::jsonb ->> 'conversation_id')),
  'Com consentimento vigente, o envio é permitido'
);

select revoke_contact_consent(:'consent_id'::uuid);

select throws_ok(
  format($i$ select send_message(%L::uuid, 'Outra mensagem', gen_random_uuid()) $i$, (:'novo_r1'::jsonb ->> 'conversation_id')),
  'P0001', 'consent_required',
  'Depois de revogado, o envio volta a ser bloqueado'
);

select throws_ok(
  format($i$ select revoke_contact_consent(%L::uuid) $i$, :'consent_id'),
  'P0001', 'consent_already_revoked',
  'Revogar um consentimento já revogado é rejeitado (não silenciosamente ignorado)'
);

-- ---------------------------------------------------------------------
-- 7) Reenvio de saída não duplica (client_dedupe_key).
-- ---------------------------------------------------------------------

select register_contact_consent(
  (:'conhecido_r1'::jsonb ->> 'contact_id')::uuid, 'whatsapp', 'consentimento', 'Atendimento via WhatsApp (teste 2)'
) as consent_id_2 \gset

\set dedupe_fixo '77777777-7777-7777-7777-777777777777'

select send_message((:'conhecido_r1'::jsonb ->> 'conversation_id')::uuid, 'Primeira tentativa', :'dedupe_fixo'::uuid) as env1 \gset
select send_message((:'conhecido_r1'::jsonb ->> 'conversation_id')::uuid, 'Primeira tentativa', :'dedupe_fixo'::uuid) as env1_retry \gset

select is(
  (:'env1'::jsonb ->> 'message_id'), (:'env1_retry'::jsonb ->> 'message_id'),
  'Reenvio com a mesma client_dedupe_key devolve a MESMA mensagem'
);
select ok((:'env1_retry'::jsonb ->> 'duplicate_submit')::boolean, 'Reenvio sinaliza duplicate_submit=true');
select is(
  (select count(*)::int from public.messages where conversation_id = (:'conhecido_r1'::jsonb ->> 'conversation_id')::uuid and direction = 'outbound'),
  1,
  'Só 1 mensagem de saída gravada, apesar do reenvio'
);

-- ---------------------------------------------------------------------
-- 8) Estados de mensagem — nunca regride; evento tardio/fora de ordem.
-- ---------------------------------------------------------------------

select wa_message_id as wamid_env1 from public.messages where id = (:'env1'::jsonb ->> 'message_id')::uuid \gset

select apply_message_status_event('a7-phone-um', :'wamid_env1', 'delivered', now()) as ev_delivered \gset
select ok((:'ev_delivered'::jsonb ->> 'applied')::boolean, 'delivered aplicado normalmente (sent -> delivered)');

select apply_message_status_event('a7-phone-um', :'wamid_env1', 'delivered', now() + interval '1 second') as ev_delivered_dup \gset
select ok(not (:'ev_delivered_dup'::jsonb ->> 'applied')::boolean, 'delivered repetido (mesmo status) não é reaplicado');

select apply_message_status_event('a7-phone-um', :'wamid_env1', 'read', now() + interval '2 second') as ev_read \gset
select ok((:'ev_read'::jsonb ->> 'applied')::boolean, 'read aplicado (delivered -> read)');

select apply_message_status_event('a7-phone-um', :'wamid_env1', 'delivered', now() - interval '10 minute') as ev_delivered_tardio \gset
select ok(not (:'ev_delivered_tardio'::jsonb ->> 'applied')::boolean, 'delivered tardio (depois de read) NÃO é aplicado — nunca regride');
select is(
  (select status::text from public.messages where id = (:'env1'::jsonb ->> 'message_id')::uuid),
  'read',
  'Status final continua "read" apesar do evento tardio'
);
select is(
  (select count(*)::int from public.message_status_events where message_id = (:'env1'::jsonb ->> 'message_id')::uuid),
  3,
  'Os 4 eventos de status geraram 3 linhas de log (o delivered repetido colapsou pelo índice único), todos preservados'
);

select apply_message_status_event('a7-phone-um', :'wamid_env1', 'failed', now() + interval '3 second', 'ERR', 'falha simulada') as ev_failed_apos_read \gset
select ok(not (:'ev_failed_apos_read'::jsonb ->> 'applied')::boolean, '"failed" depois de "read" é ignorado — mensagem já entregue e lida não vira falha');

-- ---------------------------------------------------------------------
-- 9) Alcance por papel — lawyer só vê conversa do seu lead; conversa sem
--    lead vinculado (needs_link_review) só é visível a owner/admin/manager.
-- ---------------------------------------------------------------------

reset role;
select set_config('request.jwt.claims', json_build_object('sub', :'carla', 'role', 'authenticated')::text, true);
set local role authenticated;

select is(
  get_conversation((:'novo_r1'::jsonb ->> 'conversation_id')::uuid),
  null,
  'lawyer sem acesso ao lead da conversa: get_conversation() devolve null (não vaza existência)'
);

select assign_lead((:'novo_r1'::jsonb ->> 'lead_id')::uuid, :'carla'::uuid) as _assign \gset

reset role;
select set_config('request.jwt.claims', json_build_object('sub', :'carla', 'role', 'authenticated')::text, true);
set local role authenticated;

select ok(
  get_conversation((:'novo_r1'::jsonb ->> 'conversation_id')::uuid) is not null,
  'lawyer com o lead atribuído a ela agora enxerga a conversa'
);

select is(
  get_conversation((:'ambiguo_r1'::jsonb ->> 'conversation_id')::uuid),
  null,
  'lawyer não enxerga conversa sem lead vinculado (needs_link_review) mesmo sem estar em disputa de outro lead'
);

reset role;
select set_config('request.jwt.claims', json_build_object('sub', :'ana', 'role', 'authenticated')::text, true);
set local role authenticated;

select ok(
  get_conversation((:'ambiguo_r1'::jsonb ->> 'conversation_id')::uuid) is not null,
  'owner enxerga conversa sem lead vinculado normalmente'
);

-- ---------------------------------------------------------------------
-- 10) Paginação do histórico — mais mensagens que o limite de uma página,
--     a mais antiga continua acessível, "há mais" é sinalizado direito.
-- ---------------------------------------------------------------------

select register_contact_consent(
  (:'ambiguo_r1'::jsonb ->> 'contact_id')::uuid, 'whatsapp', 'consentimento', 'Atendimento via WhatsApp (paginação)'
) as consent_pag \gset

do $$
declare
  v_conv uuid := (select (:'ambiguo_r1'::jsonb ->> 'conversation_id')::uuid);
  i integer;
begin
  for i in 1..12 loop
    perform public.send_message(v_conv, 'Mensagem de paginação número ' || i, gen_random_uuid());
  end loop;
end $$;

select * from list_conversation_messages((:'ambiguo_r1'::jsonb ->> 'conversation_id')::uuid, null, 5) \gset

select is(jsonb_array_length(items), 5, 'Primeira página do histórico respeita o limite pedido (5)');
select ok(has_more, 'has_more=true quando ainda há mensagens mais antigas');

select (items -> 0 ->> 'created_at')::timestamptz as cursor_mais_antiga \gset

select * from list_conversation_messages((:'ambiguo_r1'::jsonb ->> 'conversation_id')::uuid, :'cursor_mais_antiga'::timestamptz, 100) \gset

-- Total: 1 (mensagem original recebida) + 12 enviadas = 13; página 1 pegou
-- as 5 mais recentes, sobrando 8 mais antigas (a "mais antiga de todas" é a
-- própria mensagem recebida).
select is(jsonb_array_length(items), 8, 'Segunda página (cursor) traz o restante — a mensagem mais antiga de todas continua acessível');
select ok(not has_more, 'has_more=false quando não sobra mais nada antes do cursor');

select * from list_conversation_messages((:'novo_r1'::jsonb ->> 'conversation_id')::uuid, null, 30) \gset
select is(has_more, false, 'Conversa pequena (menos que o limite pedido): has_more=false já na primeira página');

select * from finish();
rollback;
