#!/usr/bin/env bash
# B6c/C5a.1 — prova do backup criptografado e da restauração do bucket `proposal-documents` com as
# FERRAMENTAS REAIS (aws, jq, age) contra o Storage do SUPABASE LOCAL e documentos SINTÉTICOS, sem PII.
# Nenhum dado hospedado, nenhuma chave de verdade, nenhuma credencial hospedada.
#
# Entrada (variáveis de ambiente; no CI vêm de `supabase status -o env`):
#   CHECK_S3_ENDPOINT           ex.: http://127.0.0.1:54321/storage/v1/s3
#   CHECK_S3_REGION             ex.: local
#   CHECK_S3_ACCESS_KEY_ID      chave S3 do Supabase LOCAL
#   CHECK_S3_SECRET_ACCESS_KEY  segredo S3 do Supabase LOCAL
#
# Cobre (numeração do pedido): 1 bucket vazio; 2 um e vários PDFs; 3 paginação; 4 variável ausente;
# 5 credencial inválida; 6 bucket diferente recusado; 7 segredo/URL fora de logs e argumentos; 8 falha de
# download limpa texto claro; 9 falha do age limpa texto claro; 10 alteração durante o backup detectada;
# 11 inclusão e remoção durante o backup detectadas; 12 pacote só com itens permitidos; 13 checksum válido;
# 14 checksum inválido (e pacote adulterado) bloqueia; 15 chave privada errada bloqueia; 16 destino
# Production/hospedado recusado antes de qualquer chamada; 17 destino não vazio recusado; 18 restauração
# local fiel (quantidade, tamanhos e hashes). Os itens 19 a 21 (constraints do banco, workflow-modelo e
# ausência de segredos no repositório) são cobertos pelos outros passos do CI e por tests/unit.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$HERE/lib.sh"
# shellcheck source=lib-storage.sh
. "$HERE/lib-storage.sh"

: "${CHECK_S3_ENDPOINT:?defina CHECK_S3_ENDPOINT}"
: "${CHECK_S3_REGION:?defina CHECK_S3_REGION}"
: "${CHECK_S3_ACCESS_KEY_ID:?defina CHECK_S3_ACCESS_KEY_ID}"
: "${CHECK_S3_SECRET_ACCESS_KEY:?defina CHECK_S3_SECRET_ACCESS_KEY}"
S3_ENDPOINT="$CHECK_S3_ENDPOINT"
S3_REGION="$CHECK_S3_REGION"
S3_AKID="$CHECK_S3_ACCESS_KEY_ID"
S3_SECRET="$CHECK_S3_SECRET_ACCESS_KEY"
unset CHECK_S3_ENDPOINT CHECK_S3_REGION CHECK_S3_ACCESS_KEY_ID CHECK_S3_SECRET_ACCESS_KEY
case "$(s3_endpoint_host "$S3_ENDPOINT")" in localhost|127.*|::1) ;; *) die "teste_so_contra_destino_local" 77 ;; esac

FAILS=0
ok() { printf '   ok: %s\n' "$1"; }
bad() { printf '   FALHOU: %s\n' "$1" >&2; FAILS=$((FAILS + 1)); }

for tool in aws jq age age-keygen tar sha256sum; do need_tool "$tool"; done
export REAL_AWS REAL_AGE
REAL_AWS="$(command -v aws)"
REAL_AGE="$(command -v age)"

ROOT="$(mktemp -d)"
export TMPDIR="$ROOT/tmp" # tudo o que os scripts criarem de temporário cai aqui: tem de voltar vazio
mkdir -p "$TMPDIR" "$ROOT/keys" "$ROOT/shim" "$ROOT/shimage" "$ROOT/src" "$ROOT/insp"
BUCKET="$PRAXIS_STORAGE_BUCKET"
LOG="$ROOT/log.txt"
ARGLOG="$ROOT/args.txt"

s3() { ( s3_prepare_env "$S3_ENDPOINT" "$S3_REGION" "$S3_AKID" "$S3_SECRET"; "$REAL_AWS" "$@" ); }
clear_bucket() {
  local k
  s3 s3api list-objects-v2 --bucket "$BUCKET" --output json --no-paginate 2>/dev/null \
    | jq -r '(.Contents // [])[].Key' | while IFS= read -r k; do
        [ -n "$k" ] && s3 s3api delete-object --bucket "$BUCKET" --key "$k" >/dev/null 2>&1 || true
      done
}
cleanup() {
  local rc=$?
  trap - EXIT
  clear_bucket >/dev/null 2>&1 || true
  rm -rf "$ROOT"
  exit "$rc"
}
trap cleanup EXIT

