#!/usr/bin/env bash
# B6c — prova do backup criptografado e da restauração com as FERRAMENTAS REAIS (pg_dump/psql 17 e
# age) contra um banco SINTÉTICO/LOCAL. Nenhum dado hospedado, nenhuma chave de verdade.
#
# Entrada (variáveis de ambiente):
#   CHECK_BACKUP_URL          URL do banco local de ORIGEM (o que o backup lê)
#   CHECK_RESTORE_SERVER_URL  URL de um SUPERUSUÁRIO do servidor local onde os bancos de restauração
#                             são criados (padrão: a mesma de CHECK_BACKUP_URL)
#
# Cobre: backup falha fechado sem URL; chave privada recusada no lugar da pública; URL/senha fora de
# argumentos e de logs; falha do dump e da criptografia sem sobra em texto claro; pacote final só com
# o .age e o checksum; checksum válido aceito e inválido bloqueado; chave errada bloqueada; destino
# hospedado/Production recusado antes de qualquer ferramenta; restauração local descartável fiel
# (todas as tabelas com o mesmo hash) com constraints e FKs válidas; pacote adulterado e contagem
# divergente falham e não deixam banco nem arquivo para trás.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$HERE/lib.sh"

: "${CHECK_BACKUP_URL:?defina CHECK_BACKUP_URL}"
RESTORE_SERVER_URL="${CHECK_RESTORE_SERVER_URL:-$CHECK_BACKUP_URL}"
BACKUP_URL="$CHECK_BACKUP_URL"
unset CHECK_BACKUP_URL CHECK_RESTORE_SERVER_URL

FAILS=0
ok() { printf '   ok: %s\n' "$1"; }
bad() { printf '   FALHOU: %s\n' "$1" >&2; FAILS=$((FAILS + 1)); }

for tool in age age-keygen psql pg_dump tar sha256sum; do need_tool "$tool"; done
REAL_PG_DUMP="$(command -v pg_dump)"
REAL_AGE="$(command -v age)"

ROOT="$(mktemp -d)"
export TMPDIR="$ROOT/tmp" # tudo o que os scripts criarem de temporário cai aqui: tem de voltar vazio
mkdir -p "$TMPDIR" "$ROOT/keys" "$ROOT/shim" "$ROOT/out"
CREATED_DBS=()
cleanup() {
  local rc=$?
  trap - EXIT
  for db in "${CREATED_DBS[@]:-}"; do
    [ -n "$db" ] || continue
    ( parse_database_url "$RESTORE_SERVER_URL" && psql -X -q -c "drop database if exists \"$db\" with (force)" >/dev/null 2>&1 ) || true
  done
  rm -rf "$ROOT"
  exit "$rc"
}
trap cleanup EXIT

age-keygen -o "$ROOT/keys/id1.txt" >/dev/null 2>&1
age-keygen -o "$ROOT/keys/id2.txt" >/dev/null 2>&1
PUB1="$(age-keygen -y "$ROOT/keys/id1.txt")"
PUB2="$(age-keygen -y "$ROOT/keys/id2.txt")"

BACKUP="$HERE/backup-db.sh"
RESTORE="$HERE/restore-db.sh"
LOG="$ROOT/log.txt"

tmp_empty() { [ -z "$(ls -A "$TMPDIR")" ]; }
list_restore_dbs() { ( parse_database_url "$RESTORE_SERVER_URL" && psql -X -At -c "select datname from pg_database where datname like 'praxis_restore_%' order by 1" | tr -d '\r' ); }

