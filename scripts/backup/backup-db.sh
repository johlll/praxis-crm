#!/usr/bin/env bash
# B6c — backup lógico CRIPTOGRAFADO do banco do Praxis (formato praxis-backup/v2).
#
# Entrada (somente variáveis de ambiente):
#   BACKUP_DATABASE_URL    URL postgresql:// do banco de ORIGEM (segredo; nunca vira argumento nem log)
#   BACKUP_AGE_PUBLIC_KEY  chave PÚBLICA age ("age1..."); a privada NUNCA passa por aqui
#   BACKUP_OUTPUT_DIR      pasta de saída (padrão: ./backup-out)
#
# Saída: SOMENTE  praxis-crm-backup-<UTC>.tar.gz.age  e  praxis-crm-backup-<UTC>.tar.gz.age.sha256
#
# O pacote (antes de criptografar) é um .tar.gz com manifest.json e 5 arquivos SQL:
#   01-schema-auth.sql, 02-schema-app.sql, 03-schema-auth-triggers.sql, 04-data-auth.sql, 05-data-app.sql
# (auth.users e auth.identities + schemas public, private e supabase_migrations; Storage NÃO entra).
#
# UM ÚNICO SNAPSHOT: tudo o que entra no pacote (os 4 dumps, as contagens de estrutura e a conferência de
# linhas do manifesto) enxerga exatamente o mesmo instante do banco. Uma sessão auxiliar abre uma
# transação REPEATABLE READ, READ ONLY, exporta o snapshot (pg_export_snapshot) e o MANTÉM ABERTO; cada
# pg_dump usa esse snapshot (--snapshot) e as consultas de catálogo rodam dentro dessa mesma transação.
# Nenhuma escrita é bloqueada (a transação é só de leitura e só ela segura o snapshot; o pg_dump pega apenas
# ACCESS SHARE) e a produção não é pausada.
#
# Nada de texto claro sobrevive: a pasta de trabalho é apagada ao terminar OU falhar, e uma falha
# também remove qualquer saída parcial. Só imprime códigos fechados — nunca URL, senha, SQL ou dado.
set -euo pipefail
umask 077

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$HERE/lib.sh"

WORK=""
HOLDER_PID=""
OUT_FILES=()
OK=0
stop_holder() { # encerra a sessão que segura o snapshot (a transação some junto)
  if [ -n "$HOLDER_PID" ]; then
    kill "$HOLDER_PID" 2>/dev/null || true
    wait "$HOLDER_PID" 2>/dev/null || true
    HOLDER_PID=""
  fi
}
cleanup() {
  local rc=$?
  trap - EXIT
  stop_holder
  [ -n "$WORK" ] && rm -rf "$WORK"
  if [ "$OK" -ne 1 ]; then
    [ "${#OUT_FILES[@]}" -gt 0 ] && rm -f "${OUT_FILES[@]}"
  fi
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# ---- 1. Entrada: falha fechada -------------------------------------------------------------
[ -n "${BACKUP_DATABASE_URL:-}" ] || die "backup_url_ausente" 64
[ -n "${BACKUP_AGE_PUBLIC_KEY:-}" ] || die "chave_publica_ausente" 64
case "$BACKUP_AGE_PUBLIC_KEY" in
  age1*) ;;
  *) die "chave_publica_invalida" 64 ;;
esac
[[ "$BACKUP_AGE_PUBLIC_KEY" =~ ^age1[0-9a-z]{58}$ ]] || die "chave_publica_invalida" 64
RECIPIENT="$BACKUP_AGE_PUBLIC_KEY"
unset BACKUP_AGE_PUBLIC_KEY

for tool in pg_dump psql age tar gzip sha256sum awk mktemp; do need_tool "$tool"; done
pg_major_ok pg_dump || die "pg_dump_versao_incorreta" 69
pg_major_ok psql || die "psql_versao_incorreta" 69

OUT="${BACKUP_OUTPUT_DIR:-backup-out}"

# ---- 2. Conexão: a URL vira variáveis PG* e some -------------------------------------------
parse_database_url "$BACKUP_DATABASE_URL" || die "backup_url_invalida" 64
unset BACKUP_DATABASE_URL

WORK="$(mktemp -d)"
chmod 700 "$WORK"
PKG="$WORK/pkg"
mkdir "$PKG"
ERR="$WORK/.ferramentas.log" # saída das ferramentas: nunca lida nem impressa

