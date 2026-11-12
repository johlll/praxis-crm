-- pgTAP — C3b (última correção da revisão): depois de contacts.anonymized_at o ESQUELETO é imutável.
--
-- Nenhum INSERT nem UPDATE chega ao contato anonimizado nem aos registros ligados a ele (lead,
-- oportunidade, atividade, proposta, verificação de conflito, requisitos, notas, campos
-- personalizados, conversas, atribuição, consentimentos, histórico). Só DELETE segue permitido.
-- Novo atendimento exige contato novo. O erro é sempre o código fechado `contact_anonymized`,
-- sem detalhe, dica nem dado do titular. Quem é de outro workspace recebe a mesma resposta que
-- receberia para qualquer registro comum.
--
-- Marcador do titular: ALFA. Contato novo: NOVO.

begin;
select plan(80);

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

-- Mensagem, detalhe e dica do erro (ou 'sem erro'), para provar que nada vaza.
create function pg_temp.err(p_sql text) returns text language plpgsql as $f$
declare m text; d text; h text;
begin
  execute p_sql;
  return 'sem erro';
exception when others then
  get stacked diagnostics m = message_text, d = pg_exception_detail, h = pg_exception_hint;
  return coalesce(m, '') || '|' || coalesce(d, '') || '|' || coalesce(h, '');
end;
$f$;

create function pg_temp.lead_ts(p_lead uuid) returns timestamptz language sql security definer as $f$
  select updated_at from public.leads where id = p_lead
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

-- ---------------------------------------------------------------------
-- Dados de apoio
-- ---------------------------------------------------------------------

set local role authenticated;
select pg_temp.login(:'ana'::uuid);
select (create_contact(:'ws_um'::uuid, 'pf', 'Titular ALFA', 'Curitiba ALFA', 'PR', null)).id as alfa \gset
select (create_contact(:'ws_um'::uuid, 'pf', 'Contato NOVO', null, null, null)).id as novo \gset
select create_lead(:'ws_um'::uuid, (:'alfa')::uuid, 'Trabalhista ALFA', 'INTERNO-resumo-ALFA', array['tag-alfa'], 'alta', :'ana'::uuid) as lead_alfa \gset
select create_lead(:'ws_um'::uuid, (:'novo')::uuid, 'Cível NOVO', null, '{}'::text[], 'media', :'ana'::uuid) as lead_novo \gset
select create_opportunity((:'lead_alfa')::uuid) as opp_alfa \gset
select create_opportunity((:'lead_novo')::uuid) as opp_novo \gset
select create_proposal((:'opp_alfa')::uuid, 500000, 'fixed') as prop_alfa \gset
select create_proposal((:'opp_novo')::uuid, 300000, 'fixed') as prop_novo \gset
select pg_temp.login(:'bruno'::uuid);
select (create_contact(:'ws_dois'::uuid, 'pf', 'Contato GAMA', null, null, null)).id as gama \gset
reset role;

select pg_temp.archive_at((:'lead_alfa')::uuid, pg_temp.ago12(interval '-60 days'));
update public.opportunities
set status = 'lost', lost_reason_id = (select id from public.lost_reasons where workspace_id = (:'ws_um')::uuid order by position limit 1)
where id = (:'opp_alfa')::uuid;

select stage_id as stage_alfa, pipeline_id as pipe_alfa from public.opportunities where id = (:'opp_alfa')::uuid \gset
select id as stage_outra from public.pipeline_stages where pipeline_id = (:'pipe_alfa')::uuid and id <> (:'stage_alfa')::uuid order by position limit 1 \gset
insert into public.stage_requirements (workspace_id, stage_id, label, field_type) values (:'ws_um'::uuid, (:'stage_alfa')::uuid, 'Requisito ALFA', 'text')
  returning id as req_alfa \gset
insert into public.opportunity_requirement_values (workspace_id, opportunity_id, requirement_id, value_text) values
  (:'ws_um'::uuid, (:'opp_alfa')::uuid, (:'req_alfa')::uuid, 'valor ALFA');
insert into public.activities (workspace_id, lead_id, opportunity_id, type, title, due_at, created_by, notes) values
  (:'ws_um'::uuid, (:'lead_alfa')::uuid, (:'opp_alfa')::uuid, 'call', 'INTERNO-atividade-ALFA', now() + interval '1 day', :'ana'::uuid, 'obs ALFA')
  returning id as act_alfa \gset
