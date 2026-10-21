#!/usr/bin/env bash
# B3.2d-1 — o claim da inbox do WhatsApp sob concorrência REAL (várias
# sessões Postgres simultâneas). O pgTAP 33 roda numa sessão só e prova as
# regras em sequência; aqui se prova a trava de linha entre transações:
#
#   1. Oito workers pedem o claim da MESMA entrada ao mesmo tempo, todos
#      parados atrás de uma transação que segura a linha. Quando ela
#      termina, exatamente um recebe `claimed` e os outros sete `busy`;
#      claim_count fica 1. Sem a trava de linha (SELECT ... FOR UPDATE), os
#      oito leriam a entrada como pendente e mais de um sairia com claim.
#   2. A lease venceu e um worker novo reclama a entrada com a transação
#      aberta: o complete do worker antigo ESPERA essa transação e é
#      recusado (`claim_lost`); só o token novo completa.
#   3. Um complete com a transação aberta segura a linha: um claim
#      concorrente espera e, depois, recebe `already_processed`.
#
# Usa um canal próprio, dados fictícios e o Postgres local do CI (que o
# passo seguinte recria). Nada de provedor, nada hospedado.
set -euo pipefail

DB_CONTAINER="supabase_db_praxis-crm"
WS="10000000-0000-0000-0000-000000000001"
DONO="20000000-0000-0000-0000-000000000001"
CANAL="$(cat /proc/sys/kernel/random/uuid)"
ROUTING="b3d1-conc-$(date +%s%N | tail -c 9)"
WORKERS=8

psql_as() { # $1 = application_name; resto = argumentos do psql
  local app="$1"; shift
  docker exec -i -e PGAPPNAME="$app" "$DB_CONTAINER" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -qAt "$@"
}

# Ambiente assinado do WhatsApp (Preview), como o servidor envia, e o papel
# do servidor (service_role).
SERVICE_SQL="select set_config('request.headers', json_build_object('x-praxis-whatsapp-env', 'v1.preview.' || e.x || '.' || private.whatsapp_environment_signature('preview', e.x, k.signing_key))::text, false)
  from (select extract(epoch from now())::bigint + 600 as x) e,
       (select signing_key from public.whatsapp_environment_keys where environment = 'preview') k;
set role service_role;"

fail() { echo "FALHOU: $*" >&2; exit 1; }

wait_sleeping() { # espera a sessão $1 entrar no pg_sleep (transação aberta)
  for _ in $(seq 1 100); do
    if [ "$(psql_as b3d1_main -c "select count(*) from pg_stat_activity where application_name = '$1' and query like '%pg_sleep%' and state = 'active'")" = "1" ]; then
      return 0
    fi
    sleep 0.1
  done
  fail "a sessão $1 não chegou ao pg_sleep"
}

wait_lock_waiters() { # espera $1 sessões com prefixo $2 paradas numa trava
  for _ in $(seq 1 100); do
    if [ "$(psql_as b3d1_main -c "select count(*) from pg_stat_activity where application_name like '$2%' and wait_event_type = 'Lock'")" = "$1" ]; then
      return 0
    fi
    sleep 0.1
  done
  fail "as $1 sessões $2* não chegaram à espera pela trava"
}

claim_sql() { echo "$SERVICE_SQL select public.whatsapp_inbox_claim('$1'::uuid, $2) ->> ${3:-'outcome'};"; }
finish_sql() { echo "$SERVICE_SQL select public.whatsapp_inbox_complete('$1'::uuid, '$2'::uuid) ->> 'outcome';"; }
state_of() { psql_as b3d1_main -c "select state || '|' || claim_count from public.whatsapp_webhook_inbox where id = '$1'"; }

echo "== preparo (canal e entradas próprios)"
SETUP="$(psql_as b3d1_setup <<SQL
insert into public.whatsapp_environment_keys (environment, signing_key) values
  ('preview', 'chave-whatsapp-preview-concorrencia-0123456789')
on conflict do nothing;
$SERVICE_SQL
select public.whatsapp_create_simulated_channel('$CANAL'::uuid, '$WS'::uuid, '$DONO'::uuid, 'Concorrência B3.2d-1', '$ROUTING', '1',
  'QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFB', '1') is not null as ok \gset
select string_agg(public.whatsapp_inbox_store('$CANAL'::uuid, '$WS'::uuid, 'simulated', '$ROUTING', 'evt-conc-' || n, 'message.inbound',
  repeat('a', 64), '1', 'AAAAAAAAAAAAAAAA', 'Q29ycG8gZmljdGljaW8gMQ==', 'AAAAAAAAAAAAAAAAAAAAAA==', 3600) ->> 'inbox_id', ' ' order by n)
from generate_series(1, 3) n;
SQL
)"
read -r E1 E2 E3 <<<"$(echo "$SETUP" | tail -1)"
[ -n "${E3:-}" ] || fail "preparo sem resultado: $SETUP"

echo "== 1. $WORKERS workers pedem o claim da mesma entrada ao mesmo tempo"
OUT_X="$(mktemp)"
psql_as b3d1_x > "$OUT_X" 2>&1 <<SQL &
begin;
select 1 from public.whatsapp_webhook_inbox where id = '$E1' for share;
select pg_sleep(4);
commit;
SQL
PID_X=$!
wait_sleeping b3d1_x

