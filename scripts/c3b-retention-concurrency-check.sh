#!/usr/bin/env bash
# C3b — a retenção e a anonimização sob concorrência REAL (sessões Postgres
# simultâneas). O pgTAP 50 roda numa sessão só e prova as regras em sequência
# (elegibilidade, bloqueios, rollback, lote); aqui se prova que operações AO
# MESMO TEMPO nunca anonimizam o mesmo contato duas vezes e nunca decidem sobre
# um estado já superado:
#
#   1. Largada simultânea. Quatro lotes do sistema soltos juntos (atrás de um
#      portão) sobre 8 contatos vencidos: cada contato é anonimizado UMA vez
#      (8 conclusões distintas, nenhuma sessão falha, nenhum deadlock).
#   2. Lote segurando. Um lote processa e mantém a transação aberta; outro lote,
#      ao mesmo tempo, NÃO espera (as linhas travadas são puladas) e não
#      duplica nada.
#   3. Lead reativado. Uma sessão reativa o lead e segura a transação; a
#      anonimização manual espera, relê o estado e é RECUSADA (active_lead). Sem
#      a trava dos leads ela anonimizaria um contato que voltou a ser ativo.
#   4. Preservação legal. Uma sessão cria a preservação e segura a transação; a
#      anonimização manual espera, relê e é RECUSADA (legal_hold_active).
#   5. Dupla confirmação. Duas anonimizações manuais do mesmo contato ao mesmo
#      tempo: uma conclui, a outra encontra "já anonimizado"; uma só conclusão.
#
# Usa um workspace próprio (criado aqui), usuários fictícios do seed e o
# Postgres local do CI (que um passo seguinte recria). Nada de provedor, nada
# hospedado.
set -euo pipefail

DB_CONTAINER="supabase_db_praxis-crm"
ANA="20000000-0000-0000-0000-000000000001"
HOLD=3
PORTAO=5005009
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
    if [ "$(psql_as c3b_main -c "select count(*) from pg_stat_activity where application_name = '$1' and query like '%pg_sleep%' and state = 'active'")" = "1" ]; then
      return 0
    fi
    sleep 0.1
  done
  fail "a sessão $1 não chegou ao pg_sleep"
}

wait_lock_waiters() { # espera $1 sessões com application_name iniciado em $2 paradas numa trava
  for _ in $(seq 1 100); do
    if [ "$(psql_as c3b_main -c "select count(*) from pg_stat_activity where application_name like '$2%' and wait_event_type = 'Lock'")" = "$1" ]; then
      return 0
    fi
    sleep 0.1
  done
  return 1
}

count() { psql_as c3b_main -c "$1"; }

echo "== preparo (workspace próprio)"
WS="$(uuid)"
psql_as c3b_setup <<SQL
insert into public.workspaces (id, name, slug, created_by)
  values ('$WS', 'Concorrência C3b', 'conc-c3b-$(echo "$WS" | cut -c1-8)', '$ANA');
insert into public.memberships (workspace_id, user_id, role, status) values ('$WS', '$ANA', 'owner', 'active');
SQL

novo_contato() { # $1 = nome; define CONTATO e LEAD — contato com lead arquivado há 13 meses e um telefone
  CONTATO="$(uuid)"
  LEAD="$(uuid)"
  psql_as c3b_setup <<SQL
insert into public.contacts (id, workspace_id, type, name, created_by) values ('$CONTATO', '$WS', 'pf', '$1', '$ANA');
insert into public.contact_phones (workspace_id, contact_id, value_normalized)
  values ('$WS', '$CONTATO', '+5541999' || lpad((floor(random() * 1000000))::int::text, 6, '0'));
insert into public.leads (id, workspace_id, contact_id, legal_area, status, created_by)
  values ('$LEAD', '$WS', '$CONTATO', 'Área', 'arquivado', '$ANA');
-- O gatilho é a única fonte do marco; só aqui ele é suspenso para recuar o relógio.
alter table public.leads disable trigger leads_retention_mark;
update public.leads set archived_at = now() - interval '13 months' where id = '$LEAD';
alter table public.leads enable trigger leads_retention_mark;
SQL
}

concluidas() { count "select count(*) from public.audit_logs where workspace_id = '$WS' and action = 'privacy.anonymization_completed'"; }
distintas() { count "select count(distinct resource_id) from public.audit_logs where workspace_id = '$WS' and action = 'privacy.anonymization_completed'"; }
anonimizados() { count "select count(*) from public.contacts where workspace_id = '$WS' and anonymized_at is not null"; }

