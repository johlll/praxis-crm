-- C3b — retenção de leads arquivados e anonimização de contato (LGPD operacional).
--
-- Regra desta etapa (decisão aprovada): leads arquivados/perdidos são retidos por
-- 12 MESES, contados a partir do momento EXPLÍCITO em que o lead foi arquivado.
-- Cliente, caso em andamento (oportunidade aberta ou ganha), obrigação de
-- preservação e registro sob bloqueio legal NUNCA são anonimizados automaticamente.
-- O prazo é fixo (sem tela para trocá-lo).
--
-- Tudo aqui é forward-only. Nada de agendador: a chamada periódica do lote entra na
-- B6/C5. A anonimização é TRANSACIONAL e tudo-ou-nada: se qualquer dependência não puder
-- ser tratada com segurança na mesma transação, a operação é recusada com um código
-- fechado — nunca anonimização parcial.

-- ---------------------------------------------------------------------
-- 1) Marco confiável do prazo: leads.archived_at
-- ---------------------------------------------------------------------

alter table public.leads add column archived_at timestamptz;

comment on column public.leads.archived_at is
  'C3b — instante em que o lead passou de ativo para arquivado. Preenchido e limpo SÓ pelo gatilho leads_retention_mark; início da contagem de retenção (12 meses). Nunca updated_at.';

-- Leads já arquivados antes desta migration começam a contar AQUI (não são vencidos por
-- inferência retroativa). O updated_at deles não muda.
alter table public.leads disable trigger leads_set_updated_at;
update public.leads set archived_at = now() where status = 'arquivado';
alter table public.leads enable trigger leads_set_updated_at;

alter table public.leads
  add constraint leads_archived_at_consistency check ((status = 'arquivado') = (archived_at is not null));

-- O gatilho é a ÚNICA fonte do marco: grava ao arquivar, preserva enquanto arquivado e limpa
-- ao reativar. Qualquer valor enviado por quem faz o UPDATE é ignorado.
create function private.leads_retention_mark()
returns trigger
language plpgsql
set search_path = ''
as $body$
begin
  if tg_op = 'INSERT' then
    new.archived_at := case when new.status = 'arquivado' then now() else null end;
  elsif new.status = 'arquivado' then
    new.archived_at := case when old.status = 'arquivado' then old.archived_at else now() end;
  else
    new.archived_at := null;
  end if;
  return new;
end;
$body$;

revoke all on function private.leads_retention_mark() from public, anon, authenticated, service_role;

create trigger leads_retention_mark
  before insert or update on public.leads
  for each row execute function private.leads_retention_mark();

-- ---------------------------------------------------------------------
-- 2) Marca de anonimização do contato
-- ---------------------------------------------------------------------

alter table public.contacts add column anonymized_at timestamptz;

comment on column public.contacts.anonymized_at is
  'C3b — instante da anonimização (irreversível). Contato anonimizado nunca volta a ser processado.';

-- ---------------------------------------------------------------------
-- 3) Preservação legal (bloqueio de anonimização)
--
-- Só estrutura mínima: motivo em CÓDIGO FECHADO, sem texto livre, sem documento, sem parecer.
-- ---------------------------------------------------------------------

create table public.privacy_legal_holds (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  contact_id uuid not null,
  reason_code text not null
    check (reason_code in ('judicial_process', 'legal_obligation', 'case_in_progress', 'regulatory_inquiry', 'other_legal')),
  status text not null default 'active' check (status in ('active', 'released')),
  created_by uuid references public.users (id) on delete set null,
  created_at timestamptz not null default now(),
  released_by uuid references public.users (id) on delete set null,
  released_at timestamptz,
  constraint privacy_legal_holds_contact_fkey
    foreign key (workspace_id, contact_id) references public.contacts (workspace_id, id) on delete cascade,
  constraint privacy_legal_holds_state_shape check (
    (status = 'active' and released_at is null and released_by is null)
    or (status = 'released' and released_at is not null)
  )
);

comment on table public.privacy_legal_holds is
  'C3b — bloqueio de anonimização por preservação legal. Só código fechado; nunca texto livre nem documento.';

-- Um bloqueio ativo por motivo e contato (criar de novo é idempotente).
create unique index privacy_legal_holds_active_key
  on public.privacy_legal_holds (workspace_id, contact_id, reason_code) where status = 'active';
create index privacy_legal_holds_contact_idx
  on public.privacy_legal_holds (workspace_id, contact_id, created_at desc);

alter table public.privacy_legal_holds enable row level security;
alter table public.privacy_legal_holds force row level security;
revoke all on table public.privacy_legal_holds from public, anon, authenticated;

-- Controle de rotação do lote: quando cada contato foi avaliado pela última vez. Sem isto, os
-- mesmos primeiros candidatos (por exemplo, bloqueados para sempre) ocupariam todas as vagas de
-- toda rodada e os demais nunca seriam alcançados. Só ids e horário; fechada como as outras.
create table public.privacy_retention_checks (
  workspace_id uuid not null,
  contact_id uuid not null,
  checked_at timestamptz not null default now(),
  primary key (workspace_id, contact_id),
  constraint privacy_retention_checks_contact_fkey
    foreign key (workspace_id, contact_id) references public.contacts (workspace_id, id) on delete cascade
);

comment on table public.privacy_retention_checks is
  'C3b — última avaliação de retenção de cada contato (rotação justa do lote). Só ids e horário.';

alter table public.privacy_retention_checks enable row level security;
alter table public.privacy_retention_checks force row level security;
revoke all on table public.privacy_retention_checks from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 4) Prazo e avaliação de elegibilidade
-- ---------------------------------------------------------------------

create function private.privacy_retention_interval()
returns interval
language sql
immutable
set search_path = ''
as $body$
  select interval '12 months';
$body$;

