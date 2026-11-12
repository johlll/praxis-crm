#!/usr/bin/env bash
# B6c — restauração TESTÁVEL de um backup criptografado, num Postgres LOCAL descartável.
#
# Uso:
#   RESTORE_DATABASE_URL=postgresql://postgres:...@127.0.0.1:5432/postgres \
#     bash restore-db.sh --package praxis-crm-backup-<UTC>.tar.gz.age \
#                        [--checksum praxis-crm-backup-<UTC>.tar.gz.age.sha256] \
#                        --identity /caminho/local/chave-privada-age.txt
#
# O que faz, nesta ordem (qualquer falha para tudo e limpa):
#   1. recusa destino que pareça o projeto hospedado/Production (só Postgres local, ou remoto
#      EXPLICITAMENTE descartável com RESTORE_ALLOW_DISPOSABLE_REMOTE=yes e nunca *supabase*);
#   2. valida o SHA-256 do arquivo criptografado ANTES de descriptografar;
#   3. descriptografa SÓ numa pasta temporária (a chave privada vem de um caminho local);
#   4. confere o conteúdo do pacote (lista fechada de arquivos) e os hashes do manifesto;
#   5. cria um banco NOVO (praxis_restore_<UTC>) no servidor de destino — nunca escreve num banco
#      existente — e restaura schema e dados;
#   6. valida: estrutura (tabelas, constraints, RLS, políticas, gatilhos, funções), linhas por
#      tabela e chaves estrangeiras sem órfãos, tudo contra o manifesto.
# Remove todo conteúdo descriptografado ao terminar ou falhar. Só imprime códigos e contagens
# agregadas — nunca URL, senha, SQL ou dado. O banco restaurado fica para inspeção, a menos que
# RESTORE_DROP_AFTER=yes (ou que a restauração falhe: então ele é removido).
set -euo pipefail
umask 077

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$HERE/lib.sh"

PACKAGE=""
CHECKSUM=""
IDENTITY=""
WORK=""
NEWDB=""
DB_CREATED=0
ADMIN_DB=""
VALID=0
cleanup() {
  local rc=$?
  trap - EXIT
  [ -n "$WORK" ] && rm -rf "$WORK"
  if [ "$DB_CREATED" -eq 1 ] && { [ "$VALID" -ne 1 ] || [ "${RESTORE_DROP_AFTER:-}" = "yes" ]; }; then
    PGDATABASE="$ADMIN_DB" psql -X -q -c "drop database if exists \"$NEWDB\" with (force)" >/dev/null 2>&1 || true
  fi
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# ---- 1. Argumentos e destino ---------------------------------------------------------------
while [ $# -gt 0 ]; do
  case "$1" in
    --package) PACKAGE="${2:-}"; shift 2 ;;
    --checksum) CHECKSUM="${2:-}"; shift 2 ;;
    --identity) IDENTITY="${2:-}"; shift 2 ;;
    *) die "argumento_invalido" 64 ;;
  esac
done
[ -n "$PACKAGE" ] || die "pacote_ausente" 64
[ -n "$IDENTITY" ] || die "chave_privada_ausente" 64
[ -n "${RESTORE_DATABASE_URL:-}" ] || die "destino_ausente" 64

parse_database_url "$RESTORE_DATABASE_URL" || die "destino_invalido" 64
unset RESTORE_DATABASE_URL
ADMIN_DB="${PGDATABASE}"

# Destino: Postgres local, ou remoto explicitamente descartável. Nunca o projeto hospedado.
HOST_LC="$(printf '%s' "$PGHOST" | tr '[:upper:]' '[:lower:]')"
USER_LC="$(printf '%s' "$PGUSER" | tr '[:upper:]' '[:lower:]')"
case "$HOST_LC" in
  *supabase*|*pooler*|*vercel*|*neon.tech*|*amazonaws.com*|*azure.com*|*render.com*|*railway*|*fly.dev*)
    die "destino_recusado:hospedado" 77 ;;
esac
for ref_source in "${NEXT_PUBLIC_SUPABASE_URL:-}" "${SUPABASE_URL:-}" "${SUPABASE_PROJECT_REF:-}"; do
  [ -n "$ref_source" ] || continue
  ref="${ref_source#*://}"
  ref="${ref%%.*}"
  ref="$(printf '%s' "$ref" | tr '[:upper:]' '[:lower:]')"
  if [ -n "$ref" ] && [ "${#ref}" -ge 8 ]; then
    case "$HOST_LC$USER_LC" in *"$ref"*) die "destino_recusado:production" 77 ;; esac
  fi
