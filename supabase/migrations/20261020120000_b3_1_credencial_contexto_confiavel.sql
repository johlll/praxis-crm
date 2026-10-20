-- B3.1, revisão da PR #42 — leitura de credencial com contexto confiável
-- do canal, e resolução própria do webhook
-- (docs/decisoes/b3-whatsapp-real.md §14).
--
-- A leitura anterior recebia só (canal, propósito): dentro do mesmo
-- ambiente, quem tivesse o UUID de um canal de outro workspace recebia o
-- texto cifrado dele. Agora:
--  1. `whatsapp_get_channel_credential` exige a identidade inteira do canal
--     (canal, workspace, provedor, routing key) e confere tudo contra a
--     linha do canal no ambiente autenticado antes de devolver qualquer
--     coisa. Divergência → `channel_not_found`, sem distinguir o motivo.
--  2. O webhook tem resolução própria, `whatsapp_resolve_webhook_channel`,
--     pelo identificador de roteamento (provedor, routing key): uma única
--     consulta devolve o canal e SÓ o segredo do webhook (nunca a chave de
--     API), apenas no ambiente autenticado e nunca para canal desativado.
--
-- Nenhuma tabela muda. As duas funções: SECURITY DEFINER, search_path
-- travado, EXECUTE só para service_role.

drop function public.whatsapp_get_channel_credential(uuid, public.whatsapp_credential_purpose);

create function public.whatsapp_get_channel_credential(
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

-- Webhook: (provedor, routing key) é único (whatsapp_channels_provider_routing_key_key),
-- então no máximo uma linha. Canal pausado continua resolvido (com o estado,
-- para quem decide o que fazer com o evento); desativado, não.
create function public.whatsapp_resolve_webhook_channel(
  p_provider public.whatsapp_provider,
  p_routing_key text
)
returns table (
  channel_id uuid,
  workspace_id uuid,
  environment public.whatsapp_environment,
  provider public.whatsapp_provider,
  routing_key text,
  status text,
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
begin
  return query
  select ch.id, ch.workspace_id, ch.environment, ch.provider, ch.routing_key, ch.status,
         c.ciphertext, c.key_version
  from public.whatsapp_channels ch
  join public.whatsapp_channel_credentials c
    on c.channel_id = ch.id
   and c.workspace_id = ch.workspace_id
   and c.environment = ch.environment
   and c.provider = ch.provider
  where ch.provider = p_provider
    and ch.routing_key = p_routing_key
    and ch.environment = v_env
    and ch.status <> 'disabled'
    and c.purpose = 'webhook_secret';
end;
$body$;

revoke all on function public.whatsapp_get_channel_credential(uuid, uuid, public.whatsapp_provider, text, public.whatsapp_credential_purpose) from public, anon, authenticated;
revoke all on function public.whatsapp_resolve_webhook_channel(public.whatsapp_provider, text) from public, anon, authenticated;

grant execute on function public.whatsapp_get_channel_credential(uuid, uuid, public.whatsapp_provider, text, public.whatsapp_credential_purpose) to service_role;
grant execute on function public.whatsapp_resolve_webhook_channel(public.whatsapp_provider, text) to service_role;
