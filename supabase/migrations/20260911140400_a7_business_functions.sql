-- A7 — funções de negócio expostas via RPC. Mesmo padrão de sempre:
-- SECURITY DEFINER + `set search_path = ''` + nomes totalmente
-- qualificados; cada uma valida papel/workspace internamente, nunca confia
-- só na RLS (aqui nem se aplica — SECURITY DEFINER roda por cima dela) nem
-- só na permissão já checada pela Server Action que chamou.
--
-- create_whatsapp_channel/simulate_inbound_whatsapp_message/
-- apply_message_status_event exigem owner/admin — mais restrito que o
-- "administrativo" das outras fases (que inclui manager), decisão
-- documentada em docs/decisoes/a7-conversas.md §3.

-- ---------------------------------------------------------------------
-- create_whatsapp_channel
-- ---------------------------------------------------------------------

create function public.create_whatsapp_channel(
  p_workspace_id uuid,
  p_label text,
  p_phone_number_id text,
  p_display_phone_number text
)
returns public.whatsapp_channels
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_actor uuid := auth.uid();
  v_channel public.whatsapp_channels;
begin
  if v_actor is null then
    raise exception 'authentication_required';
  end if;

  if not private.has_workspace_role(p_workspace_id, array['owner', 'admin']::public.membership_role[]) then
    raise exception 'insufficient_permission';
  end if;

  insert into public.whatsapp_channels (workspace_id, label, phone_number_id, display_phone_number)
  values (p_workspace_id, btrim(p_label), btrim(p_phone_number_id), btrim(p_display_phone_number))
  returning * into v_channel;

  insert into public.audit_logs (workspace_id, actor_user_id, action, resource_type, resource_id, metadata)
  values (p_workspace_id, v_actor, 'whatsapp_channel.created', 'whatsapp_channel', v_channel.id, jsonb_build_object('label', v_channel.label));

  return v_channel;
exception
  when unique_violation then
    raise exception 'channel_phone_number_id_taken';
end;
$body$;

revoke all on function public.create_whatsapp_channel(uuid, text, text, text) from public;
grant execute on function public.create_whatsapp_channel(uuid, text, text, text) to authenticated;

-- ---------------------------------------------------------------------
-- simulate_inbound_whatsapp_message — o núcleo da A7. Ver
-- docs/decisoes/a7-conversas.md §2 (resolução de workspace), §5-§7
-- (resolução de contato/lead/oportunidade) e §8 (idempotência em três
-- camadas) para o raciocínio completo antes de mexer aqui.
--
-- p_from_wa_id_raw: dígitos crus do evento (ex.: "5511999999999", como o
-- campo `from`/`contacts[].wa_id` real da Meta) — usado só como chave de
-- contact_identifiers. p_from_e164: MESMO número já normalizado em Node
-- via normalizePhoneBR (@/lib/normalize, já usado por toda a A3) — usado
-- para casar contact_phones e para conversations.wa_id. As duas formas
-- vêm prontas de fora: esta função nunca normaliza telefone sozinha (uma
-- única implementação de normalização, a mesma da A3).
-- ---------------------------------------------------------------------