SERVER_VERSION="$(psql -X -At -c 'show server_version' 2>"$ERR")" || die "conexao_falhou" 69
[[ "$SERVER_VERSION" =~ ^[0-9]+(\.[0-9]+)?([[:space:]].*)?$ ]] || die "conexao_falhou" 69
PG_DUMP_VERSION="$(pg_dump --version | sed -e 's/^pg_dump (PostgreSQL) //')"

# ---- 3. Snapshot único: a sessão auxiliar o exporta e o mantém aberto -------------------------
# A mesma transação (REPEATABLE READ, READ ONLY) responde às consultas de catálogo e de contagem; os
# dumps entram nela pelo snapshot exportado. Quem segura o snapshot não escreve nem trava ninguém.
HOLDER_OUT="$WORK/.snapshot.out"
HOLDER_ERR="$WORK/.snapshot.err" # nunca lido nem impresso
: >"$HOLDER_OUT"
psql -X -At -q -v ON_ERROR_STOP=1 >"$HOLDER_OUT" 2>"$HOLDER_ERR" <<'SQL' &
begin isolation level repeatable read read only;
set local statement_timeout = 0;
set local idle_in_transaction_session_timeout = 0;
select 'SNAPSHOT:' || pg_export_snapshot();
with t as (
  select c.oid, c.relname, n.nspname
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where c.relkind in ('r', 'p')
    and (n.nspname in ('public', 'private', 'supabase_migrations')
         or (n.nspname = 'auth' and c.relname in ('users', 'identities')))
)
select 'tables=' || count(*) from t
union all select 'constraints_p=' || count(*) from pg_constraint k join t on t.oid = k.conrelid where k.contype = 'p'
union all select 'constraints_f=' || count(*) from pg_constraint k join t on t.oid = k.conrelid where k.contype = 'f'
union all select 'constraints_u=' || count(*) from pg_constraint k join t on t.oid = k.conrelid where k.contype = 'u'
union all select 'constraints_c=' || count(*) from pg_constraint k join t on t.oid = k.conrelid where k.contype = 'c'
union all select 'rls_enabled=' || count(*) from pg_class c join t on t.oid = c.oid where c.relrowsecurity
union all select 'rls_forced=' || count(*) from pg_class c join t on t.oid = c.oid where c.relforcerowsecurity
union all select 'policies=' || count(*) from pg_policy p join t on t.oid = p.polrelid
union all select 'triggers=' || count(*) from pg_trigger g join t on t.oid = g.tgrelid where not g.tgisinternal
union all select 'functions=' || count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname in ('public', 'private', 'supabase_migrations')
union all select 'ROWS:' || t.nspname || '.' || t.relname || ':'
  || (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I', t.nspname, t.relname), false, true, '')))[1]::text
  from t;
select 'READY';
select pg_sleep(14400);
SQL
HOLDER_PID=$!

# Espera a sessão publicar o snapshot e as contagens (até ~2 min). Se ela morrer, o backup para.
READY=0
for _ in $(seq 1 600); do
  if grep -q '^READY' "$HOLDER_OUT" 2>/dev/null; then READY=1; break; fi
  kill -0 "$HOLDER_PID" 2>/dev/null || break
  sleep 0.2
done
[ "$READY" -eq 1 ] || die "snapshot_falhou" 70

SNAPSHOT_ID=""
while IFS= read -r linha; do
  linha="${linha%$'\r'}"
  case "$linha" in SNAPSHOT:*) SNAPSHOT_ID="${linha#SNAPSHOT:}" ;; esac
done <"$HOLDER_OUT"
[[ "$SNAPSHOT_ID" =~ ^[0-9A-Fa-f]+(-[0-9A-Fa-f]+)+$ ]] || die "snapshot_falhou" 70

# ---- 4. Dumps: todos no MESMO snapshot (qualquer falha para tudo) --------------------------------
dump() { # $1 = etapa; $2 = arquivo; resto = argumentos do pg_dump (a conexão vem do ambiente)
  local etapa="$1" arquivo="$2"
  shift 2
  kill -0 "$HOLDER_PID" 2>/dev/null || die "snapshot_falhou" 70
  pg_dump --snapshot="$SNAPSHOT_ID" --no-owner --quote-all-identifiers --no-publications --no-subscriptions --file="$arquivo" "$@" 2>"$ERR" || die "dump_falhou:$etapa" 70
  [ -s "$arquivo" ] || die "dump_falhou:$etapa" 70
}

AUTH_TABLES=(--table=auth.users --table=auth.identities)
APP_SCHEMAS=(--schema=public --schema=private --schema=supabase_migrations)

