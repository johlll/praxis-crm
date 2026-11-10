-- C3a — exportação dos dados de um titular (LGPD operacional).
--
-- O arquivo exportado NUNCA passa por aqui como conteúdo persistente: esta
-- migration só guarda o REGISTRO operacional (quem pediu, quando, resultado
-- fechado) e a leitura consistente dos dados. O JSON é montado em memória no
-- servidor, entregue como download e descartado.
--
-- Fora do escopo (C3b, depende da política de retenção): anonimização,
-- exclusão, retenção automática e bloqueio por preservação legal.

-- ---------------------------------------------------------------------
-- Registro operacional (sem conteúdo, sem PII)
-- ---------------------------------------------------------------------

create table public.privacy_exports (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  contact_id uuid not null,
  requested_by uuid references public.users (id) on delete set null,
  format_version text not null check (format_version = 'praxis_data_subject_export_v1'),
  status text not null default 'requested' check (status in ('requested', 'completed', 'failed')),
  failure_code text check (failure_code in ('data_unavailable', 'decryption_failed', 'internal_error')),
  requested_at timestamptz not null default now(),
  finished_at timestamptz,
  constraint privacy_exports_contact_fkey
    foreign key (workspace_id, contact_id) references public.contacts (workspace_id, id) on delete cascade,
  -- Estado e código andam juntos: falha sempre tem código; sucesso e pendente nunca.
  constraint privacy_exports_state_shape check (
    (status = 'requested' and failure_code is null and finished_at is null) or
    (status = 'completed' and failure_code is null and finished_at is not null) or
    (status = 'failed' and failure_code is not null and finished_at is not null)
  )
);

comment on table public.privacy_exports is
  'C3a — registro de exportações de dados de titular. Só metadados: nunca o arquivo, o conteúdo ou qualquer PII.';

create index privacy_exports_contact_idx
  on public.privacy_exports (workspace_id, contact_id, requested_at desc);

alter table public.privacy_exports enable row level security;
alter table public.privacy_exports force row level security;
revoke all on table public.privacy_exports from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- Leitura consistente dos dados do titular
--
-- Uma ÚNICA instrução (WITH + SELECT) em função STABLE: todas as categorias
-- enxergam o mesmo instantâneo, sem misturar estados de momentos diferentes.
-- Chamada só pela RPC pública abaixo, que faz a autorização.
--
-- Deliberadamente NÃO projeta TEXTO LIVRE INTERNO nem dado de terceiro (resumo e tags do
-- lead, nota de perda, texto de requisito, título e notas de atividade, nota de decisão da
-- proposta, corpo das notas, nota de conflito, e-mail do destinatário do envio e motivo do
-- vínculo de atribuição): o arquivo
-- automático pode ir ao titular. Tudo isso continua preservado no CRM; fornecê-lo depende de
-- revisão humana e jurídica.
-- Tampouco projeta: chaves, segredos, tokens, hashes, blind
-- indexes, ciphertext (exceto o do CPF/CNPJ, que volta separado e é decifrado
-- só no servidor), payload bruto de inbox/formulário, ids de provedor,
-- chaves de idempotência, caminhos de armazenamento, usuários internos e
-- listas de candidatos de vínculo (que apontam para OUTROS contatos).
-- ---------------------------------------------------------------------

