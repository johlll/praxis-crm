-- Conversas + IA — horário de ORIGEM das mensagens (pré-requisito do aplicador automático).
--
-- Três instantes que não podem se confundir:
--   * quando a mensagem ocorreu na origem  -> messages.origin_time_at (NOVO, comprovado ou ausente);
--   * quando ela chegou ao CRM             -> messages.created_at (inalterado);
--   * qual fonte comprova o horário        -> messages.origin_time_source (NOVO).
-- `created_at` nunca é horário de origem: uma mensagem antiga que chega atrasada continua antiga.
--
-- ADITIVA: três colunas, três gatilhos, uma função pública só do servidor (service_role) e funções
-- privadas. Nenhum efeito da B3 foi reescrito (recebimento, saída observada, status, custo,
-- idempotência e isolamento seguem byte a byte); nenhum dado existente muda; NÃO há backfill: toda
-- mensagem anterior continua com origem DESCONHECIDA (colunas nulas) e, portanto, inelegível.
--
-- Fontes de horário de origem (as únicas que o banco aceita):
--   provider_send_time  horário da mensagem informado pelo provedor (YCloud `sendTime`) em evento
--                       assinado e já aplicado pela B3. Entra SÓ por
--                       whatsapp_record_message_origin_time (service_role), ligado ao ledger do
--                       evento: quem chama não escolhe a mensagem nem a fonte.
--   crm_accepted        instante em que o próprio CRM aceitou o envio humano (relógio do banco,
--                       gravado por gatilho). Nenhum cliente informa esse valor.
-- Nunca são fonte: horário de entrega/leitura/falha (status), `createTime` do envelope ou da
-- mensagem do provedor (momento em que o provedor registrou, não em que a mensagem ocorreu), `now()`
-- no recebimento, o simulador da A7 (o chamador escolhe o horário) e o texto da mensagem.
--
-- Motivos de inelegibilidade (origin_time_issue ou ausência):
--   (nulo e sem horário)  origem desconhecida: legado, simulador ou caminho não instrumentado;
--   missing        o provedor não informou o horário da mensagem;
--   invalid        horário não finito;
--   too_old        anterior a 2009-01-01 (inclui epoch zero e segundos lidos como milissegundos);
--   future         mais de 5 minutos à frente do relógio do banco (inclui milissegundos lidos como
--                  segundos);
--   contradictory  outro evento do MESMO provedor trouxe horário diferente para a mesma mensagem:
--                  o banco não escolhe o mais recente nem o mais antigo e não autoriza nenhum.
-- O primeiro julgamento prevalece: depois de gravado, um horário nunca é trocado, e um evento que
-- não criou a mensagem só pode CONFIRMAR ou marcar contradição, nunca preencher origem desconhecida.

-- ---------------------------------------------------------------------
-- 1) Colunas
-- ---------------------------------------------------------------------

alter table public.messages
  add column origin_time_at timestamptz,
  add column origin_time_source text,
  add column origin_time_issue text;

alter table public.messages
  add constraint messages_origin_time_shape check (
    -- horário e fonte andam juntos
    (origin_time_at is null) = (origin_time_source is null)
    and (origin_time_source is null or origin_time_source in ('provider_send_time', 'crm_accepted'))
    and (origin_time_issue is null or origin_time_issue in ('missing', 'invalid', 'future', 'too_old', 'contradictory'))
    -- só `contradictory` convive com um horário; qualquer outro motivo é a ausência dele
    and (origin_time_issue is null or ((origin_time_issue = 'contradictory') = (origin_time_at is not null)))
    and (
      origin_time_at is null
      or (origin_time_at >= timestamptz '2009-01-01 00:00:00+00' and origin_time_at < 'infinity'::timestamptz)
    )
  );

comment on column public.messages.origin_time_at is
  'Quando a mensagem ocorreu NA ORIGEM, com a procedência em origin_time_source. Nulo = desconhecido. Nunca created_at (chegada ao CRM) nem horário de status.';
comment on column public.messages.origin_time_source is
  'Procedência do horário de origem: provider_send_time (evento assinado do provedor) ou crm_accepted (envio humano aceito pelo CRM).';
comment on column public.messages.origin_time_issue is
  'Motivo pelo qual o horário de origem NÃO pode ser usado como evidência temporal (missing, invalid, future, too_old, contradictory). Nulo com horário = verificado; nulo sem horário = desconhecido.';

-- ---------------------------------------------------------------------
-- 2) Gatilhos: ninguém informa o horário de origem na inserção, e depois de
--    gravado só a função do servidor o altera, por transições fechadas
-- ---------------------------------------------------------------------