dump schema_auth "$WORK/auth-schema.full.sql" --schema-only --no-privileges "${AUTH_TABLES[@]}"
dump schema_app "$PKG/02-schema-app.sql" --schema-only --exclude-extension='*' "${APP_SCHEMAS[@]}"
dump data_auth "$PKG/04-data-auth.sql" --data-only --no-privileges "${AUTH_TABLES[@]}"
dump data_app "$PKG/05-data-app.sql" --data-only --no-privileges "${APP_SCHEMAS[@]}"

# Os gatilhos de auth.users apontam para funções do schema private (que nascem no 02): ficam num
# arquivo à parte, aplicado depois. O resto do schema de auth vai primeiro.
awk -v main="$PKG/01-schema-auth.sql" -v trg="$PKG/03-schema-auth-triggers.sql" '
  BEGIN { intrg = 0 }
  { sub(/\r$/, "") }
  /^CREATE TRIGGER / { intrg = 1 }
  {
    if (intrg) { print > trg; if ($0 ~ /;[[:space:]]*$/) intrg = 0 }
    else print > main
  }
  END { close(main); close(trg) }
' "$WORK/auth-schema.full.sql" || die "dump_falhou:schema_auth" 70
[ -f "$PKG/03-schema-auth-triggers.sql" ] || : >"$PKG/03-schema-auth-triggers.sql"
[ -s "$PKG/01-schema-auth.sql" ] || die "dump_falhou:schema_auth" 70
rm -f "$WORK/auth-schema.full.sql"

# O snapshot já não é necessário: a sessão que o segurava termina aqui (e só se ainda estava viva).
kill -0 "$HOLDER_PID" 2>/dev/null || die "snapshot_falhou" 70
stop_holder

