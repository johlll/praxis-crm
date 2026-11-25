#!/usr/bin/env bash
# Conversas + IA — APLICADOR sob concorrência REAL (sessões Postgres simultâneas). O pgTAP 62 prova as
# regras numa sessão só; aqui se prova a disputa ao mesmo tempo:
#
#   1. Correção manual primeiro: a pessoa corrige e segura a transação; o aplicador, ao mesmo tempo, com a
#      versão antiga, espera a trava da trilha e é RECUSADO (version_stale). Nada sobrescrito; um evento.
#   2. Aplicador primeiro: ele aplica e segura a transação; a correção manual com a versão antiga espera e
#      recebe track_conflict (a pessoa recarrega e decide de novo). O marco humano não muda.
#   3. Mesma proposta, mesma chave, três sessões juntas: uma decisão, um evento, duas repetições sem erro.
#   4. Mesma chave, pedidos diferentes, juntos: uma decisão; o outro recebe idempotency_conflict.
#   5. Mesma chave entre o aplicador e a correção manual (alvos diferentes, nas duas ordens): quem chega
#      depois espera o registro único e recebe idempotency_conflict; uma única gravação com a chave.
#   6. Recusa antes da trava (etapa comercial), mesma chave, três sessões juntas: uma linha de decisão,
#      duas repetições.
#
# Workspace próprio (criado aqui), usuária fictícia do seed, Postgres local do CI. O portão do aplicador é
# aberto só durante o script, com referência de teste, e fechado no fim (também em caso de falha).
set -euo pipefail

DB_CONTAINER="supabase_db_praxis-crm"
ANA="20000000-0000-0000-0000-000000000001"
HOLD=3
PORTAO=6205901
FAILS=0

psql_as() { # $1 = application_name; resto = argumentos do psql
  local app="$1"; shift
  docker exec -i -e PGAPPNAME="$app" "$DB_CONTAINER" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -qAt "$@"
}

fail() { echo "FALHOU: $*" >&2; exit 1; }
bad() { echo "   FALHOU: $*" >&2; FAILS=$((FAILS + 1)); }

wait_sleeping() {
  for _ in $(seq 1 100); do
    if [ "$(psql_as srv_main -c "select count(*) from pg_stat_activity where application_name = '$1' and query like '%pg_sleep%' and state = 'active'")" = "1" ]; then
      return 0
    fi
    sleep 0.1
  done
  fail "a sessão $1 não chegou ao pg_sleep"
}

wait_lock_waiters() {
  for _ in $(seq 1 100); do
    if [ "$(psql_as srv_main -c "select count(*) from pg_stat_activity where application_name like '$2%' and wait_event_type = 'Lock'")" = "$1" ]; then
      return 0
    fi
    sleep 0.1
  done
  return 1
}

as_ana() {
  printf '%s\n' "begin;" "set local role authenticated;" \
    "select set_config('request.jwt.claims', json_build_object('sub', '$ANA', 'role', 'authenticated')::text, true);"
}
as_service() { printf '%s\n' "begin;" "set local role service_role;"; }

run_ana() { { as_ana; echo "$1"; echo "commit;"; } | psql_as srv_setup | tail -1; }
run_db() { psql_as srv_setup -c "$1" | tail -1; }
count() { psql_as srv_main -c "$1"; }

# apply WS CONV CHANGE TRACK OPP TO STEP VERSAO "ids" CHAVE  → texto SQL da chamada
apply_sql() {
  echo "select public.apply_status_track_automation('$1'::uuid, '$2'::uuid, '$3', '$4'::public.status_track_kind, $5, $6, null, $7, array[$8]::uuid[], '$9'::uuid, 'conc-teste:1')"
}

open_gate() {
  psql_as srv_porteiro >/dev/null 2>&1 <<SQL &
select pg_advisory_lock($PORTAO);
select pg_sleep(60);
SQL
  PID_G=$!
  wait_sleeping srv_porteiro
}
release_gate() {
  wait_lock_waiters "$1" "$2" || fail "as sessões $2 não chegaram ao portão"
  psql_as srv_main -c "select pg_cancel_backend(pid) from pg_stat_activity where application_name = 'srv_porteiro'" >/dev/null
  wait "$PID_G" || true
}

close_automation() {
  psql_as srv_main -c "update public.status_track_automation_gate set enabled = false, enabled_at = null, activation_ref = null" >/dev/null 2>&1 || true
}
trap close_automation EXIT