create function private.messages_origin_time_insert()
returns trigger
language plpgsql
set search_path = ''
as $body$
begin
  if new.origin_time_at is not null or new.origin_time_source is not null or new.origin_time_issue is not null then
    raise exception 'origin_time_not_insertable';
  end if;
  -- Envio humano do CRM: o CRM é a origem, e o instante é o do próprio banco.
  if new.direction = 'outbound' and new.origin = 'crm' and new.sender_classification = 'internal'
     and new.sent_by is not null
     and new.created_at >= timestamptz '2009-01-01 00:00:00+00' and new.created_at < 'infinity'::timestamptz then
    new.origin_time_at := new.created_at;
    new.origin_time_source := 'crm_accepted';
  end if;
  return new;
end;
$body$;

revoke all on function private.messages_origin_time_insert() from public, anon, authenticated, service_role;

-- Roda DEPOIS de messages_default_classification (ordem alfabética dos gatilhos BEFORE), que é quem
-- classifica as inserções da A7.
create trigger messages_origin_time_insert
  before insert on public.messages
  for each row execute function private.messages_origin_time_insert();

create function private.messages_origin_time_guard()
returns trigger
language plpgsql
set search_path = ''
as $body$
begin
  if current_setting('praxis.message_origin_writer', true) is distinct from 'on' then
    raise exception 'origin_time_immutable';
  end if;
  -- Desconhecido -> definido, uma única vez (com horário ou com o motivo).
  if old.origin_time_at is null and old.origin_time_issue is null then
    if new.origin_time_issue is distinct from 'contradictory' then
      return new;
    end if;
  -- Verificado -> contraditório, sem mexer no horário nem na fonte.
  elsif old.origin_time_at is not null and old.origin_time_issue is null
        and new.origin_time_at is not distinct from old.origin_time_at
        and new.origin_time_source is not distinct from old.origin_time_source
        and new.origin_time_issue = 'contradictory' then
    return new;
  end if;
  raise exception 'origin_time_immutable';
end;
$body$;

revoke all on function private.messages_origin_time_guard() from public, anon, authenticated, service_role;

create trigger messages_origin_time_guard
  before update of origin_time_at, origin_time_source, origin_time_issue on public.messages
  for each row
  when (
    old.origin_time_at is distinct from new.origin_time_at
    or old.origin_time_source is distinct from new.origin_time_source
    or old.origin_time_issue is distinct from new.origin_time_issue
  )
  execute function private.messages_origin_time_guard();

-- ---------------------------------------------------------------------
-- 3) Julgamento do horário (limites) e regra de comparação (contrato do aplicador)
-- ---------------------------------------------------------------------

-- Motivo pelo qual o horário informado NÃO serve, ou nulo se serve. A dica vem do servidor (só
-- `missing` ou `invalid`); os limites são do banco, com o relógio do banco.
create function private.message_origin_time_issue(p_at timestamptz, p_hint text, p_now timestamptz)
returns text
language plpgsql
immutable
set search_path = ''
as $body$
begin
  if p_hint is not null then
    return p_hint;
  end if;
  if p_at is null then
    return 'missing';
  end if;
  if p_at = 'infinity'::timestamptz or p_at = '-infinity'::timestamptz then
    return 'invalid';
  end if;
  if p_at < timestamptz '2009-01-01 00:00:00+00' then
    return 'too_old';
  end if;
  if p_at > p_now + interval '5 minutes' then
    return 'future';
  end if;
  return null;
end;
$body$;

revoke all on function private.message_origin_time_issue(timestamptz, text, timestamptz) from public, anon, authenticated, service_role;

-- A regra que o aplicador vai usar para decidir se uma mensagem pode contar como evidência NOVA em
-- relação à última decisão humana (`status_tracks.manual_decided_at`). Devolve 'eligible' ou o
-- motivo. O horário válido é UMA condição: não prova caso correto, autoridade do remetente nem
-- transição permitida.
--
--  * `created_at` (p_received_at) só entra para detectar incoerência (origem depois da chegada);
--    nunca torna uma mensagem posterior à decisão.
--  * A mensagem só é posterior se o horário de origem passar da decisão por MAIS de 5 segundos:
--    empate e diferença de até 5 s não autorizam (cobre horário do provedor truncado em segundos e
--    pequena diferença entre relógios). Na dúvida, não autoriza.
--  * Sem decisão humana registrada (p_manual_decided_at nulo) não há com o que comparar: basta a
--    origem ser válida.
--  * Marco de decisão no futuro (mais de 5 minutos) ou não finito é suspeito e não autoriza.
create function private.message_origin_time_verdict(
  p_origin_time_at timestamptz,
  p_origin_time_source text,
  p_origin_time_issue text,
  p_received_at timestamptz,
  p_manual_decided_at timestamptz,
  p_now timestamptz default clock_timestamp()
)
returns text
language plpgsql
set search_path = ''
as $body$
declare
  v_issue text;
