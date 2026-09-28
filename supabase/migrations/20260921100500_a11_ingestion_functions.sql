-- A11 — ingestão pública, outbox e worker transacional.
--
-- TODAS as funções deste arquivo são chamadas pelo cliente administrativo
-- (service_role), restrito por lint às rotas de ingestão e de cron. Nenhuma
-- é concedida a `authenticated` ou `anon`: um visitante com a chave
-- publicável NUNCA consegue chamar a ingestão direto, pulando Turnstile e
-- rate limit.
--
-- Contrato: docs/decisoes/a11-ingestao-atribuicao.md §2, §3, §7 e §8.

-- ---------------------------------------------------------------------
-- resolve_form_endpoint — configuração vigente a partir da chave pública
--
-- Devolve NULL para chave inexistente, chave REVOGADA, endpoint
-- DESABILITADO e destino inválido. A rota traduz todos esses casos no
-- MESMO erro público genérico — nunca distingue "não existe" de
-- "desativado" (contrato §1: sem enumeração).
-- ---------------------------------------------------------------------

create function public.resolve_form_endpoint(p_public_key text)
returns jsonb
language sql
security definer
stable
set search_path = ''
as $body$
  select jsonb_build_object(
    'id', e.id,
    'workspace_id', e.workspace_id,
    'pipeline_id', e.pipeline_id,
    'stage_id', e.stage_id,
    'legal_area', e.legal_area,
    'initial_activity_type', e.initial_activity_type,
    'initial_activity_due_minutes', e.initial_activity_due_minutes,
    'capture_mode', e.capture_mode,
    'contract_version', e.contract_version,
    'answers_config', e.answers_config,
    'turnstile_action', e.turnstile_action,
    'allowed_hostnames', to_jsonb(e.allowed_hostnames)
  )
  from public.form_endpoint_keys k
  join public.form_endpoints e on e.id = k.form_endpoint_id
  join public.pipeline_stages s on s.id = e.stage_id and s.pipeline_id = e.pipeline_id
  where k.public_key = p_public_key
    and k.revoked_at is null
    and e.status = 'active'
    and s.is_won = false
    and s.is_lost = false;
$body$;

-- ---------------------------------------------------------------------
-- ingest_form_event — a transação de ingestão inteira (contrato §7)
--
-- Numa só transação: reserva/confere a chave idempotente, compara o hash,
-- insere OU recupera o evento, preserva o protocolo público e insere
-- outbox SOMENTE para evento novo.
--
-- `received_at` é atribuída pelo BANCO (default now()), e é dela que sai
-- a normalização temporal — um único relógio, testável em pgTAP:
--   até 5 min no futuro   → mantém a declarada        (ok)
--   >5 min no futuro      → normaliza para received_at (future_clamped)
--   >24 h no passado      → normaliza para received_at (stale_clamped)
-- Data ausente/inválida é recusada ANTES daqui, na borda HTTP.
--
-- Retorno: { protocol, created, webhook_event_id }. O id interno existe
-- só para a rota publicar no Inngest com identificador estável — ele
-- NUNCA entra na resposta pública, que é sempre 202 com o mesmo formato
-- para evento novo E para repetição.
-- ---------------------------------------------------------------------