run_backup() { # $1 = pasta de saída; usa PUB1; saída em $LOG; devolve o código
  BACKUP_DATABASE_URL="$BACKUP_URL" BACKUP_AGE_PUBLIC_KEY="${PUB:-$PUB1}" BACKUP_OUTPUT_DIR="$1" bash "$BACKUP" >"$LOG" 2>&1
}
run_restore() { # $1 = pacote; $2 = checksum; $3 = identidade; $4 = URL do servidor
  RESTORE_DATABASE_URL="${4:-$RESTORE_SERVER_URL}" bash "$RESTORE" --package "$1" --checksum "$2" --identity "$3" >"$LOG" 2>&1
}
expect_rc() { # $1 = descrição; $2 = código esperado; $3 = código obtido
  [ "$3" = "$2" ] && ok "$1 (código $3)" || bad "$1: esperava código $2, veio $3"
}
log_has() { grep -q "$1" "$LOG"; }

echo "== 1. backup falha fechado sem URL, e recusa chave privada no lugar da pública"
rc=0; env -u BACKUP_DATABASE_URL BACKUP_AGE_PUBLIC_KEY="$PUB1" BACKUP_OUTPUT_DIR="$ROOT/out1" bash "$BACKUP" >"$LOG" 2>&1 || rc=$?
expect_rc "sem URL" 64 "$rc"
log_has "ERRO: backup_url_ausente" && ok "mensagem fechada: backup_url_ausente" || bad "mensagem esperada ausente"
[ ! -e "$ROOT/out1" ] && tmp_empty && ok "nada criado (nem saída, nem temporário)" || bad "sobrou arquivo"
# Chave privada FALSA, montada em tempo de execução (o texto-fonte não carrega nada com cara de chave).
SEGREDO_CHAVE="AGE-SECRET""-KEY-1$(printf 'Q%.0s' $(seq 1 58))"
rc=0; BACKUP_DATABASE_URL="$BACKUP_URL" BACKUP_AGE_PUBLIC_KEY="$SEGREDO_CHAVE" BACKUP_OUTPUT_DIR="$ROOT/out1" bash "$BACKUP" >"$LOG" 2>&1 || rc=$?
expect_rc "chave privada no lugar da pública" 64 "$rc"
! grep -q "QQQQQQ" "$LOG" && ok "a chave recebida não é ecoada" || bad "a chave apareceu no log"

echo "== 2. segredo e URL não aparecem em argumentos nem em logs"
SEGREDO_SENHA="Sup3r@Seg:redo/B6c%X9"
SEGREDO_ENC="Sup3r%40Seg%3Aredo%2FB6c%25X9"
URL_SEGREDO="postgresql://usuario_x:${SEGREDO_ENC}@host-que-nao-existe.invalid:5432/banco_x?sslmode=require"
cat >"$ROOT/shim/pg_dump" <<SHIM
#!/usr/bin/env bash
if [ "\${1:-}" = "--version" ]; then exec "$REAL_PG_DUMP" --version; fi
{ printf 'ARGV:'; printf ' [%s]' "\$@"; printf '\nPGPASSWORD_DEFINIDA=%s\n' "\${PGPASSWORD:+sim}"; printf 'PGPASSWORD_VALOR=%s\n' "\${PGPASSWORD:-}"; } >> "$ROOT/argv-registro.txt"
exit 1
SHIM
cat >"$ROOT/shim/psql" <<SHIM
#!/usr/bin/env bash
if [ "\${1:-}" = "--version" ]; then exec "$(command -v psql)" --version; fi
{ printf 'PSQL_ARGV:'; printf ' [%s]' "\$@"; printf '\nPGHOST=%s PGUSER=%s PGDATABASE=%s\n' "\${PGHOST:-}" "\${PGUSER:-}" "\${PGDATABASE:-}"; } >> "$ROOT/argv-registro.txt"
case " \$* " in
  *" -c "*) printf '17.6\n' ;;                                  # consulta de versão
  *) cat >/dev/null; printf 'SNAPSHOT:00000003-00000002-1\nREADY\n'; exec sleep 30 ;; # sessão do snapshot
