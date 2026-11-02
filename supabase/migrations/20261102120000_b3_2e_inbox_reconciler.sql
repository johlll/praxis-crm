-- B3.2e — reserva atômica da republicação da inbox do WhatsApp
-- (docs/decisoes/b3-whatsapp-real.md §28). Portão obrigatório antes de qualquer
-- webhook real (§18.3).
--
-- O reconciliador NÃO processa conteúdo e NÃO chama efeitos do domínio: encontra
-- entradas elegíveis, reserva cada uma, republica o mesmo evento interno
-- (`{ id: inboxId, name, data: { inboxId } }`, no servidor) e registra só o
-- resultado técnico. Quem faz claim, decifra, normaliza e aplica é o consumidor.
-- Nada aqui muda state, claim, cifra ou hash de uma entrada.
--
-- RESERVA. Por linha, com token próprio e aleatório, horário e vencimento
-- curto (30 a 300 s), em SELECT ... FOR UPDATE OF i SKIP LOCKED: dois
-- reconciliadores nunca recebem a mesma entrada, e nenhum espera pelo outro nem
-- por um consumidor. Se o worker cair, o vencimento devolve a entrada; o token
-- antigo não confirma nem libera nada (a posse termina no vencimento, como no
-- claim). A reserva não impede o claim: o consumidor nunca espera o
-- reconciliador.
--
-- A RPC devolve só o que publicar exige: inbox_id e o token. Nenhuma cifra, hash,
-- canal, workspace ou dado pessoal. O token fica na memória do servidor, no
-- mesmo step.run.
--
-- ELEGIBILIDADE (só no ambiente assinado). Sempre: corpo não expurgado, retenção
-- vigente, canal coerente com a linha, reserva ausente ou vencida, recebida há
-- mais de 1 minuto (a rota do webhook ainda está publicando). Além disso:
--   - processing com a lease VENCIDA e o backoff vencido;
--   - pending liberada com channel_paused, channel_disconnected ou
--     channel_disabled: só se o canal mudou depois do release
--     (status_changed_at > last_released_at) ou se o estado atual já não é o do
--     código (o canal mudou entre o claim e o release, e o relógio dele é
--     anterior ao release: sem isso a entrada ficaria presa). A primeira
--     tentativa depois da mudança não espera o backoff longo; as seguintes
--     (publicação falhou, ou o Inngest descartou o id repetido, §28.8) esperam;
--   - qualquer outra pending, nunca tentada ou liberada por condição
--     recuperável: backoff vencido e, se liberada, há mais de 1 minuto.
-- Uma entrada nunca tentada passa em QUALQUER estado do canal: é assim que um
-- evento `account` chega ao efeito em canal não ativo. Uma mensagem comum é
-- liberada pelo consumidor com channel_* e passa a esperar a mudança real.
-- Tentativas nunca transformam uma entrada em failed.
--
-- BACKOFF. Conta as tentativas de republicação: 1, 5, 15 e 60 minutos, e o teto
-- de 6 horas para sempre. A confirmação e a falha agendam a próxima tentativa;
-- a queda do worker, não (a entrada volta quando a reserva vencer).
--
-- BATIMENTO. `whatsapp_channels.last_event_at` é o último evento do PROVEDOR e
-- não serve para isso: `whatsapp_reconciler_runs` guarda ambiente, origem,
-- horários, desfecho e contagens, e nada mais. Sem texto livre, sem dado pessoal,
-- sem token. Linhas com mais de 30 dias são apagadas ao gravar uma nova.

-- ---------------------------------------------------------------------
-- Colunas técnicas da inbox
-- ---------------------------------------------------------------------

alter table public.whatsapp_webhook_inbox
  add column reconcile_token uuid,
  add column reconcile_reserved_at timestamptz,
  add column reconcile_reserved_until timestamptz,
  add column reconcile_attempts integer not null default 0,
  add column last_republished_at timestamptz,
  add column last_republish_error_code text,
  add column reconcile_next_at timestamptz,
  add constraint whatsapp_webhook_inbox_reconcile_attempts_nonnegative check (reconcile_attempts >= 0),
  -- Token e vencimento só juntos, depois do horário da reserva. O horário fica
  -- depois do fim da reserva: é a referência da última tentativa.
  add constraint whatsapp_webhook_inbox_reconcile_reservation_coherent check (
    (reconcile_token is null and reconcile_reserved_until is null)
    or (reconcile_token is not null and reconcile_reserved_at is not null and reconcile_reserved_until is not null
        and reconcile_reserved_until > reconcile_reserved_at)
  ),
  -- Lista fechada: nunca mensagem original, URL, token ou resposta do provedor.
  add constraint whatsapp_webhook_inbox_republish_error_code_check check (
    last_republish_error_code in ('inbox_event_publish_failed', 'inbox_event_not_configured')
  );

