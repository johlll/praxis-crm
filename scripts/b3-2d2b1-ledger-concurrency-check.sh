#!/usr/bin/env bash
# B3.2d-2b1 — a reserva do ledger de efeitos
# (private.whatsapp_effect_ledger_reserve) sob concorrência REAL (várias
# sessões Postgres simultâneas). O pgTAP 35 roda numa sessão só; aqui se
# prova, entre transações:
#
#   1. Duas reservas do MESMO evento e efeito ao mesmo tempo: a segunda
#      espera a primeira e vê `duplicate`, com o id já gravado. Uma linha.
#   2. A primeira reserva fica numa transação que falha DEPOIS dela: a
#      segunda, que esperava, vira `reserved`. A reserva desfeita não
#      deixa rastro; fica só a linha da segunda.
#   3. Duas reservas do mesmo evento com efeitos DIFERENTES ao mesmo
#      tempo: a segunda espera e vê `conflict`. Fica só o efeito da
#      primeira.
#
# A função é interna: as sessões rodam como postgres, no ambiente
# autenticado pelo cabeçalho assinado (como as RPCs da B3.2d-2b2 vão
# chamar). Canal próprio, dados fictícios e o Postgres local do CI. Nada
# de provedor, nada hospedado.
set -euo pipefail

DB_CONTAINER="supabase_db_praxis-crm"
WS="10000000-0000-0000-0000-000000000001"
DONO="20000000-0000-0000-0000-000000000001"
CANAL="$(cat /proc/sys/kernel/random/uuid)"
ROUTING="b3d2b1-led-$(date +%s%N | tail -c 9)"

psql_as() { # $1 = application_name; resto = argumentos do psql
  local app="$1"; shift
  docker exec -i -e PGAPPNAME="$app" "$DB_CONTAINER" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -qAt "$@"
}

ENV_SQL="select set_config('request.headers', json_build_object('x-praxis-whatsapp-env', 'v1.preview.' || e.x || '.' || private.whatsapp_environment_signature('preview', e.x, k.signing_key))::text, false)
  from (select extract(epoch from now())::bigint + 600 as x) e,
       (select signing_key from public.whatsapp_environment_keys where environment = 'preview') k \\g /dev/null"

fail() { echo "FALHOU: $*" >&2; exit 1; }

wait_lock_waiters() { # espera $1 sessões com prefixo $2 paradas numa trava
  for _ in $(seq 1 100); do
    if [ "$(psql_as b3d2b1_main -c "select count(*) from pg_stat_activity where application_name like '$2%' and wait_event_type = 'Lock'")" = "$1" ]; then
      return 0
    fi
    sleep 0.1
  done
  fail "as $1 sessões $2* não chegaram à espera pela trava"
}

wait_sleeping() { # espera a sessão $1 entrar no pg_sleep (transação aberta)
  for _ in $(seq 1 100); do
    if [ "$(psql_as b3d2b1_main -c "select count(*) from pg_stat_activity where application_name = '$1' and query like '%pg_sleep%' and state = 'active'")" = "1" ]; then
      return 0
    fi
    sleep 0.1
  done
  fail "a sessão $1 não chegou ao pg_sleep"
}

reserve_sql() { echo "$ENV_SQL
select r.outcome || '|' || coalesce(r.ledger_id::text, '-') from private.whatsapp_effect_ledger_reserve('$1'::uuid, '$2') r;"; }
rows_of() { psql_as b3d2b1_main -c "select count(*) || '|' || coalesce(string_agg(id::text || '|' || effect, ','), '-') from public.whatsapp_effect_ledger where inbox_id = '$1'"; }

echo "== preparo (canal e entradas próprios)"
SETUP="$(psql_as b3d2b1_setup <<SQL
insert into public.whatsapp_environment_keys (environment, signing_key) values
  ('preview', 'chave-whatsapp-preview-concorrencia-0123456789')
on conflict do nothing;
$ENV_SQL
set role service_role;
select public.whatsapp_create_simulated_channel('$CANAL'::uuid, '$WS'::uuid, '$DONO'::uuid, 'Concorrência B3.2d-2b1', '$ROUTING', '1',
  'QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFB', '1') is not null as ok \gset
select string_agg(public.whatsapp_inbox_store('$CANAL'::uuid, '$WS'::uuid, 'simulated', '$ROUTING', 'evt-led-' || n, 'other',
  repeat('a', 64), '1', 'AAAAAAAAAAAAAAAA', 'Q29ycG8gZmljdGljaW8gMQ==', 'AAAAAAAAAAAAAAAAAAAAAA==', 3600) ->> 'inbox_id', ' ' order by n)
from generate_series(1, 3) n;
SQL
)"
read -r E1 E2 E3 <<<"$(echo "$SETUP" | tail -1)"
[ -n "${E3:-}" ] || fail "preparo sem resultado: $SETUP"

