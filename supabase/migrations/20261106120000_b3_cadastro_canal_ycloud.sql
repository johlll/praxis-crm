-- B3 — cadastro controlado de canal YCloud (docs/decisoes/b3-whatsapp-real.md §28.17).
--
-- Esta migration NÃO fala com a YCloud, não recebe webhook e não envia nada.
-- Ela só deixa o servidor cadastrar um canal `ycloud` na MESMA estrutura de
-- canais e credenciais da B3.1 (nenhuma tabela nova):
--
--   1. `whatsapp_create_ycloud_channel`: cria o canal e as duas credenciais
--      (segredo do webhook e chave de API) na mesma transação. Provedor fixo
--      em `ycloud`; ambiente SÓ do cabeçalho assinado do WhatsApp; ator e
--      workspace vêm do servidor e o banco revalida owner/admin. Recebe as
--      credenciais JÁ CIFRADAS pela aplicação, nunca em texto puro.
--   2. `whatsapp_get_channel_credential` passa a entregar a chave de API só
--      de um canal com envio habilitado e ativo. Hoje nada habilita envio,
--      então a chave de API fica inalcançável até a etapa de envio real.
--
-- Estado inicial do canal: `paused` e `send_enabled = false`. Pausado, o
-- webhook ainda guarda a entrega na inbox, mas o consumidor não aplica efeito
-- nenhum (`channel_paused`): dá para configurar tudo antes de ativar, com
-- `whatsapp_reactivate_channel`, que já existe.
--
-- `webhook_route_id` é gerado pelo banco (default `gen_random_uuid()`, B3.2c),
-- nunca derivado da routing key nem do id do canal. A função o devolve uma
-- única vez, na criação, porque a URL do webhook é montada com ele; nenhuma
-- listagem ou projeção segura o traz.
--
-- O segredo do webhook da YCloud só existe depois que o endpoint é criado lá,
-- e o endpoint precisa da URL. Por isso o canal nasce com um segredo
-- provisório gerado pelo servidor (aleatório, nunca exibido), e o segredo
-- real entra depois por `whatsapp_store_channel_credential`, que já existe e
-- substitui a credencial cifrada.