create function public.ingest_form_event(
  p_form_endpoint_id uuid,
  p_source_event_id uuid,
  p_content_hash bytea,
  p_public_protocol text,
  p_payload_ciphertext bytea,
  p_payload_iv bytea,
  p_payload_auth_tag bytea,
  p_payload_algorithm text,
  p_payload_key_version text,
  p_payload_sanitized jsonb,
  p_occurred_at timestamptz,
  p_answers_config_snapshot jsonb default '{"fields": []}'::jsonb,
  p_retention_days integer default 30,
  p_stuck_after_minutes integer default 60
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_endpoint public.form_endpoints;
  v_existing public.webhook_events;
  v_event public.webhook_events;
  v_existing_outbox_id uuid;
  v_received timestamptz;
  v_normalized timestamptz;
  v_code text;
begin
  select * into v_endpoint from public.form_endpoints where id = p_form_endpoint_id;
  if v_endpoint.id is null or v_endpoint.status <> 'active' then
    raise exception 'form_endpoint_unavailable';
  end if;

  -- Defesa em profundidade (item 4 da auditoria pós-dry-run): a borda já
  -- valida `answers_config_snapshot` com o MESMO schema (Zod) antes de
  -- chamar esta RPC, mas a RPC não é chamável só por ali — snapshot
  -- corrompido nunca pode virar `{fields: []}` em silêncio, nem aqui nem
  -- no worker (get_webhook_event_payload): recusa ANTES de gravar
  -- qualquer coisa, com o MESMO validador usado em create/update_form_endpoint.
  perform private.assert_answers_config(coalesce(p_answers_config_snapshot, '{"fields": []}'::jsonb));

  -- Caminho rápido da repetição legítima: sem tentar inserir nada.
  select * into v_existing from public.webhook_events
  where workspace_id = v_endpoint.workspace_id
    and form_endpoint_id = p_form_endpoint_id
    and source_event_id = p_source_event_id;

  if v_existing.id is not null then
    if v_existing.content_hash <> p_content_hash then
      raise exception 'idempotency_payload_conflict';
    end if;
    -- Mesma chave + mesmo hash: reutiliza evento e protocolo. Vale também
    -- para evento já processado, purgado e expired_unprocessed — a
    -- resposta pública é idêntica em todos (contrato §12).
    select id into v_existing_outbox_id from public.outbox where webhook_event_id = v_existing.id;
    return jsonb_build_object(
      'protocol', v_existing.public_protocol,
      'created', false,
      'webhook_event_id', v_existing.id,
      'outbox_id', v_existing_outbox_id
    );
  end if;

  v_received := now();
  if p_occurred_at is null then
    v_normalized := v_received;
    v_code := 'missing_occurred_at';
  elsif p_occurred_at > v_received + interval '5 minutes' then
    v_normalized := v_received;
    v_code := 'future_clamped';
  elsif p_occurred_at < v_received - interval '24 hours' then
    v_normalized := v_received;
    v_code := 'stale_clamped';
  else
    v_normalized := p_occurred_at;
    v_code := 'ok';
  end if;

  insert into public.webhook_events (
    workspace_id, form_endpoint_id, source_event_id, content_hash, public_protocol,
    payload_ciphertext, payload_iv, payload_auth_tag, payload_algorithm, payload_key_version,
    payload_sanitized, answers_config_snapshot, occurred_at, received_at, normalized_occurred_at,
    normalization_code, expires_at, stuck_after
  )
  values (
    v_endpoint.workspace_id, p_form_endpoint_id, p_source_event_id, p_content_hash, p_public_protocol,
    p_payload_ciphertext, p_payload_iv, p_payload_auth_tag, p_payload_algorithm, p_payload_key_version,
    p_payload_sanitized, coalesce(p_answers_config_snapshot, '{"fields": []}'::jsonb),
    p_occurred_at, v_received, v_normalized, v_code,
    v_received + make_interval(days => p_retention_days),
    v_received + make_interval(mins => p_stuck_after_minutes)
  )
  on conflict (workspace_id, form_endpoint_id, source_event_id) do nothing
  returning * into v_event;

  if v_event.id is null then
    -- Perdeu a corrida para uma requisição simultânea idêntica: a outra
    -- transação já gravou. Devolve o protocolo dela (um evento, uma
    -- outbox) — ou recusa, se o conteúdo for diferente.
    select * into v_existing from public.webhook_events
    where workspace_id = v_endpoint.workspace_id
      and form_endpoint_id = p_form_endpoint_id
      and source_event_id = p_source_event_id;

    if v_existing.id is null then
      raise exception 'ingest_conflict_unresolved';
    end if;
    if v_existing.content_hash <> p_content_hash then
      raise exception 'idempotency_payload_conflict';
    end if;
    select id into v_existing_outbox_id from public.outbox where webhook_event_id = v_existing.id;
    return jsonb_build_object(
      'protocol', v_existing.public_protocol,
      'created', false,
      'webhook_event_id', v_existing.id,
      'outbox_id', v_existing_outbox_id
    );
  end if;

  -- Outbox só para evento NOVO — é o que garante que uma repetição não
  -- enfileira processamento de novo.
  insert into public.outbox (workspace_id, webhook_event_id, event_type)
  values (v_endpoint.workspace_id, v_event.id, 'praxis/form.submission.received')
  returning id into v_existing_outbox_id;

  -- `webhook_event_id` e `outbox_id` são devolvidos para uso INTERNO
  -- (publicar no Inngest com um identificador estável e marcar a outbox
  -- published/failed depois da publicação inicial). A rota nunca os
  -- repassa para a resposta pública — lá só vai o protocolo opaco.
  return jsonb_build_object(
    'protocol', v_event.public_protocol,
    'created', true,
    'webhook_event_id', v_event.id,
    'outbox_id', v_existing_outbox_id
  );
end;
$body$;

-- ---------------------------------------------------------------------
-- Outbox: reserva, sucesso e falha
--
-- `for update skip locked` + `lock_expires_at`: duas execuções
-- concorrentes do reconciliador nunca pegam a mesma linha, e um lock
-- abandonado (processo morto no meio) volta a ser elegível sozinho.
-- O reconciliador NUNCA executa efeito comercial — só republica.
-- ---------------------------------------------------------------------

create function public.claim_outbox_batch(
  p_limit integer default 20,
  p_lock_seconds integer default 120
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_result jsonb;
begin
  with candidate as (
    select o.id
    from public.outbox o
    join public.webhook_events w on w.id = o.webhook_event_id
    where o.state in ('pending', 'publishing', 'failed')
      and o.next_attempt_at <= now()
      and (o.lock_expires_at is null or o.lock_expires_at <= now())
      -- Evento já resolvido ou inelegível nunca é republicado.
      and w.status not in ('processed', 'expired_unprocessed', 'purged')
    order by o.next_attempt_at
    limit p_limit
    for update of o skip locked
  ),
  claimed as (
    update public.outbox o
    set state = 'publishing',
        locked_at = now(),
        lock_expires_at = now() + make_interval(secs => p_lock_seconds),
        attempts = o.attempts + 1,
        updated_at = now()
    from candidate c
    where o.id = c.id
    returning o.id, o.webhook_event_id, o.event_type, o.workspace_id, o.attempts
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'outbox_id', id,
    'webhook_event_id', webhook_event_id,
    'event_type', event_type,
    'workspace_id', workspace_id,
    'attempts', attempts
  )), '[]'::jsonb)
  into v_result
  from claimed;

  return v_result;