esac
SHIM
chmod +x "$ROOT/shim/pg_dump" "$ROOT/shim/psql"
rc=0; PATH="$ROOT/shim:$PATH" BACKUP_DATABASE_URL="$URL_SEGREDO" BACKUP_AGE_PUBLIC_KEY="$PUB1" BACKUP_OUTPUT_DIR="$ROOT/out2" bash "$BACKUP" >"$LOG" 2>&1 || rc=$?
expect_rc "dump que falha (ferramenta simulada)" 70 "$rc"
log_has "ERRO: dump_falhou:schema_auth" && ok "erro fechado: dump_falhou:schema_auth" || bad "erro fechado esperado ausente"
if grep -q "Sup3r\|Seg:redo\|%40\|usuario_x\|host-que-nao-existe\|banco_x\|postgresql://" "$LOG"; then bad "URL/senha/host vazaram no log"; else ok "o log não contém URL, senha, usuário, host nem banco"; fi
if grep -F -e "$SEGREDO_SENHA" -e "$SEGREDO_ENC" -e "host-que-nao-existe" -e "postgresql://" <(grep "ARGV" "$ROOT/argv-registro.txt"); then bad "segredo ou URL em ARGUMENTO de comando"; else ok "nenhum argumento de pg_dump/psql contém URL ou senha"; fi
grep -q "PGPASSWORD_DEFINIDA=sim" "$ROOT/argv-registro.txt" && grep -q "PGPASSWORD_VALOR=$SEGREDO_SENHA\$" "$ROOT/argv-registro.txt" && ok "a senha chega ao filho só pelo ambiente, já decodificada (%40 -> @)" || bad "a senha não chegou ao filho pelo ambiente"
grep -q "PGHOST=host-que-nao-existe.invalid PGUSER=usuario_x PGDATABASE=banco_x" "$ROOT/argv-registro.txt" && ok "host, usuário e banco vão por variáveis PG* (URL desmontada)" || bad "variáveis PG* não conferem"
tmp_empty && [ ! -e "$ROOT/out2" ] && ok "dump com falha: nenhum texto claro nem saída ficou" || bad "sobrou arquivo depois do dump com falha"
rm -f "$ROOT/shim/pg_dump" "$ROOT/shim/psql" "$ROOT/argv-registro.txt"

echo "== 3. falha do dump no meio deixa texto claro parcial? (não pode)"
cat >"$ROOT/shim/pg_dump" <<SHIM
#!/usr/bin/env bash
if [ "\${1:-}" = "--version" ]; then exec "$REAL_PG_DUMP" --version; fi
for a in "\$@"; do case "\$a" in --file=*) printf 'TEXTO-CLARO-PARCIAL\n' > "\${a#--file=}" ;; esac; done
exit 1
SHIM
chmod +x "$ROOT/shim/pg_dump"
rc=0; PATH="$ROOT/shim:$PATH" run_backup "$ROOT/out3" || rc=$?
expect_rc "pg_dump falha depois de escrever parte do arquivo" 70 "$rc"
tmp_empty && [ ! -e "$ROOT/out3" ] && ok "temporários e saída vazios" || bad "sobrou texto claro ou saída parcial"
rm -f "$ROOT/shim/pg_dump"

echo "== 4. falha da criptografia remove os dumps"
cat >"$ROOT/shim/age" <<SHIM
#!/usr/bin/env bash
exit 1
SHIM
chmod +x "$ROOT/shim/age"
rc=0; PATH="$ROOT/shim:$PATH" run_backup "$ROOT/out4" || rc=$?
expect_rc "age falha" 70 "$rc"
log_has "ERRO: criptografia_falhou" && ok "erro fechado: criptografia_falhou" || bad "erro fechado esperado ausente"
tmp_empty && ok "nenhum dump em texto claro sobrou" || bad "sobrou texto claro depois da falha da criptografia"
if [ -d "$ROOT/out4" ]; then [ -z "$(ls -A "$ROOT/out4")" ] && ok "a saída não tem arquivo parcial" || bad "saída parcial"; else ok "a saída nem foi criada"; fi
rm -f "$ROOT/shim/age"

