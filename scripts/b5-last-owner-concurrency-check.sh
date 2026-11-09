#!/usr/bin/env bash
# B5 — o último owner sob concorrência REAL (sessões Postgres simultâneas).
# O pgTAP (03 e 46) roda numa sessão só e prova a regra em sequência
# (`cannot_demote_last_owner`, `cannot_remove_last_owner`); aqui se prova que
# duas operações AO MESMO TEMPO nunca deixam um workspace sem owner. O defeito
# vinha da A2: update_membership_role e remove_membership travavam só a linha
# ALVO e contavam os outros owners sem trava — dois owners que se rebaixam (ou
# se removem) ao mesmo tempo travavam linhas diferentes, cada um via o outro
# ainda como owner, e os dois concluíam.
#
#   1. Transação segurada. A faz a operação e segura a transação aberta
#      (pg_sleep); com A segurando, B faz a operação oposta. Sem a trava de
#      todo o workspace B concluiria também (zero owner, duas auditorias).
#      Com ela, B espera A terminar, relê o estado e é recusado. Cenários: dois
#      owners se rebaixam (a si mesmos e um ao outro), dois se removem, um se
#      rebaixa enquanto o outro se remove, e os dois miram a mesma membership.
#   2. Largada simultânea. As mesmas operações, sem pausa: as duas sessões
#      esperam atrás de um portão (advisory lock) e são soltas juntas, nas duas
#      ordens possíveis de id das memberships. Nunca deadlock, nunca zero
#      owner, exatamente uma conclui.
#   3. Isolamento. Com uma operação segurando as travas de um workspace, uma
#      operação em OUTRO workspace conclui sem esperar, e quem não é do
#      workspace é recusado na hora, sem esperar nem sondar a trava.
#
# Usa workspaces próprios (criados aqui), usuários fictícios do seed e o
# Postgres local do CI (que um passo seguinte recria). Nada de provedor, nada
# hospedado.
set -euo pipefail

DB_CONTAINER="supabase_db_praxis-crm"
ANA="20000000-0000-0000-0000-000000000001"
BRUNO="20000000-0000-0000-0000-000000000002"
DANIEL="20000000-0000-0000-0000-000000000004" # sem nenhum vínculo: o estranho
HOLD=3          # segundos que A segura a transação (parte 1)
HOLD_ISOLAMENTO=8
PORTAO=5005005  # chave do advisory lock da parte 2
FAILS=0

psql_as() { # $1 = application_name; resto = argumentos do psql
  local app="$1"; shift
  docker exec -i -e PGAPPNAME="$app" "$DB_CONTAINER" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -qAt "$@"
}

uuid() { cat /proc/sys/kernel/random/uuid; }

fail() { echo "FALHOU: $*" >&2; exit 1; } # erro de preparo: aborta
bad() { echo "   FALHOU: $*" >&2; FAILS=$((FAILS + 1)); } # verificação: conta e segue

wait_sleeping() { # espera a sessão $1 entrar no pg_sleep (transação aberta)
  for _ in $(seq 1 100); do
    if [ "$(psql_as b5_main -c "select count(*) from pg_stat_activity where application_name = '$1' and query like '%pg_sleep%' and state = 'active'")" = "1" ]; then
      return 0
    fi
    sleep 0.1
  done
  fail "a sessão $1 não chegou ao pg_sleep"
}

wait_lock_waiters() { # espera $1 sessões com application_name iniciado em $2 paradas numa trava ($3 = tentativas)
  for _ in $(seq 1 "${3:-100}"); do
    if [ "$(psql_as b5_main -c "select count(*) from pg_stat_activity where application_name like '$2%' and wait_event_type = 'Lock'")" = "$1" ]; then
      return 0
    fi
    sleep 0.1
  done
  return 1
}

uid_of() { case "$1" in ana) echo "$ANA" ;; bruno) echo "$BRUNO" ;; daniel) echo "$DANIEL" ;; esac; }
mid_of() { case "$1" in ana) echo "$M_ANA" ;; bruno) echo "$M_BRUNO" ;; esac; }

as_user() { # $1 = ana|bruno|daniel — abre a transação como esse usuário autenticado
  printf '%s\n' "begin;" "set local role authenticated;" \
    "select set_config('request.jwt.claims', json_build_object('sub', '$(uid_of "$1")', 'role', 'authenticated')::text, true);"
}

