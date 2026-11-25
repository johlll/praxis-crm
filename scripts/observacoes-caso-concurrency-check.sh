#!/usr/bin/env bash
# Observações por caso sob concorrência REAL (sessões Postgres simultâneas). O pgTAP 60 prova as regras numa
# sessão só; aqui se prova que pedidos AO MESMO TEMPO preservam todos os registros e não duplicam nenhum:
#
#   1. Duas pessoas (dona e advogada), seis sessões, todas soltas juntas no MESMO caso, chaves diferentes: seis
#      observações gravadas, cada texto uma vez, cada uma com o seu autor.
#   2. Mesma chave, mesmo pedido, três sessões juntas (clique duplo / resposta perdida): um registro só; as
#      outras duas terminam sem erro, como repetição.
#   3. Mesma chave, textos diferentes, duas sessões juntas: um registro; a outra recebe idempotency_conflict.
#   4. Uma sessão segura a trava do andamento do caso (correção em transação aberta); acrescentar uma observação
#      NÃO espera essa trava e não muda versão, andamento nem roteiro.
#
# Workspace próprio (criado aqui), usuárias fictícias do seed, Postgres local do CI. Nada hospedado.
set -euo pipefail

DB_CONTAINER="supabase_db_praxis-crm"
ANA="20000000-0000-0000-0000-000000000001"
CARLA="20000000-0000-0000-0000-000000000003"
HOLD=3
PORTAO=6006001
FAILS=0

psql_as() { # $1 = application_name; resto = argumentos do psql
  local app="$1"; shift
  docker exec -i -e PGAPPNAME="$app" "$DB_CONTAINER" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -qAt "$@"
}

fail() { echo "FALHOU: $*" >&2; exit 1; }
bad() { echo "   FALHOU: $*" >&2; FAILS=$((FAILS + 1)); }

wait_sleeping() {
  for _ in $(seq 1 100); do
    if [ "$(psql_as obs_main -c "select count(*) from pg_stat_activity where application_name = '$1' and query like '%pg_sleep%' and state = 'active'")" = "1" ]; then
      return 0
    fi
    sleep 0.1
  done
  fail "a sessão $1 não chegou ao pg_sleep"
}

wait_lock_waiters() {
  for _ in $(seq 1 100); do
    if [ "$(psql_as obs_main -c "select count(*) from pg_stat_activity where application_name like '$2%' and wait_event_type = 'Lock'")" = "$1" ]; then
      return 0
    fi
    sleep 0.1
  done
  return 1
}

as_user() { # $1 = usuária
  printf '%s\n' "begin;" "set local role authenticated;" \
    "select set_config('request.jwt.claims', json_build_object('sub', '$1', 'role', 'authenticated')::text, true);"
}

run_as() { { as_user "$1"; echo "$2"; echo "commit;"; } | psql_as obs_setup | tail -1; }
count() { psql_as obs_main -c "$1"; }

open_gate() {
  psql_as obs_porteiro >/dev/null 2>&1 <<SQL &
select pg_advisory_lock($PORTAO);
select pg_sleep(60);
SQL
  PID_G=$!
  wait_sleeping obs_porteiro
}
release_gate() {
  wait_lock_waiters "$1" "$2" || fail "as sessões $2 não chegaram ao portão"
  psql_as obs_main -c "select pg_cancel_backend(pid) from pg_stat_activity where application_name = 'obs_porteiro'" >/dev/null
  wait "$PID_G" || true
}

