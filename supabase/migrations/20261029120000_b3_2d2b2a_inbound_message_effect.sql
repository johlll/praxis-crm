-- B3.2d-2b2a — efeito atômico de mensagem RECEBIDA
-- (docs/decisoes/b3-whatsapp-real.md §22).
--
-- public.whatsapp_effect_inbound_message aplica, numa transação só e sob a
-- trava da entrada da inbox:
--   1. inbox no ambiente autenticado, em processing, com o token do claim e
--      a lease vigente; o canal da linha ainda ativo (status ATUAL, não o
--      do momento do claim);
--   2. reserva message.inbound no ledger (contexto lido da inbox);
--   3. resolve a identidade por telefone e BSUID;
--   4. classifica o remetente pelas identidades internas ativas;
--   5. conversa, mensagem e, só para inbound + external com telefone numa
--      conversa nova, a busca e o vínculo de contato, lead e oportunidade,
--      ou a criação deles e da atividade (regras da A7); internal e
--      unresolved gravam só identidade, conversa e mensagem;
--   6. marca a inbox como processed.
-- Qualquer falha desfaz tudo. Workspace, canal, ambiente, provedor e id do
-- evento vêm da linha da inbox, nunca do chamador.
--
-- Fica de fora: status, identidade alterada, eventos de conta, mídia
-- (nenhum arquivo é baixado), saída humana e a ligação do consumidor
-- (B3.2d-2b3). Esta migration não edita as anteriores e não altera dados.

-- ---------------------------------------------------------------------
-- Classificação do remetente: só o casamento com as identidades internas
-- ---------------------------------------------------------------------

-- unresolved: o canal não tem NENHUMA identidade interna ativa (sem
-- cadastro, não há como saber se é o escritório). internal: casa com uma
-- identidade interna ATIVA do canal (telefone, ou o índice cego da mesma
-- versão de chave). external: todas as ativas são comparáveis com o
-- remetente (ao menos um identificador do mesmo tipo dos dois lados) e
-- nenhuma casa. unresolved: alguma ativa não dá para comparar. Nunca o
-- texto, o nome do perfil ou o formato de um id.
create function private.whatsapp_classify_inbound_sender(
  p_channel_id uuid,
  p_phone_e164 text,
  p_bsuid_lookup jsonb
)
returns public.whatsapp_sender_classification
language sql
stable
set search_path = ''
as $body$
  select case
    when exists (
      select 1 from public.whatsapp_internal_identities i
      where i.channel_id = p_channel_id and i.is_active
        and ((p_phone_e164 is not null and i.phone_e164 = p_phone_e164)
          or (i.bsuid_blind_index is not null and p_bsuid_lookup is not null and p_bsuid_lookup ? i.bsuid_key_version
              and i.bsuid_blind_index = decode(p_bsuid_lookup ->> i.bsuid_key_version, 'base64')))
    ) then 'internal'::public.whatsapp_sender_classification
    when exists (
      select 1 from public.whatsapp_internal_identities i
      where i.channel_id = p_channel_id and i.is_active
        and not coalesce(
          (p_phone_e164 is not null and i.phone_e164 is not null)
          or (i.bsuid_blind_index is not null and p_bsuid_lookup is not null and p_bsuid_lookup ? i.bsuid_key_version),
          false)
    ) then 'unresolved'::public.whatsapp_sender_classification
    else 'external'::public.whatsapp_sender_classification
  end;
$body$;

revoke all on function private.whatsapp_classify_inbound_sender(uuid, text, jsonb) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------
-- Resolução da identidade (telefone e BSUID)
-- ---------------------------------------------------------------------

-- Devolve a identidade do remetente no canal, criando ou acrescentando o
-- identificador que falta. Telefone e BSUID de identidades diferentes, ou
-- um identificador conhecido com o outro já ocupado por valor diferente:
-- identity_conflict (sem auto-merge). Quem chama já segura as travas do
-- telefone e do BSUID: duas transações nunca criam identidades separadas
-- para o mesmo par.
create function private.whatsapp_resolve_inbound_identity(
  p_inbox public.whatsapp_webhook_inbox,
  p_phone_e164 text,
  p_bsuid_lookup jsonb,
  p_bsuid_blind_index bytea,
  p_bsuid_ciphertext bytea,
  p_bsuid_key_version text
)
returns public.whatsapp_identities
language plpgsql
set search_path = ''
as $body$
declare
  v_by_phone public.whatsapp_identities;
  v_by_bsuid public.whatsapp_identities;
  v_identity public.whatsapp_identities;
