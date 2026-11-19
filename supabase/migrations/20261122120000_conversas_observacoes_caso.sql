-- Conversas + IA — painel do caso: OBSERVAÇÕES POR CASO.
--
-- Decisões em docs/decisoes/conversas-observacoes-caso.md. Resumo:
--
--   - Uma observação pertence à OPORTUNIDADE (o caso), nunca ao contato inteiro: dois casos do mesmo
--     contato têm observações independentes; trocar o caso em foco não move nem copia nada. As notas
--     gerais do lead (`lead_notes`) não mudam e não são migradas nem associadas por inferência.
--   - Registros ACRESCENTADOS (texto, autor, data/hora), imutáveis: corrigir é escrever outra
--     observação. Não há edição nem exclusão comum. Não exige número interno nem roteiro.
--   - Escrita: `case_note.add` (owner, admin, manager, lawyer, sales — a faixa de `lead_note.edit`);
--     o banco repete permissão, escritório, alcance do lead e o bloqueio de contato anonimizado.
--     Idempotente por chave (clique duplo, resposta perdida, repetição): a mesma chave com o mesmo
--     pedido devolve o registro gravado; com outro pedido, `idempotency_conflict`. Duas pessoas
--     escrevendo ao mesmo tempo gravam os dois registros (não há versão a disputar).
--   - Leitura: quem enxerga o caso lê (visualizador incluído), paginada por (created_at, id).
--   - Acrescentar observação NÃO toca trilhas, versões, roteiro, etapa comercial, vínculo da
--     conversa, mensagens nem automações. A auditoria guarda só ids e o tamanho, nunca o texto.
--   - Privacidade (texto livre, possivelmente dado pessoal — NÃO é esqueleto): exportação do titular
--     só com a existência (id, caso, data), como `lead_notes.body`; a anonimização APAGA as
--     observações (como as notas do lead) e confere que nada sobrou; depois dela, nada novo entra.
--     Exclusão da oportunidade/lead/escritório leva as observações em cascata.
--
-- Migration ADITIVA: uma tabela nova deny-all, funções novas e `create or replace`, com a MESMA
-- assinatura, de private.privacy_export_payload (uma seção nova; as anteriores ficam iguais) e
-- private.privacy_anonymize_contact (apaga e confere as observações; o resto fica igual).

-- =====================================================================
-- 1) Tabela
-- =====================================================================

create table public.case_notes (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  opportunity_id uuid not null,
  body text not null check (char_length(btrim(body)) between 1 and 4000),
  created_by uuid not null references auth.users (id) on delete restrict,
  created_at timestamptz not null default clock_timestamp(),
  idempotency_key uuid not null,
  request_fingerprint text not null,
  constraint case_notes_opportunity_fkey
    foreign key (workspace_id, opportunity_id) references public.opportunities (workspace_id, id) on delete cascade,
  constraint case_notes_idempotency_key unique (workspace_id, idempotency_key)
);

create index case_notes_opportunity_idx on public.case_notes (opportunity_id, created_at desc, id desc);
create index case_notes_created_by_idx on public.case_notes (created_by);

comment on table public.case_notes is
  'Painel do caso: observações acrescentadas a um caso (oportunidade) — texto livre, autor e horário; imutáveis (corrigir = nova observação). Texto livre interno: fora da exportação automática do titular e apagado na anonimização, como lead_notes.';

alter table public.case_notes enable row level security;
alter table public.case_notes force row level security;
revoke all on table public.case_notes from public, anon, authenticated, service_role;

-- =====================================================================
-- 2) Integridade: o registro não muda; depois da anonimização, nada novo entra
-- =====================================================================

create function private.case_note_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $body$
begin
  if tg_op = 'UPDATE' then
    raise exception 'case_note_immutable';
  end if;
  if private.privacy_opportunity_anonymized(new.opportunity_id) then
    raise exception 'contact_anonymized';
  end if;
  return new;
end;
$body$;

revoke all on function private.case_note_guard() from public, anon, authenticated, service_role;

create trigger case_notes_guard before insert or update on public.case_notes
  for each row execute function private.case_note_guard();

-- =====================================================================
-- 3) Alcance comum (leitura e escrita)
-- =====================================================================

