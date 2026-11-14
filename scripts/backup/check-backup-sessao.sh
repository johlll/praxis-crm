#!/usr/bin/env bash
# B6c — prova de que a SESSÃO que segura o snapshot exportado do backup é encerrada em TODA saída do script.
# Usa as FERRAMENTAS REAIS (pg_dump/psql 17 e age) contra um banco SINTÉTICO/LOCAL; nenhum dado hospedado,
# nenhuma chave de verdade.
#
# O defeito que isto cobre (visto em 14/11/2026 no banco hospedado): o backup antigo segurava o snapshot com
# `select pg_sleep(14400)` e, no fim, só matava o psql LOCAL. O servidor não percebe que o cliente morreu enquanto
# executa uma consulta, então a sessão ficava lá por até 4 horas, com a transação aberta e centenas de
# ACCESS SHARE LOCK (que bloqueiam migrations). Aqui, para cada jeito de o script terminar, o teste confere que
# NÃO sobra sessão, transação, pg_sleep, backend nem trava do segurador.
#
# Como: um "pg_dump" de mentira (shim) fica na frente do verdadeiro no PATH. A CADA chamada ele observa (com uma
# conexão de administrador) quais sessões estão em transação — o segurador, que tem de existir enquanto os
# dumps rodam — e, conforme o cenário, injeta uma falha, uma pausa ou a queda da sessão do snapshot. Depois da
# saída do script, os PIDs observados não podem mais existir, não podem segurar trava, e nenhuma sessão com o
# rótulo do segurador, em pg_sleep ou em transação pode restar. O log só pode ter linhas de CÓDIGO FECHADO.
#
# Cenários: 1 sucesso · 2 falha de dump · 3 falha de criptografia · 4 falha do manifesto · 5 sinal (TERM) ·
# 6 queda inesperada da sessão (no meio e no último dump) · 7 morte do cliente (kill -9 da árvore) ·
# 8 sessão presa no servidor: o último recurso derruba SÓ a sessão do segurador e poupa sessões-isca.
#
# Entrada: CHECK_BACKUP_URL (usuário do backup), CHECK_RESTORE_SERVER_URL (superusuário do servidor local, que
# enxerga todas as sessões) e, opcionalmente, CHECK_SCRIPTS_DIR (pasta com backup-db.sh/lib.sh a testar; padrão:
# a desta pasta — é assim que se prova o vermelho contra a versão anterior).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPTS="${CHECK_SCRIPTS_DIR:-$HERE}"
# shellcheck source=lib.sh
. "$SCRIPTS/lib.sh"

: "${CHECK_BACKUP_URL:?defina CHECK_BACKUP_URL}"
ADMIN_URL="${CHECK_RESTORE_SERVER_URL:-$CHECK_BACKUP_URL}"
BACKUP_URL="$CHECK_BACKUP_URL"
unset CHECK_BACKUP_URL CHECK_RESTORE_SERVER_URL CHECK_SCRIPTS_DIR

FAILS=0
ok() { printf '   ok: %s\n' "$1"; }
bad() { printf '   FALHOU: %s\n' "$1" >&2; FAILS=$((FAILS + 1)); }

for tool in age age-keygen psql pg_dump tar sha256sum awk; do need_tool "$tool"; done
REAL_PG_DUMP="$(command -v pg_dump)"
REAL_PSQL="$(command -v psql)"
REAL_AGE="$(command -v age)"
REAL_SHA="$(command -v sha256sum)"
LABEL="praxis-backup-snapshot"

ROOT="$(mktemp -d)"
export TMPDIR="$ROOT/tmp"
mkdir -p "$TMPDIR" "$ROOT/shim" "$ROOT/keys"

adm() { ( parse_database_url "$ADMIN_URL"; psql -X -At -q -v ON_ERROR_STOP=1 "$@" | tr -d '\r' ); }
src() { ( parse_database_url "$BACKUP_URL"; psql -X -At -q -v ON_ERROR_STOP=1 "$@" | tr -d '\r' ); }

