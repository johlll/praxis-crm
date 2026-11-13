#!/usr/bin/env bash
# B6c/C5a.1 — backup CRIPTOGRAFADO do bucket `proposal-documents` do Supabase Storage
# (formato praxis-storage-backup/v1).
#
# Entrada (somente variáveis de ambiente):
#   BACKUP_STORAGE_S3_ENDPOINT           endpoint S3 do projeto (segredo; nunca vira argumento nem log)
#   BACKUP_STORAGE_S3_REGION             região do projeto
#   BACKUP_STORAGE_S3_ACCESS_KEY_ID      chave S3 DEDICADA ao backup (segredo)
#   BACKUP_STORAGE_S3_SECRET_ACCESS_KEY  segredo da chave S3 (segredo)
#   BACKUP_AGE_PUBLIC_KEY                chave PÚBLICA age ("age1..."); a privada NUNCA passa por aqui
#   BACKUP_OUTPUT_DIR                    pasta de saída (padrão: ./storage-out)
#   BACKUP_STORAGE_BUCKET                opcional; só aceita "proposal-documents"
#   STORAGE_BACKUP_PAGE_SIZE             opcional; objetos por página da listagem (1 a 1000; padrão 1000)
#
# Saída: SOMENTE  praxis-storage-backup-<UTC>.tar.gz.age  e  praxis-storage-backup-<UTC>.tar.gz.age.sha256
#
# O pacote (antes de criptografar) é um .tar.gz com manifest.json e objects/<número de 8 dígitos>, um arquivo
# por objeto, byte a byte como veio do Storage (nada é recompactado nem alterado). O manifesto (versão, data
# UTC, bucket, quantidade, total de bytes, e para cada objeto: caminho, tamanho, SHA-256 e tipo de conteúdo,
# mais a versão das ferramentas) fica SÓ dentro do pacote criptografado, porque os caminhos podem ser sensíveis.
#
# SÓ LEITURA: usa apenas ListObjectsV2, HeadObject e GetObject. Nenhuma escrita, cópia ou exclusão.
#
# Consistência: lista tudo (com paginação), baixa cada objeto exatamente UMA vez conferindo tamanho e ETag
# contra a listagem, e lista de novo no fim. Qualquer diferença entre as duas listagens (objeto alterado,
# removido ou incluído durante o backup) falha fechado. Nada de texto claro sobrevive: a pasta de trabalho é
# apagada ao terminar OU falhar. Só imprime códigos fechados e contagens agregadas.
set -euo pipefail
umask 077

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$HERE/lib.sh"
# shellcheck source=lib-storage.sh
. "$HERE/lib-storage.sh"

