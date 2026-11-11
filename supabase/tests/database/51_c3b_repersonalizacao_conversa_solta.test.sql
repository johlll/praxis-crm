-- pgTAP — C3b (correções da revisão): contato anonimizado é IMUTÁVEL para dados pessoais e
-- conversa de WhatsApp encontrada só pelo telefone bloqueia a anonimização.
--
-- Marcadores: o titular anonimizado leva ALFA e o telefone +5541999991001; os contatos novos levam
-- NOVO. Nenhum telefone ou conteúdo de conversa pode aparecer em retorno, auditoria ou erro.

begin;
select plan(84);

\set ana    '20000000-0000-0000-0000-000000000001'
\set bruno  '20000000-0000-0000-0000-000000000002'
\set ws_um   '10000000-0000-0000-0000-000000000001'
\set ws_dois '10000000-0000-0000-0000-000000000002'

-- ---------------------------------------------------------------------
-- Ajudantes (só desta transação)
-- ---------------------------------------------------------------------

create function pg_temp.login(p_user uuid) returns void language sql as $f$
  select set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true)
$f$;

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

create function pg_temp.archive_at(p_lead uuid, p_at timestamptz) returns void language plpgsql as $f$
begin
  update public.leads set status = 'arquivado' where id = p_lead;
  alter table public.leads disable trigger leads_retention_mark;
  update public.leads set archived_at = p_at where id = p_lead;
  alter table public.leads enable trigger leads_retention_mark;
end;
$f$;

create function pg_temp.ago12(p_shift interval default interval '0') returns timestamptz language sql as $f$
  select ((now() at time zone 'UTC') - interval '12 months' + p_shift) at time zone 'UTC'
$f$;

-- Motivos de bloqueio do contato, como service_role (a prévia do servidor).
create function pg_temp.reasons(p_contact uuid) returns text language plpgsql as $f$
declare v jsonb;
begin
  set local role service_role;
  v := public.get_privacy_retention_status('20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', p_contact);
  reset role;
  return (select coalesce(string_agg(x, ','), '') from jsonb_array_elements_text(v -> 'reasons') x);
end;
$f$;

-- ---------------------------------------------------------------------
-- Dados de apoio
-- ---------------------------------------------------------------------

set local role authenticated;
select pg_temp.login(:'ana'::uuid);
select (create_contact(:'ws_um'::uuid, 'pf', 'Titular ALFA', 'Curitiba ALFA', 'PR', null)).id as alfa \gset
select (create_contact(:'ws_um'::uuid, 'pf', 'Contato NOVO', null, null, null)).id as novo \gset
select (create_contact(:'ws_um'::uuid, 'pf', 'Vinculado', null, null, null)).id as vinc \gset
select (create_contact(:'ws_um'::uuid, 'pf', 'Solto por telefone', null, null, null)).id as solto \gset
select (create_contact(:'ws_um'::uuid, 'pf', 'Solto por identidade', null, null, null)).id as solto2 \gset
select (create_contact(:'ws_um'::uuid, 'pf', 'Solto por identificador', null, null, null)).id as solto3 \gset
select (create_contact(:'ws_um'::uuid, 'pf', 'Corrida', null, null, null)).id as corrida \gset
select (create_contact(:'ws_um'::uuid, 'pf', 'Outro dono da conversa', null, null, null)).id as outro \gset
select create_lead(:'ws_um'::uuid, (:'alfa')::uuid, 'Trabalhista ALFA', 'INTERNO-resumo-ALFA', array['tag-alfa'], 'alta', :'ana'::uuid) as lead_alfa \gset
select create_lead(:'ws_um'::uuid, (:'novo')::uuid, 'Cível NOVO', null, '{}'::text[], 'media', :'ana'::uuid) as lead_novo \gset
select create_lead(:'ws_um'::uuid, (:'vinc')::uuid, 'Área', null, '{}'::text[], 'media', :'ana'::uuid) as lead_vinc \gset
select create_lead(:'ws_um'::uuid, (:'solto')::uuid, 'Área', null, '{}'::text[], 'media', :'ana'::uuid) as lead_solto \gset
select create_lead(:'ws_um'::uuid, (:'solto2')::uuid, 'Área', null, '{}'::text[], 'media', :'ana'::uuid) as lead_solto2 \gset
select create_lead(:'ws_um'::uuid, (:'solto3')::uuid, 'Área', null, '{}'::text[], 'media', :'ana'::uuid) as lead_solto3 \gset
select create_lead(:'ws_um'::uuid, (:'corrida')::uuid, 'Área', null, '{}'::text[], 'media', :'ana'::uuid) as lead_corrida \gset
select create_opportunity((:'lead_alfa')::uuid) as opp_alfa \gset
select create_custom_field(:'ws_um'::uuid, 'contact', 'Campo contato', 'text', 0, null) as d_contato \gset
select create_custom_field(:'ws_um'::uuid, 'lead', 'Campo lead', 'text', 0, null) as d_lead \gset
select pg_temp.login(:'bruno'::uuid);
select (create_contact(:'ws_dois'::uuid, 'pf', 'Contato GAMA', null, null, null)).id as gama \gset
reset role;