echo "== 5. backup real: pacote final só com o .age e o checksum"
OUT="$ROOT/out"
rc=0; run_backup "$OUT" || rc=$?
expect_rc "backup real" 0 "$rc"
mapfile -t FILES < <(ls -A "$OUT")
if [ "${#FILES[@]}" -eq 2 ] && [[ "${FILES[0]}" =~ ^praxis-crm-backup-[0-9]{8}T[0-9]{6}Z\.tar\.gz\.age$ ]] && [ "${FILES[1]}" = "${FILES[0]}.sha256" ]; then ok "a pasta de saída tem só ${FILES[0]} e o .sha256"; else bad "conteúdo inesperado da saída: ${FILES[*]:-vazio}"; fi
PKG="$OUT/${FILES[0]}"
SUM="$OUT/${FILES[0]}.sha256"
tmp_empty && ok "nenhum temporário em texto claro" || bad "sobrou temporário"
if grep -q "postgresql://\|CREATE TABLE\|INSERT INTO\|COPY " "$LOG"; then bad "o log do backup contém URL ou SQL"; else ok "o log do backup não contém URL nem SQL"; fi
( cd "$OUT" && sha256sum --check --status "${FILES[0]}.sha256" ) && ok "checksum do arquivo criptografado confere" || bad "checksum não confere"
if head -c 32 "$PKG" | grep -q "age-encryption.org"; then ok "o pacote é um arquivo age (criptografado)"; else bad "cabeçalho age ausente"; fi
if grep -a -q "CREATE TABLE\|COPY \"public\"" "$PKG"; then bad "texto SQL legível dentro do pacote criptografado"; else ok "nenhum SQL legível no pacote"; fi
mkdir "$ROOT/inspecao"
age --decrypt --identity "$ROOT/keys/id1.txt" --output "$ROOT/inspecao/p.tar.gz" "$PKG"
mapfile -t CONTEUDO < <(tar -tzf "$ROOT/inspecao/p.tar.gz" | sort)
ESPERADO=$(printf '%s\n' manifest.json "${PRAXIS_PKG_FILES[@]}" | sort | tr '\n' ' ')
[ "$(printf '%s ' "${CONTEUDO[@]}")" = "$ESPERADO" ] && ok "o pacote contém exatamente: manifesto + 5 arquivos SQL" || bad "conteúdo do pacote: ${CONTEUDO[*]}"
tar -C "$ROOT/inspecao" -xzf "$ROOT/inspecao/p.tar.gz" manifest.json
grep -q '"format": "praxis-backup/v2"' "$ROOT/inspecao/manifest.json" && grep -q '"snapshot": "single-repeatable-read"' "$ROOT/inspecao/manifest.json" && grep -q '"created_at_utc"' "$ROOT/inspecao/manifest.json" && grep -q '"postgres_server_version"' "$ROOT/inspecao/manifest.json" && grep -q '"pg_dump_version"' "$ROOT/inspecao/manifest.json" && ok "manifesto: formato v2, snapshot único, data UTC e versões do PostgreSQL" || bad "manifesto incompleto"
[ "$(grep -c '"0[1-5]-[a-z-]*\.sql": "[0-9a-f]\{64\}"' "$ROOT/inspecao/manifest.json")" = "5" ] && ok "manifesto: hash SHA-256 dos 5 arquivos" || bad "hashes do manifesto"
rm -rf "$ROOT/inspecao"

