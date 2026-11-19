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
#   5. Mesma chave entre os históricos (registro único status_track_idempotency_keys): A grava com a chave K e
#      segura a transação; B usa K em OUTRO caso do mesmo escritório — roteiro × correção do andamento e roteiro ×
#      situação do atendimento, nas duas ordens. B espera A e recebe idempotency_conflict, sem subir versão; um
#      único evento com K somando os dois históricos.
#   6. A desiste (rollback): B, que esperava, grava com a chave agora livre.
#   7. Mesma chave em escritórios diferentes: independentes, sem espera.
#   8. Repetição exata depois de resposta perdida, ao mesmo tempo que um pedido diferente com a mesma chave: a
#      repetição devolve o gravado (sem evento nem versão); o pedido diferente recebe idempotency_conflict.
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

echo "== preparo da chave compartilhada (casos ganhos com e sem roteiro, uma conversa, um segundo escritório)"
won_with_plan() {
  local o
  o="$(run_ana "select public.create_opportunity('$LEAD'::uuid);")"
  run_ana "select public.win_opportunity('$o'::uuid, 0, 100000, 'fixed');" >/dev/null
  run_ana "select public.apply_case_service_plan('$o'::uuid, '$TIPO'::uuid, 0, 1);" >/dev/null
  echo "$o"
}
won_plain() {
  local o
  o="$(run_ana "select public.create_opportunity('${1:-$LEAD}'::uuid);")"
  run_ana "select public.win_opportunity('$o'::uuid, 0, 100000, 'fixed');" >/dev/null
  echo "$o"
}
etapa() { count "select s.id from public.case_service_plan_steps s join public.case_service_plans p on p.id = s.plan_id where p.opportunity_id = '$1' and p.status = 'active' and s.position = $2"; }
# Operações (cada uma numa transação da Ana): roteiro (concluir a etapa 1 indo para a 2), correção do
# andamento e correção da situação do atendimento. Versões lidas na própria transação.
op_roteiro() { echo "select public.complete_case_service_step('$1'::uuid, '$(etapa "$1" 1)'::uuid, 1, '$(etapa "$1" 2)'::uuid, '$2'::uuid) ->> 'replayed';"; }
op_andamento() { echo "select public.set_opportunity_case_progress('$1'::uuid, '${3:-em_analise}', (public.get_status_track('case_progress', '$1'::uuid) ->> 'version')::bigint, '{}'::uuid[], '$2'::uuid) ->> 'replayed';"; }
op_atendimento() { echo "select public.set_conversation_attendance_status('$1'::uuid, '$3', (public.get_status_track('attendance', '$1'::uuid) ->> 'version')::bigint, '{}'::uuid[], '$2'::uuid) ->> 'replayed';"; }
nova_chave() { echo "c1000000-0000-4000-8000-$(date +%s%N | cut -c7-18)"; }
eventos_da_chave() { # $1 = chave, $2 = workspace
  count "select (select count(*) from public.status_track_events where idempotency_key = '$1' and workspace_id = '$2')
              + (select count(*) from public.case_service_events where idempotency_key = '$1' and workspace_id = '$2')"
}

CANAL="$(psql_as srv_setup -c "insert into public.whatsapp_channels (workspace_id, label, display_phone_number, created_by, provider, is_simulator, environment, routing_key)
  values ('$WS', 'Canal concorrência', '+5541900005990', '$ANA', 'ycloud', false, 'preview', 'rota-conc-$SLUG') returning id;" | head -1)"
IDENT="$(psql_as srv_setup -c "insert into public.whatsapp_identities (workspace_id, channel_id, provider, environment, phone_e164)
  values ('$WS', '$CANAL', 'ycloud', 'preview', '+5541999995990') returning id;" | head -1)"
CONV="$(psql_as srv_setup -c "insert into public.conversations (workspace_id, channel_id, identity_id, contact_id, lead_id)
  values ('$WS', '$CANAL', '$IDENT', '$CONTATO', '$LEAD') returning id;" | head -1)"