select pg_temp.archive_at((:'lead_alfa')::uuid, pg_temp.ago12(interval '-60 days'));
select pg_temp.archive_at((:'lead_vinc')::uuid, pg_temp.ago12(interval '-60 days'));
select pg_temp.archive_at((:'lead_solto')::uuid, pg_temp.ago12(interval '-60 days'));
select pg_temp.archive_at((:'lead_solto2')::uuid, pg_temp.ago12(interval '-60 days'));
select pg_temp.archive_at((:'lead_solto3')::uuid, pg_temp.ago12(interval '-60 days'));
select pg_temp.archive_at((:'lead_corrida')::uuid, pg_temp.ago12(interval '-60 days'));
update public.opportunities
set status = 'lost', lost_reason_id = (select id from public.lost_reasons where workspace_id = (:'ws_um')::uuid order by position limit 1)
where id = (:'opp_alfa')::uuid;

select id as stage_alfa from public.pipeline_stages where id = (select stage_id from public.opportunities where id = (:'opp_alfa')::uuid) \gset
insert into public.stage_requirements (workspace_id, stage_id, label, field_type) values (:'ws_um'::uuid, (:'stage_alfa')::uuid, 'Requisito ALFA', 'text');
insert into public.activities (workspace_id, lead_id, type, title, due_at, created_by, notes) values
  (:'ws_um'::uuid, (:'lead_alfa')::uuid, 'call', 'INTERNO-atividade-ALFA', now() + interval '1 day', :'ana'::uuid, 'obs ALFA');

-- Titular ALFA: dados pessoais que a anonimização remove.
insert into public.contact_phones (workspace_id, contact_id, value_normalized, source) values (:'ws_um'::uuid, (:'alfa')::uuid, '+5541999991001', 'manual');
insert into public.contact_emails (workspace_id, contact_id, value_normalized, source) values (:'ws_um'::uuid, (:'alfa')::uuid, 'alfa@exemplo.test', 'manual');
insert into public.lead_notes (workspace_id, lead_id, body, created_by) values (:'ws_um'::uuid, (:'lead_alfa')::uuid, 'INTERNO-nota-ALFA', :'ana'::uuid);

-- Canal e identidades do WhatsApp.
insert into public.whatsapp_channels (workspace_id, label, display_phone_number, created_by, provider, is_simulator, environment, routing_key) values
  (:'ws_um'::uuid, 'Canal teste', '+5541900000000', :'ana'::uuid, 'ycloud', false, 'preview', 'rota-c3b-51')
  returning id as canal \gset

-- vinc: conversa ligada DIRETAMENTE ao contato (regra normal).
insert into public.contact_phones (workspace_id, contact_id, value_normalized, source) values (:'ws_um'::uuid, (:'vinc')::uuid, '+5541999992001', 'manual');
insert into public.whatsapp_identities (workspace_id, channel_id, provider, environment, phone_e164) values
  (:'ws_um'::uuid, (:'canal')::uuid, 'ycloud', 'preview', '+5541999992001') returning id as id_vinc \gset
insert into public.conversations (workspace_id, channel_id, identity_id, wa_id, contact_id, lead_id) values
  (:'ws_um'::uuid, (:'canal')::uuid, (:'id_vinc')::uuid, '+5541999992001', (:'vinc')::uuid, (:'lead_vinc')::uuid) returning id as conv_vinc \gset
