#!/usr/bin/env bash
# B6c/C5a.1 — restauração TESTÁVEL de um backup criptografado do Storage (praxis-storage-backup/v1),
# num destino LOCAL ou explicitamente DESCARTÁVEL. Nunca em Production.
#
# Uso:
#   RESTORE_STORAGE_S3_ENDPOINT=http://127.0.0.1:54321/storage/v1/s3 \
#   RESTORE_STORAGE_S3_REGION=local \
#   RESTORE_STORAGE_S3_ACCESS_KEY_ID=... RESTORE_STORAGE_S3_SECRET_ACCESS_KEY=... \
#     bash restore-storage.sh --package praxis-storage-backup-<UTC>.tar.gz.age \
#                             [--checksum praxis-storage-backup-<UTC>.tar.gz.age.sha256] \
#                             --identity /caminho/local/chave-privada-age.txt
#
# O que faz, nesta ordem (qualquer falha para tudo e limpa):
#   1. recusa destino que pareça o projeto hospedado/Production (só local, ou remoto EXPLICITAMENTE
#      descartável com RESTORE_ALLOW_DISPOSABLE_REMOTE=yes e nunca *supabase*);
#   2. valida o SHA-256 do arquivo criptografado ANTES de descriptografar;
#   3. descriptografa SÓ numa pasta temporária (a chave privada vem de um caminho local);
#   4. confere a lista fechada de itens do pacote, o formato, o bucket, a quantidade, o total de bytes e,
#      para cada objeto, tamanho e SHA-256 do manifesto;
#   5. exige o bucket de destino VAZIO e restaura todos os objetos (PutObject, só aqui);
#   6. lê de volta o destino e compara quantidade, total de bytes e o SHA-256 de cada objeto.
# Remove todo conteúdo descriptografado ao terminar ou falhar. Só imprime códigos e contagens agregadas —
# nunca endpoint, segredo, nome de objeto ou conteúdo.
set -euo pipefail
umask 077

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$HERE/lib.sh"
# shellcheck source=lib-storage.sh
. "$HERE/lib-storage.sh"

PACKAGE=""
CHECKSUM=""
IDENTITY=""
WORK=""
cleanup() {
  local rc=$?
  trap - EXIT
  [ -n "$WORK" ] && rm -rf "$WORK"
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
[ -n "${RESTORE_STORAGE_S3_ENDPOINT:-}" ] || die "destino_ausente" 64
[ -n "${RESTORE_STORAGE_S3_REGION:-}" ] || die "storage_regiao_ausente" 64
[ -n "${RESTORE_STORAGE_S3_ACCESS_KEY_ID:-}" ] || die "storage_chave_acesso_ausente" 64
[ -n "${RESTORE_STORAGE_S3_SECRET_ACCESS_KEY:-}" ] || die "storage_segredo_ausente" 64

BUCKET="${RESTORE_STORAGE_BUCKET:-$PRAXIS_STORAGE_BUCKET}"
storage_bucket_ok "$BUCKET" || die "bucket_recusado" 64
PAGE=1000

HOST_LC="$(s3_endpoint_host "$RESTORE_STORAGE_S3_ENDPOINT")" || die "destino_invalido" 64
# Destino: local, ou remoto explicitamente descartável. Nunca o projeto hospedado.
case "$HOST_LC" in
  *supabase*|*pooler*|*vercel*|*neon.tech*|*amazonaws.com*|*azure.com*|*render.com*|*railway*|*fly.dev*|*cloudflarestorage*|*backblaze*|*digitaloceanspaces*)
    die "destino_recusado:hospedado" 77 ;;
esac
for ref_source in "${NEXT_PUBLIC_SUPABASE_URL:-}" "${SUPABASE_URL:-}" "${SUPABASE_PROJECT_REF:-}"; do
  [ -n "$ref_source" ] || continue
  ref="${ref_source#*://}"
  ref="${ref%%.*}"
  ref="$(printf '%s' "$ref" | tr '[:upper:]' '[:lower:]')"
  if [ -n "$ref" ] && [ "${#ref}" -ge 8 ]; then
    case "$HOST_LC" in *"$ref"*) die "destino_recusado:production" 77 ;; esac
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

for tool in aws jq age tar gzip sha256sum awk mktemp wc; do need_tool "$tool"; done

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
ERR="$WORK/.ferramentas.log" # nunca lido nem impresso

age --decrypt --identity "$IDENTITY" --output "$WORK/pacote.tar.gz" "$PACKAGE" 2>"$ERR" || die "descriptografia_falhou" 65

# Lista FECHADA de itens: só manifest.json, a pasta objects/ e objects/<8 dígitos>; nada de links nem de
# caminho fora disso (nada é extraído antes desta conferência).
tar -tzf "$WORK/pacote.tar.gz" >"$WORK/lista.txt" 2>"$ERR" || die "pacote_invalido" 65
while IFS= read -r item; do
  item="${item%$'\r'}"
  [[ "$item" =~ ^(manifest\.json|objects/|objects/[0-9]{8})$ ]] || die "pacote_conteudo_inesperado" 65
