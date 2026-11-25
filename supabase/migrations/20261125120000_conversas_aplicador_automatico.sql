-- Conversas + IA — APLICADOR DETERMINÍSTICO de propostas de mudança de status.
--
-- Decisões em docs/decisoes/conversas-aplicador.md. Depende do horário de origem das mensagens
-- (20261124120000, PR #358): sem ele não há como saber se uma mensagem é posterior à decisão humana.
--
-- O que entrega: UMA função do servidor (service_role) que recebe uma proposta estruturada de
-- mudança (de quem quer que a produza — no futuro, um extrator de IA), confere tudo de novo no
-- banco, no momento da gravação, e APLICA ou RECUSA com um motivo em código. Não há extrator, modelo,
-- rota, tela de operação nem ativação: o portão `status_track_automation_gate` nasce FECHADO e só é
-- aberto por comando direto no banco, com a referência da ativação.
--
-- Regras (todas conferidas no banco, nenhuma confiada à proposta):
--   * A proposta NÃO informa horário, remetente, autoridade, papel nem permissão. Esses fatos vêm das
--     mensagens gravadas (origem, classificação do remetente, horário de origem) e das trilhas.
--   * Três trilhas separadas. Uma proposta muda UMA coisa de UMA trilha; nada é inferido para as
--     outras (situação do atendimento ≠ andamento do serviço ≠ etapa comercial).
--   * Evidência: 1 a 20 mensagens DA conversa informada, todas com horário de origem elegível
--     (private.message_origin_time_evidence_verdict = 'eligible') contra o `manual_decided_at` da
--     trilha-alvo — margem de 5 s e demais limites da #358 — e todas POSTERIORES à evidência da
--     última aplicação automática da mesma trilha (mensagem atrasada não desfaz o que já foi aplicado
--     com evidência mais nova).
--   * A aplicação automática NÃO grava `manual_decided_at` (não finge ser decisão humana); incrementa a
--     versão da trilha como qualquer mudança e entra no histórico com actor_kind = 'automation', sem
--     usuário (actor_user_id nulo SÓ para automação; evento de usuário continua exigindo usuário).
--   * Disputa com a correção manual: as duas travam a MESMA linha da trilha; quem chega depois vê a
--     versão nova e é recusado (aplicador: version_stale; manual: track_conflict). Nada é
--     sobrescrito em silêncio.
--   * Idempotência: a chave da proposta entra no registro único compartilhado
--     (status_track_idempotency_keys, fonte 'status_track_automation_decisions'). A mesma chave com o
--     mesmo pedido devolve a mesma decisão (aplicada ou recusada) sem gravar nada; com outro pedido,
--     idempotency_conflict. Uma chave usada pela correção manual ou pelo roteiro nunca vale aqui, e
--     vice-versa.
--   * Catálogo FECHADO do que pode ser automático (o resto é recusado como transition_not_automatable):
--       situação do atendimento: -> aguardando_escritorio (só mensagens do cliente) e
--                                -> aguardando_cliente (só mensagens do escritório); nunca novo,
--                                encerrado nem reabrir conversa encerrada;
--       andamento do serviço:    -> aguardando_documentos e -> aguardando_cliente (só mensagens do
--                                escritório); aguardando_documentos -> documentos_recebidos (só ARQUIVO
--                                recebido do cliente — "enviei" em texto não comprova recebimento, e
--                                arquivo recebido não vira conferido, em análise nem concluído);
--                                em_analise, em_execucao, aguardando_terceiros, suspenso e concluido são
--                                sempre humanos (protocolo, sentença e conclusão não se presumem);
--       roteiro:                 só AVANÇAR a etapa atual para uma etapa pendente posterior, sem concluir
--                                nada (as puladas continuam pendentes); concluir etapa é sempre humano;
--       etapa comercial, ganho e perda: sempre humanos (commercial_manual_only).
--   * Cliente = mensagem recebida com remetente classificado `external` (não equipe, não
--     indeterminado). Para o andamento e o roteiro, além disso, a conversa precisa estar vinculada ao
--     contato do caso, sem revisão de vínculo pendente, e o caso precisa ser inequívoco: vínculo
--     persistido da conversa ou caso único do contato (regra private.conversation_case_resolution);
--     contato com dois casos sem vínculo = ambiguous_case.
--   * Escritório = envio humano pelo CRM (origin crm, internal, com autor) ou eco do aplicativo do
--     escritório (business_app). Chatbot, API externa, histórico e simulador não são evidência válida.
--   * Pausa ativa, versão desatualizada, evidência insuficiente, remetente sem autoridade e caso
--     ambíguo são RECUSAS registradas, com o motivo e as referências (ids) das evidências — nunca o
--     texto. Proposta malformada, alvo inexistente ou de outro escritório e portão fechado são ERROS
--     (nada é gravado, porque não há alvo válido onde registrar).
--
-- Migration ADITIVA: duas tabelas novas deny-all, uma tabela de portão, colunas e regras de autoria
-- nos dois históricos (status_track_events e case_service_events), a fonte nova no registro de
-- chaves, funções novas e `create or replace` de private.privacy_export_payload (C3a, seção nova;
-- parte da definição da 20261124120000). Nenhum dado existente muda.

-- =====================================================================
-- 1) Portão (nasce fechado)
-- =====================================================================

