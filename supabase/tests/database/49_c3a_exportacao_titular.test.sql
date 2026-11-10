-- pgTAP — C3a: exportação dos dados de um titular (LGPD).
--
-- Papéis no workspace Um: Ana owner, Bruno admin, Daniel manager, Carla lawyer,
-- Elisa viewer. Workspace Dois: Bruno owner. Os dados do titular levam o
-- marcador ALFA; os de OUTRO contato do mesmo workspace levam BETA; o de outro
-- workspace, GAMA — nenhum dos dois pode aparecer na exportação do titular.

begin;
select plan(59);

\set ana    '20000000-0000-0000-0000-000000000001'
\set bruno  '20000000-0000-0000-0000-000000000002'
\set carla  '20000000-0000-0000-0000-000000000003'
\set daniel '20000000-0000-0000-0000-000000000004'
\set elisa  '20000000-0000-0000-0000-000000000005'
\set ws_um   '10000000-0000-0000-0000-000000000001'
\set ws_dois '10000000-0000-0000-0000-000000000002'

insert into public.memberships (workspace_id, user_id, role, status) values
  (:'ws_um'::uuid, :'bruno'::uuid, 'admin', 'active'),
  (:'ws_um'::uuid, :'daniel'::uuid, 'manager', 'active');

-- ---------------------------------------------------------------------
-- Ajudantes (só desta transação)
-- ---------------------------------------------------------------------

create function pg_temp.login(p_user uuid) returns void language sql as $f$
  select set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true)
$f$;

-- Leitura como dono do banco (as tabelas são fechadas para authenticated).
create function pg_temp.n(p_sql text) returns bigint language plpgsql security definer as $f$
declare v bigint;
begin
  execute p_sql into v;
  return v;
end;
$f$;

create function pg_temp.t(p_sql text) returns text language plpgsql security definer as $f$
declare v text;
begin
  execute p_sql into v;
  return v;
end;
$f$;

-- ---------------------------------------------------------------------
-- Dados de apoio
-- ---------------------------------------------------------------------

set local role authenticated;
select pg_temp.login(:'ana'::uuid);
select (create_contact(:'ws_um'::uuid, 'pf', 'Titular ALFA', 'Curitiba', 'PR', null)).id as alfa \gset
select (create_contact(:'ws_um'::uuid, 'pf', 'Outro BETA', 'Londrina', 'PR', null)).id as beta \gset
select (create_contact(:'ws_um'::uuid, 'pf', 'Vazio ZERO', null, null, null)).id as vazio \gset
select (create_contact(:'ws_um'::uuid, 'pf', 'Mesclado ALFA', null, null, null)).id as mesclado \gset
select create_lead(:'ws_um'::uuid, (:'alfa')::uuid, 'Trabalhista ALFA', 'Resumo ALFA', array['tag-alfa'], 'alta', :'ana'::uuid) as lead_alfa \gset
select create_lead(:'ws_um'::uuid, (:'beta')::uuid, 'Cível BETA', 'Resumo BETA', array['tag-beta'], 'media', :'ana'::uuid) as lead_beta \gset
select create_opportunity((:'lead_alfa')::uuid) as opp_alfa \gset
select create_opportunity((:'lead_beta')::uuid) as opp_beta \gset

select pg_temp.login(:'bruno'::uuid);
select (create_contact(:'ws_dois'::uuid, 'pf', 'Contato GAMA', null, null, null)).id as gama \gset
reset role;

-- Contato mesclado: some das telas e da exportação (comportamento já adotado).
update public.contacts set merged_into_contact_id = (:'alfa')::uuid where id = (:'mesclado')::uuid;

-- Titular ALFA — contato e identificação.
insert into public.contact_phones (workspace_id, contact_id, value_normalized, source) values
  (:'ws_um'::uuid, (:'alfa')::uuid, '+5541999990001', 'manual');
insert into public.contact_emails (workspace_id, contact_id, value_normalized, source) values
  (:'ws_um'::uuid, (:'alfa')::uuid, 'alfa@exemplo.test', 'manual');
