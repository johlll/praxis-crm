-- pgTAP — C3b: retenção de 12 meses e anonimização de contato (LGPD).
--
-- Todas as RPCs são EXCLUSIVAS do servidor (service_role) e recebem o ator e o workspace
-- ativo como parâmetros; nenhuma sessão de usuário (authenticated) consegue chamá-las.
--
-- Papéis no workspace Um: Ana owner, Bruno admin, Daniel manager, Carla lawyer, Elisa viewer.
-- Workspace Dois: Bruno owner. Os dados do titular levam o marcador ALFA; os de outro contato
-- do mesmo workspace, BETA; os do outro workspace, GAMA. Nenhum marcador do titular pode
-- sobrar depois da anonimização — nem em retorno, nem em auditoria, nem em erro.

begin;
select plan(156);

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

-- Leitura como dono do banco (as tabelas são fechadas para os papéis de API).
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

-- Arquiva o lead e fixa o marco (o gatilho é a única fonte; aqui ele é suspenso só para recuar o relógio).
create function pg_temp.archive_at(p_lead uuid, p_at timestamptz) returns void language plpgsql as $f$
begin
  update public.leads set status = 'arquivado' where id = p_lead;
  alter table public.leads disable trigger leads_retention_mark;
  update public.leads set archived_at = p_at where id = p_lead;
  alter table public.leads enable trigger leads_retention_mark;
end;
$f$;

-- Doze meses atrás, mais o desvio dado (mesma aritmética de relógio da migration).
create function pg_temp.ago12(p_shift interval default interval '0') returns timestamptz language sql as $f$
  select ((now() at time zone 'UTC') - interval '12 months' + p_shift) at time zone 'UTC'
$f$;

-- ---------------------------------------------------------------------
-- Dados de apoio
-- ---------------------------------------------------------------------

set local role authenticated;
select pg_temp.login(:'ana'::uuid);
select (create_contact(:'ws_um'::uuid, 'pf', 'Titular ALFA', 'Curitiba ALFA', 'PR', null)).id as alfa \gset
select (create_contact(:'ws_um'::uuid, 'pf', 'Outro BETA', 'Londrina', 'PR', null)).id as beta \gset
select (create_contact(:'ws_um'::uuid, 'pf', 'Jovem 11 meses', null, null, null)).id as jovem \gset
select (create_contact(:'ws_um'::uuid, 'pf', 'Exato 12 meses', null, null, null)).id as exato \gset
select (create_contact(:'ws_um'::uuid, 'pf', 'Quase 12 meses', null, null, null)).id as quase \gset
select (create_contact(:'ws_um'::uuid, 'pf', 'Lead ativo', null, null, null)).id as ativo \gset
select (create_contact(:'ws_um'::uuid, 'pf', 'Sem lead', null, null, null)).id as semlead \gset
select (create_contact(:'ws_um'::uuid, 'pf', 'Cliente', null, null, null)).id as cliente \gset
select (create_contact(:'ws_um'::uuid, 'pf', 'Oportunidade aberta', null, null, null)).id as aberta \gset
select (create_contact(:'ws_um'::uuid, 'pf', 'Oportunidade ganha', null, null, null)).id as ganha \gset
select (create_contact(:'ws_um'::uuid, 'pf', 'Preservado', null, null, null)).id as preservado \gset
select (create_contact(:'ws_um'::uuid, 'pf', 'Com PDF', null, null, null)).id as comdoc \gset
select (create_contact(:'ws_um'::uuid, 'pf', 'Envio pendente', null, null, null)).id as pendente \gset
select (create_contact(:'ws_um'::uuid, 'pf', 'Falha FALHA', null, null, null)).id as falha \gset
select (create_contact(:'ws_um'::uuid, 'pf', 'Lote UM', null, null, null)).id as lote1 \gset
select (create_contact(:'ws_um'::uuid, 'pf', 'Lote DOIS FALHA', null, null, null)).id as lote2 \gset
select (create_contact(:'ws_um'::uuid, 'pf', 'Lote TRES', null, null, null)).id as lote3 \gset
select (create_contact(:'ws_um'::uuid, 'pf', 'Mesclado', null, null, null)).id as mesclado \gset
select (create_contact(:'ws_um'::uuid, 'pf', 'Silencioso', null, null, null)).id as silencioso \gset
select (create_contact(:'ws_um'::uuid, 'pf', 'Proposta enviada', null, null, null)).id as propenv \gset
select (create_contact(:'ws_um'::uuid, 'pf', 'Absorvente', null, null, null)).id as absorvente \gset

select create_lead(:'ws_um'::uuid, (:'alfa')::uuid, 'Trabalhista ALFA', 'INTERNO-resumo-ALFA', array['INTERNO-tag-alfa'], 'alta', :'ana'::uuid) as lead_alfa \gset
select create_lead(:'ws_um'::uuid, (:'alfa')::uuid, 'Cível ALFA', 'INTERNO-resumo2-ALFA', array['tag2-alfa'], 'media', :'ana'::uuid) as lead_alfa2 \gset
select create_lead(:'ws_um'::uuid, (:'beta')::uuid, 'Cível BETA', 'Resumo BETA', array['tag-beta'], 'media', :'ana'::uuid) as lead_beta \gset
select create_lead(:'ws_um'::uuid, (:'jovem')::uuid, 'Área', null, '{}'::text[], 'media', :'ana'::uuid) as lead_jovem \gset
select create_lead(:'ws_um'::uuid, (:'exato')::uuid, 'Área', null, '{}'::text[], 'media', :'ana'::uuid) as lead_exato \gset
select create_lead(:'ws_um'::uuid, (:'quase')::uuid, 'Área', null, '{}'::text[], 'media', :'ana'::uuid) as lead_quase \gset
select create_lead(:'ws_um'::uuid, (:'ativo')::uuid, 'Área', null, '{}'::text[], 'media', :'ana'::uuid) as lead_ativo_velho \gset
select create_lead(:'ws_um'::uuid, (:'ativo')::uuid, 'Área', null, '{}'::text[], 'media', :'ana'::uuid) as lead_ativo \gset
select create_lead(:'ws_um'::uuid, (:'cliente')::uuid, 'Área', null, '{}'::text[], 'media', :'ana'::uuid) as lead_cliente \gset
select create_lead(:'ws_um'::uuid, (:'aberta')::uuid, 'Área', null, '{}'::text[], 'media', :'ana'::uuid) as lead_aberta \gset
select create_lead(:'ws_um'::uuid, (:'ganha')::uuid, 'Área', null, '{}'::text[], 'media', :'ana'::uuid) as lead_ganha \gset
select create_lead(:'ws_um'::uuid, (:'preservado')::uuid, 'Área', null, '{}'::text[], 'media', :'ana'::uuid) as lead_preservado \gset
select create_lead(:'ws_um'::uuid, (:'comdoc')::uuid, 'Área', null, '{}'::text[], 'media', :'ana'::uuid) as lead_comdoc \gset
select create_lead(:'ws_um'::uuid, (:'pendente')::uuid, 'Área', null, '{}'::text[], 'media', :'ana'::uuid) as lead_pendente \gset
select create_lead(:'ws_um'::uuid, (:'falha')::uuid, 'Área', null, '{}'::text[], 'media', :'ana'::uuid) as lead_falha \gset
select create_lead(:'ws_um'::uuid, (:'lote1')::uuid, 'Área', 'resumo lote 1', '{}'::text[], 'media', :'ana'::uuid) as lead_lote1 \gset
select create_lead(:'ws_um'::uuid, (:'lote2')::uuid, 'Área', null, '{}'::text[], 'media', :'ana'::uuid) as lead_lote2 \gset
select create_lead(:'ws_um'::uuid, (:'lote3')::uuid, 'Área', null, '{}'::text[], 'media', :'ana'::uuid) as lead_lote3 \gset
select create_lead(:'ws_um'::uuid, (:'absorvente')::uuid, 'Área', null, '{}'::text[], 'media', :'ana'::uuid) as lead_absorvente \gset
select create_lead(:'ws_um'::uuid, (:'silencioso')::uuid, 'Área', null, '{}'::text[], 'media', :'ana'::uuid) as lead_silencioso \gset
select create_lead(:'ws_um'::uuid, (:'propenv')::uuid, 'Área', null, '{}'::text[], 'media', :'ana'::uuid) as lead_propenv \gset
select create_opportunity((:'lead_alfa')::uuid) as opp_alfa \gset
select create_opportunity((:'lead_beta')::uuid) as opp_beta \gset
select create_opportunity((:'lead_aberta')::uuid) as opp_aberta \gset
select create_opportunity((:'lead_ganha')::uuid) as opp_ganha \gset
select create_opportunity((:'lead_comdoc')::uuid) as opp_comdoc \gset
select create_opportunity((:'lead_propenv')::uuid) as opp_propenv \gset

