#!/usr/bin/env bash
# B2, etapa 3 — a trava de sincronização sob concorrência REAL (duas sessões
# Postgres simultâneas). O pgTAP roda numa sessão só e prova a regra em
# sequência; aqui se prova o bloqueio entre transações abertas:
#
#   1. A aplica com a trava válida e fica com a transação aberta enquanto a
#      trava vence: B NÃO consegue assumir antes de A terminar (a linha do
#      estado está bloqueada por `private.lock_sync_lease`). Depois que A
#      termina, B assume normalmente.
#   2. B assume uma trava vencida e fica com a transação aberta: a aplicação,
#      o `reset` e o `finish` de A esperam B terminar e então são recusados
#      (`lease_lost` / `false`), sem gravar nada.
#
# Usa um workspace próprio, dados fictícios e o Postgres local do CI (que o
# passo seguinte recria). Nada de Google, nada hospedado.
set -euo pipefail

DB_CONTAINER="supabase_db_praxis-crm"
DONO="20000000-0000-0000-0000-000000000001"
CAL="cal-concorrencia@x"

psql_as() { # $1 = application_name; resto = argumentos do psql
  local app="$1"; shift
  docker exec -i -e PGAPPNAME="$app" "$DB_CONTAINER" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -qAt "$@"
}

# Cabeçalho de ambiente assinado (production), como o servidor envia.
HEADERS_SQL="select set_config('request.headers', json_build_object('x-praxis-env', 'production.' || e.x || '.' || private.environment_signature('production', e.x, k.signing_key))::text, false)
  from (select extract(epoch from now())::bigint + 600 as x) e,
       (select signing_key from public.calendar_environment_keys where environment = 'production') k;"

fail() { echo "FALHOU: $*" >&2; exit 1; }

wait_sleeping() { # espera a sessão $1 entrar no pg_sleep (transação aberta)
  for _ in $(seq 1 100); do
    if [ "$(psql_as b2_main -c "select count(*) from pg_stat_activity where application_name = '$1' and query like '%pg_sleep%' and state = 'active'")" = "1" ]; then
      return 0
    fi
    sleep 0.1
  done
  fail "a sessão $1 não chegou ao pg_sleep"
}

echo "== preparo (workspace, conexão e vínculo próprios)"
SETUP="$(psql_as b2_setup <<SQL
insert into public.calendar_environment_keys (environment, signing_key) values
  ('production', 'chave-de-producao-concorrencia-0123456789'),
  ('preview', 'chave-de-preview-concorrencia-01234567890')
on conflict do nothing;
begin;
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', '$DONO', 'role', 'authenticated')::text, true);
select (create_workspace_with_owner('Concorrência B2', 'concorrencia-b2-' || substr(md5(random()::text), 1, 8))).id as ws \gset
select (create_contact(:'ws'::uuid, 'pf', 'Cliente concorrência B2', null, null, null)).id as contact \gset
select create_lead(:'ws'::uuid, (:'contact')::uuid, 'Trabalhista', 'Lead concorrência B2', '{}'::text[], 'media', null) as lead \gset
select create_activity(
  p_lead_id := (:'lead')::uuid, p_type := 'meeting'::activity_type, p_title := 'Reunião concorrência',
  p_due_date := (current_date + 5), p_due_time := '15:00'::time
) as reuniao \gset
reset role;
$HEADERS_SQL
select connect_calendar_account(:'ws'::uuid, '$DONO'::uuid, 'dono@concorrencia.test', array['escopo'], 'r', 'a', now() + interval '1 hour', '1') as conn \gset
select set_calendar_connection_calendar(:'conn'::uuid, '$DONO'::uuid, '$CAL', 'Agenda concorrência');
select create_calendar_event_link(:'conn'::uuid, :'reuniao'::uuid, '$DONO'::uuid, 'evento-concorrencia') as link \gset
update public.calendar_event_links set base_etag = '"1"' where id = (:'link')::uuid;
commit;
select :'conn' || ' ' || :'link' || ' ' || :'reuniao' || ' ' || (select lock_version from public.activities where id = (:'reuniao')::uuid);
SQL
)"
read -r CONN LINK REUNIAO V0 <<<"$(echo "$SETUP" | tail -1)"
[ -n "${V0:-}" ] || fail "preparo sem resultado: $SETUP"

claim_sql() { echo "$HEADERS_SQL select claim_calendar_sync('$CONN'::uuid, '$CAL', '$DONO'::uuid) ->> 'leaseId';"; }
apply_sql() { # $1 = trava, $2 = título
  echo "select apply_google_inbound_change('$LINK'::uuid, '$DONO'::uuid, '$1'::uuid, '\"1\"', $V0, '$2', null, '[]'::jsonb,
    jsonb_build_object('etag', '\"2\"', 'title', '$2', 'linkStatus', 'linked', 'changed', jsonb_build_array('title'))) ->> 'status';"
}

