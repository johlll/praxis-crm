-- A11 — atividade inicial do formulário com rastreabilidade própria.
--
-- O worker (process_form_event) grava a atividade inicial com
-- source = 'form_intake', mas activities_source_consistency (reescrita na
-- A6 e estendida na A7) só aceitava manual, stage_rule e whatsapp_inbound:
-- todo processamento de nova demanda falhava e desfazia a transação
-- inteira (reproduzido pelo pgTAP 18).
--
-- Mesmo padrão da A7: cada origem exige a SUA coluna de rastreabilidade e
-- só ela. form_intake -> source_webhook_event_id, o evento que gerou a
-- demanda. O índice único parcial garante no banco o que o contrato
-- promete — no máximo uma atividade inicial por evento, mesmo com
-- entrega repetida.
--
-- Forward-only: a função é recriada aqui; a migration anterior não é
-- editada. Nenhuma outra linha de process_form_event muda.

alter table public.activities
  add column source_webhook_event_id uuid;

alter table public.activities
  add constraint activities_source_webhook_event_same_workspace_fkey
  foreign key (workspace_id, source_webhook_event_id)
  references public.webhook_events (workspace_id, id);

create unique index activities_source_webhook_event_id_key
  on public.activities (source_webhook_event_id)
  where source_webhook_event_id is not null;

alter table public.activities
  drop constraint activities_source_consistency;

alter table public.activities
  add constraint activities_source_consistency check (
    (source = 'manual' and source_stage_transition_id is null and source_rule_id is null and source_conversation_message_id is null and source_webhook_event_id is null) or
    (source = 'stage_rule' and source_stage_transition_id is not null and source_conversation_message_id is null and source_webhook_event_id is null) or
    (source = 'whatsapp_inbound' and source_conversation_message_id is not null and source_stage_transition_id is null and source_rule_id is null and source_webhook_event_id is null) or
    (source = 'form_intake' and source_webhook_event_id is not null and source_stage_transition_id is null and source_rule_id is null and source_conversation_message_id is null)
  );

comment on constraint activities_source_consistency on public.activities is
  'Cada source exige sua própria coluna de rastreabilidade (e só ela): stage_rule -> source_stage_transition_id; whatsapp_inbound -> source_conversation_message_id; form_intake -> source_webhook_event_id; manual -> nenhuma.';

create or replace function public.process_form_event(
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
  v_provider text := nullif(btrim(p_input #>> '{external_identity,provider}'), '');
  v_external_id text := nullif(btrim(p_input #>> '{external_identity,external_id}'), '');
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
  if octet_length(v_token_hash) = 32 then
    select * into v_continuity from public.continuity_references
    where token_hash = v_token_hash
      and workspace_id = v_event.workspace_id
      and revoked_at is null
      and expires_at > now();
  end if;

  if v_continuity.id is not null then
    select * into v_contact from public.contacts where id = v_continuity.contact_id;
  elsif v_provider is not null and v_external_id is not null then
    -- Serializa duas mensagens da MESMA identidade (mesmo padrão da A7),
    -- nunca de identidades diferentes.
    perform pg_advisory_xact_lock(
      hashtext(v_event.workspace_id::text || ':' || v_provider || ':' || v_external_id)
    );
    select c.* into v_contact
    from public.contact_identifiers i
    join public.contacts c on c.id = i.contact_id
    where i.workspace_id = v_event.workspace_id
      and i.provider = v_provider
      and i.external_id = v_external_id;
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

    if v_provider is not null and v_external_id is not null then
      insert into public.contact_identifiers (workspace_id, contact_id, provider, external_id)
      values (v_event.workspace_id, v_contact.id, v_provider, v_external_id)
      on conflict (workspace_id, provider, external_id) do nothing;
    end if;
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