comment on column public.whatsapp_webhook_inbox.reconcile_token is
  'Token da reserva de republicação (B3.2e). Só existe durante a reserva; nunca sai na listagem.';
comment on column public.whatsapp_webhook_inbox.reconcile_reserved_at is
  'Horário da última reserva de republicação; fica depois do fim dela.';
comment on column public.whatsapp_webhook_inbox.reconcile_attempts is
  'Tentativas técnicas de republicação (reservas). Nunca diminui e nunca transforma a entrada em failed.';
comment on column public.whatsapp_webhook_inbox.last_republished_at is
  'Última republicação ACEITA pelo Inngest. Não significa que o consumidor executou.';
comment on column public.whatsapp_webhook_inbox.reconcile_next_at is
  'Próximo horário elegível pelo backoff da republicação.';

-- Só o que ainda pode ser candidato; as mais antigas primeiro.
create index whatsapp_webhook_inbox_reconcile_idx
  on public.whatsapp_webhook_inbox (environment, received_at, id)
  where state in ('pending', 'processing') and purged_at is null;

-- O contador só sobe; um tombstone não guarda token (o expurgo não precisa saber
-- da reserva, e o token de antes dele não confirma mais nada).
create function private.whatsapp_webhook_inbox_reconcile_guard()
returns trigger
language plpgsql
set search_path = ''
as $body$
begin
  if new.reconcile_attempts < old.reconcile_attempts then
    raise exception 'inbox_reconcile_attempts_decreased';
  end if;
  if new.purged_at is not null then
    new.reconcile_token := null;
    new.reconcile_reserved_until := null;
  end if;
  return new;
end;
$body$;

revoke all on function private.whatsapp_webhook_inbox_reconcile_guard() from public, anon, authenticated;

create trigger whatsapp_webhook_inbox_reconcile_guard
  before update on public.whatsapp_webhook_inbox
  for each row execute function private.whatsapp_webhook_inbox_reconcile_guard();

-- ---------------------------------------------------------------------
-- Backoff e elegibilidade
-- ---------------------------------------------------------------------

create function private.whatsapp_inbox_reconcile_backoff(p_attempts integer)
returns interval
language sql
immutable
set search_path = ''
as $body$
  select case
    when p_attempts <= 1 then interval '1 minute'
    when p_attempts = 2 then interval '5 minutes'
    when p_attempts = 3 then interval '15 minutes'
    when p_attempts = 4 then interval '1 hour'
    else interval '6 hours'
  end;
$body$;

revoke all on function private.whatsapp_inbox_reconcile_backoff(integer) from public, anon, authenticated;

-- Regra única, usada para contar e para reservar. Recebe o estado atual do
-- canal e o relógio do banco: não lê nada e não escreve nada.
create function private.whatsapp_inbox_reconcile_eligible(
  p_row public.whatsapp_webhook_inbox,
  p_channel_status text,
  p_channel_changed_at timestamptz,
  p_now timestamptz
)
returns boolean
language sql
stable
set search_path = ''
as $body$
  select p_row.purged_at is null
    and p_row.retain_until > p_now
    and (p_row.reconcile_reserved_until is null or p_row.reconcile_reserved_until <= p_now)
    and p_row.received_at + interval '1 minute' <= p_now
    and case
      when p_row.state = 'processing' then
        p_row.lease_until <= p_now
        and (p_row.reconcile_next_at is null or p_row.reconcile_next_at <= p_now)
      when p_row.state = 'pending' and p_row.last_release_code in ('channel_paused', 'channel_disconnected', 'channel_disabled') then
        -- O canal mudou depois do release, ou já não está no estado do código.
        (
          coalesce(p_channel_changed_at > p_row.last_released_at, false)
          or p_row.last_release_code <> 'channel_' || p_channel_status
        )
        -- A primeira tentativa depois da mudança não espera o backoff longo.
        and (
          p_row.reconcile_reserved_at is null
          or coalesce(p_row.reconcile_reserved_at < p_channel_changed_at, false)
          or p_row.reconcile_next_at is null
          or p_row.reconcile_next_at <= p_now
        )
      when p_row.state = 'pending' then
        (p_row.last_released_at is null or p_row.last_released_at + interval '1 minute' <= p_now)
        and (p_row.reconcile_next_at is null or p_row.reconcile_next_at <= p_now)
      else false
    end;