DB="$(src -c 'select current_database()')"
DBUSER="$(src -c 'select current_user')"
LEAKED=()  # PIDs que sobraram: derrubados no fim, para não sujar o banco de quem rodou o teste
DECOYS=()  # sessões-isca criadas pelo teste (precisam sobreviver ao backup)

cleanup() {
  local rc=$?
  trap - EXIT
  local p
  for p in "${LEAKED[@]:-}" "${DECOYS[@]:-}"; do
    [ -n "$p" ] || continue
    adm -c "select pg_terminate_backend($p)" >/dev/null 2>&1 || true
  done
  # nenhum processo de fundo do teste pode sobrar
  jobs -p 2>/dev/null | while read -r j; do kill "$j" 2>/dev/null || true; done
  rm -rf "$ROOT"
  exit "$rc"
}
trap cleanup EXIT

age-keygen -o "$ROOT/keys/id.txt" >/dev/null 2>&1
PUB="$(age-keygen -y "$ROOT/keys/id.txt")"
LOG="$ROOT/log.txt"
STATE="$ROOT/estado"

# --- sessões do segurador: rótulo exclusivo, pg_sleep ou transação aberta, do usuário do backup ----------
sessoes_sql() {
  local excl=""
  if [ "${#DECOYS[@]}" -gt 0 ]; then excl=" and pid <> all (array[$(IFS=,; echo "${DECOYS[*]}")]::int[])"; fi
  printf "select pid from pg_stat_activity where datname = '%s' and usename = '%s' and backend_type = 'client backend' and pid <> pg_backend_pid() and (application_name = '%s' or wait_event = 'PgSleep' or xact_start is not null)%s order by pid" "$DB" "$DBUSER" "$LABEL" "$excl"
}
restantes() { adm -c "$(sessoes_sql)" | paste -sd, -; }
sem_sessoes() { # espera até ~8 s; 0 se nenhuma sessão do segurador restar (LEFT guarda as que restaram)
  local i
  LEFT=""
  for i in $(seq 1 40); do
    LEFT="$(restantes)"
    [ -z "$LEFT" ] && return 0
    sleep 0.2
  done
  return 1
}
pids_existentes() { # $1 = lista de PIDs separada por vírgula; devolve quantos ainda existem em pg_stat_activity
  adm -c "select count(*) from pg_stat_activity where pid = any (array[$1]::int[])"
}
travas_de() { adm -c "select count(*) from pg_locks where pid = any (array[$1]::int[])"; }

# --- ferramentas de mentira ---------------------------------------------------------------------------
cat >"$ROOT/shim/pg_dump" <<'SHIM'
#!/usr/bin/env bash
# pg_dump de mentira: observa o segurador do snapshot, injeta o que o cenário pede e repassa ao verdadeiro.
if [ "${1:-}" = "--version" ]; then exec "$CHK_REAL_PG_DUMP" --version; fi
adm() { ( . "$CHK_LIB"; parse_database_url "$CHK_ADMIN_URL"; "$CHK_REAL_PSQL" -X -At -q -v ON_ERROR_STOP=1 "$@" | tr -d '\r' ); }
n=0
[ -f "$CHK_STATE/n" ] && n="$(cat "$CHK_STATE/n")"
n=$((n + 1))
printf '%s' "$n" >"$CHK_STATE/n"
SEL="datname = '$CHK_DB' and usename = '$CHK_USER' and backend_type = 'client backend' and pid <> pg_backend_pid() and xact_start is not null"
adm -c "select '$n|' || pid || '|' || application_name || '|' || coalesce(state, '') || '|' || coalesce(wait_event, '') from pg_stat_activity where $SEL" >>"$CHK_STATE/obs.txt" || true
if [ "${CHK_FAIL_AT:-0}" = "$n" ]; then exit 1; fi
if [ "${CHK_SLOW_AT:-0}" = "$n" ]; then
  : >"$CHK_STATE/dormindo"
  for _ in $(seq 1 600); do [ -e "$CHK_STATE/liberar" ] && break; sleep 0.2; done