select pg_temp.login(:'bruno'::uuid);
select (create_contact(:'ws_dois'::uuid, 'pf', 'Contato GAMA', null, null, null)).id as gama \gset
select create_lead(:'ws_dois'::uuid, (:'gama')::uuid, 'Área GAMA', 'Resumo GAMA', '{}'::text[], 'media', :'bruno'::uuid) as lead_gama \gset
reset role;

-- Mescla de verdade fica fora do roteiro: o contato absorvido só precisa apontar para o absorvente.
update public.contacts set merged_into_contact_id = (:'absorvente')::uuid where id = (:'mesclado')::uuid;

-- =====================================================================
-- 1) Marco confiável do prazo (leads.archived_at)
-- =====================================================================

select is(pg_temp.t(format($q$select archived_at::text from public.leads where id = %L$q$, :'lead_alfa')), null, 'lead novo e ativo: sem marco');

update public.leads set status = 'arquivado' where id = (:'lead_alfa')::uuid;
select is(
  pg_temp.t(format($q$select (archived_at = transaction_timestamp())::text from public.leads where id = %L$q$, :'lead_alfa')),
  'true',
  'ao arquivar, o horário é gravado'
);

-- O marco é recuado para uma data antiga (gatilho suspenso só aqui) para distinguir "preservou" de "regravou now()".
select pg_temp.archive_at((:'lead_alfa')::uuid, now() - interval '40 days');
update public.leads set summary = 'INTERNO-resumo-ALFA editado' where id = (:'lead_alfa')::uuid;
select is(
  pg_temp.t(format($q$select (archived_at = now() - interval '40 days')::text from public.leads where id = %L$q$, :'lead_alfa')),
  'true',
  'editar o lead arquivado não mexe no marco (updated_at não é substituto)'
);

-- O marco só vem do gatilho: valor enviado por quem faz o UPDATE é ignorado.
update public.leads set archived_at = now() - interval '5 years' where id = (:'lead_alfa')::uuid;
select is(
  pg_temp.t(format($q$select (archived_at = now() - interval '40 days')::text from public.leads where id = %L$q$, :'lead_alfa')),
  'true',
  'o marco não é editável direto'
);

update public.leads set status = 'ativo' where id = (:'lead_alfa')::uuid;
select is(pg_temp.t(format($q$select archived_at::text from public.leads where id = %L$q$, :'lead_alfa')), null, 'ao reativar, o marco é limpo');

update public.leads set archived_at = now() where id = (:'lead_alfa')::uuid;
select is(pg_temp.t(format($q$select archived_at::text from public.leads where id = %L$q$, :'lead_alfa')), null, 'lead ativo não ganha marco por UPDATE direto');

select is(
  pg_temp.t(format($q$select (archived_at is not null)::text from public.leads where id = %L$q$, :'lead_ativo')),
  'false',
  'lead que nunca foi arquivado continua sem marco'
);

insert into public.leads (workspace_id, contact_id, legal_area, status, created_by)
  values (:'ws_um'::uuid, (:'semlead')::uuid, 'Área', 'arquivado', :'ana'::uuid)
  returning id as lead_ins \gset
select is(
  pg_temp.t(format($q$select (archived_at = transaction_timestamp())::text from public.leads where id = %L$q$, :'lead_ins')),
  'true',
  'lead criado já arquivado também ganha marco'
);
delete from public.leads where id = (:'lead_ins')::uuid;

select throws_ok(
  format($q$ alter table public.leads disable trigger leads_retention_mark;
      insert into public.leads (workspace_id, contact_id, legal_area, status, created_by)
      values (%L, %L, 'Área', 'arquivado', %L) $q$, :'ws_um', :'semlead', :'ana'),
  '23514',
  null,
  'sem o gatilho, arquivado sem marco violaria a constraint de consistência'
);
alter table public.leads enable trigger leads_retention_mark;

-- Marcos usados no resto do roteiro.
select pg_temp.archive_at((:'lead_alfa')::uuid, pg_temp.ago12(interval '-60 days'));
select pg_temp.archive_at((:'lead_alfa2')::uuid, pg_temp.ago12(interval '-1 day'));
select pg_temp.archive_at((:'lead_beta')::uuid, pg_temp.ago12(interval '-90 days'));
select pg_temp.archive_at((:'lead_jovem')::uuid, pg_temp.ago12(interval '1 day'));
select pg_temp.archive_at((:'lead_exato')::uuid, pg_temp.ago12());
select pg_temp.archive_at((:'lead_quase')::uuid, pg_temp.ago12(interval '1 second'));
select pg_temp.archive_at((:'lead_ativo_velho')::uuid, pg_temp.ago12(interval '-200 days'));
select pg_temp.archive_at((:'lead_cliente')::uuid, pg_temp.ago12(interval '-60 days'));
select pg_temp.archive_at((:'lead_aberta')::uuid, pg_temp.ago12(interval '-60 days'));
select pg_temp.archive_at((:'lead_ganha')::uuid, pg_temp.ago12(interval '-60 days'));
select pg_temp.archive_at((:'lead_preservado')::uuid, pg_temp.ago12(interval '-60 days'));
select pg_temp.archive_at((:'lead_comdoc')::uuid, pg_temp.ago12(interval '-60 days'));
select pg_temp.archive_at((:'lead_pendente')::uuid, pg_temp.ago12(interval '-60 days'));
select pg_temp.archive_at((:'lead_falha')::uuid, pg_temp.ago12(interval '-60 days'));
select pg_temp.archive_at((:'lead_lote1')::uuid, pg_temp.ago12(interval '-70 days'));
select pg_temp.archive_at((:'lead_lote2')::uuid, pg_temp.ago12(interval '-70 days'));
select pg_temp.archive_at((:'lead_lote3')::uuid, pg_temp.ago12(interval '-70 days'));
select pg_temp.archive_at((:'lead_absorvente')::uuid, pg_temp.ago12(interval '-70 days'));
select pg_temp.archive_at((:'lead_silencioso')::uuid, pg_temp.ago12(interval '-70 days'));
select pg_temp.archive_at((:'lead_propenv')::uuid, pg_temp.ago12(interval '-70 days'));
select pg_temp.archive_at((:'lead_gama')::uuid, pg_temp.ago12(interval '-70 days'));

-- Oportunidades: ALFA perdida; a aberta e a ganha para os bloqueios.
update public.opportunities
set status = 'lost', lost_reason_id = (select id from public.lost_reasons where workspace_id = (:'ws_um')::uuid order by position limit 1),
    lost_note = 'INTERNO-nota-perda-ALFA'
where id = (:'opp_alfa')::uuid;
update public.opportunities
set status = 'lost', lost_reason_id = (select id from public.lost_reasons where workspace_id = (:'ws_um')::uuid order by position limit 1)
where id in ((:'opp_beta')::uuid, (:'opp_comdoc')::uuid, (:'opp_propenv')::uuid);
update public.opportunities set status = 'won', won_at = now() where id = (:'opp_ganha')::uuid;

-- Cliente, bloqueio por PDF, envio pendente.
insert into public.clients (workspace_id, contact_id, owner_user_id) values (:'ws_um'::uuid, (:'cliente')::uuid, :'ana'::uuid);
insert into public.proposals (workspace_id, lead_id, opportunity_id, number, value_cents, fee_model, created_by, status, sent_at, decided_at)
  values (:'ws_um'::uuid, (:'lead_comdoc')::uuid, (:'opp_comdoc')::uuid, 'PROP-DOC-1', 100000, 'fixed', :'ana'::uuid, 'recusada', now(), now())
  returning id as prop_doc \gset
insert into public.proposals (workspace_id, lead_id, opportunity_id, number, value_cents, fee_model, created_by, status, sent_at)
  values (:'ws_um'::uuid, (:'lead_propenv')::uuid, (:'opp_propenv')::uuid, 'PROP-ENV-1', 100000, 'fixed', :'ana'::uuid, 'enviada', now());
insert into public.proposal_documents (workspace_id, proposal_id, version, storage_path, requested_by, checksum_sha256, byte_size, status, resolved_at)
  values (:'ws_um'::uuid, (:'prop_doc')::uuid, 1, 'caminho/doc.pdf', :'ana'::uuid, decode(repeat('c4', 32), 'hex'), 2048, 'ready', now());

insert into public.whatsapp_channels (workspace_id, label, display_phone_number, created_by, provider, is_simulator, environment, routing_key) values
  (:'ws_um'::uuid, 'Canal teste', '+5541900000000', :'ana'::uuid, 'ycloud', false, 'preview', 'rota-c3b')
  returning id as canal \gset

-- Titular ALFA — contato e identificação.
insert into public.contact_phones (workspace_id, contact_id, value_normalized, source) values
  (:'ws_um'::uuid, (:'alfa')::uuid, '+5541999990001', 'manual');
