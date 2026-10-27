#!/usr/bin/env bash
# B3.2d-2a — a finalização SEM efeito no domínio (whatsapp_inbox_dispose)
# sob concorrência REAL (várias sessões Postgres simultâneas). O pgTAP 34
# roda numa sessão só; aqui se prova, entre transações:
#
#   1. Dois consumidores pedem o claim da MESMA entrada ao mesmo tempo,
#      parados atrás de uma transação que segura a linha: exatamente um
#      `claimed` e um `busy`.
#   2. Duas finalizações com o MESMO token válido, ao mesmo tempo: uma
#      `completed`, a outra espera a trava e vê `already_processed`. A
#      disposição e o horário são gravados uma vez só.
#   3. A lease vence de verdade (15 s) e ninguém reclama: dispose com o
#      token original → `claim_lost`, nada muda. Um consumidor novo
#      reclama com token novo; o original segue recusado; só o novo
#      finaliza, e a disposição é gravada uma vez.
#
# Canal próprio, dados fictícios e o Postgres local do CI. Nada de
# provedor, nada hospedado.
set -euo pipefail

DB_CONTAINER="supabase_db_praxis-crm"
WS="10000000-0000-0000-0000-000000000001"
DONO="20000000-0000-0000-0000-000000000001"
CANAL="$(cat /proc/sys/kernel/random/uuid)"
ROUTING="b3d2a-conc-$(date +%s%N | tail -c 9)"

psql_as() { # $1 = application_name; resto = argumentos do psql
  local app="$1"; shift
  docker exec -i -e PGAPPNAME="$app" "$DB_CONTAINER" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -qAt "$@"
}

SERVICE_SQL="select set_config('request.headers', json_build_object('x-praxis-whatsapp-env', 'v1.preview.' || e.x || '.' || private.whatsapp_environment_signature('preview', e.x, k.signing_key))::text, false)
  from (select extract(epoch from now())::bigint + 600 as x) e,
       (select signing_key from public.whatsapp_environment_keys where environment = 'preview') k;
set role service_role;"

fail() { echo "FALHOU: $*" >&2; exit 1; }

wait_sleeping() { # espera a sessão $1 entrar no pg_sleep (transação aberta)
  for _ in $(seq 1 100); do
    if [ "$(psql_as b3d2a_main -c "select count(*) from pg_stat_activity where application_name = '$1' and query like '%pg_sleep%' and state = 'active'")" = "1" ]; then
      return 0
    fi
    sleep 0.1
  done
  fail "a sessão $1 não chegou ao pg_sleep"
}

wait_lock_waiters() { # espera $1 sessões com prefixo $2 paradas numa trava
  for _ in $(seq 1 100); do
    if [ "$(psql_as b3d2a_main -c "select count(*) from pg_stat_activity where application_name like '$2%' and wait_event_type = 'Lock'")" = "$1" ]; then
      return 0
    fi
    sleep 0.1
  done
  fail "as $1 sessões $2* não chegaram à espera pela trava"
}

claim_sql() { echo "$SERVICE_SQL select public.whatsapp_inbox_claim('$1'::uuid, $2) ->> ${3:-'outcome'};"; }
dispose_sql() { echo "$SERVICE_SQL select public.whatsapp_inbox_dispose('$1'::uuid, '$2'::uuid, '$3') ->> 'outcome';"; }
row_of() { psql_as b3d2a_main -c "select state || '|' || claim_count || '|' || coalesce(disposition, '-') || '|' || coalesce(processed_at::text, '-') || '|' || coalesce(claim_token::text, '-') from public.whatsapp_webhook_inbox where id = '$1'"; }
lease_over() { psql_as b3d2a_main -c "select (lease_until <= clock_timestamp())::text from public.whatsapp_webhook_inbox where id = '$1'"; }

echo "== preparo (canal e entradas próprios)"
SETUP="$(psql_as b3d2a_setup <<SQL
insert into public.whatsapp_environment_keys (environment, signing_key) values
  ('preview', 'chave-whatsapp-preview-concorrencia-0123456789')
on conflict do nothing;
$SERVICE_SQL
select public.whatsapp_create_simulated_channel('$CANAL'::uuid, '$WS'::uuid, '$DONO'::uuid, 'Concorrência B3.2d-2a', '$ROUTING', '1',
  'QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFB', '1') is not null as ok \gset
select string_agg(public.whatsapp_inbox_store('$CANAL'::uuid, '$WS'::uuid, 'simulated', '$ROUTING', 'evt-disp-' || n, 'other',
  repeat('a', 64), '1', 'AAAAAAAAAAAAAAAA', 'Q29ycG8gZmljdGljaW8gMQ==', 'AAAAAAAAAAAAAAAAAAAAAA==', 3600) ->> 'inbox_id', ' ' order by n)
from generate_series(1, 3) n;
SQL
)"
read -r E1 E2 E3 <<<"$(echo "$SETUP" | tail -1)"
[ -n "${E3:-}" ] || fail "preparo sem resultado: $SETUP"