insert into public.messages (workspace_id, conversation_id, channel_id, direction, status, origin, sender_classification, content_kind, body_text, provider, provider_message_id) values
  (:'ws_um'::uuid, (:'conv_vinc')::uuid, (:'canal')::uuid, 'inbound', 'delivered', 'inbound', 'external', 'text', 'Mensagem VINCULADA', 'ycloud', 'WAMID-VINC');

-- solto: o telefone do contato aparece numa conversa SEM vínculo (contato, lead e oportunidade nulos).
insert into public.contact_phones (workspace_id, contact_id, value_normalized, source) values (:'ws_um'::uuid, (:'solto')::uuid, '+5541999993001', 'manual');
insert into public.whatsapp_identities (workspace_id, channel_id, provider, environment, phone_e164) values
  (:'ws_um'::uuid, (:'canal')::uuid, 'ycloud', 'preview', '+5541999993001') returning id as id_solto \gset
insert into public.conversations (workspace_id, channel_id, identity_id, wa_id) values
  (:'ws_um'::uuid, (:'canal')::uuid, (:'id_solto')::uuid, '+5541999993001') returning id as conv_solto \gset
insert into public.messages (workspace_id, conversation_id, channel_id, direction, status, origin, sender_classification, content_kind, body_text, provider, provider_message_id) values
  (:'ws_um'::uuid, (:'conv_solto')::uuid, (:'canal')::uuid, 'inbound', 'delivered', 'inbound', 'external', 'text', 'Mensagem SOLTA SEGREDO', 'ycloud', 'WAMID-SOLTA');

-- solto2: só a IDENTIDADE (telefone) casa; a conversa está ligada a OUTRO contato e sem wa_id.
insert into public.contact_phones (workspace_id, contact_id, value_normalized, source) values (:'ws_um'::uuid, (:'solto2')::uuid, '+5541999994001', 'manual');
insert into public.whatsapp_identities (workspace_id, channel_id, provider, environment, phone_e164) values
  (:'ws_um'::uuid, (:'canal')::uuid, 'ycloud', 'preview', '+5541999994001') returning id as id_solto2 \gset
insert into public.conversations (workspace_id, channel_id, identity_id, contact_id) values
  (:'ws_um'::uuid, (:'canal')::uuid, (:'id_solto2')::uuid, (:'outro')::uuid) returning id as conv_solto2 \gset

-- solto3: nenhum telefone cadastrado, só o identificador normalizado da B3 (whatsapp + número sem "+").
insert into public.contact_identifiers (workspace_id, contact_id, provider, external_id) values (:'ws_um'::uuid, (:'solto3')::uuid, 'whatsapp', '5541999995001');
insert into public.whatsapp_identities (workspace_id, channel_id, provider, environment, phone_e164) values
  (:'ws_um'::uuid, (:'canal')::uuid, 'ycloud', 'preview', '+5541999995001') returning id as id_solto3 \gset
insert into public.conversations (workspace_id, channel_id, identity_id, wa_id) values
  (:'ws_um'::uuid, (:'canal')::uuid, (:'id_solto3')::uuid, '+5541999995001') returning id as conv_solto3 \gset

-- corrida: elegível; um gatilho de teste cria a conversa solta DURANTE a anonimização.
insert into public.contact_phones (workspace_id, contact_id, value_normalized, source) values (:'ws_um'::uuid, (:'corrida')::uuid, '+5541999996001', 'manual');

-- =====================================================================
-- A) Anonimização normal do titular (base dos testes de imutabilidade)
-- =====================================================================

set local role service_role;
select anonymize_privacy_contact((:'ana')::uuid, (:'ws_um')::uuid, (:'alfa')::uuid) as r_alfa \gset
reset role;
select is(:'r_alfa'::jsonb ->> 'result', 'anonymized', 'base: o titular foi anonimizado');
select is(pg_temp.n(format($q$select count(*) from public.contact_phones where contact_id = %L$q$, :'alfa')), 0::bigint, 'base: sem telefones');

-- =====================================================================
-- B) Contato anonimizado é imutável para dados pessoais
-- =====================================================================