revoke all on function private.privacy_retention_interval() from public, anon, authenticated, service_role;

-- Chaves normalizadas que ligam o contato ao WhatsApp: os telefones (E.164) e o identificador
-- "whatsapp" da B3 (o mesmo número sem o "+"). Lidas ANTES de qualquer exclusão e mantidas até a
-- conferência final.
create function private.privacy_contact_phone_keys(p_workspace_id uuid, p_contact_id uuid)
returns text[]
language sql
stable
security definer
set search_path = ''
as $body$
  select coalesce(array_agg(distinct k), '{}'::text[])
  from (
    select value_normalized as k
    from public.contact_phones
    where workspace_id = p_workspace_id and contact_id = p_contact_id
    union
    select case when external_id like '+%' then external_id else '+' || external_id end
    from public.contact_identifiers
    where workspace_id = p_workspace_id and contact_id = p_contact_id and provider = 'whatsapp'
  ) x;
$body$;

revoke all on function private.privacy_contact_phone_keys(uuid, uuid) from public, anon, authenticated, service_role;

-- Existe conversa ou identidade do WhatsApp com alguma dessas chaves que NÃO esteja entre as do
-- próprio contato (ligadas direto a ele, a um lead ou a uma oportunidade dele)? Se existir, nada
-- é apagado por inferência: a operação bloqueia para revisão humana.
create function private.privacy_unlinked_whatsapp(p_workspace_id uuid, p_keys text[], p_conv_ids uuid[], p_identity_ids uuid[])
returns boolean
language sql
stable
security definer
set search_path = ''
as $body$
  select cardinality(p_keys) > 0 and (
    exists (
      select 1 from public.conversations c
      where c.workspace_id = p_workspace_id and c.wa_id = any(p_keys) and not (c.id = any(p_conv_ids)))
    or exists (
      select 1 from public.whatsapp_identities i
      where i.workspace_id = p_workspace_id and i.phone_e164 = any(p_keys) and not (i.id = any(p_identity_ids)))
  );
$body$;

revoke all on function private.privacy_unlinked_whatsapp(uuid, text[], uuid[], uuid[]) from public, anon, authenticated, service_role;