# ---- 4b. Contagens para a validação da restauração (só números) ----------------------------------
# Linhas por tabela, tiradas do PRÓPRIO dump de dados (mesmo snapshot): cada bloco COPY.
ROWS_FILE="$WORK/.linhas.tsv"
awk '
  { sub(/\r$/, "") }
  /^COPY / { name = $2; gsub(/"/, "", name); n = 0; incopy = 1; next }
  incopy && /^\\\.$/ { print name "\t" n; incopy = 0; next }
  incopy { n++ }
' "$PKG/04-data-auth.sql" "$PKG/05-data-app.sql" >"$ROWS_FILE" || die "manifesto_falhou" 70

# Conferência cruzada: as linhas dos dumps têm de bater, tabela a tabela, com a contagem tirada DENTRO do
# snapshot pela sessão auxiliar. Se algum dump tivesse lido outro instante, divergiria aqui.
SNAP_ROWS="$WORK/.linhas-snapshot.tsv"
awk '{ sub(/\r$/, "") } /^ROWS:/ { s = substr($0, 6); i = match(s, /:[0-9]+$/); if (i > 0) print substr(s, 1, i - 1) "\t" substr(s, i + 1) }' "$HOLDER_OUT" >"$SNAP_ROWS" || die "manifesto_falhou" 70
[ -s "$SNAP_ROWS" ] || die "manifesto_falhou" 70
awk -F'\t' '
  NR == FNR { d[$1] = $2; next }
  { s[$1] = $2 }
  END {
    for (k in d) if (!(k in s)) exit 1
    for (k in s) { v = (k in d) ? d[k] : 0; if (v != s[k]) exit 1 }
  }
' "$ROWS_FILE" "$SNAP_ROWS" || die "snapshot_inconsistente" 70

# Estrutura (catálogo): lida pela mesma sessão, dentro do MESMO snapshot.
STRUCT_FILE="$HOLDER_OUT"

# Lê cada contagem da estrutura para uma variável S_<chave> (no shell atual: se faltar, o script para).
load_struct() { # $1 = chave
  local linha v=""
  while IFS= read -r linha; do
    linha="${linha%$'\r'}"
    case "$linha" in "$1="*) v="${linha#*=}" ;; esac
  done <"$STRUCT_FILE"
  [[ "$v" =~ ^[0-9]+$ ]] || die "manifesto_falhou" 70
  printf -v "S_$1" '%s' "$v"
}
for chave in tables constraints_p constraints_f constraints_u constraints_c rls_enabled rls_forced policies triggers functions; do
  load_struct "$chave"
done

declare -A FILE_HASH
for arquivo in "${PRAXIS_PKG_FILES[@]}"; do
  FILE_HASH["$arquivo"]="$(sha256_of "$PKG/$arquivo")" || die "manifesto_falhou" 70
  is_sha256 "${FILE_HASH[$arquivo]}" || die "manifesto_falhou" 70
done

# ---- 5. Manifesto --------------------------------------------------------------------------
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
CREATED="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
{
  printf '{\n'
  printf '  "format": "%s",\n' "$PRAXIS_BACKUP_FORMAT"
  printf '  "created_at_utc": "%s",\n' "$CREATED"
  printf '  "postgres_server_version": "%s",\n' "${SERVER_VERSION%% *}"
  printf '  "pg_dump_version": "%s",\n' "${PG_DUMP_VERSION%% *}"
  printf '  "snapshot": "%s",\n' "$PRAXIS_BACKUP_SNAPSHOT"
  printf '  "schemas": ["public", "private", "supabase_migrations", "auth.users", "auth.identities"],\n'
  printf '  "files": {\n'
  i=0
  for f in "${PRAXIS_PKG_FILES[@]}"; do
    i=$((i + 1))
    sep=","
    [ "$i" -eq "${#PRAXIS_PKG_FILES[@]}" ] && sep=""
    printf '    "%s": "%s"%s\n' "$f" "${FILE_HASH[$f]}" "$sep"
  done
  printf '  },\n'
  printf '  "expected": {\n'
  printf '    "tables": %s,\n' "$S_tables"
  printf '    "constraints_p": %s,\n' "$S_constraints_p"
  printf '    "constraints_f": %s,\n' "$S_constraints_f"
  printf '    "constraints_u": %s,\n' "$S_constraints_u"
  printf '    "constraints_c": %s,\n' "$S_constraints_c"
  printf '    "rls_enabled": %s,\n' "$S_rls_enabled"
  printf '    "rls_forced": %s,\n' "$S_rls_forced"
  printf '    "policies": %s,\n' "$S_policies"
  printf '    "triggers": %s,\n' "$S_triggers"
  printf '    "functions": %s\n' "$S_functions"
  printf '  },\n'
  printf '  "row_counts": {\n'
  total="$(wc -l <"$ROWS_FILE" | tr -d ' ')"
  i=0
  while IFS=$'\t' read -r nome linhas; do
    linhas="${linhas%$'\r'}"
    i=$((i + 1))
    [[ "$nome" =~ ^[A-Za-z0-9_]+\.[A-Za-z0-9_]+$ ]] || die "manifesto_falhou" 70
    [[ "$linhas" =~ ^[0-9]+$ ]] || die "manifesto_falhou" 70
    sep=","
    [ "$i" -eq "$total" ] && sep=""
    printf '    "%s": %s%s\n' "$nome" "$linhas" "$sep"
  done <"$ROWS_FILE"
  printf '  }\n'
  printf '}\n'
} >"$PKG/manifest.json" || die "manifesto_falhou" 70

# ---- 6. Compactar e criptografar (só chave pública) ----------------------------------------
tar -C "$PKG" -czf "$WORK/pacote.tar.gz" manifest.json "${PRAXIS_PKG_FILES[@]}" 2>"$ERR" || die "compactacao_falhou" 70
age --encrypt --recipient "$RECIPIENT" --output "$WORK/pacote.tar.gz.age" "$WORK/pacote.tar.gz" 2>"$ERR" || die "criptografia_falhou" 70
[ -s "$WORK/pacote.tar.gz.age" ] || die "criptografia_falhou" 70

# O texto claro já não é mais necessário: sai agora, antes de qualquer outra coisa.
rm -rf "$PKG" "$WORK/pacote.tar.gz" "$ROWS_FILE" "$SNAP_ROWS" "$HOLDER_OUT"

# ---- 7. Saída: só o .age e o checksum do arquivo JÁ criptografado --------------------------
mkdir -p "$OUT" || die "saida_falhou" 73
chmod 700 "$OUT" 2>/dev/null || true
NAME="praxis-crm-backup-${STAMP}.tar.gz.age"
[ ! -e "$OUT/$NAME" ] || die "saida_ja_existe" 73
OUT_FILES=("$OUT/$NAME" "$OUT/$NAME.sha256")
mv "$WORK/pacote.tar.gz.age" "$OUT/$NAME" || die "saida_falhou" 73
HASH="$(sha256_of "$OUT/$NAME")" || die "checksum_falhou" 70
is_sha256 "$HASH" || die "checksum_falhou" 70
printf '%s  %s\n' "$HASH" "$NAME" >"$OUT/$NAME.sha256" || die "checksum_falhou" 70
(cd "$OUT" && sha256sum --check --status "$NAME.sha256") || die "checksum_falhou" 70

OK=1
printf 'backup_concluido: %s (%s bytes)\n' "$NAME" "$(wc -c <"$OUT/$NAME" | tr -d ' ')"