call_sql() { # $1 = demote|remove; $2 = id da membership alvo
  case "$1" in
    demote) echo "select (public.update_membership_role('$2'::uuid, 'lawyer'::public.membership_role)).role;" ;;
    remove) echo "select public.remove_membership('$2'::uuid);" ;;
  esac
}

new_workspace() { # $1 = quem fica com o id MENOR (ana|bruno) — a ordem em que as travas são pegas
  local lo hi
  WS="$(uuid)"
  lo="0$(uuid | cut -c2-)"
  hi="f$(uuid | cut -c2-)"
  if [ "$1" = "ana" ]; then M_ANA="$lo"; M_BRUNO="$hi"; else M_ANA="$hi"; M_BRUNO="$lo"; fi
  psql_as b5_setup <<SQL
insert into public.workspaces (id, name, slug, created_by)
  values ('$WS', 'Concorrência B5', 'conc-b5-$(echo "$WS" | cut -c1-8)', '$ANA');
insert into public.memberships (id, workspace_id, user_id, role, status) values
  ('$M_ANA', '$WS', '$ANA', 'owner', 'active'),
  ('$M_BRUNO', '$WS', '$BRUNO', 'owner', 'active');
SQL
}

owners_of() { psql_as b5_main -c "select count(*) from public.memberships where workspace_id = '$1' and role = 'owner' and status = 'active'"; }
audits_of() { psql_as b5_main -c "select count(*) from public.audit_logs where workspace_id = '$1' and action in ('membership.role_changed', 'membership.removed')"; }

# name | A: op, quem, alvo | B: op, quem, alvo | erro esperado de B quando B espera por A
SCENARIOS='dois owners se rebaixam (cada um a si mesmo)|demote|ana|ana|demote|bruno|bruno|cannot_demote_last_owner
dois owners se rebaixam (um ao outro)|demote|ana|bruno|demote|bruno|ana|insufficient_permission
dois owners se removem (cada um a si mesmo)|remove|ana|ana|remove|bruno|bruno|cannot_remove_last_owner
dois owners se removem (um ao outro)|remove|ana|bruno|remove|bruno|ana|insufficient_permission
um se rebaixa e o outro se remove (a si mesmos)|demote|ana|ana|remove|bruno|bruno|cannot_remove_last_owner
um se remove e o outro se rebaixa (a si mesmos)|remove|ana|ana|demote|bruno|bruno|cannot_demote_last_owner
um rebaixa o outro enquanto o outro o remove|demote|ana|bruno|remove|bruno|ana|insufficient_permission
um remove o outro enquanto o outro o rebaixa|remove|ana|bruno|demote|bruno|ana|insufficient_permission
os dois miram a mesma membership (remover)|remove|ana|ana|remove|bruno|ana|membership_not_found'

hold_pair() { # $1 nome; A: $2 op $3 quem $4 alvo; B: $5 op $6 quem $7 alvo; $8 erro esperado de B
  local name="$1" want="$8" before="$FAILS"
  echo "-- $name"
  new_workspace ana
  local out_a pid_a t0 t1 b_out b_rc b_ms a_rc=0
  out_a="$(mktemp)"
  psql_as b5_a > "$out_a" 2>&1 <<SQL &
$(as_user "$3")
$(call_sql "$2" "$(mid_of "$4")")
select pg_sleep($HOLD);
commit;
SQL
  pid_a=$!
  wait_sleeping b5_a

  t0=$(date +%s%N)
  set +e
  b_out="$( { as_user "$6"; call_sql "$5" "$(mid_of "$7")"; echo "commit;"; } | psql_as b5_b 2>&1 )"
  b_rc=$?
  set -e
  t1=$(date +%s%N)
  b_ms=$(( (t1 - t0) / 1000000 ))
  wait "$pid_a" || a_rc=$?

  local owners audits
  owners="$(owners_of "$WS")"
  audits="$(audits_of "$WS")"
  [ "$a_rc" -eq 0 ] || bad "A (a primeira) deveria concluir: $(cat "$out_a")"
  [ "$owners" = "1" ] || bad "o workspace ficou com $owners owner(s) ativo(s); esperado exatamente 1"
  [ "$audits" = "1" ] || bad "$audits auditoria(s) de membership; esperada 1 (só a operação que concluiu)"
  if [ "$b_rc" -eq 0 ]; then
    bad "B também concluiu; deveria ser recusada com $want"
  elif ! grep -q "$want" <<<"$b_out"; then
    bad "B foi recusada com outro erro (esperado $want): $b_out"
  fi
  [ "$b_ms" -ge 1000 ] || bad "B não esperou por A (${b_ms} ms): as duas operações correram sem serialização"
  if [ "$FAILS" -eq "$before" ]; then
    echo "   ok: B esperou ${b_ms} ms por A e foi recusada ($want); 1 owner, 1 auditoria"
  fi
}