fi
if [ "${CHK_CRASH_AT:-0}" = "$n" ]; then
  # Morte súbita do cliente, como no cancelamento do runner: SIGKILL no script de backup e em todos os filhos dele
  # (o psql do segurador e este próprio shim). Nenhuma limpeza do script roda.
  filhos="$(pgrep -P "$PPID" 2>/dev/null | grep -vx "$$" || true)"
  # shellcheck disable=SC2086
  kill -KILL "$PPID" $filhos 2>/dev/null
  kill -KILL "$$"
  sleep 5
fi
"$CHK_REAL_PG_DUMP" "$@"
rc=$?
if [ "${CHK_KILL_AFTER:-0}" = "$n" ]; then
  adm -c "select pg_terminate_backend(pid) from pg_stat_activity where $SEL" >/dev/null || true
  sleep 0.5
fi
exit "$rc"
SHIM
cat >"$ROOT/shim/age" <<'SHIM'
#!/usr/bin/env bash
if [ "${CHK_AGE_FALHA:-0}" = "1" ] && [ "${1:-}" = "--encrypt" ]; then exit 1; fi
exec "$CHK_REAL_AGE" "$@"
SHIM
cat >"$ROOT/shim/sha256sum" <<'SHIM'
#!/usr/bin/env bash
if [ "${CHK_SHA_FALHA:-0}" = "1" ]; then exit 1; fi
exec "$CHK_REAL_SHA" "$@"
SHIM
chmod +x "$ROOT/shim/pg_dump" "$ROOT/shim/age" "$ROOT/shim/sha256sum"

export CHK_REAL_PG_DUMP="$REAL_PG_DUMP" CHK_REAL_PSQL="$REAL_PSQL" CHK_REAL_AGE="$REAL_AGE" CHK_REAL_SHA="$REAL_SHA"
export CHK_LIB="$SCRIPTS/lib.sh" CHK_ADMIN_URL="$ADMIN_URL" CHK_DB="$DB" CHK_USER="$DBUSER" CHK_STATE="$STATE"

novo_estado() { rm -rf "$STATE"; mkdir -p "$STATE"; : >"$STATE/obs.txt"; }

# Roda o backup real (com os shims na frente do PATH). $1 = nome do cenário; resto = VAR=valor do cenário.
RC=0
SAIDA=""
roda() {
  local nome="$1"
  shift
  novo_estado
  SAIDA="$ROOT/out_$nome"
  rm -rf "$SAIDA"
  RC=0
  env "$@" PATH="$ROOT/shim:$PATH" BACKUP_DATABASE_URL="$BACKUP_URL" BACKUP_AGE_PUBLIC_KEY="$PUB" BACKUP_OUTPUT_DIR="$SAIDA" \
    bash "$SCRIPTS/backup-db.sh" >"$LOG" 2>&1 || RC=$?
}

