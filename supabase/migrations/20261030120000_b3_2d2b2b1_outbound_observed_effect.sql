-- B3.2d-2b2b1 — efeito atômico de mensagem de SAÍDA OBSERVADA
-- (docs/decisoes/b3-whatsapp-real.md §23).
--
-- Registra no CRM uma mensagem que o escritório JÁ enviou pelo WhatsApp
-- Business App (eco smb.message.echoes / smb.message.created). Não envia
-- nada, não chama o provedor e não toca o chatbot.
--
-- public.whatsapp_effect_outbound_observed aplica, numa transação só e sob
-- a trava da entrada da inbox:
--   1. inbox no ambiente autenticado, em processing, com o token do claim e
--      a lease vigente; o canal da linha ainda ativo (status ATUAL, lido
--      for share, como na B3.2d-2b2a);
--   2. reserva message.outbound_observed no ledger (contexto lido da inbox);
--   3. identidade do destinatário por telefone e BSUID, com as garantias da
--      2b2a (sem auto-merge; identity_conflict);
--   4. a mesma mensagem já gravada (pelo id do provedor ou pelo wamid)
--      converge só se o destinatário for a MESMA identidade da conversa
--      dela: nada repetido, o identificador que faltava é acrescentado;
--      identificadores de mensagens diferentes, ou outro destinatário:
--      message_conflict, nada alterado;
--   5. conversa (reutilizada ou criada; numa conversa nova, vínculo só com
--      contato, lead e oportunidade exatos e únicos, como a A7; ambiguidade
--      ou desconhecido → revisão humana) e mensagem outbound/business_app/
--      internal, sem autor;
--   6. marca a inbox como processed.
-- Nunca cria contato, lead, oportunidade ou atividade: mensagem enviada
-- pelo aplicativo não prova que o destinatário seja um lead novo. Qualquer
-- falha desfaz tudo. Workspace, canal, ambiente, provedor e id do evento
-- vêm da linha da inbox, nunca do chamador.
--
-- Fica de fora: status e custo (B3.2d-2b2b2), identidade alterada e
-- eventos de conta (B3.2d-2b2b3), mídia (nenhum arquivo é baixado), saída
-- iniciada pelo CRM (B3.3) e a ligação do consumidor (B3.2d-2b3). Esta
-- migration não edita as anteriores e não altera dados: só troca a regra de
-- tamanho do wa_message_id e cria a função.

-- ---------------------------------------------------------------------
-- wa_message_id: o limite da A7 (128) passa a ser o do normalizador
-- ---------------------------------------------------------------------

-- O normalizador da YCloud aceita `wamid.` + até 512 caracteres (518 no
-- total); a regra da coluna, herdada da A7, parava em 128. Os ids da A7
-- continuam válidos: só o limite máximo sobe. O formato `wamid.` é do
-- efeito da YCloud (abaixo), não da coluna.
alter table public.messages drop constraint messages_wa_message_id_check;
alter table public.messages
  add constraint messages_wa_message_id_length check (wa_message_id is null or char_length(btrim(wa_message_id)) between 1 and 518);