create function private.privacy_export_payload(p_workspace_id uuid, p_contact_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $body$
  with
    c as (
      select * from public.contacts
      where id = p_contact_id and workspace_id = p_workspace_id and merged_into_contact_id is null
    ),
    l as (
      select * from public.leads
      where workspace_id = p_workspace_id and contact_id in (select id from c)
    ),
    o as (
      select * from public.opportunities
      where workspace_id = p_workspace_id and lead_id in (select id from l)
    ),
    cl as (
      select * from public.clients
      where workspace_id = p_workspace_id and contact_id in (select id from c)
    ),
    p as (
      select * from public.proposals
      where workspace_id = p_workspace_id
        and (lead_id in (select id from l) or opportunity_id in (select id from o))
    ),
    cv as (
      select * from public.conversations
      where workspace_id = p_workspace_id
        and (contact_id in (select id from c)
             or lead_id in (select id from l)
             or opportunity_id in (select id from o))
    ),
    m as (
      select * from public.messages
      where workspace_id = p_workspace_id and conversation_id in (select id from cv)
    ),
    t as (
      select * from public.touchpoints
      where workspace_id = p_workspace_id
        and (contact_id in (select id from c)
             or lead_id in (select id from l)
             or opportunity_id in (select id from o))
    )
  select jsonb_build_object(
    'contact', (
      select jsonb_build_object(
        'id', c.id, 'name', c.name, 'type', c.type, 'city', c.city, 'uf', c.uf,
        'preferred_channel', c.preferred_channel, 'created_at', c.created_at, 'updated_at', c.updated_at)
      from c
    ),
    'phones', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', x.id, 'value', x.value_normalized, 'is_primary', x.is_primary, 'source', x.source,
        'verified_at', x.verified_at, 'created_at', x.created_at) order by x.created_at, x.id)
      from public.contact_phones x where x.workspace_id = p_workspace_id and x.contact_id in (select id from c)
    ), '[]'::jsonb),
    'emails', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', x.id, 'value', x.value_normalized, 'is_primary', x.is_primary, 'source', x.source,
        'verified_at', x.verified_at, 'created_at', x.created_at) order by x.created_at, x.id)
      from public.contact_emails x where x.workspace_id = p_workspace_id and x.contact_id in (select id from c)
    ), '[]'::jsonb),
    'identifiers', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', x.id, 'provider', x.provider, 'external_id', x.external_id, 'created_at', x.created_at)
        order by x.created_at, x.id)
      from public.contact_identifiers x where x.workspace_id = p_workspace_id and x.contact_id in (select id from c)
    ), '[]'::jsonb),
    '_sensitive', (
      select jsonb_build_object('ciphertext_base64', encode(s.cpf_cnpj_ciphertext, 'base64'), 'key_version', s.key_version)
      from public.contact_sensitive s where s.workspace_id = p_workspace_id and s.contact_id in (select id from c)
    ),
    'consents', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', x.id, 'purpose_code', x.purpose_code, 'purpose', x.purpose, 'channel', x.channel,
        'legal_basis', x.legal_basis, 'accepted_text', x.accepted_text, 'evidence_source', x.evidence_source,
        'granted_at', x.granted_at, 'revoked_at', x.revoked_at, 'created_at', x.created_at)
        order by x.created_at, x.id)
      from public.contact_consents x where x.workspace_id = p_workspace_id and x.contact_id in (select id from c)
    ), '[]'::jsonb),
    'consent_evidence', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', x.id, 'consent_id', x.contact_consent_id, 'decision', x.decision, 'decided_at', x.decided_at,
        'purpose_code', x.purpose_code, 'purpose', x.purpose, 'legal_basis', x.legal_basis,
        'channel', x.channel, 'text_version', x.text_version, 'created_at', x.created_at)
        order by x.decided_at, x.id)
      from public.consent_evidence x where x.workspace_id = p_workspace_id and x.contact_id in (select id from c)
    ), '[]'::jsonb),
    'leads', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', x.id, 'legal_area', x.legal_area, 'priority', x.priority, 'status', x.status,
        'estimated_value_cents', (select v.estimated_value_cents from public.lead_values v where v.lead_id = x.id),
        'created_at', x.created_at, 'updated_at', x.updated_at) order by x.created_at, x.id)
      from l x
    ), '[]'::jsonb),
    'opportunities', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', x.id, 'lead_id', x.lead_id,
        'pipeline', (select pl.name from public.pipelines pl where pl.id = x.pipeline_id),
        'stage', (select ps.name from public.pipeline_stages ps where ps.id = x.stage_id),
        'status', x.status, 'value_cents', x.value_cents, 'fee_model', x.fee_model,
        'probability', x.probability, 'forecast_date', x.forecast_date, 'signed_at', x.signed_at,
        'won_at', x.won_at, 'stage_entered_at', x.stage_entered_at,
        'lost_reason', (select lr.label from public.lost_reasons lr where lr.id = x.lost_reason_id),
        'lost_followup_date', x.lost_followup_date,
        'created_at', x.created_at, 'updated_at', x.updated_at) order by x.created_at, x.id)
      from o x
    ), '[]'::jsonb),
    'opportunity_requirements', coalesce((
      select jsonb_agg(jsonb_build_object(
        'opportunity_id', x.opportunity_id,
        'label', (select sr.label from public.stage_requirements sr where sr.id = x.requirement_id),
        'value_bool', x.value_bool, 'filled_at', x.filled_at)
        order by x.opportunity_id, x.id)
      from public.opportunity_requirement_values x
      where x.workspace_id = p_workspace_id and x.opportunity_id in (select id from o)
    ), '[]'::jsonb),
    'stage_history', coalesce((
      select jsonb_agg(jsonb_build_object(
        'opportunity_id', x.opportunity_id,
        'from_stage', (select ps.name from public.pipeline_stages ps where ps.id = x.from_stage_id),
        'to_stage', (select ps.name from public.pipeline_stages ps where ps.id = x.to_stage_id),
        'occurred_at', x.occurred_at, 'seconds_in_previous_stage', x.seconds_in_previous_stage)
        order by x.occurred_at, x.id)
      from public.stage_transitions x
      where x.workspace_id = p_workspace_id and x.opportunity_id in (select id from o)
    ), '[]'::jsonb),
    'activities', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', x.id, 'lead_id', x.lead_id, 'opportunity_id', x.opportunity_id, 'type', x.type,
        'status', x.status, 'priority', x.priority,
        'due_at', x.due_at, 'has_time', x.has_time, 'completed_at', x.completed_at,
        'source', x.source, 'created_at', x.created_at) order by x.created_at, x.id)
      from public.activities x
      where x.workspace_id = p_workspace_id
        and (x.lead_id in (select id from l) or x.opportunity_id in (select id from o))
    ), '[]'::jsonb),
    'clients', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', x.id, 'status', x.status, 'created_at', x.created_at, 'updated_at', x.updated_at)
        order by x.created_at, x.id)
      from cl x
    ), '[]'::jsonb),
    'client_handoffs', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', x.id, 'client_id', x.client_id, 'opportunity_id', x.opportunity_id, 'status', x.status,
        'target_system', x.target_system, 'attempts', x.attempts, 'completed_at', x.completed_at,
        'created_at', x.created_at) order by x.created_at, x.id)
      from public.client_handoffs x
      where x.workspace_id = p_workspace_id and x.client_id in (select id from cl)
    ), '[]'::jsonb),
    'proposals', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', x.id, 'lead_id', x.lead_id, 'opportunity_id', x.opportunity_id, 'number', x.number,
        'status', x.status, 'fee_model', x.fee_model, 'value_cents', x.value_cents,
        'sent_at', x.sent_at, 'sent_channels', x.sent_channels, 'decided_at', x.decided_at,
        'created_at', x.created_at) order by x.created_at, x.id)
      from p x
    ), '[]'::jsonb),
    -- Só metadados do documento: nada de caminho de armazenamento, checksum ou conteúdo binário.
    'proposal_documents', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', x.id, 'proposal_id', x.proposal_id, 'version', x.version, 'status', x.status,
        'byte_size', x.byte_size, 'requested_at', x.requested_at, 'resolved_at', x.resolved_at)
        order by x.requested_at, x.id)
      from public.proposal_documents x
      where x.workspace_id = p_workspace_id and x.proposal_id in (select id from p)
    ), '[]'::jsonb),
    'proposal_email_sends', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', x.id, 'proposal_id', x.proposal_id, 'document_id', x.document_id,
        'status', x.status, 'requested_at', x.requested_at, 'resolved_at', x.resolved_at)
        order by x.requested_at, x.id)
      from public.proposal_email_sends x
      where x.workspace_id = p_workspace_id and x.proposal_id in (select id from p)
    ), '[]'::jsonb),
    'lead_notes', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', x.id, 'lead_id', x.lead_id, 'created_at', x.created_at)
        order by x.created_at, x.id)
      from public.lead_notes x where x.workspace_id = p_workspace_id and x.lead_id in (select id from l)
    ), '[]'::jsonb),
    'conflict_checks', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', x.id, 'lead_id', x.lead_id, 'status', x.status,
        'checked_at', x.checked_at, 'created_at', x.created_at) order by x.created_at, x.id)
      from public.conflict_checks x where x.workspace_id = p_workspace_id and x.lead_id in (select id from l)
    ), '[]'::jsonb),
    -- Sem link_candidate_*: essas listas apontam para OUTROS contatos e leads.
    'conversations', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', x.id, 'lead_id', x.lead_id, 'opportunity_id', x.opportunity_id, 'wa_id', x.wa_id,
        'identity_id', x.identity_id, 'created_at', x.created_at, 'last_message_at', x.last_message_at)
        order by x.created_at, x.id)
      from cv x
    ), '[]'::jsonb),
    'messages', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', x.id, 'conversation_id', x.conversation_id, 'direction', x.direction,
        'content_kind', x.content_kind, 'body_text', x.body_text, 'origin', x.origin,
        'sender_classification', x.sender_classification, 'provider', x.provider, 'status', x.status,
        'status_updated_at', x.status_updated_at, 'created_at', x.created_at,
        'cost', jsonb_build_object(
          'amount', x.provider_cost_amount, 'billable_amount', x.provider_cost_billable_amount,
          'category', x.provider_cost_category, 'currency', x.provider_cost_currency,
          'finality', x.provider_cost_finality)) order by x.created_at, x.id)
      from m x
    ), '[]'::jsonb),
    'message_status_events', coalesce((
      select jsonb_agg(jsonb_build_object(
        'message_id', x.message_id, 'status', x.status, 'event_at', x.event_wa_timestamp,
        'received_at', x.received_at, 'error_code', x.error_code) order by x.received_at, x.id)
      from public.message_status_events x
      where x.workspace_id = p_workspace_id and x.message_id in (select id from m)
    ), '[]'::jsonb),
    -- Sem bsuid_ciphertext, bsuid_blind_index e bsuid_key_version.
    'whatsapp_identities', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', x.id, 'phone', x.phone_e164, 'provider', x.provider, 'environment', x.environment,
        'created_at', x.created_at) order by x.created_at, x.id)
      from public.whatsapp_identities x
      where x.workspace_id = p_workspace_id and x.id in (select identity_id from cv where identity_id is not null)
    ), '[]'::jsonb),
    'attribution_touchpoints', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', x.id, 'lead_id', x.lead_id, 'opportunity_id', x.opportunity_id, 'channel', x.channel,
        'source', x.source, 'medium', x.medium, 'campaign', x.campaign, 'term', x.term,
        'content', x.content, 'landing_url', x.landing_url, 'referrer', x.referrer,
        'gclid', x.gclid, 'fbclid', x.fbclid, 'consent_id', x.consent_evidence_id,
        'occurred_at', x.occurred_at, 'received_at', x.received_at) order by x.occurred_at, x.id)
      from t x
    ), '[]'::jsonb),
    'attribution_links', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', x.id, 'touchpoint_id', x.touchpoint_id, 'opportunity_id', x.opportunity_id,
        'action', x.action, 'created_at', x.created_at) order by x.created_at, x.id)
      from public.touchpoint_demand_links x
      where x.workspace_id = p_workspace_id and x.touchpoint_id in (select id from t)
    ), '[]'::jsonb),
    -- Sem token_hash.
    'continuity_references', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', x.id, 'lead_id', x.lead_id, 'opportunity_id', x.opportunity_id, 'purpose', x.purpose,
        'created_at', x.created_at, 'expires_at', x.expires_at, 'last_used_at', x.last_used_at,
        'used_count', x.used_count, 'revoked_at', x.revoked_at) order by x.created_at, x.id)
      from public.continuity_references x
      where x.workspace_id = p_workspace_id
        and (x.contact_id in (select id from c) or x.lead_id in (select id from l))
    ), '[]'::jsonb),
    -- C4: valores de contato, leads, oportunidades e clientes do titular, inclusive de
    -- definições arquivadas (arquivar preserva o valor). Seleção única sai pelo RÓTULO.
    'custom_fields', coalesce((
      select jsonb_agg(jsonb_build_object(
        'entity_type', d.entity_type,
        'record_id', coalesce(v.contact_id, v.lead_id, v.opportunity_id, v.client_id),
        'field', d.name, 'field_type', d.field_type, 'archived', d.archived_at is not null,
        'value', case d.field_type
          when 'text' then to_jsonb(v.value_text)
          when 'number' then to_jsonb(v.value_number)
          when 'date' then to_jsonb(v.value_date)
          when 'boolean' then to_jsonb(v.value_boolean)
          else to_jsonb((select co.label from public.custom_field_options co where co.id = v.option_id))
        end) order by d.entity_type, d.name, v.id)
      from public.custom_field_values v
      join public.custom_field_definitions d on d.workspace_id = v.workspace_id and d.id = v.definition_id
      where v.workspace_id = p_workspace_id
        and (v.contact_id in (select id from c)
             or v.lead_id in (select id from l)
             or v.opportunity_id in (select id from o)
             or v.client_id in (select id from cl))
    ), '[]'::jsonb)
  );
