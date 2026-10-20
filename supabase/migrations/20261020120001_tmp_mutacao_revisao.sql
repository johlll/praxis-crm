-- TEMPORÁRIA (não mesclar): mutações da revisão da B3.1 para provar que o
-- pgTAP detecta cada uma. Cada mutação mexe numa condição distinta:
--  M1: leitura sem conferir o workspace do canal;
--  M2: leitura sem conferir provedor e routing key;
--  M3: webhook devolve qualquer propósito (inclui a chave de API);
--  M4: webhook sem filtro de ambiente.
create or replace function public.whatsapp_get_channel_credential(
  p_channel_id uuid, p_workspace_id uuid, p_provider public.whatsapp_provider,
  p_routing_key text, p_purpose public.whatsapp_credential_purpose
)
returns table (
  channel_id uuid, workspace_id uuid, environment public.whatsapp_environment,
  provider public.whatsapp_provider, routing_key text,
  purpose public.whatsapp_credential_purpose, ciphertext text, key_version text
)
language plpgsql stable security definer set search_path = ''
as $body$
declare
  v_env public.whatsapp_environment := private.require_whatsapp_environment();
  v_channel public.whatsapp_channels;
begin
  if p_channel_id is null or p_purpose is null then
    raise exception 'channel_not_found';
  end if;
  select ch.* into v_channel from public.whatsapp_channels ch
  where ch.id = p_channel_id and ch.environment = v_env;           -- M1 + M2
  if not found then
    raise exception 'channel_not_found';
  end if;
  return query
  select c.channel_id, c.workspace_id, c.environment, c.provider, v_channel.routing_key,
         c.purpose, c.ciphertext, c.key_version
  from public.whatsapp_channel_credentials c
  where c.channel_id = v_channel.id and c.environment = v_env and c.purpose = p_purpose;
end;
$body$;

create or replace function public.whatsapp_resolve_webhook_channel(
  p_provider public.whatsapp_provider, p_routing_key text
)
returns table (
  channel_id uuid, workspace_id uuid, environment public.whatsapp_environment,
  provider public.whatsapp_provider, routing_key text, status text, ciphertext text, key_version text
)
language plpgsql stable security definer set search_path = ''
as $body$
declare
  v_env public.whatsapp_environment := private.require_whatsapp_environment();
begin
  return query
  select ch.id, ch.workspace_id, ch.environment, ch.provider, ch.routing_key, ch.status,
         c.ciphertext, c.key_version
  from public.whatsapp_channels ch
  join public.whatsapp_channel_credentials c
    on c.channel_id = ch.id and c.workspace_id = ch.workspace_id
   and c.environment = ch.environment and c.provider = ch.provider
  where ch.provider = p_provider and ch.routing_key = p_routing_key
    and ch.status <> 'disabled';                                    -- M3 + M4
end;
$body$;