insert into public.activities (workspace_id, lead_id, opportunity_id, type, title, due_at, created_by) values
  (:'ws_um'::uuid, (:'lead_novo')::uuid, (:'opp_novo')::uuid, 'call', 'Ligar para o contato novo', now() + interval '1 day', :'ana'::uuid)
  returning id as act_novo \gset
insert into public.contact_phones (workspace_id, contact_id, value_normalized, source) values (:'ws_um'::uuid, (:'alfa')::uuid, '+5541999991001', 'manual');
insert into public.conflict_checks (workspace_id, lead_id, note) values (:'ws_um'::uuid, (:'lead_alfa')::uuid, 'nota de conflito ALFA')
  on conflict do nothing;
insert into public.contact_consents (workspace_id, contact_id, channel, legal_basis, purpose, accepted_text) values
  (:'ws_um'::uuid, (:'alfa')::uuid, 'email', 'consentimento', 'Contato ALFA', 'Texto aceito ALFA')
  returning id as consent_alfa \gset
insert into public.lead_values (workspace_id, lead_id, estimated_value_cents) values (:'ws_um'::uuid, (:'lead_alfa')::uuid, 123400)
  on conflict (lead_id) do update set estimated_value_cents = excluded.estimated_value_cents;
insert into public.touchpoints (workspace_id, contact_id, lead_id, opportunity_id, received_at, normalized_occurred_at, occurred_at, channel, position, source, campaign) values
  (:'ws_um'::uuid, (:'alfa')::uuid, (:'lead_alfa')::uuid, (:'opp_alfa')::uuid, now(), now(), now(), 'formulario', 1, 'google', 'Campanha ALFA')
  returning id as tp_alfa \gset
insert into public.touchpoint_demand_links (workspace_id, touchpoint_id, opportunity_id, action) values
  (:'ws_um'::uuid, (:'tp_alfa')::uuid, (:'opp_alfa')::uuid, 'assign');
insert into public.touchpoints (workspace_id, contact_id, received_at, normalized_occurred_at, occurred_at, channel, position, source) values
  (:'ws_um'::uuid, (:'novo')::uuid, now(), now(), now(), 'formulario', 1, 'google')
  returning id as tp_novo \gset

-- =====================================================================
-- A) A anonimização original continua concluindo (limpa ANTES de pôr a marca)
-- =====================================================================

set local role service_role;
select anonymize_privacy_contact((:'ana')::uuid, (:'ws_um')::uuid, (:'alfa')::uuid) as r_alfa \gset
reset role;
select is(:'r_alfa'::jsonb ->> 'result', 'anonymized', '8) a anonimização original conclui normalmente');
set local role service_role;
select anonymize_privacy_contact((:'ana')::uuid, (:'ws_um')::uuid, (:'alfa')::uuid) as r_alfa2 \gset
reset role;
select is(:'r_alfa2'::jsonb ->> 'result', 'already_anonymized', '8) repetir devolve already_anonymized (sem tentar escrever no contato)');

select updated_at as lead_ts from public.leads where id = (:'lead_alfa')::uuid \gset
select count(*) as audit_antes from public.audit_logs
where resource_id in ((:'lead_alfa')::uuid, (:'opp_alfa')::uuid, (:'act_alfa')::uuid, (:'prop_alfa')::uuid) \gset

-- =====================================================================
-- B) 1 e 2 — o lead anonimizado não é reativado nem editado
-- =====================================================================

set local role authenticated;
select pg_temp.login(:'ana'::uuid);
select throws_ok(format($q$select set_lead_status(%L, 'ativo', %L)$q$, :'lead_alfa', :'lead_ts'), 'P0001', 'contact_anonymized', '1) o lead arquivado NÃO volta a ativo (função da aplicação)');
select throws_ok(format($q$select assign_lead(%L, null, %L)$q$, :'lead_alfa', :'lead_ts'), 'P0001', 'contact_anonymized', '2) responsável do lead: recusado (função da aplicação)');
select throws_ok(format($q$select update_lead_basic_fields(%L, 'Trabalhista', null, '{}'::text[], 'baixa', %L)$q$, :'lead_alfa', :'lead_ts'), 'P0001', 'contact_anonymized', '2) prioridade do lead: recusada (função da aplicação)');
reset role;