gun_pair() { # $1 nome; $2 quem tem o id menor; A: $3 op $4 quem $5 alvo; B: $6 op $7 quem $8 alvo
  local name="$1" order="$2" before="$FAILS"
  echo "-- $name (travas: $order primeiro)"
  new_workspace "$order"
  local out_a out_b pid_g pid_a pid_b a_rc=0 b_rc=0 wins=0
  out_a="$(mktemp)"
  out_b="$(mktemp)"
  # O porteiro segura o portão; A e B esperam atrás dele e são soltas juntas.
  psql_as b5_porteiro >/dev/null 2>&1 <<SQL &
select pg_advisory_lock($PORTAO);
select pg_sleep(60);
SQL
  pid_g=$!
  wait_sleeping b5_porteiro
  psql_as b5_largada_a > "$out_a" 2>&1 <<SQL &
select pg_advisory_lock_shared($PORTAO);
$(as_user "$4")
$(call_sql "$3" "$(mid_of "$5")")
commit;
SQL
  pid_a=$!
  psql_as b5_largada_b > "$out_b" 2>&1 <<SQL &
select pg_advisory_lock_shared($PORTAO);
$(as_user "$7")
$(call_sql "$6" "$(mid_of "$8")")
commit;
SQL
  pid_b=$!
  wait_lock_waiters 2 b5_largada_ || fail "as duas sessões não chegaram ao portão"
  psql_as b5_main -c "select pg_cancel_backend(pid) from pg_stat_activity where application_name = 'b5_porteiro'" >/dev/null
  wait "$pid_g" || true
  wait "$pid_a" || a_rc=$?
  wait "$pid_b" || b_rc=$?

  local owners audits
  owners="$(owners_of "$WS")"
  audits="$(audits_of "$WS")"
  [ "$a_rc" -eq 0 ] && wins=$((wins + 1))
  [ "$b_rc" -eq 0 ] && wins=$((wins + 1))
  [ "$wins" -eq 1 ] || bad "$wins operação(ões) concluíram; esperada exatamente 1"
  [ "$owners" = "1" ] || bad "o workspace ficou com $owners owner(s) ativo(s); esperado exatamente 1"
  [ "$audits" = "1" ] || bad "$audits auditoria(s) de membership; esperada 1"
  if grep -qi "deadlock" "$out_a" "$out_b"; then
    bad "deadlock entre as duas operações: $(cat "$out_a" "$out_b")"
  fi
  if [ "$wins" -eq 1 ]; then
    local loser_out="$out_a"
    [ "$a_rc" -eq 0 ] && loser_out="$out_b"
    grep -Eq "insufficient_permission|cannot_demote_last_owner|cannot_remove_last_owner|membership_not_found" "$loser_out" \
      || bad "a recusada falhou por um motivo inesperado: $(cat "$loser_out")"
  fi
  if [ "$FAILS" -eq "$before" ]; then
    echo "   ok: uma concluiu e a outra foi recusada; 1 owner, 1 auditoria, sem deadlock"
  fi
}

echo "== 1. transação segurada: B espera A e é recusada"
while IFS='|' read -r -u 3 name opa qa ta opb qb tb want; do
  hold_pair "$name" "$opa" "$qa" "$ta" "$opb" "$qb" "$tb" "$want"
done 3<<<"$SCENARIOS"

echo "== 2. largada simultânea, nas duas ordens de trava"
for order in ana bruno; do
  while IFS='|' read -r -u 3 name opa qa ta opb qb tb _; do
    gun_pair "$name" "$order" "$opa" "$qa" "$ta" "$opb" "$qb" "$tb"
  done 3<<<"$SCENARIOS"