create table public.status_track_automation_gate (
  singleton boolean primary key default true check (singleton),
  enabled boolean not null default false,
  activation_ref text,
  enabled_at timestamptz,
  constraint status_track_automation_gate_activation check (
    (not enabled and enabled_at is null)
    or (enabled and enabled_at is not null and activation_ref is not null and activation_ref ~ '^\S{3,200}$')
  )
);

insert into public.status_track_automation_gate (singleton, enabled) values (true, false);

comment on table public.status_track_automation_gate is
  'Conversas + IA (aplicador): portão GLOBAL do aplicador automático. Nasce fechado; abrir exige activation_ref e só se faz por comando direto no banco (não há função de API). Fechado = apply_status_track_automation recusa tudo com automation_disabled, sem gravar.';

alter table public.status_track_automation_gate enable row level security;
alter table public.status_track_automation_gate force row level security;
revoke all on table public.status_track_automation_gate from public, anon, authenticated, service_role;

-- =====================================================================
-- 2) Registro das decisões do aplicador (aplicadas e recusadas)
-- =====================================================================

create table public.status_track_automation_decisions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  idempotency_key uuid not null,
  -- A conversa de onde vieram as evidências. A decisão some com ela (retenção/anonimização).
  conversation_id uuid not null,
  track public.status_track_kind not null,
  opportunity_id uuid,
  change text not null check (change in ('set_status', 'set_current_step', 'complete_step', 'commercial_stage', 'commercial_outcome')),
  to_status text,
  step_id uuid,
  expected_version bigint not null check (expected_version >= 0),
  -- Linha da trilha no momento da decisão (nula quando a recusa veio antes de travar a trilha).
  track_id uuid,
  track_version bigint,
  outcome text not null check (outcome in ('applied', 'refused')),
  reason text check (reason ~ '^[a-z_]{3,60}$'),
  evidence_count integer not null check (evidence_count between 0 and 20),
  -- Maior horário de origem das evidências de uma decisão APLICADA: a próxima aplicação automática da
  -- mesma trilha só aceita evidência posterior a ele.
  evidence_origin_max timestamptz,
  event_source text check (event_source in ('status_track_events', 'case_service_events')),
  event_id uuid,
  -- Referência opaca de quem produziu a proposta (execução do extrator); nunca texto livre.
  extractor_ref text check (extractor_ref ~ '^[A-Za-z0-9._:-]{1,120}$'),
  request_fingerprint text not null check (request_fingerprint ~ '^[0-9a-f]{32}$'),
  decided_at timestamptz not null default clock_timestamp(),
  constraint status_track_automation_decisions_workspace_id_id_key unique (workspace_id, id),
  constraint status_track_automation_decisions_key unique (workspace_id, idempotency_key),
  constraint status_track_automation_decisions_conversation_fkey
    foreign key (workspace_id, conversation_id) references public.conversations (workspace_id, id) on delete cascade,
  constraint status_track_automation_decisions_opportunity_fkey
    foreign key (workspace_id, opportunity_id) references public.opportunities (workspace_id, id) on delete cascade,
  constraint status_track_automation_decisions_outcome_shape check (
    (outcome = 'applied' and reason is null and event_id is not null and event_source is not null
       and track_id is not null and evidence_origin_max is not null and evidence_count >= 1)
    or (outcome = 'refused' and reason is not null and event_id is null and event_source is null)
  ),
  constraint status_track_automation_decisions_target_shape check (
    (track = 'attendance' and opportunity_id is null) or (track <> 'attendance' and opportunity_id is not null)
  )
);

create index status_track_automation_decisions_track_idx
  on public.status_track_automation_decisions (track_id, decided_at desc) where outcome = 'applied';
create index status_track_automation_decisions_conversation_idx
  on public.status_track_automation_decisions (conversation_id, decided_at desc);

comment on table public.status_track_automation_decisions is
  'Conversas + IA (aplicador): uma linha por proposta processada (aplicada ou recusada), com o motivo em código, a versão vista e a referência do evento gravado. Só códigos e ids; nenhum texto de mensagem. Imutável; some com a conversa.';