select throws_ok(format($q$update public.leads set status = 'ativo' where id = %L$q$, :'lead_alfa'), 'P0001', 'contact_anonymized', '1) reativar direto no banco: recusado');
select throws_ok(format($q$update public.leads set assigned_to = null where id = %L$q$, :'lead_alfa'), 'P0001', 'contact_anonymized', '2) trocar responsável direto: recusado');
select throws_ok(format($q$update public.leads set priority = 'baixa' where id = %L$q$, :'lead_alfa'), 'P0001', 'contact_anonymized', '2) trocar prioridade direto: recusado');
select throws_ok(format($q$update public.leads set legal_area = 'Cível' where id = %L$q$, :'lead_alfa'), 'P0001', 'contact_anonymized', '2) trocar área direto: recusado');
select throws_ok(format($q$update public.leads set updated_at = now() + interval '1 day' where id = %L$q$, :'lead_alfa'), 'P0001', 'contact_anonymized', '2) nem um UPDATE "técnico" no lead preservado');
select throws_ok(format($q$update public.leads set archived_at = null where id = %L$q$, :'lead_alfa'), 'P0001', 'contact_anonymized', '1) o marco de arquivamento não se limpa');
select is(pg_temp.t(format($q$select status::text from public.leads where id = %L$q$, :'lead_alfa')), 'arquivado', '1) o lead continua arquivado');
select is(pg_temp.n(format($q$select count(*) from public.leads where id = %L and archived_at is not null$q$, :'lead_alfa')), 1::bigint, '1) e com o marco de arquivamento');

-- =====================================================================
-- C) 3 — oportunidade
-- =====================================================================

select throws_ok(format($q$update public.opportunities set status = 'open', lost_reason_id = null where id = %L$q$, :'opp_alfa'), 'P0001', 'contact_anonymized', '3) reabrir a oportunidade: recusado');
select throws_ok(format($q$update public.opportunities set stage_id = %L where id = %L$q$, :'stage_outra', :'opp_alfa'), 'P0001', 'contact_anonymized', '3) mover de etapa: recusado');
select throws_ok(format($q$update public.opportunities set status = 'won' where id = %L$q$, :'opp_alfa'), 'P0001', 'contact_anonymized', '3) ganhar: recusado');
select throws_ok(format($q$update public.opportunities set value_cents = 99900 where id = %L$q$, :'opp_alfa'), 'P0001', 'contact_anonymized', '3) valor da oportunidade: recusado');
select throws_ok(format($q$update public.opportunities set lock_version = lock_version + 1 where id = %L$q$, :'opp_alfa'), 'P0001', 'contact_anonymized', '3) nem a versão da oportunidade muda');
select throws_ok(format($q$insert into public.stage_transitions (workspace_id, opportunity_id, to_stage_id, actor_user_id) values (%L, %L, %L, %L)$q$, :'ws_um', :'opp_alfa', :'stage_outra', :'ana'), 'P0001', 'contact_anonymized', '3) novo registro de histórico de etapa: recusado');
select throws_ok(format($q$update public.opportunity_requirement_values set value_text = 'novo' where opportunity_id = %L$q$, :'opp_alfa'), 'P0001', 'contact_anonymized', '3) requisito da oportunidade: recusado');
select is(pg_temp.t(format($q$select status::text from public.opportunities where id = %L$q$, :'opp_alfa')), 'lost', '3) a oportunidade continua perdida');

-- =====================================================================
-- D) 4 — atividade
-- =====================================================================

