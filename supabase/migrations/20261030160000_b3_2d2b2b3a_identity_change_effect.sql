-- B3.2d-2b2b3a — efeito atômico de IDENTIDADE ALTERADA e TROCA DE NÚMERO
-- (docs/decisoes/b3-whatsapp-real.md §25).
--
-- Aplica um NormalizedIdentityChange (mensagem de sistema
-- user_changed_number / user_identity_changed) à identidade que o canal já
-- conhece. Não envia nada, não chama o provedor e não toca o chatbot.
--
-- public.whatsapp_effect_identity_change aplica, numa transação só e sob a
-- trava da entrada da inbox:
--   1. inbox no ambiente autenticado, em processing, com o token do claim e
--      a lease vigente; o canal da linha ainda ativo (status ATUAL, lido
--      for share, como nos efeitos anteriores);
--   2. reserva contact.identity_changed no ledger (contexto lido da inbox);
--   3. travas consultivas em ordem fixa (telefone e BSUID anteriores e
--      novos, as mesmas chaves dos outros efeitos); a lease é reconferida
--      depois da espera;
--   4. identidade ANTERIOR só lida, nunca criada: telefone e BSUID dela
--      apontam para a mesma identidade (senão identity_conflict); nenhuma →
--      identity_not_found, recuperável; a identidade e a conversa dela são
--      travadas;
--   5. phone_number: o telefone novo substitui o antigo na MESMA
--      identidade; o BSUID novo só enriquece uma identidade sem BSUID;
--      telefone ou BSUID de outra identidade, ou outro BSUID na mesma →
--      identity_conflict. Nunca uma segunda identidade, nunca auto-merge,
--      nunca telefone derivado do BSUID;
--      identity sem a identidade nova: nada inventado; a conversa vai para
--      revisão humana (review_required);
--   6. a conversa continua a mesma: wa_id acompanha o telefone; vínculos
--      comerciais e candidatos preservados, e a conversa vinculada vai para
--      revisão (o cadastro comercial pode continuar com o telefone antigo);
--   7. auditoria só com ids técnicos; ledger; inbox processed.
-- Nunca cria, apaga ou altera contato, telefone do contato, identificador
-- comercial, lead, oportunidade ou atividade. Qualquer falha desfaz tudo.
-- Workspace, canal, ambiente, provedor e id do evento vêm da linha da
-- inbox, nunca do chamador.
--
-- Fica de fora: eventos operacionais da conta e do número (B3.2d-2b2b3b),
-- a ligação do consumidor (B3.2d-2b3), o reconciliador, envio, mídia e
-- interface. Esta migration não edita as anteriores e não altera dados:
-- substitui a guarda das identidades (para permitir a troca de telefone
-- SÓ por este efeito) e cria a função.

-- ---------------------------------------------------------------------
-- Guarda das identidades: a troca de telefone só por este efeito
-- ---------------------------------------------------------------------

-- A regra da B3.2d-2b1 continua: canal, ambiente, provedor e BSUID nunca
-- mudam; um identificador que faltava pode ser acrescentado. A única
-- exceção é o telefone trocado pelo efeito de troca de número, que marca a
-- própria identidade na transação (praxis.whatsapp_identity_phone_change,
-- local à transação). Nenhum papel tem acesso direto à tabela: só funções
-- SECURITY DEFINER escrevem nela. Telefone nunca é apagado.
create or replace function private.whatsapp_identities_guard()
returns trigger
language plpgsql
set search_path = ''
as $body$
declare
  v_channel public.whatsapp_channels;