echo "== 6. destino hospedado ou Production é recusado antes de qualquer ferramenta"
cat >"$ROOT/shim/age" <<SHIM
#!/usr/bin/env bash
echo age >> "$ROOT/chamadas.txt"; exit 1
SHIM
cat >"$ROOT/shim/psql" <<SHIM
#!/usr/bin/env bash
if [ "\${1:-}" = "--version" ]; then exec "$(command -v psql)" --version; fi
echo psql >> "$ROOT/chamadas.txt"; exit 1
SHIM
chmod +x "$ROOT/shim/age" "$ROOT/shim/psql"
alvo_recusado() { # $1 = descrição; $2 = URL; resto = variáveis extras (VAR=valor)
  local d="$1" u="$2"; shift 2
  local r=0
  rm -f "$ROOT/chamadas.txt"
  env "$@" PATH="$ROOT/shim:$PATH" RESTORE_DATABASE_URL="$u" bash "$RESTORE" --package "$PKG" --checksum "$SUM" --identity "$ROOT/keys/id1.txt" >"$LOG" 2>&1 || r=$?
  [ "$r" = "77" ] && [ ! -e "$ROOT/chamadas.txt" ] && ! grep -q "postgresql://\|senha" "$LOG" && ok "$d: recusado (código 77), sem tocar em age/psql" || bad "$d: código $r ou ferramenta chamada"
}
alvo_recusado "host db.<ref>.supabase.co" "postgresql://postgres:x@db.abcdefghijklmnop.supabase.co:5432/postgres" A=1
alvo_recusado "pooler do Supabase" "postgresql://postgres.abcdefghijklmnop:x@aws-0-sa-east-1.pooler.supabase.com:5432/postgres" A=1
alvo_recusado "host remoto qualquer, sem permissão de descartável" "postgresql://postgres:x@banco.exemplo.com:5432/postgres" A=1
alvo_recusado "usuário com a referência do projeto de Production" "postgresql://postgres.zzzzzzzzzzzzzzzz:x@127.0.0.1:5432/postgres" NEXT_PUBLIC_SUPABASE_URL=https://zzzzzzzzzzzzzzzz.supabase.co
alvo_recusado "mesmo com RESTORE_ALLOW_DISPOSABLE_REMOTE, host supabase continua recusado" "postgresql://postgres:x@db.abcdefghijklmnop.supabase.co:5432/postgres" RESTORE_ALLOW_DISPOSABLE_REMOTE=yes
rm -f "$ROOT/shim/age" "$ROOT/shim/psql" "$ROOT/chamadas.txt"

echo "== 7. checksum inválido e pacote adulterado bloqueiam ANTES de descriptografar"
DBS_ANTES="$(list_restore_dbs)"
HASH_RUIM="$(printf '%064d' 0)"
printf '%s  %s\n' "$HASH_RUIM" "$(basename "$PKG")" >"$ROOT/ruim.sha256"
cat >"$ROOT/shim/age" <<SHIM
#!/usr/bin/env bash
echo age >> "$ROOT/chamadas.txt"; exec "$REAL_AGE" "\$@"
SHIM
chmod +x "$ROOT/shim/age"
rm -f "$ROOT/chamadas.txt"
rc=0; PATH="$ROOT/shim:$PATH" run_restore "$PKG" "$ROOT/ruim.sha256" "$ROOT/keys/id1.txt" || rc=$?
expect_rc "checksum divergente" 65 "$rc"
log_has "ERRO: checksum_invalido" && ok "erro fechado: checksum_invalido" || bad "erro fechado esperado ausente"
[ ! -e "$ROOT/chamadas.txt" ] && ok "o age NÃO foi chamado (validou o hash antes)" || bad "descriptografou antes de validar o hash"
[ "$(list_restore_dbs)" = "$DBS_ANTES" ] && tmp_empty && ok "nenhum banco criado e nenhum temporário" || bad "sobrou banco ou temporário"
cp "$PKG" "$ROOT/adulterado.tar.gz.age"
printf 'x' >>"$ROOT/adulterado.tar.gz.age"
printf '%s  %s\n' "$(sha256_of "$PKG")" "adulterado.tar.gz.age" >"$ROOT/adulterado.sha256"
rc=0; PATH="$ROOT/shim:$PATH" run_restore "$ROOT/adulterado.tar.gz.age" "$ROOT/adulterado.sha256" "$ROOT/keys/id1.txt" || rc=$?
expect_rc "pacote com um byte a mais" 65 "$rc"
[ ! -e "$ROOT/chamadas.txt" ] && ok "adulterado: também parou antes do age" || bad "adulterado chegou ao age"
printf 'não é um checksum\n' >"$ROOT/lixo.sha256"
rc=0; run_restore "$PKG" "$ROOT/lixo.sha256" "$ROOT/keys/id1.txt" || rc=$?
expect_rc "arquivo de checksum malformado" 65 "$rc"
rm -f "$ROOT/shim/age" "$ROOT/chamadas.txt"