[ -n "$CONV" ] || fail "não criou a conversa"
SLUG2="conc-servico-b-$(date +%s%N | cut -c10-17)"
WS2="$(run_ana "select (public.create_workspace_with_owner('Concorrência serviço B', '$SLUG2')).id;")"
CONTATO2="$(run_ana "select (public.create_contact('$WS2'::uuid, 'pf', 'Contato concorrência B', null, null, null)).id;")"
LEAD2="$(run_ana "select public.create_lead('$WS2'::uuid, '$CONTATO2'::uuid, 'Cível', null, '{}'::text[], 'media', '$ANA'::uuid);")"

# A faz a operação $2 com a chave e segura a transação aberta ($4 = commit|rollback); B faz a operação $3
# com a MESMA chave. $5 = espera|livre (B deve parar esperando A, ou terminar sem esperar);
# $6 = conflito|ok (resultado esperado de B); $7 = workspace onde contar; $8 = eventos esperados com a chave.
cruzado() {
  local nome="$1" sql_a="$2" sql_b="$3" fim_a="$4" espera="$5" esperado="$6" ws="$7" total="$8" chave="$9"
  local antes="$FAILS" out_a out_b pid_a pid_b rc_a=0 rc_b=0
  out_a="$(mktemp)"; out_b="$(mktemp)"
  psql_as srv_k_a > "$out_a" 2>&1 <<SQL &
$(as_ana)
$sql_a
select pg_sleep($HOLD);
$fim_a;
SQL
  pid_a=$!
  wait_sleeping srv_k_a
  psql_as srv_k_b > "$out_b" 2>&1 <<SQL &
$(as_ana)
$sql_b
commit;
SQL
  pid_b=$!
  if [ "$espera" = "espera" ]; then
    wait_lock_waiters 1 srv_k_b || bad "$nome: B deveria esperar a transação de A (a chave ainda não confirmada)"
  else
    wait "$pid_b" || rc_b=$?
    [ "$(count "select count(*) from pg_stat_activity where application_name = 'srv_k_a' and query like '%pg_sleep%' and state = 'active'")" = "1" ] \
      || bad "$nome: B deveria terminar sem esperar A"
  fi
  wait "$pid_a" || rc_a=$?
  [ "$espera" = "espera" ] && { wait "$pid_b" || rc_b=$?; }
  [ "$rc_a" -eq 0 ] || bad "$nome: A falhou: $(cat "$out_a")"
  if [ "$esperado" = "conflito" ]; then
    { [ "$rc_b" -ne 0 ] && grep -q "idempotency_conflict" "$out_b"; } || bad "$nome: B deveria receber idempotency_conflict, recebeu (rc=$rc_b): $(tr '\n' ' ' < "$out_b")"
  else
    [ "$rc_b" -eq 0 ] || bad "$nome: B deveria gravar, falhou: $(cat "$out_b")"
  fi
  local n; n="$(eventos_da_chave "$chave" "$ws")"
  [ "$n" = "$total" ] || bad "$nome: deveria haver $total evento(s) com a chave no escritório, há $n"
  [ "$FAILS" -eq "$antes" ] && echo "   ok: $nome"
  return 0
}

echo "== 5. mesma chave entre os históricos, ao mesmo tempo, em casos diferentes do mesmo escritório"
R1="$(won_with_plan)"; P1="$(won_plain)"; K="$(nova_chave)"
VP1="$(count "select version from public.status_tracks where opportunity_id = '$P1' and track = 'case_progress'")"
cruzado "roteiro segura a chave; correção do andamento em outro caso espera e recebe conflito" \
  "$(op_roteiro "$R1" "$K")" "$(op_andamento "$P1" "$K")" commit espera conflito "$WS" 1 "$K"
[ "$(count "select version from public.status_tracks where opportunity_id = '$P1' and track = 'case_progress'")" = "$VP1" ] || bad "o andamento recusado não pode subir a versão"
R2="$(won_with_plan)"; P2="$(won_plain)"; K="$(nova_chave)"
cruzado "andamento segura a chave; roteiro em outro caso espera e recebe conflito" \
  "$(op_andamento "$P2" "$K")" "$(op_roteiro "$R2" "$K")" commit espera conflito "$WS" 1 "$K"