# Mensagem sintética: msg CONV TIPO ORIGEM_SQL → id. cliente = recebida de remetente externo;
# escritorio = envio humano pelo CRM (o gatilho da #358 grava crm_accepted = created_at).
msg() {
  local conv="$1" kind="$2" origin="$3" pm="pm-conc-62-$RANDOM-$RANDOM-$RANDOM"
  if [ "$kind" = "escritorio" ]; then
    run_db "insert into public.messages (workspace_id, conversation_id, channel_id, direction, status, origin, sender_classification, content_kind, body_text, provider, provider_message_id, sent_by, client_dedupe_key, origin_correlation_kind, origin_correlation_ref, created_at)
      select c.workspace_id, c.id, c.channel_id, 'outbound', 'sent', 'crm', 'internal', 'text', 'Mensagem fictícia do escritório', 'ycloud', '$pm', '$ANA', gen_random_uuid(), 'crm_outbox', '$pm', $origin
      from public.conversations c where c.id = '$conv' returning id;"
  else
    psql_as srv_setup >/dev/null <<SQL
begin;
insert into public.messages (workspace_id, conversation_id, channel_id, direction, status, origin, sender_classification, content_kind, body_text, provider, provider_message_id, created_at)
  select c.workspace_id, c.id, c.channel_id, 'inbound', 'delivered', 'inbound', 'external', 'text', 'Mensagem fictícia do cliente', 'ycloud', '$pm', $origin + interval '10 seconds'
  from public.conversations c where c.id = '$conv';
select set_config('praxis.message_origin_writer', 'on', true);
update public.messages set origin_time_at = $origin, origin_time_source = 'provider_send_time' where provider_message_id = '$pm';
commit;
SQL
    count "select id from public.messages where provider_message_id = '$pm'"
  fi
}

echo "== preparo (workspace próprio, caso ganho, conversas, portão aberto só durante o script)"
SLUG="conc-aplicador-$(date +%s%N | cut -c10-17)"
WS="$(run_ana "select (public.create_workspace_with_owner('Concorrência aplicador', '$SLUG')).id;")"
[ -n "$WS" ] || fail "não criou o workspace"
CONTATO="$(run_ana "select (public.create_contact('$WS'::uuid, 'pf', 'Contato concorrência aplicador', null, null, null)).id;")"
LEAD="$(run_ana "select public.create_lead('$WS'::uuid, '$CONTATO'::uuid, 'Imobiliário', null, '{}'::text[], 'media', '$ANA'::uuid);")"
OPP="$(run_ana "select public.create_opportunity('$LEAD'::uuid);")"
CANAL="$(run_db "insert into public.whatsapp_channels (workspace_id, label, display_phone_number, created_by, provider, is_simulator, environment, routing_key)
  values ('$WS', 'Canal concorrência aplicador', '+5541900006290', '$ANA', 'ycloud', false, 'preview', '$SLUG') returning id;")"
CONVS=()
for n in 1 2 3 4 5; do
  IDENT="$(run_db "insert into public.whatsapp_identities (workspace_id, channel_id, provider, environment, phone_e164)
    values ('$WS', '$CANAL', 'ycloud', 'preview', '+554199999629$n') returning id;")"
  CONVS+=("$(run_db "insert into public.conversations (workspace_id, channel_id, identity_id, contact_id, lead_id)
    values ('$WS', '$CANAL', '$IDENT', '$CONTATO', '$LEAD') returning id;")")
done
[ "${#CONVS[@]}" = "5" ] || fail "não criou as conversas"
psql_as srv_main -c "update public.status_track_automation_gate set enabled = true, enabled_at = now(), activation_ref = 'teste-concorrencia-local'" >/dev/null
C1="${CONVS[0]}"