echo "== 1. A aplica com a trava válida e segura a transação; a trava vence no meio"
LEASE_A="$(claim_sql | psql_as b2_main | tail -1)"
[ -n "$LEASE_A" ] || fail "A não pegou a trava"
OUT_A="$(mktemp)"
psql_as b2_a > "$OUT_A" 2>&1 <<SQL &
$HEADERS_SQL
update public.calendar_sync_state set lease_until = clock_timestamp() + interval '2 seconds' where lease_id = '$LEASE_A';
begin;
$(apply_sql "$LEASE_A" "Título de A")
select pg_sleep(6);
commit;
SQL
PID_A=$!
wait_sleeping b2_a
sleep 2.5 # a trava de A já venceu, mas a transação de A continua aberta

set +e
B_EARLY="$( (echo "set lock_timeout = '500ms';"; claim_sql) | psql_as b2_b 2>&1)"
B_EARLY_RC=$?
set -e
[ $B_EARLY_RC -ne 0 ] && echo "$B_EARLY" | grep -q "lock timeout" \
  || fail "B assumiu a trava com a transação de A aberta (rc=$B_EARLY_RC): $B_EARLY"
echo "   ok: B esperou (lock timeout) enquanto A gravava"

wait $PID_A || fail "sessão A falhou: $(cat "$OUT_A")"
grep -qx "applied" "$OUT_A" || fail "A deveria ter aplicado com a trava válida: $(cat "$OUT_A")"
LEASE_B="$(claim_sql | psql_as b2_b | tail -1)"
[ -n "$LEASE_B" ] && [ "$LEASE_B" != "$LEASE_A" ] || fail "B não assumiu depois que A terminou"
echo "   ok: A aplicou dentro da trava; B assumiu só depois"

echo "== 2. B assume uma trava vencida e segura a transação; A espera e é recusado"
psql_as b2_main -c "update public.calendar_sync_state set lease_until = clock_timestamp() - interval '1 second' where lease_id = '$LEASE_B'" >/dev/null
OLD="$LEASE_B" # agora é a trava vencida da execução "A"
OUT_C="$(mktemp)"
psql_as b2_c > "$OUT_C" 2>&1 <<SQL &
$HEADERS_SQL
begin;
select claim_calendar_sync('$CONN'::uuid, '$CAL', '$DONO'::uuid) ->> 'leaseId';
select pg_sleep(5);
commit;
SQL
PID_C=$!
wait_sleeping b2_c

T0=$(date +%s%N)
APPLY_OLD="$( (echo "$HEADERS_SQL"; apply_sql "$OLD" "Título que não pode chegar") | psql_as b2_a | tail -1)"
T1=$(date +%s%N)
WAITED_MS=$(( (T1 - T0) / 1000000 ))
wait $PID_C || fail "sessão C falhou: $(cat "$OUT_C")"
[ "$APPLY_OLD" = "lease_lost" ] || fail "aplicação com a trava tomada deveria ser recusada, veio: $APPLY_OLD"
[ "$WAITED_MS" -ge 1000 ] || fail "a aplicação não esperou a transação de quem assumiu (${WAITED_MS} ms)"
echo "   ok: a aplicação esperou ${WAITED_MS} ms e foi recusada (lease_lost)"

RESET_OLD="$( (echo "$HEADERS_SQL"; echo "select reset_calendar_sync_token('$OLD'::uuid, '$DONO'::uuid);") | psql_as b2_a | tail -1)"
FINISH_OLD="$( (echo "$HEADERS_SQL"; echo "select finish_calendar_sync('$OLD'::uuid, '$DONO'::uuid, 'success', 'tok-velho', true, '');") | psql_as b2_a | tail -1)"
[ "$RESET_OLD" = "f" ] || fail "reset com a trava tomada deveria devolver false: $RESET_OLD"
[ "$FINISH_OLD" = "f" ] || fail "finish com a trava tomada deveria devolver false: $FINISH_OLD"

FINAL="$(psql_as b2_main -c "select a.title || '|' || a.lock_version || '|' || l.base_etag || '|' || coalesce(s.sync_token, '-') || '|' || (s.lease_id is not null and s.lease_id::text <> '$OLD')
  from public.activities a, public.calendar_event_links l, public.calendar_sync_state s
  where a.id = '$REUNIAO' and l.id = '$LINK' and s.connection_id = '$CONN' and s.calendar_id = '$CAL'")"
[ "$FINAL" = "Título de A|$((V0 + 1))|\"2\"|-|true" ] || fail "estado final inesperado: $FINAL"
echo "   ok: só a escrita feita com a trava válida ficou; token intacto; a trava é de quem assumiu"
echo "== trava sob concorrência real: OK"
