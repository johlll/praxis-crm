#!/usr/bin/env bash
# Painel do caso, etapa B — número interno e roteiro do serviço sob concorrência REAL (sessões Postgres
# simultâneas). O pgTAP 59 prova as regras numa sessão só; aqui se prova que pedidos AO MESMO TEMPO não
# duplicam número nem conclusão e não copiam um modelo pela metade:
#
#   1. Números: seis sessões pedem número para seis casos diferentes e duas pedem para o MESMO caso, todas
#      soltas juntas. Sete números distintos, de 1 a 7, sem buraco; o caso repetido recebe um só.
#   2. Mesma conclusão: três sessões concluem a MESMA etapa com a MESMA versão (chaves diferentes). Uma
#      conclui; as outras recebem track_conflict; um único evento de conclusão.
#   3. Mesma chave: três sessões repetem o MESMO pedido com a MESMA chave ao mesmo tempo. Um evento só;
#      todas terminam sem erro (as outras como repetição).
#   4. Modelo editado durante a aplicação: A edita o tipo e segura a transação; B aplica o tipo ao mesmo
#      tempo, espera e copia a versão NOVA inteira (nunca metade de cada).
#
# Workspace próprio (criado aqui), usuária fictícia do seed, Postgres local do CI. Nada hospedado.
set -euo pipefail

DB_CONTAINER="supabase_db_praxis-crm"
ANA="20000000-0000-0000-0000-000000000001"
HOLD=3
PORTAO=5905901
FAILS=0

psql_as() { # $1 = application_name; resto = argumentos do psql
  local app="$1"; shift
  docker exec -i -e PGAPPNAME="$app" "$DB_CONTAINER" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -qAt "$@"
}

fail() { echo "FALHOU: $*" >&2; exit 1; }
bad() { echo "   FALHOU: $*" >&2; FAILS=$((FAILS + 1)); }

wait_sleeping() { # espera a sessão $1 entrar no pg_sleep (transação aberta)
  for _ in $(seq 1 100); do
    if [ "$(psql_as srv_main -c "select count(*) from pg_stat_activity where application_name = '$1' and query like '%pg_sleep%' and state = 'active'")" = "1" ]; then
      return 0
    fi
    sleep 0.1
  done
  fail "a sessão $1 não chegou ao pg_sleep"
}

