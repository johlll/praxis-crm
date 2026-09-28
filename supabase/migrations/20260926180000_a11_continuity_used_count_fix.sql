-- A11 — used_count/last_used_at de continuity_references devem
-- registrar QUALQUER uso bem-sucedido da referência para IDENTIDADE,
-- não só quando o endpoint tem capture_mode = 'continuity'.
-- `20260921100500_a11_ingestion_functions.sql` já está aplicada em
-- ambientes reais (praxis-crm-dev) — migrations são forward-only (ver
-- plano §15), então a correção entra AQUI, numa migration nova, em vez
-- de editar o arquivo já aplicado. `create or replace` basta: a
-- aridade de `process_form_event` não muda, só o corpo.
--
-- Defeito: um token de continuidade válido resolve `v_continuity` e
-- reaproveita o CONTATO em qualquer capture_mode (esse trecho nunca foi
-- condicionado) — mas o UPDATE que marca `used_count`/`last_used_at`
-- só rodava dentro do bloco condicionado a
-- `capture_mode = 'continuity'`. Um token emitido e usado de verdade
-- (identidade reconhecida) num endpoint `new_intake` ficava com
-- `used_count = 0` e `last_used_at = null` para sempre — a bookkeeping
-- de uso nunca refletia o uso real.
--
-- docs/decisoes/a11-ingestao-atribuicao.md §8.1 (linha ~754) documenta
-- a semântica pretendida sem ressalva de capture_mode: "ela É mutável
-- depois de emitida (used_count, last_used_at por process_form_event...)",
-- "usar ou revogar uma referência" — USO é a resolução da identidade,
-- não a reabertura da demanda.
--
-- Correção: o UPDATE sai do bloco condicionado por capture_mode e passa
-- a rodar sempre que `v_continuity.id is not null` (a mesma condição já
-- usada para reaproveitar o contato) — token inválido, expirado,
-- revogado ou com finalidade incompatível nunca chega a resolver
-- `v_continuity.id`, então continuam nunca incrementando, sem mudança
-- de comportamento nesses casos. A condição de reaproveitar
-- lead/oportunidade (só quando capture_mode = 'continuity') permanece
-- exatamente igual — nenhuma mudança de comportamento comercial, só de
-- observabilidade/auditoria do uso do token.

create or replace function public.process_form_event(p_webhook_event_id uuid, p_input jsonb)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
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

    -- Correção (esta migration): o USO da referência para IDENTIDADE
    -- é registrado aqui, incondicionalmente — nunca dentro do bloco de
    -- reaproveitamento de demanda, que só roda quando
    -- capture_mode = 'continuity'. Um token válido, já resolvido acima
    -- (não expirado, não revogado, finalidade certa), influenciou a
    -- identidade do contato de verdade, em qualquer capture_mode: o
    -- registro de uso tem que refletir isso.
    update public.continuity_references
      set last_used_at = now(), used_count = used_count + 1
      where id = v_continuity.id;
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
$function$;