done <"$WORK/lista.txt"
grep -q -x 'manifest.json' "$WORK/lista.txt" || die "pacote_conteudo_inesperado" 65
tar -tvzf "$WORK/pacote.tar.gz" 2>"$ERR" | awk '{ t = substr($1, 1, 1); if (t != "-" && t != "d") bad = 1 } END { exit bad }' || die "pacote_conteudo_inesperado" 65
tar -xzf "$WORK/pacote.tar.gz" -C "$PKG" 2>"$ERR" || die "pacote_invalido" 65
rm -f "$WORK/pacote.tar.gz" "$WORK/lista.txt"

# ---- 5. Manifesto e objetos ----------------------------------------------------------------
MAN="$PKG/manifest.json"
[ -f "$MAN" ] || die "manifesto_ausente" 65
jq -e --arg f "$PRAXIS_STORAGE_FORMAT" --arg b "$PRAXIS_STORAGE_BUCKET" '
  .format == $f and .bucket == $b
  and (.objects | type == "array")
  and .object_count == (.objects | length)
  and .total_bytes == ([.objects[].size] | add // 0)
  and all(.objects[]; (.id | test("^[0-9]{8}$")) and (.key | type == "string" and length > 0)
                      and (.size | type == "number" and . >= 0) and (.sha256 | test("^[0-9a-f]{64}$")))
  and ((.objects | map(.id) | unique | length) == (.objects | length))
  and ((.objects | map(.key) | unique | length) == (.objects | length))' "$MAN" >/dev/null 2>"$ERR" || die "manifesto_invalido" 65

COUNT="$(jq -r '.object_count' "$MAN")"
TOTAL="$(jq -r '.total_bytes' "$MAN")"
[[ "$COUNT" =~ ^[0-9]+$ ]] && [[ "$TOTAL" =~ ^[0-9]+$ ]] || die "manifesto_invalido" 65
[ "$(find "$PKG/objects" -type f | wc -l | tr -d ' ')" = "$COUNT" ] || die "pacote_conteudo_inesperado" 65

for ((i = 0; i < COUNT; i++)); do
  id="$(jq -r --argjson i "$i" '.objects[$i].id' "$MAN")"
  size="$(jq -r --argjson i "$i" '.objects[$i].size' "$MAN")"
  sha="$(jq -r --argjson i "$i" '.objects[$i].sha256' "$MAN")"
  [ -f "$PKG/objects/$id" ] || die "pacote_conteudo_inesperado" 65
  [ "$(wc -c <"$PKG/objects/$id" | tr -d ' ')" = "$size" ] || die "manifesto_tamanho_divergente" 65
  [ "$(sha256_of "$PKG/objects/$id")" = "$sha" ] || die "manifesto_hash_divergente" 65
done

# ---- 6. Destino: bucket existente e VAZIO ----------------------------------------------------
s3_prepare_env "$RESTORE_STORAGE_S3_ENDPOINT" "$RESTORE_STORAGE_S3_REGION" \
  "$RESTORE_STORAGE_S3_ACCESS_KEY_ID" "$RESTORE_STORAGE_S3_SECRET_ACCESS_KEY"
unset RESTORE_STORAGE_S3_ENDPOINT RESTORE_STORAGE_S3_REGION RESTORE_STORAGE_S3_ACCESS_KEY_ID RESTORE_STORAGE_S3_SECRET_ACCESS_KEY
s3_list_all "$WORK/destino-antes.json"
[ "$(jq 'length' "$WORK/destino-antes.json")" = "0" ] || die "bucket_destino_nao_vazio" 78

# ---- 7. Restaurar ----------------------------------------------------------------------------
for ((i = 0; i < COUNT; i++)); do
  id="$(jq -r --argjson i "$i" '.objects[$i].id' "$MAN")"
  key="$(jq -r --argjson i "$i" '.objects[$i].key' "$MAN")"
  ctype="$(jq -r --argjson i "$i" '.objects[$i].content_type // ""' "$MAN")"
  args=(s3api put-object --bucket "$BUCKET" --key "$key" --body "$PKG/objects/$id")
  [ -z "$ctype" ] || args+=(--content-type "$ctype")
  aws "${args[@]}" >/dev/null 2>"$ERR" || die "restauracao_falhou" 70
done

# ---- 8. Conferir o destino: quantidade, total de bytes e SHA-256 de cada objeto -------------
s3_list_all "$WORK/destino-depois.json"
[ "$(jq 'length' "$WORK/destino-depois.json")" = "$COUNT" ] || die "validacao_quantidade" 70
[ "$(jq '[.[].s] | add // 0' "$WORK/destino-depois.json")" = "$TOTAL" ] || die "validacao_bytes" 70
for ((i = 0; i < COUNT; i++)); do
  key="$(jq -r --argjson i "$i" '.objects[$i].key' "$MAN")"
  size="$(jq -r --argjson i "$i" '.objects[$i].size' "$MAN")"
  sha="$(jq -r --argjson i "$i" '.objects[$i].sha256' "$MAN")"
  jq -e --arg k "$key" --argjson s "$size" 'any(.[]; .k == $k and .s == $s)' "$WORK/destino-depois.json" >/dev/null 2>"$ERR" || die "validacao_objeto" 70
  aws s3api get-object --bucket "$BUCKET" --key "$key" "$WORK/conferencia" >/dev/null 2>"$ERR" || die "validacao_download" 70
  [ "$(sha256_of "$WORK/conferencia")" = "$sha" ] || die "validacao_hash" 70
  rm -f "$WORK/conferencia"
done

printf 'storage_restauracao_validada: objetos=%s bytes=%s\n' "$COUNT" "$TOTAL"