echo "== 1. correção manual segura a trava; o aplicador, ao mesmo tempo, com a versão antiga"
ANTES="$FAILS"
M1="$(msg "$C1" cliente "clock_timestamp() - interval '10 minutes'")"
OUT_A="$(mktemp)"; OUT_B="$(mktemp)"
psql_as srv_humano > "$OUT_A" 2>&1 <<SQL &
$(as_ana)
select public.set_conversation_attendance_status('$C1'::uuid, 'aguardando_cliente', 0, '{}'::uuid[], null) ->> 'version';
select pg_sleep($HOLD);
commit;
SQL
PID_A=$!
wait_sleeping srv_humano
psql_as srv_aplicador > "$OUT_B" 2>&1 <<SQL &
$(as_service)
$(apply_sql "$WS" "$C1" set_status attendance null "'aguardando_escritorio'" 0 "'$M1'" "$(node -e "console.log(crypto.randomUUID())")") ->> 'reason';
commit;
SQL
PID_B=$!
wait_lock_waiters 1 srv_aplicador || bad "o aplicador deveria esperar a trava da trilha"
wait "$PID_A" || bad "a correção manual falhou: $(cat "$OUT_A")"
wait "$PID_B" || bad "o aplicador falhou: $(cat "$OUT_B")"
grep -qx "version_stale" "$OUT_B" || bad "o aplicador deveria ser recusado por version_stale: $(cat "$OUT_B")"
[ "$(count "select attendance_status::text || '|' || version from public.status_tracks where conversation_id = '$C1'")" = "aguardando_cliente|1" ] \
  || bad "a decisão humana deveria ficar (aguardando_cliente, versão 1)"
[ "$(count "select count(*) from public.status_track_events e join public.status_tracks t on t.id = e.track_id where t.conversation_id = '$C1'")" = "1" ] \
  || bad "deveria haver um único evento (o humano)"
[ "$FAILS" -eq "$ANTES" ] && echo "   ok: o aplicador esperou e foi recusado (version_stale); a decisão humana ficou; um evento"

echo "== 2. o aplicador segura a trava; a correção manual, ao mesmo tempo, com a versão antiga"
ANTES="$FAILS"
MARCO="$(count "select manual_decided_at from public.status_tracks where conversation_id = '$C1'")"
M2="$(msg "$C1" cliente "clock_timestamp() + interval '1 minute'")"
OUT_A="$(mktemp)"; OUT_B="$(mktemp)"
psql_as srv_aplicador2 > "$OUT_A" 2>&1 <<SQL &
$(as_service)
$(apply_sql "$WS" "$C1" set_status attendance null "'aguardando_escritorio'" 1 "'$M2'" "$(node -e "console.log(crypto.randomUUID())")") ->> 'outcome';
select pg_sleep($HOLD);
commit;
SQL
PID_A=$!
wait_sleeping srv_aplicador2
psql_as srv_humano2 > "$OUT_B" 2>&1 <<SQL &
$(as_ana)
select public.set_conversation_attendance_status('$C1'::uuid, 'encerrado', 1, '{}'::uuid[], null);
commit;
SQL
PID_B=$!
wait_lock_waiters 1 srv_humano2 || bad "a correção manual deveria esperar a trava da trilha"
wait "$PID_A" || bad "o aplicador falhou: $(cat "$OUT_A")"
rc=0; wait "$PID_B" || rc=$?
grep -qx "applied" "$OUT_A" || bad "o aplicador deveria aplicar: $(cat "$OUT_A")"
[ "$rc" -ne 0 ] && grep -q "track_conflict" "$OUT_B" || bad "a correção manual deveria receber track_conflict: $(cat "$OUT_B")"
[ "$(count "select attendance_status::text || '|' || version from public.status_tracks where conversation_id = '$C1'")" = "aguardando_escritorio|2" ] \
  || bad "deveria estar aguardando_escritorio, versão 2"
[ "$(count "select manual_decided_at from public.status_tracks where conversation_id = '$C1'")" = "$MARCO" ] \
  || bad "o marco humano não pode mudar com a aplicação automática"
[ "$FAILS" -eq "$ANTES" ] && echo "   ok: aplicado; a correção manual esperou e recebeu track_conflict; marco humano intacto"

echo "== 3. mesma proposta, mesma chave, três sessões juntas"
ANTES="$FAILS"
C3="${CONVS[1]}"
M3="$(msg "$C3" cliente "clock_timestamp() - interval '5 minutes'")"
CHAVE="$(node -e "console.log(crypto.randomUUID())")"
open_gate
PIDS=(); OUTS=()
for n in 1 2 3; do
  OUT="$(mktemp)"; OUTS+=("$OUT")
  psql_as "srv_rep_$n" > "$OUT" 2>&1 <<SQL &
select pg_advisory_lock_shared($PORTAO);
$(as_service)
$(apply_sql "$WS" "$C3" set_status attendance null "'aguardando_escritorio'" 0 "'$M3'" "$CHAVE") ->> 'replayed';
commit;
SQL
  PIDS+=($!)