-- Avalia o contato SEM devolver conteúdo pessoal: só estado, datas e códigos fechados.
-- Nulo = contato inexistente, mesclado ou de outro workspace ("não encontrado").
--
-- Códigos de bloqueio (fechados):
--   no_lead, active_lead, retention_period_open, client_present,
--   open_or_won_opportunity, open_proposal, legal_hold_active, merge_history_present,
--   proposal_document_present, calendar_link_present, pending_outbound_message,
--   unlinked_whatsapp_conversation.
--
-- Chamada SEMPRE em instrução própria depois das travas (privacy_lock_subtree), para que a
-- leitura veja o estado já confirmado — por isso não é STABLE.
create function private.privacy_retention_assess(p_workspace_id uuid, p_contact_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_c public.contacts;
  v_total integer;
  v_archived integer;
  v_last timestamptz;
  v_due timestamptz;
  v_reasons text[] := '{}';
  v_lead_ids uuid[];
  v_opp_ids uuid[];
  v_activity_ids uuid[];
  v_proposal_ids uuid[];
  v_conv_ids uuid[];
  v_identity_ids uuid[];
begin
  select * into v_c from public.contacts
  where id = p_contact_id and workspace_id = p_workspace_id and merged_into_contact_id is null;
  if v_c.id is null then return null; end if;

  if v_c.anonymized_at is not null then
    return jsonb_build_object(
      'state', 'anonymized', 'eligible', false, 'reasons', '[]'::jsonb,
      'lead_count', 0, 'archived_lead_count', 0, 'retention_due_at', null, 'anonymized_at', v_c.anonymized_at);
  end if;

  select count(*), count(*) filter (where status = 'arquivado' and archived_at is not null),
         max(archived_at) filter (where status = 'arquivado'),
         coalesce(array_agg(id), '{}'::uuid[])
    into v_total, v_archived, v_last, v_lead_ids
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

  if v_total = 0 then
    v_reasons := array_append(v_reasons, 'no_lead');
  elsif v_archived < v_total then
    v_reasons := array_append(v_reasons, 'active_lead');
  else
    -- Todos arquivados: o prazo conta do marco MAIS RECENTE, e só vence com 12 meses completos.
    v_due := ((v_last at time zone 'UTC') + private.privacy_retention_interval()) at time zone 'UTC';
    if now() < v_due then v_reasons := array_append(v_reasons, 'retention_period_open'); end if;
  end if;

  if exists (select 1 from public.clients where workspace_id = p_workspace_id and contact_id = p_contact_id) then
    v_reasons := array_append(v_reasons, 'client_present');
  end if;
  if exists (
    select 1 from public.opportunities
    where workspace_id = p_workspace_id and id = any(v_opp_ids) and status in ('open', 'won')
  ) then
    v_reasons := array_append(v_reasons, 'open_or_won_opportunity');
  end if;
  -- Proposta enviada ou aceita é processo comercial sem desfecho: não se anonimiza no meio dele.
  if exists (
    select 1 from public.proposals
    where workspace_id = p_workspace_id and id = any(v_proposal_ids) and status in ('enviada', 'aceita')
  ) then
    v_reasons := array_append(v_reasons, 'open_proposal');
  end if;
  if exists (
    select 1 from public.privacy_legal_holds
    where workspace_id = p_workspace_id and contact_id = p_contact_id and status = 'active'
  ) then
    v_reasons := array_append(v_reasons, 'legal_hold_active');
  end if;
  -- Contato absorvido por mesclagem ou histórico de mesclagem: as linhas do outro contato
  -- guardam dado pessoal que esta operação não trata.
  if exists (select 1 from public.contacts where workspace_id = p_workspace_id and merged_into_contact_id = p_contact_id)
     or exists (
       select 1 from public.contact_merges
       where workspace_id = p_workspace_id and (kept_contact_id = p_contact_id or merged_contact_id = p_contact_id)
     ) then
    v_reasons := array_append(v_reasons, 'merge_history_present');
  end if;
  -- PDFs e e-mails de proposta moram em armazenamento externo: nada de apagar fora da transação.
  if exists (
    select 1 from public.proposal_documents where workspace_id = p_workspace_id and proposal_id = any(v_proposal_ids)
  ) then
    v_reasons := array_append(v_reasons, 'proposal_document_present');
  end if;
  -- Evento de agenda no Google guarda o título da atividade fora do banco.
  if exists (
    select 1 from public.calendar_event_links where workspace_id = p_workspace_id and activity_id = any(v_activity_ids)
  ) or exists (
    select 1 from public.calendar_effect_intents where workspace_id = p_workspace_id and activity_id = any(v_activity_ids)
  ) then
    v_reasons := array_append(v_reasons, 'calendar_link_present');
  end if;
  -- Mensagem de saída ainda em andamento: apagá-la silenciosamente perderia um envio.
  if exists (
    select 1 from public.whatsapp_outbox
    where workspace_id = p_workspace_id and conversation_id = any(v_conv_ids) and state in ('reserved', 'sending', 'uncertain')
  ) then
    v_reasons := array_append(v_reasons, 'pending_outbound_message');
  end if;
  -- Conversa de WhatsApp que só se acha pelo telefone (sem vínculo com o contato, lead ou
  -- oportunidade): pode ser da mesma pessoa, mas apagá-la seria inferência. Revisão humana.
  if private.privacy_unlinked_whatsapp(
    p_workspace_id, private.privacy_contact_phone_keys(p_workspace_id, p_contact_id), v_conv_ids, v_identity_ids
  ) then
    v_reasons := array_append(v_reasons, 'unlinked_whatsapp_conversation');
  end if;

  return jsonb_build_object(
    'state', case when cardinality(v_reasons) = 0 then 'eligible' else 'blocked' end,
    'eligible', cardinality(v_reasons) = 0,
    'reasons', to_jsonb(v_reasons),
    'lead_count', v_total,
    'archived_lead_count', v_archived,
    'retention_due_at', v_due,
    'anonymized_at', null);
end;
$body$;

revoke all on function private.privacy_retention_assess(uuid, uuid) from public, anon, authenticated, service_role;

-- Trava os registros que decidem a elegibilidade (leads e oportunidades do contato), na mesma
-- transação e depois da trava do contato: reativar um lead ou mexer numa oportunidade enquanto
-- a anonimização decide passa a esperar — e a decisão é relida depois da espera.
create function private.privacy_lock_subtree(p_workspace_id uuid, p_contact_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $body$
begin
  perform 1 from public.leads where workspace_id = p_workspace_id and contact_id = p_contact_id for update;
  perform 1 from public.opportunities
  where workspace_id = p_workspace_id
    and lead_id in (select id from public.leads where workspace_id = p_workspace_id and contact_id = p_contact_id)
  for update;
end;
$body$;

revoke all on function private.privacy_lock_subtree(uuid, uuid) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------
-- 5) A anonimização em si (tudo na transação de quem chama)
--
-- Remove ou substitui, de forma irreversível, o dado pessoal e o texto associado, e preserva só
-- o ESQUELETO: ids, relações, datas, etapas, valores estruturados (métricas) e a auditoria
-- sem conteúdo. Sem nenhuma cópia: não existe "desfazer".
--
-- Trata: contato, telefones, e-mails, identificadores, CPF/CNPJ cifrado, consentimentos e
-- evidências, textos de leads/oportunidades/atividades/propostas/notas/verificações de
-- conflito, conversas do WhatsApp (mensagens, status, fila de saída e identidades), dados
-- pessoais da atribuição (gclid, fbclid, URLs, referência, termos, motivo do vínculo),
-- referências de continuidade, campos personalizados, candidatos a duplicidade, payload de
-- formulário ainda não expurgado e o metadata da auditoria dos registros do titular.
--
-- Nunca chamada fora de uma avaliação favorável sob as travas do contato.
-- ---------------------------------------------------------------------

create function private.privacy_anonymize_contact(p_workspace_id uuid, p_contact_id uuid)
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

revoke all on function private.privacy_anonymize_contact(uuid, uuid) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------
-- 5b) Contato anonimizado e o ESQUELETO que ele preservou são IMUTÁVEIS
--
-- Depois de contacts.anonymized_at, nenhum INSERT nem UPDATE chega ao contato nem a qualquer
-- registro ligado a ele: lead, oportunidade, atividade, proposta, verificação de conflito,
-- requisitos, notas, campos personalizados, conversas, atribuição, consentimentos, valores e
-- histórico. Nem mudança "técnica" (estado, responsável, prioridade, etapa, datas, versão,
-- updated_at): reativar um lead, mover uma oportunidade ou concluir uma atividade reutilizaria o
-- histórico de uma pessoa que já não pode ser identificada. Novo atendimento exige um contato
-- NOVO. Só o DELETE (exclusão administrativa, em cascata) continua permitido. A proteção é do
-- banco (gatilhos); a tela e as funções da aplicação apenas traduzem o código fechado
-- `contact_anonymized`, que só aparece para quem já enxerga o registro (as funções da aplicação
-- respondem "não encontrado" a outro workspace antes de chegar aqui). A anonimização em si grava
-- ANTES da marca (e a marca é a última escrita), por isso não esbarra nestes gatilhos.
-- ---------------------------------------------------------------------