echo "== 1. largada simultânea: 4 lotes sobre 8 contatos vencidos"
for i in 1 2 3 4 5 6 7 8; do novo_contato "Concorrência $i"; done
OUTS=()
psql_as c3b_porteiro >/dev/null 2>&1 <<SQL &
select pg_advisory_lock($PORTAO);
select pg_sleep(60);
SQL
PID_G=$!
wait_sleeping c3b_porteiro
PIDS=()
for n in 1 2 3 4; do
  OUT="$(mktemp)"; OUTS+=("$OUT")
  psql_as "c3b_largada_$n" > "$OUT" 2>&1 <<SQL &
select pg_advisory_lock_shared($PORTAO);
select public.run_privacy_retention_batch(50);
SQL
  PIDS+=($!)
done
wait_lock_waiters 4 c3b_largada_ || fail "as quatro sessões não chegaram ao portão"
psql_as c3b_main -c "select pg_cancel_backend(pid) from pg_stat_activity where application_name = 'c3b_porteiro'" >/dev/null
wait "$PID_G" || true
PROCESSADOS=0
for i in 0 1 2 3; do
  rc=0
  wait "${PIDS[$i]}" || rc=$?
  [ "$rc" -eq 0 ] || bad "o lote $((i + 1)) falhou: $(cat "${OUTS[$i]}")"
  if grep -qi "deadlock" "${OUTS[$i]}"; then bad "deadlock no lote $((i + 1)): $(cat "${OUTS[$i]}")"; fi
  p="$(grep -o '"processed": *[0-9]*' "${OUTS[$i]}" | grep -o '[0-9]*$' || echo 0)"
  PROCESSADOS=$((PROCESSADOS + p))
done
[ "$PROCESSADOS" -eq 8 ] || bad "a soma de 'processed' deveria ser 8, é $PROCESSADOS"
[ "$(anonimizados)" = "8" ] || bad "deveriam estar anonimizados 8 contatos, há $(anonimizados)"
[ "$(concluidas)" = "8" ] || bad "deveria haver 8 conclusões, há $(concluidas)"
[ "$(distintas)" = "8" ] || bad "as conclusões deveriam ser de 8 contatos distintos, são $(distintas)"
[ "$FAILS" -eq 0 ] && echo "   ok: 8 contatos, 8 conclusões distintas, 4 lotes sem erro nem deadlock"

echo "== 2. um lote segurando a transação: o outro não espera nem duplica"
for i in 1 2 3 4; do novo_contato "Segurando $i"; done
ANTES="$FAILS"
OUT_A="$(mktemp)"
psql_as c3b_a > "$OUT_A" 2>&1 <<SQL &
begin;
select public.run_privacy_retention_batch(50);
select pg_sleep($HOLD);
commit;
SQL
PID_A=$!
wait_sleeping c3b_a
T0=$(date +%s%N)
B_OUT="$(psql_as c3b_b -c "select public.run_privacy_retention_batch(50)" 2>&1 | tail -1)"
B_MS=$(( ($(date +%s%N) - T0) / 1000000 ))
A_RC=0
wait "$PID_A" || A_RC=$?
[ "$A_RC" -eq 0 ] || bad "o lote que segurava falhou: $(cat "$OUT_A")"
[ "$B_MS" -lt $((HOLD * 1000 - 500)) ] || bad "o segundo lote ESPEROU o primeiro (${B_MS} ms): deveria pular as linhas travadas"
echo "$B_OUT" | tr -d ' ' | grep -q '"processed":0' || bad "o segundo lote não deveria processar nada: $B_OUT"
[ "$(anonimizados)" = "12" ] || bad "deveriam estar anonimizados 12 contatos, há $(anonimizados)"
[ "$(concluidas)" = "12" ] || bad "deveria haver 12 conclusões, há $(concluidas)"
[ "$(distintas)" = "12" ] || bad "as conclusões deveriam ser de 12 contatos distintos, são $(distintas)"
[ "$FAILS" -eq "$ANTES" ] && echo "   ok: o segundo lote terminou em ${B_MS} ms sem esperar e sem duplicar; 12 conclusões distintas"