echo "== 8. chave errada bloqueia a restauração"
rc=0; run_restore "$PKG" "$SUM" "$ROOT/keys/id2.txt" || rc=$?
expect_rc "chave de outro par" 65 "$rc"
log_has "ERRO: descriptografia_falhou" && ok "erro fechado: descriptografia_falhou" || bad "erro fechado esperado ausente"
[ "$(list_restore_dbs)" = "$DBS_ANTES" ] && tmp_empty && ok "nenhum banco criado e nenhum temporário" || bad "sobrou banco ou temporário"

echo "== 9. restauração local descartável fiel, com constraints e FKs válidas"
rc=0; run_restore "$PKG" "$SUM" "$ROOT/keys/id1.txt" || rc=$?
expect_rc "restauração" 0 "$rc"
log_has "restauracao_validada: banco=praxis_restore_" && ok "$(grep restauracao_validada "$LOG" | sed -e 's/banco=[a-zA-Z0-9_]*/banco=<novo>/')" || bad "validação não confirmada"
tmp_empty && ok "nenhum conteúdo descriptografado sobrou" || bad "sobrou conteúdo descriptografado"
RDB="$(grep -o 'banco=praxis_restore_[0-9TZ]*' "$LOG" | head -1 | cut -d= -f2)"
CREATED_DBS+=("$RDB")
FP_SQL="$ROOT/fp.sql"
cat >"$FP_SQL" <<'SQL'
select t.nspname || '.' || t.relname || '|' || (xpath('/row/c/text()', query_to_xml(format('select md5(coalesce(string_agg(md5(x::text), %L order by md5(x::text)), %L)) as c from %I.%I x', '', '', t.nspname, t.relname), false, true, '')))[1]::text
from (select c.relname, n.nspname from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where c.relkind in ('r', 'p') and (n.nspname in ('public', 'private', 'supabase_migrations') or (n.nspname = 'auth' and c.relname in ('users', 'identities')))) t
order by 1;
SQL
( parse_database_url "$BACKUP_URL"; psql -X -At -f "$FP_SQL" | tr -d '\r' ) >"$ROOT/fp_origem.txt"
( parse_database_url "$RESTORE_SERVER_URL"; PGDATABASE="$RDB"; export PGDATABASE; psql -X -At -f "$FP_SQL" | tr -d '\r' ) >"$ROOT/fp_destino.txt"
if [ -s "$ROOT/fp_origem.txt" ] && diff -q "$ROOT/fp_origem.txt" "$ROOT/fp_destino.txt" >/dev/null; then ok "as $(wc -l <"$ROOT/fp_origem.txt" | tr -d ' ') tabelas restauradas têm o MESMO conteúdo (hash de todas as linhas) que a origem"; else bad "conteúdo restaurado diverge da origem"; fi
CONSTRAINTS_SQL="select (select count(*) from pg_constraint where contype = 'f' and connamespace in ('public'::regnamespace, 'private'::regnamespace)) || '|' || (select count(*) from pg_constraint where not convalidated and connamespace in ('public'::regnamespace, 'private'::regnamespace))"
ORIG="$( ( parse_database_url "$BACKUP_URL"; psql -X -At -c "$CONSTRAINTS_SQL" | tr -d '\r' ) )"
DEST="$( ( parse_database_url "$RESTORE_SERVER_URL"; PGDATABASE="$RDB"; export PGDATABASE; psql -X -At -c "$CONSTRAINTS_SQL" | tr -d '\r' ) )"
[ "$ORIG" = "$DEST" ] && [ "${DEST##*|}" = "0" ] && ok "FKs: mesma quantidade da origem (${DEST%%|*}) e nenhuma constraint não validada" || bad "FKs/constraints divergem (origem=$ORIG destino=$DEST)"
( parse_database_url "$RESTORE_SERVER_URL"; psql -X -q -c "drop database if exists \"$RDB\" with (force)" >/dev/null 2>&1 ) && ok "banco de restauração descartado" || bad "não descartou o banco"