create table public.status_track_automation_decision_evidence (
  workspace_id uuid not null,
  decision_id uuid not null,
  message_id uuid not null,
  -- Como o banco classificou a mensagem e o veredito temporal no momento da decisão (códigos).
  kind text not null check (kind in ('client_message', 'client_file', 'office_message', 'other')),
  verdict text not null check (verdict ~ '^[a-z_]{3,40}$'),
  primary key (decision_id, message_id),
  constraint status_track_automation_decision_evidence_decision_fkey
    foreign key (workspace_id, decision_id) references public.status_track_automation_decisions (workspace_id, id) on delete cascade,
  constraint status_track_automation_decision_evidence_message_fkey
    foreign key (workspace_id, message_id) references public.messages (workspace_id, id) on delete cascade
);

create index status_track_automation_decision_evidence_message_idx
  on public.status_track_automation_decision_evidence (message_id);

comment on table public.status_track_automation_decision_evidence is
  'Conversas + IA (aplicador): mensagens referenciadas por uma decisão, com a classificação e o veredito temporal calculados pelo banco. Só ids e códigos; cai em cascata com a mensagem.';

alter table public.status_track_automation_decisions enable row level security;
alter table public.status_track_automation_decisions force row level security;
revoke all on table public.status_track_automation_decisions from public, anon, authenticated, service_role;

alter table public.status_track_automation_decision_evidence enable row level security;
alter table public.status_track_automation_decision_evidence force row level security;
revoke all on table public.status_track_automation_decision_evidence from public, anon, authenticated, service_role;

-- Imutável; nada novo para contato ou caso anonimizado (mesma regra das trilhas).
create function private.status_track_automation_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_conversation_id uuid;
  v_opportunity_id uuid;
  v_contact_id uuid;
begin
  if tg_op = 'UPDATE' then
    raise exception 'automation_decision_immutable';
  end if;
  if tg_table_name = 'status_track_automation_decisions' then
    v_conversation_id := new.conversation_id;
    v_opportunity_id := new.opportunity_id;
  else
    select d.conversation_id, d.opportunity_id into v_conversation_id, v_opportunity_id
    from public.status_track_automation_decisions d where d.id = new.decision_id;
  end if;
  if v_opportunity_id is not null and private.privacy_opportunity_anonymized(v_opportunity_id) then
    raise exception 'contact_anonymized';
  end if;
  select c.contact_id into v_contact_id from public.conversations c where c.id = v_conversation_id;
  if v_contact_id is not null and private.privacy_contact_anonymized(v_contact_id) then
    raise exception 'contact_anonymized';
  end if;
  return new;
end;
$body$;

revoke all on function private.status_track_automation_guard() from public, anon, authenticated, service_role;

create trigger status_track_automation_decisions_guard before insert or update on public.status_track_automation_decisions
  for each row execute function private.status_track_automation_guard();
create trigger status_track_automation_decision_evidence_guard before insert or update on public.status_track_automation_decision_evidence
  for each row execute function private.status_track_automation_guard();

-- A chave da proposta entra no MESMO registro único das chaves da trilha (seção 4b da etapa B).
alter table public.status_track_idempotency_keys drop constraint status_track_idempotency_keys_source_check;
alter table public.status_track_idempotency_keys add constraint status_track_idempotency_keys_source_check
  check (source in ('status_track_events', 'case_service_events', 'status_track_automation_decisions'));

create trigger status_track_automation_decisions_key_register after insert on public.status_track_automation_decisions
  for each row execute function private.status_track_key_register();
create trigger status_track_automation_decisions_key_release after delete on public.status_track_automation_decisions
  for each row execute function private.status_track_key_register();

-- =====================================================================
-- 3) Autoria automática nos históricos (sem inventar usuário)
--
-- Antes: actor_kind só 'user' e actor_user_id obrigatório. Agora: 'user' continua EXIGINDO o usuário;
-- 'automation' exige NÃO ter usuário e ter a decisão que o produziu (conferida na inserção). A
-- referência da decisão é um id sem chave estrangeira de propósito: o histórico é imutável e não pode
-- ser alterado quando a decisão some com a conversa.
-- =====================================================================

alter table public.status_track_events drop constraint status_track_events_actor_kind_check;
alter table public.status_track_events alter column actor_user_id drop not null;
alter table public.status_track_events add column automation_decision_id uuid;
alter table public.status_track_events add constraint status_track_events_actor_shape check (
  (actor_kind = 'user' and actor_user_id is not null and automation_decision_id is null)
  or (actor_kind = 'automation' and actor_user_id is null and automation_decision_id is not null
      and event = 'status_changed' and idempotency_key is null)
);