-- Oportunidade no alcance do ator (escritório ativo + alcance do lead). Fora do alcance, de outro
-- escritório ou inexistente → opportunity_not_found (não revela se existe); sem sessão → authentication_required.
create function private.case_note_target(p_opportunity_id uuid, p_actor uuid)
returns table (o_workspace_id uuid, o_opportunity_id uuid, o_role public.membership_role)
language plpgsql
stable
security definer
set search_path = ''
as $body$
declare
  v_opp public.opportunities;
  v_lead public.leads;
  v_role public.membership_role;
begin
  if p_actor is null then
    raise exception 'authentication_required';
  end if;
  if p_opportunity_id is null then
    raise exception 'invalid_request';
  end if;
  select * into v_opp from public.opportunities where id = p_opportunity_id;
  if v_opp.id is null then
    raise exception 'opportunity_not_found';
  end if;
  v_role := private.status_track_actor_role(v_opp.workspace_id, p_actor);
  if v_role is null then
    raise exception 'opportunity_not_found';
  end if;
  select * into v_lead from public.leads where id = v_opp.lead_id and workspace_id = v_opp.workspace_id;
  if not private.lead_accessible_to_role(v_role, v_lead.assigned_to, p_actor) then
    raise exception 'opportunity_not_found';
  end if;
  return query select v_opp.workspace_id, v_opp.id, v_role;
end;
$body$;

revoke all on function private.case_note_target(uuid, uuid) from public, anon, authenticated, service_role;

-- Projeção pública de uma observação (texto, autor e horário; sem chave nem impressão do pedido).
create function private.case_note_json(p_note public.case_notes)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $body$
  select jsonb_build_object(
    'id', p_note.id,
    'opportunity_id', p_note.opportunity_id,
    'body', p_note.body,
    'author_name', private.user_display_name(p_note.created_by),
    'created_at', p_note.created_at
  );
$body$;

revoke all on function private.case_note_json(public.case_notes) from public, anon, authenticated, service_role;

-- =====================================================================
-- 4) Acrescentar observação
-- =====================================================================

create function public.add_case_note(
  p_opportunity_id uuid,
  p_body text,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_actor uuid := auth.uid();
  v_target record;
  v_body text;
  v_fp text;
  v_note public.case_notes;
begin
  select * into v_target from private.case_note_target(p_opportunity_id, v_actor);
  if v_target.o_role not in ('owner', 'admin', 'manager', 'lawyer', 'sales') then
    raise exception 'insufficient_permission';
  end if;
  if p_idempotency_key is null then
    raise exception 'invalid_request';
  end if;

  -- Quebras de linha preservadas (CRLF vira LF); só as bordas são aparadas.
  v_body := btrim(replace(coalesce(p_body, ''), E'\r\n', E'\n'), E' \t\n\r');
  if v_body = '' then
    raise exception 'case_note_body_required';
  end if;
  if char_length(v_body) > 4000 then
    raise exception 'case_note_too_long';
  end if;
  if private.privacy_opportunity_anonymized(p_opportunity_id) then
    raise exception 'contact_anonymized';
  end if;

  v_fp := md5(p_opportunity_id::text || ':' || v_body);

  -- Duas gravações com a MESMA chave ao mesmo tempo: a segunda espera a primeira no índice único e
  -- não grava; depois lê o registro confirmado e decide entre repetição e conflito.
  insert into public.case_notes (workspace_id, opportunity_id, body, created_by, idempotency_key, request_fingerprint)
  values (v_target.o_workspace_id, p_opportunity_id, v_body, v_actor, p_idempotency_key, v_fp)
  on conflict (workspace_id, idempotency_key) do nothing
  returning * into v_note;

  if v_note.id is null then
    select * into v_note from public.case_notes
    where workspace_id = v_target.o_workspace_id and idempotency_key = p_idempotency_key;
    if v_note.id is null or v_note.opportunity_id <> p_opportunity_id or v_note.request_fingerprint <> v_fp then
      raise exception 'idempotency_conflict';
    end if;
    return private.case_note_json(v_note) || jsonb_build_object('replayed', true);
  end if;

  -- Auditoria só com ids e tamanho — nunca o texto.
  insert into public.audit_logs (workspace_id, actor_user_id, action, resource_type, resource_id, metadata)
  values (v_target.o_workspace_id, v_actor, 'opportunity.case_note_added', 'opportunity', p_opportunity_id,
          jsonb_build_object('note_id', v_note.id, 'length', char_length(v_body)));

  return private.case_note_json(v_note) || jsonb_build_object('replayed', false);
end;
$body$;

comment on function public.add_case_note(uuid, text, uuid) is
  'Painel do caso: acrescenta uma observação ao caso (oportunidade). Idempotente por chave; não altera trilhas, roteiro, etapa nem vínculo; auditoria sem o texto.';

revoke all on function public.add_case_note(uuid, text, uuid) from public, anon;
grant execute on function public.add_case_note(uuid, text, uuid) to authenticated;

-- =====================================================================
-- 5) Ler as observações (paginado no servidor)
-- =====================================================================

