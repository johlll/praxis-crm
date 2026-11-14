#!/usr/bin/env bash
# B6c — prova de que o backup representa UM ÚNICO instante (snapshot) do banco, mesmo com escritas
# concorrentes no meio do backup. Usa as FERRAMENTAS REAIS (pg_dump/psql 17 e age) contra um banco
# SINTÉTICO/LOCAL; nenhum dado hospedado, nenhuma chave de verdade.
#
# Como a coordenação é feita: um "pg_dump" de mentira (shim) fica na frente do verdadeiro no PATH. ANTES de
# cada chamada ao pg_dump verdadeiro, ele confirma (COMMIT) uma escrita no banco de origem: um usuário novo
# em auth.users (o gatilho cria a linha em public.users) e a troca do e-mail de um usuário que já existia.
# Ou seja, as escritas acontecem ENTRE as etapas do backup. Se cada etapa enxergasse um instante próprio,
# o pacote juntaria usuários de um instante com dados da aplicação de outro.
#
# Resultado esperado: o pacote restaurado é IDÊNTICO (hash de todas as linhas de todas as tabelas) ao estado
# de ANTES do backup, ou ao de DEPOIS — nunca uma mistura. A restauração também tem de passar (constraints,
# FKs, contagens).
#
# Entrada: CHECK_BACKUP_URL, CHECK_RESTORE_SERVER_URL (superusuário do servidor local) e, opcionalmente,
# CHECK_SCRIPTS_DIR (pasta com backup-db.sh/restore-db.sh/lib.sh a testar; padrão: a desta pasta).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPTS="${CHECK_SCRIPTS_DIR:-$HERE}"
# shellcheck source=lib.sh
. "$SCRIPTS/lib.sh"

: "${CHECK_BACKUP_URL:?defina CHECK_BACKUP_URL}"
RESTORE_SERVER_URL="${CHECK_RESTORE_SERVER_URL:-$CHECK_BACKUP_URL}"
BACKUP_URL="$CHECK_BACKUP_URL"
unset CHECK_BACKUP_URL CHECK_RESTORE_SERVER_URL CHECK_SCRIPTS_DIR

FAILS=0
ok() { printf '   ok: %s\n' "$1"; }
bad() { printf '   FALHOU: %s\n' "$1" >&2; FAILS=$((FAILS + 1)); }

for tool in age age-keygen psql pg_dump tar sha256sum; do need_tool "$tool"; done
REAL_PG_DUMP="$(command -v pg_dump)"
REAL_PSQL="$(command -v psql)"

ROOT="$(mktemp -d)"
export TMPDIR="$ROOT/tmp"
mkdir -p "$TMPDIR" "$ROOT/shim" "$ROOT/out" "$ROOT/keys"
CREATED_DBS=()
TARGET_ID=""
cleanup() {
  local rc=$?
  trap - EXIT
  # Desfaz as escritas de teste na origem (usuários inseridos e e-mail trocado), aconteça o que acontecer.
  ( parse_database_url "$BACKUP_URL" && psql -X -q -c "delete from auth.users where email like 'concorrente-%@exemplo.invalid'" >/dev/null 2>&1 ) || true
  if [ -n "$TARGET_ID" ] && [ -n "${TARGET_EMAIL:-}" ]; then
    ( parse_database_url "$BACKUP_URL" && psql -X -q -c "update auth.users set email = '$TARGET_EMAIL' where id = '$TARGET_ID'" >/dev/null 2>&1 ) || true
  fi
  for db in "${CREATED_DBS[@]:-}"; do
    [ -n "$db" ] || continue
    ( parse_database_url "$RESTORE_SERVER_URL" && psql -X -q -c "drop database if exists \"$db\" with (force)" >/dev/null 2>&1 ) || true
  done
  rm -rf "$ROOT"
  exit "$rc"
}
trap cleanup EXIT

age-keygen -o "$ROOT/keys/id.txt" >/dev/null 2>&1
PUB="$(age-keygen -y "$ROOT/keys/id.txt")"
LOG="$ROOT/log.txt"

src() { ( parse_database_url "$BACKUP_URL"; psql -X -At -v ON_ERROR_STOP=1 "$@" | tr -d '\r' ); }
dst() { ( parse_database_url "$RESTORE_SERVER_URL"; PGDATABASE="$1"; export PGDATABASE; shift; psql -X -At -v ON_ERROR_STOP=1 "$@" | tr -d '\r' ); }

# Impressão digital: md5 do conteúdo de TODAS as linhas de cada tabela do escopo do backup.
FP_SQL="$ROOT/fp.sql"
cat >"$FP_SQL" <<'SQL'
select t.nspname || '.' || t.relname || '|' || (xpath('/row/c/text()', query_to_xml(format('select md5(coalesce(string_agg(md5(x::text), %L order by md5(x::text)), %L)) as c from %I.%I x', '', '', t.nspname, t.relname), false, true, '')))[1]::text
from (select c.relname, n.nspname from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where c.relkind in ('r', 'p') and (n.nspname in ('public', 'private', 'supabase_migrations') or (n.nspname = 'auth' and c.relname in ('users', 'identities')))) t
order by 1;
SQL