begin
  if tg_op = 'INSERT' then
    select * into v_channel from public.whatsapp_channels c
    where c.id = new.channel_id and c.workspace_id = new.workspace_id;
    if v_channel.id is null
       or v_channel.environment is distinct from new.environment
       or v_channel.provider is distinct from new.provider then
      raise exception using errcode = '23503', message = 'identity_channel_mismatch';
    end if;
    return new;
  end if;

  if new.workspace_id is distinct from old.workspace_id
     or new.channel_id is distinct from old.channel_id
     or new.environment is distinct from old.environment
     or new.provider is distinct from old.provider
     or (old.phone_e164 is not null and new.phone_e164 is null)
     or (old.phone_e164 is not null and new.phone_e164 is distinct from old.phone_e164
         and coalesce(current_setting('praxis.whatsapp_identity_phone_change', true), '') <> old.id::text)
     or (old.bsuid_blind_index is not null and (
          new.bsuid_blind_index is distinct from old.bsuid_blind_index
          or new.bsuid_ciphertext is distinct from old.bsuid_ciphertext
          or new.bsuid_key_version is distinct from old.bsuid_key_version)) then
    raise exception 'identity_immutable';
  end if;
  return new;
end;
$body$;

revoke all on function private.whatsapp_identities_guard() from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------
-- Índice cego conferido (anterior e nova, materiais separados)
-- ---------------------------------------------------------------------

-- Os índices cegos de cada versão de chave conhecida, em base64, e a versão
-- ativa: devolve o índice da versão ativa. Qualquer forma fora do contrato
-- (o mesmo dos efeitos anteriores) → invalid_identity_change.
create function private.whatsapp_identity_change_blind(p_lookup jsonb, p_key_version text)
returns bytea
language plpgsql
immutable
set search_path = ''
as $body$
declare
  v_key text;
  v_blind bytea;
begin
  if p_lookup is null or jsonb_typeof(p_lookup) <> 'object'
     or p_key_version is null or p_key_version !~ '^[A-Za-z0-9_-]{1,32}$'
     or not (p_lookup ? p_key_version)
     or (select count(*) from jsonb_object_keys(p_lookup)) > 8 then
    raise exception 'invalid_identity_change';
  end if;
  for v_key in select jsonb_object_keys(p_lookup) loop
    if v_key !~ '^[A-Za-z0-9_-]{1,32}$'
       or jsonb_typeof(p_lookup -> v_key) <> 'string'
       or (p_lookup ->> v_key) !~ '^[A-Za-z0-9+/]{43}=$' then
      raise exception 'invalid_identity_change';
    end if;
  end loop;
  v_blind := decode(p_lookup ->> p_key_version, 'base64');
  if octet_length(v_blind) <> 32 then
    raise exception 'invalid_identity_change';
  end if;
  return v_blind;
end;
$body$;

revoke all on function private.whatsapp_identity_change_blind(jsonb, text) from public, anon, authenticated, service_role;