done
case "$HOST_LC" in
  localhost|127.*|::1) ;;
  *) [ "${RESTORE_ALLOW_DISPOSABLE_REMOTE:-}" = "yes" ] || die "destino_recusado:nao_local" 77 ;;
esac

# ---- 2. Arquivos de entrada ----------------------------------------------------------------
[ -f "$PACKAGE" ] || die "pacote_inexistente" 66
[ -f "$IDENTITY" ] || die "chave_privada_inexistente" 66
[ -n "$CHECKSUM" ] || CHECKSUM="$PACKAGE.sha256"
[ -f "$CHECKSUM" ] || die "checksum_inexistente" 66

for tool in age psql tar gzip sha256sum awk mktemp; do need_tool "$tool"; done
pg_major_ok psql || die "psql_versao_incorreta" 69

# ---- 3. SHA-256 do arquivo criptografado, ANTES de descriptografar -------------------------
read -r EXPECTED_HASH EXPECTED_NAME _ <"$CHECKSUM" || [ -n "$EXPECTED_HASH" ] || die "checksum_invalido" 65
EXPECTED_NAME="${EXPECTED_NAME#\*}"
is_sha256 "$EXPECTED_HASH" || die "checksum_invalido" 65
[ "$EXPECTED_NAME" = "$(basename "$PACKAGE")" ] || die "checksum_invalido" 65
ACTUAL_HASH="$(sha256_of "$PACKAGE")" || die "checksum_invalido" 65
EXPECTED_HASH="$(printf '%s' "$EXPECTED_HASH" | tr 'A-F' 'a-f')"
[ "$ACTUAL_HASH" = "$EXPECTED_HASH" ] || die "checksum_invalido" 65

# ---- 4. Descriptografar só em pasta temporária ---------------------------------------------
WORK="$(mktemp -d)"
chmod 700 "$WORK"
PKG="$WORK/pkg"
mkdir "$PKG"
ERR="$WORK/.ferramentas.log"
age --decrypt --identity "$IDENTITY" --output "$WORK/pacote.tar.gz" "$PACKAGE" 2>"$ERR" || die "descriptografia_falhou" 65

# Só os arquivos esperados, sem caminho (nada de ../ nem de arquivo extra).
mapfile -t LISTED < <(tar -tzf "$WORK/pacote.tar.gz" 2>"$ERR") || die "pacote_invalido" 65
EXPECTED_LIST=("manifest.json" "${PRAXIS_PKG_FILES[@]}")
[ "${#LISTED[@]}" -eq "${#EXPECTED_LIST[@]}" ] || die "pacote_invalido" 65
for item in "${LISTED[@]}"; do
  found=0
  for ok in "${EXPECTED_LIST[@]}"; do [ "$item" = "$ok" ] && found=1; done
  [ "$found" -eq 1 ] || die "pacote_invalido" 65
done
tar -C "$PKG" -xzf "$WORK/pacote.tar.gz" 2>"$ERR" || die "pacote_invalido" 65
rm -f "$WORK/pacote.tar.gz"

# ---- 5. Manifesto: formato e hashes --------------------------------------------------------
mv "$PKG/manifest.json" "$WORK/manifest.json"
MANIFEST="$WORK/manifest.json"
grep -q "\"format\": \"$PRAXIS_BACKUP_FORMAT\"" "$MANIFEST" || die "manifesto_invalido" 65
for arquivo in "${PRAXIS_PKG_FILES[@]}"; do
  linha="$(grep -F "\"$arquivo\":" "$MANIFEST" | tr -d '\r' || true)"
  esperado="${linha#*: \"}"
  esperado="${esperado%%\"*}"
  is_sha256 "$esperado" || die "manifesto_invalido" 65
  [ "$(sha256_of "$PKG/$arquivo")" = "$esperado" ] || die "manifesto_hash_divergente" 65
done

manifest_value() { # $1 = chave de "expected" (número)
  local linha v
  linha="$(tr -d '\r' <"$MANIFEST" | grep -E "^    \"$1\": [0-9]+,?$" || true)"
  v="${linha#*: }"
  v="${v%,}"
  [[ "$v" =~ ^[0-9]+$ ]] || die "manifesto_invalido" 65
  printf '%s' "$v"
}