insert into public.contact_identifiers (workspace_id, contact_id, provider, external_id) values
  (:'ws_um'::uuid, (:'alfa')::uuid, 'google', 'ext-alfa-1');
insert into public.contact_sensitive (workspace_id, contact_id, cpf_cnpj_ciphertext, cpf_cnpj_blind_index, key_version) values
  (:'ws_um'::uuid, (:'alfa')::uuid, '\xc1f4c1f4c1f4c1f4c1f4c1f4'::bytea, '\xb11db11db11db11d'::bytea, 'v1');
insert into public.contact_consents (workspace_id, contact_id, channel, legal_basis, purpose, accepted_text) values
  (:'ws_um'::uuid, (:'alfa')::uuid, 'email', 'consentimento', 'Contato ALFA', 'Texto aceito ALFA');
insert into public.consent_evidence (workspace_id, contact_id, decision, purpose_code, purpose, legal_basis, channel, decided_at, text_version, text_hash, ip_hmac, evidence) values
  (:'ws_um'::uuid, (:'alfa')::uuid, 'granted', 'formulario_contato', 'Contato ALFA', 'consentimento', 'email', now(), 'v7', decode(repeat('7e', 32), 'hex'), decode(repeat('1b', 32), 'hex'), '{"ua":"EVIDENCIA-BRUTA"}');

-- Titular ALFA — processo.
update public.lead_values set estimated_value_cents = 123400 where lead_id = (:'lead_alfa')::uuid;
insert into public.lead_values (workspace_id, lead_id, estimated_value_cents)
  select workspace_id, id, 123400 from public.leads where id = (:'lead_alfa')::uuid
  on conflict (lead_id) do update set estimated_value_cents = 123400;
insert into public.lead_notes (workspace_id, lead_id, body, created_by) values
  (:'ws_um'::uuid, (:'lead_alfa')::uuid, 'Nota ALFA', :'ana'::uuid),
  (:'ws_um'::uuid, (:'lead_beta')::uuid, 'Nota BETA', :'ana'::uuid);
insert into public.conflict_checks (workspace_id, lead_id, note) values
  (:'ws_um'::uuid, (:'lead_alfa')::uuid, 'Conflito ALFA'),
  (:'ws_um'::uuid, (:'lead_beta')::uuid, 'Conflito BETA');
insert into public.activities (workspace_id, lead_id, type, title, due_at, created_by, notes) values
  (:'ws_um'::uuid, (:'lead_alfa')::uuid, 'call', 'Atividade ALFA', now() + interval '1 day', :'ana'::uuid, 'Obs ALFA'),
  (:'ws_um'::uuid, (:'lead_beta')::uuid, 'call', 'Atividade BETA', now() + interval '1 day', :'ana'::uuid, 'Obs BETA');
select id as stage_alfa from public.pipeline_stages where id = (select stage_id from public.opportunities where id = (:'opp_alfa')::uuid) \gset
insert into public.stage_requirements (workspace_id, stage_id, label, field_type) values
  (:'ws_um'::uuid, (:'stage_alfa')::uuid, 'Requisito ALFA', 'text') returning id as req_alfa \gset
insert into public.opportunity_requirement_values (workspace_id, opportunity_id, requirement_id, value_text) values
  (:'ws_um'::uuid, (:'opp_alfa')::uuid, (:'req_alfa')::uuid, 'Valor requisito ALFA');
insert into public.stage_transitions (workspace_id, opportunity_id, to_stage_id, actor_user_id) values
  (:'ws_um'::uuid, (:'opp_alfa')::uuid, (:'stage_alfa')::uuid, :'ana'::uuid);
insert into public.proposals (workspace_id, lead_id, opportunity_id, number, value_cents, fee_model, created_by) values
  (:'ws_um'::uuid, (:'lead_alfa')::uuid, (:'opp_alfa')::uuid, 'PROP-ALFA-1', 500000, 'fixed', :'ana'::uuid)
  returning id as prop_alfa \gset