echo "== A. estado de ANTES do backup"
src -f "$FP_SQL" >"$ROOT/fp_antes.txt"
[ -s "$ROOT/fp_antes.txt" ] && ok "$(wc -l <"$ROOT/fp_antes.txt" | tr -d ' ') tabelas fotografadas (hash de todas as linhas)" || bad "não fotografou a origem"
USERS_ANTES="$(src -c "select count(*) from auth.users")"
TARGET_ID="$(src -c "select id from auth.users order by created_at, id limit 1")"
TARGET_EMAIL="$(src -c "select email from auth.users where id = '$TARGET_ID'")"
[ -n "$TARGET_ID" ] && [ -n "$TARGET_EMAIL" ] && ok "há um usuário preexistente para ter o e-mail trocado durante o backup ($USERS_ANTES usuários)" || bad "origem sem usuários"

echo "== B. backup real com escritas CONFIRMADAS entre as etapas"
cat >"$ROOT/shim/pg_dump" <<'SHIM'
#!/usr/bin/env bash
# pg_dump de mentira: antes de CADA chamada ao verdadeiro, uma escrita concorrente é confirmada na origem.
if [ "${1:-}" = "--version" ]; then exec "$SNAPCHK_REAL_PG_DUMP" --version; fi
n=0
[ -f "$SNAPCHK_STATE" ] && n="$(cat "$SNAPCHK_STATE")"
n=$((n + 1))
printf '%s' "$n" >"$SNAPCHK_STATE"
for a in "$@"; do case "$a" in --snapshot=*) printf '%s
' "${a#--snapshot=}" >>"$SNAPCHK_STATE.snaps" ;; esac; done
"$SNAPCHK_REAL_PSQL" -X -q -v ON_ERROR_STOP=1 >/dev/null 2>&1 <<SQL || exit 97
begin;
insert into auth.users (id, email) values (gen_random_uuid(), 'concorrente-$n@exemplo.invalid');
update auth.users set email = 'alterado-$n@exemplo.invalid' where id = '$SNAPCHK_TARGET_ID';
commit;
SQL
exec "$SNAPCHK_REAL_PG_DUMP" "$@"
SHIM
chmod +x "$ROOT/shim/pg_dump"
export SNAPCHK_STATE="$ROOT/chamadas.txt" SNAPCHK_REAL_PG_DUMP="$REAL_PG_DUMP" SNAPCHK_REAL_PSQL="$REAL_PSQL" SNAPCHK_TARGET_ID="$TARGET_ID"
rc=0
PATH="$ROOT/shim:$PATH" BACKUP_DATABASE_URL="$BACKUP_URL" BACKUP_AGE_PUBLIC_KEY="$PUB" BACKUP_OUTPUT_DIR="$ROOT/out" bash "$SCRIPTS/backup-db.sh" >"$LOG" 2>&1 || rc=$?
[ "$rc" = "0" ] && ok "o backup terminou normalmente (código 0)" || bad "backup falhou com código $rc"
CHAMADAS="$(cat "$ROOT/chamadas.txt" 2>/dev/null || echo 0)"
USERS_DEPOIS="$(src -c "select count(*) from auth.users")"
[ "$CHAMADAS" -ge 2 ] && [ "$USERS_DEPOIS" = "$((USERS_ANTES + CHAMADAS))" ] && ok "$CHAMADAS escritas foram confirmadas entre as etapas do backup (usuários: $USERS_ANTES -> $USERS_DEPOIS)" || bad "as escritas concorrentes não aconteceram como planejado (chamadas=$CHAMADAS, usuários $USERS_ANTES -> $USERS_DEPOIS)"
SNAPS_USADOS="$(sort -u "$ROOT/chamadas.txt.snaps" 2>/dev/null | grep -c . || true)"
SNAPS_CHAMADAS="$(grep -c . "$ROOT/chamadas.txt.snaps" 2>/dev/null || true)"
[ "$SNAPS_USADOS" = "1" ] && [ "$SNAPS_CHAMADAS" = "$CHAMADAS" ] && ok "as $CHAMADAS chamadas ao pg_dump usaram o MESMO snapshot exportado (--snapshot)" || bad "os dumps não usaram um único snapshot exportado (chamadas=$CHAMADAS, com snapshot=$SNAPS_CHAMADAS, distintos=$SNAPS_USADOS)"
src -f "$FP_SQL" >"$ROOT/fp_depois.txt"
diff -q "$ROOT/fp_antes.txt" "$ROOT/fp_depois.txt" >/dev/null && bad "o banco não mudou durante o backup (teste vazio)" || ok "o banco de origem MUDOU durante o backup (estado depois != estado antes)"