WORK=""
OUT_FILES=()
OK=0
cleanup() {
  local rc=$?
  trap - EXIT
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
[ -n "${BACKUP_STORAGE_S3_ENDPOINT:-}" ] || die "storage_endpoint_ausente" 64
[ -n "${BACKUP_STORAGE_S3_REGION:-}" ] || die "storage_regiao_ausente" 64
[ -n "${BACKUP_STORAGE_S3_ACCESS_KEY_ID:-}" ] || die "storage_chave_acesso_ausente" 64
[ -n "${BACKUP_STORAGE_S3_SECRET_ACCESS_KEY:-}" ] || die "storage_segredo_ausente" 64
[ -n "${BACKUP_AGE_PUBLIC_KEY:-}" ] || die "chave_publica_ausente" 64
[[ "$BACKUP_AGE_PUBLIC_KEY" =~ ^age1[0-9a-z]{58}$ ]] || die "chave_publica_invalida" 64
RECIPIENT="$BACKUP_AGE_PUBLIC_KEY"
unset BACKUP_AGE_PUBLIC_KEY

BUCKET="${BACKUP_STORAGE_BUCKET:-$PRAXIS_STORAGE_BUCKET}"
storage_bucket_ok "$BUCKET" || die "bucket_recusado" 64
PAGE="${STORAGE_BACKUP_PAGE_SIZE:-1000}"
[[ "$PAGE" =~ ^[0-9]+$ ]] && [ "$PAGE" -ge 1 ] && [ "$PAGE" -le 1000 ] || die "tamanho_pagina_invalido" 64

s3_endpoint_host "$BACKUP_STORAGE_S3_ENDPOINT" >/dev/null || die "storage_endpoint_invalido" 64
s3_prepare_env "$BACKUP_STORAGE_S3_ENDPOINT" "$BACKUP_STORAGE_S3_REGION" \
  "$BACKUP_STORAGE_S3_ACCESS_KEY_ID" "$BACKUP_STORAGE_S3_SECRET_ACCESS_KEY"
unset BACKUP_STORAGE_S3_ENDPOINT BACKUP_STORAGE_S3_REGION BACKUP_STORAGE_S3_ACCESS_KEY_ID BACKUP_STORAGE_S3_SECRET_ACCESS_KEY

for tool in aws jq age tar gzip sha256sum awk mktemp wc; do need_tool "$tool"; done

OUT="${BACKUP_OUTPUT_DIR:-storage-out}"
WORK="$(mktemp -d)"
chmod 700 "$WORK"
PKG="$WORK/pkg"
mkdir -p "$PKG/objects"
ERR="$WORK/.ferramentas.log" # saída das ferramentas: nunca lida nem impressa

AWS_VERSION="$(aws --version 2>&1 | head -n 1 | awk '{print $1}')" || AWS_VERSION=""
JQ_VERSION="$(jq --version 2>/dev/null || true)"
AGE_VERSION="$(age --version 2>/dev/null | head -n 1 || true)"
TAR_VERSION="$(tar --version 2>/dev/null | head -n 1 || true)"

# ---- 2. Primeira listagem (todas as páginas) ----------------------------------------------
LIST1="$WORK/lista1.json"
LIST2="$WORK/lista2.json"
s3_list_all "$LIST1"
COUNT="$(jq 'length' "$LIST1")"
[[ "$COUNT" =~ ^[0-9]+$ ]] || die "listagem_invalida" 70

# ---- 3. Cada objeto: conferir, baixar UMA vez, conferir de novo, calcular SHA-256 ----------------
: >"$WORK/objetos.ndjson"
TOTAL=0
for ((i = 0; i < COUNT; i++)); do
  key="$(jq -r --argjson i "$i" '.[$i].k' "$LIST1")"
  size="$(jq -r --argjson i "$i" '.[$i].s' "$LIST1")"
  etag="$(s3_etag_norm "$(jq -r --argjson i "$i" '.[$i].e' "$LIST1")")"
  id="$(printf '%08d' $((i + 1)))"

  aws s3api head-object --bucket "$BUCKET" --key "$key" >"$WORK/head.json" 2>"$ERR" || die "$(s3_error_code "$ERR")" 69
  head_size="$(jq -r '.ContentLength // -1' "$WORK/head.json" 2>"$ERR")" || die "objeto_invalido" 70
  head_etag="$(s3_etag_norm "$(jq -r '.ETag // ""' "$WORK/head.json" 2>"$ERR")")" || die "objeto_invalido" 70
  [ "$head_size" = "$size" ] || die "objeto_alterado" 70
  { [ -z "$etag" ] || [ "$head_etag" = "$etag" ]; } || die "objeto_alterado" 70

  aws s3api get-object --bucket "$BUCKET" --key "$key" "$PKG/objects/$id" >"$WORK/get.json" 2>"$ERR" || die "download_falhou" 70
  get_size="$(jq -r '.ContentLength // -1' "$WORK/get.json" 2>"$ERR")" || die "objeto_invalido" 70
  get_etag="$(s3_etag_norm "$(jq -r '.ETag // ""' "$WORK/get.json" 2>"$ERR")")" || die "objeto_invalido" 70
  ctype="$(jq -r '.ContentType // ""' "$WORK/get.json" 2>"$ERR")" || die "objeto_invalido" 70
  real_size="$(wc -c <"$PKG/objects/$id" | tr -d ' ')"
  [ "$get_size" = "$size" ] && [ "$real_size" = "$size" ] || die "tamanho_divergente" 70
  { [ -z "$etag" ] || [ "$get_etag" = "$etag" ]; } || die "objeto_alterado" 70

  hash="$(sha256_of "$PKG/objects/$id")" || die "hash_falhou" 70
  is_sha256 "$hash" || die "hash_falhou" 70
  jq -n -c --arg id "$id" --arg key "$key" --argjson size "$size" --arg sha "$hash" --arg ct "$ctype" \
    '{id: $id, key: $key, size: $size, sha256: $sha, content_type: $ct}' >>"$WORK/objetos.ndjson" || die "manifesto_falhou" 70
  TOTAL=$((TOTAL + size))
  rm -f "$WORK/head.json" "$WORK/get.json"
done

# ---- 4. Segunda listagem: o conjunto tem de ser exatamente o mesmo -----------------------------
s3_list_all "$LIST2"
cmp -s "$LIST1" "$LIST2" || die "conjunto_alterado" 70

# ---- 5. Releitura local: o que está na pasta ainda bate com o hash calculado -------------------
while IFS= read -r linha; do
  oid="$(printf '%s' "$linha" | jq -r '.id')"
  ohash="$(printf '%s' "$linha" | jq -r '.sha256')"
  [ "$(sha256_of "$PKG/objects/$oid")" = "$ohash" ] || die "hash_divergente" 70
done <"$WORK/objetos.ndjson"

# ---- 6. Manifesto --------------------------------------------------------------------------
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
CREATED="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
jq -n --arg format "$PRAXIS_STORAGE_FORMAT" --arg created "$CREATED" --arg bucket "$BUCKET" \
  --arg aws "$AWS_VERSION" --arg jqv "$JQ_VERSION" --arg agev "$AGE_VERSION" --arg tarv "$TAR_VERSION" \
  --slurpfile objs "$WORK/objetos.ndjson" \
  '{format: $format, created_at_utc: $created, bucket: $bucket,
    object_count: ($objs | length), total_bytes: ($objs | map(.size) | add // 0),
    tools: {aws_cli: $aws, jq: $jqv, age: $agev, tar: $tarv},
    objects: $objs}' >"$PKG/manifest.json" 2>"$ERR" || die "manifesto_falhou" 70
[ "$(jq -r '.object_count' "$PKG/manifest.json")" = "$COUNT" ] || die "manifesto_falhou" 70
[ "$(jq -r '.total_bytes' "$PKG/manifest.json")" = "$TOTAL" ] || die "manifesto_falhou" 70

# ---- 7. Compactar e criptografar (só chave pública) ----------------------------------------
tar -C "$PKG" -czf "$WORK/pacote.tar.gz" manifest.json objects 2>"$ERR" || die "compactacao_falhou" 70
age --encrypt --recipient "$RECIPIENT" --output "$WORK/pacote.tar.gz.age" "$WORK/pacote.tar.gz" 2>"$ERR" || die "criptografia_falhou" 70
[ -s "$WORK/pacote.tar.gz.age" ] || die "criptografia_falhou" 70

# O texto claro já não é mais necessário: sai agora, antes de qualquer outra coisa.
rm -rf "$PKG" "$WORK/pacote.tar.gz" "$LIST1" "$LIST2" "$WORK/objetos.ndjson"

# ---- 8. Saída: só o .age e o checksum do arquivo JÁ criptografado --------------------------
mkdir -p "$OUT" || die "saida_falhou" 73
chmod 700 "$OUT" 2>/dev/null || true
NAME="praxis-storage-backup-${STAMP}.tar.gz.age"
[ ! -e "$OUT/$NAME" ] || die "saida_ja_existe" 73
OUT_FILES=("$OUT/$NAME" "$OUT/$NAME.sha256")
mv "$WORK/pacote.tar.gz.age" "$OUT/$NAME" || die "saida_falhou" 73
HASH="$(sha256_of "$OUT/$NAME")" || die "checksum_falhou" 70
is_sha256 "$HASH" || die "checksum_falhou" 70
printf '%s  %s\n' "$HASH" "$NAME" >"$OUT/$NAME.sha256" || die "checksum_falhou" 70
(cd "$OUT" && sha256sum --check --status "$NAME.sha256") || die "checksum_falhou" 70

OK=1
printf 'storage_backup_concluido: %s (%s objetos, %s bytes de conteudo, %s bytes cifrados)\n' \
  "$NAME" "$COUNT" "$TOTAL" "$(wc -c <"$OUT/$NAME" | tr -d ' ')"
