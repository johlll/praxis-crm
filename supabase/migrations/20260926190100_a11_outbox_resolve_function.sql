-- A11 — colunas + função de convergência para a outbox órfã (ver
-- migration anterior para o achado). Depende do valor 'resolved' de
-- `outbox_state` já ter sido commitado (migration separada, requisito do
-- Postgres para usar um valor de enum recém-criado em comparação).
--
-- Semântica: `resolved` nunca significa "publicado" — outbox nenhuma
-- marcada assim jamais chegou a ser enviada ao Inngest. Ela significa
-- "o evento já é irreversivelmente terminal por outro caminho; não há
-- mais nada a publicar". `resolved_reason` distingue qual dos três
-- caminhos foi: o próprio status do webhook_event no momento da
-- convergência, nunca payload nem qualquer dado pessoal.

alter table public.outbox
  add column resolved_reason text,
  add column resolved_at timestamptz;

alter table public.outbox
  add constraint outbox_resolved_reason_check check (
    (
      state = 'resolved'
      and resolved_reason in ('event_processed', 'event_expired_unprocessed', 'event_purged')
      and resolved_at is not null
    )
    or (
      state <> 'resolved'
      and resolved_reason is null
      and resolved_at is null
    )
  );

-- Converge atomicamente outbox não-terminal cujo evento já é terminal por
-- outro caminho. Roda ANTES de `claim_outbox_batch` no reconciliador: o
-- que sobrar depois desta função é, por construção, elegível de verdade.
--
-- `for update of o skip locked`: uma outbox travada por uma reivindicação
-- concorrente (claim_outbox_batch em outra transação, lock ainda válido)
-- é simplesmente ignorada nesta passada — nunca hoje, nunca duas vezes.
-- Uma segunda chamada concorrente desta MESMA função, sobre a MESMA
-- linha, também não produz duplicidade: a primeira a commitar já tirou a
-- linha de `pending/publishing/failed`, então a segunda não a encontra
-- mais como candidata.
create or replace function public.resolve_stale_outbox_batch(p_limit integer default 200)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_result jsonb;
begin
  with candidate as (
    select o.id, w.status as event_status
    from public.outbox o
    join public.webhook_events w on w.id = o.webhook_event_id
    where o.state in ('pending', 'publishing', 'failed')
      and w.status in ('processed', 'expired_unprocessed', 'purged')
    order by o.next_attempt_at
    limit p_limit
    for update of o skip locked
  ),
  resolved as (
    update public.outbox o
    set state = 'resolved',
        resolved_reason = 'event_' || c.event_status::text,
        resolved_at = now(),
        locked_at = null,
        lock_expires_at = null,
        updated_at = now()
    from candidate c
    where o.id = c.id
    returning o.id, o.webhook_event_id, o.workspace_id, o.resolved_reason
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'outbox_id', id,
    'webhook_event_id', webhook_event_id,
    'workspace_id', workspace_id,
    'resolved_reason', resolved_reason
  )), '[]'::jsonb)
  into v_result
  from resolved;

  return v_result;
end;
$function$;

revoke all on function public.resolve_stale_outbox_batch(integer) from public;
grant execute on function public.resolve_stale_outbox_batch(integer) to service_role;
revoke execute on function public.resolve_stale_outbox_batch(integer) from anon, authenticated;