echo "== C. o que cada arquivo do pacote enxergou"
mapfile -t OUTFILES < <(ls -A "$ROOT/out" | grep -v '\.sha256$' || true)
[ "${#OUTFILES[@]}" -eq 1 ] || { bad "pacote não encontrado"; exit 1; }
PKG="$ROOT/out/${OUTFILES[0]}"
mkdir "$ROOT/x"
age --decrypt --identity "$ROOT/keys/id.txt" --output "$ROOT/p.tar.gz" "$PKG"
tar -C "$ROOT/x" -xzf "$ROOT/p.tar.gz"
rm -f "$ROOT/p.tar.gz"
DISTINTOS=""
for f in "$ROOT"/x/*data*.sql; do
  n="$(grep -c 'concorrente-[0-9]*@exemplo.invalid' "$f" || true)"
  a="$(grep -c 'alterado-[0-9]*@exemplo.invalid' "$f" || true)"
  printf '   %s: usuários concorrentes=%s e-mails trocados=%s\n' "$(basename "$f")" "$n" "$a"
  DISTINTOS="$DISTINTOS|$n/$a"
done
PADROES="$(printf '%s' "$DISTINTOS" | tr '|' '
' | grep -v '^$' | sort -u || true)"
NPADROES="$(printf '%s
' "$PADROES" | grep -c . || true)"
if [ "$PADROES" = "0/0" ]; then ok "nenhum arquivo de dados enxergou as escritas (todos no mesmo instante: o anterior)"
elif [ "$NPADROES" = "1" ]; then ok "todos os arquivos de dados enxergaram as mesmas escritas (todos no mesmo instante: o posterior)"
else bad "os arquivos do pacote enxergaram instantes DIFERENTES do banco (snapshots independentes)"; fi
rm -rf "$ROOT/x"

echo "== D. restaurar o pacote: constraints, FKs e contagens válidas, estado inteiro"
rc=0
RESTORE_DATABASE_URL="$RESTORE_SERVER_URL" bash "$SCRIPTS/restore-db.sh" --package "$PKG" --checksum "$PKG.sha256" --identity "$ROOT/keys/id.txt" >"$LOG" 2>&1 || rc=$?
if [ "$rc" = "0" ] && grep -q "restauracao_validada: banco=praxis_restore_" "$LOG"; then
  ok "restauração aceita pela validação (estrutura, linhas por tabela e FKs sem órfãos)"
  RDB="$(grep -o 'banco=praxis_restore_[0-9TZ]*' "$LOG" | head -1 | cut -d= -f2)"
  CREATED_DBS+=("$RDB")
  dst "$RDB" -f "$FP_SQL" >"$ROOT/fp_restaurado.txt"
  if diff -q "$ROOT/fp_antes.txt" "$ROOT/fp_restaurado.txt" >/dev/null; then ok "o banco restaurado é IDÊNTICO ao estado de ANTES do backup (todas as linhas de todas as tabelas)"
  elif diff -q "$ROOT/fp_depois.txt" "$ROOT/fp_restaurado.txt" >/dev/null; then ok "o banco restaurado é IDÊNTICO ao estado de DEPOIS do backup (todas as linhas de todas as tabelas)"
  else bad "o banco restaurado é uma MISTURA: não é nem o estado anterior nem o posterior"; fi
else
  bad "a restauração recusou o pacote (código $rc): $(grep -o 'ERRO: [a-z_:]*' "$LOG" | head -1)"
fi

echo "== E. se a sessão que segura o snapshot morrer, o backup falha fechado e não deixa nada"
rm -f "$ROOT/shim/pg_dump"
cat >"$ROOT/shim/psql" <<SHIM
#!/usr/bin/env bash
case " \$* " in
  *" -c "*|*" --version "*) exec "$REAL_PSQL" "\$@" ;;
  *) exit 1 ;;   # a sessão do snapshot cai logo no início (sem ler a entrada, como um psql que não conecta)
esac
SHIM
chmod +x "$ROOT/shim/psql"
rm -rf "$ROOT/out_e"
rc=0
PATH="$ROOT/shim:$PATH" BACKUP_DATABASE_URL="$BACKUP_URL" BACKUP_AGE_PUBLIC_KEY="$PUB" BACKUP_OUTPUT_DIR="$ROOT/out_e" bash "$SCRIPTS/backup-db.sh" >"$LOG" 2>&1 || rc=$?
if [ "$rc" = "70" ] && grep -q "ERRO: snapshot_falhou" "$LOG"; then ok "sem snapshot, nenhum dump é feito: erro fechado snapshot_falhou (código 70)"; else bad "esperava snapshot_falhou/70, veio $rc"; fi
[ ! -e "$ROOT/out_e" ] && [ -z "$(ls -A "$TMPDIR")" ] && ok "nada ficou (nem saída, nem temporário)" || bad "sobrou arquivo"
rm -f "$ROOT/shim/psql"

if [ "$FAILS" -gt 0 ]; then
  printf '\n%s verificação(ões) falharam\n' "$FAILS" >&2
  exit 1
fi
echo
echo "snapshot único do backup (B6c): OK"