insert into public.proposal_documents (workspace_id, proposal_id, version, storage_path, requested_by, checksum_sha256, byte_size, status, resolved_at) values
  (:'ws_um'::uuid, (:'prop_alfa')::uuid, 1, 'CAMINHO-INTERNO-SECRETO/alfa.pdf', :'ana'::uuid, decode(repeat('c4', 32), 'hex'), 2048, 'ready', now())
  returning id as doc_alfa \gset
insert into public.proposal_email_sends (workspace_id, proposal_id, document_id, to_email, requested_by, idempotency_key, provider_message_id, status, resolved_at) values
  (:'ws_um'::uuid, (:'prop_alfa')::uuid, (:'doc_alfa')::uuid, 'alfa@exemplo.test', :'ana'::uuid, gen_random_uuid(), 'PROVEDOR-MSG-ALFA', 'accepted', now());
insert into public.clients (workspace_id, contact_id, owner_user_id) values (:'ws_um'::uuid, (:'alfa')::uuid, :'ana'::uuid)
  returning id as client_alfa \gset
insert into public.client_handoffs (workspace_id, client_id, opportunity_id, last_error) values
  (:'ws_um'::uuid, (:'client_alfa')::uuid, (:'opp_alfa')::uuid, 'ERRO-TECNICO-HANDOFF');

-- Titular ALFA — WhatsApp.
insert into public.whatsapp_channels (workspace_id, label, display_phone_number, created_by, provider, is_simulator, environment, routing_key) values
  (:'ws_um'::uuid, 'Canal teste', '+5541900000000', :'ana'::uuid, 'ycloud', false, 'preview', 'rota-c3a')
  returning id as canal \gset
insert into public.whatsapp_identities (workspace_id, channel_id, provider, environment, phone_e164, bsuid_ciphertext, bsuid_blind_index, bsuid_key_version) values
  (:'ws_um'::uuid, (:'canal')::uuid, 'ycloud', 'preview', '+5541999990001', decode(repeat('b5', 40), 'hex'), decode(repeat('b6', 32), 'hex'), 'v1')
  returning id as ident_alfa \gset
insert into public.whatsapp_identities (workspace_id, channel_id, provider, environment, phone_e164) values
  (:'ws_um'::uuid, (:'canal')::uuid, 'ycloud', 'preview', '+5541999990002')
  returning id as ident_beta \gset
insert into public.conversations (workspace_id, channel_id, identity_id, contact_id, lead_id, link_candidate_contact_ids) values
  (:'ws_um'::uuid, (:'canal')::uuid, (:'ident_alfa')::uuid, (:'alfa')::uuid, (:'lead_alfa')::uuid, array[(:'beta')::uuid])
  returning id as conv_alfa \gset
insert into public.conversations (workspace_id, channel_id, identity_id, contact_id, lead_id) values
  (:'ws_um'::uuid, (:'canal')::uuid, (:'ident_beta')::uuid, (:'beta')::uuid, (:'lead_beta')::uuid)
  returning id as conv_beta \gset
insert into public.messages (workspace_id, conversation_id, channel_id, direction, status, origin, sender_classification, content_kind, body_text, provider, provider_message_id) values
  (:'ws_um'::uuid, (:'conv_alfa')::uuid, (:'canal')::uuid, 'inbound', 'delivered', 'inbound', 'external', 'text', 'Mensagem ALFA', 'ycloud', 'WAMID-ALFA-PROVEDOR')
  returning id as msg_alfa \gset
insert into public.messages (workspace_id, conversation_id, channel_id, direction, status, origin, sender_classification, content_kind, body_text, provider, provider_message_id) values
  (:'ws_um'::uuid, (:'conv_beta')::uuid, (:'canal')::uuid, 'inbound', 'delivered', 'inbound', 'external', 'text', 'Mensagem BETA', 'ycloud', 'WAMID-BETA');