# O log só pode ter linhas de código fechado: nada de URL, senha, PID, snapshot, SQL ou dado.
log_fechado() {
  local linha
  [ -f "$LOG" ] || return 0
  while IFS= read -r linha; do
    linha="${linha%$'\r'}"
    [ -n "$linha" ] || continue
    if [[ "$linha" =~ ^backup_concluido:\ praxis-crm-backup-[0-9TZ]+\.tar\.gz\.age\ \([0-9]+\ bytes\)$ ]]; then continue; fi
    if [[ "$linha" =~ ^ERRO:\ [a-z_]+(:[a-z_]+)?$ ]]; then continue; fi
    if [[ "$linha" =~ ^AVISO:\ [a-z_]+$ ]]; then continue; fi
    return 1
  done <"$LOG"
  return 0
}
ultimo_erro() { grep -o '^ERRO: [a-z_:]*' "$LOG" 2>/dev/null | head -1 | cut -c7- || true; }
observados() { # PIDs vistos em transação durante os dumps (o segurador), sem as sessões-isca, que devem sobreviver
  awk -F'|' -v excl=" ${DECOYS[*]:-} " 'NF >= 2 && index(excl, " " $2 " ") == 0 { print $2 }' "$STATE/obs.txt" 2>/dev/null | sort -u | paste -sd, - || true
}
chamadas_com_sessao() { awk -F'|' 'NF >= 2 { c[$1] = 1 } END { n = 0; for (k in c) n++; print n }' "$STATE/obs.txt"; }
saida_vazia() { [ ! -e "$1" ] || [ -z "$(ls -A "$1")" ]; }

# Confere que, DEPOIS da saída do script, o segurador sumiu por completo. $1 = nome do cenário.
confere_limpeza() {
  local nome="$1" pids
  pids="$(observados)"
  if [ -z "$pids" ]; then
    bad "$nome: o segurador do snapshot não foi visto em nenhuma chamada ao pg_dump (teste vazio)"
    return
  fi
  local i n=1
  for i in $(seq 1 40); do
    n="$(pids_existentes "$pids")"
    [ "$n" = "0" ] && break
    sleep 0.2
  done
  if [ "$n" = "0" ]; then
    ok "$nome: a sessão do segurador não existe mais (PID observado: nenhum em pg_stat_activity)"
  else
    LEAKED+=("$(adm -c "select string_agg(pid::text, ',') from pg_stat_activity where pid = any (array[$pids]::int[])" | tr ',' ' ')")
    bad "$nome: SOBROU sessão do segurador depois da saída do script ($n sessão(ões); PIDs observados: $pids)"
  fi
  [ "$(travas_de "$pids")" = "0" ] && ok "$nome: nenhuma trava (pg_locks) do segurador" || bad "$nome: sobraram travas do segurador"
  if sem_sessoes; then
    ok "$nome: nenhuma sessão com o rótulo do segurador, em pg_sleep ou em transação aberta"
  else
    LEAKED+=("${LEFT//,/ }")
    bad "$nome: sobrou sessão em transação/pg_sleep/rótulo do segurador (PIDs: $LEFT)"
  fi
  log_fechado && ok "$nome: o log só tem códigos fechados (sem URL, senha, PID, snapshot, SQL ou dado)" || bad "$nome: o log tem texto fora dos códigos fechados"
}

confere_falha_limpa() { # $1 = nome; $2 = erro esperado ("" = qualquer); falha fechada, sem saída e sem temporário
  local nome="$1" esperado="$2" erro
  erro="$(ultimo_erro)"
  [ "$RC" != "0" ] && ok "$nome: o backup falhou fechado (código $RC)" || bad "$nome: o backup NÃO falhou (código 0)"
  if [ -n "$esperado" ]; then
    [ "$erro" = "$esperado" ] && ok "$nome: erro fechado $esperado" || bad "$nome: esperava ERRO: $esperado, veio '${erro:-nenhum}'"
  fi
  saida_vazia "$SAIDA" && ok "$nome: nenhuma saída (nem pacote parcial)" || bad "$nome: sobrou saída"
  [ -z "$(ls -A "$TMPDIR")" ] && ok "$nome: nenhum temporário em texto claro" || bad "$nome: sobrou temporário"
}