insert into public.contact_emails (workspace_id, contact_id, value_normalized, source) values
  (:'ws_um'::uuid, (:'alfa')::uuid, 'alfa@exemplo.test', 'manual');
insert into public.contact_identifiers (workspace_id, contact_id, provider, external_id) values
  (:'ws_um'::uuid, (:'alfa')::uuid, 'google', 'ext-alfa-1');
insert into public.contact_sensitive (workspace_id, contact_id, cpf_cnpj_ciphertext, cpf_cnpj_blind_index, key_version) values
  (:'ws_um'::uuid, (:'alfa')::uuid, '\xc1f4c1f4c1f4c1f4c1f4c1f4'::bytea, '\xb11db11db11db11d'::bytea, 'v1');
insert into public.contact_consents (workspace_id, contact_id, channel, legal_basis, purpose, accepted_text, evidence_source) values
  (:'ws_um'::uuid, (:'alfa')::uuid, 'email', 'consentimento', 'Contato ALFA', 'Texto aceito ALFA', 'Fonte ALFA');
insert into public.consent_evidence (workspace_id, contact_id, decision, purpose_code, purpose, legal_basis, channel, decided_at, text_version, text_hash, ip_hmac, evidence) values
  (:'ws_um'::uuid, (:'alfa')::uuid, 'granted', 'formulario_contato', 'Contato ALFA', 'consentimento', 'email', now(), 'v7', decode(repeat('7e', 32), 'hex'), decode(repeat('1b', 32), 'hex'), '{"ua":"EVIDENCIA-BRUTA-ALFA"}');

-- Titular ALFA — processo (textos livres que precisam sumir; valores estruturados que ficam).
insert into public.lead_values (workspace_id, lead_id, estimated_value_cents)
  select workspace_id, id, 123400 from public.leads where id = (:'lead_alfa')::uuid
  on conflict (lead_id) do update set estimated_value_cents = 123400;
insert into public.lead_notes (workspace_id, lead_id, body, created_by) values
  (:'ws_um'::uuid, (:'lead_alfa')::uuid, 'INTERNO-nota-juridica-ALFA', :'ana'::uuid),
  (:'ws_um'::uuid, (:'lead_beta')::uuid, 'Nota BETA', :'ana'::uuid);
insert into public.conflict_checks (workspace_id, lead_id, note) values
  (:'ws_um'::uuid, (:'lead_alfa')::uuid, 'INTERNO-conflito-ALFA'),
  (:'ws_um'::uuid, (:'lead_beta')::uuid, 'Conflito BETA');
insert into public.activities (workspace_id, lead_id, type, title, due_at, created_by, notes) values
  (:'ws_um'::uuid, (:'lead_alfa')::uuid, 'call', 'INTERNO-titulo-atividade-ALFA', now() + interval '1 day', :'ana'::uuid, 'INTERNO-obs-atividade-ALFA'),
  (:'ws_um'::uuid, (:'lead_beta')::uuid, 'call', 'Atividade BETA', now() + interval '1 day', :'ana'::uuid, 'Obs BETA');
select id as stage_alfa from public.pipeline_stages where id = (select stage_id from public.opportunities where id = (:'opp_alfa')::uuid) \gset
insert into public.stage_requirements (workspace_id, stage_id, label, field_type) values
  (:'ws_um'::uuid, (:'stage_alfa')::uuid, 'Requisito ALFA', 'text') returning id as req_alfa \gset
insert into public.opportunity_requirement_values (workspace_id, opportunity_id, requirement_id, value_text) values
  (:'ws_um'::uuid, (:'opp_alfa')::uuid, (:'req_alfa')::uuid, 'INTERNO-valor-requisito-ALFA');
insert into public.stage_transitions (workspace_id, opportunity_id, to_stage_id, actor_user_id) values
  (:'ws_um'::uuid, (:'opp_alfa')::uuid, (:'stage_alfa')::uuid, :'ana'::uuid);
insert into public.proposals (workspace_id, lead_id, opportunity_id, number, value_cents, fee_model, created_by, status, sent_at, decided_at, decision_note) values
  (:'ws_um'::uuid, (:'lead_alfa')::uuid, (:'opp_alfa')::uuid, 'PROP-ALFA-1', 500000, 'fixed', :'ana'::uuid, 'recusada', now(), now(), 'INTERNO-decisao-ALFA');

-- Titular ALFA — WhatsApp (conversa, mensagens, status, fila de saída já concluída).
insert into public.whatsapp_identities (workspace_id, channel_id, provider, environment, phone_e164, bsuid_ciphertext, bsuid_blind_index, bsuid_key_version) values
  (:'ws_um'::uuid, (:'canal')::uuid, 'ycloud', 'preview', '+5541999990001', decode(repeat('b5', 40), 'hex'), decode(repeat('b6', 32), 'hex'), 'v1')
  returning id as ident_alfa \gset
insert into public.whatsapp_identities (workspace_id, channel_id, provider, environment, phone_e164) values
  (:'ws_um'::uuid, (:'canal')::uuid, 'ycloud', 'preview', '+5541999990002')
  returning id as ident_beta \gset
insert into public.whatsapp_identities (workspace_id, channel_id, provider, environment, phone_e164) values
  (:'ws_um'::uuid, (:'canal')::uuid, 'ycloud', 'preview', '+5541999990003')
  returning id as ident_pend \gset
insert into public.conversations (workspace_id, channel_id, identity_id, contact_id, lead_id, link_candidate_contact_ids) values
  (:'ws_um'::uuid, (:'canal')::uuid, (:'ident_alfa')::uuid, (:'alfa')::uuid, (:'lead_alfa')::uuid, array[(:'beta')::uuid])
  returning id as conv_alfa \gset
insert into public.conversations (workspace_id, channel_id, identity_id, contact_id, lead_id) values
  (:'ws_um'::uuid, (:'canal')::uuid, (:'ident_beta')::uuid, (:'beta')::uuid, (:'lead_beta')::uuid)
  returning id as conv_beta \gset
insert into public.conversations (workspace_id, channel_id, identity_id, contact_id, lead_id) values
  (:'ws_um'::uuid, (:'canal')::uuid, (:'ident_pend')::uuid, (:'pendente')::uuid, (:'lead_pendente')::uuid)
  returning id as conv_pend \gset
insert into public.messages (workspace_id, conversation_id, channel_id, direction, status, origin, sender_classification, content_kind, body_text, provider, provider_message_id) values
  (:'ws_um'::uuid, (:'conv_alfa')::uuid, (:'canal')::uuid, 'inbound', 'delivered', 'inbound', 'external', 'text', 'Mensagem ALFA', 'ycloud', 'WAMID-ALFA-PROVEDOR')
  returning id as msg_alfa \gset
insert into public.messages (workspace_id, conversation_id, channel_id, direction, status, origin, sender_classification, content_kind, body_text, provider, provider_message_id) values
  (:'ws_um'::uuid, (:'conv_beta')::uuid, (:'canal')::uuid, 'inbound', 'delivered', 'inbound', 'external', 'text', 'Mensagem BETA', 'ycloud', 'WAMID-BETA')
  returning id as msg_beta \gset
insert into public.messages (workspace_id, conversation_id, channel_id, direction, status, origin, sender_classification, content_kind, body_text, provider, provider_message_id, sent_by, client_dedupe_key, origin_correlation_kind, origin_correlation_ref) values
  (:'ws_um'::uuid, (:'conv_pend')::uuid, (:'canal')::uuid, 'outbound', 'queued', 'crm', 'internal', 'text', 'Saída pendente', 'ycloud', 'WAMID-PEND-1', :'ana'::uuid, gen_random_uuid(), 'crm_outbox', 'pend-1')
  returning id as msg_pend \gset
insert into public.message_status_events (workspace_id, message_id, status, event_wa_timestamp, applied) values
  (:'ws_um'::uuid, (:'msg_alfa')::uuid, 'delivered', now(), true);
insert into public.whatsapp_outbox (environment, workspace_id, channel_id, provider, conversation_id, message_id, client_dedupe_key, kind, state, attempts)
  select 'preview', workspace_id, channel_id, 'ycloud', conversation_id, id, client_dedupe_key, 'text', 'reserved', 0
  from public.messages where id = (:'msg_pend')::uuid;

-- Titular ALFA — atribuição (A11) e continuidade.
insert into public.touchpoints (workspace_id, contact_id, lead_id, opportunity_id, received_at, normalized_occurred_at, occurred_at, channel, position, source, campaign, gclid, fbclid, landing_url, referrer, term, content) values
  (:'ws_um'::uuid, (:'alfa')::uuid, (:'lead_alfa')::uuid, (:'opp_alfa')::uuid, now(), now(), now(), 'formulario', 1, 'google', 'Campanha ALFA', 'gclid-alfa', 'fbclid-alfa', 'https://site.test/?e=alfa', 'https://ref.test/alfa', 'termo alfa', 'conteudo alfa')
  returning id as tp_alfa \gset
