#!/usr/bin/env bash
# C1 — o processamento das automações sob concorrência REAL (sessões Postgres
# simultâneas). O pgTAP 47 roda numa sessão só e prova as regras em sequência
# (idempotência, retry, dead-letter); aqui se prova que processadores AO MESMO
# TEMPO sobre os mesmos eventos nunca duplicam uma atividade:
#
#   1. Largada simultânea. Quatro sessões pedem o processamento do mesmo
#      workspace ao mesmo tempo (atrás de um portão, soltas juntas), com 8
#      leads pendentes e duas regras ativas. Cada combinação evento + regra
#      gera UMA execução e UMA atividade: 8 da regra A (todos os leads) e 4 da
#      regra B (só prioridade alta); nenhuma sessão falha.
#   2. Processador segurando. A processa e mantém a transação aberta; B, ao
#      mesmo tempo, NÃO espera (as linhas travadas por A são puladas) e não
#      duplica nada; depois que A termina, a conta fecha exata.
#   3. Reprocessar. Nova rodada: nada pendente, nada novo.
#
# Usa um workspace próprio (criado aqui), usuários fictícios do seed e o
# Postgres local do CI (que um passo seguinte recria). Nada de provedor, nada
# hospedado.
set -euo pipefail

DB_CONTAINER="supabase_db_praxis-crm"
ANA="20000000-0000-0000-0000-000000000001"
HOLD=3
PORTAO=5005007
FAILS=0

psql_as() { # $1 = application_name; resto = argumentos do psql
  local app="$1"; shift
  docker exec -i -e PGAPPNAME="$app" "$DB_CONTAINER" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -qAt "$@"
}

uuid() { cat /proc/sys/kernel/random/uuid; }

fail() { echo "FALHOU: $*" >&2; exit 1; }
bad() { echo "   FALHOU: $*" >&2; FAILS=$((FAILS + 1)); }

wait_sleeping() { # espera a sessão $1 entrar no pg_sleep (transação aberta)
  for _ in $(seq 1 100); do
    if [ "$(psql_as c1_main -c "select count(*) from pg_stat_activity where application_name = '$1' and query like '%pg_sleep%' and state = 'active'")" = "1" ]; then
      return 0
    fi
    sleep 0.1
  done
  fail "a sessão $1 não chegou ao pg_sleep"
}

wait_lock_waiters() { # espera $1 sessões com application_name iniciado em $2 paradas numa trava
  for _ in $(seq 1 100); do
    if [ "$(psql_as c1_main -c "select count(*) from pg_stat_activity where application_name like '$2%' and wait_event_type = 'Lock'")" = "$1" ]; then
      return 0
    fi
    sleep 0.1
  done
  return 1
}

as_ana() { # abre a transação como a Ana autenticada
  printf '%s\n' "begin;" "set local role authenticated;" \
    "select set_config('request.jwt.claims', json_build_object('sub', '$ANA', 'role', 'authenticated')::text, true);"
}

count() { psql_as c1_main -c "$1"; }

echo "== preparo (workspace, contato e duas regras ativas)"
WS="$(uuid)"
CONTATO="$(uuid)"
psql_as c1_setup <<SQL
insert into public.workspaces (id, name, slug, created_by)
  values ('$WS', 'Concorrência C1', 'conc-c1-$(echo "$WS" | cut -c1-8)', '$ANA');
insert into public.memberships (workspace_id, user_id, role, status) values ('$WS', '$ANA', 'owner', 'active');
insert into public.contacts (id, workspace_id, type, name, created_by) values ('$CONTATO', '$WS', 'pf', 'Contato concorrência C1', '$ANA');
SQL

RULE_A="$( { as_ana; echo "select public.create_automation_rule('$WS'::uuid, 'Regra A', 'lead_created', 'Acompanhar A', 1, 'media', 'lead_owner');"; echo "commit;"; } | psql_as c1_setup | tail -1)"
RULE_B="$( { as_ana; echo "select public.create_automation_rule('$WS'::uuid, 'Regra B', 'lead_created', 'Acompanhar B', 1, 'alta', 'lead_owner', null, 'alta');"; echo "commit;"; } | psql_as c1_setup | tail -1)"
[ -n "$RULE_A" ] && [ -n "$RULE_B" ] || fail "não criou as regras"
for r in "$RULE_A" "$RULE_B"; do
  { as_ana; echo "select public.simulate_automation_rule('$r'::uuid) is not null;"; echo "select public.set_automation_rule_status('$r'::uuid, 'active');"; echo "commit;"; } | psql_as c1_setup >/dev/null
done
[ "$(count "select count(*) from public.automation_rules where workspace_id = '$WS' and status = 'active'")" = "2" ] || fail "as duas regras deveriam estar ativas"

novos_leads() { # $1 = quantos, $2 = prioridade
  local sql="" i
  for i in $(seq 1 "$1"); do
    sql="$sql select public.create_lead('$WS'::uuid, '$CONTATO'::uuid, 'Trabalhista', null, '{}'::text[], '$2', '$ANA'::uuid);"
  done
  { as_ana; echo "$sql"; echo "commit;"; } | psql_as c1_setup >/dev/null
}

atividades() { count "select count(*) from public.activities where workspace_id = '$WS' and title = '$1'"; }
execucoes() { count "select count(*) from public.automation_executions where workspace_id = '$WS' and state = '$1'"; }

echo "== 1. largada simultânea: 4 processadores, 8 leads, 2 regras"
novos_leads 4 alta
novos_leads 4 media
[ "$(count "select count(*) from public.automation_events where workspace_id = '$WS' and status = 'pending'")" = "8" ] || fail "deveria haver 8 eventos pendentes"