# ------------------------------------------------------------------------------------------------------
echo "== 1. sucesso: o segurador existe enquanto os dumps rodam e some antes de o backup ser declarado concluído"
roda s1
[ "$RC" = "0" ] && ok "o backup terminou normalmente (código 0)" || bad "backup falhou com código $RC ($(ultimo_erro))"
[ "$(cat "$STATE/n" 2>/dev/null || echo 0)" = "4" ] && ok "os 4 dumps passaram pelo pg_dump observado" || bad "esperava 4 chamadas ao pg_dump"
[ "$(chamadas_com_sessao)" = "4" ] && ok "em CADA um dos 4 dumps havia uma sessão em transação (o segurador)" || bad "faltou sessão em transação durante algum dump"
grep -q "|$LABEL|" "$STATE/obs.txt" && ok "a sessão do segurador usa o application_name exclusivo '$LABEL'" || bad "nenhuma sessão com o application_name '$LABEL' durante os dumps"
[ "$(ls -A "$SAIDA" | wc -l | tr -d ' ')" = "2" ] && ok "a saída tem só o pacote criptografado e o checksum" || bad "a saída não tem exatamente 2 arquivos"
if grep -q '^AVISO:' "$LOG"; then
  bad "o segurador NÃO encerrou sozinho (COMMIT + fim da sessão): foi preciso o último recurso"
else
  ok "o segurador encerrou sozinho (COMMIT + fim da sessão), sem precisar do último recurso"
fi
confere_limpeza "sucesso"

echo "== 2. falha de dump (no 3º dump): a limpeza roda e não sobra nada"
roda s2 CHK_FAIL_AT=3
confere_falha_limpa "falha de dump" "dump_falhou:data_auth"
confere_limpeza "falha de dump"

echo "== 3. falha de criptografia"
roda s3 CHK_AGE_FALHA=1
confere_falha_limpa "falha de criptografia" "criptografia_falhou"
confere_limpeza "falha de criptografia"

echo "== 4. falha do manifesto"
roda s4 CHK_SHA_FALHA=1
confere_falha_limpa "falha do manifesto" "manifesto_falhou"
confere_limpeza "falha do manifesto"

echo "== 5. sinal (TERM) no meio dos dumps"
novo_estado
SAIDA="$ROOT/out_s5"
rm -rf "$SAIDA"
env CHK_SLOW_AT=2 PATH="$ROOT/shim:$PATH" BACKUP_DATABASE_URL="$BACKUP_URL" BACKUP_AGE_PUBLIC_KEY="$PUB" BACKUP_OUTPUT_DIR="$SAIDA" bash "$SCRIPTS/backup-db.sh" >"$LOG" 2>&1 &
PID5=$!
for _ in $(seq 1 300); do [ -e "$STATE/dormindo" ] && break; sleep 0.2; done
if [ -e "$STATE/dormindo" ]; then
  kill -TERM "$PID5" 2>/dev/null || true
  sleep 0.3
  : >"$STATE/liberar"
  RC=0
  wait "$PID5" 2>/dev/null || RC=$?
  confere_falha_limpa "sinal" ""
  confere_limpeza "sinal"
else
  kill "$PID5" 2>/dev/null || true
  bad "sinal: o backup não chegou ao 2º dump"
fi

echo "== 6. queda inesperada da sessão do snapshot: falha fechada"
roda s6a CHK_KILL_AFTER=2
confere_falha_limpa "queda no meio" "snapshot_falhou"
confere_limpeza "queda no meio"
roda s6b CHK_KILL_AFTER=4
confere_falha_limpa "queda no último dump" "snapshot_falhou"
confere_limpeza "queda no último dump"