echo "== 1. dois consumidores pedem o claim da mesma entrada ao mesmo tempo"
OUT_X="$(mktemp)"
psql_as b3d2a_x > "$OUT_X" 2>&1 <<SQL &
begin;
select 1 from public.whatsapp_webhook_inbox where id = '$E1' for share;
select pg_sleep(4);
commit;
SQL
PID_X=$!
wait_sleeping b3d2a_x
DIR="$(mktemp -d)"
claim_sql "$E1" 60 "'claim_token'" | psql_as b3d2a_c1 > "$DIR/c1" 2>&1 &
PID_1=$!
claim_sql "$E1" 60 "'claim_token'" | psql_as b3d2a_c2 > "$DIR/c2" 2>&1 &
PID_2=$!
wait_lock_waiters 2 b3d2a_c
wait $PID_X || fail "sessão de bloqueio falhou: $(cat "$OUT_X")"
wait $PID_1 || true
wait $PID_2 || true
TOKENS="$(cat "$DIR/c1" "$DIR/c2" | grep -cE '^[0-9a-f-]{36}$' || true)"
[ "$TOKENS" = "1" ] || fail "esperado exatamente um claim, vieram $TOKENS: $(cat "$DIR"/c*)"
TOKEN_1="$(cat "$DIR/c1" "$DIR/c2" | grep -E '^[0-9a-f-]{36}$')"
[ "$(row_of "$E1" | cut -d'|' -f1-3)" = "processing|1|-" ] || fail "estado da entrada 1: $(row_of "$E1")"
echo "   ok: um claim e um busy; claim_count = 1"

echo "== 2. duas finalizações com o mesmo token ao mesmo tempo: uma disposição só"
OUT_A="$(mktemp)"
psql_as b3d2a_a > "$OUT_A" 2>&1 <<SQL &
$SERVICE_SQL
begin;
select public.whatsapp_inbox_dispose('$E1'::uuid, '$TOKEN_1'::uuid, 'unsupported_event') ->> 'outcome';
select pg_sleep(4);
commit;
SQL
PID_A=$!
wait_sleeping b3d2a_a
T0=$(date +%s%N)
SECOND="$(dispose_sql "$E1" "$TOKEN_1" "ignored_history" | psql_as b3d2a_b | tail -1)"
T1=$(date +%s%N)
WAITED_MS=$(( (T1 - T0) / 1000000 ))
wait $PID_A || fail "sessão A falhou: $(cat "$OUT_A")"
grep -qx "completed" "$OUT_A" || fail "a primeira finalização deveria completar: $(cat "$OUT_A")"
[ "$SECOND" = "already_processed" ] || fail "a segunda finalização deveria ver already_processed, veio: $SECOND"
[ "$WAITED_MS" -ge 1000 ] || fail "a segunda finalização não esperou a trava (${WAITED_MS} ms)"
ROW1="$(row_of "$E1")"
[ "$(echo "$ROW1" | cut -d'|' -f1-3)" = "processed|1|unsupported_event" ] || fail "estado final da entrada 1: $ROW1"
[ "$(echo "$ROW1" | cut -d'|' -f5)" = "-" ] || fail "o token deveria estar limpo: $ROW1"
AGAIN="$(dispose_sql "$E1" "$TOKEN_1" "unsupported_event" | psql_as b3d2a_b | tail -1)"
[ "$AGAIN" = "already_processed" ] && [ "$(row_of "$E1")" = "$ROW1" ] || fail "repetir mudou a entrada: $AGAIN $(row_of "$E1")"
echo "   ok: a segunda esperou ${WAITED_MS} ms e viu already_processed; disposição e horário gravados uma vez"

echo "== 3. lease vencida sem novo claim: o token original não finaliza; só o novo"
TOKEN_F="$(claim_sql "$E2" 15 "'claim_token'" | psql_as b3d2a_main | tail -1)"
[ -n "$TOKEN_F" ] || fail "o consumidor F não obteve o claim"
for _ in $(seq 1 250); do
  [ "$(lease_over "$E2")" = "true" ] && break
  sleep 0.1
done
[ "$(lease_over "$E2")" = "true" ] || fail "a lease de 15 s da entrada 2 não venceu"
BEFORE="$(row_of "$E2")"
LATE="$(dispose_sql "$E2" "$TOKEN_F" "unsupported_event" | psql_as b3d2a_f | tail -1)"
[ "$LATE" = "claim_lost" ] || fail "dispose com a lease vencida deveria ser recusado, veio: $LATE"
[ "$(row_of "$E2")" = "$BEFORE" ] || fail "claim_lost mudou a entrada: $BEFORE → $(row_of "$E2")"
echo "   ok: lease vencida; dispose original recusado (claim_lost) e nada mudou"
TOKEN_G="$(claim_sql "$E2" 60 "'claim_token'" | psql_as b3d2a_g | tail -1)"
[ -n "$TOKEN_G" ] && [ "$TOKEN_G" != "$TOKEN_F" ] || fail "o consumidor G não reclamou com token novo: $TOKEN_G"
OLD="$(dispose_sql "$E2" "$TOKEN_F" "unsupported_event" | psql_as b3d2a_f | tail -1)"
[ "$OLD" = "claim_lost" ] || fail "o token original deveria seguir recusado, veio: $OLD"
NEW="$(dispose_sql "$E2" "$TOKEN_G" "unsupported_event" | psql_as b3d2a_g | tail -1)"
[ "$NEW" = "completed" ] || fail "o token novo deveria finalizar, veio: $NEW"
ROW2="$(row_of "$E2")"
[ "$(echo "$ROW2" | cut -d'|' -f1-3)" = "processed|2|unsupported_event" ] || fail "estado final da entrada 2: $ROW2"
LATER="$(dispose_sql "$E2" "$TOKEN_G" "ignored_history" | psql_as b3d2a_g | tail -1)"
[ "$LATER" = "already_processed" ] && [ "$(row_of "$E2")" = "$ROW2" ] || fail "a disposição foi regravada: $LATER $(row_of "$E2")"
echo "   ok: só o token novo finalizou; claim_count = 2; disposição gravada uma vez"

# A terceira entrada não é tocada: prova que o canal não mudou nada fora das duas.
[ "$(row_of "$E3" | cut -d'|' -f1-3)" = "pending|0|-" ] || fail "a entrada 3 não deveria mudar: $(row_of "$E3")"
echo "== finalização sem efeito sob concorrência real: OK"