$body$;

revoke all on function private.whatsapp_inbox_reconcile_eligible(public.whatsapp_webhook_inbox, text, timestamptz, timestamptz) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- Reserva
-- ---------------------------------------------------------------------

create function public.whatsapp_inbox_reconcile_reserve(p_limit integer, p_reservation_seconds integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_env public.whatsapp_environment := private.require_whatsapp_environment();
  v_now timestamptz;
  v_candidates integer;
  v_entries jsonb;
begin
  if p_limit is null or p_limit not between 1 and 25 then
    raise exception 'invalid_limit';
  end if;
  if p_reservation_seconds is null or p_reservation_seconds not between 30 and 300 then
    raise exception 'invalid_reservation';
  end if;

  v_now := clock_timestamp();

  select count(*)::integer into v_candidates
  from public.whatsapp_webhook_inbox i
  join public.whatsapp_channels ch
    on ch.id = i.channel_id and ch.workspace_id = i.workspace_id and ch.environment = i.environment and ch.provider = i.provider
  where i.environment = v_env
    and i.state in ('pending', 'processing')
    and private.whatsapp_inbox_reconcile_eligible(i, ch.status, ch.status_changed_at, v_now);

  with picked as (
    select i.id
    from public.whatsapp_webhook_inbox i
    join public.whatsapp_channels ch
      on ch.id = i.channel_id and ch.workspace_id = i.workspace_id and ch.environment = i.environment and ch.provider = i.provider
    where i.environment = v_env
      and i.state in ('pending', 'processing')
      and private.whatsapp_inbox_reconcile_eligible(i, ch.status, ch.status_changed_at, v_now)
    order by i.received_at, i.id
    limit p_limit
    for update of i skip locked
  ),
  reserved as (
    update public.whatsapp_webhook_inbox i
    set reconcile_token = gen_random_uuid(),
        reconcile_reserved_at = v_now,
        reconcile_reserved_until = v_now + make_interval(secs => p_reservation_seconds),
        reconcile_attempts = i.reconcile_attempts + 1
    from picked p
    where i.id = p.id
    returning i.id, i.reconcile_token, i.received_at
  )
  select coalesce(
    jsonb_agg(jsonb_build_object('inbox_id', r.id, 'reservation_token', r.reconcile_token) order by r.received_at, r.id),
    '[]'::jsonb
  ) into v_entries
  from reserved r;

  return jsonb_build_object('candidates', v_candidates, 'entries', v_entries);
end;
$body$;

-- ---------------------------------------------------------------------
-- Resultado da publicação, preso ao token
-- ---------------------------------------------------------------------

-- Publicação aceita: limpa a reserva e o código de falha, grava o horário e
-- agenda a próxima tentativa (o consumidor pode não ter concluído a entrada).
-- Não toca no estado da entrada: ela pode até já ter sido processada.
create function public.whatsapp_inbox_reconcile_confirm(p_inbox_id uuid, p_reservation_token uuid)
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

  v_now := clock_timestamp();
  if p_reservation_token is null
     or v_row.reconcile_token is distinct from p_reservation_token
     or v_row.reconcile_reserved_until is null
     or v_row.reconcile_reserved_until <= v_now then
    return jsonb_build_object('outcome', 'reservation_lost');
  end if;

  update public.whatsapp_webhook_inbox
  set reconcile_token = null,
      reconcile_reserved_until = null,
      last_republished_at = v_now,
      last_republish_error_code = null,
      reconcile_next_at = v_now + private.whatsapp_inbox_reconcile_backoff(v_row.reconcile_attempts)
  where id = v_row.id;

  return jsonb_build_object('outcome', 'confirmed');
end;
$body$;

-- Publicação recusada ou sem resposta: só o código fixo e a próxima tentativa.
create function public.whatsapp_inbox_reconcile_fail(p_inbox_id uuid, p_reservation_token uuid, p_code text)
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
  if p_code is null or p_code not in ('inbox_event_publish_failed', 'inbox_event_not_configured') then
    raise exception 'invalid_error_code';
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

  v_now := clock_timestamp();
  if p_reservation_token is null
     or v_row.reconcile_token is distinct from p_reservation_token
     or v_row.reconcile_reserved_until is null
     or v_row.reconcile_reserved_until <= v_now then
    return jsonb_build_object('outcome', 'reservation_lost');
  end if;

  update public.whatsapp_webhook_inbox
  set reconcile_token = null,
      reconcile_reserved_until = null,
      last_republish_error_code = p_code,
      reconcile_next_at = v_now + private.whatsapp_inbox_reconcile_backoff(v_row.reconcile_attempts)
  where id = v_row.id;

  return jsonb_build_object('outcome', 'failed');
end;
$body$;

-- ---------------------------------------------------------------------
-- Batimento técnico
-- ---------------------------------------------------------------------

create table public.whatsapp_reconciler_runs (
  id uuid primary key default gen_random_uuid(),
  environment public.whatsapp_environment not null,
  origin text not null check (origin in ('inngest', 'manual_test')),
  started_at timestamptz not null,
  finished_at timestamptz not null,
  outcome text not null check (outcome in ('ok', 'partial', 'failed')),
  candidates integer not null check (candidates >= 0),
  reserved integer not null check (reserved >= 0),
  published integer not null check (published >= 0),
  skipped integer not null check (skipped >= 0),
  failures integer not null check (failures >= 0),
  constraint whatsapp_reconciler_runs_dates check (finished_at >= started_at)
);

comment on table public.whatsapp_reconciler_runs is
  'Batimento técnico do reconciliador da inbox (B3.2e): só ambiente, origem, horários, desfecho e contagens. Não confundir com whatsapp_channels.last_event_at, o último evento do provedor.';

create index whatsapp_reconciler_runs_recent_idx on public.whatsapp_reconciler_runs (environment, finished_at desc);

alter table public.whatsapp_reconciler_runs enable row level security;
alter table public.whatsapp_reconciler_runs force row level security;
create policy whatsapp_reconciler_runs_select_deny on public.whatsapp_reconciler_runs for select to authenticated using (false);
create policy whatsapp_reconciler_runs_insert_deny on public.whatsapp_reconciler_runs for insert to authenticated with check (false);
create policy whatsapp_reconciler_runs_update_deny on public.whatsapp_reconciler_runs for update to authenticated using (false);
create policy whatsapp_reconciler_runs_delete_deny on public.whatsapp_reconciler_runs for delete to authenticated using (false);
revoke all on table public.whatsapp_reconciler_runs from public, anon, authenticated, service_role;

-- O ambiente é o assinado da requisição, nunca informado pelo chamador.
create function public.whatsapp_reconciler_record_run(
  p_origin text,
  p_started_at timestamptz,
  p_outcome text,
  p_candidates integer,
  p_reserved integer,
  p_published integer,
  p_skipped integer,
  p_failures integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $body$
declare
  v_env public.whatsapp_environment := private.require_whatsapp_environment();
  v_now timestamptz := clock_timestamp();
begin
  if p_origin is null or p_origin not in ('inngest', 'manual_test')
     or p_outcome is null or p_outcome not in ('ok', 'partial', 'failed')
     or p_started_at is null or p_started_at > v_now or p_started_at < v_now - interval '1 day'
     or p_candidates is null or p_candidates < 0
     or p_reserved is null or p_reserved < 0
     or p_published is null or p_published < 0
     or p_skipped is null or p_skipped < 0
     or p_failures is null or p_failures < 0 then
    raise exception 'invalid_reconciler_run';
  end if;

  insert into public.whatsapp_reconciler_runs (environment, origin, started_at, finished_at, outcome, candidates, reserved, published, skipped, failures)
  values (v_env, p_origin, p_started_at, v_now, p_outcome, p_candidates, p_reserved, p_published, p_skipped, p_failures);

  delete from public.whatsapp_reconciler_runs
  where environment = v_env and finished_at < v_now - interval '30 days';

  return jsonb_build_object('outcome', 'recorded');
end;
$body$;

-- EXECUTE só para service_role.
revoke all on function public.whatsapp_inbox_reconcile_reserve(integer, integer) from public, anon, authenticated;
revoke all on function public.whatsapp_inbox_reconcile_confirm(uuid, uuid) from public, anon, authenticated;
revoke all on function public.whatsapp_inbox_reconcile_fail(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.whatsapp_reconciler_record_run(text, timestamptz, text, integer, integer, integer, integer, integer) from public, anon, authenticated;

grant execute on function public.whatsapp_inbox_reconcile_reserve(integer, integer) to service_role;
grant execute on function public.whatsapp_inbox_reconcile_confirm(uuid, uuid) to service_role;
grant execute on function public.whatsapp_inbox_reconcile_fail(uuid, uuid, text) to service_role;
grant execute on function public.whatsapp_reconciler_record_run(text, timestamptz, text, integer, integer, integer, integer, integer) to service_role;