begin
  if p_origin_time_issue is not null then
    return 'origin_' || p_origin_time_issue;
  end if;
  if p_origin_time_at is null or p_origin_time_source is null then
    return 'origin_unknown';
  end if;
  if p_received_at is null then
    return 'arrival_unknown';
  end if;
  v_issue := private.message_origin_time_issue(p_origin_time_at, null, p_now);
  if v_issue is not null then
    return 'origin_' || v_issue;
  end if;
  -- Origem depois da chegada ao CRM (mais de 5 minutos): incoerente.
  if p_origin_time_at > p_received_at + interval '5 minutes' then
    return 'origin_future';
  end if;
  if p_manual_decided_at is null then
    return 'eligible';
  end if;
  if p_manual_decided_at = 'infinity'::timestamptz or p_manual_decided_at = '-infinity'::timestamptz
     or p_manual_decided_at > p_now + interval '5 minutes' then
    return 'decision_marker_suspect';
  end if;
  if p_origin_time_at <= p_manual_decided_at + interval '5 seconds' then
    return 'not_after_decision';
  end if;
  return 'eligible';
end;
$body$;

revoke all on function private.message_origin_time_verdict(timestamptz, text, text, timestamptz, timestamptz, timestamptz)
  from public, anon, authenticated, service_role;

-- O mesmo veredito para uma mensagem gravada.
create function private.message_origin_time_evidence_verdict(
  p_message_id uuid,
  p_manual_decided_at timestamptz,
  p_now timestamptz default clock_timestamp()
)
returns text
language plpgsql
stable
set search_path = ''
as $body$
declare
  v_message public.messages;
begin
  select * into v_message from public.messages where id = p_message_id;
  if v_message.id is null then
    return 'message_not_found';
  end if;
  return private.message_origin_time_verdict(
    v_message.origin_time_at, v_message.origin_time_source, v_message.origin_time_issue,
    v_message.created_at, p_manual_decided_at, p_now
  );
end;
$body$;

revoke all on function private.message_origin_time_evidence_verdict(uuid, timestamptz, timestamptz)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------
-- 4) Gravação do horário do provedor (só o servidor, ligada ao evento assinado)
-- ---------------------------------------------------------------------

