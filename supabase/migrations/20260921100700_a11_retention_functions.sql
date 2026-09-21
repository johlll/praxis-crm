-- A11 — retenção, alerta de evento travado e vencimento sem processamento.
--
-- Contrato: docs/decisoes/a11-ingestao-atribuicao.md §12.
--
-- Todas operam EM LOTES, são idempotentes e seguras sob duas execuções
-- concorrentes (`for update skip locked`). O alerta é estruturado e vai
-- para audit_logs (append-only, SEM PII) além de ser devolvido para quem
-- chamou — a regra funciona sem Sentry, que é observabilidade, não
-- mecanismo.

-- ---------------------------------------------------------------------
-- flag_stuck_webhook_events — evento fora do tempo operacional esperado
--
-- Limite determinístico e testável: `stuck_after`, gravado no próprio
-- evento no recebimento (received_at + N minutos). Nada de heurística.
-- ---------------------------------------------------------------------

create function public.flag_stuck_webhook_events(p_limit integer default 100)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_row record;
  v_alerts jsonb := '[]'::jsonb;
begin
  for v_row in
    with candidate as (
      select id from public.webhook_events
      where processed_at is null
        and stuck_alerted_at is null
        and stuck_after <= now()
        and status not in ('processed', 'expired_unprocessed', 'purged')
      order by stuck_after
      limit p_limit
      for update skip locked
    )
    update public.webhook_events w
    set stuck_alerted_at = now()
    from candidate c
    where w.id = c.id
    returning w.id, w.workspace_id, w.form_endpoint_id, w.status, w.attempts,
              w.received_at, w.stuck_after, w.expires_at, w.last_error_code
  loop
    insert into public.audit_logs (workspace_id, actor_user_id, action, resource_type, resource_id, metadata)
    values (
      v_row.workspace_id, null, 'webhook_event.stuck', 'webhook_event', v_row.id,
      -- Sem PII: só identificadores estruturais, contagens e códigos.
      jsonb_build_object(
        'form_endpoint_id', v_row.form_endpoint_id,
        'status', v_row.status,
        'attempts', v_row.attempts,
        'received_at', v_row.received_at,
        'stuck_after', v_row.stuck_after,
        'last_error_code', v_row.last_error_code
      )
    );

    v_alerts := v_alerts || jsonb_build_array(jsonb_build_object(
      'kind', 'stuck',
      'webhook_event_id', v_row.id,
      'workspace_id', v_row.workspace_id,
      'status', v_row.status,
      'attempts', v_row.attempts,
      'expires_at', v_row.expires_at
    ));
  end loop;

  return jsonb_build_object('alerts', v_alerts, 'count', jsonb_array_length(v_alerts));
end;
$body$;

-- ---------------------------------------------------------------------
-- flag_expiring_webhook_events — alerta ANTECIPADO, antes dos 30 dias
--
-- Um evento que vai vencer sem ter sido processado é a situação que a
-- retenção depois torna irreversível; avisar só no vencimento seria
-- avisar tarde demais.
-- ---------------------------------------------------------------------