begin
  if p_phone_e164 is not null then
    select i.* into v_by_phone from public.whatsapp_identities i
    where i.channel_id = p_inbox.channel_id and i.phone_e164 = p_phone_e164;
  end if;
  if p_bsuid_lookup is not null then
    select i.* into v_by_bsuid from public.whatsapp_identities i
    where i.channel_id = p_inbox.channel_id
      and i.bsuid_blind_index is not null
      and p_bsuid_lookup ? i.bsuid_key_version
      and i.bsuid_blind_index = decode(p_bsuid_lookup ->> i.bsuid_key_version, 'base64');
  end if;

  if v_by_phone.id is not null and v_by_bsuid.id is not null then
    if v_by_phone.id <> v_by_bsuid.id then
      raise exception 'identity_conflict';
    end if;
    return v_by_phone;
  end if;

  if v_by_phone.id is not null then
    if p_bsuid_lookup is null then
      return v_by_phone;
    end if;
    if v_by_phone.bsuid_blind_index is not null then
      raise exception 'identity_conflict';
    end if;
    update public.whatsapp_identities
    set bsuid_blind_index = p_bsuid_blind_index, bsuid_ciphertext = p_bsuid_ciphertext, bsuid_key_version = p_bsuid_key_version
    where id = v_by_phone.id
    returning * into v_identity;
    return v_identity;
  end if;

  if v_by_bsuid.id is not null then
    if p_phone_e164 is null then
      return v_by_bsuid;
    end if;
    if v_by_bsuid.phone_e164 is not null then
      raise exception 'identity_conflict';
    end if;
    update public.whatsapp_identities set phone_e164 = p_phone_e164
    where id = v_by_bsuid.id
    returning * into v_identity;
    return v_identity;
  end if;

  insert into public.whatsapp_identities (workspace_id, channel_id, environment, provider, phone_e164, bsuid_blind_index, bsuid_ciphertext, bsuid_key_version)
  values (p_inbox.workspace_id, p_inbox.channel_id, p_inbox.environment, p_inbox.provider, p_phone_e164, p_bsuid_blind_index, p_bsuid_ciphertext, p_bsuid_key_version)
  returning * into v_identity;
  return v_identity;
end;
$body$;

revoke all on function private.whatsapp_resolve_inbound_identity(public.whatsapp_webhook_inbox, text, jsonb, bytea, bytea, text)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------
-- Efeito: mensagem recebida
-- ---------------------------------------------------------------------