$body$;

revoke all on function private.privacy_export_payload(uuid, uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- RPCs — EXCLUSIVAS DO SERVIDOR (service_role)
--
-- Nenhuma é chamável com sessão de usuário: a leitura devolve o conjunto
-- completo e o ciphertext do CPF/CNPJ, e só a rota de entrega (que decifra em
-- Node, aplica as proteções de resposta e fecha o registro) pode obtê-los.
--
-- O ator e o workspace NÃO vêm de auth.uid() nem do navegador: o servidor os extrai
-- da sessão já validada (requirePermissionSafe: userId e workspace ATIVO) e os envia como
-- p_actor_user_id e p_workspace_id. Cada função confere DE NOVO, no banco: ator existente,
-- membership ativa e papel owner/admin NESTE workspace, contato/registro pertencentes
-- exatamente a ele, registro do próprio ator e ainda aberto. Divergência de workspace
-- responde "não encontrado" — outro workspace nunca é revelado.
-- ---------------------------------------------------------------------

-- Papel do ator no workspace; nulo se o ator não existe ou não tem membership ativa.
create function private.privacy_export_actor_role(p_actor_user_id uuid, p_workspace_id uuid)
returns public.membership_role
language sql
stable
security definer
set search_path = ''
as $body$
  select m.role
  from public.users u
  join public.memberships m on m.user_id = u.id
  where u.id = p_actor_user_id and m.workspace_id = p_workspace_id and m.status = 'active';
$body$;

revoke all on function private.privacy_export_actor_role(uuid, uuid) from public, anon, authenticated;

-- 1) Abre o registro. Contato inexistente, mesclado ou de workspace do qual o ator
-- não participa: "não encontrado". Participante sem papel de owner/admin: permissão negada.
create function public.request_privacy_export(p_actor_user_id uuid, p_workspace_id uuid, p_contact_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_found boolean;
  v_role public.membership_role;
  v_id uuid;
begin
  if p_actor_user_id is null then raise exception 'authentication_required'; end if;

  -- O contato precisa pertencer EXATAMENTE ao workspace ativo informado pelo servidor.
  select true into v_found
  from public.contacts c
  where c.id = p_contact_id and c.workspace_id = p_workspace_id and c.merged_into_contact_id is null;

  v_role := private.privacy_export_actor_role(p_actor_user_id, p_workspace_id);

  if v_found is not true or v_role is null then raise exception 'contact_not_found'; end if;
  if v_role not in ('owner', 'admin') then raise exception 'insufficient_permission'; end if;

  insert into public.privacy_exports (workspace_id, contact_id, requested_by, format_version)
  values (p_workspace_id, p_contact_id, p_actor_user_id, 'praxis_data_subject_export_v1')
  returning id into v_id;

  insert into public.audit_logs (workspace_id, actor_user_id, action, resource_type, resource_id, metadata)
  values (p_workspace_id, p_actor_user_id, 'privacy.export_requested', 'privacy_export', v_id,
          jsonb_build_object('contact_id', p_contact_id, 'format_version', 'praxis_data_subject_export_v1'));

  return v_id;
end;
$body$;

-- 2) Entrega os dados de um registro ABERTO do próprio ator. O ciphertext do
-- CPF/CNPJ volta separado, só para o servidor decifrar; a leitura é registrada
-- na trilha de dado sensível já existente (sem o valor).
create function public.get_privacy_export_payload(p_actor_user_id uuid, p_workspace_id uuid, p_export_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_export public.privacy_exports;
  v_role public.membership_role;
  v_payload jsonb;
begin
  if p_actor_user_id is null then raise exception 'authentication_required'; end if;

  -- Registro do próprio ator, NO workspace ativo informado pelo servidor, ainda aberto.
  select * into v_export from public.privacy_exports
  where id = p_export_id and requested_by = p_actor_user_id and workspace_id = p_workspace_id and status = 'requested'
  for update;
  if v_export.id is null then raise exception 'privacy_export_not_found'; end if;

  -- O papel é conferido de novo, nesse mesmo workspace: pode ter mudado (ou a membership
  -- ter sido suspensa) entre o pedido e a leitura.
  v_role := private.privacy_export_actor_role(p_actor_user_id, p_workspace_id);
  if v_role is null or v_role not in ('owner', 'admin') then raise exception 'privacy_export_not_found'; end if;

  select private.privacy_export_payload(v_export.workspace_id, v_export.contact_id) into v_payload;
  if v_payload -> 'contact' is null or jsonb_typeof(v_payload -> 'contact') = 'null' then
    raise exception 'contact_not_found';
  end if;

  if v_payload ->> '_sensitive' is not null then
    insert into public.sensitive_data_access (workspace_id, contact_id, actor_user_id, field, reason)
    values (v_export.workspace_id, v_export.contact_id, p_actor_user_id, 'cpf_cnpj', 'exportacao_titular');
  end if;

  return jsonb_build_object('data', v_payload - '_sensitive', 'sensitive', v_payload -> '_sensitive');
end;
$body$;

-- 3) Fecha o registro: sem código = concluída; com código fechado = falha.
-- Só o autor do pedido, com o papel ainda válido, e só uma vez.
create function public.finish_privacy_export(p_actor_user_id uuid, p_workspace_id uuid, p_export_id uuid, p_failure_code text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_export public.privacy_exports;
  v_role public.membership_role;
begin
  if p_actor_user_id is null then raise exception 'authentication_required'; end if;
  if p_failure_code is not null and p_failure_code not in ('data_unavailable', 'decryption_failed', 'internal_error') then
    raise exception 'privacy_export_failure_invalid';
  end if;

  select * into v_export from public.privacy_exports
  where id = p_export_id and requested_by = p_actor_user_id and workspace_id = p_workspace_id and status = 'requested'
  for update;
  if v_export.id is null then raise exception 'privacy_export_not_found'; end if;

  v_role := private.privacy_export_actor_role(p_actor_user_id, p_workspace_id);
  if v_role is null or v_role not in ('owner', 'admin') then raise exception 'privacy_export_not_found'; end if;

  update public.privacy_exports
  set status = case when p_failure_code is null then 'completed' else 'failed' end,
      failure_code = p_failure_code,
      finished_at = now()
  where id = v_export.id;

  insert into public.audit_logs (workspace_id, actor_user_id, action, resource_type, resource_id, metadata)
  values (v_export.workspace_id, p_actor_user_id,
          case when p_failure_code is null then 'privacy.export_generated' else 'privacy.export_failed' end,
          'privacy_export', v_export.id,
          jsonb_build_object('contact_id', v_export.contact_id, 'format_version', v_export.format_version)
            || case when p_failure_code is null then '{}'::jsonb
                    else jsonb_build_object('result_code', p_failure_code) end);
end;
$body$;

-- ACL final: somente service_role (e o dono postgres). anon, authenticated e PUBLIC não executam.
revoke all on function public.request_privacy_export(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.request_privacy_export(uuid, uuid, uuid) to service_role;

revoke all on function public.get_privacy_export_payload(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.get_privacy_export_payload(uuid, uuid, uuid) to service_role;

revoke all on function public.finish_privacy_export(uuid, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.finish_privacy_export(uuid, uuid, uuid, text) to service_role;