insert into public.message_status_events (workspace_id, message_id, status, event_wa_timestamp, applied) values
  (:'ws_um'::uuid, (:'msg_alfa')::uuid, 'delivered', now(), true);

-- Titular ALFA — atribuição (A11).
insert into public.touchpoints (workspace_id, contact_id, lead_id, opportunity_id, received_at, normalized_occurred_at, occurred_at, channel, position, source, campaign, gclid) values
  (:'ws_um'::uuid, (:'alfa')::uuid, (:'lead_alfa')::uuid, (:'opp_alfa')::uuid, now(), now(), now(), 'formulario', 1, 'google', 'Campanha ALFA', 'gclid-alfa')
  returning id as tp_alfa \gset
insert into public.touchpoint_demand_links (workspace_id, touchpoint_id, opportunity_id, action, reason) values
  (:'ws_um'::uuid, (:'tp_alfa')::uuid, (:'opp_alfa')::uuid, 'assign', 'Vínculo ALFA');
insert into public.continuity_references (workspace_id, token_hash, contact_id, lead_id, purpose, expires_at) values
  (:'ws_um'::uuid, decode(repeat('70', 32), 'hex'), (:'alfa')::uuid, (:'lead_alfa')::uuid, 'Retomada ALFA', now() + interval '7 days');

-- Outro contato (BETA) e outro workspace (GAMA) — dados que NÃO podem vazar.
insert into public.contact_phones (workspace_id, contact_id, value_normalized, source) values
  (:'ws_um'::uuid, (:'beta')::uuid, '+5541999990002', 'manual');
insert into public.contact_sensitive (workspace_id, contact_id, cpf_cnpj_ciphertext, cpf_cnpj_blind_index, key_version) values
  (:'ws_um'::uuid, (:'beta')::uuid, '\xbe7abe7abe7abe7a'::bytea, '\xbe7abe7a00000001'::bytea, 'v1');
insert into public.touchpoints (workspace_id, contact_id, lead_id, received_at, normalized_occurred_at, occurred_at, channel, position, source, campaign) values
  (:'ws_um'::uuid, (:'beta')::uuid, (:'lead_beta')::uuid, now(), now(), now(), 'formulario', 1, 'meta', 'Campanha BETA');

-- Campos personalizados (C4): quatro entidades, seleção única e um campo arquivado.
set local role authenticated;
select pg_temp.login(:'ana'::uuid);
select create_custom_field(:'ws_um'::uuid, 'contact', 'Campo contato', 'text', 0, null) as d_contato \gset
select create_custom_field(:'ws_um'::uuid, 'lead', 'Campo lead', 'number', 0, null) as d_lead \gset
select create_custom_field(:'ws_um'::uuid, 'opportunity', 'Campo oportunidade', 'date', 0, null) as d_opp \gset
select create_custom_field(:'ws_um'::uuid, 'client', 'Campo cliente', 'boolean', 0, null) as d_cliente \gset
select create_custom_field(:'ws_um'::uuid, 'contact', 'Origem escolhida', 'select', 1, '[{"label":"Indicação ALFA"},{"label":"Evento"}]'::jsonb) as d_sel \gset
select create_custom_field(:'ws_um'::uuid, 'lead', 'Campo arquivado', 'text', 1, null) as d_arq \gset
reset role;
select id as opt_alfa from public.custom_field_options where definition_id = (:'d_sel')::uuid and label = 'Indicação ALFA' \gset
set local role authenticated;
select pg_temp.login(:'ana'::uuid);
select set_custom_field_values('contact', (:'alfa')::uuid, jsonb_build_array(
  jsonb_build_object('definition_id', :'d_contato', 'value', 'Texto ALFA'),
  jsonb_build_object('definition_id', :'d_sel', 'value', :'opt_alfa')));
select set_custom_field_values('lead', (:'lead_alfa')::uuid, jsonb_build_array(
  jsonb_build_object('definition_id', :'d_lead', 'value', 42.5),
  jsonb_build_object('definition_id', :'d_arq', 'value', 'Valor arquivado ALFA')));