echo "== 1. duas reservas do mesmo evento e efeito ao mesmo tempo"
OUT_A="$(mktemp)"
psql_as b3d2b1_a > "$OUT_A" 2>&1 <<SQL &
$ENV_SQL
begin;
select r.outcome || '|' || r.ledger_id from private.whatsapp_effect_ledger_reserve('$E1'::uuid, 'message.inbound') r;
select pg_sleep(4) \\g /dev/null
commit;
SQL
PID_A=$!
wait_sleeping b3d2b1_a
T0=$(date +%s%N)
SECOND="$(reserve_sql "$E1" message.inbound | psql_as b3d2b1_b | tail -1)"
T1=$(date +%s%N)
WAITED_MS=$(( (T1 - T0) / 1000000 ))
wait $PID_A || fail "sessão A falhou: $(cat "$OUT_A")"
FIRST="$(grep -E '^(reserved|duplicate|conflict)\|' "$OUT_A" | tail -1)"
[ "${FIRST%%|*}" = "reserved" ] || fail "a primeira reserva deveria ser reserved: $(cat "$OUT_A")"
[ "$SECOND" = "duplicate|${FIRST#*|}" ] || fail "a segunda deveria ver duplicate com o mesmo id (${FIRST#*|}), veio: $SECOND"
[ "$WAITED_MS" -ge 1000 ] || fail "a segunda reserva não esperou a primeira (${WAITED_MS} ms)"
[ "$(rows_of "$E1")" = "1|${FIRST#*|}|message.inbound" ] || fail "linhas do evento 1: $(rows_of "$E1")"
echo "   ok: reserved e, depois de ${WAITED_MS} ms, duplicate com o mesmo id; uma linha"

echo "== 2. a primeira reserva é desfeita por uma falha depois dela"
OUT_A="$(mktemp)"
psql_as b3d2b1_a > "$OUT_A" 2>&1 <<SQL &
$ENV_SQL
begin;
select r.outcome from private.whatsapp_effect_ledger_reserve('$E2'::uuid, 'message.inbound') r;
select pg_sleep(4) \\g /dev/null
select 1 / 0;
commit;
SQL
PID_A=$!
wait_sleeping b3d2b1_a
reserve_sql "$E2" message.inbound | psql_as b3d2b1_b > "$OUT_A.b" 2>&1 &
PID_B=$!
wait_lock_waiters 1 b3d2b1_b
if wait $PID_A; then fail "a sessão A deveria falhar depois da reserva: $(cat "$OUT_A")"; fi
wait $PID_B || fail "sessão B falhou: $(cat "$OUT_A.b")"
SECOND="$(tail -1 "$OUT_A.b")"
grep -qx "reserved" "$OUT_A" || fail "a sessão A deveria ter reservado antes de falhar: $(cat "$OUT_A")"
grep -q "division by zero" "$OUT_A" || fail "a sessão A deveria falhar pela divisão: $(cat "$OUT_A")"
[ "${SECOND%%|*}" = "reserved" ] || fail "com a primeira desfeita, a segunda deveria reservar, veio: $SECOND"
[ "$(rows_of "$E2")" = "1|${SECOND#*|}|message.inbound" ] || fail "linhas do evento 2: $(rows_of "$E2")"
echo "   ok: a reserva desfeita não ficou; a segunda reservou; uma linha"

echo "== 3. mesmo evento com efeitos diferentes ao mesmo tempo"
OUT_A="$(mktemp)"
psql_as b3d2b1_a > "$OUT_A" 2>&1 <<SQL &
$ENV_SQL
begin;
select r.outcome || '|' || r.ledger_id from private.whatsapp_effect_ledger_reserve('$E3'::uuid, 'message.inbound') r;
select pg_sleep(4) \\g /dev/null
commit;
SQL
PID_A=$!
wait_sleeping b3d2b1_a
reserve_sql "$E3" message.status | psql_as b3d2b1_c > "$OUT_A.c" 2>&1 &
PID_C=$!
wait_lock_waiters 1 b3d2b1_c
wait $PID_A || fail "sessão A falhou: $(cat "$OUT_A")"
wait $PID_C || fail "sessão C falhou: $(cat "$OUT_A.c")"
FIRST="$(grep -E '^(reserved|duplicate|conflict)\|' "$OUT_A" | tail -1)"
[ "${FIRST%%|*}" = "reserved" ] || fail "a primeira reserva deveria ser reserved: $(cat "$OUT_A")"
[ "$(tail -1 "$OUT_A.c")" = "conflict|-" ] || fail "outro efeito na mesma chave deveria ser conflict, veio: $(cat "$OUT_A.c")"
[ "$(rows_of "$E3")" = "1|${FIRST#*|}|message.inbound" ] || fail "linhas do evento 3: $(rows_of "$E3")"
echo "   ok: a segunda esperou e viu conflict; ficou só o efeito da primeira"

echo "== reserva do ledger sob concorrência real: OK"