-- Resultados:
--   recorded       horário válido gravado numa mensagem de origem desconhecida;
--   unverified     o horário não serve (motivo gravado): mensagem segue recebida e inelegível;
--   unchanged      nada mudou (o mesmo horário já estava gravado, ou já havia motivo, ou o evento não
--                  criou a mensagem e ela ainda não tem origem);
--   contradictory  outro evento trouxe horário diferente: a mensagem fica marcada, sem escolher;
--   not_found      a entrada não tem efeito de mensagem aplicado neste ambiente;
--   not_applicable a mensagem não vem de provedor (não há horário de provedor a gravar).
-- Quem chama informa a entrada (inbox) e o horário que o EVENTO trouxe — nunca a mensagem, a fonte
-- ou o veredito. A mensagem vem do ledger do evento já aplicado; a fonte é sempre
-- provider_send_time. Idempotente: pode ser repetida para curar uma chamada perdida.
create function public.whatsapp_record_message_origin_time(
  p_inbox_id uuid,
  p_origin_at timestamptz,
  p_origin_issue text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_env public.whatsapp_environment := private.require_whatsapp_environment();
  v_ledger public.whatsapp_effect_ledger;
  v_message public.messages;
  v_now timestamptz := clock_timestamp();
  v_issue text;
  v_at timestamptz;
begin
  if p_inbox_id is null
     or (p_origin_issue is not null and p_origin_issue not in ('missing', 'invalid'))
     or (p_origin_at is not null and p_origin_issue is not null) then
    raise exception 'invalid_origin_time';
  end if;

  select l.* into v_ledger
  from public.whatsapp_effect_ledger l
  where l.inbox_id = p_inbox_id and l.environment = v_env
    and l.effect in ('message.inbound', 'message.outbound_observed')
    and l.message_id is not null
  order by l.recorded_at desc
  limit 1;
  if v_ledger.id is null then
    return jsonb_build_object('outcome', 'not_found');
  end if;

  select m.* into v_message from public.messages m
  where m.id = v_ledger.message_id and m.workspace_id = v_ledger.workspace_id
  for update;
  if v_message.id is null then
    return jsonb_build_object('outcome', 'not_found');
  end if;
  if v_message.provider is null or v_message.origin not in ('inbound', 'business_app') then
    return jsonb_build_object('outcome', 'not_applicable');
  end if;

  v_issue := private.message_origin_time_issue(p_origin_at, p_origin_issue, v_now);
  v_at := case when v_issue is null then p_origin_at end;

  -- Origem desconhecida: só o evento que CRIOU a mensagem a preenche (mesma transação: o ledger e a
  -- mensagem nascem com o mesmo now()). Um evento duplicado, de outra entrada, nunca preenche.
  if v_message.origin_time_at is null and v_message.origin_time_issue is null then
    if v_ledger.recorded_at is distinct from v_message.created_at then
      return jsonb_build_object('outcome', 'unchanged');
    end if;
    perform set_config('praxis.message_origin_writer', 'on', true);
    update public.messages
    set origin_time_at = v_at,
        origin_time_source = case when v_at is not null then 'provider_send_time' end,
        origin_time_issue = v_issue
    where id = v_message.id;
    perform set_config('praxis.message_origin_writer', '', true);
    return jsonb_build_object('outcome', case when v_at is null then 'unverified' else 'recorded' end, 'issue', v_issue);
  end if;

  -- Já verificada: o mesmo horário confirma; horário diferente é contradição; evento sem horário
  -- válido não desfaz nem contradiz nada.
  if v_message.origin_time_at is not null and v_message.origin_time_issue is null
     and v_message.origin_time_source = 'provider_send_time' then
    if v_at is null or v_at = v_message.origin_time_at then
      return jsonb_build_object('outcome', 'unchanged');
    end if;
    perform set_config('praxis.message_origin_writer', 'on', true);
    update public.messages set origin_time_issue = 'contradictory' where id = v_message.id;
    perform set_config('praxis.message_origin_writer', '', true);
    return jsonb_build_object('outcome', 'contradictory');
  end if;

  return jsonb_build_object('outcome', 'unchanged');
end;
$body$;

revoke all on function public.whatsapp_record_message_origin_time(uuid, timestamptz, text) from public, anon, authenticated;
grant execute on function public.whatsapp_record_message_origin_time(uuid, timestamptz, text) to service_role;

-- ---------------------------------------------------------------------
-- 5) Exportação do titular (C3a): o horário de origem entra em cada mensagem
--
-- Mesma função, mesma assinatura e as mesmas seções, byte a byte, da definição PUBLICADA por
-- 20261123120000_conversas_documentos_caso.sql (inclui `case_notes` e `case_documents`); só a seção
-- `messages` ganha a chave `origin_time` (horário, fonte e motivo). Sem identificador interno, ledger
-- ou entrada. (Esta migration nasceu como 20261119120000 e foi renumerada para depois das publicadas
-- sem nunca ter sido aplicada; partir da versão antiga apagaria as seções acrescentadas depois.)
-- Retenção/anonimização (C3b): as colunas moram na própria mensagem e saem com ela (a conversa
-- apagada leva as mensagens em cascata); não guardam texto, telefone nem identidade.
-- ---------------------------------------------------------------------

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
    -- Documentos por caso: só os METADADOS (nome, tipo, tamanho, situação, conferência e datas). O conteúdo dos
    -- arquivos NÃO entra no arquivo de exportação (file_content_included = false), nem a observação interna da
    -- conferência nem quem enviou/conferiu (usuários internos).
    'case_documents', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', x.id, 'opportunity_id', x.opportunity_id, 'name', x.original_name,
        'content_type', coalesce(x.content_type, x.declared_type),
        'byte_size', coalesce(x.byte_size, x.declared_size),
        'status', x.status, 'review_status', x.review_status,
        'uploaded_at', coalesce(x.finalized_at, x.created_at), 'reviewed_at', x.reviewed_at,
        'file_content_included', false)
        order by x.created_at, x.id)
      from public.case_documents x where x.workspace_id = p_workspace_id and x.opportunity_id in (select id from o)
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
        'origin_time', jsonb_build_object(
          'at', x.origin_time_at, 'source', x.origin_time_source, 'issue', x.origin_time_issue),
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