create function public.list_case_notes(
  p_opportunity_id uuid,
  p_before timestamptz default null,
  p_before_id uuid default null,
  p_limit integer default 10
)
returns table (items jsonb, has_more boolean)
language plpgsql
stable
security definer
set search_path = ''
as $body$
declare
  v_target record;
  v_limit integer;
begin
  if (p_before is null) <> (p_before_id is null) then
    raise exception 'invalid_cursor';
  end if;
  select * into v_target from private.case_note_target(p_opportunity_id, auth.uid());
  v_limit := greatest(1, least(coalesce(p_limit, 10), 50));

  return query
  with page as (
    select n.id, n.created_at, private.case_note_json(n) as j
    from public.case_notes n
    where n.workspace_id = v_target.o_workspace_id
      and n.opportunity_id = p_opportunity_id
      and (p_before is null or (n.created_at, n.id) < (p_before, p_before_id))
    order by n.created_at desc, n.id desc
    limit v_limit + 1
  ),
  shown as (
    select * from page order by created_at desc, id desc limit v_limit
  )
  select
    coalesce((select jsonb_agg(s.j order by s.created_at desc, s.id desc) from shown s), '[]'::jsonb),
    (select count(*) from page) > v_limit;
end;
$body$;

comment on function public.list_case_notes(uuid, timestamptz, uuid, integer) is
  'Painel do caso: observações do caso, da mais recente para a mais antiga, paginadas por (created_at, id); quem enxerga o caso lê.';

revoke all on function public.list_case_notes(uuid, timestamptz, uuid, integer) from public, anon;
grant execute on function public.list_case_notes(uuid, timestamptz, uuid, integer) to authenticated;

-- =====================================================================
-- 6) Exportação do titular (C3a): seção `case_notes`, só a existência
--
-- `create or replace` com a mesma assinatura; todas as seções anteriores ficam iguais (conferido pelo
-- script de atualização). O texto da observação e o autor não entram: texto livre interno, como
-- `lead_notes.body`, depende de revisão humana e jurídica para chegar ao titular.
-- =====================================================================