insert into public.touchpoint_demand_links (workspace_id, touchpoint_id, opportunity_id, action, reason) values
  (:'ws_um'::uuid, (:'tp_alfa')::uuid, (:'opp_alfa')::uuid, 'assign', 'INTERNO-motivo-vinculo-ALFA');
insert into public.continuity_references (workspace_id, token_hash, contact_id, lead_id, purpose, expires_at) values
  (:'ws_um'::uuid, decode(repeat('70', 32), 'hex'), (:'alfa')::uuid, (:'lead_alfa')::uuid, 'Retomada ALFA', now() + interval '7 days');

-- Sugestão de duplicidade, payload de formulário ainda não expurgado.
insert into public.duplicate_candidates (workspace_id, contact_a_id, contact_b_id, tier, priority, signals) values
  (:'ws_um'::uuid, (:'alfa')::uuid, (:'beta')::uuid, 'review', 1, '[{"sinal":"nome ALFA"}]');
select pipeline_id as pl, id as st from public.pipeline_stages where workspace_id = (:'ws_um')::uuid order by position limit 1 \gset
insert into public.form_endpoints (workspace_id, name, pipeline_id, stage_id, legal_area, initial_activity_type, initial_activity_due_minutes, capture_mode, turnstile_action, allowed_hostnames, created_by)
  values (:'ws_um'::uuid, 'Formulário C3b', (:'pl')::uuid, (:'st')::uuid, 'Área', 'call', 60, 'new_intake', 'c3b', array['site.test'], :'ana'::uuid)
  returning id as ep \gset
insert into public.webhook_events (workspace_id, form_endpoint_id, source_event_id, content_hash, public_protocol, payload_ciphertext, payload_iv, payload_auth_tag, payload_algorithm, payload_key_version, payload_sanitized, normalized_occurred_at, normalization_code, status, processed_at, expires_at, stuck_after, result_contact_id, result_lead_id)
  values (:'ws_um'::uuid, (:'ep')::uuid, gen_random_uuid(), decode(repeat('aa', 32), 'hex'), 'protocolo-c3b-alfa-0001', '\xdeadbeef'::bytea, decode(repeat('01', 12), 'hex'), decode(repeat('02', 16), 'hex'), 'aes-256-gcm', 'v1', '{"nome":"Titular ALFA"}', now(), 'ok', 'processed', now(), now() + interval '30 days', now() + interval '1 hour', (:'alfa')::uuid, (:'lead_alfa')::uuid)
  returning id as wh_alfa \gset

-- Campos personalizados (C4).
set local role authenticated;
select pg_temp.login(:'ana'::uuid);
select create_custom_field(:'ws_um'::uuid, 'contact', 'Campo contato', 'text', 0, null) as d_contato \gset
select create_custom_field(:'ws_um'::uuid, 'lead', 'Campo lead', 'number', 0, null) as d_lead \gset
select create_custom_field(:'ws_um'::uuid, 'opportunity', 'Campo oportunidade', 'date', 0, null) as d_opp \gset
select set_custom_field_values('contact', (:'alfa')::uuid, jsonb_build_array(jsonb_build_object('definition_id', :'d_contato', 'value', 'Texto ALFA')));
select set_custom_field_values('lead', (:'lead_alfa')::uuid, jsonb_build_array(jsonb_build_object('definition_id', :'d_lead', 'value', 42.5)));
select set_custom_field_values('opportunity', (:'opp_alfa')::uuid, jsonb_build_array(jsonb_build_object('definition_id', :'d_opp', 'value', '2026-12-01')));
select set_custom_field_values('contact', (:'beta')::uuid, jsonb_build_array(jsonb_build_object('definition_id', :'d_contato', 'value', 'Texto BETA')));
reset role;

-- Outro contato (BETA): dados que NÃO podem ser tocados pela anonimização do ALFA.
insert into public.contact_phones (workspace_id, contact_id, value_normalized, source) values
  (:'ws_um'::uuid, (:'beta')::uuid, '+5541999990002', 'manual');
insert into public.contact_sensitive (workspace_id, contact_id, cpf_cnpj_ciphertext, cpf_cnpj_blind_index, key_version) values
  (:'ws_um'::uuid, (:'beta')::uuid, '\xbe7abe7abe7abe7a'::bytea, '\xbe7abe7a00000001'::bytea, 'v1');
insert into public.touchpoints (workspace_id, contact_id, lead_id, received_at, normalized_occurred_at, occurred_at, channel, position, source, campaign, gclid) values
  (:'ws_um'::uuid, (:'beta')::uuid, (:'lead_beta')::uuid, now(), now(), now(), 'formulario', 1, 'meta', 'Campanha BETA', 'gclid-beta');

-- Lote: três contatos vencidos com nota de lead; o segundo "falha" por um gatilho de teste.
insert into public.lead_notes (workspace_id, lead_id, body, created_by) values
  (:'ws_um'::uuid, (:'lead_lote1')::uuid, 'nota lote 1', :'ana'::uuid),
  (:'ws_um'::uuid, (:'lead_lote2')::uuid, 'FALHA-ISOLADA nota lote 2', :'ana'::uuid),
  (:'ws_um'::uuid, (:'lead_lote3')::uuid, 'nota lote 3', :'ana'::uuid),
  (:'ws_um'::uuid, (:'lead_falha')::uuid, 'FALHA-ISOLADA nota do rollback', :'ana'::uuid);
insert into public.contact_phones (workspace_id, contact_id, value_normalized, source) values
  (:'ws_um'::uuid, (:'silencioso')::uuid, '+5541999990097', 'manual'),
  (:'ws_um'::uuid, (:'falha')::uuid, '+5541999990099', 'manual'),
  (:'ws_um'::uuid, (:'lote2')::uuid, '+5541999990098', 'manual');

-- Auditoria antiga com o nome (como a A3 gravava): precisa ser esvaziada, não mantida.
select count(*) as audit_nome_antes from public.audit_logs
  where resource_id = (:'alfa')::uuid and action = 'contact.created' and metadata::text like '%Titular ALFA%' \gset

-- =====================================================================
-- 2) Superfície fechada
-- =====================================================================

select ok(
  (select relrowsecurity and relforcerowsecurity from pg_class where oid = 'public.privacy_legal_holds'::regclass),
  'privacy_legal_holds tem RLS habilitada e forçada'
);
select is((select count(*) from pg_policy where polrelid = 'public.privacy_legal_holds'::regclass), 0::bigint, 'nenhuma policy na tabela de preservação');
select ok(
  not has_table_privilege('anon', 'public.privacy_legal_holds', 'select,insert,update,delete,truncate,references,trigger')
  and not has_table_privilege('authenticated', 'public.privacy_legal_holds', 'select,insert,update,delete,truncate,references,trigger'),
  'anon e authenticated não têm privilégio algum na tabela de preservação'
);
select is(
  (select array_agg(p.proname::text order by p.proname) from pg_proc p
   where p.pronamespace = 'public'::regnamespace and p.proname in
     ('get_privacy_retention_status', 'create_privacy_legal_hold', 'release_privacy_legal_hold', 'anonymize_privacy_contact', 'run_privacy_retention_batch')
     and p.prosecdef and exists (select 1 from unnest(p.proconfig) c where c = 'search_path=""')),
  array['anonymize_privacy_contact', 'create_privacy_legal_hold', 'get_privacy_retention_status', 'release_privacy_legal_hold', 'run_privacy_retention_batch'],
  'as cinco RPCs são SECURITY DEFINER com search_path vazio'
);
select is(
  (select count(*) from pg_proc p
   where p.pronamespace = 'public'::regnamespace and p.proname in
     ('get_privacy_retention_status', 'create_privacy_legal_hold', 'release_privacy_legal_hold', 'anonymize_privacy_contact', 'run_privacy_retention_batch')
     and has_function_privilege('service_role', p.oid, 'execute')),
  5::bigint,
  'service_role executa as cinco RPCs'
);
select is(
  (select count(*) from pg_proc p
   where p.pronamespace = 'public'::regnamespace and p.proname in
     ('get_privacy_retention_status', 'create_privacy_legal_hold', 'release_privacy_legal_hold', 'anonymize_privacy_contact', 'run_privacy_retention_batch')
     and (has_function_privilege('authenticated', p.oid, 'execute')
          or has_function_privilege('anon', p.oid, 'execute')
          or has_function_privilege('public', p.oid, 'execute'))),
  0::bigint,
  'authenticated, anon e PUBLIC não executam nenhuma das cinco'
);
select is(
  (select count(*) from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
   where p.pronamespace = 'public'::regnamespace and p.proname in
     ('get_privacy_retention_status', 'create_privacy_legal_hold', 'release_privacy_legal_hold', 'anonymize_privacy_contact', 'run_privacy_retention_batch')
     and a.privilege_type = 'EXECUTE' and a.grantee <> p.proowner
     and a.grantee <> (select oid from pg_roles where rolname = 'service_role')),
  0::bigint,
  'a única concessão de EXECUTE além do dono é a service_role'
);
select is(
  (select count(*) from pg_proc p
   where p.pronamespace = 'private'::regnamespace
     and p.proname in ('privacy_retention_assess', 'privacy_anonymize_contact', 'privacy_lock_subtree', 'privacy_retention_interval', 'privacy_batch_count', 'leads_retention_mark')
     and (has_function_privilege('authenticated', p.oid, 'execute') or has_function_privilege('anon', p.oid, 'execute')
          or has_function_privilege('service_role', p.oid, 'execute'))),
  0::bigint,
  'as funções privadas ficam fechadas até para a service_role'
);