wait_lock_waiters() { # espera $1 sessões com application_name iniciado em $2 paradas numa trava
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

run_ana() { { as_ana; echo "$1"; echo "commit;"; } | psql_as srv_setup | tail -1; }
count() { psql_as srv_main -c "$1"; }

# Portão: N sessões esperam um advisory lock compartilhado e são soltas juntas.
open_gate() {
  psql_as srv_porteiro >/dev/null 2>&1 <<SQL &
select pg_advisory_lock($PORTAO);
select pg_sleep(60);
SQL
  PID_G=$!
  wait_sleeping srv_porteiro
}
release_gate() { # $1 = quantas sessões, $2 = prefixo
  wait_lock_waiters "$1" "$2" || fail "as sessões $2 não chegaram ao portão"
  psql_as srv_main -c "select pg_cancel_backend(pid) from pg_stat_activity where application_name = 'srv_porteiro'" >/dev/null
  wait "$PID_G" || true
}

echo "== preparo (workspace próprio, contato, lead, oito casos)"
SLUG="conc-servico-$(date +%s%N | cut -c10-17)"
WS="$(run_ana "select (public.create_workspace_with_owner('Concorrência serviço', '$SLUG')).id;")"
[ -n "$WS" ] || fail "não criou o workspace"
CONTATO="$(run_ana "select (public.create_contact('$WS'::uuid, 'pf', 'Contato concorrência serviço', null, null, null)).id;")"
LEAD="$(run_ana "select public.create_lead('$WS'::uuid, '$CONTATO'::uuid, 'Imobiliário', null, '{}'::text[], 'media', '$ANA'::uuid);")"
OPPS=()
for _ in 1 2 3 4 5 6 7 8; do
  OPPS+=("$(run_ana "select public.create_opportunity('$LEAD'::uuid);")")
done
[ "${#OPPS[@]}" = "8" ] || fail "não criou os casos"

echo "== 1. números: 6 casos diferentes + 2 pedidos para o mesmo caso, ao mesmo tempo"
open_gate
PIDS=(); OUTS=()
for i in 0 1 2 3 4 5 5; do
  OUT="$(mktemp)"; OUTS+=("$OUT")
  psql_as "srv_num_${#PIDS[@]}" > "$OUT" 2>&1 <<SQL &
select pg_advisory_lock_shared($PORTAO);
$(as_ana)
select public.assign_opportunity_case_number('${OPPS[$i]}'::uuid);
commit;
SQL
  PIDS+=($!)
done
OUT="$(mktemp)"; OUTS+=("$OUT")
psql_as "srv_num_7" > "$OUT" 2>&1 <<SQL &
select pg_advisory_lock_shared($PORTAO);
$(as_ana)
select public.assign_opportunity_case_number('${OPPS[6]}'::uuid);
commit;
SQL
PIDS+=($!)
release_gate 8 srv_num_
for i in "${!PIDS[@]}"; do
  rc=0; wait "${PIDS[$i]}" || rc=$?
  [ "$rc" -eq 0 ] || bad "o pedido de número $i falhou: $(cat "${OUTS[$i]}")"
done
[ "$(count "select count(*) from public.opportunity_case_numbers where workspace_id = '$WS'")" = "7" ] || bad "deveria haver 7 números"
[ "$(count "select string_agg(number::text, ',' order by number) from public.opportunity_case_numbers where workspace_id = '$WS'")" = "1,2,3,4,5,6,7" ] \
  || bad "números deveriam ser 1..7 sem buraco: $(count "select string_agg(number::text, ',' order by number) from public.opportunity_case_numbers where workspace_id = '$WS'")"
[ "$(count "select last_value from public.case_number_counters where workspace_id = '$WS'")" = "7" ] || bad "o contador deveria estar em 7"
[ "$FAILS" -eq 0 ] && echo "   ok: 7 números distintos (1..7), o caso repetido com um só, contador em 7"

echo "== preparo do roteiro (caso ganho, tipo com 3 etapas)"
OPP="${OPPS[7]}"
run_ana "select public.win_opportunity('$OPP'::uuid, 0, 100000, 'fixed');" >/dev/null
TIPO="$(run_ana "select public.create_service_type('$WS'::uuid, 'Tipo concorrência', array['Um', 'Dois', 'Três']) ->> 'id';")"
run_ana "select public.apply_case_service_plan('$OPP'::uuid, '$TIPO'::uuid, 0, 1);" >/dev/null
ETAPA1="$(count "select s.id from public.case_service_plan_steps s join public.case_service_plans p on p.id = s.plan_id where p.opportunity_id = '$OPP' and p.status = 'active' and s.position = 1")"
ETAPA2="$(count "select s.id from public.case_service_plan_steps s join public.case_service_plans p on p.id = s.plan_id where p.opportunity_id = '$OPP' and p.status = 'active' and s.position = 2")"
[ -n "$ETAPA1" ] && [ -n "$ETAPA2" ] || fail "o roteiro não foi aplicado"

echo "== 2. três sessões concluem a mesma etapa com a mesma versão"
ANTES="$FAILS"
open_gate
PIDS=(); OUTS=()
for n in 1 2 3; do
  OUT="$(mktemp)"; OUTS+=("$OUT")
  psql_as "srv_conc_$n" > "$OUT" 2>&1 <<SQL &
select pg_advisory_lock_shared($PORTAO);
$(as_ana)
select public.complete_case_service_step('$OPP'::uuid, '$ETAPA1'::uuid, 1, '$ETAPA2'::uuid, gen_random_uuid());
commit;
SQL
  PIDS+=($!)
done
release_gate 3 srv_conc_
OKS=0; CONFLITOS=0
for i in 0 1 2; do
  rc=0; wait "${PIDS[$i]}" || rc=$?
  if [ "$rc" -eq 0 ]; then OKS=$((OKS + 1));
  elif grep -q "track_conflict" "${OUTS[$i]}"; then CONFLITOS=$((CONFLITOS + 1));
  else bad "erro inesperado: $(cat "${OUTS[$i]}")"; fi
done
[ "$OKS" = "1" ] && [ "$CONFLITOS" = "2" ] || bad "esperado 1 conclusão e 2 conflitos, houve $OKS e $CONFLITOS"
[ "$(count "select count(*) from public.case_service_events where opportunity_id = '$OPP' and op = 'step_completed'")" = "1" ] || bad "deveria haver um único evento de conclusão"
[ "$(count "select version from public.status_tracks where opportunity_id = '$OPP' and track = 'case_progress'")" = "2" ] || bad "a versão deveria ser 2"
[ "$FAILS" -eq "$ANTES" ] && echo "   ok: uma conclusão, dois track_conflict, um evento, versão 2"

echo "== 3. três repetições simultâneas do mesmo pedido com a mesma chave"
ANTES="$FAILS"
CHAVE="c0000000-0000-4000-8000-$(date +%s%N | cut -c7-18)"
open_gate
PIDS=(); OUTS=()
for n in 1 2 3; do
  OUT="$(mktemp)"; OUTS+=("$OUT")
  psql_as "srv_chave_$n" > "$OUT" 2>&1 <<SQL &
select pg_advisory_lock_shared($PORTAO);
$(as_ana)
select public.complete_case_service_step('$OPP'::uuid, '$ETAPA2'::uuid, 2, null, '$CHAVE'::uuid) ->> 'replayed';
commit;
SQL
  PIDS+=($!)
done
release_gate 3 srv_chave_
REPETIDOS=0
for i in 0 1 2; do
  rc=0; wait "${PIDS[$i]}" || rc=$?
  [ "$rc" -eq 0 ] || bad "a repetição $((i + 1)) falhou: $(cat "${OUTS[$i]}")"
  grep -qx "true" "${OUTS[$i]}" && REPETIDOS=$((REPETIDOS + 1))
done
[ "$REPETIDOS" = "2" ] || bad "duas das três deveriam ser repetição, foram $REPETIDOS"
[ "$(count "select count(*) from public.case_service_events where idempotency_key = '$CHAVE'")" = "1" ] || bad "a chave deveria ter um único evento"
[ "$(count "select version from public.status_tracks where opportunity_id = '$OPP' and track = 'case_progress'")" = "3" ] || bad "a versão deveria ser 3"
[ "$FAILS" -eq "$ANTES" ] && echo "   ok: um evento, duas repetições sem erro, versão 3"

echo "== 4. modelo editado enquanto outro caso aplica o mesmo tipo"
ANTES="$FAILS"
OPP2="$(run_ana "select public.create_opportunity('$LEAD'::uuid);")"
run_ana "select public.win_opportunity('$OPP2'::uuid, 0, 100000, 'fixed');" >/dev/null
OUT_A="$(mktemp)"
psql_as srv_edita > "$OUT_A" 2>&1 <<SQL &
$(as_ana)
select public.update_service_type('$TIPO'::uuid, 'Tipo concorrência', array['Novo um', 'Novo dois', 'Novo três', 'Novo quatro'], 1);
select pg_sleep($HOLD);
commit;
SQL
PID_A=$!
wait_sleeping srv_edita
B_OUT="$(run_ana "select public.apply_case_service_plan('$OPP2'::uuid, '$TIPO'::uuid, 0) -> 'plan' ->> 'service_type_version';" 2>&1)"
A_RC=0; wait "$PID_A" || A_RC=$?
[ "$A_RC" -eq 0 ] || bad "a edição falhou: $(cat "$OUT_A")"
[ "$B_OUT" = "2" ] || bad "a aplicação deveria copiar a versão 2 (a nova), copiou: $B_OUT"
[ "$(count "select string_agg(s.name, '|' order by s.position) from public.case_service_plan_steps s join public.case_service_plans p on p.id = s.plan_id where p.opportunity_id = '$OPP2' and p.status = 'active'")" = "Novo um|Novo dois|Novo três|Novo quatro" ] \
  || bad "as etapas copiadas deveriam ser exatamente as da versão nova"
[ "$(count "select string_agg(s.name, '|' order by s.position) from public.case_service_plan_steps s join public.case_service_plans p on p.id = s.plan_id where p.opportunity_id = '$OPP' and p.status = 'active'")" = "Um|Dois|Três" ] \
  || bad "o caso que já usava o tipo não pode mudar"
[ "$FAILS" -eq "$ANTES" ] && echo "   ok: a aplicação esperou a edição e copiou a versão nova inteira; o caso anterior não mudou"

if [ "$FAILS" -gt 0 ]; then
  fail "$FAILS verificação(ões) falharam — número ou roteiro inconsistente sob concorrência"
fi
echo "== número interno e roteiro do serviço sob concorrência real: OK"