[ "$(count "select version from public.status_tracks where opportunity_id = '$R2' and track = 'case_progress'")" = "1" ] || bad "o roteiro recusado não pode subir a versão"
R3="$(won_with_plan)"; K="$(nova_chave)"
cruzado "situação do atendimento segura a chave; roteiro espera e recebe conflito" \
  "$(op_atendimento "$CONV" "$K" aguardando_cliente)" "$(op_roteiro "$R3" "$K")" commit espera conflito "$WS" 1 "$K"
R4="$(won_with_plan)"; K="$(nova_chave)"
cruzado "roteiro segura a chave; situação do atendimento espera e recebe conflito" \
  "$(op_roteiro "$R4" "$K")" "$(op_atendimento "$CONV" "$K" aguardando_escritorio)" commit espera conflito "$WS" 1 "$K"
[ "$(count "select attendance_status from public.status_tracks where conversation_id = '$CONV'")" = "aguardando_cliente" ] || bad "a situação recusada não pode mudar"

echo "== 6. A desiste (rollback): a chave fica livre e B grava depois de esperar"
R5="$(won_with_plan)"; P5="$(won_plain)"; K="$(nova_chave)"
cruzado "roteiro com a chave desfeito; andamento com a mesma chave grava" \
  "$(op_roteiro "$R5" "$K")" "$(op_andamento "$P5" "$K")" rollback espera ok "$WS" 1 "$K"
[ "$(count "select count(*) from public.case_service_events where opportunity_id = '$R5' and op = 'step_completed'")" = "0" ] || bad "o roteiro desfeito não pode ter evento"

echo "== 7. mesma chave em escritórios diferentes: independentes, sem espera"
R6="$(won_with_plan)"; P6="$(won_plain "$LEAD2")"; K="$(nova_chave)"
cruzado "roteiro no escritório A e andamento no escritório B com a mesma chave" \
  "$(op_roteiro "$R6" "$K")" "$(op_andamento "$P6" "$K")" commit livre ok "$WS" 1 "$K"
[ "$(eventos_da_chave "$K" "$WS2")" = "1" ] || bad "o escritório B deveria ter o próprio evento com a chave"

echo "== 8. repetição exata depois de resposta perdida, ao mesmo tempo que um pedido diferente com a chave"
R7="$(won_with_plan)"; P7="$(won_plain)"; K="$(nova_chave)"
run_ana "$(op_roteiro "$R7" "$K")" >/dev/null
V7="$(count "select version from public.status_tracks where opportunity_id = '$R7' and track = 'case_progress'")"
open_gate
OUT_R="$(mktemp)"; OUT_P="$(mktemp)"
psql_as srv_rep_1 > "$OUT_R" 2>&1 <<SQL &
select pg_advisory_lock_shared($PORTAO);
$(as_ana)
$(op_roteiro "$R7" "$K")
commit;
SQL
PID_R=$!
psql_as srv_rep_2 > "$OUT_P" 2>&1 <<SQL &
select pg_advisory_lock_shared($PORTAO);
$(as_ana)
$(op_andamento "$P7" "$K")
commit;
SQL
PID_P=$!
release_gate 2 srv_rep_
RC_R=0; wait "$PID_R" || RC_R=$?
RC_P=0; wait "$PID_P" || RC_P=$?
ANTES="$FAILS"
{ [ "$RC_R" -eq 0 ] && grep -qx "true" "$OUT_R"; } || bad "a repetição exata deveria devolver replayed=true: $(cat "$OUT_R")"
{ [ "$RC_P" -ne 0 ] && grep -q "idempotency_conflict" "$OUT_P"; } || bad "o pedido diferente com a chave deveria receber idempotency_conflict: $(cat "$OUT_P")"
[ "$(count "select version from public.status_tracks where opportunity_id = '$R7' and track = 'case_progress'")" = "$V7" ] || bad "a repetição não pode subir a versão"
[ "$(eventos_da_chave "$K" "$WS")" = "1" ] || bad "a chave deveria continuar com um único evento"
[ "$FAILS" -eq "$ANTES" ] && echo "   ok: repetição sem evento novo nem versão; pedido diferente recusado"

if [ "$FAILS" -gt 0 ]; then
  fail "$FAILS verificação(ões) falharam — número ou roteiro inconsistente sob concorrência"
fi
echo "== número interno e roteiro do serviço sob concorrência real: OK"