set local role authenticated;
select pg_temp.login(:'ana'::uuid);
select throws_ok(format($q$select get_privacy_retention_status(%L, %L, %L)$q$, :'ana', :'ws_um', :'alfa'), '42501', null, 'authenticated não consulta o estado nem como owner');
select throws_ok(format($q$select anonymize_privacy_contact(%L, %L, %L)$q$, :'ana', :'ws_um', :'alfa'), '42501', null, 'authenticated não anonimiza');
select throws_ok(format($q$select create_privacy_legal_hold(%L, %L, %L, 'other_legal')$q$, :'ana', :'ws_um', :'alfa'), '42501', null, 'authenticated não cria preservação');
select throws_ok($q$select run_privacy_retention_batch(10)$q$, '42501', null, 'authenticated não roda o lote');
reset role;
set local role anon;
select throws_ok($q$select run_privacy_retention_batch(10)$q$, '42501', null, 'anon não roda o lote');
reset role;

-- =====================================================================
-- 3) Quem pode operar e isolamento entre workspaces
-- =====================================================================

set local role service_role;
select is((get_privacy_retention_status((:'ana')::uuid, (:'ws_um')::uuid, (:'alfa')::uuid)) ->> 'eligible', 'true', 'owner consulta a prévia');
select is((get_privacy_retention_status((:'bruno')::uuid, (:'ws_um')::uuid, (:'alfa')::uuid)) ->> 'eligible', 'true', 'admin consulta a prévia');
select throws_ok(format($q$select get_privacy_retention_status(%L, %L, %L)$q$, :'daniel', :'ws_um', :'alfa'), 'P0001', 'insufficient_permission', 'manager é recusado na prévia');
select throws_ok(format($q$select get_privacy_retention_status(%L, %L, %L)$q$, :'carla', :'ws_um', :'alfa'), 'P0001', 'insufficient_permission', 'advogado é recusado na prévia');
select throws_ok(format($q$select get_privacy_retention_status(%L, %L, %L)$q$, :'elisa', :'ws_um', :'alfa'), 'P0001', 'insufficient_permission', 'viewer é recusado na prévia');
select throws_ok(format($q$select anonymize_privacy_contact(%L, %L, %L)$q$, :'daniel', :'ws_um', :'alfa'), 'P0001', 'insufficient_permission', 'manager não anonimiza');
select throws_ok(format($q$select create_privacy_legal_hold(%L, %L, %L, 'other_legal')$q$, :'carla', :'ws_um', :'alfa'), 'P0001', 'insufficient_permission', 'advogado não cria preservação');
select throws_ok(format($q$select get_privacy_retention_status(%L, %L, %L)$q$, :'ana', :'ws_um', :'gama'), 'P0001', 'contact_not_found', 'contato de outro workspace: não encontrado');
select throws_ok(format($q$select get_privacy_retention_status(%L, %L, %L)$q$, :'bruno', :'ws_um', :'gama'), 'P0001', 'contact_not_found', 'admin do Um e owner do Dois, com Um ativo, não vê o contato do Dois');
select throws_ok(format($q$select anonymize_privacy_contact(%L, %L, %L)$q$, :'bruno', :'ws_um', :'gama'), 'P0001', 'contact_not_found', 'e não o anonimiza com o workspace errado ativo');
select throws_ok(format($q$select anonymize_privacy_contact(%L, %L, %L)$q$, :'ana', :'ws_dois', :'gama'), 'P0001', 'contact_not_found', 'quem não participa do workspace recebe "não encontrado"');
select throws_ok(format($q$select get_privacy_retention_status(%L, %L, %L)$q$, :'ana', :'ws_um', :'mesclado'), 'P0001', 'contact_not_found', 'contato mesclado: não encontrado');
select throws_ok(format($q$select get_privacy_retention_status(null, %L, %L)$q$, :'ws_um', :'alfa'), 'P0001', 'authentication_required', 'sem ator: recusado');
reset role;
select is(
  pg_temp.n($q$select count(*) from public.audit_logs where action like 'privacy.anonymization%' or action like 'privacy.legal_hold%'$q$),
  0::bigint,
  'tentativas recusadas (permissão, outro workspace) não deixam auditoria'
);

-- =====================================================================
-- 4) Elegibilidade (prévia): 12 meses completos, bloqueios e prazo
-- =====================================================================

create function pg_temp.reasons(p_contact uuid) returns text language plpgsql as $f$
declare v jsonb;
begin
  set local role service_role;
  v := public.get_privacy_retention_status('20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', p_contact);
  reset role;
  return (select coalesce(string_agg(x, ','), '') from jsonb_array_elements_text(v -> 'reasons') x);
end;
$f$;

select is(pg_temp.reasons((:'alfa')::uuid), '', 'titular vencido: sem bloqueio (elegível)');
select is(pg_temp.reasons((:'exato')::uuid), '', 'exatamente 12 meses completos: elegível');
select is(pg_temp.reasons((:'quase')::uuid), 'retention_period_open', 'um segundo antes dos 12 meses: ainda em retenção');
select is(pg_temp.reasons((:'jovem')::uuid), 'retention_period_open', 'menos de 12 meses: ainda em retenção');
select is(pg_temp.reasons((:'ativo')::uuid), 'active_lead', 'um lead ativo impede (mesmo com outro arquivado há muito tempo)');
select is(pg_temp.reasons((:'semlead')::uuid), 'no_lead', 'contato sem lead não tem prazo de retenção');
select is(pg_temp.reasons((:'cliente')::uuid), 'client_present', 'cliente impede');
select is(pg_temp.reasons((:'aberta')::uuid), 'open_or_won_opportunity', 'oportunidade aberta impede');
select is(pg_temp.reasons((:'ganha')::uuid), 'open_or_won_opportunity', 'oportunidade ganha impede');
select is(pg_temp.reasons((:'comdoc')::uuid), 'proposal_document_present', 'PDF de proposta (armazenamento externo) impede, sem anonimização parcial');
select is(pg_temp.reasons((:'propenv')::uuid), 'open_proposal', 'proposta enviada sem desfecho (processo comercial em andamento) impede');
select is(pg_temp.reasons((:'pendente')::uuid), 'pending_outbound_message', 'mensagem de saída ainda em andamento impede');
select is(pg_temp.reasons((:'absorvente')::uuid), 'merge_history_present', 'contato que absorveu outro (dado pessoal do absorvido) impede');

set local role service_role;
select get_privacy_retention_status((:'ana')::uuid, (:'ws_um')::uuid, (:'alfa')::uuid) as previa \gset
reset role;
select ok(
  :'previa'::jsonb ->> 'state' = 'eligible' and (:'previa'::jsonb ->> 'retention_months')::int = 12
  and :'previa'::jsonb ->> 'retention_due_at' is not null,
  'a prévia traz estado, prazo de 12 meses e data de vencimento'
);
select ok(
  :'previa' !~* 'ALFA|alfa@|Curitiba|\+5541|gclid|INTERNO|Titular',
  'a prévia não devolve conteúdo pessoal'
);

-- =====================================================================
-- 5) Preservação legal
-- =====================================================================