select set_custom_field_values('opportunity', (:'opp_alfa')::uuid, jsonb_build_array(
  jsonb_build_object('definition_id', :'d_opp', 'value', '2026-12-01')));
select set_custom_field_values('contact', (:'beta')::uuid, jsonb_build_array(
  jsonb_build_object('definition_id', :'d_contato', 'value', 'Texto BETA')));
reset role;
insert into public.custom_field_values (workspace_id, definition_id, entity_type, field_type, client_id, value_boolean) values
  (:'ws_um'::uuid, (:'d_cliente')::uuid, 'client', 'boolean', (:'client_alfa')::uuid, true);
update public.custom_field_definitions set archived_at = now() where id = (:'d_arq')::uuid;

-- =====================================================================
-- 1) Superfície fechada
-- =====================================================================

select ok(
  (select relrowsecurity and relforcerowsecurity from pg_class where oid = 'public.privacy_exports'::regclass),
  'privacy_exports tem RLS habilitada e forçada'
);
select is((select count(*) from pg_policy where polrelid = 'public.privacy_exports'::regclass), 0::bigint, 'nenhuma policy na tabela do registro');
select ok(
  not has_table_privilege('anon', 'public.privacy_exports', 'select,insert,update,delete,truncate,references,trigger')
  and not has_table_privilege('authenticated', 'public.privacy_exports', 'select,insert,update,delete,truncate,references,trigger'),
  'anon e authenticated não têm privilégio algum na tabela do registro'
);
select is(
  (select array_agg(p.proname::text order by p.proname) from pg_proc p
   where p.pronamespace = 'public'::regnamespace and p.proname like '%privacy_export%'
     and p.prosecdef and exists (select 1 from unnest(p.proconfig) c where c = 'search_path=""')
     and has_function_privilege('authenticated', p.oid, 'execute')
     and not has_function_privilege('anon', p.oid, 'execute') and not has_function_privilege('public', p.oid, 'execute')),
  array['finish_privacy_export', 'get_privacy_export_payload', 'request_privacy_export'],
  'as três RPCs são SECURITY DEFINER, com search_path vazio, e executam só para authenticated'
);
select ok(
  (select p.provolatile = 's' and p.prosecdef and not has_function_privilege('authenticated', p.oid, 'execute')
          and not has_function_privilege('anon', p.oid, 'execute')
   from pg_proc p where p.pronamespace = 'private'::regnamespace and p.proname = 'privacy_export_payload'),
  'a leitura consistente é STABLE (um só instantâneo), SECURITY DEFINER e fechada ao cliente'
);

-- =====================================================================
-- 2) Quem pode exportar
-- =====================================================================

set local role authenticated;
select pg_temp.login(:'ana'::uuid);
select request_privacy_export((:'alfa')::uuid) as exp_ana \gset
select ok((:'exp_ana') is not null, 'owner abre a exportação');
select pg_temp.login(:'bruno'::uuid);
select request_privacy_export((:'alfa')::uuid) as exp_bruno \gset
select ok((:'exp_bruno') is not null, 'admin abre a exportação');
select pg_temp.login(:'daniel'::uuid);
select throws_ok(format($q$select request_privacy_export(%L)$q$, :'alfa'), 'P0001', 'insufficient_permission', 'manager é recusado');
select pg_temp.login(:'carla'::uuid);
select throws_ok(format($q$select request_privacy_export(%L)$q$, :'alfa'), 'P0001', 'insufficient_permission', 'advogado é recusado');
select pg_temp.login(:'elisa'::uuid);
select throws_ok(format($q$select request_privacy_export(%L)$q$, :'alfa'), 'P0001', 'insufficient_permission', 'viewer é recusado');
select pg_temp.login(:'ana'::uuid);
select throws_ok(format($q$select request_privacy_export(%L)$q$, :'gama'), 'P0001', 'contact_not_found', 'contato de outro workspace: não encontrado');
select throws_ok(format($q$select request_privacy_export(%L)$q$, gen_random_uuid()), 'P0001', 'contact_not_found', 'contato inexistente: não encontrado');
select throws_ok(format($q$select request_privacy_export(%L)$q$, :'mesclado'), 'P0001', 'contact_not_found', 'contato mesclado: não encontrado (comportamento existente)');
select set_config('request.jwt.claims', '', true);
select throws_ok(format($q$select request_privacy_export(%L)$q$, :'alfa'), 'P0001', 'authentication_required', 'sem sessão: autenticação exigida');
reset role;