set local role authenticated;
select pg_temp.login(:'ana'::uuid);
select throws_ok(format($q$select add_contact_phone(%L, '+5541999999999')$q$, :'alfa'), 'P0001', 'contact_anonymized', '1) novo telefone: recusado');
select throws_ok(format($q$select add_contact_phone(%L, '+5541999991001', true)$q$, :'alfa'), 'P0001', 'contact_anonymized', '1) nem o telefone que ele já teve');
select throws_ok(format($q$select add_contact_email(%L, 'novo@exemplo.test')$q$, :'alfa'), 'P0001', 'contact_anonymized', '2) novo e-mail: recusado');
select throws_ok(format($q$select set_contact_cpf_cnpj(%L, 'AAAA', 'BBBB', 'v1')$q$, :'alfa'), 'P0001', 'contact_anonymized', '2) CPF/CNPJ: recusado');
select throws_ok(format($q$select update_contact_basic_fields(%L, 'Fulano de Tal', 'Curitiba', 'PR', null)$q$, :'alfa'), 'P0001', 'contact_anonymized', '1) editar nome, cidade e UF: recusado');
select throws_ok(format($q$select register_contact_consent(%L, 'email', 'consentimento', 'Contato', null, 'Texto aceito', null)$q$, :'alfa'), 'P0001', 'contact_anonymized', '2) novo consentimento: recusado');
select throws_ok(format($q$select create_lead(%L, %L, 'Cível', 'resumo novo', '{}'::text[], 'media', %L)$q$, :'ws_um', :'alfa', :'ana'), 'P0001', 'contact_anonymized', '3) novo lead para o contato anonimizado: recusado');
select throws_ok(format($q$select create_lead_note(%L, 'nota nova')$q$, :'lead_alfa'), 'P0001', 'contact_anonymized', '3) nota nova no lead preservado: recusada');
select throws_ok(format($q$select create_activity(%L, 'call', 'Ligar para Fulano', current_date + 1)$q$, :'lead_alfa'), 'P0001', 'contact_anonymized', '4) atividade nova no lead preservado: recusada');
select throws_ok(format($q$select set_custom_field_values('contact', %L, jsonb_build_array(jsonb_build_object('definition_id', %L, 'value', 'Fulano')))$q$, :'alfa', :'d_contato'), 'P0001', 'contact_anonymized', '4) campos personalizados do contato anonimizado: recusados');
select throws_ok(format($q$select set_custom_field_values('lead', %L, jsonb_build_array(jsonb_build_object('definition_id', %L, 'value', 'Fulano')))$q$, :'lead_alfa', :'d_lead'), 'P0001', 'contact_anonymized', '4) campos personalizados do lead preservado: recusados');
reset role;