alter table public.case_service_events drop constraint case_service_events_actor_kind_check;
alter table public.case_service_events alter column actor_user_id drop not null;
alter table public.case_service_events add column automation_decision_id uuid;
alter table public.case_service_events add constraint case_service_events_actor_shape check (
  (actor_kind = 'user' and actor_user_id is not null and automation_decision_id is null)
  or (actor_kind = 'automation' and actor_user_id is null and automation_decision_id is not null
      and op = 'current_step_set' and idempotency_key is null)
);

comment on column public.status_track_events.automation_decision_id is
  'Decisão do aplicador que gravou o evento (só actor_kind = automation). Sem chave estrangeira: o histórico é imutável e sobrevive à decisão.';
comment on column public.case_service_events.automation_decision_id is
  'Decisão do aplicador que gravou o evento (só actor_kind = automation). Sem chave estrangeira: o histórico é imutável e sobrevive à decisão.';

-- Evento automático só entra pela função do aplicador, que marca a transação com a decisão.
create function private.status_track_automation_event_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $body$
begin
  if new.actor_kind = 'automation'
     and current_setting('praxis.automation_decision', true) is distinct from new.automation_decision_id::text then
    raise exception 'automation_event_requires_decision';
  end if;
  return new;
end;
$body$;

revoke all on function private.status_track_automation_event_guard() from public, anon, authenticated, service_role;

create trigger status_track_events_automation_guard before insert on public.status_track_events
  for each row execute function private.status_track_automation_event_guard();
create trigger case_service_events_automation_guard before insert on public.case_service_events
  for each row execute function private.status_track_automation_event_guard();

-- =====================================================================
-- 4) Classificação das evidências (fatos gravados, nunca a proposta)
-- =====================================================================

create function private.status_track_automation_message_kind(p_message public.messages)
returns text
language sql
immutable
set search_path = ''
as $body$
  select case
    when p_message.direction = 'inbound' and p_message.origin = 'inbound' and p_message.sender_classification = 'external'
      then case when p_message.content_kind in ('document', 'image') then 'client_file' else 'client_message' end
    when p_message.direction = 'outbound'
         and ((p_message.origin = 'crm' and p_message.sender_classification = 'internal' and p_message.sent_by is not null)
              or (p_message.origin = 'business_app' and p_message.sender_classification = 'internal'))
      then 'office_message'
    else 'other'
  end;
$body$;

revoke all on function private.status_track_automation_message_kind(public.messages) from public, anon, authenticated, service_role;

-- Catálogo fechado: que tipos de evidência cada mudança aceita, a partir de que estados.
-- Devolve nulo se a mudança é automatizável a partir do estado atual, ou o motivo da recusa.
create function private.status_track_automation_rule(
  p_track public.status_track_kind,
  p_from text,
  p_to text,
  out o_reason text,
  out o_kinds text[]
)
language plpgsql
immutable
set search_path = ''
as $body$
begin
  o_reason := null;
  o_kinds := null;
  if p_track = 'attendance' then
    if p_to = 'aguardando_escritorio' and p_from in ('nao_informado', 'novo', 'aguardando_cliente') then
      o_kinds := array['client_message', 'client_file'];
    elsif p_to = 'aguardando_cliente' and p_from in ('nao_informado', 'novo', 'aguardando_escritorio') then
      o_kinds := array['office_message'];
    end if;
  elsif p_track = 'case_progress' then
    if p_to = 'aguardando_documentos' and p_from in ('nao_informado', 'em_analise', 'aguardando_cliente', 'em_execucao') then
      o_kinds := array['office_message'];
    elsif p_to = 'aguardando_cliente' and p_from in ('nao_informado', 'em_analise', 'em_execucao', 'aguardando_terceiros') then
      o_kinds := array['office_message'];
    elsif p_to = 'documentos_recebidos' and p_from = 'aguardando_documentos' then
      o_kinds := array['client_file'];
    end if;
  end if;
  if o_kinds is null then
    o_reason := 'transition_not_automatable';
  end if;
end;
$body$;

revoke all on function private.status_track_automation_rule(public.status_track_kind, text, text) from public, anon, authenticated, service_role;