echo "== preparo (workspace próprio, advogada como integrante, contato, lead sem responsável, caso ganho)"
SLUG="conc-obs-$(date +%s%N | cut -c10-17)"
WS="$(run_as "$ANA" "select (public.create_workspace_with_owner('Concorrência observações', '$SLUG')).id;")"
[ -n "$WS" ] || fail "não criou o workspace"
psql_as obs_setup -c "insert into public.memberships (workspace_id, user_id, role, status) values ('$WS', '$CARLA', 'lawyer', 'active');" >/dev/null
CONTATO="$(run_as "$ANA" "select (public.create_contact('$WS'::uuid, 'pf', 'Contato concorrência observações', null, null, null)).id;")"
LEAD="$(run_as "$ANA" "select public.create_lead('$WS'::uuid, '$CONTATO'::uuid, 'Imobiliário', null, '{}'::text[], 'media', null);")"
OPP="$(run_as "$ANA" "select public.create_opportunity('$LEAD'::uuid);")"
run_as "$ANA" "select public.win_opportunity('$OPP'::uuid, 0, 100000, 'fixed');" >/dev/null
[ -n "$OPP" ] || fail "não criou o caso"
trilha() { count "select coalesce((select version || ':' || case_progress_status from public.status_tracks where opportunity_id = '$OPP' and track = 'case_progress'), 'sem')"; }
TRILHA0="$(trilha)"

echo "== 1. duas pessoas, seis sessões, o mesmo caso, ao mesmo tempo"
open_gate
PIDS=(); OUTS=()
for i in 1 2 3 4 5 6; do
  OUT="$(mktemp)"; OUTS+=("$OUT")
  if [ $((i % 2)) -eq 0 ]; then WHO="$CARLA"; else WHO="$ANA"; fi
  psql_as "obs_n_$i" > "$OUT" 2>&1 <<SQL &
select pg_advisory_lock_shared($PORTAO);
$(as_user "$WHO")
select public.add_case_note('$OPP'::uuid, 'Observação simultânea $i', gen_random_uuid()) ->> 'replayed';
commit;
SQL
  PIDS+=($!)
done
release_gate 6 obs_n_
for i in "${!PIDS[@]}"; do
  rc=0; wait "${PIDS[$i]}" || rc=$?
  [ "$rc" -eq 0 ] || bad "a sessão $((i + 1)) falhou: $(cat "${OUTS[$i]}")"
done
[ "$(count "select count(*) from public.case_notes where opportunity_id = '$OPP' and body like 'Observação simultânea %'")" = "6" ] || bad "deveria haver 6 observações"
[ "$(count "select count(distinct body) from public.case_notes where opportunity_id = '$OPP'")" = "6" ] || bad "cada texto deveria aparecer uma vez"
[ "$(count "select count(*) from public.case_notes where opportunity_id = '$OPP' and created_by = '$CARLA'")" = "3" ] || bad "a advogada deveria ser autora de 3"
[ "$FAILS" -eq 0 ] && echo "   ok: 6 observações preservadas, cada texto uma vez, cada uma com o seu autor"

echo "== 2. mesma chave, mesmo pedido, três sessões juntas"
ANTES="$FAILS"
CHAVE="d0000000-0000-4000-8000-$(date +%s%N | cut -c7-18)"
open_gate
PIDS=(); OUTS=()
for n in 1 2 3; do
  OUT="$(mktemp)"; OUTS+=("$OUT")
  psql_as "obs_k_$n" > "$OUT" 2>&1 <<SQL &
select pg_advisory_lock_shared($PORTAO);
$(as_user "$ANA")
select public.add_case_note('$OPP'::uuid, 'Pedido repetido', '$CHAVE'::uuid) ->> 'replayed';
commit;
SQL
  PIDS+=($!)
done
release_gate 3 obs_k_
REPETIDOS=0
for i in 0 1 2; do
  rc=0; wait "${PIDS[$i]}" || rc=$?
  [ "$rc" -eq 0 ] || bad "a repetição $((i + 1)) falhou: $(cat "${OUTS[$i]}")"
  grep -qx "true" "${OUTS[$i]}" && REPETIDOS=$((REPETIDOS + 1))