end;
$body$;

create function public.mark_outbox_published(p_outbox_id uuid)
returns void
language sql
security definer
set search_path = ''
as $body$
  update public.outbox
  set state = 'published', published_at = now(), locked_at = null,
      lock_expires_at = null, last_error_code = null, updated_at = now()
  where id = p_outbox_id;
$body$;

create function public.mark_outbox_failed(
  p_outbox_id uuid,
  p_error_code text,
  p_retry_in_seconds integer default 60
)
returns void
language sql
security definer
set search_path = ''
as $body$
  update public.outbox
  set state = case when attempts >= 10 then 'abandoned'::public.outbox_state else 'failed'::public.outbox_state end,
      -- Só o CÓDIGO sanitizado, nunca a mensagem original (que poderia
      -- carregar fragmento de payload).
      last_error_code = left(coalesce(p_error_code, 'unknown'), 80),
      next_attempt_at = now() + make_interval(secs => p_retry_in_seconds),
      locked_at = null, lock_expires_at = null, updated_at = now()
  where id = p_outbox_id;
$body$;

-- ---------------------------------------------------------------------
-- process_form_event — o worker, numa única transação
--
-- Ordem segura de identidade (contrato §8):
--   1. referência de continuidade válida;
--   2. identidade externa confiável do mesmo workspace/provedor;
--   3. sem identidade confiável → contato novo.
-- Telefone e e-mail NUNCA reutilizam contato: normalizam, levantam
-- candidato a duplicidade e seguem.
--
-- Falha em qualquer etapa desfaz tudo (uma função plpgsql é uma
-- transação). Worker concorrente encontra o evento processado ou
-- bloqueado (`for update`) e não repete efeito: at-least-once com efeitos
-- idempotentes, nunca exactly-once.
-- ---------------------------------------------------------------------

-- Única finalidade de continuity_references que process_form_event honra.
-- Um token emitido para outra finalidade (ex.: futuro portal do cliente)
-- nunca é aceito aqui — mesmo que o hash bata — porque "para que serve o
-- token" é parte da garantia, não só "o token existe e não venceu".
create function private.form_intake_continuity_purpose()
returns text
language sql
immutable
set search_path = ''
as $body$
  select 'form_continuity'::text;