-- As leituras abaixo TRAVAM a linha do contato (FOR KEY SHARE) e por isso são VOLATILE: uma escrita que
-- chega enquanto a anonimização ainda não confirmou (ela segura o contato FOR UPDATE) ESPERA o commit e
-- relê o contato já anonimizado — sem isso, um lead ou atividade novo (ex.: a pessoa voltou a escrever no
-- mesmo instante) entraria no esqueleto logo depois da anonimização. KEY SHARE não conflita com outras
-- escritas comuns; só com a trava exclusiva da anonimização.

create function private.privacy_contact_anonymized(p_contact_id uuid)
returns boolean
language sql
volatile
security definer
set search_path = ''
as $body$
  select coalesce((
    select c.anonymized_at is not null
    from public.contacts c
    where c.id = p_contact_id
    for key share of c), false);
$body$;

create function private.privacy_lead_anonymized(p_lead_id uuid)
returns boolean
language sql
volatile
security definer
set search_path = ''
as $body$
  select coalesce((
    select c.anonymized_at is not null
    from public.leads l join public.contacts c on c.id = l.contact_id and c.workspace_id = l.workspace_id
    where l.id = p_lead_id
    for key share of c), false);
$body$;

create function private.privacy_opportunity_anonymized(p_opportunity_id uuid)
returns boolean
language sql
volatile
security definer
set search_path = ''
as $body$
  select coalesce((
    select c.anonymized_at is not null
    from public.opportunities o
    join public.leads l on l.id = o.lead_id and l.workspace_id = o.workspace_id
    join public.contacts c on c.id = l.contact_id and c.workspace_id = l.workspace_id
    where o.id = p_opportunity_id
    for key share of c), false);
$body$;

create function private.privacy_client_anonymized(p_client_id uuid)
returns boolean
language sql
volatile
security definer
set search_path = ''
as $body$
  select coalesce((
    select c.anonymized_at is not null
    from public.clients cl join public.contacts c on c.id = cl.contact_id and c.workspace_id = cl.workspace_id
    where cl.id = p_client_id
    for key share of c), false);
$body$;

revoke all on function private.privacy_contact_anonymized(uuid) from public, anon, authenticated, service_role;
revoke all on function private.privacy_lead_anonymized(uuid) from public, anon, authenticated, service_role;
revoke all on function private.privacy_opportunity_anonymized(uuid) from public, anon, authenticated, service_role;
revoke all on function private.privacy_client_anonymized(uuid) from public, anon, authenticated, service_role;

create function private.privacy_proposal_anonymized(p_proposal_id uuid)
returns boolean
language sql
volatile
security definer
set search_path = ''
as $body$
  select coalesce((
    select c.anonymized_at is not null
    from public.proposals p
    join public.leads l on l.id = p.lead_id and l.workspace_id = p.workspace_id
    join public.contacts c on c.id = l.contact_id and c.workspace_id = l.workspace_id
    where p.id = p_proposal_id
    for key share of c), false);
$body$;

revoke all on function private.privacy_proposal_anonymized(uuid) from public, anon, authenticated, service_role;