create or replace function private.privacy_export_payload(p_workspace_id uuid, p_contact_id uuid)
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
    -- Observações por caso: só a existência (id, caso, data), como lead_notes — o texto livre interno
    -- e o autor (usuário interno) ficam fora do arquivo automático.
    'case_notes', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', x.id, 'opportunity_id', x.opportunity_id, 'created_at', x.created_at)
        order by x.created_at, x.id)
      from public.case_notes x where x.workspace_id = p_workspace_id and x.opportunity_id in (select id from o)
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
    ), '[]'::jsonb),
    -- Conversas + IA (PR 1): trilhas das conversas e oportunidades do titular.
    -- Sem automation_paused_by (usuário interno).
    'status_tracks', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', x.id, 'track', x.track, 'conversation_id', x.conversation_id, 'opportunity_id', x.opportunity_id,
        'status', coalesce(x.attendance_status::text, x.case_progress_status::text), 'version', x.version,
        'automation_paused', x.automation_paused, 'automation_paused_at', x.automation_paused_at,
        'manual_decided_at', x.manual_decided_at, 'created_at', x.created_at, 'updated_at', x.updated_at)
        order by x.created_at, x.id)
      from public.status_tracks x
      where x.workspace_id = p_workspace_id
        and (x.conversation_id in (select id from cv) or x.opportunity_id in (select id from o))
    ), '[]'::jsonb),
    -- Sem actor_user_id (usuário interno) e sem idempotency_key.
    'status_track_history', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', e.id, 'track_id', e.track_id, 'track', x.track, 'conversation_id', x.conversation_id,
        'opportunity_id', x.opportunity_id, 'event', e.event, 'from_status', e.from_status,
        'to_status', e.to_status, 'from_version', e.from_version, 'to_version', e.to_version,
        'actor_kind', e.actor_kind, 'occurred_at', e.occurred_at, 'evidence_count', e.evidence_count,
        'evidence_message_ids', coalesce((
          select jsonb_agg(ee.message_id order by ee.message_id)
          from public.status_track_event_evidence ee
          where ee.event_id = e.id and ee.workspace_id = p_workspace_id), '[]'::jsonb))
        order by e.occurred_at, e.id)
      from public.status_track_events e
      join public.status_tracks x on x.id = e.track_id and x.workspace_id = e.workspace_id
      where e.workspace_id = p_workspace_id
        and (x.conversation_id in (select id from cv) or x.opportunity_id in (select id from o))
    ), '[]'::jsonb),
    -- Painel do caso (etapa B): número interno, roteiros (com as etapas copiadas e as conclusões) e o
    -- histórico do roteiro das oportunidades do titular. Sem usuário interno (quem atribuiu, aplicou,
    -- concluiu ou decidiu) e sem chave de idempotência, como no restante da C3a.
    'case_numbers', coalesce((
      select jsonb_agg(jsonb_build_object(
        'opportunity_id', x.opportunity_id, 'number', x.number, 'assigned_via', x.assigned_via,
        'assigned_at', x.assigned_at) order by x.assigned_at, x.opportunity_id)
      from public.opportunity_case_numbers x
      where x.workspace_id = p_workspace_id and x.opportunity_id in (select id from o)
    ), '[]'::jsonb),
    'case_service_plans', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', x.id, 'opportunity_id', x.opportunity_id, 'service_type', x.service_type_name,
        'service_type_version', x.service_type_version, 'status', x.status,
        'current_step_id', x.current_step_id, 'applied_at', x.applied_at, 'ended_at', x.ended_at,
        'steps', coalesce((
          select jsonb_agg(jsonb_build_object(
            'id', s.id, 'position', s.position, 'name', s.name, 'completed_at', s.completed_at)
            order by s.position)
          from public.case_service_plan_steps s
          where s.plan_id = x.id and s.workspace_id = p_workspace_id), '[]'::jsonb))
        order by x.applied_at, x.id)
      from public.case_service_plans x
      where x.workspace_id = p_workspace_id and x.opportunity_id in (select id from o)
    ), '[]'::jsonb),
    'case_service_history', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', x.id, 'opportunity_id', x.opportunity_id, 'plan_id', x.plan_id, 'op', x.op,
        'step_id', x.step_id, 'previous_plan_id', x.previous_plan_id,
        'current_step_before', x.current_step_before, 'current_step_after', x.current_step_after,
        'progress_from', x.progress_from, 'progress_to', x.progress_to,
        'from_version', x.from_version, 'to_version', x.to_version, 'actor_kind', x.actor_kind,
        'occurred_at', x.occurred_at) order by x.occurred_at, x.id)
      from public.case_service_events x
      where x.workspace_id = p_workspace_id and x.opportunity_id in (select id from o)
    ), '[]'::jsonb)
  );
$body$;

-- =====================================================================
-- 7) Anonimização (C3b): as observações do caso são APAGADAS e conferidas
--
-- Mesma função da C3b, com só duas linhas novas: apaga as observações dos casos do titular (como as
-- notas do lead) e a conferência final desfaz tudo se alguma sobrar. A guarda da tabela recusa
-- observação nova depois da anonimização. `create or replace` preserva a ACL (fechada).
-- =====================================================================