-- Direto no banco (o gatilho é a proteção principal, não a função da aplicação).
select throws_ok(format($q$insert into public.contact_phones (workspace_id, contact_id, value_normalized) values (%L, %L, '+5541999990000')$q$, :'ws_um', :'alfa'), 'P0001', 'contact_anonymized', '1) telefone direto: recusado');
select throws_ok(format($q$insert into public.contact_emails (workspace_id, contact_id, value_normalized) values (%L, %L, 'x@exemplo.test')$q$, :'ws_um', :'alfa'), 'P0001', 'contact_anonymized', '2) e-mail direto: recusado');
select throws_ok(format($q$insert into public.contact_identifiers (workspace_id, contact_id, provider, external_id) values (%L, %L, 'google', 'ext-novo')$q$, :'ws_um', :'alfa'), 'P0001', 'contact_anonymized', '2) identificador direto: recusado');
select throws_ok(format($q$insert into public.contact_sensitive (workspace_id, contact_id, cpf_cnpj_ciphertext, cpf_cnpj_blind_index, key_version) values (%L, %L, '\x01'::bytea, '\x02'::bytea, 'v1')$q$, :'ws_um', :'alfa'), 'P0001', 'contact_anonymized', '2) CPF/CNPJ direto: recusado');
select throws_ok(format($q$insert into public.contact_consents (workspace_id, contact_id, channel, legal_basis, purpose) values (%L, %L, 'email', 'consentimento', 'x')$q$, :'ws_um', :'alfa'), 'P0001', 'contact_anonymized', '2) consentimento direto: recusado');
select throws_ok(format($q$insert into public.consent_evidence (workspace_id, contact_id, decision, purpose_code, purpose, legal_basis, channel, decided_at) values (%L, %L, 'granted', 'formulario_contato', 'x', 'consentimento', 'email', now())$q$, :'ws_um', :'alfa'), 'P0001', 'contact_anonymized', '2) evidência de consentimento direta: recusada');
select throws_ok(format($q$update public.contacts set name = 'Fulano de Tal' where id = %L$q$, :'alfa'), 'P0001', 'contact_anonymized', '1) nome direto: recusado');
select throws_ok(format($q$update public.contacts set city = 'Curitiba', uf = 'PR' where id = %L$q$, :'alfa'), 'P0001', 'contact_anonymized', '1) cidade e UF direto: recusados');
select throws_ok(format($q$update public.contacts set anonymized_at = null where id = %L$q$, :'alfa'), 'P0001', 'contact_anonymized', '1) a marca de anonimização não se desfaz');
select throws_ok(format($q$update public.leads set summary = 'Fulano ligou' where id = %L$q$, :'lead_alfa'), 'P0001', 'contact_anonymized', '3) texto do lead preservado: recusado');
select throws_ok(format($q$update public.leads set tags = array['fulano'] where id = %L$q$, :'lead_alfa'), 'P0001', 'contact_anonymized', '3) tags do lead preservado: recusadas');
select throws_ok(format($q$update public.leads set legal_area = 'Fulano' where id = %L$q$, :'lead_alfa'), 'P0001', 'contact_anonymized', '3) área do lead preservado: recusada');
select throws_ok(format($q$insert into public.leads (workspace_id, contact_id, legal_area, created_by) values (%L, %L, 'Área', %L)$q$, :'ws_um', :'alfa', :'ana'), 'P0001', 'contact_anonymized', '3) lead novo direto: recusado');
select throws_ok(format($q$insert into public.lead_notes (workspace_id, lead_id, body, created_by) values (%L, %L, 'x', %L)$q$, :'ws_um', :'lead_alfa', :'ana'), 'P0001', 'contact_anonymized', '4) nota direta: recusada');
select throws_ok(format($q$insert into public.activities (workspace_id, lead_id, type, title, due_at, created_by) values (%L, %L, 'call', 'Ligar para Fulano', now(), %L)$q$, :'ws_um', :'lead_alfa', :'ana'), 'P0001', 'contact_anonymized', '4) atividade direta: recusada');
select throws_ok(format($q$update public.activities set title = 'Fulano' where lead_id = %L$q$, :'lead_alfa'), 'P0001', 'contact_anonymized', '4) (update de atividade preservada, mesmo sem mudar nada além do texto)');
select throws_ok(format($q$insert into public.opportunities (workspace_id, lead_id, pipeline_id, stage_id, created_by)
  select o.workspace_id, %L, o.pipeline_id, o.stage_id, o.created_by from public.opportunities o where o.id = %L$q$, :'lead_alfa', :'opp_alfa'), 'P0001', 'contact_anonymized', '4) oportunidade nova direta: recusada');
select throws_ok(format($q$update public.opportunities set status = 'lost', lost_note = 'Fulano desistiu' where id = %L$q$, :'opp_alfa'), 'P0001', 'contact_anonymized', '4) nota de perda: recusada');
select throws_ok(format($q$insert into public.opportunity_requirement_values (workspace_id, opportunity_id, requirement_id, value_text)
  select %L, %L, id, 'Fulano' from public.stage_requirements where workspace_id = %L limit 1$q$, :'ws_um', :'opp_alfa', :'ws_um'), 'P0001', 'contact_anonymized', '4) requisito direto: recusado');
