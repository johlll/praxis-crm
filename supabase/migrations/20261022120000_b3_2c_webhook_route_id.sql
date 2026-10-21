-- B3.2c — localizador público OPACO do canal de WhatsApp
-- (docs/decisoes/b3-whatsapp-real.md §18).
--
-- POR QUÊ. O segredo do webhook é por canal (B3.1), então a rota precisa
-- localizar o canal ANTES de conferir a assinatura, e sem ler o corpo ainda
-- não autenticado: o localizador vai na URL. A routing key real
-- (`<wabaId>:<telefone do escritório>`, na YCloud) não pode ir na URL, que
-- fica em logs da Vercel, do provedor e de observabilidade.
--
-- O QUÊ. `webhook_route_id`: UUID aleatório próprio de cada canal, que não é
-- o id do canal nem derivado da routing key. É só um localizador; a
-- autenticação continua sendo a assinatura com o segredo do canal. Fica
-- imutável depois de criado, para que a URL cadastrada no provedor não mude.
--
-- RESOLUÇÃO. `whatsapp_resolve_webhook_route(provedor, localizador)` exige o
-- ambiente assinado do WhatsApp e devolve, só para uso interno do servidor,
-- o canal e a routing key real (com o estado). Nunca credencial, texto
-- cifrado, versão de chave ou segredo: o segredo continua saindo só da
-- resolução da B3.1, chamada depois com a routing key obtida aqui. Canal
-- desativado, de outro ambiente, de outro provedor ou inexistente: nenhuma
-- linha. EXECUTE só para service_role.

alter table public.whatsapp_channels add column webhook_route_id uuid;

-- Canais existentes (inclusive os legados da A7) recebem o seu.
update public.whatsapp_channels set webhook_route_id = gen_random_uuid() where webhook_route_id is null;

alter table public.whatsapp_channels
  alter column webhook_route_id set default gen_random_uuid(),
  alter column webhook_route_id set not null,
  add constraint whatsapp_channels_webhook_route_id_key unique (webhook_route_id);

comment on column public.whatsapp_channels.webhook_route_id is
  'Localizador público e opaco do webhook do canal (B3.2c): UUID aleatório, nunca o id do canal nem derivado da routing key. Não autentica nada: a assinatura com o segredo do canal autentica.';

-- O guarda da identidade do canal passa a travar também o localizador.
create or replace function private.whatsapp_channels_guard()
returns trigger
language plpgsql
set search_path = ''
as $body$
begin
  if tg_op = 'INSERT' then
    if new.routing_key is null then
      new.routing_key := new.phone_number_id;
    end if;
    return new;
  end if;

  if new.workspace_id is distinct from old.workspace_id
     or new.environment is distinct from old.environment
     or new.provider is distinct from old.provider
     or new.routing_key is distinct from old.routing_key
     or new.is_simulator is distinct from old.is_simulator
     or new.webhook_route_id is distinct from old.webhook_route_id then
    raise exception 'channel_identity_immutable';
  end if;
  return new;
end;
$body$;

revoke all on function private.whatsapp_channels_guard() from public, anon, authenticated;

create function public.whatsapp_resolve_webhook_route(
  p_provider public.whatsapp_provider,
  p_webhook_route_id uuid
)
returns table (
  channel_id uuid,
  workspace_id uuid,
  environment public.whatsapp_environment,
  provider public.whatsapp_provider,
  routing_key text,
  status text
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
  select ch.id, ch.workspace_id, ch.environment, ch.provider, ch.routing_key, ch.status
  from public.whatsapp_channels ch
  where ch.webhook_route_id = p_webhook_route_id
    and ch.provider = p_provider
    and ch.status <> 'disabled';
end;
$body$;

revoke all on function public.whatsapp_resolve_webhook_route(public.whatsapp_provider, uuid) from public, anon, authenticated;
grant execute on function public.whatsapp_resolve_webhook_route(public.whatsapp_provider, uuid) to service_role;