-- Resultados:
--   applied            — o telefone (e, se faltava, o BSUID) da MESMA
--                        identidade mudou; conversa acompanhou; inbox
--                        processed;
--   review_required    — identity sem a identidade nova: a conversa vai
--                        para revisão humana; nada inventado; inbox
--                        processed;
--   duplicate          — o mesmo efeito já estava no ledger para esta
--                        entrada, ou nada precisa mudar (a troca já está
--                        aplicada): inbox processed;
--   identity_not_found — nenhuma identidade anterior no canal: nada
--                        gravado (nenhum ledger, nenhuma identidade), inbox
--                        em processing; reaplicável;
--   identity_conflict  — telefone e BSUID da anterior em identidades
--                        diferentes; telefone ou BSUID novo de outra
--                        identidade; outro BSUID na identidade que já tem
--                        um: nada gravado;
--   effect_conflict    — a chave estável já tem outro efeito ou entrada;
--   already_processed, terminal_failed, claim_lost, not_found — como na
--                        finalização da B3.2d-1, sem mudar nada (claim_lost
--                        também quando a lease vence durante a espera por
--                        uma trava);
--   channel_paused, channel_disconnected, channel_disabled — o canal
--                        deixou de estar ativo depois do claim.
-- Em identity_not_found, nos conflitos e nos três estados do canal nada fica
-- gravado e o claim continua: quem chama libera ou decide (B3.2d-2b3).
-- Entrada malformada: invalid_identity_change.
create function public.whatsapp_effect_identity_change(
  p_inbox_id uuid,
  p_claim_token uuid,
  p_change text,
  p_occurred_at timestamptz,
  p_previous_phone_e164 text,
  p_previous_bsuid_lookup jsonb,
  p_previous_bsuid_key_version text,
  p_next_phone_e164 text,
  p_next_bsuid_lookup jsonb,
  p_next_bsuid_ciphertext text,
  p_next_bsuid_key_version text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_env public.whatsapp_environment := private.require_whatsapp_environment();
  v_prev_blind bytea;
  v_next_blind bytea;
  v_next_cipher bytea;
  v_row public.whatsapp_webhook_inbox;
  v_channel public.whatsapp_channels;
  v_now timestamptz;
  v_reserve record;
  v_by_phone public.whatsapp_identities;
  v_by_bsuid public.whatsapp_identities;
  v_prev public.whatsapp_identities;
  v_next_by_phone public.whatsapp_identities;
  v_next_by_bsuid public.whatsapp_identities;
  v_conversation public.conversations;
  v_linked boolean := false;
  v_phone_changes boolean := false;
  v_bsuid_added boolean := false;
  v_review_marked boolean := false;
  v_locks bigint[] := '{}';
  v_lock bigint;
begin
  -- Entrada: falha fechada antes de qualquer trava ou escrita.
  if p_change is null or p_change not in ('phone_number', 'identity')
     or p_occurred_at is null or not isfinite(p_occurred_at)
     or (p_previous_phone_e164 is null and p_previous_bsuid_lookup is null)
     or (p_previous_phone_e164 is not null and p_previous_phone_e164 !~ '^\+[1-9][0-9]{7,14}$')
     or (p_next_phone_e164 is not null and p_next_phone_e164 !~ '^\+[1-9][0-9]{7,14}$')
     or (p_change = 'phone_number' and p_next_phone_e164 is null)
     or (p_change = 'identity' and (p_next_phone_e164 is not null or p_next_bsuid_lookup is not null
         or p_next_bsuid_ciphertext is not null or p_next_bsuid_key_version is not null)) then
    raise exception 'invalid_identity_change';
  end if;
  if p_previous_bsuid_lookup is not null or p_previous_bsuid_key_version is not null then
    v_prev_blind := private.whatsapp_identity_change_blind(p_previous_bsuid_lookup, p_previous_bsuid_key_version);
  end if;
  if p_next_bsuid_lookup is not null or p_next_bsuid_ciphertext is not null or p_next_bsuid_key_version is not null then
    v_next_blind := private.whatsapp_identity_change_blind(p_next_bsuid_lookup, p_next_bsuid_key_version);
    if p_next_bsuid_ciphertext is null or p_next_bsuid_ciphertext !~ '^[A-Za-z0-9+/]+={0,2}$' or char_length(p_next_bsuid_ciphertext) > 700 then
      raise exception 'invalid_identity_change';
    end if;
    begin
      v_next_cipher := decode(p_next_bsuid_ciphertext, 'base64');
    exception when others then
      raise exception 'invalid_identity_change';
    end;
    if octet_length(v_next_cipher) not between 29 and 512 then
      raise exception 'invalid_identity_change';
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
    from private.whatsapp_effect_ledger_reserve(v_row.id, 'contact.identity_changed') r;
    if v_reserve.outcome = 'conflict' then
      raise exception 'effect_conflict';
    end if;
    if v_reserve.outcome = 'duplicate' then
      update public.whatsapp_webhook_inbox
      set state = 'processed', processed_at = v_now, claim_token = null, claimed_at = null, lease_until = null
      where id = v_row.id;
      return jsonb_build_object('outcome', 'duplicate');
    end if;

    -- Travas, sempre na mesma ordem e com as mesmas chaves dos outros
    -- efeitos: telefone e BSUID anteriores e novos. Duas trocas que
    -- disputam um número ou um BSUID esperam uma pela outra.
    if p_previous_phone_e164 is not null then
      v_locks := v_locks || hashtextextended(v_row.channel_id::text || ':' || p_previous_phone_e164, 0);
    end if;
    if v_prev_blind is not null then
      v_locks := v_locks || hashtextextended(v_row.channel_id::text || ':bsuid:' || encode(v_prev_blind, 'hex'), 0);
    end if;
    if p_next_phone_e164 is not null then
      v_locks := v_locks || hashtextextended(v_row.channel_id::text || ':' || p_next_phone_e164, 0);
    end if;
    if v_next_blind is not null then
      v_locks := v_locks || hashtextextended(v_row.channel_id::text || ':bsuid:' || encode(v_next_blind, 'hex'), 0);
    end if;
    for v_lock in select distinct l from unnest(v_locks) l order by l loop
      perform pg_advisory_xact_lock(v_lock);
    end loop;
    -- A espera pode ter passado da lease: quem segura a trava da inbox não
    -- perde o token, mas o prazo combinado com o consumidor tem de valer.
    if v_row.lease_until <= clock_timestamp() then
      raise exception 'claim_lost';
    end if;

    -- Identidade anterior: só leitura, pelas mesmas regras da resolução
    -- dos outros efeitos, mas nunca criada nem enriquecida.
    if p_previous_phone_e164 is not null then
      select i.* into v_by_phone from public.whatsapp_identities i
      where i.channel_id = v_row.channel_id and i.phone_e164 = p_previous_phone_e164;
    end if;
    if v_prev_blind is not null then
      select i.* into v_by_bsuid from public.whatsapp_identities i
      where i.channel_id = v_row.channel_id
        and i.bsuid_blind_index is not null
        and p_previous_bsuid_lookup ? i.bsuid_key_version
        and i.bsuid_blind_index = decode(p_previous_bsuid_lookup ->> i.bsuid_key_version, 'base64');
    end if;
    if v_by_phone.id is not null and v_by_bsuid.id is not null and v_by_phone.id <> v_by_bsuid.id then
      raise exception 'identity_conflict';
    end if;
    if v_by_phone.id is not null then
      v_prev := v_by_phone;
    else
      v_prev := v_by_bsuid;
    end if;
    if v_prev.id is null then
      raise exception 'identity_not_found';
    end if;
    -- O telefone da anterior, quando veio, é o da identidade — ou já é o
    -- novo (a mesma troca, aplicada por outro evento). O BSUID da anterior,
    -- quando veio, é o da identidade.
    if p_previous_phone_e164 is not null and v_prev.phone_e164 is not null
       and v_prev.phone_e164 <> p_previous_phone_e164
       and not (p_change = 'phone_number' and v_prev.phone_e164 = p_next_phone_e164) then
      raise exception 'identity_conflict';
    end if;
    if v_prev_blind is not null and v_by_bsuid.id is null and v_prev.bsuid_blind_index is not null then
      raise exception 'identity_conflict';
    end if;

    select i.* into v_prev from public.whatsapp_identities i where i.id = v_prev.id for update;
    select c.* into v_conversation from public.conversations c where c.identity_id = v_prev.id for update;
    v_linked := v_conversation.contact_id is not null or v_conversation.lead_id is not null or v_conversation.opportunity_id is not null;

    if p_change = 'identity' then
      -- O provedor confirma a mudança, mas não diz qual é a identidade
      -- nova: nada é inventado nem apagado; a conversa vai para revisão.
      if v_conversation.id is not null and not v_conversation.needs_link_review then
        update public.conversations set needs_link_review = true where id = v_conversation.id;
        v_review_marked := true;
      end if;
      if v_review_marked then
        insert into public.audit_logs (workspace_id, actor_user_id, action, resource_type, resource_id, metadata)
        values (
          v_row.workspace_id, null, 'whatsapp.identity.review_required', 'whatsapp_identity', v_prev.id,
          jsonb_build_object('source', 'whatsapp_webhook', 'change', p_change, 'outcome', 'review_required',
                             'channel_id', v_row.channel_id, 'conversation_id', v_conversation.id, 'review_marked', true)
        );
      end if;
      update public.whatsapp_webhook_inbox
      set state = 'processed', processed_at = v_now, claim_token = null, claimed_at = null, lease_until = null
      where id = v_row.id;
      return jsonb_build_object('outcome', 'review_required', 'identity_id', v_prev.id);
    end if;

    -- phone_number: telefone e BSUID novos nunca podem ser de outra
    -- identidade, e um BSUID existente nunca é substituído.
    select i.* into v_next_by_phone from public.whatsapp_identities i
    where i.channel_id = v_row.channel_id and i.phone_e164 = p_next_phone_e164;
    if v_next_by_phone.id is not null and v_next_by_phone.id <> v_prev.id then
      raise exception 'identity_conflict';
    end if;
    if v_next_blind is not null then
      select i.* into v_next_by_bsuid from public.whatsapp_identities i
      where i.channel_id = v_row.channel_id
        and i.bsuid_blind_index is not null
        and p_next_bsuid_lookup ? i.bsuid_key_version
        and i.bsuid_blind_index = decode(p_next_bsuid_lookup ->> i.bsuid_key_version, 'base64');
      if v_next_by_bsuid.id is null then
        if v_prev.bsuid_blind_index is not null then
          raise exception 'identity_conflict';
        end if;
        v_bsuid_added := true;
      end if;
    end if;
    v_phone_changes := v_prev.phone_e164 is distinct from p_next_phone_e164;

    if v_phone_changes or v_bsuid_added then
      perform set_config('praxis.whatsapp_identity_phone_change', v_prev.id::text, true);
      update public.whatsapp_identities
      set phone_e164 = p_next_phone_e164,
          bsuid_blind_index = case when v_bsuid_added then v_next_blind else bsuid_blind_index end,
          bsuid_ciphertext = case when v_bsuid_added then v_next_cipher else bsuid_ciphertext end,
          bsuid_key_version = case when v_bsuid_added then p_next_bsuid_key_version else bsuid_key_version end
      where id = v_prev.id;
      perform set_config('praxis.whatsapp_identity_phone_change', '', true);

      -- A conversa continua a mesma e acompanha o número. Vinculada a
      -- cadastro comercial, vai para revisão: o contato pode continuar com
      -- o telefone antigo, e ele não é trocado aqui.
      if v_phone_changes and v_conversation.id is not null then
        update public.conversations
        set wa_id = p_next_phone_e164,
            needs_link_review = needs_link_review or v_linked
        where id = v_conversation.id;
        v_review_marked := v_linked and not v_conversation.needs_link_review;
      end if;

      insert into public.audit_logs (workspace_id, actor_user_id, action, resource_type, resource_id, metadata)
      values (
        v_row.workspace_id, null, 'whatsapp.identity.changed', 'whatsapp_identity', v_prev.id,
        jsonb_build_object('source', 'whatsapp_webhook', 'change', p_change, 'outcome', 'applied',
                           'channel_id', v_row.channel_id, 'conversation_id', v_conversation.id,
                           'phone_changed', v_phone_changes, 'bsuid_added', v_bsuid_added, 'review_marked', v_review_marked)
      );
      update public.whatsapp_webhook_inbox
      set state = 'processed', processed_at = v_now, claim_token = null, claimed_at = null, lease_until = null
      where id = v_row.id;
      return jsonb_build_object('outcome', 'applied', 'identity_id', v_prev.id);
    end if;

    update public.whatsapp_webhook_inbox
    set state = 'processed', processed_at = v_now, claim_token = null, claimed_at = null, lease_until = null
    where id = v_row.id;
    return jsonb_build_object('outcome', 'duplicate');
  exception
    when raise_exception then
      -- Conflitos, identidade ausente e lease vencida na espera desfazem o
      -- bloco (ledger, identidade, conversa, auditoria) e voltam como
      -- resultado; o resto propaga e desfaz tudo.
      if sqlerrm in ('identity_not_found', 'identity_conflict', 'effect_conflict', 'claim_lost') then
        return jsonb_build_object('outcome', sqlerrm);
      end if;
      raise;
  end;
end;
$body$;

revoke all on function public.whatsapp_effect_identity_change(uuid, uuid, text, timestamptz, text, jsonb, text, text, jsonb, text, text)
  from public, anon, authenticated;
grant execute on function public.whatsapp_effect_identity_change(uuid, uuid, text, timestamptz, text, jsonb, text, text, jsonb, text, text)
  to service_role;