set local role authenticated;
select pg_temp.login(:'ana'::uuid);
select throws_ok(format($q$select complete_activity(%L, 0)$q$, :'act_alfa'), 'P0001', 'contact_anonymized', '4) concluir a atividade: recusado (função da aplicação)');
select throws_ok(format($q$select reassign_activity(%L, 0, %L)$q$, :'act_alfa', :'ana'), 'P0001', 'contact_anonymized', '4) reatribuir a atividade: recusado (função da aplicação)');
select throws_ok(format($q$select reschedule_activity(%L, 0, current_date + 5, null)$q$, :'act_alfa'), 'P0001', 'contact_anonymized', '4) reagendar a atividade: recusado (função da aplicação)');
select throws_ok(format($q$select update_activity(%L, 0, 'call', 'Ligar para Fulano', null, false, null)$q$, :'act_alfa'), 'P0001', 'contact_anonymized', '4) editar o conteúdo da atividade: recusado (função da aplicação)');
reset role;
select throws_ok(format($q$update public.activities set status = 'done', completed_at = now() where id = %L$q$, :'act_alfa'), 'P0001', 'contact_anonymized', '4) status da atividade direto: recusado');
select throws_ok(format($q$update public.activities set assigned_to = %L where id = %L$q$, :'ana', :'act_alfa'), 'P0001', 'contact_anonymized', '4) responsável da atividade direto: recusado');
select throws_ok(format($q$update public.activities set due_at = now() + interval '9 days' where id = %L$q$, :'act_alfa'), 'P0001', 'contact_anonymized', '4) data da atividade direto: recusada');
select is(pg_temp.t(format($q$select status::text from public.activities where id = %L$q$, :'act_alfa')), 'pending', '4) a atividade continua pendente');

-- =====================================================================
-- E) 5 — proposta
-- =====================================================================

set local role authenticated;
select pg_temp.login(:'ana'::uuid);
select throws_ok(format($q$select send_proposal(%L, 0, array['whatsapp']::public.proposal_channel[])$q$, :'prop_alfa'), 'P0001', 'contact_anonymized', '5) enviar a proposta: recusado (função da aplicação)');
reset role;
select throws_ok(format($q$update public.proposals set status = 'enviada' where id = %L$q$, :'prop_alfa'), 'P0001', 'contact_anonymized', '5) status "enviada" direto: recusado');
select throws_ok(format($q$update public.proposals set status = 'aceita' where id = %L$q$, :'prop_alfa'), 'P0001', 'contact_anonymized', '5) aceitar direto: recusado');
select throws_ok(format($q$update public.proposals set status = 'recusada' where id = %L$q$, :'prop_alfa'), 'P0001', 'contact_anonymized', '5) recusar direto: recusado');
select throws_ok(format($q$update public.proposals set value_cents = 1 where id = %L$q$, :'prop_alfa'), 'P0001', 'contact_anonymized', '5) valor da proposta: recusado');
select is(pg_temp.t(format($q$select status::text from public.proposals where id = %L$q$, :'prop_alfa')), 'rascunho', '5) a proposta continua rascunho');

-- =====================================================================
-- F) 6 — registros históricos não aceitam novo vínculo ou texto
-- =====================================================================

