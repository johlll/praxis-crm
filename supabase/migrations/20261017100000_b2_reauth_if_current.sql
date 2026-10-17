-- B2 — conexão "a reautorizar" reconhecida fora do agendador.
--
-- Até aqui só a manutenção agendada marcava `needs_reauth`
-- (`mark_calendar_connection_needs_reauth`). A sincronização sob demanda e as
-- ações interativas também renovam o token e precisam reconhecer o
-- `invalid_grant` — mas de forma segura contra uma falha ATRASADA: se o
-- usuário reautorizou (refresh token novo) ou desconectou enquanto a
-- renovação com o token VELHO estava em andamento, essa falha não pode
-- derrubar a conexão nova nem ressuscitar a desconectada.
--
-- Por isso a marcação compara a impressão digital (SHA-256 em hexadecimal)
-- do refresh token CIFRADO que a chamada usou com a do que está gravado
-- agora. Nada do token em claro passa por aqui. A função antiga continua
-- existindo, sem mudança.

create function public.mark_calendar_connection_needs_reauth_if_current(
  p_connection_id uuid,
  p_workspace_id uuid,
  p_actor_user_id uuid,
  p_refresh_fingerprint text,
  p_reason text
)
returns text
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_env public.calendar_environment := private.require_request_environment();
  v_conn public.calendar_connections;
begin
  -- Trava a linha: serializa com a reautorização e a desconexão.
  select * into v_conn from public.calendar_connections c where c.id = p_connection_id for update;
  if v_conn.id is null
     or v_conn.user_id is distinct from p_actor_user_id
     or v_conn.workspace_id is distinct from p_workspace_id then
    raise exception 'connection_not_found';
  end if;
  if v_conn.environment <> v_env then
    raise exception 'calendar_environment_mismatch';
  end if;

  -- Desconectada (antes ou durante a chamada): continua desconectada.
  if v_conn.status = 'disconnected' then
    return 'disconnected';
  end if;
  -- O refresh token mudou desde a leitura (reautorização concluída): a falha
  -- era do token velho e não diz nada sobre a conexão atual.
  if v_conn.refresh_token_ciphertext is null
     or p_refresh_fingerprint is null
     or encode(extensions.digest(v_conn.refresh_token_ciphertext, 'sha256'), 'hex') <> p_refresh_fingerprint then
    return 'stale';
  end if;
  -- Mesma falha repetida: nenhuma transição nem auditoria nova.
  if v_conn.status = 'needs_reauth' then
    return 'already';
  end if;

  update public.calendar_connections set status = 'needs_reauth', updated_at = now() where id = v_conn.id;
  insert into public.audit_logs (workspace_id, actor_user_id, action, resource_type, resource_id, metadata)
  values (v_conn.workspace_id, p_actor_user_id, 'calendar.connection.needs_reauth', 'calendar_connection', v_conn.id,
    jsonb_build_object('environment', v_env, 'reason', left(coalesce(p_reason, ''), 100)));
  return 'marked';
end;
$body$;

revoke all on function public.mark_calendar_connection_needs_reauth_if_current(uuid, uuid, uuid, text, text) from public;
grant execute on function public.mark_calendar_connection_needs_reauth_if_current(uuid, uuid, uuid, text, text) to service_role;
revoke execute on function public.mark_calendar_connection_needs_reauth_if_current(uuid, uuid, uuid, text, text) from anon, authenticated;
