-- B2, etapa 2b — leitura do vínculo com a agenda para as telas de atividade.
--
-- As tabelas de B2 negam tudo a `authenticated`, então a interface não lê o
-- vínculo diretamente. Esta função devolve, para atividades que o usuário
-- pode ver, SÓ o que a tela precisa (estado do vínculo, se é dele, duração e
-- o link do Meet). Nunca devolve token, e-mail da conta Google, id de agenda
-- ou de evento, título, etag nem valores de conflito.
--
-- Não é aplicada ao banco hospedado sem autorização à parte. A aplicação só a
-- chama quando o provedor de agenda está configurado, para que a tela
-- continue funcionando enquanto a migration não existir.

create function public.list_activity_calendar_links(p_activity_ids uuid[])
returns jsonb
language plpgsql
security definer
stable
set search_path = ''
as $body$
declare
  v_actor uuid := auth.uid();
  v_env public.calendar_environment := private.require_request_environment();
begin
  if v_actor is null then
    raise exception 'authentication_required';
  end if;
  if p_activity_ids is null or cardinality(p_activity_ids) = 0 then
    return '[]'::jsonb;
  end if;
  if cardinality(p_activity_ids) > 200 then
    raise exception 'too_many_activities';
  end if;

  return coalesce(
    (
      select jsonb_agg(
        jsonb_build_object(
          'activityId', l.activity_id,
          'status', l.status,
          'isMine', c.user_id = v_actor,
          'durationMinutes', l.duration_minutes,
          'meetStatus', l.meet_status,
          'meetUrl', l.meet_url,
          'lastSyncedAt', l.last_synced_at
        )
      )
      from public.calendar_event_links l
      join public.calendar_connections c on c.id = l.connection_id
      join public.activities a on a.id = l.activity_id
      join public.memberships m
        on m.workspace_id = a.workspace_id and m.user_id = v_actor and m.status = 'active'
      join public.leads ld on ld.id = a.lead_id
      where l.activity_id = any (p_activity_ids)
        and l.status <> 'unlinked'
        -- Só o ambiente que está operando (assinado pelo servidor).
        and l.environment = v_env
        -- Mesmo alcance de leitura do lead (advogado: os seus + sem responsável).
        and private.lead_accessible_to_role(m.role, ld.assigned_to, v_actor)
    ),
    '[]'::jsonb
  );
end;
$body$;

revoke all on function public.list_activity_calendar_links(uuid[]) from public;
grant execute on function public.list_activity_calendar_links(uuid[]) to authenticated;
revoke execute on function public.list_activity_calendar_links(uuid[]) from anon;