-- =====================================================================
-- 3) Conteúdo: categorias, isolamento e itens deliberadamente fora
-- =====================================================================

set local role authenticated;
select pg_temp.login(:'ana'::uuid);
select get_privacy_export_payload((:'exp_ana')::uuid) as pacote \gset
reset role;

select is(:'pacote'::jsonb #>> '{data,contact,name}', 'Titular ALFA', 'o contato do titular está no arquivo');
select is(jsonb_array_length(:'pacote'::jsonb #> '{data,phones}'), 1, 'telefones');
select is(jsonb_array_length(:'pacote'::jsonb #> '{data,emails}'), 1, 'e-mails');
select is(jsonb_array_length(:'pacote'::jsonb #> '{data,identifiers}'), 1, 'identificadores');
select is(jsonb_array_length(:'pacote'::jsonb #> '{data,consents}'), 1, 'consentimentos');
select is(jsonb_array_length(:'pacote'::jsonb #> '{data,consent_evidence}'), 1, 'evidência de consentimento');
select is(:'pacote'::jsonb #>> '{data,leads,0,estimated_value_cents}', '123400', 'lead com valor estimado');
select is(
  (select coalesce(array_agg(k order by k), array[]::text[]) from jsonb_object_keys(:'pacote'::jsonb -> 'data') k where jsonb_typeof(:'pacote'::jsonb -> 'data' -> k) = 'array' and jsonb_array_length(:'pacote'::jsonb -> 'data' -> k) = 0),
  array[]::text[],
  'toda categoria do titular de teste tem pelo menos um item'
);
select is(:'pacote'::jsonb #>> '{data,opportunity_requirements,0,label}', 'Requisito ALFA', 'requisitos da oportunidade com o rótulo');
select is(jsonb_array_length(:'pacote'::jsonb #> '{data,stage_history}'), 1, 'histórico de etapas');
select is(:'pacote'::jsonb #>> '{data,activities,0,title}', 'Atividade ALFA', 'atividades do titular');
select is(jsonb_array_length(:'pacote'::jsonb #> '{data,client_handoffs}'), 1, 'cliente e handoff');
select is(:'pacote'::jsonb #>> '{data,proposals,0,number}', 'PROP-ALFA-1', 'proposta');
select is(jsonb_array_length(:'pacote'::jsonb #> '{data,proposal_documents}'), 1, 'documento da proposta: só metadados');
select is(:'pacote'::jsonb #>> '{data,proposal_email_sends,0,to_email}', 'alfa@exemplo.test', 'histórico de envio da proposta');
select is(:'pacote'::jsonb #>> '{data,lead_notes,0,body}', 'Nota ALFA', 'notas');
select is(:'pacote'::jsonb #>> '{data,conflict_checks,0,note}', 'Conflito ALFA', 'verificação de conflito');
select is(:'pacote'::jsonb #>> '{data,messages,0,body_text}', 'Mensagem ALFA', 'mensagens do WhatsApp');
select is(jsonb_array_length(:'pacote'::jsonb #> '{data,message_status_events}'), 1, 'status das mensagens');
select is(:'pacote'::jsonb #>> '{data,whatsapp_identities,0,phone}', '+5541999990001', 'identidade do WhatsApp');
select is(:'pacote'::jsonb #>> '{data,attribution_touchpoints,0,campaign}', 'Campanha ALFA', 'atribuição (touchpoints)');
select is(jsonb_array_length(:'pacote'::jsonb #> '{data,attribution_links}'), 1, 'vínculos de atribuição');
select is(jsonb_array_length(:'pacote'::jsonb #> '{data,continuity_references}'), 1, 'continuidade');

select is(
  (select jsonb_agg(jsonb_build_array(f ->> 'entity_type', f ->> 'field', f -> 'value') order by f ->> 'entity_type', f ->> 'field')
   from jsonb_array_elements(:'pacote'::jsonb #> '{data,custom_fields}') f),
  jsonb_build_array(
    jsonb_build_array('client', 'Campo cliente', 'true'::jsonb),
    jsonb_build_array('contact', 'Campo contato', '"Texto ALFA"'::jsonb),
    jsonb_build_array('contact', 'Origem escolhida', '"Indicação ALFA"'::jsonb),
    jsonb_build_array('lead', 'Campo arquivado', '"Valor arquivado ALFA"'::jsonb),
    jsonb_build_array('lead', 'Campo lead', '42.5'::jsonb),
    jsonb_build_array('opportunity', 'Campo oportunidade', '"2026-12-01"'::jsonb)),
  'campos personalizados das quatro entidades; seleção sai pelo rótulo; valor de campo arquivado é preservado'
);

select ok(:'pacote'::jsonb::text not like '%BETA%', 'nada de outro contato do mesmo workspace (nem pela lista de candidatos de vínculo)');
select ok(:'pacote'::jsonb::text not like '%GAMA%', 'nada de outro workspace');
select ok((:'pacote'::jsonb -> 'data')::text !~* '(ciphertext|blind_index|bsuid|token_hash|ip_hmac|text_hash|storage_path|checksum|api_key|secret)', 'nenhuma chave de ciphertext, hash, índice cego, segredo ou caminho de armazenamento');
select ok(
  :'pacote'::jsonb::text not like '%CAMINHO-INTERNO-SECRETO%' and :'pacote'::jsonb::text not like '%WAMID-ALFA-PROVEDOR%'
  and :'pacote'::jsonb::text not like '%PROVEDOR-MSG-ALFA%' 
  and :'pacote'::jsonb::text not like '%ERRO-TECNICO-HANDOFF%' and :'pacote'::jsonb::text not like '%EVIDENCIA-BRUTA%',
  'ids de provedor, chaves de idempotência, erros técnicos e evidência bruta ficam fora'
);
select ok(
  (:'pacote'::jsonb -> 'data')::text not like '%' || encode('\xc1f4c1f4c1f4c1f4c1f4c1f4'::bytea, 'base64') || '%',
  'o ciphertext do CPF não está dentro do conteúdo exportado'
);
select is(:'pacote'::jsonb #>> '{sensitive,key_version}', 'v1', 'o ciphertext do CPF volta separado, só para o servidor decifrar');

-- =====================================================================
-- 4) Registro, trilha e auditoria sem conteúdo
-- =====================================================================

select is(pg_temp.n($$select count(*) from public.sensitive_data_access where contact_id = '$$ || :'alfa' || $$' and reason = 'exportacao_titular' and field = 'cpf_cnpj'$$), 1::bigint, 'a leitura do CPF entrou na trilha de dado sensível existente (sem o valor)');

set local role authenticated;
select pg_temp.login(:'bruno'::uuid);
select throws_ok(format($q$select get_privacy_export_payload(%L)$q$, :'exp_ana'), 'P0001', 'privacy_export_not_found', 'outro usuário não lê o pacote de um registro alheio');
select pg_temp.login(:'ana'::uuid);
select throws_ok(format($q$select finish_privacy_export(%L, 'qualquer')$q$, :'exp_ana'), 'P0001', 'privacy_export_failure_invalid', 'código de falha fora da lista fechada é recusado');
select lives_ok(format($q$select finish_privacy_export(%L)$q$, :'exp_ana'), 'concluir o registro');
select throws_ok(format($q$select finish_privacy_export(%L)$q$, :'exp_ana'), 'P0001', 'privacy_export_not_found', 'registro fechado não fecha de novo');
select throws_ok(format($q$select get_privacy_export_payload(%L)$q$, :'exp_ana'), 'P0001', 'privacy_export_not_found', 'registro fechado não entrega o pacote de novo');
reset role;

select is(pg_temp.t($$select status || ':' || coalesce(failure_code, '-') from public.privacy_exports where id = '$$ || :'exp_ana' || $$'$$), 'completed:-', 'registro concluído');

-- Falha: nunca vira "concluída".
set local role authenticated;
select pg_temp.login(:'bruno'::uuid);
select get_privacy_export_payload((:'exp_bruno')::uuid) is not null as ok_bruno \gset
select finish_privacy_export((:'exp_bruno')::uuid, 'decryption_failed');
reset role;
select is(pg_temp.t($$select status || ':' || failure_code from public.privacy_exports where id = '$$ || :'exp_bruno' || $$'$$), 'failed:decryption_failed', 'falha fica registrada como falha, com código fechado');
select is(pg_temp.n($$select count(*) from public.audit_logs where action = 'privacy.export_generated' and resource_id = '$$ || :'exp_bruno' || $$'$$), 0::bigint, 'falha não gera auditoria de "gerada"');
select is(
  pg_temp.n($$select count(*) from public.audit_logs where action in ('privacy.export_requested','privacy.export_generated','privacy.export_failed')$$),
  4::bigint, 'duas solicitadas, uma gerada e uma falha'
);

select ok(
  not exists (
    select 1 from public.audit_logs a
    where a.action like 'privacy.%'
      and (a.metadata::text ~* '(alfa|beta|gama|@|\+55|curitiba|cpf)'
           or exists (select 1 from jsonb_object_keys(a.metadata) k where k not in ('contact_id', 'format_version', 'result_code')))
  ),
  'auditoria guarda só ids, versão e código fechado — nenhum nome, contato, CPF ou valor'
);
select ok(
  (select array_agg(column_name::text order by column_name) from information_schema.columns
   where table_schema = 'public' and table_name = 'privacy_exports')
  = array['contact_id', 'failure_code', 'finished_at', 'format_version', 'id', 'requested_at', 'requested_by', 'status', 'workspace_id'],
  'o registro operacional não tem coluna de conteúdo'
);

-- =====================================================================
-- 5) Casos de borda
-- =====================================================================

set local role authenticated;
select pg_temp.login(:'ana'::uuid);
select request_privacy_export((:'vazio')::uuid) as exp_vazio \gset
select get_privacy_export_payload((:'exp_vazio')::uuid) as pacote_vazio \gset
reset role;
select is(
  (select count(*) from jsonb_each(:'pacote_vazio'::jsonb -> 'data') e where case when jsonb_typeof(e.value) = 'array' then jsonb_array_length(e.value) > 0 else false end),
  0::bigint, 'contato sem dados relacionados: todas as categorias saem vazias, sem erro'
);
select ok(:'pacote_vazio'::jsonb -> 'sensitive' = 'null'::jsonb or (:'pacote_vazio'::jsonb -> 'sensitive') is null, 'sem CPF cadastrado, nada é lido nem registrado como acesso sensível');

-- O papel muda entre o pedido e a leitura: o pacote não sai.
set local role authenticated;
select pg_temp.login(:'ana'::uuid);
select request_privacy_export((:'beta')::uuid) as exp_beta \gset
reset role;
update public.memberships set role = 'manager' where workspace_id = (:'ws_um')::uuid and user_id = (:'ana')::uuid;
set local role authenticated;
select pg_temp.login(:'ana'::uuid);
select throws_ok(format($q$select get_privacy_export_payload(%L)$q$, :'exp_beta'), 'P0001', 'privacy_export_not_found', 'quem perdeu o papel entre o pedido e a leitura não recebe o pacote');
reset role;

select * from finish();
rollback;