echo "== 10. pacote íntegro por fora mas inconsistente por dentro falha e não deixa nada"
repack() { # $1 = nome do cenário; $2 = comando sed a aplicar no manifest.json (ou vazio); $3 = "dados" para adulterar um SQL
  local dir="$ROOT/repack-$1"
  mkdir -p "$dir/x"
  age --decrypt --identity "$ROOT/keys/id1.txt" --output "$dir/p.tar.gz" "$PKG"
  tar -C "$dir/x" -xzf "$dir/p.tar.gz"
  [ -z "$2" ] || sed -i -e "$2" "$dir/x/manifest.json"
  [ "$3" != "dados" ] || printf '\n-- adulterado\n' >>"$dir/x/05-data-app.sql"
  tar -C "$dir/x" -czf "$dir/novo.tar.gz" manifest.json "${PRAXIS_PKG_FILES[@]}"
  age --encrypt --recipient "$PUB1" --output "$dir/praxis-crm-backup-$1.tar.gz.age" "$dir/novo.tar.gz"
  ( cd "$dir" && sha256sum "praxis-crm-backup-$1.tar.gz.age" >"praxis-crm-backup-$1.tar.gz.age.sha256" )
  printf '%s' "$dir/praxis-crm-backup-$1.tar.gz.age"
}
P="$(repack dados '' dados)"
rc=0; run_restore "$P" "$P.sha256" "$ROOT/keys/id1.txt" || rc=$?
expect_rc "SQL adulterado (hash do manifesto não bate)" 65 "$rc"
log_has "ERRO: manifesto_hash_divergente" && ok "erro fechado: manifesto_hash_divergente" || bad "erro fechado esperado ausente"
P="$(repack tabelas 's/"tables": [0-9]*/"tables": 9999/' '')"
rc=0; run_restore "$P" "$P.sha256" "$ROOT/keys/id1.txt" || rc=$?
expect_rc "contagem de tabelas divergente do manifesto" 70 "$rc"
log_has "ERRO: validacao_estrutura:tables" && ok "erro fechado: validacao_estrutura:tables" || bad "erro fechado esperado ausente"
P="$(repack linhas 's/"auth.users": [0-9]*/"auth.users": 424242/' '')"
rc=0; run_restore "$P" "$P.sha256" "$ROOT/keys/id1.txt" || rc=$?
expect_rc "linhas de auth.users divergentes do manifesto" 70 "$rc"
log_has "ERRO: validacao_linhas" && ok "erro fechado: validacao_linhas" || bad "erro fechado esperado ausente"
[ "$(list_restore_dbs)" = "$DBS_ANTES" ] && tmp_empty && ok "as restaurações que falharam não deixaram banco nem temporário" || bad "sobrou banco ou temporário"
rm -rf "$ROOT"/repack-*

if [ "$FAILS" -gt 0 ]; then
  printf '\n%s verificação(ões) falharam\n' "$FAILS" >&2
  exit 1
fi
echo
echo "backup e restauração (B6c): OK"