OUTS=()
psql_as c1_porteiro >/dev/null 2>&1 <<SQL &
select pg_advisory_lock($PORTAO);
select pg_sleep(60);
SQL
PID_G=$!
wait_sleeping c1_porteiro
PIDS=()
for n in 1 2 3 4; do
  OUT="$(mktemp)"; OUTS+=("$OUT")
  psql_as "c1_largada_$n" > "$OUT" 2>&1 <<SQL &
select pg_advisory_lock_shared($PORTAO);
$(as_ana)
select public.process_automation_events('$WS'::uuid, 50);
commit;
SQL
  PIDS+=($!)
done
wait_lock_waiters 4 c1_largada_ || fail "as quatro sessões não chegaram ao portão"
psql_as c1_main -c "select pg_cancel_backend(pid) from pg_stat_activity where application_name = 'c1_porteiro'" >/dev/null
wait "$PID_G" || true
for i in 0 1 2 3; do
  rc=0
  wait "${PIDS[$i]}" || rc=$?
  [ "$rc" -eq 0 ] || bad "o processador $((i + 1)) falhou: $(cat "${OUTS[$i]}")"
done

[ "$(atividades 'Acompanhar A')" = "8" ] || bad "regra A deveria ter exatamente 8 atividades, tem $(atividades 'Acompanhar A')"
[ "$(atividades 'Acompanhar B')" = "4" ] || bad "regra B deveria ter exatamente 4 atividades, tem $(atividades 'Acompanhar B')"
[ "$(execucoes succeeded)" = "12" ] || bad "deveria haver 12 execuções concluídas, há $(execucoes succeeded)"
[ "$(count "select count(*) from public.automation_executions where workspace_id = '$WS'")" = "12" ] || bad "nenhuma execução extra era esperada"
[ "$(count "select count(*) from public.automation_events where workspace_id = '$WS' and status = 'pending'")" = "0" ] || bad "nenhum evento deveria ficar pendente"
[ "$FAILS" -eq 0 ] && echo "   ok: 8 + 4 atividades, 12 execuções concluídas, 4 processadores sem erro"

echo "== 2. um processador segurando a transação: o outro não espera nem duplica"
novos_leads 4 alta
ANTES="$FAILS"
OUT_A="$(mktemp)"
psql_as c1_a > "$OUT_A" 2>&1 <<SQL &
$(as_ana)
select public.process_automation_events('$WS'::uuid, 50);
select pg_sleep($HOLD);
commit;
SQL
PID_A=$!
wait_sleeping c1_a
T0=$(date +%s%N)
B_OUT="$( { as_ana; echo "select public.process_automation_events('$WS'::uuid, 50);"; echo "commit;"; } | psql_as c1_b 2>&1 | tail -1)"
B_MS=$(( ($(date +%s%N) - T0) / 1000000 ))
A_RC=0
wait "$PID_A" || A_RC=$?
[ "$A_RC" -eq 0 ] || bad "o processador que segurava falhou: $(cat "$OUT_A")"
[ "$B_MS" -lt $((HOLD * 1000 - 500)) ] || bad "o segundo processador ESPEROU o primeiro (${B_MS} ms): deveria pular as linhas travadas"
[ "$(echo "$B_OUT" | tr -d ' ')" = '{"events":0,"executions":0}' ] || bad "o segundo processador não deveria encontrar nada livre: $B_OUT"
[ "$(atividades 'Acompanhar A')" = "12" ] || bad "regra A deveria ter exatamente 12 atividades, tem $(atividades 'Acompanhar A')"
[ "$(atividades 'Acompanhar B')" = "8" ] || bad "regra B deveria ter exatamente 8 atividades, tem $(atividades 'Acompanhar B')"
[ "$(count "select count(*) from public.automation_executions where workspace_id = '$WS'")" = "20" ] || bad "deveria haver exatamente 20 execuções"
[ "$FAILS" -eq "$ANTES" ] && echo "   ok: o segundo terminou em ${B_MS} ms sem esperar e sem duplicar; 12 + 8 atividades"

echo "== 3. reprocessar não cria nada"
ANTES="$FAILS"
R3="$( { as_ana; echo "select public.process_automation_events('$WS'::uuid, 50);"; echo "commit;"; } | psql_as c1_b 2>&1 | tail -1)"
[ "$(echo "$R3" | tr -d ' ')" = '{"events":0,"executions":0}' ] || bad "não deveria haver nada a processar: $R3"
# Mesmo reabrindo os eventos, nada é recriado: a unicidade (evento, regra) segura.
psql_as c1_setup -c "update public.automation_events set status = 'pending', processed_at = null where workspace_id = '$WS'" >/dev/null
{ as_ana; echo "select public.process_automation_events('$WS'::uuid, 50);"; echo "commit;"; } | psql_as c1_b >/dev/null
[ "$(atividades 'Acompanhar A')" = "12" ] && [ "$(atividades 'Acompanhar B')" = "8" ] || bad "reabrir os eventos duplicou atividade"
[ "$(count "select count(*) from public.automation_executions where workspace_id = '$WS'")" = "20" ] || bad "reabrir os eventos criou execução"
[ "$FAILS" -eq "$ANTES" ] && echo "   ok: sem novas execuções nem atividades, mesmo com os eventos reabertos"

if [ "$FAILS" -gt 0 ]; then
  fail "$FAILS verificação(ões) falharam — o processamento pode duplicar atividade sob concorrência"
fi
echo "== processamento das automações sob concorrência real: OK"