create or replace function private.privacy_anonymize_contact(p_workspace_id uuid, p_contact_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_lead_ids uuid[];
  v_opp_ids uuid[];
  v_activity_ids uuid[];
  v_proposal_ids uuid[];
  v_conv_ids uuid[];
  v_identity_ids uuid[];
  v_touch_ids uuid[];
  v_phone_keys text[];
begin
  select coalesce(array_agg(id), '{}'::uuid[]) into v_lead_ids
  from public.leads where workspace_id = p_workspace_id and contact_id = p_contact_id;
  select coalesce(array_agg(id), '{}'::uuid[]) into v_opp_ids
  from public.opportunities where workspace_id = p_workspace_id and lead_id = any(v_lead_ids);
  select coalesce(array_agg(id), '{}'::uuid[]) into v_activity_ids
  from public.activities where workspace_id = p_workspace_id and lead_id = any(v_lead_ids);
  select coalesce(array_agg(id), '{}'::uuid[]) into v_proposal_ids
  from public.proposals
  where workspace_id = p_workspace_id and (lead_id = any(v_lead_ids) or opportunity_id = any(v_opp_ids));
  select coalesce(array_agg(id), '{}'::uuid[]), coalesce(array_agg(identity_id), '{}'::uuid[])
    into v_conv_ids, v_identity_ids
  from public.conversations
  where workspace_id = p_workspace_id
    and (contact_id = p_contact_id or lead_id = any(v_lead_ids) or opportunity_id = any(v_opp_ids));
  select coalesce(array_agg(id), '{}'::uuid[]) into v_touch_ids
  from public.touchpoints
  where workspace_id = p_workspace_id
    and (contact_id = p_contact_id or lead_id = any(v_lead_ids) or opportunity_id = any(v_opp_ids));

  -- Os telefones originais são lidos AGORA, antes de qualquer exclusão, e guardados até a
  -- conferência final. A checagem da avaliação se repete aqui, sob as travas da execução.
  v_phone_keys := private.privacy_contact_phone_keys(p_workspace_id, p_contact_id);
  if private.privacy_unlinked_whatsapp(p_workspace_id, v_phone_keys, v_conv_ids, v_identity_ids) then
    raise exception 'unlinked_whatsapp_conversation';
  end if;

  -- Identificação do contato.
  delete from public.contact_phones where workspace_id = p_workspace_id and contact_id = p_contact_id;
  delete from public.contact_emails where workspace_id = p_workspace_id and contact_id = p_contact_id;
  delete from public.contact_identifiers where workspace_id = p_workspace_id and contact_id = p_contact_id;
  delete from public.contact_sensitive where workspace_id = p_workspace_id and contact_id = p_contact_id;

  -- Consentimentos e evidências: a estrutura (canal, base legal, decisão, datas) fica; texto
  -- aceito, fonte, versão, hash, HMAC de IP e evidência bruta saem.
  update public.contact_consents
  set accepted_text = null, evidence_source = null, purpose = 'anonimizado'
  where workspace_id = p_workspace_id and contact_id = p_contact_id;
  update public.consent_evidence
  set purpose = 'anonimizado', text_version = null, text_hash = null, ip_hmac = null, evidence = '{}'::jsonb
  where workspace_id = p_workspace_id and contact_id = p_contact_id;

  -- Leads, oportunidades, atividades, propostas, notas e verificações de conflito.
  update public.leads set summary = null, tags = '{}'::text[] where id = any(v_lead_ids);
  delete from public.lead_notes where workspace_id = p_workspace_id and lead_id = any(v_lead_ids);
  delete from public.case_notes where workspace_id = p_workspace_id and opportunity_id = any(v_opp_ids);
  update public.conflict_checks set note = null where workspace_id = p_workspace_id and lead_id = any(v_lead_ids);
  update public.opportunities set lost_note = null where id = any(v_opp_ids);
  update public.opportunity_requirement_values set value_text = null
  where workspace_id = p_workspace_id and opportunity_id = any(v_opp_ids);
  update public.activities set title = 'Atividade anonimizada', notes = null where id = any(v_activity_ids);
  update public.proposals set decision_note = null where id = any(v_proposal_ids);

  -- WhatsApp: a conversa inteira (mensagens, status e fila de saída em cascata) e a identidade
  -- (telefone e BSUID). O registro técnico do ledger fica (só perde a referência da mensagem).
  delete from public.conversations where workspace_id = p_workspace_id and id = any(v_conv_ids);
  delete from public.whatsapp_identities where workspace_id = p_workspace_id and id = any(v_identity_ids);

  -- Atribuição: o que identifica a pessoa sai; canal, origem, mídia e campanha (métricas) ficam.
  update public.touchpoints
  set gclid = null, fbclid = null, landing_url = null, referrer = null, term = null, content = null
  where id = any(v_touch_ids);
  update public.touchpoint_demand_links set reason = null
  where workspace_id = p_workspace_id and touchpoint_id = any(v_touch_ids);
  delete from public.continuity_references where workspace_id = p_workspace_id and contact_id = p_contact_id;

  -- Campos personalizados (C4): os valores saem; as definições não são tocadas.
  delete from public.custom_field_values
  where workspace_id = p_workspace_id
    and (contact_id = p_contact_id or lead_id = any(v_lead_ids) or opportunity_id = any(v_opp_ids));

  -- Sugestões de duplicidade (apontam para outros contatos e carregam sinais).
  delete from public.duplicate_candidates
  where workspace_id = p_workspace_id and (contact_a_id = p_contact_id or contact_b_id = p_contact_id);

  -- Payload de formulário ainda não expurgado: mesmo efeito do expurgo por validade.
  update public.webhook_events
  set status = case when status = 'processed' then 'processed'::public.webhook_event_status
                    else 'expired_unprocessed'::public.webhook_event_status end,
      payload_ciphertext = null, payload_iv = null, payload_auth_tag = null, payload_algorithm = null,
      payload_key_version = null, payload_sanitized = null, occurred_at = null, purged_at = now()
  where workspace_id = p_workspace_id and purged_at is null
    and (result_contact_id = p_contact_id or result_lead_id = any(v_lead_ids) or result_opportunity_id = any(v_opp_ids));

  -- Auditoria: a linha (ação, ator, data, ids) fica; o metadata dos registros do titular
  -- (alguns guardavam o nome, por exemplo) é esvaziado. Eventos do próprio módulo de
  -- privacidade só carregam ids e códigos e ficam como estão.
  update public.audit_logs
  set metadata = '{}'::jsonb
  where workspace_id = p_workspace_id
    and action not like 'privacy.%'
    and metadata <> '{}'::jsonb
    and (resource_id = p_contact_id
         or resource_id = any(v_lead_ids) or resource_id = any(v_opp_ids) or resource_id = any(v_activity_ids)
         or resource_id = any(v_proposal_ids) or resource_id = any(v_conv_ids) or resource_id = any(v_identity_ids)
         or metadata::text like '%' || p_contact_id::text || '%');

  -- O próprio contato por último.
  update public.contacts
  set name = 'Contato anonimizado', city = null, uf = null, preferred_channel = null, anonymized_at = now()
  where id = p_contact_id and workspace_id = p_workspace_id;

  -- Conferência final: se qualquer coisa prevista ainda estiver acessível (por exemplo, uma
  -- exclusão barrada por gatilho ou regra), a transação inteira é desfeita.
  if exists (select 1 from public.contact_phones where workspace_id = p_workspace_id and contact_id = p_contact_id)
     or exists (select 1 from public.contact_emails where workspace_id = p_workspace_id and contact_id = p_contact_id)
     or exists (select 1 from public.contact_identifiers where workspace_id = p_workspace_id and contact_id = p_contact_id)
     or exists (select 1 from public.contact_sensitive where workspace_id = p_workspace_id and contact_id = p_contact_id)
     or exists (select 1 from public.lead_notes where workspace_id = p_workspace_id and lead_id = any(v_lead_ids))
     or exists (select 1 from public.case_notes where workspace_id = p_workspace_id and opportunity_id = any(v_opp_ids))
     or exists (select 1 from public.conversations where workspace_id = p_workspace_id and id = any(v_conv_ids))
     or exists (select 1 from public.whatsapp_identities where workspace_id = p_workspace_id and id = any(v_identity_ids))
     -- Com os telefones ORIGINAIS: nenhuma conversa ou identidade que os use pode ter sobrado.
     or private.privacy_unlinked_whatsapp(p_workspace_id, v_phone_keys, '{}'::uuid[], '{}'::uuid[])
     or exists (select 1 from public.continuity_references where workspace_id = p_workspace_id and contact_id = p_contact_id)
     or exists (
       select 1 from public.custom_field_values
       where workspace_id = p_workspace_id
         and (contact_id = p_contact_id or lead_id = any(v_lead_ids) or opportunity_id = any(v_opp_ids)))
     or exists (select 1 from public.leads where id = any(v_lead_ids) and (summary is not null or tags <> '{}'::text[]))
     or exists (select 1 from public.activities where id = any(v_activity_ids) and (notes is not null or title <> 'Atividade anonimizada'))
     or not exists (
       select 1 from public.contacts
       where id = p_contact_id and workspace_id = p_workspace_id and anonymized_at is not null and name = 'Contato anonimizado')
  then
    raise exception 'anonymization_incomplete';
  end if;
end;
$body$;
