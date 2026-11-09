-- B3.3 — portão do envio: canal YCloud de PREVIEW pode ligar o envio
-- (docs/decisoes/b3-whatsapp-real.md §28.20).
--
-- Remove o último bloqueio de CÓDIGO da B3.3, sem configurar canal, credencial,
-- número ou serviço externo, e sem fazer nenhuma chamada: esta função só muda
-- uma linha do banco e escreve a auditoria.
--
-- Regra de `whatsapp_enable_channel_send` depois desta migration. O envio só
-- liga quando TODAS valem:
--   - ambiente autenticado (cabeçalho assinado) e ambiente do canal = preview;
--   - provedor = ycloud (ou simulated, como já era, só no Preview pela restrição
--     `whatsapp_channels_simulator_send_preview_only`);
--   - canal do workspace e do ambiente autenticados, ativo;
--   - ator owner ou admin com membership ativa no workspace;
--   - existe a credencial `api_key` DO MESMO canal, workspace, ambiente e
--     provedor (o `webhook_secret` não conta).
-- Continua recusado: YCloud em Production, Meta em qualquer ambiente, canal
-- pausado/desconectado/desativado, canal sem `api_key`, qualquer papel que não
-- seja owner/admin, ambiente ausente, inválido, vencido ou assinado por outra
-- chave. Todas as recusas são códigos simbólicos; nada de credencial, texto
-- cifrado ou segredo no retorno, no erro ou na auditoria.
--
-- Esta liberação é só técnica, para um futuro canal dedicado de teste. O número
-- da Vitória segue proibido até existir o contrato autenticado Praxis ↔ Vitória
-- (§5.2); nada aqui o cadastra ou o prepara.
--
-- `create or replace` com a MESMA assinatura, SECURITY DEFINER e search_path
-- vazio; nenhuma tabela, coluna, índice, enum ou dado muda. As permissões
-- (EXECUTE só para service_role) são reafirmadas ao final.

create or replace function public.whatsapp_enable_channel_send(p_channel_id uuid, p_workspace_id uuid, p_actor_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_env public.whatsapp_environment := private.require_whatsapp_environment();
  v_channel public.whatsapp_channels := private.whatsapp_lock_managed_channel(p_channel_id, p_workspace_id, p_actor_user_id, v_env);
begin
  -- Portão do provedor. O simulado segue como antes. O YCloud só no Preview;
  -- qualquer outro provedor (Meta, ou um futuro) fica recusado.
  if v_channel.provider = 'ycloud' then
    if v_env is distinct from 'preview'::public.whatsapp_environment
       or v_channel.environment is distinct from 'preview'::public.whatsapp_environment then
      raise exception 'provider_send_not_available';
    end if;
  elsif v_channel.provider <> 'simulated' then
    raise exception 'provider_send_not_available';
  end if;
  if v_channel.status <> 'active' then
    raise exception 'invalid_channel_state';
  end if;

  -- YCloud: a chave de API do MESMO canal, workspace, ambiente e provedor tem
  -- de existir. O segredo do webhook não habilita o envio.
  if v_channel.provider = 'ycloud' and not exists (
    select 1 from public.whatsapp_channel_credentials c
    where c.channel_id = v_channel.id
      and c.workspace_id = v_channel.workspace_id
      and c.environment = v_channel.environment
      and c.provider = v_channel.provider
      and c.purpose = 'api_key'
  ) then
    raise exception 'credential_not_found';
  end if;

  begin
    update public.whatsapp_channels set send_enabled = true where id = v_channel.id
    returning * into v_channel;
  exception when check_violation then
    raise exception 'invalid_channel_state';
  end;

  insert into public.audit_logs (workspace_id, actor_user_id, action, resource_type, resource_id, metadata)
  values (
    p_workspace_id, p_actor_user_id, 'whatsapp.channel.send_enabled', 'whatsapp_channel', v_channel.id,
    jsonb_build_object('environment', v_env, 'provider', v_channel.provider)
  );

  return private.whatsapp_channel_safe_row(v_channel);
end;
$body$;

revoke all on function public.whatsapp_enable_channel_send(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.whatsapp_enable_channel_send(uuid, uuid, uuid) to service_role;