-- Resultados:
--   applied           — efeito aplicado e inbox processed;
--   duplicate         — o mesmo efeito já estava no ledger para esta
--                       entrada, ou a mensagem do provedor já existe no
--                       canal: nada repetido, inbox processed;
--   already_processed, terminal_failed, claim_lost, not_found — como na
--                       finalização da B3.2d-1, sem mudar nada;
--   identity_conflict — telefone e BSUID não batem com uma identidade só;
--   effect_conflict   — a chave estável já tem outro efeito ou outra
--                       entrada;
--   channel_paused, channel_disconnected, channel_disabled — o canal
--                       deixou de estar ativo depois do claim.
-- Nos conflitos e nos três estados do canal nada fica gravado e o claim
-- continua: quem chama libera ou decide (B3.2d-2b3). Entrada malformada:
-- invalid_inbound_message.
create function public.whatsapp_effect_inbound_message(
  p_inbox_id uuid,
  p_claim_token uuid,
  p_provider_message_id text,
  p_content_kind text,
  p_body_text text,
  p_occurred_at timestamptz,
  p_phone_e164 text,
  p_bsuid_lookup jsonb,
  p_bsuid_ciphertext text,
  p_bsuid_key_version text,
  p_profile_name text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_env public.whatsapp_environment := private.require_whatsapp_environment();
  v_body text := nullif(btrim(coalesce(p_body_text, '')), '');
  v_profile text := nullif(btrim(coalesce(p_profile_name, '')), '');
  v_blind bytea;
  v_cipher bytea;
  v_lookup_key text;
  v_row public.whatsapp_webhook_inbox;
  v_channel public.whatsapp_channels;
  v_now timestamptz;
  v_reserve record;
  v_existing_message uuid;
  v_identity public.whatsapp_identities;
  v_class public.whatsapp_sender_classification;
  v_conversation public.conversations;
  v_new_conversation boolean := false;
  v_contact_id uuid;
  v_candidate_contact_ids uuid[];
  v_candidate_count integer;
  v_lead_id uuid;
  v_opportunity_id uuid;
  v_candidate_lead_ids uuid[];
  v_lead_count integer;
  v_open_opp_count integer;
  v_needs_review boolean := false;
  v_contact_created boolean := false;
  v_pipeline_id uuid;
  v_stage_id uuid;
  v_message_id uuid;
  v_activity_id uuid;
  v_locks bigint[];
  v_lock bigint;
begin
  -- Entrada: falha fechada antes de qualquer trava ou escrita.
  if p_provider_message_id is null or p_provider_message_id !~ '^\S{1,255}$'
     or p_content_kind is null or p_content_kind not in (
       'text', 'image', 'video', 'audio', 'document', 'sticker', 'location', 'contacts',
       'interactive', 'button', 'reaction', 'order', 'request_welcome', 'template', 'unsupported', 'other')
     or (p_content_kind = 'text' and v_body is null)
     or char_length(coalesce(v_body, '')) > 4096
     or p_occurred_at is null
     or (p_phone_e164 is not null and p_phone_e164 !~ '^\+[1-9][0-9]{7,14}$')
     or (p_phone_e164 is null and p_bsuid_lookup is null)
     or char_length(coalesce(v_profile, '')) > 160 then
    raise exception 'invalid_inbound_message';
  end if;
  if p_bsuid_lookup is not null or p_bsuid_ciphertext is not null or p_bsuid_key_version is not null then
    if p_bsuid_lookup is null or jsonb_typeof(p_bsuid_lookup) <> 'object'
       or p_bsuid_ciphertext is null or p_bsuid_key_version is null
       or p_bsuid_key_version !~ '^[A-Za-z0-9_-]{1,32}$'
       or not (p_bsuid_lookup ? p_bsuid_key_version)
       or (select count(*) from jsonb_object_keys(p_bsuid_lookup)) > 8 then
      raise exception 'invalid_inbound_message';
    end if;
    for v_lookup_key in select jsonb_object_keys(p_bsuid_lookup) loop
      if v_lookup_key !~ '^[A-Za-z0-9_-]{1,32}$'
         or jsonb_typeof(p_bsuid_lookup -> v_lookup_key) <> 'string'
         or (p_bsuid_lookup ->> v_lookup_key) !~ '^[A-Za-z0-9+/]{43}=$' then
        raise exception 'invalid_inbound_message';
      end if;
    end loop;
    if p_bsuid_ciphertext !~ '^[A-Za-z0-9+/]+={0,2}$' or char_length(p_bsuid_ciphertext) > 700 then
      raise exception 'invalid_inbound_message';
    end if;
    v_blind := decode(p_bsuid_lookup ->> p_bsuid_key_version, 'base64');
    v_cipher := decode(p_bsuid_ciphertext, 'base64');
    if octet_length(v_blind) <> 32 or octet_length(v_cipher) not between 29 and 512 then
      raise exception 'invalid_inbound_message';
    end if;
  end if;

  if p_inbox_id is null then
    return jsonb_build_object('outcome', 'not_found');
  end if;

  -- Trava da entrada: uma execução de cada vez; a outra relê o estado final.
  select i.* into v_row
  from public.whatsapp_webhook_inbox i
  where i.id = p_inbox_id and i.environment = v_env
  for update;
  if not found then
    return jsonb_build_object('outcome', 'not_found');
  end if;
  if v_row.state = 'processed' then
    return jsonb_build_object('outcome', 'already_processed');
  end if;
  if v_row.state = 'failed' then
    return jsonb_build_object('outcome', 'terminal_failed');
  end if;
  if v_row.state <> 'processing' or p_claim_token is null or v_row.claim_token is distinct from p_claim_token then
    return jsonb_build_object('outcome', 'claim_lost');
  end if;
  v_now := clock_timestamp();
  if v_row.lease_until is null or v_row.lease_until <= v_now then
    return jsonb_build_object('outcome', 'claim_lost');
  end if;

  -- O canal da própria linha (a FK da inbox garante que existe), no estado
  -- ATUAL: pausar, desconectar ou desativar depois do claim fecha a porta
  -- antes de qualquer reserva ou efeito. FOR SHARE: uma mudança de estado
  -- concorrente espera este efeito terminar, e o efeito seguinte já a vê.
  select c.* into v_channel from public.whatsapp_channels c
  where c.id = v_row.channel_id and c.workspace_id = v_row.workspace_id
    and c.environment = v_row.environment and c.provider = v_row.provider
  for share;
  if v_channel.status is distinct from 'active' then
    return jsonb_build_object('outcome', case v_channel.status
      when 'paused' then 'channel_paused'
      when 'disconnected' then 'channel_disconnected'
      else 'channel_disabled' end);
  end if;

  begin
    select r.outcome, r.ledger_id into v_reserve
    from private.whatsapp_effect_ledger_reserve(v_row.id, 'message.inbound') r;
    if v_reserve.outcome = 'conflict' then
      raise exception 'effect_conflict';
    end if;
    if v_reserve.outcome = 'duplicate' then
      update public.whatsapp_webhook_inbox
      set state = 'processed', processed_at = v_now, claim_token = null, claimed_at = null, lease_until = null
      where id = v_row.id;
      return jsonb_build_object('outcome', 'duplicate');
    end if;

    -- Travas, sempre na mesma ordem: a mensagem do provedor no canal, o
    -- telefone (a mesma chave do simulador da A7) e o BSUID.
    v_locks := array[hashtextextended(v_row.channel_id::text || ':message:' || p_provider_message_id, 0)];
    if p_phone_e164 is not null then
      v_locks := v_locks || hashtextextended(v_row.channel_id::text || ':' || p_phone_e164, 0);
    end if;
    if v_blind is not null then
      v_locks := v_locks || hashtextextended(v_row.channel_id::text || ':bsuid:' || encode(v_blind, 'hex'), 0);
    end if;
    for v_lock in select l from unnest(v_locks) l order by l loop
      perform pg_advisory_xact_lock(v_lock);
    end loop;

    -- A mesma mensagem do provedor por outro evento: nada repetido.
    select m.id into v_existing_message from public.messages m
    where m.channel_id = v_row.channel_id and m.provider_message_id = p_provider_message_id;
    if v_existing_message is not null then
      update public.whatsapp_effect_ledger set message_id = v_existing_message where id = v_reserve.ledger_id;
      update public.whatsapp_webhook_inbox
      set state = 'processed', processed_at = v_now, claim_token = null, claimed_at = null, lease_until = null
      where id = v_row.id;
      return jsonb_build_object('outcome', 'duplicate');
    end if;

    v_identity := private.whatsapp_resolve_inbound_identity(v_row, p_phone_e164, p_bsuid_lookup, v_blind, v_cipher, p_bsuid_key_version);
    v_class := private.whatsapp_classify_inbound_sender(v_row.channel_id, p_phone_e164, p_bsuid_lookup);

    select c.* into v_conversation from public.conversations c where c.identity_id = v_identity.id;

    if v_conversation.id is null then
      v_new_conversation := true;
      -- Contato e lead (a7-conversas.md §5–§7), só para external com
      -- telefone: o contato é casado pelo telefone, como na A7. internal e
      -- unresolved não procuram, não vinculam e não criam nada comercial,
      -- mesmo que um contato do workspace tenha o mesmo telefone.
      if v_class = 'external' and v_identity.phone_e164 is not null then
        select ct.id into v_contact_id
        from public.contacts ct
        where ct.workspace_id = v_row.workspace_id and ct.merged_into_contact_id is null
          and ct.id in (
            select ci.contact_id from public.contact_identifiers ci
            where ci.workspace_id = v_row.workspace_id and ci.provider = 'whatsapp'
              and ci.external_id = substr(v_identity.phone_e164, 2)
          );

        if v_contact_id is null then
          select array_agg(distinct ct.id) into v_candidate_contact_ids
          from public.contacts ct
          join public.contact_phones cp on cp.contact_id = ct.id
          where ct.workspace_id = v_row.workspace_id and ct.merged_into_contact_id is null
            and cp.workspace_id = v_row.workspace_id and cp.value_normalized = v_identity.phone_e164;
          v_candidate_count := coalesce(array_length(v_candidate_contact_ids, 1), 0);

          if v_candidate_count = 1 then
            v_contact_id := v_candidate_contact_ids[1];
            insert into public.contact_identifiers (workspace_id, contact_id, provider, external_id)
            values (v_row.workspace_id, v_contact_id, 'whatsapp', substr(v_identity.phone_e164, 2))
            on conflict (workspace_id, provider, external_id) do nothing;
          elsif v_candidate_count > 1 then
            v_needs_review := true;
          elsif private.whatsapp_may_create_lead('inbound', v_class) then
            -- Só inbound + external cria contato (e, abaixo, lead).
            v_contact_created := true;
            insert into public.contacts (workspace_id, type, name, preferred_channel, created_by)
            values (v_row.workspace_id, 'pf', coalesce(v_profile, 'Contato WhatsApp ' || v_identity.phone_e164), 'whatsapp', v_channel.created_by)
            returning id into v_contact_id;
            insert into public.contact_phones (workspace_id, contact_id, value_normalized, is_primary, source)
            values (v_row.workspace_id, v_contact_id, v_identity.phone_e164, true, 'whatsapp_inbound');
            insert into public.contact_identifiers (workspace_id, contact_id, provider, external_id)
            values (v_row.workspace_id, v_contact_id, 'whatsapp', substr(v_identity.phone_e164, 2))
            on conflict (workspace_id, provider, external_id) do nothing;
            insert into public.audit_logs (workspace_id, actor_user_id, action, resource_type, resource_id, metadata)
            values (v_row.workspace_id, null, 'contact.created', 'contact', v_contact_id, jsonb_build_object('source', 'whatsapp_inbound'));
          end if;
        end if;

        -- Lead e oportunidade só para contato JÁ conhecido; o novo recebe
        -- os seus abaixo.
        if v_contact_id is not null and not v_contact_created then
          select array_agg(l.id) into v_candidate_lead_ids
          from public.leads l where l.workspace_id = v_row.workspace_id and l.contact_id = v_contact_id and l.status = 'ativo';
          v_lead_count := coalesce(array_length(v_candidate_lead_ids, 1), 0);
          if v_lead_count = 1 then
            v_lead_id := v_candidate_lead_ids[1];
            select count(*) into v_open_opp_count from public.opportunities o where o.lead_id = v_lead_id and o.status = 'open';
            if v_open_opp_count = 1 then
              select o.id into v_opportunity_id from public.opportunities o where o.lead_id = v_lead_id and o.status = 'open';
            elsif v_open_opp_count > 1 then
              v_needs_review := true;
            end if;
          else
            v_needs_review := true;
          end if;
        end if;
      end if;

      -- unresolved sempre vai para revisão humana; external, quando não
      -- achou contato; o próprio escritório, nunca.
      if v_class = 'unresolved' or (v_class = 'external' and v_contact_id is null) then
        v_needs_review := true;
      end if;

      insert into public.conversations (
        workspace_id, channel_id, identity_id, wa_id, contact_id, lead_id, opportunity_id,
        needs_link_review, link_candidate_contact_ids, link_candidate_lead_ids, last_message_at
      )
      values (
        v_row.workspace_id, v_row.channel_id, v_identity.id, v_identity.phone_e164, v_contact_id, v_lead_id, v_opportunity_id,
        v_needs_review, coalesce(v_candidate_contact_ids, '{}'::uuid[]), coalesce(v_candidate_lead_ids, '{}'::uuid[]), p_occurred_at
      )
      returning * into v_conversation;
    elsif v_conversation.wa_id is null and v_identity.phone_e164 is not null then
      -- A identidade ganhou o telefone: a conversa passa a mostrá-lo.
      update public.conversations set wa_id = v_identity.phone_e164 where id = v_conversation.id
      returning * into v_conversation;
    end if;

    insert into public.messages (
      workspace_id, conversation_id, channel_id, direction, origin, sender_classification,
      content_kind, body_text, provider, provider_message_id, status
    )
    values (
      v_row.workspace_id, v_conversation.id, v_row.channel_id, 'inbound', 'inbound', v_class,
      p_content_kind, v_body, v_row.provider, p_provider_message_id, 'delivered'
    )
    returning id into v_message_id;

    update public.conversations
    set last_message_at = greatest(coalesce(last_message_at, p_occurred_at), p_occurred_at)
    where id = v_conversation.id;

    -- Contato novo: lead, oportunidade (pipeline padrão, primeira etapa) e
    -- a atividade de primeiro contato, como create_lead/create_opportunity
    -- da A4/A5 e o simulador da A7. Sem usuário no webhook: a autoria é de
    -- quem configurou o canal; a auditoria fica sem ator.
    if v_contact_created then
      insert into public.leads (workspace_id, contact_id, legal_area, summary, created_by)
      values (v_row.workspace_id, v_contact_id, 'A definir', 'Lead criado automaticamente a partir de mensagem de WhatsApp.', v_channel.created_by)
      returning id into v_lead_id;
      insert into public.audit_logs (workspace_id, actor_user_id, action, resource_type, resource_id, metadata)
      values (v_row.workspace_id, null, 'lead.created', 'lead', v_lead_id, jsonb_build_object('contact_id', v_contact_id, 'source', 'whatsapp_inbound'));

      select p.id into v_pipeline_id from public.pipelines p where p.workspace_id = v_row.workspace_id and p.is_default;
      if v_pipeline_id is null then
        raise exception 'pipeline_not_found';
      end if;
      select s.id into v_stage_id from public.pipeline_stages s where s.pipeline_id = v_pipeline_id order by s.position asc limit 1;
      if v_stage_id is null then
        raise exception 'pipeline_has_no_stages';
      end if;
      insert into public.opportunities (workspace_id, lead_id, pipeline_id, stage_id, created_by)
      values (v_row.workspace_id, v_lead_id, v_pipeline_id, v_stage_id, v_channel.created_by)
      returning id into v_opportunity_id;
      insert into public.audit_logs (workspace_id, actor_user_id, action, resource_type, resource_id, metadata)
      values (
        v_row.workspace_id, null, 'opportunity.created', 'opportunity', v_opportunity_id,
        jsonb_build_object('lead_id', v_lead_id, 'pipeline_id', v_pipeline_id, 'stage_id', v_stage_id, 'source', 'whatsapp_inbound')
      );

      insert into public.activities (
        workspace_id, lead_id, opportunity_id, type, title, due_at, has_time,
        status, source, source_conversation_message_id, created_by
      )
      values (
        v_row.workspace_id, v_lead_id, v_opportunity_id, 'task',
        'Responder mensagem de WhatsApp (novo contato)', now() + interval '1 hour', true,
        'pending', 'whatsapp_inbound', v_message_id, v_channel.created_by
      )
      on conflict (source_conversation_message_id) where source_conversation_message_id is not null do nothing
      returning id into v_activity_id;
      if v_activity_id is not null then
        insert into public.audit_logs (workspace_id, actor_user_id, action, resource_type, resource_id, metadata)
        values (
          v_row.workspace_id, null, 'activity.auto_created', 'activity', v_activity_id,
          jsonb_build_object('source', 'whatsapp_inbound', 'message_id', v_message_id)
        );
      end if;

      update public.conversations
      set lead_id = v_lead_id, opportunity_id = v_opportunity_id, needs_link_review = false
      where id = v_conversation.id;
    end if;

    insert into public.audit_logs (workspace_id, actor_user_id, action, resource_type, resource_id, metadata)
    values (
      v_row.workspace_id, null, 'message.received', 'message', v_message_id,
      jsonb_build_object('conversation_id', v_conversation.id, 'source', 'whatsapp_webhook', 'sender_classification', v_class)
    );

    update public.whatsapp_effect_ledger set message_id = v_message_id where id = v_reserve.ledger_id;

    update public.whatsapp_webhook_inbox
    set state = 'processed', processed_at = v_now, claim_token = null, claimed_at = null, lease_until = null
    where id = v_row.id;

    return jsonb_build_object(
      'outcome', 'applied',
      'message_id', v_message_id,
      'conversation_id', v_conversation.id,
      'sender_classification', v_class,
      'contact_created', v_contact_created,
      'lead_created', v_contact_created
    );
  exception
    when raise_exception then
      -- Os dois conflitos desfazem o bloco (ledger, identidade, conversa,
      -- mensagem) e voltam como resultado; o resto propaga e desfaz tudo.
      if sqlerrm in ('identity_conflict', 'effect_conflict') then
        return jsonb_build_object('outcome', sqlerrm);
      end if;
      raise;
  end;
end;
$body$;

revoke all on function public.whatsapp_effect_inbound_message(uuid, uuid, text, text, text, timestamptz, text, jsonb, text, text, text)
  from public, anon, authenticated;
grant execute on function public.whatsapp_effect_inbound_message(uuid, uuid, text, text, text, timestamptz, text, jsonb, text, text, text)
  to service_role;