-- Resultados:
--   applied           — mensagem gravada e inbox processed;
--   duplicate         — o mesmo efeito já estava no ledger para esta
--                       entrada, ou a mensagem já existe no canal (pelo id
--                       do provedor ou pelo wamid) para a MESMA identidade
--                       do destinatário: nada repetido, o identificador que
--                       faltava é acrescentado, inbox processed;
--   already_processed, terminal_failed, claim_lost, not_found — como na
--                       finalização da B3.2d-1, sem mudar nada;
--   channel_paused, channel_disconnected, channel_disabled — o canal
--                       deixou de estar ativo depois do claim;
--   identity_conflict — telefone e BSUID não batem com uma identidade só;
--   message_conflict  — o id do provedor e o wamid apontam para mensagens
--                       diferentes, a mensagem existente tem outro valor
--                       para o mesmo identificador, não é uma saída, ou é de
--                       outro destinatário (outra identidade);
--   effect_conflict   — a chave estável já tem outro efeito ou outra
--                       entrada.
-- Nos conflitos e nos três estados do canal nada fica gravado e o claim
-- continua: quem chama libera ou decide (B3.2d-2b3). Entrada malformada:
-- invalid_outbound_message.
create function public.whatsapp_effect_outbound_observed(
  p_inbox_id uuid,
  p_claim_token uuid,
  p_provider_message_id text,
  p_wa_message_id text,
  p_content_kind text,
  p_body_text text,
  p_occurred_at timestamptz,
  p_phone_e164 text,
  p_bsuid_lookup jsonb,
  p_bsuid_ciphertext text,
  p_bsuid_key_version text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_env public.whatsapp_environment := private.require_whatsapp_environment();
  v_body text := nullif(btrim(coalesce(p_body_text, '')), '');
  v_blind bytea;
  v_cipher bytea;
  v_lookup_key text;
  v_row public.whatsapp_webhook_inbox;
  v_channel public.whatsapp_channels;
  v_now timestamptz;
  v_reserve record;
  v_by_provider public.messages;
  v_by_wamid public.messages;
  v_existing public.messages;
  v_identity public.whatsapp_identities;
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
  v_message_id uuid;
  v_locks bigint[];
  v_lock bigint;
begin
  -- Entrada: falha fechada antes de qualquer trava ou escrita. O wamid tem
  -- o formato e o limite do normalizador da YCloud (`wamid.` + até 512).
  if p_provider_message_id is null or p_provider_message_id !~ '^\S{1,255}$'
     or (p_wa_message_id is not null and p_wa_message_id !~ '^wamid\.[A-Za-z0-9._:=+/-]{1,512}$')
     or p_content_kind is null or p_content_kind not in (
       'text', 'image', 'video', 'audio', 'document', 'sticker', 'location', 'contacts',
       'interactive', 'button', 'reaction', 'order', 'request_welcome', 'template', 'unsupported', 'other')
     or (p_content_kind = 'text' and v_body is null)
     or char_length(coalesce(v_body, '')) > 4096
     or p_occurred_at is null
     or (p_phone_e164 is not null and p_phone_e164 !~ '^\+[1-9][0-9]{7,14}$')
     or (p_phone_e164 is null and p_bsuid_lookup is null) then
    raise exception 'invalid_outbound_message';
  end if;
  if p_bsuid_lookup is not null or p_bsuid_ciphertext is not null or p_bsuid_key_version is not null then
    if p_bsuid_lookup is null or jsonb_typeof(p_bsuid_lookup) <> 'object'
       or p_bsuid_ciphertext is null or p_bsuid_key_version is null
       or p_bsuid_key_version !~ '^[A-Za-z0-9_-]{1,32}$'
       or not (p_bsuid_lookup ? p_bsuid_key_version)
       or (select count(*) from jsonb_object_keys(p_bsuid_lookup)) > 8 then
      raise exception 'invalid_outbound_message';
    end if;
    for v_lookup_key in select jsonb_object_keys(p_bsuid_lookup) loop
      if v_lookup_key !~ '^[A-Za-z0-9_-]{1,32}$'
         or jsonb_typeof(p_bsuid_lookup -> v_lookup_key) <> 'string'
         or (p_bsuid_lookup ->> v_lookup_key) !~ '^[A-Za-z0-9+/]{43}=$' then
        raise exception 'invalid_outbound_message';
      end if;
    end loop;
    if p_bsuid_ciphertext !~ '^[A-Za-z0-9+/]+={0,2}$' or char_length(p_bsuid_ciphertext) > 700 then
      raise exception 'invalid_outbound_message';
    end if;
    v_blind := decode(p_bsuid_lookup ->> p_bsuid_key_version, 'base64');
    v_cipher := decode(p_bsuid_ciphertext, 'base64');
    if octet_length(v_blind) <> 32 or octet_length(v_cipher) not between 29 and 512 then
      raise exception 'invalid_outbound_message';
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
  if v_row.state <> 'processing' then
    return jsonb_build_object('outcome', 'claim_lost');
  end if;
  v_now := clock_timestamp();
  if v_row.lease_until is null or v_row.lease_until <= v_now then
    return jsonb_build_object('outcome', 'claim_lost');
  end if;

  -- O canal da própria linha, no estado ATUAL (a mesma proteção da 2b2a):
  -- FOR SHARE faz uma mudança de estado concorrente esperar este efeito.
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
    from private.whatsapp_effect_ledger_reserve(v_row.id, 'message.outbound_observed') r;
    if v_reserve.outcome = 'conflict' then
      raise exception 'effect_conflict';
    end if;
    if v_reserve.outcome = 'duplicate' then
      update public.whatsapp_webhook_inbox
      set state = 'processed', processed_at = v_now, claim_token = null, claimed_at = null, lease_until = null
      where id = v_row.id;
      return jsonb_build_object('outcome', 'duplicate');
    end if;

    -- Travas, sempre na mesma ordem: o id do provedor (a mesma chave da
    -- 2b2a), o wamid, o telefone (a mesma chave do simulador da A7) e o
    -- BSUID. Dois ecos da mesma mensagem esperam um pelo outro.
    v_locks := array[hashtextextended(v_row.channel_id::text || ':message:' || p_provider_message_id, 0)];
    if p_wa_message_id is not null then
      v_locks := v_locks || hashtextextended(v_row.channel_id::text || ':wamid:' || p_wa_message_id, 0);
    end if;
    if p_phone_e164 is not null then
      v_locks := v_locks || hashtextextended(v_row.channel_id::text || ':' || p_phone_e164, 0);
    end if;
    if v_blind is not null then
      v_locks := v_locks || hashtextextended(v_row.channel_id::text || ':bsuid:' || encode(v_blind, 'hex'), 0);
    end if;
    for v_lock in select l from unnest(v_locks) l order by l loop
      perform pg_advisory_xact_lock(v_lock);
    end loop;

    -- A mesma mensagem por outro evento (reentrega, ou echoes + created):
    -- converge para a mensagem existente, se for do mesmo destinatário.
    select m.* into v_by_provider from public.messages m
    where m.channel_id = v_row.channel_id and m.provider_message_id = p_provider_message_id;
    if p_wa_message_id is not null then
      select m.* into v_by_wamid from public.messages m
      where m.channel_id = v_row.channel_id and m.wa_message_id = p_wa_message_id;
    end if;
    if v_by_provider.id is not null and v_by_wamid.id is not null and v_by_provider.id <> v_by_wamid.id then
      raise exception 'message_conflict';
    end if;
    if v_by_provider.id is not null then
      v_existing := v_by_provider;
    else
      v_existing := v_by_wamid;
    end if;
    if v_existing.id is not null
       and (v_existing.direction <> 'outbound'
         or (v_existing.provider_message_id is not null and v_existing.provider_message_id <> p_provider_message_id)
         or (p_wa_message_id is not null and v_existing.wa_message_id is not null and v_existing.wa_message_id <> p_wa_message_id)) then
      raise exception 'message_conflict';
    end if;

    v_identity := private.whatsapp_resolve_inbound_identity(v_row, p_phone_e164, p_bsuid_lookup, v_blind, v_cipher, p_bsuid_key_version);

    if v_existing.id is not null then
      -- O destinatário tem de ser a identidade da conversa da mensagem
      -- existente (telefone e BSUID complementares dela convergem). Outro
      -- destinatário: conflito, e o bloco desfaz a identidade que a
      -- resolução acima tenha criado ou enriquecido.
      if v_identity.id is distinct from (select c.identity_id from public.conversations c where c.id = v_existing.conversation_id) then
        raise exception 'message_conflict';
      end if;
      update public.messages
      set provider_message_id = coalesce(provider_message_id, p_provider_message_id),
          provider = coalesce(provider, v_row.provider),
          wa_message_id = coalesce(wa_message_id, p_wa_message_id)
      where id = v_existing.id
        and (provider_message_id is null or (wa_message_id is null and p_wa_message_id is not null));
      update public.whatsapp_effect_ledger set message_id = v_existing.id where id = v_reserve.ledger_id;
      update public.whatsapp_webhook_inbox
      set state = 'processed', processed_at = v_now, claim_token = null, claimed_at = null, lease_until = null
      where id = v_row.id;
      return jsonb_build_object('outcome', 'duplicate');
    end if;

    select c.* into v_conversation from public.conversations c where c.identity_id = v_identity.id;

    if v_conversation.id is null then
      -- Vínculo só exato e único (a7-conversas.md §5–§7), pelo telefone;
      -- nunca cria nada e não acrescenta identificador ao contato.
      if v_identity.phone_e164 is not null then
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
          elsif v_candidate_count > 1 then
            v_needs_review := true;
          end if;
        end if;

        if v_contact_id is not null then
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
          elsif v_lead_count > 1 then
            v_needs_review := true;
          end if;
        end if;
      end if;

      -- Destinatário desconhecido (ou só BSUID): revisão humana.
      if v_contact_id is null then
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
      update public.conversations set wa_id = v_identity.phone_e164 where id = v_conversation.id
      returning * into v_conversation;
    end if;

    -- Saída do aplicativo: interna por definição da origem; o CRM não sabe
    -- quem operou o aparelho (sent_by nulo). Nunca chatbot sem correlação.
    insert into public.messages (
      workspace_id, conversation_id, channel_id, direction, origin, sender_classification,
      content_kind, body_text, provider, provider_message_id, wa_message_id, status, status_updated_at
    )
    values (
      v_row.workspace_id, v_conversation.id, v_row.channel_id, 'outbound', 'business_app', 'internal',
      p_content_kind, v_body, v_row.provider, p_provider_message_id, p_wa_message_id, 'sent', p_occurred_at
    )
    returning id into v_message_id;

    update public.conversations
    set last_message_at = greatest(coalesce(last_message_at, p_occurred_at), p_occurred_at)
    where id = v_conversation.id;

    insert into public.audit_logs (workspace_id, actor_user_id, action, resource_type, resource_id, metadata)
    values (
      v_row.workspace_id, null, 'message.observed', 'message', v_message_id,
      jsonb_build_object('conversation_id', v_conversation.id, 'source', 'whatsapp_webhook', 'origin', 'business_app')
    );

    update public.whatsapp_effect_ledger set message_id = v_message_id where id = v_reserve.ledger_id;

    update public.whatsapp_webhook_inbox
    set state = 'processed', processed_at = v_now, claim_token = null, claimed_at = null, lease_until = null
    where id = v_row.id;

    return jsonb_build_object(
      'outcome', 'applied',
      'message_id', v_message_id,
      'conversation_id', v_conversation.id
    );
  exception
    when raise_exception then
      -- Os conflitos desfazem o bloco (ledger, identidade, conversa,
      -- mensagem) e voltam como resultado; o resto propaga e desfaz tudo.
      if sqlerrm in ('identity_conflict', 'message_conflict', 'effect_conflict') then
        return jsonb_build_object('outcome', sqlerrm);
      end if;
      raise;
  end;
end;
$body$;

revoke all on function public.whatsapp_effect_outbound_observed(uuid, uuid, text, text, text, text, timestamptz, text, jsonb, text, text)
  from public, anon, authenticated;
grant execute on function public.whatsapp_effect_outbound_observed(uuid, uuid, text, text, text, text, timestamptz, text, jsonb, text, text)
  to service_role;