select throws_ok(format($q$insert into public.conflict_checks (workspace_id, lead_id, note) values (%L, %L, 'Fulano')$q$, :'ws_um', :'lead_alfa'), 'P0001', 'contact_anonymized', '4) verificação de conflito nova: recusada');
select throws_ok(format($q$insert into public.proposals (workspace_id, lead_id, opportunity_id, number, value_cents, fee_model, created_by) values (%L, %L, %L, 'PROP-NOVA', 1, 'fixed', %L)$q$, :'ws_um', :'lead_alfa', :'opp_alfa', :'ana'), 'P0001', 'contact_anonymized', '4) proposta nova: recusada');
select throws_ok(format($q$insert into public.clients (workspace_id, contact_id, owner_user_id) values (%L, %L, %L)$q$, :'ws_um', :'alfa', :'ana'), 'P0001', 'contact_anonymized', '4) cliente novo para o contato anonimizado: recusado');
select throws_ok(format($q$insert into public.touchpoints (workspace_id, contact_id, received_at, normalized_occurred_at, channel, position) values (%L, %L, now(), now(), 'formulario', 1)$q$, :'ws_um', :'alfa'), 'P0001', 'contact_anonymized', '4) atribuição nova: recusada');
select throws_ok(format($q$insert into public.continuity_references (workspace_id, token_hash, contact_id, lead_id, purpose, expires_at) values (%L, decode(repeat('71', 32), 'hex'), %L, %L, 'x', now() + interval '1 day')$q$, :'ws_um', :'alfa', :'lead_alfa'), 'P0001', 'contact_anonymized', '4) continuidade nova: recusada');
select throws_ok(format($q$insert into public.whatsapp_identities (workspace_id, channel_id, provider, environment, phone_e164) values (%L, %L, 'ycloud', 'preview', '+5541999997001')$q$, :'ws_um', :'canal') || ';' || format($q$insert into public.conversations (workspace_id, channel_id, identity_id, wa_id, contact_id) select %L, %L, id, '+5541999997001', %L from public.whatsapp_identities where phone_e164 = '+5541999997001'$q$, :'ws_um', :'canal', :'alfa'), 'P0001', 'contact_anonymized', '4) conversa ligada ao contato anonimizado: recusada');
select throws_ok(format($q$insert into public.conversations (workspace_id, channel_id, identity_id, wa_id, lead_id, contact_id) select %L, %L, id, '+5541999997002', %L, %L from (select id from public.whatsapp_identities where phone_e164 = '+5541999993001') x$q$, :'ws_um', :'canal', :'lead_alfa', :'alfa'), 'P0001', null, '4) conversa ligada ao lead preservado: recusada');

-- Mesclagem: o anonimizado não participa, em nenhum dos lados.
set local role authenticated;
select pg_temp.login(:'ana'::uuid);
select throws_ok(format($q$select merge_contacts(%L, %L)$q$, :'novo', :'alfa'), 'P0001', 'contact_anonymized', '5) anonimizado como absorvido: recusado');
select throws_ok(format($q$select merge_contacts(%L, %L)$q$, :'alfa', :'novo'), 'P0001', 'contact_anonymized', '5) anonimizado como absorvente: recusado');
reset role;
select throws_ok(format($q$update public.contacts set merged_into_contact_id = %L where id = %L$q$, :'alfa', :'novo'), 'P0001', 'contact_anonymized', '5) apontar outro contato para o anonimizado: recusado');
select throws_ok(format($q$insert into public.contact_merges (workspace_id, kept_contact_id, merged_contact_id, merged_by) values (%L, %L, %L, %L)$q$, :'ws_um', :'alfa', :'novo', :'ana'), 'P0001', 'contact_anonymized', '5) registro de mesclagem com o anonimizado: recusado');

-- Outro workspace continua como "não encontrado" (nunca revela o anonimizado).
set local role authenticated;
select pg_temp.login(:'bruno'::uuid);
select throws_ok(format($q$select add_contact_phone(%L, '+5541999999999')$q$, :'alfa'), 'P0001', 'insufficient_permission', '6) outro workspace tentando telefone: a mesma resposta de um contato comum (nunca "anonimizado")');
select throws_ok(format($q$select add_contact_phone(%L, '+5541999999999')$q$, :'novo'), 'P0001', 'insufficient_permission', '6) e a resposta para um contato comum é idêntica');
select throws_ok(format($q$select update_contact_basic_fields(%L, 'Fulano', null, null, null)$q$, :'alfa'), 'P0001', 'insufficient_permission', '6) outro workspace tentando editar: idem, sem revelar o anonimizado');
select throws_ok(format($q$select merge_contacts(%L, %L)$q$, :'gama', :'alfa'), 'P0001', null, '6) outro workspace tentando mesclar: recusado sem revelar o registro');
reset role;

