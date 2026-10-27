-- B3.2d-2a — finalização SEM efeito no domínio da inbox do WhatsApp
-- (docs/decisoes/b3-whatsapp-real.md §20).
--
-- O consumidor da B3.2d-2a não escreve no domínio. Eventos autênticos que
-- o CRM ignora por regra (`ignored`) ou ainda não processa (`unsupported`)
-- são finalizados como processed com uma DISPOSIÇÃO: um código de uma
-- lista fechada, nunca conteúdo, telefone, BSUID ou routing key. Nada é
-- auditado: a disposição fica só na linha da inbox.
--
-- A disposição passa pela MESMA finalização de complete, fail e release
-- (private.whatsapp_inbox_finish, recriada aqui sem mudar a assinatura):
-- linha travada, terminais primeiro, token atual, e um único
-- clock_timestamp() decide a lease e data a transição. Lease vencida,
-- token antigo, inventado, ausente ou de outra entrada → claim_lost sem
-- mudar nada; repetir → already_processed.
--
-- A disposição só nasce na transição processing → processed e nunca muda
-- depois (gatilho próprio). Esta migration não edita as anteriores.

-- ---------------------------------------------------------------------
-- Coluna e restrições
-- ---------------------------------------------------------------------

alter table public.whatsapp_webhook_inbox
  add column disposition text;

alter table public.whatsapp_webhook_inbox
  add constraint whatsapp_webhook_inbox_disposition_check check (
    disposition is null
    or (state = 'processed'
        and disposition in ('ignored_history', 'ignored_group_message', 'ignored_non_whatsapp_product', 'unsupported_event'))
  );

-- A disposição só é gravada junto com processing → processed; depois disso
-- não troca nem some.
create function private.whatsapp_webhook_inbox_disposition_guard()
returns trigger
language plpgsql
set search_path = ''
as $body$
begin
  if new.disposition is distinct from old.disposition
     and not (old.state = 'processing' and new.state = 'processed' and old.disposition is null) then
    raise exception 'inbox_disposition_immutable';
  end if;
  return new;
end;
$body$;

revoke all on function private.whatsapp_webhook_inbox_disposition_guard() from public, anon, authenticated;


-- ---------------------------------------------------------------------
-- Finalização: a mesma de complete, fail e release, com a disposição
-- ---------------------------------------------------------------------

-- Igual à da B3.2d-1, com uma diferença: em processed, p_code é a
-- disposição (nula no complete; da lista fechada no dispose).
create or replace function private.whatsapp_inbox_finish(
  p_inbox_id uuid,
  p_claim_token uuid,
  p_target text,
  p_code text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_env public.whatsapp_environment := private.require_whatsapp_environment();
  v_row public.whatsapp_webhook_inbox;
  v_now timestamptz;
begin
  if p_target not in ('processed', 'failed', 'pending') then
    raise exception 'invalid_inbox_transition';
  end if;
  if p_target <> 'processed' and (p_code is null or p_code !~ '^[a-z0-9_]{1,64}$') then
    raise exception 'invalid_error_code';
  end if;
  if p_target = 'processed' and p_code is not null
     and p_code not in ('ignored_history', 'ignored_group_message', 'ignored_non_whatsapp_product', 'unsupported_event') then
    raise exception 'invalid_disposition';
  end if;
  if p_inbox_id is null then
    return jsonb_build_object('outcome', 'not_found');
  end if;

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

  if p_target = 'processed' then
    update public.whatsapp_webhook_inbox
    set state = 'processed', processed_at = v_now, disposition = p_code,
        claim_token = null, claimed_at = null, lease_until = null
    where id = v_row.id;
    return jsonb_build_object('outcome', 'completed');
  end if;

  if p_target = 'failed' then
    update public.whatsapp_webhook_inbox
    set state = 'failed', failed_at = v_now, error_code = p_code, claim_token = null, claimed_at = null, lease_until = null
    where id = v_row.id;
    insert into public.audit_logs (workspace_id, actor_user_id, action, resource_type, resource_id, metadata)
    values (
      v_row.workspace_id, null, 'whatsapp.inbox.failed', 'whatsapp_webhook_inbox', v_row.id,
      jsonb_build_object('environment', v_env, 'provider', v_row.provider, 'channel_id', v_row.channel_id, 'code', p_code)
    );
    return jsonb_build_object('outcome', 'failed');
  end if;

  update public.whatsapp_webhook_inbox
  set state = 'pending', claim_token = null, claimed_at = null, lease_until = null,
      last_release_code = p_code, last_released_at = v_now
  where id = v_row.id;
  return jsonb_build_object('outcome', 'released');
end;
$body$;

revoke all on function private.whatsapp_inbox_finish(uuid, uuid, text, text) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- dispose: processing → processed SEM efeito, com a disposição
-- ---------------------------------------------------------------------

create function public.whatsapp_inbox_dispose(p_inbox_id uuid, p_claim_token uuid, p_disposition text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $body$
begin
  if p_disposition is null
     or p_disposition not in ('ignored_history', 'ignored_group_message', 'ignored_non_whatsapp_product', 'unsupported_event') then
    raise exception 'invalid_disposition';
  end if;
  return private.whatsapp_inbox_finish(p_inbox_id, p_claim_token, 'processed', p_disposition);
end;
$body$;

-- EXECUTE só para service_role.
revoke all on function public.whatsapp_inbox_dispose(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.whatsapp_inbox_dispose(uuid, uuid, text) to service_role;