done

echo "== 3. isolamento entre workspaces"
before="$FAILS"
new_workspace ana; W1="$WS"; W1_MA="$M_ANA"; W1_MB="$M_BRUNO"
new_workspace ana; W2="$WS"; W2_MA="$M_ANA"; W2_MB="$M_BRUNO"
out_a="$(mktemp)"; out_b1="$(mktemp)"
psql_as b5_a > "$out_a" 2>&1 <<SQL &
$(as_user ana)
$(call_sql demote "$W1_MA")
select pg_sleep($HOLD_ISOLAMENTO);
commit;
SQL
pid_a=$!
wait_sleeping b5_a
# Mesmo workspace: Bruno tenta se rebaixar e espera a trava de A.
psql_as b5_b1 > "$out_b1" 2>&1 <<SQL &
$(as_user bruno)
$(call_sql demote "$W1_MB")
commit;
SQL
pid_b1=$!
wait_lock_waiters 1 b5_b1 30 || bad "Bruno (mesmo workspace) não ficou esperando a trava de A"

# Outro workspace: Ana rebaixa o Bruno de W2 e conclui sem esperar por A.
t0=$(date +%s%N)
set +e
out_w2="$( { as_user ana; call_sql demote "$W2_MB"; echo "commit;"; } | psql_as b5_b2 2>&1 )"
rc_w2=$?
set -e
ms_w2=$(( ($(date +%s%N) - t0) / 1000000 ))

# Quem não é do workspace é recusado na hora, sem esperar a trava de W1.
t0=$(date +%s%N)
set +e
out_dn="$( { as_user daniel; call_sql demote "$W1_MA"; echo "commit;"; } | psql_as b5_estranho 2>&1 )"
rc_dn=$?
set -e
ms_dn=$(( ($(date +%s%N) - t0) / 1000000 ))

segurando="$(psql_as b5_main -c "select count(*) from pg_stat_activity where application_name = 'b5_a' and query like '%pg_sleep%' and state = 'active'")"
a_rc=0; b1_rc=0
wait "$pid_a" || a_rc=$?
wait "$pid_b1" || b1_rc=$?

[ "$segurando" = "1" ] || bad "A já tinha terminado antes das verificações; o isolamento não ficou provado (aumente HOLD_ISOLAMENTO)"
[ "$rc_w2" -eq 0 ] || bad "a operação em OUTRO workspace falhou: $out_w2"
[ "$ms_w2" -lt 4000 ] || bad "a operação em outro workspace esperou ${ms_w2} ms: as travas vazaram entre workspaces"
if [ "$rc_dn" -eq 0 ]; then
  bad "um estranho ao workspace conseguiu alterar uma membership"
elif ! grep -q "insufficient_permission" <<<"$out_dn"; then
  bad "o estranho deveria receber insufficient_permission: $out_dn"
fi
[ "$ms_dn" -lt 4000 ] || bad "o estranho esperou ${ms_dn} ms pela trava de um workspace que não é dele"
[ "$a_rc" -eq 0 ] || bad "A deveria concluir: $(cat "$out_a")"
if [ "$b1_rc" -eq 0 ]; then
  bad "Bruno (mesmo workspace) também concluiu; deveria ser recusado"
elif ! grep -q "cannot_demote_last_owner" "$out_b1"; then
  bad "Bruno deveria receber cannot_demote_last_owner: $(cat "$out_b1")"
fi
[ "$(owners_of "$W1")" = "1" ] || bad "W1 deveria terminar com exatamente 1 owner"
[ "$(owners_of "$W2")" = "1" ] || bad "W2 deveria terminar com exatamente 1 owner"
if [ "$FAILS" -eq "$before" ]; then
  echo "   ok: outro workspace concluiu em ${ms_w2} ms e o estranho foi recusado em ${ms_dn} ms com A ainda segurando; W1 e W2 com 1 owner cada"
fi

if [ "$FAILS" -gt 0 ]; then
  fail "$FAILS verificação(ões) falharam — o workspace pode ficar sem owner sob concorrência"
fi
echo "== último owner sob concorrência real: OK"