set local role service_role;
select create_privacy_legal_hold((:'ana')::uuid, (:'ws_um')::uuid, (:'preservado')::uuid, 'judicial_process') as hold_a \gset
select ok((:'hold_a') is not null, 'owner cria a preservação');
select is(create_privacy_legal_hold((:'bruno')::uuid, (:'ws_um')::uuid, (:'preservado')::uuid, 'judicial_process'), (:'hold_a')::uuid, 'criar de novo o mesmo motivo ativo é idempotente');
select throws_ok(format($q$select create_privacy_legal_hold(%L, %L, %L, 'texto livre qualquer')$q$, :'ana', :'ws_um', :'preservado'), 'P0001', 'invalid_legal_hold_reason', 'só código fechado: texto livre é recusado');
select throws_ok(format($q$select create_privacy_legal_hold(%L, %L, %L, null)$q$, :'ana', :'ws_um', :'preservado'), 'P0001', 'invalid_legal_hold_reason', 'motivo ausente é recusado');
select throws_ok(format($q$select create_privacy_legal_hold(%L, %L, %L, 'other_legal')$q$, :'ana', :'ws_um', :'gama'), 'P0001', 'contact_not_found', 'preservação de contato de outro workspace: não encontrado');
reset role;
select is(pg_temp.reasons((:'preservado')::uuid), 'legal_hold_active', 'preservação ativa bloqueia');
select is(
  pg_temp.n(format($q$select count(*) from public.audit_logs where action = 'privacy.legal_hold_created' and resource_id = %L and metadata = jsonb_build_object('contact_id', %L::uuid, 'reason_code', 'judicial_process')$q$, :'hold_a', :'preservado')),
  1::bigint,
  'a criação foi auditada uma vez, só com ids e código'
);

set local role service_role;
select throws_ok(format($q$select release_privacy_legal_hold(%L, %L, %L)$q$, :'daniel', :'ws_um', :'hold_a'), 'P0001', 'insufficient_permission', 'manager não encerra preservação');
select throws_ok(format($q$select release_privacy_legal_hold(%L, %L, %L)$q$, :'bruno', :'ws_dois', :'hold_a'), 'P0001', 'legal_hold_not_found', 'preservação de outro workspace: não encontrada');
reset role;

-- A prévia é feita, depois a situação muda: a confirmação reavalia e recusa (nada muda).
set local role service_role;
select is((anonymize_privacy_contact((:'ana')::uuid, (:'ws_um')::uuid, (:'preservado')::uuid)) ->> 'result', 'refused', 'com preservação ativa a anonimização é recusada');
select is((anonymize_privacy_contact((:'ana')::uuid, (:'ws_um')::uuid, (:'preservado')::uuid)) -> 'reasons' ->> 0, 'legal_hold_active', 'e informa o código do bloqueio');
reset role;
select is(pg_temp.t(format($q$select name from public.contacts where id = %L$q$, :'preservado')), 'Preservado', 'o contato preservado ficou intacto');

set local role service_role;
select release_privacy_legal_hold((:'bruno')::uuid, (:'ws_um')::uuid, (:'hold_a')::uuid);
select release_privacy_legal_hold((:'bruno')::uuid, (:'ws_um')::uuid, (:'hold_a')::uuid);
reset role;
select is(pg_temp.reasons((:'preservado')::uuid), '', 'preservação encerrada deixa de bloquear');
select is(
  pg_temp.n(format($q$select count(*) from public.audit_logs where action = 'privacy.legal_hold_released' and resource_id = %L$q$, :'hold_a')),
  1::bigint,
  'encerrar duas vezes audita uma só'
);

-- Nova preservação: o contato que acabou de ser preservado e liberado volta a ser preservável.
set local role service_role;
select create_privacy_legal_hold((:'ana')::uuid, (:'ws_um')::uuid, (:'preservado')::uuid, 'case_in_progress') as hold_b \gset
reset role;
select isnt((:'hold_b')::uuid, (:'hold_a')::uuid, 'depois de encerrada, uma nova preservação é um novo registro');

-- Prévia eligível -> preservação criada -> confirmação recusa (elegibilidade mudou).
set local role service_role;
select is((get_privacy_retention_status((:'ana')::uuid, (:'ws_um')::uuid, (:'exato')::uuid)) ->> 'eligible', 'true', 'prévia do "exato": elegível');
select create_privacy_legal_hold((:'ana')::uuid, (:'ws_um')::uuid, (:'exato')::uuid, 'legal_obligation') as hold_exato \gset
select is((anonymize_privacy_contact((:'ana')::uuid, (:'ws_um')::uuid, (:'exato')::uuid)) ->> 'result', 'refused', 'a elegibilidade mudou entre a prévia e a confirmação: recusada');
reset role;
select is(pg_temp.t(format($q$select name from public.contacts where id = %L$q$, :'exato')), 'Exato 12 meses', 'e o contato ficou intacto');

-- Reativar um lead entre a prévia e a confirmação também recusa.
update public.leads set status = 'ativo' where id = (:'lead_exato')::uuid;
set local role service_role;
select release_privacy_legal_hold((:'ana')::uuid, (:'ws_um')::uuid, (:'hold_exato')::uuid);
select is((anonymize_privacy_contact((:'ana')::uuid, (:'ws_um')::uuid, (:'exato')::uuid)) -> 'reasons' ->> 0, 'active_lead', 'lead reativado: recusada com active_lead');
reset role;
select pg_temp.archive_at((:'lead_exato')::uuid, pg_temp.ago12());

-- =====================================================================
-- 6) Anonimização manual do titular ALFA
-- =====================================================================

select count(*) as aud_antes from public.audit_logs where action like 'privacy.%' \gset

set local role service_role;
select anonymize_privacy_contact((:'ana')::uuid, (:'ws_um')::uuid, (:'alfa')::uuid) as r1 \gset
reset role;
select is(:'r1'::jsonb ->> 'result', 'anonymized', 'owner confirma a anonimização do titular vencido');
select ok(:'r1' !~* 'ALFA|alfa@|Curitiba|\+5541|INTERNO', 'o retorno não carrega conteúdo pessoal');

select is(pg_temp.t(format($q$select name from public.contacts where id = %L$q$, :'alfa')), 'Contato anonimizado', 'o nome foi substituído');
select ok(pg_temp.t(format($q$select (anonymized_at is not null and city is null and uf is null and preferred_channel is null)::text from public.contacts where id = %L$q$, :'alfa')) = 'true', 'cidade, UF e canal removidos; marca de anonimização gravada');
select is(pg_temp.n(format($q$select count(*) from public.contact_phones where contact_id = %L$q$, :'alfa')), 0::bigint, 'telefones removidos');
select is(pg_temp.n(format($q$select count(*) from public.contact_emails where contact_id = %L$q$, :'alfa')), 0::bigint, 'e-mails removidos');
select is(pg_temp.n(format($q$select count(*) from public.contact_identifiers where contact_id = %L$q$, :'alfa')), 0::bigint, 'identificadores removidos');
select is(pg_temp.n(format($q$select count(*) from public.contact_sensitive where contact_id = %L$q$, :'alfa')), 0::bigint, 'CPF/CNPJ (cifrado e índice cego) removido');
select is(pg_temp.n(format($q$select count(*) from public.contact_consents where contact_id = %L and accepted_text is null and evidence_source is null and purpose = 'anonimizado'$q$, :'alfa')), 1::bigint, 'consentimento: estrutura fica, texto e fonte saem');
select is(pg_temp.n(format($q$select count(*) from public.consent_evidence where contact_id = %L and text_hash is null and ip_hmac is null and text_version is null and evidence = '{}'::jsonb and purpose = 'anonimizado'$q$, :'alfa')), 1::bigint, 'evidência de consentimento: hash, HMAC e prova bruta saem');
select is(pg_temp.n(format($q$select count(*) from public.leads where contact_id = %L and summary is null and tags = '{}'::text[]$q$, :'alfa')), 2::bigint, 'resumo e tags dos leads removidos');
select is(pg_temp.n(format($q$select count(*) from public.lead_notes where lead_id in (%L, %L)$q$, :'lead_alfa', :'lead_alfa2')), 0::bigint, 'notas dos leads removidas');
select is(pg_temp.n(format($q$select count(*) from public.conflict_checks where lead_id = %L and note is null$q$, :'lead_alfa')), 1::bigint, 'verificação de conflito: a linha fica, a nota sai');
select is(pg_temp.n(format($q$select count(*) from public.opportunities where id = %L and lost_note is null and status = 'lost'$q$, :'opp_alfa')), 1::bigint, 'oportunidade perdida: a nota de perda sai, o estado fica');
select is(pg_temp.n(format($q$select count(*) from public.opportunity_requirement_values where opportunity_id = %L and value_text is null$q$, :'opp_alfa')), 1::bigint, 'texto de requisito removido');
select is(pg_temp.n(format($q$select count(*) from public.activities where lead_id = %L and title = 'Atividade anonimizada' and notes is null$q$, :'lead_alfa')), 1::bigint, 'atividade: título e observação substituídos');
select is(pg_temp.n(format($q$select count(*) from public.proposals where lead_id = %L and decision_note is null and number = 'PROP-ALFA-1'$q$, :'lead_alfa')), 1::bigint, 'proposta (sem PDF): nota de decisão removida, número e valor ficam');
select is(pg_temp.n(format($q$select count(*) from public.conversations where id = %L$q$, :'conv_alfa')), 0::bigint, 'conversa do WhatsApp removida');
select is(pg_temp.n(format($q$select count(*) from public.messages where id = %L$q$, :'msg_alfa')), 0::bigint, 'mensagens removidas');
select is(pg_temp.n(format($q$select count(*) from public.message_status_events where message_id = %L$q$, :'msg_alfa')), 0::bigint, 'eventos de status das mensagens removidos');
select is(pg_temp.n(format($q$select count(*) from public.whatsapp_identities where id = %L$q$, :'ident_alfa')), 0::bigint, 'identidade do WhatsApp (telefone e BSUID) removida');
select is(pg_temp.n(format($q$select count(*) from public.touchpoints where id = %L and gclid is null and fbclid is null and landing_url is null and referrer is null and term is null and content is null and channel = 'formulario' and campaign = 'Campanha ALFA'$q$, :'tp_alfa')), 1::bigint, 'atribuição: identificadores e URLs saem, canal e campanha (métrica) ficam');
select is(pg_temp.n(format($q$select count(*) from public.touchpoint_demand_links where touchpoint_id = %L and reason is null$q$, :'tp_alfa')), 1::bigint, 'motivo do vínculo de atribuição removido');
select is(pg_temp.n(format($q$select count(*) from public.continuity_references where contact_id = %L$q$, :'alfa')), 0::bigint, 'referências de continuidade removidas');
select is(
  pg_temp.n(format($q$select count(*) from public.custom_field_values where contact_id = %L or lead_id = %L or opportunity_id = %L$q$, :'alfa', :'lead_alfa', :'opp_alfa')),
  0::bigint,
  'campos personalizados (contato, lead, oportunidade) removidos'
);
select is(pg_temp.n(format($q$select count(*) from public.custom_field_definitions where workspace_id = %L$q$, :'ws_um')), 3::bigint, 'as definições dos campos não são tocadas');
select is(pg_temp.n(format($q$select count(*) from public.duplicate_candidates where contact_a_id = %L or contact_b_id = %L$q$, :'alfa', :'alfa')), 0::bigint, 'sugestão de duplicidade removida');
select is(pg_temp.n(format($q$select count(*) from public.webhook_events where id = %L and payload_ciphertext is null and payload_sanitized is null and purged_at is not null and status = 'processed'$q$, :'wh_alfa')), 1::bigint, 'payload de formulário ainda guardado foi expurgado');
select is(
  pg_temp.n(format($q$select count(*) from public.audit_logs where resource_id = %L and action = 'contact.created' and metadata = '{}'::jsonb$q$, :'alfa')),
  :'audit_nome_antes'::bigint,
  'a auditoria antiga que guardava o nome foi esvaziada (a linha fica)'
);