select throws_ok(format($q$update public.conflict_checks set status = 'sem_conflito' where lead_id = %L$q$, :'lead_alfa'), 'P0001', 'contact_anonymized', '6) verificação de conflito: status recusado');
select throws_ok(format($q$update public.conflict_checks set note = 'Fulano' where lead_id = %L$q$, :'lead_alfa'), 'P0001', 'contact_anonymized', '6) verificação de conflito: texto recusado');
select throws_ok(format($q$update public.lead_values set estimated_value_cents = 1 where lead_id = %L$q$, :'lead_alfa'), 'P0001', 'contact_anonymized', '6) valor estimado (histórico): recusado');
select throws_ok(format($q$insert into public.automation_events (workspace_id, event_type, lead_id) values (%L, 'lead_created', %L)$q$, :'ws_um', :'lead_alfa'), 'P0001', 'contact_anonymized', '6) evento de automação para o lead preservado: recusado');
select throws_ok(format($q$insert into public.proposal_documents (workspace_id, proposal_id, version, storage_path, requested_by) values (%L, %L, 1, 'x/y.pdf', %L)$q$, :'ws_um', :'prop_alfa', :'ana'), 'P0001', 'contact_anonymized', '6) documento novo para a proposta preservada: recusado');
select throws_ok(format($q$insert into public.duplicate_candidates (workspace_id, contact_a_id, contact_b_id, tier, priority) values (%L, %L, %L, 'review', 1)$q$, :'ws_um', :'alfa', :'novo'), 'P0001', 'contact_anonymized', '6) sugestão de duplicidade com o anonimizado: recusada');
select throws_ok(format($q$update public.touchpoints set source = 'outro' where id = %L$q$, :'tp_alfa'), 'P0001', 'contact_anonymized', '6) atribuição: origem recusada');
select throws_ok(format($q$update public.touchpoints set lead_id = %L, opportunity_id = null where id = %L$q$, :'lead_novo', :'tp_alfa'), 'P0001', 'contact_anonymized', '6) atribuição: novo vínculo recusado');
select throws_ok(format($q$update public.touchpoints set lead_id = %L, opportunity_id = %L where id = %L$q$, :'lead_alfa', :'opp_alfa', :'tp_novo'), 'P0001', 'contact_anonymized', '6) atribuição de contato NOVO não se liga ao lead preservado');
select throws_ok(format($q$insert into public.touchpoint_demand_links (workspace_id, touchpoint_id, opportunity_id, action) values (%L, %L, %L, 'assign')$q$, :'ws_um', :'tp_novo', :'opp_alfa'), 'P0001', 'contact_anonymized', '6) vínculo de demanda de contato NOVO com a oportunidade preservada: recusado');
select throws_ok(format($q$insert into public.touchpoint_demand_links (workspace_id, touchpoint_id, opportunity_id, action) values (%L, %L, %L, 'unassign')$q$, :'ws_um', :'tp_alfa', :'opp_alfa'), 'P0001', 'contact_anonymized', '6) novo vínculo de demanda (mesmo sem texto): recusado');
select throws_ok(format($q$update public.contact_consents set revoked_at = now() where id = %L$q$, :'consent_alfa'), 'P0001', 'contact_anonymized', '6) consentimento: revogação recusada');
select throws_ok(format($q$update public.contacts set updated_at = now() + interval '1 day' where id = %L$q$, :'alfa'), 'P0001', 'contact_anonymized', '6) o contato anonimizado é imutável (nem updated_at)');
select throws_ok(format($q$update public.contacts set type = 'pj' where id = %L$q$, :'alfa'), 'P0001', 'contact_anonymized', '6) tipo do contato: recusado');
select throws_ok(format($q$insert into public.lead_notes (workspace_id, lead_id, body, created_by) values (%L, %L, 'x', %L)$q$, :'ws_um', :'lead_alfa', :'ana'), 'P0001', 'contact_anonymized', '6) nota nova: recusada');

-- Nenhum dado do titular aparece no erro.
select is(pg_temp.err(format($q$update public.leads set status = 'ativo' where id = %L$q$, :'lead_alfa')), 'contact_anonymized||', '12) erro: só o código fechado (sem detalhe nem dica)');
select is(pg_temp.err(format($q$update public.activities set status = 'done' where id = %L$q$, :'act_alfa')), 'contact_anonymized||', '12) erro da atividade: só o código fechado');
select is(pg_temp.err(format($q$update public.proposals set status = 'enviada' where id = %L$q$, :'prop_alfa')), 'contact_anonymized||', '12) erro da proposta: só o código fechado');
select is(pg_temp.err(format($q$update public.opportunities set status = 'open' where id = %L$q$, :'opp_alfa')), 'contact_anonymized||', '12) erro da oportunidade: só o código fechado');

-- =====================================================================
-- G) 11 — outro workspace: a mesma resposta de um registro comum
-- =====================================================================

set local role authenticated;
select pg_temp.login(:'bruno'::uuid);
select is(
  pg_temp.err(format($q$select set_lead_status(%L, 'ativo', now())$q$, :'lead_alfa')),
  pg_temp.err(format($q$select set_lead_status(%L, 'ativo', now())$q$, :'lead_novo')),
  '11) outro workspace tentando reativar: a mesma resposta de um lead comum');
select is(
  pg_temp.err(format($q$select complete_activity(%L, 0)$q$, :'act_alfa')),
  pg_temp.err(format($q$select complete_activity(%L, 0)$q$, :'act_novo')),
  '11) outro workspace tentando concluir atividade: idem');
select is(
  pg_temp.err(format($q$select send_proposal(%L, 0, array['whatsapp']::public.proposal_channel[])$q$, :'prop_alfa')),
  pg_temp.err(format($q$select send_proposal(%L, 0, array['whatsapp']::public.proposal_channel[])$q$, :'prop_novo')),
  '11) outro workspace tentando enviar proposta: idem');
select ok(
  pg_temp.err(format($q$select set_lead_status(%L, 'ativo', now())$q$, :'lead_alfa')) not like '%anonym%',
  '11) e a resposta nunca menciona anonimização');
reset role;

-- =====================================================================
-- H) 9 — contato novo e seus registros continuam funcionando
-- =====================================================================