done
release_gate 3 srv_rep_
REPETIDOS=0
for i in 0 1 2; do
  rc=0; wait "${PIDS[$i]}" || rc=$?
  [ "$rc" -eq 0 ] || bad "a repetição $((i + 1)) falhou: $(cat "${OUTS[$i]}")"
  grep -qx "true" "${OUTS[$i]}" && REPETIDOS=$((REPETIDOS + 1))
done
[ "$REPETIDOS" = "2" ] || bad "duas das três deveriam ser repetição, foram $REPETIDOS"
[ "$(count "select count(*) from public.status_track_automation_decisions where idempotency_key = '$CHAVE'")" = "1" ] || bad "uma decisão só"
[ "$(count "select count(*) from public.status_track_events e join public.status_tracks t on t.id = e.track_id where t.conversation_id = '$C3'")" = "1" ] || bad "um evento só"
[ "$(count "select version from public.status_tracks where conversation_id = '$C3'")" = "1" ] || bad "versão 1"
[ "$FAILS" -eq "$ANTES" ] && echo "   ok: uma decisão, um evento, duas repetições sem erro, versão 1"

echo "== 4. mesma chave, pedidos diferentes, juntos"
ANTES="$FAILS"
C4="${CONVS[2]}"
M4A="$(msg "$C4" cliente "clock_timestamp() - interval '5 minutes'")"
M4B="$(msg "$C4" escritorio "clock_timestamp() - interval '4 minutes'")"
CHAVE="$(node -e "console.log(crypto.randomUUID())")"
open_gate
OUT_A="$(mktemp)"; OUT_B="$(mktemp)"
psql_as srv_dif_1 > "$OUT_A" 2>&1 <<SQL &
select pg_advisory_lock_shared($PORTAO);
$(as_service)
$(apply_sql "$WS" "$C4" set_status attendance null "'aguardando_escritorio'" 0 "'$M4A'" "$CHAVE") ->> 'outcome';
commit;
SQL
PID_A=$!
psql_as srv_dif_2 > "$OUT_B" 2>&1 <<SQL &
select pg_advisory_lock_shared($PORTAO);
$(as_service)
$(apply_sql "$WS" "$C4" set_status attendance null "'aguardando_cliente'" 0 "'$M4B'" "$CHAVE") ->> 'outcome';
commit;
SQL
PID_B=$!
release_gate 2 srv_dif_
RA=0; RB=0; wait "$PID_A" || RA=$?; wait "$PID_B" || RB=$?
OKS=0; CONFLITOS=0
for pair in "$RA:$OUT_A" "$RB:$OUT_B"; do
  rc="${pair%%:*}"; out="${pair#*:}"
  if [ "$rc" -eq 0 ] && grep -qx "applied" "$out"; then OKS=$((OKS + 1));
  elif [ "$rc" -ne 0 ] && grep -q "idempotency_conflict" "$out"; then CONFLITOS=$((CONFLITOS + 1));
  else bad "resultado inesperado: $(cat "$out")"; fi
done
[ "$OKS" = "1" ] && [ "$CONFLITOS" = "1" ] || bad "esperado 1 aplicado e 1 conflito, houve $OKS e $CONFLITOS"
[ "$(count "select count(*) from public.status_track_automation_decisions where idempotency_key = '$CHAVE'")" = "1" ] || bad "uma decisão só"
[ "$(count "select version from public.status_tracks where conversation_id = '$C4'")" = "1" ] || bad "versão 1"
[ "$FAILS" -eq "$ANTES" ] && echo "   ok: um aplicado, um idempotency_conflict, uma decisão"

echo "== 5. mesma chave entre o aplicador e a correção manual (alvos diferentes, nas duas ordens)"
ANTES="$FAILS"
C5="${CONVS[3]}"; C6="${CONVS[4]}"
M5="$(msg "$C5" cliente "clock_timestamp() - interval '5 minutes'")"
for ordem in aplicador_primeiro humano_primeiro; do
  CHAVE="$(node -e "console.log(crypto.randomUUID())")"
  OUT_A="$(mktemp)"; OUT_B="$(mktemp)"
  V5="$(count "select coalesce((select version from public.status_tracks where conversation_id = '$C5'), 0)")"
  V6="$(count "select coalesce((select version from public.status_tracks where conversation_id = '$C6'), 0)")"
  if [ "$ordem" = "aplicador_primeiro" ]; then
    ST5="'aguardando_escritorio'"
    psql_as srv_k_a > "$OUT_A" 2>&1 <<SQL &