echo "== 7. o cliente morre de repente (kill -9 da árvore): o servidor não pode ficar com a sessão"
if [ "$(uname -s)" = "Linux" ] && command -v pgrep >/dev/null 2>&1; then
  roda s7 CHK_CRASH_AT=2
  [ "$RC" = "137" ] && ok "o script e os filhos dele morreram por SIGKILL (código 137), sem rodar nenhuma limpeza" || bad "esperava a morte por SIGKILL (código 137), veio $RC"
  rm -rf "$TMPDIR"/* 2>/dev/null || true # sobras da árvore morta sem limpeza: só o servidor está em jogo aqui
  confere_limpeza "morte do cliente"
else
  echo "   (pulado: precisa de Linux e pgrep para matar a árvore do cliente; o CI roda este cenário)"
fi

echo "== 8. sessão presa no servidor: o último recurso derruba SÓ o segurador e poupa as sessões-isca"
# Duas iscas em transação aberta, do MESMO usuário do backup (não o administrador: no CI são usuários diferentes):
# uma com o MESMO rótulo do segurador e outra com outro rótulo.
( parse_database_url "$BACKUP_URL"; psql -X -q -At -c "begin; set local application_name = '$LABEL'; select pg_sleep(120);" >/dev/null 2>&1 ) &
( parse_database_url "$BACKUP_URL"; psql -X -q -At -c "begin; set local application_name = 'outra-aplicacao'; select pg_sleep(120);" >/dev/null 2>&1 ) &
ISCAS=""
for _ in $(seq 1 50); do
  ISCAS="$(adm -c "select pid from pg_stat_activity where datname = '$DB' and usename = '$DBUSER' and wait_event = 'PgSleep' and application_name in ('$LABEL', 'outra-aplicacao') order by pid" | paste -sd, -)"
  [ "$(printf '%s' "$ISCAS" | tr ',' '\n' | grep -c .)" = "2" ] && break
  sleep 0.2
done
if [ "$(printf '%s' "$ISCAS" | tr ',' '\n' | grep -c .)" = "2" ]; then
  # shellcheck disable=SC2206
  DECOYS=(${ISCAS//,/ })
  ok "duas sessões-isca criadas (mesmo usuário, transação aberta; uma com o MESMO rótulo do segurador)"
  cat >"$ROOT/shim/psql" <<'SHIM'
#!/usr/bin/env bash
# psql de mentira: SÓ a sessão do snapshot (a que lê o SQL da entrada padrão) recebe, logo depois do READY, uma
# consulta longa (pg_sleep) — simula uma sessão no servidor que não responde mais ao COMMIT nem ao fim.
case " $* " in
  *" -c "*|*" --version "*) exec "$CHK_REAL_PSQL" "$@" ;;
esac
exec 3<&0
exec "$CHK_REAL_PSQL" "$@" < <(awk '{ print; fflush() } /^select .READY.;$/ { print "select pg_sleep(40);"; fflush() }' <&3)
SHIM
  chmod +x "$ROOT/shim/psql"
  roda s8
  rm -f "$ROOT/shim/psql"
  [ "$RC" = "0" ] && ok "o backup concluiu mesmo com a sessão presa (código 0)" || bad "o backup falhou com código $RC ($(ultimo_erro))"
  grep -q '^AVISO: segurador_encerrado_por_fallback$' "$LOG" && ok "o log registra o último recurso com um código fechado (AVISO: segurador_encerrado_por_fallback)" || bad "faltou o aviso do último recurso"
  [ "$(ls -A "$SAIDA" 2>/dev/null | wc -l | tr -d ' ')" = "2" ] && ok "a saída tem só o pacote criptografado e o checksum" || bad "saída incompleta"
  vivas="$(adm -c "select count(*) from pg_stat_activity where pid = any (array[$ISCAS]::int[]) and wait_event = 'PgSleep'")"
  [ "$vivas" = "2" ] && ok "as duas sessões-isca (inclusive a de MESMO rótulo) sobreviveram: o último recurso só atinge a identidade exata do segurador" || bad "o último recurso derrubou uma sessão que não era a do segurador (iscas vivas: $vivas de 2)"
  confere_limpeza "sessão presa"
else
  bad "sessão presa: não foi possível criar as sessões-isca"
fi

if [ "$FAILS" -gt 0 ]; then
  printf '\n%s verificação(ões) falharam\n' "$FAILS" >&2
  exit 1
fi
echo
echo "sessão do snapshot do backup (B6c): OK"