-- Esqueleto preservado (integridade e métricas).
select is(pg_temp.n(format($q$select count(*) from public.leads where contact_id = %L and status = 'arquivado' and archived_at is not null$q$, :'alfa')), 2::bigint, 'esqueleto: leads, estado e marco continuam');
select is(pg_temp.n(format($q$select estimated_value_cents from public.lead_values where lead_id = %L$q$, :'lead_alfa')), 123400::bigint, 'esqueleto: valor estimado (métrica) continua');
select is(pg_temp.n(format($q$select count(*) from public.opportunities where lead_id = %L$q$, :'lead_alfa')), 1::bigint, 'esqueleto: oportunidade continua');
select is(pg_temp.n(format($q$select count(*) from public.stage_transitions where opportunity_id = %L$q$, :'opp_alfa')), 1::bigint, 'esqueleto: histórico de etapas continua');

-- Auditoria do módulo: só ids e códigos.
select is(pg_temp.n(format($q$select count(*) from public.audit_logs where action = 'privacy.anonymization_requested' and resource_id = %L$q$, :'alfa')), 1::bigint, 'auditoria: solicitação registrada');
select is(pg_temp.n(format($q$select count(*) from public.audit_logs where action = 'privacy.anonymization_completed' and metadata ->> 'trigger' = 'manual' and resource_id = %L$q$, :'alfa')), 1::bigint, 'auditoria: conclusão registrada');
select is(
  pg_temp.n(format($q$select count(*) from public.audit_logs where action = 'privacy.anonymization_refused' and resource_id = %L
                      and metadata = jsonb_build_object('contact_id', %L::uuid, 'trigger', 'manual', 'reasons', jsonb_build_array('legal_hold_active'))$q$, :'preservado', :'preservado')),
  2::bigint,
  'auditoria: cada recusa guarda só os códigos fechados do bloqueio'
);
select is(
  pg_temp.n($q$select count(*) from public.audit_logs where action like 'privacy.%'
               and metadata::text ~* 'ALFA|alfa@|Curitiba|Titular|\+55|INTERNO|gclid'$q$),
  0::bigint,
  'nenhuma auditoria de privacidade carrega conteúdo pessoal ou texto livre'
);

-- Idempotência.
select count(*) as aud_depois from public.audit_logs where action like 'privacy.%' \gset
set local role service_role;
select anonymize_privacy_contact((:'bruno')::uuid, (:'ws_um')::uuid, (:'alfa')::uuid) as r2 \gset
reset role;
select is(:'r2'::jsonb ->> 'result', 'already_anonymized', 'repetir a anonimização é idempotente');
select is(
  pg_temp.n($q$select count(*) from public.audit_logs where action like 'privacy.%'$q$),
  (:'aud_depois')::bigint,
  'e não grava auditoria nova'
);
select is(pg_temp.reasons((:'alfa')::uuid), '', 'contato já anonimizado não aparece com bloqueio algum');
set local role service_role;
select is((get_privacy_retention_status((:'ana')::uuid, (:'ws_um')::uuid, (:'alfa')::uuid)) ->> 'state', 'anonymized', 'a prévia informa "anonimizado"');
select throws_ok(format($q$select create_privacy_legal_hold(%L, %L, %L, 'other_legal')$q$, :'ana', :'ws_um', :'alfa'), 'P0001', 'contact_already_anonymized', 'contato anonimizado não recebe preservação');
reset role;

-- O outro contato do mesmo workspace e o de outro workspace seguem intactos.
select is(pg_temp.t(format($q$select name from public.contacts where id = %L$q$, :'beta')), 'Outro BETA', 'BETA: contato intacto');
select is(pg_temp.n(format($q$select count(*) from public.contact_phones where contact_id = %L$q$, :'beta')), 1::bigint, 'BETA: telefone intacto');
select is(pg_temp.n(format($q$select count(*) from public.lead_notes where lead_id = %L$q$, :'lead_beta')), 1::bigint, 'BETA: nota intacta');
select is(pg_temp.n(format($q$select count(*) from public.messages where id = %L$q$, :'msg_beta')), 1::bigint, 'BETA: mensagem intacta');
select is(pg_temp.n(format($q$select count(*) from public.touchpoints where contact_id = %L and gclid = 'gclid-beta'$q$, :'beta')), 1::bigint, 'BETA: atribuição intacta');
select is(pg_temp.n(format($q$select count(*) from public.custom_field_values where contact_id = %L$q$, :'beta')), 1::bigint, 'BETA: campo personalizado intacto');
select is(pg_temp.t(format($q$select name from public.contacts where id = %L$q$, :'gama')), 'Contato GAMA', 'GAMA (outro workspace): intacto');