done
[ "$REPETIDOS" = "2" ] || bad "duas das três deveriam ser repetição, foram $REPETIDOS"
[ "$(count "select count(*) from public.case_notes where idempotency_key = '$CHAVE'")" = "1" ] || bad "a chave deveria ter um único registro"
[ "$(count "select count(*) from public.audit_logs where action = 'opportunity.case_note_added' and metadata ->> 'note_id' = (select id::text from public.case_notes where idempotency_key = '$CHAVE')")" = "1" ] \
  || bad "deveria haver uma auditoria só"
[ "$FAILS" -eq "$ANTES" ] && echo "   ok: um registro, duas repetições sem erro, uma auditoria"

echo "== 3. mesma chave, textos diferentes, duas sessões juntas"
ANTES="$FAILS"
CHAVE2="d1000000-0000-4000-8000-$(date +%s%N | cut -c7-18)"
open_gate
PIDS=(); OUTS=()
for n in 1 2; do
  OUT="$(mktemp)"; OUTS+=("$OUT")
  psql_as "obs_c_$n" > "$OUT" 2>&1 <<SQL &
select pg_advisory_lock_shared($PORTAO);
$(as_user "$ANA")
select public.add_case_note('$OPP'::uuid, 'Texto $n', '$CHAVE2'::uuid) ->> 'replayed';
commit;
SQL
  PIDS+=($!)
done
release_gate 2 obs_c_
OKS=0; CONFLITOS=0
for i in 0 1; do
  rc=0; wait "${PIDS[$i]}" || rc=$?
  if [ "$rc" -eq 0 ]; then OKS=$((OKS + 1));
  elif grep -q "idempotency_conflict" "${OUTS[$i]}"; then CONFLITOS=$((CONFLITOS + 1));
  else bad "erro inesperado: $(cat "${OUTS[$i]}")"; fi
done
[ "$OKS" = "1" ] && [ "$CONFLITOS" = "1" ] || bad "esperado 1 gravação e 1 conflito, houve $OKS e $CONFLITOS"
[ "$(count "select count(*) from public.case_notes where idempotency_key = '$CHAVE2'")" = "1" ] || bad "a chave deveria ter um único registro"
[ "$FAILS" -eq "$ANTES" ] && echo "   ok: um registro, um idempotency_conflict"

echo "== 4. a trava do andamento está segura por outra sessão; a observação não espera e não muda nada da trilha"
ANTES="$FAILS"
V="$(count "select coalesce((select version from public.status_tracks where opportunity_id = '$OPP' and track = 'case_progress'), 0)")"
OUT_A="$(mktemp)"
psql_as obs_trava > "$OUT_A" 2>&1 <<SQL &
$(as_user "$ANA")
select public.set_opportunity_case_progress('$OPP'::uuid, 'em_analise', $V);
select pg_sleep($HOLD);
rollback;
SQL
PID_A=$!
wait_sleeping obs_trava
T0=$(date +%s%N)
run_as "$CARLA" "select public.add_case_note('$OPP'::uuid, 'Observação durante a trava', gen_random_uuid()) ->> 'replayed';" >/dev/null || bad "a observação falhou durante a trava"
T1=$(date +%s%N)
[ "$(count "select count(*) from pg_stat_activity where application_name = 'obs_trava' and query like '%pg_sleep%' and state = 'active'")" = "1" ] \
  || bad "a observação deveria terminar antes da sessão que segura a trava"
wait "$PID_A" || true
[ $(( (T1 - T0) / 1000000 )) -lt $((HOLD * 1000)) ] || bad "a observação esperou a trava do andamento"
[ "$(trilha)" = "$TRILHA0" ] || bad "versão ou andamento mudaram: $(trilha) (antes $TRILHA0)"
[ "$(count "select count(*) from public.case_service_events where opportunity_id = '$OPP'")" = "0" ] || bad "nada no roteiro"
[ "$FAILS" -eq "$ANTES" ] && echo "   ok: observação gravada sem esperar a trava; versão, andamento e roteiro iguais"

if [ "$FAILS" -gt 0 ]; then
  fail "$FAILS verificação(ões) falharam — observações inconsistentes sob concorrência"
fi
echo "== observações por caso sob concorrência real: OK"