DIR="$(mktemp -d)"
PIDS=()
for i in $(seq 1 "$WORKERS"); do
  claim_sql "$E1" 60 | psql_as "b3d1_w$i" > "$DIR/w$i" 2>&1 &
  PIDS+=("$!")
done
wait_lock_waiters "$WORKERS" b3d1_w
echo "   ok: os $WORKERS workers estão parados na trava da linha"

wait $PID_X || fail "sessão de bloqueio falhou: $(cat "$OUT_X")"
for pid in "${PIDS[@]}"; do wait "$pid" || true; done
RESULTS="$(for i in $(seq 1 "$WORKERS"); do tail -1 "$DIR/w$i"; done | sort | uniq -c | awk '{print $2 "=" $1}' | paste -sd' ')"
[ "$RESULTS" = "busy=$((WORKERS - 1)) claimed=1" ] || fail "esperado um claimed e $((WORKERS - 1)) busy, veio: $RESULTS ($(cat "$DIR"/w*))"
[ "$(state_of "$E1")" = "processing|1" ] || fail "estado final da entrada 1: $(state_of "$E1")"
echo "   ok: um claimed, $((WORKERS - 1)) busy; claim_count = 1"

echo "== 2. lease vencida: o worker novo reclama com a transação aberta; o antigo espera e perde"
TOKEN_A="$(claim_sql "$E2" 15 "'claim_token'" | psql_as b3d1_main | tail -1)"
[ -n "$TOKEN_A" ] || fail "o worker A não obteve o claim"
psql_as b3d1_main -c "update public.whatsapp_webhook_inbox set claimed_at = clock_timestamp() - interval '2 minutes', lease_until = clock_timestamp() - interval '1 minute' where id = '$E2'" >/dev/null
OUT_C="$(mktemp)"
psql_as b3d1_c > "$OUT_C" 2>&1 <<SQL &
$SERVICE_SQL
begin;
select public.whatsapp_inbox_claim('$E2'::uuid, 60) ->> 'claim_token';
select pg_sleep(4);
commit;
SQL
PID_C=$!
wait_sleeping b3d1_c

T0=$(date +%s%N)
OLD="$(finish_sql "$E2" "$TOKEN_A" | psql_as b3d1_a | tail -1)"
T1=$(date +%s%N)
WAITED_MS=$(( (T1 - T0) / 1000000 ))
wait $PID_C || fail "sessão C falhou: $(cat "$OUT_C")"
TOKEN_B="$(grep -E '^[0-9a-f-]{36}$' "$OUT_C" | tail -1)"
[ -n "$TOKEN_B" ] && [ "$TOKEN_B" != "$TOKEN_A" ] || fail "o worker C não reclamou com token novo: $(cat "$OUT_C")"
[ "$OLD" = "claim_lost" ] || fail "o complete com o token vencido deveria ser recusado, veio: $OLD"
[ "$WAITED_MS" -ge 1000 ] || fail "o complete antigo não esperou a transação de quem reclamou (${WAITED_MS} ms)"
echo "   ok: o complete antigo esperou ${WAITED_MS} ms e foi recusado (claim_lost)"
NEW="$(finish_sql "$E2" "$TOKEN_B" | psql_as b3d1_c | tail -1)"
[ "$NEW" = "completed" ] || fail "o token novo deveria completar, veio: $NEW"
[ "$(state_of "$E2")" = "processed|2" ] || fail "estado final da entrada 2: $(state_of "$E2")"
echo "   ok: só o token novo completou; claim_count = 2"

echo "== 3. complete com a transação aberta segura a linha; o claim concorrente espera"
TOKEN_D="$(claim_sql "$E3" 60 "'claim_token'" | psql_as b3d1_main | tail -1)"
[ -n "$TOKEN_D" ] || fail "o worker D não obteve o claim"
OUT_D="$(mktemp)"
psql_as b3d1_d > "$OUT_D" 2>&1 <<SQL &
$SERVICE_SQL
begin;
select public.whatsapp_inbox_complete('$E3'::uuid, '$TOKEN_D'::uuid) ->> 'outcome';
select pg_sleep(4);
commit;
SQL
PID_D=$!
wait_sleeping b3d1_d
set +e
EARLY="$( (echo "set lock_timeout = '500ms';"; claim_sql "$E3" 60) | psql_as b3d1_e 2>&1)"
EARLY_RC=$?
set -e
[ $EARLY_RC -ne 0 ] && echo "$EARLY" | grep -q "lock timeout" \
  || fail "o claim não esperou o complete em andamento (rc=$EARLY_RC): $EARLY"
wait $PID_D || fail "sessão D falhou: $(cat "$OUT_D")"
grep -qx "completed" "$OUT_D" || fail "o complete de D deveria completar: $(cat "$OUT_D")"
AFTER="$(claim_sql "$E3" 60 | psql_as b3d1_e | tail -1)"
[ "$AFTER" = "already_processed" ] || fail "depois do complete, o claim deveria ver already_processed, veio: $AFTER"
echo "   ok: o claim esperou o complete e depois viu already_processed"
echo "== claim da inbox sob concorrência real: OK"