-- C3a segue exportando normalmente os contatos não anonimizados (e o anonimizado vira esqueleto).
set local role service_role;
select request_privacy_export((:'ana')::uuid, (:'ws_um')::uuid, (:'beta')::uuid) as exp_beta \gset
select get_privacy_export_payload((:'ana')::uuid, (:'ws_um')::uuid, (:'exp_beta')::uuid) as pacote_beta \gset
select request_privacy_export((:'ana')::uuid, (:'ws_um')::uuid, (:'alfa')::uuid) as exp_alfa \gset
select get_privacy_export_payload((:'ana')::uuid, (:'ws_um')::uuid, (:'exp_alfa')::uuid) as pacote_alfa \gset
reset role;
select is(:'pacote_beta'::jsonb #>> '{data,contact,name}', 'Outro BETA', 'C3a: contato não anonimizado exporta normalmente');
select is(jsonb_array_length(:'pacote_beta'::jsonb #> '{data,phones}'), 1, 'C3a: com os telefones');
select ok(:'pacote_alfa' !~* 'alfa@|Curitiba|[+]55419999900|INTERNO|Titular|Texto aceito|gclid-alfa|Mensagem ALFA', 'C3a: o contato anonimizado exporta só o esqueleto, sem dado anterior');

-- =====================================================================
-- 7) Falha no meio da anonimização: rollback completo
-- =====================================================================

create function public.c3b_test_falha() returns trigger language plpgsql as $f$
begin
  if old.body like 'FALHA-ISOLADA%' then
    raise exception 'ERRO-TECNICO-SEGREDO-FALHA';
  end if;
  return old;
end;
$f$;
create trigger c3b_test_falha before delete on public.lead_notes for each row execute function public.c3b_test_falha();

set local role service_role;
select anonymize_privacy_contact((:'ana')::uuid, (:'ws_um')::uuid, (:'falha')::uuid) as r_falha \gset
reset role;
select is(:'r_falha'::jsonb ->> 'result', 'failed', 'falha no meio: resultado "failed"');
select is(:'r_falha'::jsonb ->> 'code', 'internal_error', 'com código fechado');
select ok(:'r_falha' !~* 'SEGREDO|FALHA-ISOLADA', 'e sem a mensagem do erro');
select is(pg_temp.t(format($q$select name from public.contacts where id = %L$q$, :'falha')), 'Falha FALHA', 'rollback: o contato continua como era');
select is(pg_temp.n(format($q$select count(*) from public.contact_phones where contact_id = %L$q$, :'falha')), 1::bigint, 'rollback: o telefone apagado antes da falha voltou');
select is(pg_temp.n(format($q$select count(*) from public.lead_notes where lead_id = %L$q$, :'lead_falha')), 1::bigint, 'rollback: a nota continua');
select is(pg_temp.t(format($q$select anonymized_at::text from public.contacts where id = %L$q$, :'falha')), null, 'rollback: sem marca de anonimização');
select is(
  pg_temp.n(format($q$select count(*) from public.audit_logs where resource_id = %L and action in ('privacy.anonymization_requested', 'privacy.anonymization_failed')$q$, :'falha')),
  2::bigint,
  'a solicitação e a falha ficam auditadas'
);
select is(
  pg_temp.n(format($q$select count(*) from public.audit_logs where resource_id = %L and action = 'privacy.anonymization_failed' and metadata ->> 'result_code' = 'internal_error' and metadata::text !~* 'SEGREDO|FALHA'$q$, :'falha')),
  1::bigint,
  'a auditoria da falha traz só o código fechado'
);

-- Uma exclusão silenciosamente barrada (gatilho que descarta o DELETE) não pode virar "anonimizado":
-- a conferência final desfaz tudo.
create function public.c3b_test_silencio() returns trigger language plpgsql as $f$
begin
  if old.value_normalized = '+5541999990097' then return null; end if;
  return old;
end;
$f$;
create trigger c3b_test_silencio before delete on public.contact_phones for each row execute function public.c3b_test_silencio();

set local role service_role;
select anonymize_privacy_contact((:'ana')::uuid, (:'ws_um')::uuid, (:'silencioso')::uuid) as r_silencio \gset
reset role;
select is(:'r_silencio'::jsonb ->> 'result', 'failed', 'dado previsto ainda acessível: a operação falha em vez de declarar anonimizado');
select is(pg_temp.t(format($q$select name from public.contacts where id = %L$q$, :'silencioso')), 'Silencioso', 'e nada foi alterado (sem anonimização parcial)');
select is(pg_temp.t(format($q$select (anonymized_at is null)::text from public.contacts where id = %L$q$, :'silencioso')), 'true', 'sem marca de anonimização');
drop trigger c3b_test_silencio on public.contact_phones;

-- =====================================================================
-- 8) Lote do sistema
-- =====================================================================

-- Antes do lote: nada anonimizado fora o ALFA. Vencidos e elegíveis: lote1, lote2 (vai falhar), lote3,
-- exato, preservado (liberado) e beta. O "falha" também falha (mesmo gatilho). Bloqueados: cliente etc.
set local role service_role;
select run_privacy_retention_batch(1) as lote_limite \gset
reset role;
select is((:'lote_limite'::jsonb ->> 'processed')::int + (:'lote_limite'::jsonb ->> 'failed')::int, 1, 'o limite do lote é respeitado');

set local role service_role;
select run_privacy_retention_batch(50) as lote \gset
reset role;
select is(
  (select array_agg(k order by k) from jsonb_object_keys(:'lote'::jsonb) k),
  array['blocked', 'failed', 'processed'],
  'o lote devolve só contagens'
);
select is((:'lote'::jsonb ->> 'failed')::int >= 1, true, 'contato que falha é contado como falha');
select is(pg_temp.t(format($q$select (anonymized_at is not null)::text from public.contacts where id = %L$q$, :'lote1')), 'true', 'lote: contato vencido e elegível foi anonimizado');
select is(pg_temp.t(format($q$select (anonymized_at is not null)::text from public.contacts where id = %L$q$, :'lote3')), 'true', 'lote: uma falha isolada no meio não impediu os demais');
select is(pg_temp.t(format($q$select (anonymized_at is not null)::text from public.contacts where id = %L$q$, :'lote2')), 'false', 'lote: o contato que falhou foi desfeito por inteiro');
select is(pg_temp.n(format($q$select count(*) from public.contact_phones where contact_id = %L$q$, :'lote2')), 1::bigint, 'lote: o telefone do que falhou continua');
select is(pg_temp.t(format($q$select (anonymized_at is not null)::text from public.contacts where id = %L$q$, :'exato')), 'true', 'lote: o de exatamente 12 meses entra');
select is(pg_temp.t(format($q$select (anonymized_at is not null)::text from public.contacts where id = %L$q$, :'beta')), 'true', 'lote: o BETA vencido entra (só ele, com os próprios dados)');
select is(pg_temp.t(format($q$select (anonymized_at is not null)::text from public.contacts where id = %L$q$, :'jovem')), 'false', 'lote: contato não vencido permanece intacto');
select is(pg_temp.t(format($q$select name from public.contacts where id = %L$q$, :'quase')), 'Quase 12 meses', 'lote: a um segundo do prazo, intacto');
select is(pg_temp.t(format($q$select name from public.contacts where id = %L$q$, :'cliente')), 'Cliente', 'lote: cliente intacto');
select is(pg_temp.t(format($q$select name from public.contacts where id = %L$q$, :'aberta')), 'Oportunidade aberta', 'lote: oportunidade aberta intacta');
select is(pg_temp.t(format($q$select name from public.contacts where id = %L$q$, :'comdoc')), 'Com PDF', 'lote: contato com PDF intacto');
select is(pg_temp.t(format($q$select name from public.contacts where id = %L$q$, :'ativo')), 'Lead ativo', 'lote: lead ativo intacto');
select is(pg_temp.t(format($q$select (anonymized_at is not null)::text from public.contacts where id = %L$q$, :'gama')), 'true', 'lote do sistema: processa todos os workspaces (o GAMA venceu e foi anonimizado, cada um com os próprios dados)');

-- Preservação ativa nunca entra no lote.
set local role service_role;
select create_privacy_legal_hold((:'ana')::uuid, (:'ws_um')::uuid, (:'lote2')::uuid, 'regulatory_inquiry') as hold_lote2 \gset
reset role;
drop trigger c3b_test_falha on public.lead_notes;
set local role service_role;
select run_privacy_retention_batch(50) as lote_hold \gset
reset role;
select is(pg_temp.t(format($q$select (anonymized_at is not null)::text from public.contacts where id = %L$q$, :'lote2')), 'false', 'preservação ativa: o contato não entra no lote, mesmo sem a falha');
set local role service_role;
select release_privacy_legal_hold((:'ana')::uuid, (:'ws_um')::uuid, (:'hold_lote2')::uuid);
select run_privacy_retention_batch(50) as lote_final \gset
reset role;
select is(pg_temp.t(format($q$select (anonymized_at is not null)::text from public.contacts where id = %L$q$, :'lote2')), 'true', 'encerrada a preservação e sem a falha, o contato entra');

-- Reprocessar não faz nada de novo (idempotência do lote).
set local role service_role;
select run_privacy_retention_batch(50) as lote_vazio \gset
reset role;
select is((:'lote_vazio'::jsonb ->> 'processed')::int, 0, 'reprocessar o lote não anonimiza ninguém de novo');
select is(
  pg_temp.n($q$select count(*) from (select resource_id from public.audit_logs where action = 'privacy.anonymization_completed' group by resource_id having count(*) > 1) d$q$),
  0::bigint,
  'nenhum contato tem duas conclusões de anonimização'
);
select ok(
  pg_temp.n($q$select count(*) from public.audit_logs where action = 'privacy.retention_processed' and actor_user_id is null
               and metadata ?& array['processed', 'blocked', 'failed'] and (select count(*) from jsonb_object_keys(metadata)) = 3$q$) >= 1,
  'o resumo do lote tem só as três contagens'
);
select is(
  pg_temp.n($q$select count(*) from public.audit_logs where action like 'privacy.%'
               and metadata::text ~* 'ALFA|BETA|alfa@|Curitiba|Titular|\+55|INTERNO|FALHA|SEGREDO'$q$),
  0::bigint,
  'nenhuma auditoria (manual ou do lote) guarda conteúdo pessoal, texto livre ou mensagem de erro'
);

select * from finish();
rollback;