# O bucket vem da migration da B1; se por algum motivo não existir, cria (só no Supabase local).
s3 s3api head-bucket --bucket "$BUCKET" >/dev/null 2>&1 || s3 s3api create-bucket --bucket "$BUCKET" >/dev/null
clear_bucket

age-keygen -o "$ROOT/keys/id1.txt" >/dev/null 2>&1
age-keygen -o "$ROOT/keys/id2.txt" >/dev/null 2>&1
PUB1="$(age-keygen -y "$ROOT/keys/id1.txt")"

BACKUP="$HERE/backup-storage.sh"
RESTORE="$HERE/restore-storage.sh"

tmp_empty() { [ -z "$(ls -A "$TMPDIR")" ]; }
log_has() { grep -q -- "$1" "$LOG"; }
expect_rc() {
  if [ "$3" = "$2" ]; then
    ok "$1 (código $3)"
  else
    # O log dos scripts só tem códigos fechados ("ERRO: <codigo>") e contagens: é seguro mostrar.
    bad "$1: esperava código $2, veio $3 ($(grep -h '^ERRO:' "$LOG" | head -n 2 | tr '
' ' '))"
  fi
}
mk_pdf() { # $1 = arquivo; $2 = número
  printf '%%PDF-1.4\n%% sintetico %s\n' "$2" >"$1"
  head -c $((200 + $2 * 37)) /dev/urandom >>"$1"
  printf '\n%%%%EOF\n' >>"$1"
}
key_of() { printf 'ws-sintetico/prop-%03d/v1.pdf' "$1"; }
put_n() { # sobe os PDFs sintéticos 1..$1
  local n
  for n in $(seq 1 "$1"); do
    mk_pdf "$ROOT/src/$n.pdf" "$n"
    s3 s3api put-object --bucket "$BUCKET" --key "$(key_of "$n")" --body "$ROOT/src/$n.pdf" --content-type application/pdf >/dev/null
  done
}
run_backup() { # $1 = pasta de saída; resto = argumentos do `env` (VAR=valor, -u VAR); saída em $LOG
  local out="$1"
  shift
  (
    export BACKUP_STORAGE_S3_ENDPOINT="$S3_ENDPOINT" BACKUP_STORAGE_S3_REGION="$S3_REGION"
    export BACKUP_STORAGE_S3_ACCESS_KEY_ID="$S3_AKID" BACKUP_STORAGE_S3_SECRET_ACCESS_KEY="$S3_SECRET"
    export BACKUP_AGE_PUBLIC_KEY="$PUB1" BACKUP_OUTPUT_DIR="$out"
    env "$@" bash "$BACKUP"
  ) >"$LOG" 2>&1
}
run_restore() { # $1 = pacote; $2 = checksum; $3 = identidade; resto = argumentos do `env`
  local pkg="$1" sum="$2" id="$3"
  shift 3
  (
    export RESTORE_STORAGE_S3_ENDPOINT="$S3_ENDPOINT" RESTORE_STORAGE_S3_REGION="$S3_REGION"
    export RESTORE_STORAGE_S3_ACCESS_KEY_ID="$S3_AKID" RESTORE_STORAGE_S3_SECRET_ACCESS_KEY="$S3_SECRET"
    env "$@" bash "$RESTORE" --package "$pkg" --checksum "$sum" --identity "$id"
  ) >"$LOG" 2>&1
}
the_pkg() { ls -1 "$1"/*.tar.gz.age 2>/dev/null || true; }
unpack() { # $1 = pacote .age (abre com a chave 1 em $ROOT/insp; quem chama apaga)
  rm -rf "$ROOT/insp" && mkdir -p "$ROOT/insp"
  age --decrypt --identity "$ROOT/keys/id1.txt" --output "$ROOT/insp.tar.gz" "$1"
  tar -tzf "$ROOT/insp.tar.gz" >"$ROOT/insp.lista"
  tar -xzf "$ROOT/insp.tar.gz" -C "$ROOT/insp"
  rm -f "$ROOT/insp.tar.gz"
}

# --- shims (só para injetar falhas/alterações; chamam o aws/age REAIS) ----------------------------
cat >"$ROOT/shim/aws" <<'SHIM'
#!/usr/bin/env bash
op="${2:-}"
[ -z "${SHIM_ARGLOG:-}" ] || printf '%s\n' "$*" >>"$SHIM_ARGLOG"
if [ "$op" = "get-object" ] && [ -n "${SHIM_MODE:-}" ]; then
  n=$(( $(cat "$SHIM_COUNTER" 2>/dev/null || echo 0) + 1 ))
  echo "$n" >"$SHIM_COUNTER"
  IFS=: read -r mode at action <<<"$SHIM_MODE"
  if [ "$n" = "$at" ]; then
    case "$mode" in
      fail_get) exit 1 ;;
      mutate_after_get)
        "$REAL_AWS" "$@" || exit $?
        case "$action" in
          overwrite) "$REAL_AWS" s3api put-object --bucket proposal-documents --key "$SHIM_MUT_KEY" --body "$SHIM_MUT_BODY" >/dev/null ;;
          add) "$REAL_AWS" s3api put-object --bucket proposal-documents --key "$SHIM_MUT_KEY.novo" --body "$SHIM_MUT_BODY" >/dev/null ;;
          delete) "$REAL_AWS" s3api delete-object --bucket proposal-documents --key "$SHIM_MUT_KEY" >/dev/null ;;
        esac
        exit 0 ;;
    esac
  fi
fi
exec "$REAL_AWS" "$@"
SHIM
cat >"$ROOT/shimage/age" <<'SHIM'
#!/usr/bin/env bash
case "${1:-}" in --encrypt) exit 1 ;; esac
exec "$REAL_AGE" "$@"
SHIM
chmod +x "$ROOT/shim/aws" "$ROOT/shimage/age"
SHIMPATH="$ROOT/shim:$PATH"       # só o aws com registro/injeção de falhas
AGEPATH="$ROOT/shimage:$PATH"     # só o age que falha ao criptografar

echo "== 1. bucket vazio gera um pacote válido"
rc=0; run_backup "$ROOT/o1" || rc=$?
expect_rc "backup do bucket vazio" 0 "$rc"
PK="$(the_pkg "$ROOT/o1")"
unpack "$PK"
[ "$(jq -r '.object_count' "$ROOT/insp/manifest.json")" = "0" ] && [ "$(jq -r '.total_bytes' "$ROOT/insp/manifest.json")" = "0" ] && ok "manifesto com 0 objetos e 0 bytes" || bad "manifesto do bucket vazio"
[ "$(jq -r '.format' "$ROOT/insp/manifest.json")" = "praxis-storage-backup/v1" ] && ok "formato praxis-storage-backup/v1" || bad "formato"
tmp_empty && ok "nenhum temporário sobrou" || bad "sobrou temporário"

echo "== 2. um PDF, depois vários, com hash e tamanho iguais aos arquivos de origem"
put_n 1
rc=0; run_backup "$ROOT/o2a" || rc=$?
expect_rc "backup de 1 PDF" 0 "$rc"
unpack "$(the_pkg "$ROOT/o2a")"
[ "$(jq -r '.object_count' "$ROOT/insp/manifest.json")" = "1" ] && ok "1 objeto no manifesto" || bad "contagem de 1 objeto"

echo "== 3. paginação (2 por página, 5 objetos)"
put_n 5
: >"$ARGLOG"
rc=0; run_backup "$ROOT/o3" SHIM_ARGLOG="$ARGLOG" PATH="$SHIMPATH" STORAGE_BACKUP_PAGE_SIZE=2 || rc=$?
expect_rc "backup paginado" 0 "$rc"
PK3="$(the_pkg "$ROOT/o3")"
unpack "$PK3"
[ "$(jq -r '.object_count' "$ROOT/insp/manifest.json")" = "5" ] && ok "5 objetos" || bad "contagem paginada"
paginas="$(grep -c 'list-objects-v2' "$ARGLOG" || true)"
[ "$paginas" -ge 6 ] && ok "listagem em várias páginas nas duas listagens ($paginas chamadas)" || bad "paginação não aconteceu ($paginas chamadas)"
iguais=1
for n in 1 2 3 4 5; do
  hash_src="$(sha256_of "$ROOT/src/$n.pdf")"
  size_src="$(wc -c <"$ROOT/src/$n.pdf" | tr -d ' ')"
  jq -e --arg k "$(key_of "$n")" --arg h "$hash_src" --argjson s "$size_src" \
    'any(.objects[]; .key == $k and .sha256 == $h and .size == $s)' "$ROOT/insp/manifest.json" >/dev/null || iguais=0
done
[ "$iguais" = 1 ] && ok "caminho, tamanho e SHA-256 de cada objeto batem com a origem" || bad "manifesto diverge da origem"
tot_src="$(cat "$ROOT"/src/[1-5].pdf | wc -c | tr -d ' ')"
[ "$(jq -r '.total_bytes' "$ROOT/insp/manifest.json")" = "$tot_src" ] && ok "total agregado de bytes" || bad "total de bytes"
jq -e '.tools.aws_cli != "" and .tools.jq != "" and .tools.age != "" and (.created_at_utc | test("Z$"))' "$ROOT/insp/manifest.json" >/dev/null && ok "versão das ferramentas e data UTC no manifesto" || bad "manifesto sem ferramentas/data"

echo "== 4. variável ausente falha fechado, sem criar nada"
for par in "BACKUP_STORAGE_S3_ENDPOINT:storage_endpoint_ausente" "BACKUP_STORAGE_S3_REGION:storage_regiao_ausente" \
  "BACKUP_STORAGE_S3_ACCESS_KEY_ID:storage_chave_acesso_ausente" "BACKUP_STORAGE_S3_SECRET_ACCESS_KEY:storage_segredo_ausente" \
  "BACKUP_AGE_PUBLIC_KEY:chave_publica_ausente"; do
  var="${par%%:*}"; codigo="${par#*:}"
  rc=0; run_backup "$ROOT/o4" -u "$var" || rc=$?
  expect_rc "sem $var" 64 "$rc"
  log_has "ERRO: $codigo" && ok "mensagem fechada: $codigo" || bad "mensagem $codigo ausente"
done
[ ! -e "$ROOT/o4" ] && tmp_empty && ok "nada criado" || bad "sobrou arquivo"

echo "== 5. credencial inválida"
rc=0; run_backup "$ROOT/o5" BACKUP_STORAGE_S3_SECRET_ACCESS_KEY="segredo-invalido-0123456789abcdef" || rc=$?
expect_rc "segredo S3 inválido" 69 "$rc"
log_has "ERRO: credencial_invalida" && ok "mensagem fechada: credencial_invalida" || bad "mensagem credencial_invalida ausente"
[ ! -e "$ROOT/o5" ] && tmp_empty && ok "nada criado" || bad "sobrou arquivo"

echo "== 6. bucket diferente é recusado antes de qualquer chamada"
: >"$ARGLOG"
rc=0; run_backup "$ROOT/o6" SHIM_ARGLOG="$ARGLOG" PATH="$SHIMPATH" BACKUP_STORAGE_BUCKET="outro-bucket" || rc=$?
expect_rc "bucket diferente" 64 "$rc"
log_has "ERRO: bucket_recusado" && ok "mensagem fechada: bucket_recusado" || bad "mensagem bucket_recusado ausente"
[ ! -s "$ARGLOG" ] && [ ! -e "$ROOT/o6" ] && ok "nenhuma chamada ao S3 e nada criado" || bad "houve chamada ou saída"

echo "== 7. segredo, chave de acesso, endpoint e nomes de objeto fora dos logs; segredo e endpoint fora dos argumentos"
: >"$ARGLOG"
rc=0; run_backup "$ROOT/o7" SHIM_ARGLOG="$ARGLOG" PATH="$SHIMPATH" || rc=$?
expect_rc "backup com registro de argumentos" 0 "$rc"
vazou=0
for segredo in "$S3_SECRET" "$S3_AKID" "$S3_ENDPOINT" "ws-sintetico" "prop-00" ".pdf"; do
  grep -q -F -- "$segredo" "$LOG" && vazou=1
done
[ "$vazou" = 0 ] && ok "log sem segredo, chave, endpoint ou nome de objeto" || bad "algo sensível apareceu no log"
[ -s "$ARGLOG" ] && ok "argumentos registrados ($(wc -l <"$ARGLOG" | tr -d ' ') chamadas)" || bad "nenhum argumento registrado"
vazou=0
for segredo in "$S3_SECRET" "$S3_AKID" "$S3_ENDPOINT"; do
  grep -q -F -- "$segredo" "$ARGLOG" && vazou=1
done
[ "$vazou" = 0 ] && ok "argumentos sem segredo, chave de acesso ou endpoint" || bad "segredo/endpoint em argumento"
! grep -q -E 'put-object|delete-object|copy-object|create-bucket|s3 (cp|mv|rm|sync)' "$ARGLOG" && ok "backup só usou operações de leitura" || bad "operação de escrita no backup"

echo "== 8. falha de download limpa o texto claro e não deixa saída"
rc=0; run_backup "$ROOT/o8" PATH="$SHIMPATH" SHIM_MODE="fail_get:2:" SHIM_COUNTER="$ROOT/c8" || rc=$?
expect_rc "download falho" 70 "$rc"
log_has "ERRO: download_falhou" && ok "mensagem fechada: download_falhou" || bad "mensagem download_falhou ausente"
[ ! -e "$ROOT/o8" ] && tmp_empty && ok "nenhum texto claro nem saída restou" || bad "sobrou arquivo"

echo "== 9. falha do age limpa o texto claro e não deixa saída"
rc=0; run_backup "$ROOT/o9" PATH="$AGEPATH" || rc=$?
expect_rc "age falhou" 70 "$rc"
log_has "ERRO: criptografia_falhou" && ok "mensagem fechada: criptografia_falhou" || bad "mensagem criptografia_falhou ausente"
[ ! -e "$ROOT/o9" ] && tmp_empty && ok "nenhum texto claro nem saída restou" || bad "sobrou arquivo"

echo "== 10. alteração de um objeto DURANTE o backup é detectada"
sleep 1.2
mk_pdf "$ROOT/src/alterado.pdf" 77
rc=0; run_backup "$ROOT/o10" PATH="$SHIMPATH" SHIM_MODE="mutate_after_get:2:overwrite" SHIM_COUNTER="$ROOT/c10" \
  SHIM_MUT_KEY="$(key_of 1)" SHIM_MUT_BODY="$ROOT/src/alterado.pdf" || rc=$?
expect_rc "objeto sobrescrito durante o backup" 70 "$rc"
log_has "ERRO: conjunto_alterado" && ok "mensagem fechada: conjunto_alterado" || bad "mensagem conjunto_alterado ausente"
[ ! -e "$ROOT/o10" ] && tmp_empty && ok "nenhuma saída e nenhum texto claro" || bad "sobrou arquivo"
s3 s3api put-object --bucket "$BUCKET" --key "$(key_of 1)" --body "$ROOT/src/1.pdf" --content-type application/pdf >/dev/null # restaura o estado

echo "== 11. inclusão e remoção DURANTE o backup são detectadas"
sleep 1.2
rc=0; run_backup "$ROOT/o11a" PATH="$SHIMPATH" SHIM_MODE="mutate_after_get:2:add" SHIM_COUNTER="$ROOT/c11a" \
  SHIM_MUT_KEY="$(key_of 1)" SHIM_MUT_BODY="$ROOT/src/alterado.pdf" || rc=$?
expect_rc "objeto incluído durante o backup" 70 "$rc"
log_has "ERRO: conjunto_alterado" && ok "inclusão detectada" || bad "inclusão não detectada"
s3 s3api delete-object --bucket "$BUCKET" --key "$(key_of 1).novo" >/dev/null
rc=0; run_backup "$ROOT/o11b" PATH="$SHIMPATH" SHIM_MODE="mutate_after_get:2:delete" SHIM_COUNTER="$ROOT/c11b" \
  SHIM_MUT_KEY="$(key_of 1)" || rc=$?
expect_rc "objeto removido durante o backup" 70 "$rc"
log_has "ERRO: conjunto_alterado" && ok "remoção detectada" || bad "remoção não detectada"
[ ! -e "$ROOT/o11a" ] && [ ! -e "$ROOT/o11b" ] && tmp_empty && ok "nenhuma saída e nenhum texto claro" || bad "sobrou arquivo"
s3 s3api put-object --bucket "$BUCKET" --key "$(key_of 1)" --body "$ROOT/src/1.pdf" --content-type application/pdf >/dev/null # restaura o estado

echo "== 12. o pacote contém SOMENTE manifest.json e objects/<8 dígitos>; a pasta de saída, só o .age e o .sha256"
unpack "$PK3"
itens_ok=1
while IFS= read -r item; do
  [[ "$item" =~ ^(manifest\.json|objects/|objects/[0-9]{8})$ ]] || itens_ok=0
done <"$ROOT/insp.lista"
[ "$itens_ok" = 1 ] && [ "$(wc -l <"$ROOT/insp.lista" | tr -d ' ')" = "7" ] && ok "7 itens: manifest.json, objects/ e 5 objetos" || bad "itens inesperados no pacote"
[ "$(ls -1 "$ROOT/o3" | wc -l | tr -d ' ')" = "2" ] && ok "saída com exatamente 2 arquivos" || bad "saída com arquivos a mais"
ls "$ROOT/o3" | grep -q -E '^praxis-storage-backup-[0-9]{8}T[0-9]{6}Z\.tar\.gz\.age(\.sha256)?$' && ok "nomes praxis-storage-backup-<UTC>" || bad "nome inesperado"
! grep -a -q -F 'sintetico' "$PK3" && ok "o pacote cifrado não deixa ver nome nem conteúdo" || bad "texto claro dentro do pacote cifrado"

echo "== 13. checksum válido é aceito; 18. restauração local fiel"
clear_bucket
rc=0; run_restore "$PK3" "$PK3.sha256" "$ROOT/keys/id1.txt" || rc=$?
expect_rc "restauração com checksum válido" 0 "$rc"
log_has "storage_restauracao_validada: objetos=5 bytes=$tot_src" && ok "restauração validada: 5 objetos e $tot_src bytes" || bad "linha de validação ausente"
fiel=1
for n in 1 2 3 4 5; do
  s3 s3api get-object --bucket "$BUCKET" --key "$(key_of "$n")" "$ROOT/volta.pdf" >/dev/null
  [ "$(sha256_of "$ROOT/volta.pdf")" = "$(sha256_of "$ROOT/src/$n.pdf")" ] || fiel=0
  rm -f "$ROOT/volta.pdf"
done
[ "$fiel" = 1 ] && ok "cada PDF restaurado tem o mesmo SHA-256 da origem (conferido por fora do script)" || bad "PDF restaurado diferente"
n_dest="$(s3 s3api list-objects-v2 --bucket "$BUCKET" --output json --no-paginate | jq '(.Contents // []) | length')"
[ "$n_dest" = "5" ] && ok "5 objetos no destino" || bad "quantidade no destino: $n_dest"
tmp_empty && ok "nenhum texto claro sobrou" || bad "sobrou temporário"

echo "== 17. destino com objetos é recusado e nada é alterado"
rc=0; run_restore "$PK3" "$PK3.sha256" "$ROOT/keys/id1.txt" || rc=$?
expect_rc "destino não vazio" 78 "$rc"
log_has "ERRO: bucket_destino_nao_vazio" && ok "mensagem fechada: bucket_destino_nao_vazio" || bad "mensagem ausente"
[ "$(s3 s3api list-objects-v2 --bucket "$BUCKET" --output json --no-paginate | jq '(.Contents // []) | length')" = "5" ] && ok "destino intacto" || bad "destino alterado"
tmp_empty && ok "nenhum texto claro sobrou" || bad "sobrou temporário"
clear_bucket

echo "== 14. checksum inválido e pacote adulterado bloqueiam, sem escrever no destino"
cp "$PK3" "$ROOT/adulterado.tar.gz.age"
printf 'X' >>"$ROOT/adulterado.tar.gz.age"
sed "s#praxis-storage-backup-[0-9TZ]*\.tar\.gz\.age#adulterado.tar.gz.age#" "$PK3.sha256" >"$ROOT/adulterado.tar.gz.age.sha256"
rc=0; run_restore "$ROOT/adulterado.tar.gz.age" "$ROOT/adulterado.tar.gz.age.sha256" "$ROOT/keys/id1.txt" || rc=$?
expect_rc "pacote com checksum que não bate" 65 "$rc"
log_has "ERRO: checksum_invalido" && ok "mensagem fechada: checksum_invalido" || bad "mensagem ausente"
cp "$PK3.sha256" "$ROOT/sum-errado.sha256"
sed -i 's/^./Z/' "$ROOT/sum-errado.sha256"
rc=0; run_restore "$PK3" "$ROOT/sum-errado.sha256" "$ROOT/keys/id1.txt" || rc=$?
expect_rc "checksum alterado" 65 "$rc"
[ "$(s3 s3api list-objects-v2 --bucket "$BUCKET" --output json --no-paginate | jq '(.Contents // []) | length')" = "0" ] && ok "destino continua vazio" || bad "destino foi escrito"
tmp_empty && ok "nenhum texto claro sobrou" || bad "sobrou temporário"

echo "== 15. chave privada errada bloqueia"
rc=0; run_restore "$PK3" "$PK3.sha256" "$ROOT/keys/id2.txt" || rc=$?
expect_rc "chave errada" 65 "$rc"
log_has "ERRO: descriptografia_falhou" && ok "mensagem fechada: descriptografia_falhou" || bad "mensagem ausente"
[ "$(s3 s3api list-objects-v2 --bucket "$BUCKET" --output json --no-paginate | jq '(.Contents // []) | length')" = "0" ] && ok "destino continua vazio" || bad "destino foi escrito"
tmp_empty && ok "nenhum texto claro sobrou" || bad "sobrou temporário"

echo "== 16. destino Production ou hospedado é recusado antes de qualquer chamada ao S3"
: >"$ARGLOG"
for destino in "https://abcdefghijklmnopqrst.supabase.co/storage/v1/s3" "https://abcdefghijklmnopqrst.storage.supabase.co/storage/v1/s3" \
  "https://s3.sa-east-1.amazonaws.com" "https://conta.r2.cloudflarestorage.com"; do
  rc=0; run_restore "$PK3" "$PK3.sha256" "$ROOT/keys/id1.txt" PATH="$SHIMPATH" SHIM_ARGLOG="$ARGLOG" RESTORE_STORAGE_S3_ENDPOINT="$destino" || rc=$?
  expect_rc "destino hospedado recusado" 77 "$rc"
  log_has "ERRO: destino_recusado:hospedado" && ok "mensagem fechada: destino_recusado:hospedado" || bad "mensagem ausente"
done
rc=0; run_restore "$PK3" "$PK3.sha256" "$ROOT/keys/id1.txt" PATH="$SHIMPATH" SHIM_ARGLOG="$ARGLOG" \
  RESTORE_STORAGE_S3_ENDPOINT="http://abcdefghijklmnopqrst.exemplo.test/s3" NEXT_PUBLIC_SUPABASE_URL="https://abcdefghijklmnopqrst.supabase.co" RESTORE_ALLOW_DISPOSABLE_REMOTE=yes || rc=$?
expect_rc "endereço com a referência do projeto de Production" 77 "$rc"
log_has "ERRO: destino_recusado:production" && ok "mensagem fechada: destino_recusado:production" || bad "mensagem ausente"
rc=0; run_restore "$PK3" "$PK3.sha256" "$ROOT/keys/id1.txt" PATH="$SHIMPATH" SHIM_ARGLOG="$ARGLOG" RESTORE_STORAGE_S3_ENDPOINT="http://10.1.2.3:9000" || rc=$?
expect_rc "servidor não local sem autorização de descartável" 77 "$rc"
log_has "ERRO: destino_recusado:nao_local" && ok "mensagem fechada: destino_recusado:nao_local" || bad "mensagem ausente"
[ ! -s "$ARGLOG" ] && ok "nenhuma chamada ao S3 em nenhuma recusa" || bad "houve chamada ao S3 antes da recusa"
tmp_empty && ok "nenhum texto claro sobrou" || bad "sobrou temporário"

echo
if [ "$FAILS" -eq 0 ]; then
  echo "TODAS AS VERIFICAÇÕES DO BACKUP DO STORAGE PASSARAM"
else
  echo "$FAILS VERIFICAÇÃO(ÕES) FALHARAM" >&2
  exit 1
fi