-- O que NÃO reidentifica segue permitido: atualização técnica e o contato novo.
select lives_ok(format($q$update public.contacts set updated_at = now() where id = %L$q$, :'alfa'), 'atualização técnica sem dado pessoal segue permitida');
set local role authenticated;
select pg_temp.login(:'ana'::uuid);
select lives_ok(format($q$select add_contact_phone(%L, '+5541999991001', true)$q$, :'novo'), '7) contato novo aceita até o telefone que o anonimizado teve');
select lives_ok(format($q$select add_contact_email(%L, 'novo@exemplo.test')$q$, :'novo'), '7) contato novo aceita e-mail');
select lives_ok(format($q$select update_contact_basic_fields(%L, 'Contato NOVO editado', 'Londrina', 'PR', null)$q$, :'novo'), '7) contato novo aceita edição');
select lives_ok(format($q$select create_lead_note(%L, 'nota nova do contato novo')$q$, :'lead_novo'), '7) contato novo aceita nota de lead');
select lives_ok(format($q$select create_activity(%L, 'call', 'Ligar para o contato novo', current_date + 1)$q$, :'lead_novo'), '7) contato novo aceita atividade');
select lives_ok(format($q$select create_lead(%L, %L, 'Previdenciário', 'resumo', '{}'::text[], 'media', %L)$q$, :'ws_um', :'novo', :'ana'), '7) contato novo aceita lead novo');
select lives_ok(format($q$select register_contact_consent(%L, 'email', 'consentimento', 'Contato', null, 'Texto', null)$q$, :'novo'), '7) contato novo aceita consentimento');
reset role;
select is(pg_temp.n(format($q$select count(*) from public.contact_phones where contact_id = %L$q$, :'novo')), 1::bigint, '7) o telefone do contato novo está só nele');
select throws_ok(format($q$update public.contact_phones set contact_id = %L where contact_id = %L$q$, :'alfa', :'novo'), 'P0001', 'contact_anonymized', '1) reapontar um telefone existente para o anonimizado: recusado');
select is(pg_temp.t(format($q$select name from public.contacts where id = %L$q$, :'alfa')), 'Contato anonimizado', 'o anonimizado continua anonimizado');

-- =====================================================================
-- C) Conversa de WhatsApp localizada só pelo telefone
-- =====================================================================

-- 8) Ligada diretamente: regra normal (some junto, sem bloqueio).
select is(pg_temp.reasons((:'vinc')::uuid), '', '8) conversa ligada diretamente ao contato: sem bloqueio');
set local role service_role;
select anonymize_privacy_contact((:'ana')::uuid, (:'ws_um')::uuid, (:'vinc')::uuid) as r_vinc \gset
reset role;
select is(:'r_vinc'::jsonb ->> 'result', 'anonymized', '8) e é anonimizado como antes');
select is(pg_temp.n(format($q$select count(*) from public.conversations where id = %L$q$, :'conv_vinc')), 0::bigint, '8) a conversa ligada foi removida');
select is(pg_temp.n(format($q$select count(*) from public.messages where conversation_id = %L$q$, :'conv_vinc')), 0::bigint, '8) e as mensagens dela');

-- 9) Só pelo telefone: bloqueia com o código novo, sem apagar nada por inferência.
select is(pg_temp.reasons((:'solto')::uuid), 'unlinked_whatsapp_conversation', '9) conversa só pelo telefone (wa_id): bloqueia');
select is(pg_temp.reasons((:'solto2')::uuid), 'unlinked_whatsapp_conversation', '9) identidade só pelo telefone, conversa de outro contato: bloqueia');
select is(pg_temp.reasons((:'solto3')::uuid), 'unlinked_whatsapp_conversation', '9) identificador normalizado da B3 (whatsapp): bloqueia');
set local role service_role;
select anonymize_privacy_contact((:'ana')::uuid, (:'ws_um')::uuid, (:'solto')::uuid) as r_solto \gset
reset role;
select is(:'r_solto'::jsonb ->> 'result', 'refused', '9) a anonimização é recusada');
select is(:'r_solto'::jsonb -> 'reasons' ->> 0, 'unlinked_whatsapp_conversation', '9) com o código fechado');
select is(pg_temp.t(format($q$select name from public.contacts where id = %L$q$, :'solto')), 'Solto por telefone', '9) o contato ficou intacto');
select is(pg_temp.n(format($q$select count(*) from public.contact_phones where contact_id = %L$q$, :'solto')), 1::bigint, '9) o telefone continua');
select is(pg_temp.n(format($q$select count(*) from public.conversations where id = %L$q$, :'conv_solto')), 1::bigint, '9) a conversa solta NÃO foi apagada por inferência');
select is(pg_temp.n(format($q$select count(*) from public.messages where conversation_id = %L$q$, :'conv_solto')), 1::bigint, '9) nem as mensagens dela');
select is(pg_temp.n(format($q$select count(*) from public.whatsapp_identities where id = %L$q$, :'id_solto')), 1::bigint, '9) nem a identidade');
select is(pg_temp.n(format($q$select count(*) from public.conversations where id = %L$q$, :'conv_solto2')), 1::bigint, '9) a conversa do outro contato também ficou');