create function public.flag_expiring_webhook_events(
  p_limit integer default 100,
  p_days_before integer default 7
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_row record;
  v_alerts jsonb := '[]'::jsonb;
begin
  for v_row in
    with candidate as (
      select id from public.webhook_events
      where processed_at is null
        and expiring_alerted_at is null
        and expires_at <= now() + make_interval(days => p_days_before)
        and status not in ('processed', 'expired_unprocessed', 'purged')
      order by expires_at
      limit p_limit
      for update skip locked
    )
    update public.webhook_events w
    set expiring_alerted_at = now()
    from candidate c
    where w.id = c.id
    returning w.id, w.workspace_id, w.form_endpoint_id, w.status, w.attempts, w.expires_at
  loop
    insert into public.audit_logs (workspace_id, actor_user_id, action, resource_type, resource_id, metadata)
    values (
      v_row.workspace_id, null, 'webhook_event.expiring_unprocessed', 'webhook_event', v_row.id,
      jsonb_build_object(
        'form_endpoint_id', v_row.form_endpoint_id,
        'status', v_row.status,
        'attempts', v_row.attempts,
        'expires_at', v_row.expires_at
      )
    );

    v_alerts := v_alerts || jsonb_build_array(jsonb_build_object(
      'kind', 'expiring_unprocessed',
      'webhook_event_id', v_row.id,
      'workspace_id', v_row.workspace_id,
      'expires_at', v_row.expires_at
    ));
  end loop;

  return jsonb_build_object('alerts', v_alerts, 'count', jsonb_array_length(v_alerts));
end;
$body$;

-- ---------------------------------------------------------------------
-- purge_expired_webhook_events — o vencimento dos 30 dias
--
-- Dois caminhos, na MESMA operação transacional:
--
-- (a) evento terminal JÁ PROCESSADO → elimina ciphertext, IV, auth tag,
--     payload sanitizado e diagnóstico; preserva a TOMBSTONE (chave
--     idempotente, hash, protocolo, status final, referências
--     resultantes, timestamps mínimos e códigos não sensíveis).
--
-- (b) evento AINDA NÃO PROCESSADO → nunca apagado em silêncio: marca
--     `expired_unprocessed`, grava auditoria sem PII, produz alerta
--     estruturado, torna o evento inelegível para processamento novo,
--     elimina ciphertext e diagnóstico, e preserva a tombstone.
--
-- Depois disso, um replay idêntico continua devolvendo 202 com o MESMO
-- protocolo (a chave idempotente sobreviveu), sem criar evento novo e sem
-- efeito comercial; e a mesma chave com hash diferente continua dando 409.
-- ---------------------------------------------------------------------

create function public.purge_expired_webhook_events(p_limit integer default 200)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_row record;
  v_alerts jsonb := '[]'::jsonb;
  v_purged integer := 0;
  v_expired integer := 0;
begin
  for v_row in
    with candidate as (
      select id from public.webhook_events
      where expires_at <= now()
        and purged_at is null
      order by expires_at
      limit p_limit
      for update skip locked
    )
    update public.webhook_events w
    set
      status = case when w.status = 'processed' then 'processed'::public.webhook_event_status
                    else 'expired_unprocessed'::public.webhook_event_status end,
      -- Conteúdo pessoal eliminado nos DOIS caminhos.
      payload_ciphertext = null,
      payload_iv = null,
      payload_auth_tag = null,
      payload_algorithm = null,
      payload_key_version = null,
      payload_sanitized = null,
      occurred_at = null,
      purged_at = now()
    from candidate c
    where w.id = c.id
    returning w.id, w.workspace_id, w.form_endpoint_id, w.status, w.attempts,
              w.processed_at, w.expires_at
  loop
    if v_row.status = 'processed' then
      v_purged := v_purged + 1;
      insert into public.audit_logs (workspace_id, actor_user_id, action, resource_type, resource_id, metadata)
      values (
        v_row.workspace_id, null, 'webhook_event.purged', 'webhook_event', v_row.id,
        jsonb_build_object('form_endpoint_id', v_row.form_endpoint_id, 'processed_at', v_row.processed_at)
      );
    else
      v_expired := v_expired + 1;
      insert into public.audit_logs (workspace_id, actor_user_id, action, resource_type, resource_id, metadata)
      values (
        v_row.workspace_id, null, 'webhook_event.expired_unprocessed', 'webhook_event', v_row.id,
        jsonb_build_object(
          'form_endpoint_id', v_row.form_endpoint_id,
          'attempts', v_row.attempts,
          'expires_at', v_row.expires_at
        )
      );

      v_alerts := v_alerts || jsonb_build_array(jsonb_build_object(
        'kind', 'expired_unprocessed',
        'webhook_event_id', v_row.id,
        'workspace_id', v_row.workspace_id,
        'attempts', v_row.attempts
      ));

      -- A outbox do evento perde o sentido: nada mais pode ser publicado.
      update public.outbox set state = 'abandoned', locked_at = null,
             lock_expires_at = null, updated_at = now()
      where webhook_event_id = v_row.id and state <> 'published';
    end if;
  end loop;

  return jsonb_build_object(
    'purged', v_purged,
    'expired_unprocessed', v_expired,
    'alerts', v_alerts
  );
end;
$body$;

revoke all on function public.flag_stuck_webhook_events(integer) from public;
grant execute on function public.flag_stuck_webhook_events(integer) to service_role;

revoke all on function public.flag_expiring_webhook_events(integer, integer) from public;
grant execute on function public.flag_expiring_webhook_events(integer, integer) to service_role;

revoke all on function public.purge_expired_webhook_events(integer) from public;
grant execute on function public.purge_expired_webhook_events(integer) to service_role;