$(as_service)
$(apply_sql "$WS" "$C5" set_status attendance null "$ST5" "$V5" "'$M5'" "$CHAVE") ->> 'outcome';
select pg_sleep($HOLD);
commit;
SQL
    PID_A=$!
    wait_sleeping srv_k_a
    psql_as srv_k_b > "$OUT_B" 2>&1 <<SQL &
$(as_ana)
select public.set_conversation_attendance_status('$C6'::uuid, 'aguardando_cliente', $V6, '{}'::uuid[], '$CHAVE'::uuid);
commit;
SQL
    PID_B=$!
    wait_lock_waiters 1 srv_k_b || bad "($ordem) a correção manual deveria esperar o registro da chave"
  else
    psql_as srv_k_a > "$OUT_A" 2>&1 <<SQL &
$(as_ana)
select public.set_conversation_attendance_status('$C6'::uuid, 'encerrado', $V6, '{}'::uuid[], '$CHAVE'::uuid) ->> 'version';
select pg_sleep($HOLD);
commit;
SQL
    PID_A=$!
    wait_sleeping srv_k_a
    M5B="$(msg "$C5" escritorio "clock_timestamp() - interval '1 minute'")"
    psql_as srv_k_b > "$OUT_B" 2>&1 <<SQL &
$(as_service)
$(apply_sql "$WS" "$C5" set_status attendance null "'aguardando_cliente'" "$V5" "'$M5B'" "$CHAVE");
commit;
SQL
    PID_B=$!
    wait_lock_waiters 1 srv_k_b || bad "($ordem) o aplicador deveria esperar o registro da chave"
  fi
  wait "$PID_A" || bad "($ordem) a primeira gravação falhou: $(cat "$OUT_A")"
  rc=0; wait "$PID_B" || rc=$?
  [ "$rc" -ne 0 ] && grep -q "idempotency_conflict" "$OUT_B" || bad "($ordem) a segunda deveria receber idempotency_conflict: $(cat "$OUT_B")"
  [ "$(count "select count(*) from public.status_track_idempotency_keys where idempotency_key = '$CHAVE'")" = "1" ] || bad "($ordem) a chave deveria ter uma única gravação"
done
[ "$FAILS" -eq "$ANTES" ] && echo "   ok: nas duas ordens, a segunda esperou e recebeu idempotency_conflict; uma gravação por chave"

echo "== 6. recusa antes da trava (etapa comercial), mesma chave, três sessões juntas"
ANTES="$FAILS"
CHAVE="$(node -e "console.log(crypto.randomUUID())")"
open_gate
PIDS=(); OUTS=()
for n in 1 2 3; do
  OUT="$(mktemp)"; OUTS+=("$OUT")
  psql_as "srv_rec_$n" > "$OUT" 2>&1 <<SQL &
select pg_advisory_lock_shared($PORTAO);
$(as_service)
$(apply_sql "$WS" "$C3" commercial_stage commercial_stage "'$OPP'::uuid" null 0 "'$M3'" "$CHAVE") ->> 'replayed';
commit;
SQL
  PIDS+=($!)
done
release_gate 3 srv_rec_
REPETIDOS=0
for i in 0 1 2; do
  rc=0; wait "${PIDS[$i]}" || rc=$?
  [ "$rc" -eq 0 ] || bad "a sessão $((i + 1)) falhou: $(cat "${OUTS[$i]}")"
  grep -qx "true" "${OUTS[$i]}" && REPETIDOS=$((REPETIDOS + 1))
done
[ "$REPETIDOS" = "2" ] || bad "duas das três deveriam ser repetição, foram $REPETIDOS"
[ "$(count "select count(*) || '|' || min(reason) from public.status_track_automation_decisions where idempotency_key = '$CHAVE'")" = "1|commercial_manual_only" ] \
  || bad "uma decisão só, recusada como commercial_manual_only"
[ "$FAILS" -eq "$ANTES" ] && echo "   ok: uma recusa gravada, duas repetições"

close_automation
[ "$(count "select enabled::text from public.status_track_automation_gate")" = "false" ] || bad "o portão deveria voltar a fechar"

if [ "$FAILS" -ne 0 ]; then
  echo "FALHOU: $FAILS verificação(ões)" >&2
  exit 1
fi
echo "OK: o aplicador disputa a trilha com a correção manual sem sobrescrever em silêncio, e a chave nunca duplica nem muda de significado."