-- Grava a decisão (e as evidências classificadas). Duas propostas IGUAIS ao mesmo tempo: a segunda
-- espera o índice único e devolve a decisão da primeira; chave já usada em outro pedido ou em outro
-- histórico: idempotency_conflict.
create function private.status_track_automation_record(
  p_decision public.status_track_automation_decisions,
  p_evidence jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_existing public.status_track_automation_decisions;
begin
  begin
    insert into public.status_track_automation_decisions select p_decision.*;
  exception when unique_violation then
    select * into v_existing from public.status_track_automation_decisions
    where workspace_id = p_decision.workspace_id and idempotency_key = p_decision.idempotency_key;
    if v_existing.id is null or v_existing.request_fingerprint <> p_decision.request_fingerprint then
      raise exception 'idempotency_conflict';
    end if;
    return private.status_track_automation_result(v_existing, true);
  end;

  insert into public.status_track_automation_decision_evidence (workspace_id, decision_id, message_id, kind, verdict)
  select p_decision.workspace_id, p_decision.id, (e ->> 'message_id')::uuid, e ->> 'kind', e ->> 'verdict'
  from jsonb_array_elements(coalesce(p_evidence, '[]'::jsonb)) e;

  return private.status_track_automation_result(p_decision, false);
end;
$body$;

-- Resposta (só códigos e ids).
create function private.status_track_automation_result(
  p_decision public.status_track_automation_decisions,
  p_replayed boolean
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $body$
  select jsonb_build_object(
    'outcome', p_decision.outcome,
    'reason', p_decision.reason,
    'decision_id', p_decision.id,
    'track', p_decision.track,
    'track_id', p_decision.track_id,
    'version_seen', p_decision.track_version,
    'event_source', p_decision.event_source,
    'event_id', p_decision.event_id,
    'replayed', p_replayed
  );
$body$;

revoke all on function private.status_track_automation_result(public.status_track_automation_decisions, boolean)
  from public, anon, authenticated, service_role;
revoke all on function private.status_track_automation_record(public.status_track_automation_decisions, jsonb)
  from public, anon, authenticated, service_role;

-- =====================================================================
-- 5) O aplicador
-- =====================================================================

create function public.apply_status_track_automation(
  p_workspace_id uuid,
  p_conversation_id uuid,
  p_change text,
  p_track public.status_track_kind,
  p_opportunity_id uuid,
  p_to_status text,
  p_step_id uuid,
  p_expected_version bigint,
  p_evidence_message_ids uuid[],
  p_idempotency_key uuid,
  p_extractor_ref text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_gate public.status_track_automation_gate;
  v_conv public.conversations;
  v_opp public.opportunities;
  v_lead public.leads;
  v_ids uuid[];
  v_fp text;
  v_existing public.status_track_automation_decisions;
  v_d public.status_track_automation_decisions;
  v_row public.status_tracks;
  v_from text;
  v_rule record;
  v_resolution jsonb;
  v_evidence jsonb := '[]'::jsonb;
  v_found integer;
  v_last_auto timestamptz;
  v_origin_max timestamptz;
  v_plan public.case_service_plans;
  v_step public.case_service_plan_steps;
  v_current public.case_service_plan_steps;
  v_event_id uuid;
  v_reason text;
begin
  -- Portão.
  select * into v_gate from public.status_track_automation_gate where singleton;
  if v_gate.enabled is distinct from true then
    raise exception 'automation_disabled';
  end if;

  -- Forma da proposta. Nada aqui é decidido pelo conteúdo: só o formato.
  v_ids := coalesce(p_evidence_message_ids, '{}'::uuid[]);
  if p_workspace_id is null or p_conversation_id is null or p_track is null or p_idempotency_key is null
     or p_expected_version is null or p_expected_version < 0
     or cardinality(v_ids) < 1 or cardinality(v_ids) > 20
     or array_position(v_ids, null) is not null
     or (select count(distinct x) from unnest(v_ids) x) <> cardinality(v_ids)
     or (p_extractor_ref is not null and p_extractor_ref !~ '^[A-Za-z0-9._:-]{1,120}$')
     or p_change is null
     or p_change not in ('set_status', 'set_current_step', 'complete_step', 'commercial_stage', 'commercial_outcome')
     or (p_track = 'attendance' and (p_change <> 'set_status' or p_opportunity_id is not null))
     or (p_track <> 'attendance' and p_opportunity_id is null)
     or (p_change = 'set_status' and (p_track = 'commercial_stage' or p_step_id is not null or p_to_status is null))
     or (p_change in ('set_current_step', 'complete_step') and (p_track <> 'case_progress' or p_step_id is null or p_to_status is not null))
     or (p_change in ('commercial_stage', 'commercial_outcome') and p_track <> 'commercial_stage')
     or (p_change = 'set_status' and p_track = 'attendance'
         and p_to_status not in ('novo', 'aguardando_escritorio', 'aguardando_cliente', 'encerrado'))
     or (p_change = 'set_status' and p_track = 'case_progress'
         and p_to_status not in ('aguardando_documentos', 'documentos_recebidos', 'em_analise', 'aguardando_cliente',
                                 'aguardando_terceiros', 'em_execucao', 'concluido', 'suspenso')) then
    raise exception 'invalid_proposal';
  end if;

  -- Alvo: a conversa e o caso precisam ser DESTE escritório (outro escritório = inexistente).
  select * into v_conv from public.conversations where id = p_conversation_id and workspace_id = p_workspace_id;
  if v_conv.id is null then
    raise exception 'target_not_found';
  end if;
  if v_conv.contact_id is not null and private.privacy_contact_anonymized(v_conv.contact_id) then
    raise exception 'contact_anonymized';
  end if;
  if p_opportunity_id is not null then
    select * into v_opp from public.opportunities where id = p_opportunity_id and workspace_id = p_workspace_id;
    if v_opp.id is null then
      raise exception 'target_not_found';
    end if;
    if private.privacy_opportunity_anonymized(v_opp.id) then
      raise exception 'contact_anonymized';
    end if;
    select * into v_lead from public.leads where id = v_opp.lead_id and workspace_id = p_workspace_id;
  end if;

  v_fp := md5(concat_ws('|', 'automation.v1', p_workspace_id, p_conversation_id, p_change, p_track,
                        coalesce(p_opportunity_id::text, '-'), coalesce(p_to_status, '-'), coalesce(p_step_id::text, '-'),
                        p_expected_version, coalesce(p_extractor_ref, '-'),
                        (select string_agg(x::text, ',' order by x) from unnest(v_ids) x)));

  -- Repetição (resposta perdida, reenvio): a mesma chave com o mesmo pedido devolve a mesma decisão.
  select * into v_existing from public.status_track_automation_decisions
  where workspace_id = p_workspace_id and idempotency_key = p_idempotency_key;
  if v_existing.id is not null then
    if v_existing.request_fingerprint <> v_fp then
      raise exception 'idempotency_conflict';
    end if;
    return private.status_track_automation_result(v_existing, true);
  end if;
  perform private.status_track_key_assert_free(p_workspace_id, p_idempotency_key, 'status_track_automation_decisions');

  v_d.id := gen_random_uuid();
  v_d.workspace_id := p_workspace_id;
  v_d.idempotency_key := p_idempotency_key;
  v_d.conversation_id := v_conv.id;
  v_d.track := p_track;
  v_d.opportunity_id := p_opportunity_id;
  v_d.change := p_change;
  v_d.to_status := p_to_status;
  v_d.step_id := p_step_id;
  v_d.expected_version := p_expected_version;
  v_d.outcome := 'refused';
  v_d.evidence_count := 0;
  v_d.extractor_ref := p_extractor_ref;
  v_d.request_fingerprint := v_fp;
  v_d.decided_at := clock_timestamp();

  -- Sempre humanos nesta etapa.
  if p_track = 'commercial_stage' then
    v_d.reason := 'commercial_manual_only';
    return private.status_track_automation_record(v_d, null);
  end if;
  if p_change = 'complete_step' then
    v_d.reason := 'step_completion_manual_only';
    return private.status_track_automation_record(v_d, null);
  end if;

  -- Evidências: todas desta conversa (e, portanto, deste escritório).
  select count(*) into v_found from public.messages m
  where m.id = any(v_ids) and m.workspace_id = p_workspace_id and m.conversation_id = v_conv.id;
  if v_found <> cardinality(v_ids) then
    v_d.reason := 'evidence_invalid';
    return private.status_track_automation_record(v_d, null);
  end if;

  -- Caso inequívoco, ganho, da conversa vinculada ao contato do caso.
  if p_track = 'case_progress' then
    if v_conv.contact_id is null or v_conv.needs_link_review then
      v_d.reason := 'conversation_link_unresolved';
      return private.status_track_automation_record(v_d, null);
    end if;
    v_resolution := private.conversation_case_resolution(v_conv.id, 'owner', null);
    -- Só vínculo persistido da conversa ou caso ÚNICO do contato; o palpite "único do lead" com outros
    -- casos no contato não basta para uma mudança automática.
    if (v_resolution ->> 'default_opportunity_id') is null
       or not ((v_resolution ->> 'default_source') = 'linked' or (v_resolution ->> 'case_count')::int = 1) then
      v_d.reason := 'ambiguous_case';
      return private.status_track_automation_record(v_d, null);
    end if;
    if (v_resolution ->> 'default_opportunity_id')::uuid <> v_opp.id or v_lead.contact_id is distinct from v_conv.contact_id then
      v_d.reason := 'target_mismatch';
      return private.status_track_automation_record(v_d, null);
    end if;
    if v_opp.status <> 'won' then
      v_d.reason := 'opportunity_not_won';
      return private.status_track_automation_record(v_d, null);
    end if;
  end if;

  -- Trava a trilha (a MESMA trava da correção manual e do roteiro).
  v_row := private.status_track_lock(p_workspace_id, p_track, v_conv.id, p_opportunity_id);
  v_d.track_id := v_row.id;
  v_d.track_version := v_row.version;

  -- Depois da trava: a repetição simultânea da mesma chave enfileira aqui e devolve a decisão gravada.
  select * into v_existing from public.status_track_automation_decisions
  where workspace_id = p_workspace_id and idempotency_key = p_idempotency_key;
  if v_existing.id is not null then
    if v_existing.request_fingerprint <> v_fp then
      raise exception 'idempotency_conflict';
    end if;
    return private.status_track_automation_result(v_existing, true);
  end if;

  -- Classificação e veredito temporal de cada evidência, contra a decisão humana DESTA trilha.
  select coalesce(jsonb_agg(jsonb_build_object(
           'message_id', m.id,
           'kind', private.status_track_automation_message_kind(m),
           'verdict', private.message_origin_time_evidence_verdict(m.id, v_row.manual_decided_at),
           'origin_at', m.origin_time_at) order by m.id), '[]'::jsonb)
  into v_evidence
  from public.messages m
  where m.id = any(v_ids) and m.workspace_id = p_workspace_id;
  v_d.evidence_count := jsonb_array_length(v_evidence);

  if v_row.automation_paused then
    v_d.reason := 'automation_paused';
  elsif v_row.version <> p_expected_version then
    v_d.reason := 'version_stale';
  elsif exists (select 1 from jsonb_array_elements(v_evidence) e where e ->> 'verdict' <> 'eligible') then
    v_d.reason := 'evidence_not_eligible';
  end if;
  if v_d.reason is not null then
    return private.status_track_automation_record(v_d, v_evidence);
  end if;

  -- Mensagem atrasada não desfaz aplicação automática feita com evidência mais nova.
  select max(d.evidence_origin_max) into v_last_auto
  from public.status_track_automation_decisions d
  where d.track_id = v_row.id and d.outcome = 'applied';
  select max((e ->> 'origin_at')::timestamptz) into v_origin_max from jsonb_array_elements(v_evidence) e;
  if v_last_auto is not null and exists (
       select 1 from jsonb_array_elements(v_evidence) e where (e ->> 'origin_at')::timestamptz <= v_last_auto) then
    v_d.reason := 'evidence_superseded';
    return private.status_track_automation_record(v_d, v_evidence);
  end if;

  if p_change = 'set_status' then
    v_from := coalesce(v_row.attendance_status::text, v_row.case_progress_status::text);
    if v_from = p_to_status then
      v_d.reason := 'status_unchanged';
      return private.status_track_automation_record(v_d, v_evidence);
    end if;
    select * into v_rule from private.status_track_automation_rule(p_track, v_from, p_to_status);
    if v_rule.o_reason is not null then
      v_d.reason := v_rule.o_reason;
      return private.status_track_automation_record(v_d, v_evidence);
    end if;
  else
    -- set_current_step: avança a etapa atual, sem concluir nada.
    select * into v_plan from public.case_service_plans where opportunity_id = v_opp.id and status = 'active';
    if v_plan.id is null then
      v_reason := 'service_plan_missing';
    else
      select * into v_step from public.case_service_plan_steps where id = p_step_id and plan_id = v_plan.id;
      select * into v_current from public.case_service_plan_steps where id = v_plan.current_step_id;
      if v_step.id is null or v_step.completed_at is not null then
        v_reason := 'step_not_pending';
      elsif v_plan.current_step_id = v_step.id then
        v_reason := 'status_unchanged';
      elsif v_current.id is not null and v_step.position <= v_current.position then
        v_reason := 'step_not_after_current';
      end if;
    end if;
    if v_reason is not null then
      v_d.reason := v_reason;
      return private.status_track_automation_record(v_d, v_evidence);
    end if;
    v_rule := null;
    select null::text as o_reason, array['client_message', 'client_file', 'office_message'] as o_kinds into v_rule;
  end if;

  -- Toda evidência precisa ser do tipo que a regra aceita; mensagem recebida que não é do cliente
  -- (equipe ou remetente indeterminado) é falta de autoridade, não só de tipo.
  if exists (
    select 1 from jsonb_array_elements(v_evidence) e
    join public.messages m on m.id = (e ->> 'message_id')::uuid
    where e ->> 'kind' = 'other' and m.direction = 'inbound') then
    v_d.reason := 'sender_not_authorized';
    return private.status_track_automation_record(v_d, v_evidence);
  end if;
  if exists (select 1 from jsonb_array_elements(v_evidence) e where not ((e ->> 'kind') = any(v_rule.o_kinds))) then
    v_d.reason := 'evidence_kind_insufficient';
    return private.status_track_automation_record(v_d, v_evidence);
  end if;

  -- Aplicar. A trilha NÃO ganha manual_decided_at: a aplicação automática não é decisão humana.
  perform set_config('praxis.automation_decision', v_d.id::text, true);
  if p_change = 'set_status' then
    if p_track = 'attendance' then
      update public.status_tracks
      set attendance_status = p_to_status::public.conversation_attendance_status, version = version + 1
      where id = v_row.id returning * into v_row;
    else
      update public.status_tracks
      set case_progress_status = p_to_status::public.case_progress_status, version = version + 1
      where id = v_row.id returning * into v_row;
    end if;
    insert into public.status_track_events (
      workspace_id, track_id, event, from_status, to_status, from_version, to_version,
      actor_kind, actor_user_id, evidence_count, idempotency_key, automation_decision_id
    ) values (
      v_row.workspace_id, v_row.id, 'status_changed', v_from, p_to_status, v_row.version - 1, v_row.version,
      'automation', null, cardinality(v_ids), null, v_d.id
    ) returning id into v_event_id;
    insert into public.status_track_event_evidence (workspace_id, event_id, message_id)
    select v_row.workspace_id, v_event_id, x from unnest(v_ids) x;
    v_d.event_source := 'status_track_events';
    -- Situação do atendimento e andamento nunca convivem com concluído inconsistente (I1).
    if p_track = 'case_progress' then
      perform private.case_service_assert(v_row.opportunity_id);
    end if;
  else
    update public.case_service_plans set current_step_id = v_step.id where id = v_plan.id;
    update public.status_tracks set version = version + 1 where id = v_row.id returning * into v_row;
    insert into public.case_service_events (
      workspace_id, opportunity_id, plan_id, op, step_id, previous_plan_id,
      current_step_before, current_step_after, progress_from, progress_to,
      from_version, to_version, actor_kind, actor_user_id, idempotency_key, request_fingerprint, automation_decision_id
    ) values (
      v_row.workspace_id, v_row.opportunity_id, v_plan.id, 'current_step_set', null, null,
      v_plan.current_step_id, v_step.id, null, null,
      v_row.version - 1, v_row.version, 'automation', null, null, v_fp, v_d.id
    ) returning id into v_event_id;
    v_d.event_source := 'case_service_events';
    perform private.case_service_assert(v_row.opportunity_id);
  end if;
  perform set_config('praxis.automation_decision', '', true);

  v_d.outcome := 'applied';
  v_d.reason := null;
  v_d.event_id := v_event_id;
  v_d.evidence_origin_max := v_origin_max;
  return private.status_track_automation_record(v_d, v_evidence);
end;
$body$;

comment on function public.apply_status_track_automation(uuid, uuid, text, public.status_track_kind, uuid, text, uuid, bigint, uuid[], uuid, text) is
  'Conversas + IA (aplicador): aplica ou recusa UMA proposta estruturada de mudança de status, revalidando tudo no banco (escritório, alvo, caso inequívoco, evidências, horário de origem, versão, pausa, decisão humana, catálogo). Só o processamento interno (service_role) e só com o portão aberto. Idempotente pela chave; recusa registrada com motivo em código.';

revoke all on function public.apply_status_track_automation(uuid, uuid, text, public.status_track_kind, uuid, text, uuid, bigint, uuid[], uuid, text)
  from public, anon, authenticated;
grant execute on function public.apply_status_track_automation(uuid, uuid, text, public.status_track_kind, uuid, text, uuid, bigint, uuid[], uuid, text)
  to service_role;

-- =====================================================================
-- 6) Exportação do titular (C3a): decisões do aplicador sobre as conversas do titular
--
-- Mesma função, mesma assinatura e as mesmas seções, byte a byte, da definição de 20261124120000;
-- só a seção nova `status_track_automation_decisions` (códigos, ids e horários; nenhum texto).
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
    ), '[]'::jsonb),
    -- Aplicador: decisões (aplicadas e recusadas) sobre as conversas do titular. Só códigos, ids e
    -- horários; sem chave de idempotência, impressão do pedido nem referência do extrator.
    'status_track_automation_decisions', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', d.id, 'conversation_id', d.conversation_id, 'track', d.track, 'opportunity_id', d.opportunity_id,
        'change', d.change, 'to_status', d.to_status, 'outcome', d.outcome, 'reason', d.reason,
        'decided_at', d.decided_at,
        'evidence_message_ids', coalesce((
          select jsonb_agg(de.message_id order by de.message_id)
          from public.status_track_automation_decision_evidence de
          where de.decision_id = d.id and de.workspace_id = p_workspace_id), '[]'::jsonb))
        order by d.decided_at, d.id)
      from public.status_track_automation_decisions d
      where d.workspace_id = p_workspace_id and d.conversation_id in (select id from cv)
    ), '[]'::jsonb)
  );
$body$;