# ---- 6. Banco NOVO no servidor de destino --------------------------------------------------
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
NEWDB="praxis_restore_${STAMP}"
[[ "$NEWDB" =~ ^praxis_restore_[0-9]{8}T[0-9]{6}Z$ ]] || die "destino_invalido" 64
PGDATABASE="$ADMIN_DB" psql -X -q -v ON_ERROR_STOP=1 -c "select 1" >/dev/null 2>"$ERR" || die "destino_inacessivel" 69
PGDATABASE="$ADMIN_DB" psql -X -q -v ON_ERROR_STOP=1 -c "create database \"$NEWDB\"" >/dev/null 2>"$ERR" || die "restauracao_falhou:criar_banco" 70
DB_CREATED=1
export PGDATABASE="$NEWDB"
psql -X -q -v ON_ERROR_STOP=1 -c "alter database \"$NEWDB\" set search_path = \"\$user\", public, extensions" >/dev/null 2>"$ERR" || die "restauracao_falhou:banco" 70

# Dados entram com gatilhos e FKs desligados (papel de replicação): o pacote é a foto fiel do banco,
# e nenhum gatilho (marco de retenção, updated_at, guardas) pode reescrever linha na carga.
export PGOPTIONS="-c session_replication_role=replica -c check_function_bodies=off"
load() { # $1 = arquivo
  psql -X -q -v ON_ERROR_STOP=1 --single-transaction -f "$1" >/dev/null 2>"$ERR" || die "restauracao_falhou:$(basename "$1")" 70
}
load "$HERE/restore-bootstrap.sql"
for arquivo in "${PRAXIS_PKG_FILES[@]}"; do load "$PKG/$arquivo"; done

# Já restaurado: o conteúdo descriptografado não é mais necessário.
rm -rf "$PKG"

# ---- 7. Validação contra o manifesto -------------------------------------------------------
export PGOPTIONS=""
RESULT="$WORK/.validacao.txt"
psql -X -At -v ON_ERROR_STOP=1 -f "$HERE/restore-validate.sql" >"$RESULT" 2>"$ERR" || die "validacao_falhou" 70

result_value() { # $1 = chave (número)
  local linha v=""
  while IFS= read -r linha; do
    linha="${linha%$'\r'}"
    case "$linha" in "$1="*) v="${linha#*=}" ;; esac
  done <"$RESULT"
  [[ "$v" =~ ^[0-9]+$ ]] || die "validacao_falhou" 70
  printf '%s' "$v"
}

# 7.1 estrutura: tabelas, constraints, RLS, políticas, gatilhos e funções == manifesto
for chave in tables constraints_p constraints_f constraints_u constraints_c rls_enabled rls_forced policies triggers functions; do
  esperado="$(manifest_value "$chave")"
  obtido="$(result_value "$chave")"
  [ "$esperado" = "$obtido" ] || die "validacao_estrutura:$chave" 70
done
[ "$(result_value nao_validadas)" = "0" ] || die "validacao_constraints_nao_validadas" 70

# 7.2 linhas por tabela == manifesto (tabela sem bloco no manifesto = 0 linhas)
declare -A ESPERADAS
LINHA_RE='^    "([A-Za-z0-9_]+\.[A-Za-z0-9_]+)": ([0-9]+),?$'
while IFS= read -r linha; do
  linha="${linha%$'\r'}"
  if [[ "$linha" =~ $LINHA_RE ]]; then
    ESPERADAS["${BASH_REMATCH[1]}"]="${BASH_REMATCH[2]}"
  fi
done <"$MANIFEST"
TOTAL_LINHAS=0
while IFS='|' read -r tipo nome n; do
  [ "$tipo" = "linhas" ] || continue
  n="${n%$'\r'}"
  [[ "$n" =~ ^[0-9]+$ ]] || die "validacao_falhou" 70
  [ "${ESPERADAS[$nome]:-0}" = "$n" ] || die "validacao_linhas" 70
  TOTAL_LINHAS=$((TOTAL_LINHAS + n))
  unset 'ESPERADAS[$nome]'
done <"$RESULT"
for nome in "${!ESPERADAS[@]}"; do
  [ "${ESPERADAS[$nome]}" = "0" ] || die "validacao_linhas" 70
done

# 7.3 chaves estrangeiras sem órfãos (a carga desligou os gatilhos, então cada FK é conferida de verdade)
psql -X -q -v ON_ERROR_STOP=1 -f "$HERE/restore-fks.sql" >/dev/null 2>"$ERR" || die "validacao_fks_orfas" 70

VALID=1
printf 'restauracao_validada: banco=%s tabelas=%s linhas=%s fks=%s constraints=%s\n' \
  "$NEWDB" "$(result_value tables)" "$TOTAL_LINHAS" "$(result_value constraints_f)" \
  "$(( $(result_value constraints_p) + $(result_value constraints_f) + $(result_value constraints_u) + $(result_value constraints_c) ))"