create function private.privacy_anonymized_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_hit boolean := false;
begin
  -- Regra única: depois de contacts.anonymized_at, NENHUM INSERT nem UPDATE chega ao contato nem a
  -- qualquer registro ligado ao esqueleto que ele preservou (nem "técnico": updated_at, versão,
  -- estado, datas). Só DELETE passa (estes gatilhos não o interceptam). Em UPDATE, o dono
  -- ANTIGO também conta, para ninguém tirar um registro do esqueleto nem trocá-lo de dono.
  case tg_table_name
    when 'contacts' then
      -- Só UPDATE. A própria marca (nulo -> data) é a última escrita da anonimização e passa;
      -- depois dela o contato inteiro é imutável.
      if old.anonymized_at is not null then
        v_hit := true;
      end if;
      -- Ninguém é absorvido por um contato anonimizado.
      if not v_hit and new.merged_into_contact_id is not null
         and new.merged_into_contact_id is distinct from old.merged_into_contact_id then
        v_hit := private.privacy_contact_anonymized(new.merged_into_contact_id);
      end if;

    when 'contact_merges' then
      v_hit := private.privacy_contact_anonymized(new.kept_contact_id) or private.privacy_contact_anonymized(new.merged_contact_id);
      if not v_hit and tg_op = 'UPDATE' then
        v_hit := private.privacy_contact_anonymized(old.kept_contact_id) or private.privacy_contact_anonymized(old.merged_contact_id);
      end if;

    when 'contact_phones', 'contact_emails', 'contact_identifiers', 'contact_sensitive', 'contact_consents',
         'consent_evidence', 'clients' then
      v_hit := private.privacy_contact_anonymized(new.contact_id);
      if not v_hit and tg_op = 'UPDATE' then v_hit := private.privacy_contact_anonymized(old.contact_id); end if;

    when 'continuity_references' then
      v_hit := private.privacy_contact_anonymized(new.contact_id)
            or (new.lead_id is not null and private.privacy_lead_anonymized(new.lead_id));
      if not v_hit and tg_op = 'UPDATE' then
        v_hit := private.privacy_contact_anonymized(old.contact_id)
              or (old.lead_id is not null and private.privacy_lead_anonymized(old.lead_id));
      end if;

    when 'touchpoints' then
      -- O contato, o lead e a oportunidade: reaproveitar o histórico de um anonimizado num atendimento
      -- novo (por um vínculo) também é reuso.
      v_hit := private.privacy_contact_anonymized(new.contact_id)
            or (new.lead_id is not null and private.privacy_lead_anonymized(new.lead_id))
            or (new.opportunity_id is not null and private.privacy_opportunity_anonymized(new.opportunity_id));
      if not v_hit and tg_op = 'UPDATE' then
        v_hit := private.privacy_contact_anonymized(old.contact_id)
              or (old.lead_id is not null and private.privacy_lead_anonymized(old.lead_id))
              or (old.opportunity_id is not null and private.privacy_opportunity_anonymized(old.opportunity_id));
      end if;

    when 'touchpoint_demand_links' then
      v_hit := coalesce((
                 select private.privacy_contact_anonymized(t.contact_id) from public.touchpoints t where t.id = new.touchpoint_id), false)
            or (new.opportunity_id is not null and private.privacy_opportunity_anonymized(new.opportunity_id));
      if not v_hit and tg_op = 'UPDATE' then
        v_hit := coalesce((
                   select private.privacy_contact_anonymized(t.contact_id) from public.touchpoints t where t.id = old.touchpoint_id), false)
              or (old.opportunity_id is not null and private.privacy_opportunity_anonymized(old.opportunity_id));
      end if;

    when 'leads' then
      v_hit := private.privacy_contact_anonymized(new.contact_id);
      if not v_hit and tg_op = 'UPDATE' then v_hit := private.privacy_contact_anonymized(old.contact_id); end if;

    when 'lead_notes', 'conflict_checks', 'activities', 'proposals', 'lead_values', 'automation_events', 'opportunities' then
      v_hit := private.privacy_lead_anonymized(new.lead_id);
      if not v_hit and tg_op = 'UPDATE' then v_hit := private.privacy_lead_anonymized(old.lead_id); end if;

    when 'opportunity_requirement_values', 'stage_transitions' then
      v_hit := private.privacy_opportunity_anonymized(new.opportunity_id);
      if not v_hit and tg_op = 'UPDATE' then v_hit := private.privacy_opportunity_anonymized(old.opportunity_id); end if;

    when 'proposal_documents', 'proposal_email_sends' then
      v_hit := private.privacy_proposal_anonymized(new.proposal_id);
      if not v_hit and tg_op = 'UPDATE' then v_hit := private.privacy_proposal_anonymized(old.proposal_id); end if;

    when 'duplicate_candidates' then
      v_hit := private.privacy_contact_anonymized(new.contact_a_id) or private.privacy_contact_anonymized(new.contact_b_id);
      if not v_hit and tg_op = 'UPDATE' then
        v_hit := private.privacy_contact_anonymized(old.contact_a_id) or private.privacy_contact_anonymized(old.contact_b_id);
      end if;

    when 'custom_field_values' then
      v_hit := (new.contact_id is not null and private.privacy_contact_anonymized(new.contact_id))
            or (new.lead_id is not null and private.privacy_lead_anonymized(new.lead_id))
            or (new.opportunity_id is not null and private.privacy_opportunity_anonymized(new.opportunity_id))
            or (new.client_id is not null and private.privacy_client_anonymized(new.client_id));
      if not v_hit and tg_op = 'UPDATE' then
        v_hit := (old.contact_id is not null and private.privacy_contact_anonymized(old.contact_id))
              or (old.lead_id is not null and private.privacy_lead_anonymized(old.lead_id))
              or (old.opportunity_id is not null and private.privacy_opportunity_anonymized(old.opportunity_id))
              or (old.client_id is not null and private.privacy_client_anonymized(old.client_id));
      end if;

    when 'conversations' then
      v_hit := (new.contact_id is not null and private.privacy_contact_anonymized(new.contact_id))
            or (new.lead_id is not null and private.privacy_lead_anonymized(new.lead_id))
            or (new.opportunity_id is not null and private.privacy_opportunity_anonymized(new.opportunity_id));
      if not v_hit and tg_op = 'UPDATE' then
        v_hit := (old.contact_id is not null and private.privacy_contact_anonymized(old.contact_id))
              or (old.lead_id is not null and private.privacy_lead_anonymized(old.lead_id))
              or (old.opportunity_id is not null and private.privacy_opportunity_anonymized(old.opportunity_id));
      end if;

    else
      null;
  end case;

  if v_hit then
    raise exception 'contact_anonymized';
  end if;
  return new;
end;
$body$;

revoke all on function private.privacy_anonymized_guard() from public, anon, authenticated, service_role;

create trigger contacts_anonymized_guard before update on public.contacts
  for each row execute function private.privacy_anonymized_guard();
create trigger contact_merges_anonymized_guard before insert or update on public.contact_merges
  for each row execute function private.privacy_anonymized_guard();
create trigger contact_phones_anonymized_guard before insert or update on public.contact_phones
  for each row execute function private.privacy_anonymized_guard();
create trigger contact_emails_anonymized_guard before insert or update on public.contact_emails
  for each row execute function private.privacy_anonymized_guard();
create trigger contact_identifiers_anonymized_guard before insert or update on public.contact_identifiers
  for each row execute function private.privacy_anonymized_guard();
create trigger contact_sensitive_anonymized_guard before insert or update on public.contact_sensitive
  for each row execute function private.privacy_anonymized_guard();
create trigger contact_consents_anonymized_guard before insert or update on public.contact_consents
  for each row execute function private.privacy_anonymized_guard();
create trigger consent_evidence_anonymized_guard before insert or update on public.consent_evidence
  for each row execute function private.privacy_anonymized_guard();
create trigger continuity_references_anonymized_guard before insert or update on public.continuity_references
  for each row execute function private.privacy_anonymized_guard();
create trigger touchpoints_anonymized_guard before insert or update on public.touchpoints
  for each row execute function private.privacy_anonymized_guard();
create trigger touchpoint_demand_links_anonymized_guard before insert or update on public.touchpoint_demand_links
  for each row execute function private.privacy_anonymized_guard();
create trigger clients_anonymized_guard before insert or update on public.clients
  for each row execute function private.privacy_anonymized_guard();
create trigger leads_anonymized_guard before insert or update on public.leads
  for each row execute function private.privacy_anonymized_guard();
create trigger lead_notes_anonymized_guard before insert or update on public.lead_notes
  for each row execute function private.privacy_anonymized_guard();