-- 11) Nada de telefone ou conteúdo no retorno, na auditoria ou no erro.
select ok(:'r_solto' !~* '[+]5541|SEGREDO|5541999993001', '11) o retorno da recusa não carrega telefone nem conteúdo');
select is(
  pg_temp.n(format($q$select count(*) from public.audit_logs where resource_id = %L and metadata::text ~* '[+]5541|5541999|SEGREDO'$q$, :'solto')),
  0::bigint,
  '11) a auditoria da recusa não carrega telefone nem conteúdo'
);

-- 10) Depois de vinculada corretamente, segue a regra normal.
update public.conversations set contact_id = (:'solto')::uuid, lead_id = (:'lead_solto')::uuid where id = (:'conv_solto')::uuid;
select is(pg_temp.reasons((:'solto')::uuid), '', '10) vinculada ao contato: o bloqueio some');
set local role service_role;
select anonymize_privacy_contact((:'ana')::uuid, (:'ws_um')::uuid, (:'solto')::uuid) as r_solto2 \gset
reset role;
select is(:'r_solto2'::jsonb ->> 'result', 'anonymized', '10) e a anonimização segue a regra normal');
select is(pg_temp.n(format($q$select count(*) from public.conversations where id = %L$q$, :'conv_solto')), 0::bigint, '10) agora a conversa vinculada é tratada');
select is(pg_temp.n(format($q$select count(*) from public.whatsapp_identities where id = %L$q$, :'id_solto')), 0::bigint, '10) e a identidade também');

-- A verificação se repete sob as travas e a conferência final guarda os telefones originais:
-- uma conversa solta que apareça DURANTE a execução desfaz tudo.
create function public.c3b_test_corrida() returns trigger language plpgsql as $f$
begin
  if old.value_normalized = '+5541999996001' then
    insert into public.whatsapp_identities (workspace_id, channel_id, provider, environment, phone_e164)
      values (old.workspace_id, (select id from public.whatsapp_channels limit 1), 'ycloud', 'preview', old.value_normalized);
    insert into public.conversations (workspace_id, channel_id, identity_id, wa_id)
      select old.workspace_id, i.channel_id, i.id, i.phone_e164 from public.whatsapp_identities i where i.phone_e164 = old.value_normalized;
  end if;
  return old;
end;
$f$;
create trigger c3b_test_corrida before delete on public.contact_phones for each row execute function public.c3b_test_corrida();

set local role service_role;
select anonymize_privacy_contact((:'ana')::uuid, (:'ws_um')::uuid, (:'corrida')::uuid) as r_corrida \gset
reset role;
drop trigger c3b_test_corrida on public.contact_phones;
select is(:'r_corrida'::jsonb ->> 'result', 'failed', '9) conversa solta que surge durante a execução: a operação falha em vez de declarar anonimizado');
select is(pg_temp.t(format($q$select name from public.contacts where id = %L$q$, :'corrida')), 'Corrida', '9) e nada foi alterado (rollback completo)');
select is(pg_temp.n(format($q$select count(*) from public.contact_phones where contact_id = %L$q$, :'corrida')), 1::bigint, '9) o telefone original continua');
select ok(:'r_corrida' !~* '[+]5541|5541999', '11) a falha não devolve telefone');
select is(
  pg_temp.n(format($q$select count(*) from public.audit_logs where resource_id = %L and metadata::text ~* '[+]5541|5541999'$q$, :'corrida')),
  0::bigint,
  '11) a auditoria da falha não carrega telefone'
);

select * from finish();
rollback;
