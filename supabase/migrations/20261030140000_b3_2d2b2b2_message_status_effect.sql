-- B3.2d-2b2b2 — efeito atômico de STATUS e CUSTO de uma mensagem de saída
-- (docs/decisoes/b3-whatsapp-real.md §24).
--
-- Aplica um NormalizedStatusUpdate (whatsapp.message.updated) a uma
-- mensagem de saída JÁ gravada. Não envia nada, não chama o provedor e não
-- toca o chatbot.
--
-- public.whatsapp_effect_message_status aplica, numa transação só e sob a
-- trava da entrada da inbox:
--   1. inbox no ambiente autenticado, em processing, com o token do claim e
--      a lease vigente; o canal da linha ainda ativo (status ATUAL, lido
--      for share, como nos efeitos anteriores);
--   2. reserva message.status no ledger (contexto lido da inbox);
--   3. trava e localiza a mensagem do mesmo canal pelo id do provedor e
--      pelo wamid (nunca pelo externalId sozinho); nenhuma → o efeito é
--      desfeito e volta message_not_found, recuperável;
--   4. confere os identificadores (mensagens diferentes, mensagem
--      recebida, outro valor) e o destinatário, quando vier (a mesma
--      identidade da conversa da mensagem; sem auto-merge);
--   5. projeta o status (a regra da B3, igual a
--      projectWhatsAppMessageStatus), o código de erro e o custo (igual a
--      projectWhatsAppProviderCost: o final nunca muda; final conflitante →
--      cost_conflict);
--   6. atualiza a mensagem, associa o ledger a ela e marca a inbox como
--      processed.
-- Nunca cria mensagem, conversa, identidade, contato, lead, oportunidade
-- ou atividade, e nunca muda origem, classificação, autoria ou correlação:
-- o externalId é só correlação opaca. Qualquer falha desfaz tudo.
-- Workspace, canal, ambiente, provedor e id do evento vêm da linha da
-- inbox, nunca do chamador.
--
-- Fica de fora: identidade alterada e eventos de conta (B3.2d-2b2b3), a
-- ligação do consumidor (B3.2d-2b3), o envio pelo CRM (B3.3) e mídia. Esta
-- migration não edita as anteriores e não altera dados: só troca a regra
-- de tamanho do provider_external_id e cria a função.

-- ---------------------------------------------------------------------
-- provider_external_id: o limite da coluna passa a ser o do normalizador
-- ---------------------------------------------------------------------

-- O normalizador da YCloud preserva o externalId como texto opaco de até
-- 512 caracteres, sem caractere de controle (§16.6); a regra da coluna
-- (B3.2d-2b1) parava em 255, sem espaço. Os valores já gravados continuam
-- válidos: só o limite sobe. As regras do id do provedor não mudam.
alter table public.messages drop constraint messages_provider_ids_format;
alter table public.messages
  add constraint messages_provider_ids_format check (
    (provider_message_id is null or provider_message_id ~ '^\S{1,255}$')
    and (provider_external_id is null or (char_length(provider_external_id) between 1 and 512 and provider_external_id !~ '[[:cntrl:]]'))
    and (provider_message_id is null or provider is not null)
  );

