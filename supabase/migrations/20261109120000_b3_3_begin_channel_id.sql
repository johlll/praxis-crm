-- B3.3 — `whatsapp_outbox_begin` devolve o `channel_id` da intenção (docs/decisoes/b3-whatsapp-real.md
-- §28.19).
--
-- O envio real precisa da chave de API DO CANAL da intenção. Sem este campo, o
-- servidor só conseguiria o canal por uma função que também entrega o segredo
-- do webhook; com ele, pede-se SÓ `whatsapp_get_channel_credential(..., 'api_key')`.
--
-- Mudança única: o retorno do `begin` ganha `channel_id`, lido pelo banco da
-- linha da OUTBOX (`v_outbox.channel_id`, a mesma do canal travado com `for share`).
-- O chamador não fornece nem influencia esse valor. O retorno continua sem
-- credencial, texto cifrado, segredo ou token.
--
-- `create or replace` com a MESMA assinatura, SECURITY DEFINER e search_path
-- vazio; tabelas, colunas, índices, enums e dados não mudam. As permissões
-- (EXECUTE só para service_role) são reafirmadas abaixo.

create or replace function public.whatsapp_outbox_begin(p_outbox_id uuid, p_lease_seconds integer default 60)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_env public.whatsapp_environment := private.require_whatsapp_environment();
  v_outbox public.whatsapp_outbox;
  v_channel public.whatsapp_channels;
  v_conversation public.conversations;
  v_message public.messages;
  v_template public.whatsapp_templates;
begin
  if p_lease_seconds is null or p_lease_seconds not between 15 and 300 then
    raise exception 'invalid_lease';
  end if;

  select * into v_outbox from public.whatsapp_outbox o where o.id = p_outbox_id and o.environment = v_env for update;
  if v_outbox.id is null then
    raise exception 'outbox_not_found';
  end if;

  if v_outbox.state = 'sending' then
    if v_outbox.lease_until >= now() then
      return private.whatsapp_outbox_snapshot(v_outbox, true, false) || jsonb_build_object('outcome', 'in_progress');
    end if;
    -- A tentativa começou e o processo sumiu: pode ter chegado ao provedor.
    -- Nunca reenvia; fica incerta.
    update public.whatsapp_outbox set state = 'uncertain' where id = v_outbox.id returning * into v_outbox;
    update public.messages set error_reason = 'send_uncertain', status_updated_at = now() where id = v_outbox.message_id;
    return private.whatsapp_outbox_snapshot(v_outbox, true, false) || jsonb_build_object('outcome', 'done');
  end if;

  if v_outbox.state <> 'reserved' then
    return private.whatsapp_outbox_snapshot(v_outbox, true, false) || jsonb_build_object('outcome', 'done');
  end if;

  select * into v_channel from public.whatsapp_channels c where c.id = v_outbox.channel_id for share;
  select * into v_conversation from public.conversations c where c.id = v_outbox.conversation_id;
  select * into v_message from public.messages m where m.id = v_outbox.message_id;

  -- O envio pode ter sido desligado entre a reserva e a chamada.
  if v_channel.status <> 'active' or not v_channel.send_enabled or v_conversation.wa_id is null then
    update public.whatsapp_outbox set state = 'rejected', error_code = 'send_disabled' where id = v_outbox.id returning * into v_outbox;
    update public.messages set status = 'failed', error_reason = 'send_disabled', status_updated_at = now() where id = v_outbox.message_id;
    return private.whatsapp_outbox_snapshot(v_outbox, false, false) || jsonb_build_object('outcome', 'done');
  end if;

  if v_outbox.kind = 'template' then
    select * into v_template from public.whatsapp_templates t where t.id = v_outbox.template_id;
  end if;

  update public.whatsapp_outbox
  set state = 'sending', attempts = 1, sending_started_at = now(),
      lease_until = now() + make_interval(secs => p_lease_seconds)
  where id = v_outbox.id
  returning * into v_outbox;

  return private.whatsapp_outbox_snapshot(v_outbox, false, false) || jsonb_build_object(
    'outcome', 'begin',
    'kind', v_outbox.kind,
    'provider', v_channel.provider,
    'channel_id', v_channel.id,
    'routing_key', v_channel.routing_key,
    'recipient_phone', v_conversation.wa_id,
    'text', case when v_outbox.kind = 'text' then v_message.body_text end,
    'template_name', v_template.name,
    'template_language', v_template.language,
    'template_params', case when v_outbox.kind = 'template' then to_jsonb(v_outbox.template_params) end
  );
end;
$body$;

revoke all on function public.whatsapp_outbox_begin(uuid, integer) from public, anon, authenticated;
grant execute on function public.whatsapp_outbox_begin(uuid, integer) to service_role;