set local role authenticated;
select pg_temp.login(:'ana'::uuid);
select lives_ok(format($q$select set_lead_status(%L, 'arquivado', pg_temp.lead_ts(%L))$q$, :'lead_novo', :'lead_novo'), '9) contato novo: arquivar lead');
select lives_ok(format($q$select set_lead_status(%L, 'ativo', pg_temp.lead_ts(%L))$q$, :'lead_novo', :'lead_novo'), '9) contato novo: reativar lead');
select lives_ok(format($q$select assign_lead(%L, %L, pg_temp.lead_ts(%L))$q$, :'lead_novo', :'ana', :'lead_novo'), '9) contato novo: trocar responsável');
select lives_ok(format($q$select update_lead_basic_fields(%L, 'Cível NOVO', null, '{}'::text[], 'baixa', pg_temp.lead_ts(%L))$q$, :'lead_novo', :'lead_novo'), '9) contato novo: trocar prioridade');
select lives_ok(format($q$select reassign_activity(%L, 0, %L)$q$, :'act_novo', :'ana'), '9) contato novo: reatribuir atividade');
select lives_ok(format($q$select complete_activity(%L, 1)$q$, :'act_novo'), '9) contato novo: concluir atividade');
select lives_ok(format($q$select send_proposal(%L, 0, array['whatsapp']::public.proposal_channel[])$q$, :'prop_novo'), '9) contato novo: enviar proposta');
select lives_ok(format($q$select decide_proposal(%L, 1, 'aceita', 'ok')$q$, :'prop_novo'), '9) contato novo: aceitar proposta');
select lives_ok(format($q$select lose_opportunity(%L, 0, (select id from public.lost_reasons where workspace_id = %L order by position limit 1), 'nota', null)$q$, :'opp_novo', :'ws_um'), '9) contato novo: encerrar oportunidade');
reset role;
select lives_ok(format($q$update public.contacts set updated_at = now() where id = %L$q$, :'novo'), '9) contato novo: atualização comum');

-- =====================================================================
-- I) 12 — nada aparece em auditoria
-- =====================================================================

select is(pg_temp.n(format($q$select count(*) from public.audit_logs where resource_id in (%L::uuid, %L::uuid, %L::uuid, %L::uuid)$q$, :'lead_alfa', :'opp_alfa', :'act_alfa', :'prop_alfa')), (:'audit_antes')::bigint, '12) as tentativas recusadas não deixam rastro na auditoria');
select is(pg_temp.n($q$select count(*) from public.audit_logs where metadata::text like '%ALFA%' or metadata::text like '%+5541999991001%'$q$), 0::bigint, '12) nem em qualquer auditoria');
select is(pg_temp.n(format($q$select count(*) from public.audit_logs where action = 'privacy.anonymization_failed' and resource_id = %L$q$, :'alfa')), 0::bigint, '12) as tentativas recusadas não viram falha de anonimização');

-- =====================================================================
-- J) 7 — excluir continua possível
-- =====================================================================

select lives_ok(format($q$delete from public.touchpoint_demand_links where touchpoint_id = %L$q$, :'tp_alfa'), '7) excluir vínculo de demanda');
select lives_ok(format($q$delete from public.proposals where id = %L$q$, :'prop_alfa'), '7) excluir proposta');
select lives_ok(format($q$delete from public.activities where id = %L$q$, :'act_alfa'), '7) excluir atividade');
select lives_ok(format($q$delete from public.touchpoints where id = %L$q$, :'tp_alfa'), '7) excluir atribuição');
select lives_ok(format($q$delete from public.opportunities where id = %L$q$, :'opp_alfa'), '7) excluir oportunidade');
select lives_ok(format($q$delete from public.leads where id = %L$q$, :'lead_alfa'), '7) excluir lead');
select lives_ok(format($q$delete from public.contacts where id = %L$q$, :'alfa'), '7) excluir o contato anonimizado (exclusão administrativa)');
select is(pg_temp.n(format($q$select count(*) from public.contacts where id = %L$q$, :'alfa')), 0::bigint, '7) o contato foi mesmo excluído');
select is(pg_temp.n(format($q$select count(*) from public.leads where contact_id = %L$q$, :'alfa')), 0::bigint, '7) sem lead órfão');

select * from finish();
rollback;