-- Resultados:
--   applied           — a mensagem mudou (status, erro, custo ou um
--                       identificador que faltava) e a inbox processed;
--   duplicate         — o mesmo efeito já estava no ledger para esta
--                       entrada, ou a projeção não muda nada: inbox
--                       processed;
--   message_not_found — nenhuma mensagem do canal com esse id do provedor
--                       ou wamid ainda: nada gravado (nenhum ledger,
--                       placeholder ou identidade), inbox em processing;
--                       reaplicável depois que a mensagem chegar;
--   message_conflict  — o id do provedor e o wamid apontam para mensagens
--                       diferentes; a mensagem tem outro valor para um
--                       identificador ou para o externalId; não é uma
--                       saída; ou o destinatário é outra identidade (ou
--                       telefone e BSUID de identidades diferentes);
--   cost_conflict     — a mensagem já tem um custo final e o evento traz
--                       outro custo final (valor, moeda ou categoria);
--   effect_conflict   — a chave estável já tem outro efeito ou outra
--                       entrada;
--   already_processed, terminal_failed, claim_lost, not_found — como na
--                       finalização da B3.2d-1, sem mudar nada;
--   channel_paused, channel_disconnected, channel_disabled — o canal
--                       deixou de estar ativo depois do claim.
-- Em message_not_found, nos conflitos e nos três estados do canal nada fica
-- gravado e o claim continua: quem chama libera ou decide (B3.2d-2b3).
-- Entrada malformada: invalid_status_update.
create function public.whatsapp_effect_message_status(
  p_inbox_id uuid,
  p_claim_token uuid,
  p_provider_message_id text,
  p_wa_message_id text,
  p_external_id text,
  p_status text,
  p_error_code text,
  p_occurred_at timestamptz,
  p_phone_e164 text,
  p_bsuid_lookup jsonb,
  p_bsuid_ciphertext text,
  p_bsuid_key_version text,
  p_cost_amount numeric,
  p_cost_currency text,
  p_cost_category text,
  p_cost_finality text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_env public.whatsapp_environment := private.require_whatsapp_environment();
  v_status public.message_status;
  v_cost_amount numeric(18, 6);
  v_cost_finality text;
  v_blind bytea;
  v_cipher bytea;
  v_lookup_key text;
  v_row public.whatsapp_webhook_inbox;
  v_channel public.whatsapp_channels;
  v_now timestamptz;
  v_reserve record;
  v_by_provider public.messages;
  v_by_wamid public.messages;
  v_message public.messages;
  v_identity public.whatsapp_identities;
  v_status_changes boolean;
  v_new_status public.message_status;
  v_new_amount numeric(18, 6);
  v_new_currency text;
  v_new_category text;
  v_new_finality text;
  v_changed boolean;
  v_locks bigint[];
  v_lock bigint;
begin
  -- Entrada: falha fechada antes de qualquer trava ou escrita. O wamid e o
  -- externalId têm os limites do normalizador da YCloud; o código de erro
  -- é só um código opaco bem formado, nunca a mensagem do provedor.
  if p_provider_message_id is null or p_provider_message_id !~ '^\S{1,255}$'
     or p_status is null or p_status not in ('accepted', 'sent', 'delivered', 'read', 'failed')
     or (p_wa_message_id is not null and (p_wa_message_id !~ '^wamid\.[A-Za-z0-9._:=+/-]+$' or char_length(p_wa_message_id) > 518))
     or (p_external_id is not null and (char_length(p_external_id) not between 1 and 512 or p_external_id ~ '[[:cntrl:]]'))
     or (p_error_code is not null and p_error_code !~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$')
     or p_occurred_at is null or not isfinite(p_occurred_at)
     or (p_phone_e164 is not null and p_phone_e164 !~ '^\+[1-9][0-9]{7,14}$') then
    raise exception 'invalid_status_update';
  end if;
  -- Custo completo e coerente, ou nenhum: valor finito e não negativo que
  -- cabe na coluna, moeda ISO 4217, categoria aberta mas bem formada (a
  -- mesma regra do domínio) e final só com a prova de entrega. O custo de
  -- failed é estimativa (failed não é cobrado), mesmo se vier como final.
  if p_cost_amount is not null or p_cost_currency is not null or p_cost_category is not null or p_cost_finality is not null then
    if p_cost_amount is null or p_cost_currency is null or p_cost_finality is null
       or not (p_cost_amount >= 0 and p_cost_amount < 1000000000000)
       or p_cost_currency !~ '^[A-Z]{3}$'
       or (p_cost_category is not null and p_cost_category !~ '^[a-z][a-z0-9_]{0,63}$')
       or p_cost_finality not in ('estimated', 'final')
       or (p_cost_finality = 'final' and p_status not in ('delivered', 'read', 'failed')) then
      raise exception 'invalid_status_update';
    end if;
    v_cost_amount := round(p_cost_amount, 6);
    v_cost_finality := case when p_status = 'failed' then 'estimated' else p_cost_finality end;
  end if;
  if p_bsuid_lookup is not null or p_bsuid_ciphertext is not null or p_bsuid_key_version is not null then
    if p_bsuid_lookup is null or jsonb_typeof(p_bsuid_lookup) <> 'object'
       or p_bsuid_ciphertext is null or p_bsuid_key_version is null
       or p_bsuid_key_version !~ '^[A-Za-z0-9_-]{1,32}$'
       or not (p_bsuid_lookup ? p_bsuid_key_version)
       or (select count(*) from jsonb_object_keys(p_bsuid_lookup)) > 8 then
      raise exception 'invalid_status_update';
    end if;
    for v_lookup_key in select jsonb_object_keys(p_bsuid_lookup) loop
      if v_lookup_key !~ '^[A-Za-z0-9_-]{1,32}$'
         or jsonb_typeof(p_bsuid_lookup -> v_lookup_key) <> 'string'
         or (p_bsuid_lookup ->> v_lookup_key) !~ '^[A-Za-z0-9+/]{43}=$' then
        raise exception 'invalid_status_update';
      end if;
    end loop;
    if p_bsuid_ciphertext !~ '^[A-Za-z0-9+/]+={0,2}$' or char_length(p_bsuid_ciphertext) > 700 then
      raise exception 'invalid_status_update';
    end if;
    v_blind := decode(p_bsuid_lookup ->> p_bsuid_key_version, 'base64');
    v_cipher := decode(p_bsuid_ciphertext, 'base64');
    if octet_length(v_blind) <> 32 or octet_length(v_cipher) not between 29 and 512 then
      raise exception 'invalid_status_update';
    end if;
  end if;
  v_status := p_status::public.message_status;

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

  -- O canal da própria linha, no estado ATUAL (a mesma proteção dos efeitos
  -- anteriores): FOR SHARE faz uma mudança de estado concorrente esperar
  -- este efeito.
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
    from private.whatsapp_effect_ledger_reserve(v_row.id, 'message.status') r;
    if v_reserve.outcome = 'conflict' then
      raise exception 'effect_conflict';
    end if;
    if v_reserve.outcome = 'duplicate' then
      update public.whatsapp_webhook_inbox
      set state = 'processed', processed_at = v_now, claim_token = null, claimed_at = null, lease_until = null
      where id = v_row.id;
      return jsonb_build_object('outcome', 'duplicate');
    end if;

    -- Travas, sempre na mesma ordem dos outros efeitos: o id do provedor (a
    -- mesma chave da saída observada e da mensagem recebida), o wamid, o
    -- telefone e o BSUID. Um status espera a mensagem que ainda está sendo
    -- gravada, e dois status da mesma mensagem esperam um pelo outro.
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

    -- A mensagem do MESMO canal, travada (qualquer outra escrita nela
    -- espera, e a leitura é a mais recente). Nunca pelo externalId.
    select m.* into v_by_provider from public.messages m
    where m.channel_id = v_row.channel_id and m.provider_message_id = p_provider_message_id
    for update;
    if p_wa_message_id is not null then
      select m.* into v_by_wamid from public.messages m
      where m.channel_id = v_row.channel_id and m.wa_message_id = p_wa_message_id
      for update;
    end if;
    if v_by_provider.id is not null and v_by_wamid.id is not null and v_by_provider.id <> v_by_wamid.id then
      raise exception 'message_conflict';
    end if;
    if v_by_provider.id is not null then
      v_message := v_by_provider;
    else
      v_message := v_by_wamid;
    end if;
    -- Status antes da mensagem: o bloco desfaz a reserva do ledger; nada
    -- fica gravado e o claim continua.
    if v_message.id is null then
      raise exception 'message_not_found';
    end if;
    if v_message.direction <> 'outbound'
       or (v_message.provider_message_id is not null and v_message.provider_message_id <> p_provider_message_id)
       or (p_wa_message_id is not null and v_message.wa_message_id is not null and v_message.wa_message_id <> p_wa_message_id)
       or (p_external_id is not null and v_message.provider_external_id is not null and v_message.provider_external_id <> p_external_id) then
      raise exception 'message_conflict';
    end if;

    -- O destinatário, quando vier, tem de ser a identidade da conversa da
    -- mensagem (telefone e BSUID complementares dela convergem). Outro
    -- destinatário: conflito, e o bloco desfaz a identidade que a resolução
    -- tenha criado ou enriquecido.
    if p_phone_e164 is not null or v_blind is not null then
      v_identity := private.whatsapp_resolve_inbound_identity(v_row, p_phone_e164, p_bsuid_lookup, v_blind, v_cipher, p_bsuid_key_version);
      if v_identity.id is distinct from (select c.identity_id from public.conversations c where c.id = v_message.conversation_id) then
        raise exception 'message_conflict';
      end if;
    end if;

    -- Status: a regra da B3 (§1.3), a mesma de projectWhatsAppMessageStatus.
    v_status_changes := private.whatsapp_message_status_should_apply(v_message.status, v_status);
    v_new_status := case when v_status_changes then v_status else v_message.status end;

    -- Custo: a regra de projectWhatsAppProviderCost. Ausente preserva; o
    -- final nunca muda nem volta a estimativa; outro final é conflito.
    v_new_amount := v_message.provider_cost_amount;
    v_new_currency := v_message.provider_cost_currency;
    v_new_category := v_message.provider_cost_category;
    v_new_finality := v_message.provider_cost_finality;
    if v_cost_amount is not null then
      if v_message.provider_cost_finality = 'final' then
        if v_cost_finality = 'final'
           and (v_cost_amount <> v_message.provider_cost_amount
             or p_cost_currency <> v_message.provider_cost_currency
             or (p_cost_category is not null and v_message.provider_cost_category is not null
                 and p_cost_category <> v_message.provider_cost_category)) then
          raise exception 'cost_conflict';
        end if;
      else
        v_new_amount := v_cost_amount;
        v_new_currency := p_cost_currency;
        v_new_category := p_cost_category;
        v_new_finality := v_cost_finality;
      end if;
    end if;

    v_changed := v_status_changes
      or (v_new_amount, v_new_currency, v_new_category, v_new_finality)
         is distinct from (v_message.provider_cost_amount, v_message.provider_cost_currency, v_message.provider_cost_category, v_message.provider_cost_finality)
      or v_message.provider_message_id is null
      or (v_message.wa_message_id is null and p_wa_message_id is not null)
      or (v_message.provider_external_id is null and p_external_id is not null);

    if v_changed then
      -- O horário e o erro só mudam com o status efetivo; o horário nunca
      -- volta. O código entra com failed e sai com a correção.
      update public.messages
      set status = v_new_status,
          status_updated_at = case when v_status_changes then greatest(status_updated_at, p_occurred_at) else status_updated_at end,
          error_reason = case when v_status_changes then (case when v_new_status = 'failed' then p_error_code end) else error_reason end,
          provider_cost_amount = v_new_amount,
          provider_cost_currency = v_new_currency,
          provider_cost_category = v_new_category,
          provider_cost_finality = v_new_finality,
          provider_message_id = coalesce(provider_message_id, p_provider_message_id),
          provider = coalesce(provider, v_row.provider),
          wa_message_id = coalesce(wa_message_id, p_wa_message_id),
          provider_external_id = coalesce(provider_external_id, p_external_id)
      where id = v_message.id;
    end if;

    update public.whatsapp_effect_ledger set message_id = v_message.id where id = v_reserve.ledger_id;

    update public.whatsapp_webhook_inbox
    set state = 'processed', processed_at = v_now, claim_token = null, claimed_at = null, lease_until = null
    where id = v_row.id;

    if v_changed then
      return jsonb_build_object('outcome', 'applied', 'message_id', v_message.id);
    end if;
    return jsonb_build_object('outcome', 'duplicate');
  exception
    when raise_exception then
      -- Os conflitos e a mensagem ausente desfazem o bloco (ledger,
      -- identidade, mensagem) e voltam como resultado; o resto propaga e
      -- desfaz tudo. Telefone e BSUID de identidades diferentes apontam
      -- para identidades diferentes: message_conflict.
      if sqlerrm in ('message_not_found', 'message_conflict', 'cost_conflict', 'effect_conflict') then
        return jsonb_build_object('outcome', sqlerrm);
      end if;
      if sqlerrm = 'identity_conflict' then
        return jsonb_build_object('outcome', 'message_conflict');
      end if;
      raise;
  end;
end;
$body$;

revoke all on function public.whatsapp_effect_message_status(uuid, uuid, text, text, text, text, text, timestamptz, text, jsonb, text, text, numeric, text, text, text)
  from public, anon, authenticated;
grant execute on function public.whatsapp_effect_message_status(uuid, uuid, text, text, text, text, text, timestamptz, text, jsonb, text, text, numeric, text, text, text)
  to service_role;