$body$;

revoke all on function private.form_intake_continuity_purpose() from public;

create function public.process_form_event(
  p_webhook_event_id uuid,
  p_input jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_event public.webhook_events;
  v_endpoint public.form_endpoints;
  v_contact public.contacts;
  v_lead public.leads;
  v_opportunity public.opportunities;
  v_continuity public.continuity_references;
  v_touchpoint public.touchpoints;
  v_consent_evidence_id uuid;
  v_contact_consent_id uuid;
  v_activity_id uuid;
  v_phone text := nullif(btrim(p_input #>> '{contact,phone_e164}'), '');
  v_email text := nullif(lower(btrim(p_input #>> '{contact,email}')), '');
  v_name text := nullif(btrim(p_input #>> '{contact,name}'), '');
  v_token_hash bytea := decode(coalesce(p_input ->> 'continuity_token_hash', ''), 'base64');
  v_is_new_demand boolean := true;
  v_position integer;
  v_creator uuid;
begin
  -- 1. Bloqueia o evento. Um worker concorrente espera aqui e, ao entrar,
  --    já encontra o estado final.
  select * into v_event from public.webhook_events where id = p_webhook_event_id for update;
  if v_event.id is null then
    raise exception 'webhook_event_not_found';
  end if;

  if v_event.status = 'processed' then
    return jsonb_build_object(
      'already_processed', true,
      'contact_id', v_event.result_contact_id,
      'lead_id', v_event.result_lead_id,
      'opportunity_id', v_event.result_opportunity_id,
      'touchpoint_id', v_event.result_touchpoint_id
    );
  end if;

  -- Evento vencido sem processamento (ou já purgado) é INELEGÍVEL: nunca
  -- produz efeito comercial tardio (contrato §12).
  if v_event.status in ('expired_unprocessed', 'purged') then
    return jsonb_build_object('ineligible', true, 'status', v_event.status);
  end if;

  select * into v_endpoint from public.form_endpoints where id = v_event.form_endpoint_id;
  if v_endpoint.id is null then
    raise exception 'form_endpoint_not_found';
  end if;

  -- Revalida o destino no PROCESSAMENTO, não só na configuração: a etapa
  -- pode ter virado terminal entre o recebimento e o processamento.
  perform private.assert_form_endpoint_destination(
    v_endpoint.workspace_id, v_endpoint.pipeline_id, v_endpoint.stage_id
  );

  -- Autor técnico das linhas criadas: quem criou o endpoint (created_by é
  -- NOT NULL em leads/opportunities/activities e precisa de um usuário
  -- real). Não é "quem preencheu o formulário" — o visitante não tem
  -- conta; a origem verdadeira fica no touchpoint e no evento.
  v_creator := v_endpoint.created_by;

  -- 2. Identidade — ordem segura.
  --
  -- A ÚNICA identidade confiável que o formulário PÚBLICO aceita é uma
  -- referência de continuidade válida: token aleatório emitido pelo
  -- servidor, entregue fora de banda (ex.: e-mail de confirmação), e
  -- verificado aqui só por hash. NÃO existe caminho de "identidade
  -- externa declarada pelo navegador" nesta função — um visitante
  -- anônimo não tem como se autodeclarar "o mesmo contato que já existe"
  -- (contrato §8: telefone e e-mail NUNCA são identidade; e um provider/
  -- external_id vindo do corpo da requisição seria exatamente tão
  -- forjável quanto telefone/e-mail, só que capaz de reivindicar
  -- QUALQUER contato do workspace, não só o próprio).
  if octet_length(v_token_hash) = 32 then
    select * into v_continuity from public.continuity_references
    where token_hash = v_token_hash
      and workspace_id = v_event.workspace_id
      and revoked_at is null
      and expires_at > now()
      and purpose = private.form_intake_continuity_purpose();
  end if;

  if v_continuity.id is not null then
    select * into v_contact from public.contacts where id = v_continuity.contact_id;
  end if;

  if v_contact.id is null then
    insert into public.contacts (workspace_id, type, name, city, uf, created_by)
    values (
      v_event.workspace_id,
      coalesce(nullif(p_input #>> '{contact,type}', ''), 'pf')::public.contact_type,
      coalesce(v_name, 'Contato sem nome'),
      nullif(btrim(p_input #>> '{contact,city}'), ''),
      nullif(btrim(upper(p_input #>> '{contact,uf}')), ''),
      v_creator
    )
    returning * into v_contact;
  end if;

  -- 3. Telefone e e-mail: normalizam e entram como sinal, nunca como
  --    identidade. `on conflict do nothing` evita duplicar o mesmo valor
  --    no mesmo contato quando o visitante reenvia.
  if v_phone is not null and v_phone ~ '^\+[1-9][0-9]{7,14}$'
     and not exists (
       select 1 from public.contact_phones
       where contact_id = v_contact.id and value_normalized = v_phone
     ) then
    insert into public.contact_phones (workspace_id, contact_id, value_normalized, source)
    values (v_event.workspace_id, v_contact.id, v_phone, 'form');
  end if;

  if v_email is not null and v_email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
     and not exists (
       select 1 from public.contact_emails
       where contact_id = v_contact.id and value_normalized = v_email
     ) then
    insert into public.contact_emails (workspace_id, contact_id, value_normalized, source)
    values (v_event.workspace_id, v_contact.id, v_email, 'form');
  end if;

  -- Candidatos a duplicidade: a MESMA detecção determinística da A3.
  perform private.detect_duplicate_candidates_for(v_contact.id);

  -- 4. Demanda. Continuidade confiável só vale em endpoint de
  --    continuidade; captação nova explícita SEMPRE abre demanda nova,
  --    mesmo com a pessoa identificada (contrato §8).
  if v_continuity.id is not null and v_endpoint.capture_mode = 'continuity' then
    select * into v_lead from public.leads where id = v_continuity.lead_id;
    if v_continuity.opportunity_id is not null then
      select * into v_opportunity from public.opportunities where id = v_continuity.opportunity_id;
    end if;
    v_is_new_demand := false;

    update public.continuity_references
      set last_used_at = now(), used_count = used_count + 1
      where id = v_continuity.id;
  end if;

  if v_is_new_demand then
    insert into public.leads (
      workspace_id, contact_id, legal_area, summary, priority, created_by
    )
    values (
      v_event.workspace_id, v_contact.id, v_endpoint.legal_area,
      nullif(btrim(p_input ->> 'summary'), ''), 'media', v_creator
    )
    returning * into v_lead;

    insert into public.opportunities (
      workspace_id, lead_id, pipeline_id, stage_id, created_by
    )
    values (
      v_event.workspace_id, v_lead.id, v_endpoint.pipeline_id, v_endpoint.stage_id, v_creator
    )
    returning * into v_opportunity;
  end if;

  -- 5. Evidência de consentimento — append-only, versionada, e SEMPRE
  --    com finalidade própria do formulário. Nunca deriva (nem alimenta)
  --    'whatsapp_atendimento': receber um formulário não autoriza envio
  --    ativo por WhatsApp (contrato §11).
  if p_input ? 'consent' then
    if (p_input #>> '{consent,decision}') = 'granted' then
      insert into public.contact_consents (
        workspace_id, contact_id, channel, legal_basis, purpose,
        purpose_code, granted_at, evidence_source, accepted_text, created_by
      )
      values (
        v_event.workspace_id, v_contact.id,
        coalesce(nullif(p_input #>> '{consent,channel}', ''), 'email')::public.contact_channel,
        coalesce(nullif(p_input #>> '{consent,legal_basis}', ''), 'consentimento')::public.consent_legal_basis,
        coalesce(nullif(btrim(p_input #>> '{consent,purpose}'), ''), 'Contato a partir de formulário público'),
        'formulario_contato',
        v_event.received_at,
        'form_endpoint:' || v_endpoint.id::text,
        nullif(btrim(p_input #>> '{consent,accepted_text}'), ''),
        v_creator
      )
      returning id into v_contact_consent_id;
    end if;

    insert into public.consent_evidence (
      workspace_id, contact_id, contact_consent_id, decision, purpose_code, purpose,
      legal_basis, channel, text_version, text_hash, decided_at,
      form_endpoint_id, webhook_event_id, evidence, ip_hmac
    )
    values (
      v_event.workspace_id, v_contact.id, v_contact_consent_id,
      coalesce(nullif(p_input #>> '{consent,decision}', ''), 'refused')::public.consent_decision,
      'formulario_contato',
      coalesce(nullif(btrim(p_input #>> '{consent,purpose}'), ''), 'Contato a partir de formulário público'),
      coalesce(nullif(p_input #>> '{consent,legal_basis}', ''), 'consentimento')::public.consent_legal_basis,
      coalesce(nullif(p_input #>> '{consent,channel}', ''), 'email')::public.contact_channel,
      nullif(btrim(p_input #>> '{consent,text_version}'), ''),
      case when (p_input #>> '{consent,text_hash}') is null then null
           else decode(p_input #>> '{consent,text_hash}', 'base64') end,
      v_event.received_at,
      v_endpoint.id, v_event.id,
      coalesce(p_input -> 'consent' -> 'evidence', '{}'::jsonb),
      case when (p_input ->> 'ip_hmac') is null then null
           else decode(p_input ->> 'ip_hmac', 'base64') end
    )
    returning id into v_consent_evidence_id;
  end if;

  -- 6. Touchpoint — append-only, com a oportunidade JÁ na origem quando
  --    ela é conhecida (é isso que torna a conversão verificável).
  -- `position` é palavra-chave em SQL (POSITION(x IN y)): sempre
  -- qualificada, nunca solta dentro de uma função de agregação.
  select coalesce(max(t.position), 0) + 1 into v_position
  from public.touchpoints t
  where t.workspace_id = v_event.workspace_id and t.contact_id = v_contact.id;

  insert into public.touchpoints (
    workspace_id, contact_id, lead_id, opportunity_id, webhook_event_id,
    occurred_at, received_at, normalized_occurred_at,
    channel, source, medium, campaign, content, term, gclid, fbclid,
    landing_url, referrer, form_endpoint_id, consent_evidence_id, position
  )
  values (
    v_event.workspace_id, v_contact.id, v_lead.id, v_opportunity.id, v_event.id,
    v_event.occurred_at, v_event.received_at, v_event.normalized_occurred_at,
    coalesce(nullif(btrim(p_input #>> '{attribution,channel}'), ''), 'formulario'),
    nullif(btrim(p_input #>> '{attribution,source}'), ''),
    nullif(btrim(p_input #>> '{attribution,medium}'), ''),
    nullif(btrim(p_input #>> '{attribution,campaign}'), ''),
    nullif(btrim(p_input #>> '{attribution,content}'), ''),
    nullif(btrim(p_input #>> '{attribution,term}'), ''),
    nullif(btrim(p_input #>> '{attribution,gclid}'), ''),
    nullif(btrim(p_input #>> '{attribution,fbclid}'), ''),
    nullif(btrim(p_input #>> '{attribution,landing_url}'), ''),
    nullif(btrim(p_input #>> '{attribution,referrer}'), ''),
    v_endpoint.id, v_consent_evidence_id, v_position
  )
  returning * into v_touchpoint;

  -- 7. Vínculo determinístico (raiz da cadeia) quando há oportunidade.
  --    Sem oportunidade (continuidade que aponta só para o lead) não
  --    existe vínculo: o touchpoint fica NÃO atribuído, nunca "chutado"
  --    para alguma oportunidade do lead.
  if v_opportunity.id is not null then
    insert into public.touchpoint_demand_links (
      workspace_id, touchpoint_id, opportunity_id, action, reason
    )
    values (
      v_event.workspace_id, v_touchpoint.id, v_opportunity.id, 'assign',
      'Vínculo de origem da captação'
    );
  end if;

  -- 8. Atividade inicial — SOMENTE junto com demanda nova. Continuidade
  --    (inclusive para oportunidade encerrada) nunca cria atividade, nem
  --    reabre nada.
  if v_is_new_demand then
    insert into public.activities (
      workspace_id, lead_id, opportunity_id, type, title, due_at, has_time,
      source, source_webhook_event_id, created_by
    )
    values (
      v_event.workspace_id, v_lead.id, v_opportunity.id,
      v_endpoint.initial_activity_type,
      'Primeiro contato — ' || v_endpoint.name,
      v_event.received_at + make_interval(mins => v_endpoint.initial_activity_due_minutes),
      true, 'form_intake', v_event.id, v_creator
    )
    returning id into v_activity_id;
  end if;

  -- 9. Referências resultantes + evento processado.
  update public.webhook_events set
    status = 'processed',
    processed_at = now(),
    result_contact_id = v_contact.id,
    result_lead_id = v_lead.id,
    result_opportunity_id = v_opportunity.id,
    result_touchpoint_id = v_touchpoint.id,
    result_activity_id = v_activity_id,
    last_error_code = null
  where id = v_event.id;

  return jsonb_build_object(
    'already_processed', false,
    'contact_id', v_contact.id,
    'lead_id', v_lead.id,
    'opportunity_id', v_opportunity.id,
    'touchpoint_id', v_touchpoint.id,
    'activity_id', v_activity_id,
    'new_demand', v_is_new_demand
  );
end;
$body$;

create function public.mark_webhook_event_failed(
  p_webhook_event_id uuid,
  p_error_code text
)
returns void
language sql
security definer
set search_path = ''
as $body$
  update public.webhook_events
  set status = case when attempts + 1 >= 10 then 'dead'::public.webhook_event_status
                    else 'failed'::public.webhook_event_status end,
      attempts = attempts + 1,
      last_error_code = left(coalesce(p_error_code, 'unknown'), 80)
  where id = p_webhook_event_id
    and status not in ('processed', 'expired_unprocessed', 'purged');
$body$;

-- Só o cliente administrativo (webhooks/jobs). Nunca authenticated/anon:
-- um visitante com a chave publicável não pode pular Turnstile e rate
-- limit chamando a RPC direto.
revoke all on function public.resolve_form_endpoint(text) from public;
grant execute on function public.resolve_form_endpoint(text) to service_role;

revoke all on function public.ingest_form_event(uuid, uuid, bytea, text, bytea, bytea, bytea, text, text, jsonb, timestamptz, jsonb, integer, integer) from public;
grant execute on function public.ingest_form_event(uuid, uuid, bytea, text, bytea, bytea, bytea, text, text, jsonb, timestamptz, jsonb, integer, integer) to service_role;

revoke all on function public.claim_outbox_batch(integer, integer) from public;
grant execute on function public.claim_outbox_batch(integer, integer) to service_role;

revoke all on function public.mark_outbox_published(uuid) from public;
grant execute on function public.mark_outbox_published(uuid) to service_role;

revoke all on function public.mark_outbox_failed(uuid, text, integer) from public;
grant execute on function public.mark_outbox_failed(uuid, text, integer) to service_role;

revoke all on function public.process_form_event(uuid, jsonb) from public;
grant execute on function public.process_form_event(uuid, jsonb) to service_role;

revoke all on function public.mark_webhook_event_failed(uuid, text) from public;
grant execute on function public.mark_webhook_event_failed(uuid, text) to service_role;

-- ---------------------------------------------------------------------
-- get_webhook_event_payload — o que o worker precisa para decifrar
--
-- Existe para que NENHUM caminho da aplicação leia webhook_events
-- direto: as tabelas da A11 são deny-all e todo acesso passa por função,
-- inclusive o do cliente administrativo. Devolve o ciphertext em base64
-- (o worker decifra em memória) — nunca texto em claro, que o banco nem
-- tem como produzir.
-- ---------------------------------------------------------------------

create function public.get_webhook_event_payload(p_webhook_event_id uuid)
returns jsonb
language sql
security definer
stable
set search_path = ''
as $body$
  select jsonb_build_object(
    'id', w.id,
    'status', w.status,
    'ciphertext', case when w.payload_ciphertext is null then null
                       else encode(w.payload_ciphertext, 'base64') end,
    'iv', case when w.payload_iv is null then null else encode(w.payload_iv, 'base64') end,
    'auth_tag', case when w.payload_auth_tag is null then null
                     else encode(w.payload_auth_tag, 'base64') end,
    'algorithm', w.payload_algorithm,
    'key_version', w.payload_key_version,
    -- Fotografia de answers_config no momento da ingestão: o worker
    -- revalida `answers` contra ELA, nunca contra a configuração atual
    -- do endpoint (item 6 da auditoria pós-dry-run).
    'answers_config_snapshot', w.answers_config_snapshot
  )
  from public.webhook_events w
  where w.id = p_webhook_event_id;
$body$;

revoke all on function public.get_webhook_event_payload(uuid) from public;
grant execute on function public.get_webhook_event_payload(uuid) to service_role;