echo "== 3. lead reativado em transação aberta: a anonimização espera, relê e é recusada"
novo_contato "Reativa"
K3="$CONTATO"; L3="$LEAD"
ANTES="$FAILS"
OUT_R="$(mktemp)"
psql_as c3b_reativa > "$OUT_R" 2>&1 <<SQL &
begin;
update public.leads set status = 'ativo' where id = '$L3';
select pg_sleep($HOLD);
commit;
SQL
PID_R=$!
wait_sleeping c3b_reativa
T0=$(date +%s%N)
R3="$(psql_as c3b_manual3 -c "select public.anonymize_privacy_contact('$ANA'::uuid, '$WS'::uuid, '$K3'::uuid)" 2>&1 | tail -1)"
MS3=$(( ($(date +%s%N) - T0) / 1000000 ))
R_RC=0
wait "$PID_R" || R_RC=$?
[ "$R_RC" -eq 0 ] || bad "a sessão que reativava falhou: $(cat "$OUT_R")"
[ "$MS3" -ge 1000 ] || bad "a anonimização não esperou o lead reativado (${MS3} ms)"
echo "$R3" | grep -q '"result": "refused"' || bad "deveria ser recusada: $R3"
echo "$R3" | grep -q 'active_lead' || bad "deveria recusar com active_lead: $R3"
[ "$(count "select name from public.contacts where id = '$K3'")" = "Reativa" ] || bad "o contato foi alterado"
[ "$FAILS" -eq "$ANTES" ] && echo "   ok: esperou ${MS3} ms pelo lead reativado, releu o estado e recusou (active_lead)"

echo "== 4. preservação legal criada em transação aberta: a anonimização espera, relê e é recusada"
novo_contato "Preserva"
K4="$CONTATO"
ANTES="$FAILS"
OUT_H="$(mktemp)"
psql_as c3b_hold > "$OUT_H" 2>&1 <<SQL &
begin;
select public.create_privacy_legal_hold('$ANA'::uuid, '$WS'::uuid, '$K4'::uuid, 'judicial_process');
select pg_sleep($HOLD);
commit;
SQL
PID_H=$!
wait_sleeping c3b_hold
T0=$(date +%s%N)
R4="$(psql_as c3b_manual4 -c "select public.anonymize_privacy_contact('$ANA'::uuid, '$WS'::uuid, '$K4'::uuid)" 2>&1 | tail -1)"
MS4=$(( ($(date +%s%N) - T0) / 1000000 ))
H_RC=0
wait "$PID_H" || H_RC=$?
[ "$H_RC" -eq 0 ] || bad "a sessão que criava a preservação falhou: $(cat "$OUT_H")"
[ "$MS4" -ge 1000 ] || bad "a anonimização não esperou a preservação (${MS4} ms)"
echo "$R4" | grep -q '"result": "refused"' || bad "deveria ser recusada: $R4"
echo "$R4" | grep -q 'legal_hold_active' || bad "deveria recusar com legal_hold_active: $R4"
[ "$(count "select name from public.contacts where id = '$K4'")" = "Preserva" ] || bad "o contato preservado foi alterado"
[ "$FAILS" -eq "$ANTES" ] && echo "   ok: esperou ${MS4} ms, releu o estado e recusou (legal_hold_active)"

echo "== 5. duas anonimizações manuais simultâneas do mesmo contato"
novo_contato "Duplo"
K5="$CONTATO"
ANTES="$FAILS"
OUT_1="$(mktemp)"; OUT_2="$(mktemp)"
psql_as c3b_dup1 > "$OUT_1" 2>&1 <<SQL &
select public.anonymize_privacy_contact('$ANA'::uuid, '$WS'::uuid, '$K5'::uuid);
SQL
PID_1=$!
psql_as c3b_dup2 > "$OUT_2" 2>&1 <<SQL &
select public.anonymize_privacy_contact('$ANA'::uuid, '$WS'::uuid, '$K5'::uuid);
SQL
PID_2=$!
RC1=0; RC2=0
wait "$PID_1" || RC1=$?
wait "$PID_2" || RC2=$?
[ "$RC1" -eq 0 ] && [ "$RC2" -eq 0 ] || bad "uma das duas falhou: $(cat "$OUT_1" "$OUT_2")"
GANHOU="$(cat "$OUT_1" "$OUT_2" | grep -c '"result": "anonymized"' || true)"
JA="$(cat "$OUT_1" "$OUT_2" | grep -c '"result": "already_anonymized"' || true)"
[ "$GANHOU" = "1" ] && [ "$JA" = "1" ] || bad "esperado 1 'anonymized' e 1 'already_anonymized'; veio $GANHOU e $JA: $(cat "$OUT_1" "$OUT_2")"
[ "$(count "select count(*) from public.audit_logs where resource_id = '$K5' and action = 'privacy.anonymization_completed'")" = "1" ] || bad "o contato deveria ter exatamente 1 conclusão"
[ "$FAILS" -eq "$ANTES" ] && echo "   ok: uma anonimizou, a outra encontrou 'já anonimizado'; 1 conclusão"

if [ "$FAILS" -gt 0 ]; then
  fail "$FAILS verificação(ões) falharam — a anonimização pode duplicar ou decidir sobre estado superado sob concorrência"
fi
echo "== retenção e anonimização sob concorrência real: OK"