create trigger conflict_checks_anonymized_guard before insert or update on public.conflict_checks
  for each row execute function private.privacy_anonymized_guard();
create trigger activities_anonymized_guard before insert or update on public.activities
  for each row execute function private.privacy_anonymized_guard();
create trigger opportunities_anonymized_guard before insert or update on public.opportunities
  for each row execute function private.privacy_anonymized_guard();
create trigger proposals_anonymized_guard before insert or update on public.proposals
  for each row execute function private.privacy_anonymized_guard();
create trigger opportunity_requirement_values_anonymized_guard before insert or update on public.opportunity_requirement_values
  for each row execute function private.privacy_anonymized_guard();
create trigger custom_field_values_anonymized_guard before insert or update on public.custom_field_values
  for each row execute function private.privacy_anonymized_guard();
create trigger conversations_anonymized_guard before insert or update on public.conversations
  for each row execute function private.privacy_anonymized_guard();
create trigger automation_events_anonymized_guard before insert or update on public.automation_events
  for each row execute function private.privacy_anonymized_guard();
create trigger lead_values_anonymized_guard before insert or update on public.lead_values
  for each row execute function private.privacy_anonymized_guard();
create trigger stage_transitions_anonymized_guard before insert or update on public.stage_transitions
  for each row execute function private.privacy_anonymized_guard();
create trigger proposal_documents_anonymized_guard before insert or update on public.proposal_documents
  for each row execute function private.privacy_anonymized_guard();
create trigger proposal_email_sends_anonymized_guard before insert or update on public.proposal_email_sends
  for each row execute function private.privacy_anonymized_guard();
create trigger duplicate_candidates_anonymized_guard before insert or update on public.duplicate_candidates
  for each row execute function private.privacy_anonymized_guard();

-- ---------------------------------------------------------------------
-- 6) RPCs — EXCLUSIVAS DO SERVIDOR (service_role), no padrão da C3a
--
-- Ator e workspace ATIVO vêm do contexto confiável do servidor (requirePermissionSafe) e
-- chegam como parâmetros; o banco confere de novo (ator existente, membership ativa e papel
-- owner/admin NESSE workspace, contato e bloqueio pertencentes exatamente a ele). Contato
-- inexistente, mesclado ou de outro workspace responde "não encontrado". Nada aqui devolve
-- conteúdo pessoal.
-- ---------------------------------------------------------------------

-- Estado da retenção: elegibilidade, prazo, motivos de bloqueio (códigos) e preservações.
create function public.get_privacy_retention_status(p_actor_user_id uuid, p_workspace_id uuid, p_contact_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_role public.membership_role;
  v_assess jsonb;
begin
  if p_actor_user_id is null then raise exception 'authentication_required'; end if;

  v_role := private.privacy_export_actor_role(p_actor_user_id, p_workspace_id);
  if v_role is null then raise exception 'contact_not_found'; end if;
  if v_role not in ('owner', 'admin') then raise exception 'insufficient_permission'; end if;

  v_assess := private.privacy_retention_assess(p_workspace_id, p_contact_id);
  if v_assess is null then raise exception 'contact_not_found'; end if;

  return v_assess || jsonb_build_object(
    'retention_months', 12,
    'holds', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', h.id, 'reason_code', h.reason_code, 'status', h.status,
        'created_at', h.created_at, 'released_at', h.released_at) order by h.created_at, h.id)
      from public.privacy_legal_holds h
      where h.workspace_id = p_workspace_id and h.contact_id = p_contact_id
    ), '[]'::jsonb));
end;
$body$;