create function public.whatsapp_create_ycloud_channel(
  p_channel_id uuid,
  p_workspace_id uuid,
  p_actor_user_id uuid,
  p_label text,
  p_routing_key text,
  p_display_phone_number text,
  p_webhook_secret_ciphertext text,
  p_webhook_secret_key_version text,
  p_api_key_ciphertext text,
  p_api_key_key_version text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_env public.whatsapp_environment := private.require_whatsapp_environment();
  v_channel public.whatsapp_channels;
begin
  if p_actor_user_id is null or p_workspace_id is null or p_channel_id is null then
    raise exception 'actor_required';
  end if;
  if not private.whatsapp_actor_can_manage(p_workspace_id, p_actor_user_id) then
    raise exception 'insufficient_permission';
  end if;
  if p_label is null or char_length(btrim(p_label)) not between 1 and 120 then
    raise exception 'invalid_channel_label';
  end if;
  if p_routing_key is null or char_length(btrim(p_routing_key)) not between 1 and 128 then
    raise exception 'invalid_routing_key';
  end if;
  if p_display_phone_number is null or char_length(btrim(p_display_phone_number)) not between 1 and 32 then
    raise exception 'invalid_display_phone_number';
  end if;
  if p_webhook_secret_ciphertext is null or p_webhook_secret_key_version is null
     or p_api_key_ciphertext is null or p_api_key_key_version is null then
    raise exception 'invalid_credential';
  end if;

  -- Um único código para qualquer conflito: não revela se a routing key é de
  -- outro workspace, de outro ambiente ou de outra credencial. O índice único
  -- (provedor, routing key) é global; o pré-teste só poupa um erro do banco.
  if exists (
    select 1 from public.whatsapp_channels c
    where c.provider = 'ycloud' and c.routing_key = btrim(p_routing_key)
  ) then
    raise exception 'channel_routing_key_taken';
  end if;

  begin
    insert into public.whatsapp_channels (
      id, workspace_id, label, phone_number_id, display_phone_number, is_simulator,
      status, created_by, provider, environment, routing_key, send_enabled, status_changed_at
    ) values (
      p_channel_id, p_workspace_id, btrim(p_label), null, btrim(p_display_phone_number), false,
      'paused', p_actor_user_id, 'ycloud', v_env, btrim(p_routing_key), false, now()
    )
    returning * into v_channel;
  exception
    when unique_violation then
      raise exception 'channel_routing_key_taken';
    when check_violation then
      raise exception 'invalid_channel_data';
  end;

  begin
    insert into public.whatsapp_channel_credentials (
      channel_id, workspace_id, environment, provider, purpose, ciphertext, key_version
    ) values
      (v_channel.id, p_workspace_id, v_env, 'ycloud', 'webhook_secret', p_webhook_secret_ciphertext, p_webhook_secret_key_version),
      (v_channel.id, p_workspace_id, v_env, 'ycloud', 'api_key', p_api_key_ciphertext, p_api_key_key_version);
  exception when check_violation then
    raise exception 'invalid_credential';
  end;

  -- Auditoria só com ambiente e provedor: nunca segredo, texto cifrado, versão
  -- de chave, routing key nem localizador.
  insert into public.audit_logs (workspace_id, actor_user_id, action, resource_type, resource_id, metadata)
  values (
    p_workspace_id, p_actor_user_id, 'whatsapp.channel.created', 'whatsapp_channel', v_channel.id,
    jsonb_build_object('environment', v_env, 'provider', 'ycloud')
  );

  return private.whatsapp_channel_safe_row(v_channel)
    || jsonb_build_object('webhook_route_id', v_channel.webhook_route_id);
end;
$body$;

revoke all on function public.whatsapp_create_ycloud_channel(uuid, uuid, uuid, text, text, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.whatsapp_create_ycloud_channel(uuid, uuid, uuid, text, text, text, text, text, text, text) to service_role;

-- A chave de API só sai de um canal com envio habilitado e ativo. Mesma
-- assinatura e mesmos GRANTs; só a condição da chave de API é nova. O segredo
-- do webhook continua independente do envio.
create or replace function public.whatsapp_get_channel_credential(
  p_channel_id uuid,
  p_workspace_id uuid,
  p_provider public.whatsapp_provider,
  p_routing_key text,
  p_purpose public.whatsapp_credential_purpose
)
returns table (
  channel_id uuid,
  workspace_id uuid,
  environment public.whatsapp_environment,
  provider public.whatsapp_provider,
  routing_key text,
  purpose public.whatsapp_credential_purpose,
  ciphertext text,
  key_version text
)
language plpgsql
stable
security definer
set search_path = ''
as $body$
declare
  v_env public.whatsapp_environment := private.require_whatsapp_environment();
  v_channel public.whatsapp_channels;
begin
  if p_channel_id is null or p_workspace_id is null or p_provider is null
     or p_routing_key is null or p_purpose is null then
    raise exception 'channel_not_found';
  end if;

  select ch.* into v_channel
  from public.whatsapp_channels ch
  where ch.id = p_channel_id
    and ch.workspace_id = p_workspace_id
    and ch.environment = v_env
    and ch.provider = p_provider
    and ch.routing_key = p_routing_key;
  if not found then
    raise exception 'channel_not_found';
  end if;

  -- Sem envio habilitado e canal ativo, a chave de API não existe para quem lê.
  if p_purpose = 'api_key' and not (v_channel.send_enabled and v_channel.status = 'active') then
    return;
  end if;

  return query
  select c.channel_id, c.workspace_id, c.environment, c.provider, v_channel.routing_key,
         c.purpose, c.ciphertext, c.key_version
  from public.whatsapp_channel_credentials c
  where c.channel_id = v_channel.id
    and c.workspace_id = v_channel.workspace_id
    and c.environment = v_env
    and c.provider = v_channel.provider
    and c.purpose = p_purpose;
end;
$body$;