create function public.simulate_inbound_whatsapp_message(
  p_phone_number_id text,
  p_from_wa_id_raw text,
  p_from_e164 text,
  p_wa_message_id text,
  p_event_timestamp timestamptz,
  p_body_text text,
  p_profile_name text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_actor uuid := auth.uid();
  v_channel public.whatsapp_channels;
  v_existing record;
  v_conversation public.conversations;
  v_contact_id uuid;
  v_candidate_contact_ids uuid[];
  v_candidate_count integer;
  v_lead_id uuid;
  v_opportunity_id uuid;
  v_candidate_lead_ids uuid[];
  v_lead_count integer;
  v_open_opp_count integer;
  v_needs_review boolean := false;
  v_is_new_contact boolean := false;
  v_message_id uuid;
  v_activity_id uuid;
begin
  if v_actor is null then
    raise exception 'authentication_required';
  end if;

  select * into v_channel from public.whatsapp_channels where phone_number_id = p_phone_number_id;
  if v_channel.id is null then
    raise exception 'channel_not_found';
  end if;
  if v_channel.status <> 'active' then
    raise exception 'channel_disabled';
  end if;

  if not private.has_workspace_role(v_channel.workspace_id, array['owner', 'admin']::public.membership_role[]) then
    raise exception 'insufficient_permission';
  end if;

  -- Idempotência, camadas 2 e 3 (a7-conversas.md §8): o lock precisa vir
  -- ANTES da checagem de evento repetido — checar primeiro e travar depois
  -- deixaria uma janela em que duas chamadas concorrentes com o MESMO
  -- wa_message_id passam as duas pela checagem "não existe ainda" antes de
  -- qualquer uma commitar, e a segunda bateria de frente na constraint
  -- única em vez de devolver o resultado já existente. Travando primeiro,
  -- a segunda chamada só prossegue depois que a primeira já commitou (ou
  -- fez rollback) — a checagem abaixo, feita DEPOIS do lock, sempre vê o
  -- estado final e verdadeiro.
  perform pg_advisory_xact_lock(hashtextextended(v_channel.id::text || ':' || p_from_e164, 0));

  select m.id, m.conversation_id into v_existing
  from public.messages m
  where m.channel_id = v_channel.id and m.wa_message_id = p_wa_message_id;

  if v_existing.id is not null then
    select * into v_conversation from public.conversations where id = v_existing.conversation_id;
    return jsonb_build_object(
      'conversation_id', v_conversation.id,
      'message_id', v_existing.id,
      'contact_id', v_conversation.contact_id,
      'lead_id', v_conversation.lead_id,
      'opportunity_id', v_conversation.opportunity_id,
      'needs_link_review', v_conversation.needs_link_review,
      'was_new_contact', false,
      'duplicate_event', true
    );
  end if;

  select * into v_conversation
  from public.conversations
  where workspace_id = v_channel.workspace_id and channel_id = v_channel.id and wa_id = p_from_e164;

  if v_conversation.id is null then
    -- Resolução de contato (a7-conversas.md §5) — só roda na criação da
    -- conversa; conversas existentes já têm seu vínculo, resolvido ou
    -- pendente, e uma mensagem nova nunca reabre essa decisão sozinha.
    select id into v_contact_id
    from public.contacts
    where workspace_id = v_channel.workspace_id
      and merged_into_contact_id is null
      and id in (
        select contact_id from public.contact_identifiers
        where workspace_id = v_channel.workspace_id and provider = 'whatsapp' and external_id = p_from_wa_id_raw
      );

    if v_contact_id is null then
      select array_agg(distinct c.id) into v_candidate_contact_ids
      from public.contacts c
      join public.contact_phones cp on cp.contact_id = c.id
      where c.workspace_id = v_channel.workspace_id
        and c.merged_into_contact_id is null
        and cp.workspace_id = v_channel.workspace_id
        and cp.value_normalized = p_from_e164;

      v_candidate_count := coalesce(array_length(v_candidate_contact_ids, 1), 0);

      if v_candidate_count = 1 then
        v_contact_id := v_candidate_contact_ids[1];
        insert into public.contact_identifiers (workspace_id, contact_id, provider, external_id)
        values (v_channel.workspace_id, v_contact_id, 'whatsapp', p_from_wa_id_raw)
        on conflict (workspace_id, provider, external_id) do nothing;
      elsif v_candidate_count > 1 then
        v_needs_review := true;
      else
        v_is_new_contact := true;
        insert into public.contacts (workspace_id, type, name, preferred_channel)
        values (
          v_channel.workspace_id, 'pf',
          coalesce(nullif(btrim(coalesce(p_profile_name, '')), ''), 'Contato WhatsApp ' || p_from_e164),
          'whatsapp'
        )
        returning id into v_contact_id;

        insert into public.contact_phones (workspace_id, contact_id, value_normalized, is_primary, source)
        values (v_channel.workspace_id, v_contact_id, p_from_e164, true, 'whatsapp_inbound');

        insert into public.contact_identifiers (workspace_id, contact_id, provider, external_id)
        values (v_channel.workspace_id, v_contact_id, 'whatsapp', p_from_wa_id_raw);

        insert into public.audit_logs (workspace_id, actor_user_id, action, resource_type, resource_id, metadata)
        values (v_channel.workspace_id, v_actor, 'contact.created', 'contact', v_contact_id, jsonb_build_object('source', 'whatsapp_inbound'));
      end if;
    end if;

    -- Resolução de lead/oportunidade (a7-conversas.md §7) — só para
    -- contato JÁ conhecido; contato novo segue direto para a criação
    -- automática abaixo (§6), que já cria lead+oportunidade próprios.
    if v_contact_id is not null and not v_is_new_contact then
      select array_agg(id) into v_candidate_lead_ids
      from public.leads
      where workspace_id = v_channel.workspace_id and contact_id = v_contact_id and status = 'ativo';

      v_lead_count := coalesce(array_length(v_candidate_lead_ids, 1), 0);

      if v_lead_count = 1 then
        v_lead_id := v_candidate_lead_ids[1];
        select count(*) into v_open_opp_count from public.opportunities where lead_id = v_lead_id and status = 'open';
        if v_open_opp_count = 1 then
          select id into v_opportunity_id from public.opportunities where lead_id = v_lead_id and status = 'open';
        elsif v_open_opp_count > 1 then
          v_needs_review := true;
        end if;
      elsif v_lead_count > 1 then
        v_needs_review := true;
      else
        -- 0 leads ativos: contato conhecido sem negociação em andamento —
        -- fica pendente de vínculo humano, nunca cria lead sozinho aqui
        -- (só o caminho de contato genuinamente novo cria — a7-conversas.md §6).
        v_needs_review := true;
      end if;
    end if;

    if v_contact_id is null then
      v_needs_review := true;
    end if;

    insert into public.conversations (
      workspace_id, channel_id, wa_id, contact_id, lead_id, opportunity_id,
      needs_link_review, link_candidate_contact_ids, link_candidate_lead_ids, last_message_at
    )
    values (
      v_channel.workspace_id, v_channel.id, p_from_e164, v_contact_id, v_lead_id, v_opportunity_id,
      v_needs_review, coalesce(v_candidate_contact_ids, '{}'::uuid[]), coalesce(v_candidate_lead_ids, '{}'::uuid[]),
      p_event_timestamp
    )
    -- Defesa em profundidade redundante com o advisory lock acima (mesmo
    -- espírito do "on conflict...do nothing" já usado na A6): RETURNING
    -- sempre devolve a linha vigente, mesmo no caminho teoricamente
    -- inatingível de conflito.
    on conflict (workspace_id, channel_id, wa_id) do update set updated_at = now()
    returning * into v_conversation;
  end if;

  insert into public.messages (workspace_id, conversation_id, channel_id, direction, wa_message_id, body_text, status)
  values (v_channel.workspace_id, v_conversation.id, v_channel.id, 'inbound', p_wa_message_id, p_body_text, 'delivered')
  returning id into v_message_id;

  update public.conversations
  set last_message_at = greatest(coalesce(last_message_at, p_event_timestamp), p_event_timestamp)
  where id = v_conversation.id;

  -- Atividade automática de primeiro contato (a7-conversas.md §6) — só no
  -- caminho "contato genuinamente novo", o critério de aceite literal do
  -- plano. create_lead()/create_opportunity() são as MESMAS funções já
  -- testadas da A4/A5 (nunca reimplementadas aqui) — cuidam de validação,
  -- pipeline padrão e do próprio audit_log de criação.
  if v_is_new_contact then
    v_lead_id := public.create_lead(
      v_channel.workspace_id, v_contact_id, 'A definir',
      'Lead criado automaticamente a partir de mensagem de WhatsApp.'
    );
    v_opportunity_id := public.create_opportunity(v_lead_id);

    insert into public.activities (
      workspace_id, lead_id, opportunity_id, type, title, due_at, has_time,
      status, source, source_conversation_message_id
    )
    values (
      v_channel.workspace_id, v_lead_id, v_opportunity_id, 'task',
      'Responder mensagem de WhatsApp (novo contato)', now() + interval '1 hour', true,
      'pending', 'whatsapp_inbound', v_message_id
    )
    on conflict (source_conversation_message_id) where source_conversation_message_id is not null do nothing
    returning id into v_activity_id;

    if v_activity_id is not null then
      insert into public.audit_logs (workspace_id, actor_user_id, action, resource_type, resource_id, metadata)
      values (
        v_channel.workspace_id, v_actor, 'activity.auto_created', 'activity', v_activity_id,
        jsonb_build_object('source', 'whatsapp_inbound', 'message_id', v_message_id)
      );
    end if;

    update public.conversations
    set lead_id = v_lead_id, opportunity_id = v_opportunity_id, needs_link_review = false
    where id = v_conversation.id
    returning * into v_conversation;
  end if;

  insert into public.audit_logs (workspace_id, actor_user_id, action, resource_type, resource_id, metadata)
  values (
    v_channel.workspace_id, v_actor, 'message.received', 'message', v_message_id,
    jsonb_build_object('conversation_id', v_conversation.id, 'simulated', true)
  );

  return jsonb_build_object(
    'conversation_id', v_conversation.id,
    'message_id', v_message_id,
    'contact_id', v_conversation.contact_id,
    'lead_id', v_conversation.lead_id,
    'opportunity_id', v_conversation.opportunity_id,
    'needs_link_review', v_conversation.needs_link_review,
    'was_new_contact', v_is_new_contact,
    'duplicate_event', false
  );
end;
$body$;

revoke all on function public.simulate_inbound_whatsapp_message(text, text, text, text, timestamptz, text, text) from public;
grant execute on function public.simulate_inbound_whatsapp_message(text, text, text, text, timestamptz, text, text) to authenticated;

-- ---------------------------------------------------------------------
-- apply_message_status_event — simula sent/delivered/read/failed.
-- Idempotente e resistente a fora-de-ordem via private.message_status_rank
-- + "select ... for update" (serializa dois eventos concorrentes da MESMA
-- mensagem — sem isso, duas checagens de rank concorrentes poderiam ler o
-- mesmo status "antes" e as duas decidirem aplicar).
-- ---------------------------------------------------------------------

create function public.apply_message_status_event(
  p_phone_number_id text,
  p_wa_message_id text,
  p_status public.message_status,
  p_event_timestamp timestamptz,
  p_error_code text default null,
  p_error_message text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_actor uuid := auth.uid();
  v_channel public.whatsapp_channels;
  v_message public.messages;
  v_applied boolean := false;
  v_current_rank smallint;
  v_new_rank smallint;
  v_final_status public.message_status;
begin
  if v_actor is null then
    raise exception 'authentication_required';
  end if;

  if p_status = 'queued' then
    raise exception 'invalid_status_event';
  end if;

  select * into v_channel from public.whatsapp_channels where phone_number_id = p_phone_number_id;
  if v_channel.id is null then
    raise exception 'channel_not_found';
  end if;

  if not private.has_workspace_role(v_channel.workspace_id, array['owner', 'admin']::public.membership_role[]) then
    raise exception 'insufficient_permission';
  end if;

  select * into v_message from public.messages
  where channel_id = v_channel.id and wa_message_id = p_wa_message_id
  for update;

  if v_message.id is null then
    raise exception 'message_not_found';
  end if;

  v_current_rank := private.message_status_rank(v_message.status);
  v_new_rank := private.message_status_rank(p_status);

  if p_status = 'failed' then
    v_applied := v_current_rank <= 1 and v_message.status <> 'failed';
  else
    v_applied := v_new_rank > v_current_rank and v_message.status <> 'failed';
  end if;

  if v_applied then
    update public.messages
    set status = p_status,
        status_updated_at = p_event_timestamp,
        error_reason = case when p_status = 'failed' then p_error_message else null end
    where id = v_message.id;
  end if;

  insert into public.message_status_events (
    workspace_id, message_id, status, event_wa_timestamp, error_code, error_message, applied
  )
  values (v_channel.workspace_id, v_message.id, p_status, p_event_timestamp, p_error_code, p_error_message, v_applied)
  on conflict (message_id, status, event_wa_timestamp) do nothing;

  select status into v_final_status from public.messages where id = v_message.id;

  return jsonb_build_object('message_id', v_message.id, 'applied', v_applied, 'status', v_final_status);
end;
$body$;

revoke all on function public.apply_message_status_event(text, text, public.message_status, timestamptz, text, text) from public;
grant execute on function public.apply_message_status_event(text, text, public.message_status, timestamptz, text, text) to authenticated;

-- ---------------------------------------------------------------------
-- send_message — único caminho de envio ativo (simulador e a conexão real
-- futura reaproveitam sem modificação). Consentimento verificado aqui
-- dentro, nunca contornável pela tela do simulador.
-- ---------------------------------------------------------------------

create function public.send_message(
  p_conversation_id uuid,
  p_body_text text,
  p_client_dedupe_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_actor uuid := auth.uid();
  v_role public.membership_role;
  v_conversation public.conversations;
  v_lead_assigned_to uuid;
  v_channel_id uuid;
  v_existing_id uuid;
  v_message_id uuid;
  v_wa_message_id text;
begin
  if v_actor is null then
    raise exception 'authentication_required';
  end if;

  select * into v_conversation from public.conversations where id = p_conversation_id;
  if v_conversation.id is null then
    raise exception 'conversation_not_found';
  end if;

  if not private.has_workspace_role(
    v_conversation.workspace_id, array['owner', 'admin', 'manager', 'lawyer', 'sales']::public.membership_role[]
  ) then
    raise exception 'insufficient_permission';
  end if;

  select role into v_role from public.memberships
  where workspace_id = v_conversation.workspace_id and user_id = v_actor and status = 'active';

  select assigned_to into v_lead_assigned_to from public.leads where id = v_conversation.lead_id;

  if not private.conversation_accessible_to_role(v_role, v_conversation.lead_id, v_lead_assigned_to, v_actor) then
    raise exception 'conversation_not_found';
  end if;

  -- Idempotência de reenvio (a7-conversas.md §8, 4ª camada): mesma
  -- composição já aceita — devolve sem duplicar, nunca erro.
  select id into v_existing_id from public.messages
  where conversation_id = p_conversation_id and client_dedupe_key = p_client_dedupe_key;
  if v_existing_id is not null then
    return jsonb_build_object('message_id', v_existing_id, 'duplicate_submit', true);
  end if;

  if v_conversation.contact_id is null then
    raise exception 'conversation_not_linked';
  end if;

  if not private.contact_has_active_consent(v_conversation.contact_id, 'whatsapp') then
    raise exception 'consent_required';
  end if;

  v_channel_id := v_conversation.channel_id;
  v_wa_message_id := 'wamid.sim.' || replace(gen_random_uuid()::text, '-', '');

  insert into public.messages (
    workspace_id, conversation_id, channel_id, direction, wa_message_id,
    client_dedupe_key, body_text, status, sent_by
  )
  values (
    v_conversation.workspace_id, p_conversation_id, v_channel_id, 'outbound', v_wa_message_id,
    p_client_dedupe_key, p_body_text, 'sent', v_actor
  )
  -- O índice de client_dedupe_key é PARCIAL (where client_dedupe_key is
  -- not null) — o Postgres só infere um índice parcial para ON CONFLICT se
  -- a cláusula repetir o MESMO predicado (mesmo achado já documentado na
  -- A6, 20260911120500_a6_move_stage_auto_activity.sql); sem o WHERE aqui,
  -- falha em runtime com "no unique or exclusion constraint matching" —
  -- confirmado ao vivo contra o hospedado antes desta correção.
  on conflict (conversation_id, client_dedupe_key) where client_dedupe_key is not null do nothing
  returning id into v_message_id;

  if v_message_id is null then
    -- Corrida perdida: outra chamada com a MESMA client_dedupe_key já
    -- comitou entre a checagem acima e este INSERT.
    select id into v_message_id from public.messages
    where conversation_id = p_conversation_id and client_dedupe_key = p_client_dedupe_key;
    return jsonb_build_object('message_id', v_message_id, 'duplicate_submit', true);
  end if;

  update public.conversations set last_message_at = now() where id = p_conversation_id;

  insert into public.audit_logs (workspace_id, actor_user_id, action, resource_type, resource_id, metadata)
  values (
    v_conversation.workspace_id, v_actor, 'message.sent', 'message', v_message_id,
    jsonb_build_object('conversation_id', p_conversation_id, 'simulated', true)
  );

  return jsonb_build_object('message_id', v_message_id, 'duplicate_submit', false);
end;
$body$;

revoke all on function public.send_message(uuid, text, uuid) from public;
grant execute on function public.send_message(uuid, text, uuid) to authenticated;

-- ---------------------------------------------------------------------
-- resolve_conversation_link — resolução humana de ambiguidade (contato
-- e/ou lead e/ou oportunidade). owner/admin/manager — mesmo nível de
-- contact.merge (também resolve ambiguidade de identidade).
-- ---------------------------------------------------------------------

create function public.resolve_conversation_link(
  p_conversation_id uuid,
  p_contact_id uuid default null,
  p_lead_id uuid default null,
  p_opportunity_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_actor uuid := auth.uid();
  v_conversation public.conversations;
  v_contact_id uuid;
  v_lead public.leads;
  v_opportunity public.opportunities;
begin
  if v_actor is null then
    raise exception 'authentication_required';
  end if;

  select * into v_conversation from public.conversations where id = p_conversation_id;
  if v_conversation.id is null then
    raise exception 'conversation_not_found';
  end if;

  if not private.has_workspace_role(
    v_conversation.workspace_id, array['owner', 'admin', 'manager']::public.membership_role[]
  ) then
    raise exception 'insufficient_permission';
  end if;

  v_contact_id := coalesce(v_conversation.contact_id, p_contact_id);
  if v_contact_id is null then
    raise exception 'contact_required';
  end if;

  if not exists (
    select 1 from public.contacts
    where id = v_contact_id and workspace_id = v_conversation.workspace_id and merged_into_contact_id is null
  ) then
    raise exception 'contact_not_found';
  end if;

  if p_lead_id is not null then
    select * into v_lead from public.leads where id = p_lead_id and workspace_id = v_conversation.workspace_id;
    if v_lead.id is null then
      raise exception 'lead_not_found';
    end if;
    if v_lead.contact_id <> v_contact_id then
      raise exception 'lead_contact_mismatch';
    end if;
  end if;

  if p_opportunity_id is not null then
    if p_lead_id is null then
      raise exception 'lead_required_for_opportunity';
    end if;
    select * into v_opportunity from public.opportunities where id = p_opportunity_id and workspace_id = v_conversation.workspace_id;
    if v_opportunity.id is null then
      raise exception 'opportunity_not_found';
    end if;
    if v_opportunity.lead_id <> p_lead_id then
      raise exception 'opportunity_lead_mismatch';
    end if;
  end if;

  update public.conversations
  set contact_id = v_contact_id,
      lead_id = p_lead_id,
      opportunity_id = p_opportunity_id,
      needs_link_review = false,
      link_candidate_contact_ids = '{}'::uuid[],
      link_candidate_lead_ids = '{}'::uuid[]
  where id = p_conversation_id
  returning * into v_conversation;

  insert into public.audit_logs (workspace_id, actor_user_id, action, resource_type, resource_id, metadata)
  values (
    v_conversation.workspace_id, v_actor, 'conversation.link_resolved', 'conversation', p_conversation_id,
    jsonb_build_object('contact_id', v_contact_id, 'lead_id', p_lead_id, 'opportunity_id', p_opportunity_id)
  );

  return jsonb_build_object(
    'conversation_id', v_conversation.id, 'contact_id', v_conversation.contact_id,
    'lead_id', v_conversation.lead_id, 'opportunity_id', v_conversation.opportunity_id
  );
end;
$body$;

revoke all on function public.resolve_conversation_link(uuid, uuid, uuid, uuid) from public;
grant execute on function public.resolve_conversation_link(uuid, uuid, uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------
-- register_contact_consent / revoke_contact_consent — completa o caminho
-- de escrita de contact_consents que a A3 desenhou (schema+RLS) mas não
-- chegou a expor (comentário original: "SEM tela própria... ausência de
-- registro não significa consentimento"). A7 é a primeira fase que
-- realmente precisa gravar consentimento — mesmo nível de permissão de
-- contact.edit (owner/admin/manager/lawyer/sales).
-- ---------------------------------------------------------------------

create function public.register_contact_consent(
  p_contact_id uuid,
  p_channel public.contact_channel,
  p_legal_basis public.consent_legal_basis,
  p_purpose text,
  p_evidence_source text default null,
  p_accepted_text text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_actor uuid := auth.uid();
  v_contact public.contacts;
  v_consent_id uuid;
begin
  if v_actor is null then
    raise exception 'authentication_required';
  end if;

  select * into v_contact from public.contacts where id = p_contact_id;
  if v_contact.id is null then
    raise exception 'contact_not_found';
  end if;

  if not private.has_workspace_role(
    v_contact.workspace_id, array['owner', 'admin', 'manager', 'lawyer', 'sales']::public.membership_role[]
  ) then
    raise exception 'insufficient_permission';
  end if;

  if btrim(coalesce(p_purpose, '')) = '' then
    raise exception 'purpose_required';
  end if;

  insert into public.contact_consents (
    workspace_id, contact_id, channel, legal_basis, purpose, granted_at, evidence_source, accepted_text, created_by
  )
  values (
    v_contact.workspace_id, p_contact_id, p_channel, p_legal_basis, btrim(p_purpose), now(),
    nullif(btrim(coalesce(p_evidence_source, '')), ''), nullif(btrim(coalesce(p_accepted_text, '')), ''), v_actor
  )
  returning id into v_consent_id;

  insert into public.audit_logs (workspace_id, actor_user_id, action, resource_type, resource_id, metadata)
  values (
    v_contact.workspace_id, v_actor, 'consent.registered', 'contact', p_contact_id,
    jsonb_build_object('consent_id', v_consent_id, 'channel', p_channel)
  );

  return v_consent_id;
end;
$body$;

revoke all on function public.register_contact_consent(uuid, public.contact_channel, public.consent_legal_basis, text, text, text) from public;
grant execute on function public.register_contact_consent(uuid, public.contact_channel, public.consent_legal_basis, text, text, text) to authenticated;

create function public.revoke_contact_consent(p_consent_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_actor uuid := auth.uid();
  v_consent public.contact_consents;
begin
  if v_actor is null then
    raise exception 'authentication_required';
  end if;

  select * into v_consent from public.contact_consents where id = p_consent_id;
  if v_consent.id is null then
    raise exception 'consent_not_found';
  end if;

  if not private.has_workspace_role(
    v_consent.workspace_id, array['owner', 'admin', 'manager', 'lawyer', 'sales']::public.membership_role[]
  ) then
    raise exception 'insufficient_permission';
  end if;

  if v_consent.revoked_at is not null then
    raise exception 'consent_already_revoked';
  end if;

  update public.contact_consents set revoked_at = now() where id = p_consent_id;

  insert into public.audit_logs (workspace_id, actor_user_id, action, resource_type, resource_id, metadata)
  values (v_consent.workspace_id, v_actor, 'consent.revoked', 'contact', v_consent.contact_id, jsonb_build_object('consent_id', p_consent_id));
end;
$body$;

revoke all on function public.revoke_contact_consent(uuid) from public;
grant execute on function public.revoke_contact_consent(uuid) to authenticated;