-- Cria a preservação legal. Repetir o mesmo motivo com bloqueio ativo é idempotente.
create function public.create_privacy_legal_hold(p_actor_user_id uuid, p_workspace_id uuid, p_contact_id uuid, p_reason_code text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_role public.membership_role;
  v_contact public.contacts;
  v_id uuid;
begin
  if p_actor_user_id is null then raise exception 'authentication_required'; end if;

  v_role := private.privacy_export_actor_role(p_actor_user_id, p_workspace_id);
  if v_role is null then raise exception 'contact_not_found'; end if;
  if v_role not in ('owner', 'admin') then raise exception 'insufficient_permission'; end if;

  if p_reason_code is null
     or p_reason_code not in ('judicial_process', 'legal_obligation', 'case_in_progress', 'regulatory_inquiry', 'other_legal') then
    raise exception 'invalid_legal_hold_reason';
  end if;

  -- A mesma trava da anonimização: criar o bloqueio e anonimizar nunca correm ao mesmo tempo.
  select * into v_contact from public.contacts
  where id = p_contact_id and workspace_id = p_workspace_id and merged_into_contact_id is null
  for update;
  if v_contact.id is null then raise exception 'contact_not_found'; end if;
  if v_contact.anonymized_at is not null then raise exception 'contact_already_anonymized'; end if;

  select id into v_id from public.privacy_legal_holds
  where workspace_id = p_workspace_id and contact_id = p_contact_id and reason_code = p_reason_code and status = 'active';
  if v_id is not null then return v_id; end if;

  insert into public.privacy_legal_holds (workspace_id, contact_id, reason_code, created_by)
  values (p_workspace_id, p_contact_id, p_reason_code, p_actor_user_id)
  returning id into v_id;

  insert into public.audit_logs (workspace_id, actor_user_id, action, resource_type, resource_id, metadata)
  values (p_workspace_id, p_actor_user_id, 'privacy.legal_hold_created', 'privacy_legal_hold', v_id,
          jsonb_build_object('contact_id', p_contact_id, 'reason_code', p_reason_code));

  return v_id;
end;
$body$;

-- Encerra a preservação. Encerrar um bloqueio já encerrado não faz nada.
create function public.release_privacy_legal_hold(p_actor_user_id uuid, p_workspace_id uuid, p_hold_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_role public.membership_role;
  v_hold public.privacy_legal_holds;
begin
  if p_actor_user_id is null then raise exception 'authentication_required'; end if;

  v_role := private.privacy_export_actor_role(p_actor_user_id, p_workspace_id);
  if v_role is null then raise exception 'legal_hold_not_found'; end if;
  if v_role not in ('owner', 'admin') then raise exception 'insufficient_permission'; end if;

  select * into v_hold from public.privacy_legal_holds
  where id = p_hold_id and workspace_id = p_workspace_id
  for update;
  if v_hold.id is null then raise exception 'legal_hold_not_found'; end if;
  if v_hold.status = 'released' then return; end if;

  update public.privacy_legal_holds
  set status = 'released', released_by = p_actor_user_id, released_at = now()
  where id = v_hold.id;

  insert into public.audit_logs (workspace_id, actor_user_id, action, resource_type, resource_id, metadata)
  values (p_workspace_id, p_actor_user_id, 'privacy.legal_hold_released', 'privacy_legal_hold', v_hold.id,
          jsonb_build_object('contact_id', v_hold.contact_id, 'reason_code', v_hold.reason_code));
end;
$body$;

-- Anonimização manual. Reavalia a elegibilidade DENTRO da transação, sob a trava do contato:
-- se mudou desde a prévia, recusa com os códigos. Idempotente. Recusa e falha NÃO desfazem a
-- auditoria (voltam como resultado, não como exceção); permissão negada e contato inexistente
-- desfazem a chamada inteira, sem deixar rastro.
create function public.anonymize_privacy_contact(p_actor_user_id uuid, p_workspace_id uuid, p_contact_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_role public.membership_role;
  v_contact public.contacts;
  v_assess jsonb;
  v_failed boolean := false;
begin
  if p_actor_user_id is null then raise exception 'authentication_required'; end if;

  v_role := private.privacy_export_actor_role(p_actor_user_id, p_workspace_id);
  if v_role is null then raise exception 'contact_not_found'; end if;
  if v_role not in ('owner', 'admin') then raise exception 'insufficient_permission'; end if;

  select * into v_contact from public.contacts
  where id = p_contact_id and workspace_id = p_workspace_id and merged_into_contact_id is null
  for update;
  if v_contact.id is null then raise exception 'contact_not_found'; end if;

  if v_contact.anonymized_at is not null then
    return jsonb_build_object('result', 'already_anonymized');
  end if;

  insert into public.audit_logs (workspace_id, actor_user_id, action, resource_type, resource_id, metadata)
  values (p_workspace_id, p_actor_user_id, 'privacy.anonymization_requested', 'contact', p_contact_id,
          jsonb_build_object('contact_id', p_contact_id, 'trigger', 'manual'));

  perform private.privacy_lock_subtree(p_workspace_id, p_contact_id);
  v_assess := private.privacy_retention_assess(p_workspace_id, p_contact_id);

  if jsonb_array_length(v_assess -> 'reasons') > 0 then
    insert into public.audit_logs (workspace_id, actor_user_id, action, resource_type, resource_id, metadata)
    values (p_workspace_id, p_actor_user_id, 'privacy.anonymization_refused', 'contact', p_contact_id,
            jsonb_build_object('contact_id', p_contact_id, 'trigger', 'manual', 'reasons', v_assess -> 'reasons'));
    return jsonb_build_object('result', 'refused', 'reasons', v_assess -> 'reasons');
  end if;

  -- Subtransação: qualquer erro desfaz TUDO o que a anonimização fez (nunca parcial). O texto
  -- do erro não é guardado nem devolvido.
  begin
    perform private.privacy_anonymize_contact(p_workspace_id, p_contact_id);
  exception when others then
    v_failed := true;
  end;

  if v_failed then
    insert into public.audit_logs (workspace_id, actor_user_id, action, resource_type, resource_id, metadata)
    values (p_workspace_id, p_actor_user_id, 'privacy.anonymization_failed', 'contact', p_contact_id,
            jsonb_build_object('contact_id', p_contact_id, 'trigger', 'manual', 'result_code', 'internal_error'));
    return jsonb_build_object('result', 'failed', 'code', 'internal_error');
  end if;

  insert into public.audit_logs (workspace_id, actor_user_id, action, resource_type, resource_id, metadata)
  values (p_workspace_id, p_actor_user_id, 'privacy.anonymization_completed', 'contact', p_contact_id,
          jsonb_build_object('contact_id', p_contact_id, 'trigger', 'manual'));

  return jsonb_build_object('result', 'anonymized');
end;
$body$;

-- ---------------------------------------------------------------------
-- 7) Lote — operação do SISTEMA (só service_role, sem ator humano)
--
-- Seleciona apenas contatos com todos os leads arquivados e prazo completo, sem preservação
-- ativa, e confirma cada um sob a trava antes de agir. `for update ... skip locked`: dois
-- processadores ao mesmo tempo nunca pegam o mesmo contato (quem chega depois pula o travado
-- e, ao receber a trava de um já concluído, relê o estado e o ignora). Cada contato roda em
-- sua própria subtransação: uma falha desfaz só ele e o lote segue. Devolve apenas contagens.
-- ---------------------------------------------------------------------

-- Soma 1 à contagem (processed|blocked|failed) de um workspace dentro de um jsonb de contagens.
create function private.privacy_batch_count(p_counts jsonb, p_workspace_id uuid, p_key text)
returns jsonb
language sql
immutable
set search_path = ''
as $body$
  select jsonb_set(
    case when p_counts ? p_workspace_id::text then p_counts
         else p_counts || jsonb_build_object(p_workspace_id::text, '{}'::jsonb) end,
    array[p_workspace_id::text, p_key],
    to_jsonb(coalesce((p_counts -> p_workspace_id::text ->> p_key)::integer, 0) + 1),
    true);
$body$;

revoke all on function private.privacy_batch_count(jsonb, uuid, text) from public, anon, authenticated, service_role;

create function public.run_privacy_retention_batch(p_limit integer default 50)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_limit integer := greatest(1, least(coalesce(p_limit, 50), 200));
  v_row record;
  v_assess jsonb;
  v_failed boolean;
  v_examined integer := 0;
  v_processed integer := 0;
  v_blocked integer := 0;
  v_failures integer := 0;
  v_counts jsonb := '{}'::jsonb;
  v_ws text;
begin

  for v_row in
    select c.workspace_id, c.id
    from public.contacts c
    left join public.privacy_retention_checks k on k.workspace_id = c.workspace_id and k.contact_id = c.id
    where c.merged_into_contact_id is null
      and c.anonymized_at is null
      and exists (select 1 from public.leads l where l.workspace_id = c.workspace_id and l.contact_id = c.id)
      and not exists (
        select 1 from public.leads l
        where l.workspace_id = c.workspace_id and l.contact_id = c.id
          and (l.status <> 'arquivado' or l.archived_at is null))
      and ((select max(l.archived_at) from public.leads l where l.workspace_id = c.workspace_id and l.contact_id = c.id)
             at time zone 'UTC' + private.privacy_retention_interval()) at time zone 'UTC' <= now()
      and not exists (
        select 1 from public.privacy_legal_holds h
        where h.workspace_id = c.workspace_id and h.contact_id = c.id and h.status = 'active')
    -- Quem foi avaliado há mais tempo (ou nunca) vem primeiro: a rotação passa por todos.
    order by k.checked_at nulls first, c.workspace_id, c.id
    limit v_limit
    for update of c skip locked
  loop
    -- O limite vale para os candidatos AVALIADOS (processados + bloqueados + falhos), não só
    -- para as conclusões. O que sobrar fica para a rodada seguinte.
    exit when v_examined >= v_limit;
    v_examined := v_examined + 1;

    insert into public.privacy_retention_checks (workspace_id, contact_id, checked_at)
    values (v_row.workspace_id, v_row.id, clock_timestamp())
    on conflict (workspace_id, contact_id) do update set checked_at = excluded.checked_at;

    perform private.privacy_lock_subtree(v_row.workspace_id, v_row.id);
    v_assess := private.privacy_retention_assess(v_row.workspace_id, v_row.id);

    -- Concluído por outro processador enquanto esperávamos a trava, ou não mais elegível.
    if v_assess is null or v_assess ->> 'state' = 'anonymized' then
      continue;
    end if;
    if jsonb_array_length(v_assess -> 'reasons') > 0 then
      v_blocked := v_blocked + 1;
      v_counts := private.privacy_batch_count(v_counts, v_row.workspace_id, 'blocked');
      continue;
    end if;

    v_failed := false;
    begin
      perform private.privacy_anonymize_contact(v_row.workspace_id, v_row.id);
    exception when others then
      v_failed := true;
    end;

    if v_failed then
      v_failures := v_failures + 1;
      v_counts := private.privacy_batch_count(v_counts, v_row.workspace_id, 'failed');
      insert into public.audit_logs (workspace_id, actor_user_id, action, resource_type, resource_id, metadata)
      values (v_row.workspace_id, null, 'privacy.anonymization_failed', 'contact', v_row.id,
              jsonb_build_object('contact_id', v_row.id, 'trigger', 'retention', 'result_code', 'internal_error'));
    else
      v_processed := v_processed + 1;
      v_counts := private.privacy_batch_count(v_counts, v_row.workspace_id, 'processed');
      insert into public.audit_logs (workspace_id, actor_user_id, action, resource_type, resource_id, metadata)
      values (v_row.workspace_id, null, 'privacy.anonymization_completed', 'contact', v_row.id,
              jsonb_build_object('contact_id', v_row.id, 'trigger', 'retention'));
    end if;
  end loop;

  -- Um resumo por workspace que teve algo concluído ou falho — só contagens.
  for v_ws in select k from jsonb_object_keys(v_counts) as k loop
    if coalesce((v_counts -> v_ws ->> 'processed')::integer, 0) > 0 or coalesce((v_counts -> v_ws ->> 'failed')::integer, 0) > 0 then
      insert into public.audit_logs (workspace_id, actor_user_id, action, resource_type, resource_id, metadata)
      values (v_ws::uuid, null, 'privacy.retention_processed', 'workspace', v_ws::uuid,
              jsonb_build_object(
                'processed', coalesce((v_counts -> v_ws ->> 'processed')::integer, 0),
                'blocked', coalesce((v_counts -> v_ws ->> 'blocked')::integer, 0),
                'failed', coalesce((v_counts -> v_ws ->> 'failed')::integer, 0)));
    end if;
  end loop;

  return jsonb_build_object('processed', v_processed, 'blocked', v_blocked, 'failed', v_failures);
end;
$body$;

-- ACL final: somente service_role (e o dono postgres). anon, authenticated e PUBLIC não executam.
revoke all on function public.get_privacy_retention_status(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.get_privacy_retention_status(uuid, uuid, uuid) to service_role;

revoke all on function public.create_privacy_legal_hold(uuid, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.create_privacy_legal_hold(uuid, uuid, uuid, text) to service_role;

revoke all on function public.release_privacy_legal_hold(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.release_privacy_legal_hold(uuid, uuid, uuid) to service_role;

revoke all on function public.anonymize_privacy_contact(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.anonymize_privacy_contact(uuid, uuid, uuid) to service_role;

revoke all on function public.run_privacy_retention_batch(integer) from public, anon, authenticated;
grant execute on function public.run_privacy_retention_batch(integer) to service_role;
