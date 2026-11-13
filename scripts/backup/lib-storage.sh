#!/usr/bin/env bash
# B6c/C5a.1 — funções comuns do backup e da restauração do Supabase Storage (praxis-storage-backup/v1).
#
# Valem as mesmas regras do banco (lib.sh): NUNCA imprimir URL, segredo, nome de objeto ou conteúdo; só
# códigos fechados ("ERRO: <codigo>"). A saída e o erro da ferramenta (aws) vão para um arquivo temporário
# que nunca é lido nem impresso. Sem rastreamento de comandos do shell.
#
# O caminho de BACKUP usa SÓ leitura do S3: ListObjectsV2, HeadObject e GetObject. A restauração é a única
# que escreve (PutObject), e só num destino local ou explicitamente descartável.
# shellcheck source=lib.sh

PRAXIS_STORAGE_FORMAT="praxis-storage-backup/v1"
PRAXIS_STORAGE_BUCKET="proposal-documents"

storage_bucket_ok() { [ "$1" = "$PRAXIS_STORAGE_BUCKET" ]; }

# Host do endpoint (sem esquema, usuário, porta ou caminho), em minúsculas. Devolve 1 se não for http(s).
s3_endpoint_host() {
  local url="$1" rest hostport host
  case "$url" in
    http://*|https://*) ;;
    *) return 1 ;;
  esac
  rest="${url#*://}"
  hostport="${rest%%/*}"
  case "$hostport" in *@*) return 1 ;; esac # credenciais embutidas na URL: recusado
  case "$hostport" in
    \[*\]*) host="${hostport%%\]*}"; host="${host#\[}" ;;
    *) host="${hostport%%:*}" ;;
  esac
  [ -n "$host" ] || return 1
  printf '%s' "$host" | tr '[:upper:]' '[:lower:]'
}

# Prepara o ambiente do aws: endpoint, região e credenciais SÓ por variáveis (nunca por argumento) e sem
# perfil, arquivo de configuração, metadados da instância ou token de sessão herdados do ambiente.
# $1 endpoint  $2 região  $3 access key id  $4 secret
s3_prepare_env() {
  unset AWS_PROFILE AWS_SESSION_TOKEN AWS_SECURITY_TOKEN AWS_CA_BUNDLE AWS_ENDPOINT_URL_S3
  export AWS_ENDPOINT_URL="$1"
  export AWS_DEFAULT_REGION="$2"
  export AWS_REGION="$2"
  export AWS_ACCESS_KEY_ID="$3"
  export AWS_SECRET_ACCESS_KEY="$4"
  export AWS_CONFIG_FILE=/dev/null
  export AWS_SHARED_CREDENTIALS_FILE=/dev/null
  export AWS_EC2_METADATA_DISABLED=true
  export AWS_PAGER=""
  # Provedores compatíveis com S3 não aceitam as somas de verificação extras das versões novas do cliente.
  export AWS_REQUEST_CHECKSUM_CALCULATION=when_required
  export AWS_RESPONSE_CHECKSUM_VALIDATION=when_required
}

# ETag sem aspas e sem o prefixo de ETag fraco, para comparar listagem, HeadObject e GetObject.
s3_etag_norm() {
  local v="$1"
  v="${v#W/}"
  v="${v#\"}"
  v="${v%\"}"
  printf '%s' "$v"
}

# Traduz o ERRO do aws (arquivo $1, nunca impresso) em um código fechado.
s3_error_code() {
  local f="$1"
  if grep -q -i -E 'InvalidAccessKeyId|SignatureDoesNotMatch|AccessDenied|InvalidSignature|Unauthorized|Forbidden|\(403\)|\(401\)' "$f" 2>/dev/null; then
    printf 'credencial_invalida'
  elif grep -q -i -E 'NoSuchBucket|\(404\).*bucket' "$f" 2>/dev/null; then
    printf 'bucket_inexistente'
  elif grep -q -i -E 'Could not connect|Connection refused|Could not resolve|Name or service|timed out|EndpointConnectionError|Connect timeout|SSL' "$f" 2>/dev/null; then
    printf 'conexao_falhou'
  else
    printf 'listagem_falhou'
  fi
}

# Lista TODOS os objetos do bucket $BUCKET, página a página (tamanho $PAGE), e grava em $1 um array JSON
# ordenado por chave: [{"k":chave,"s":tamanho,"e":etag,"m":última_modificação}, ...].
# Precisa de: WORK (pasta de trabalho), ERR (arquivo de erro), BUCKET, PAGE e die().
s3_list_all() {
  local out="$1" token="" page=0 trunc args
  : >"$WORK/items.ndjson"
  while :; do
    page=$((page + 1))
    [ "$page" -le 100000 ] || die "listagem_paginas_demais" 70
    args=(s3api list-objects-v2 --bucket "$BUCKET" --max-keys "$PAGE" --output json --no-paginate)
    [ -z "$token" ] || args+=(--continuation-token "$token")
    aws "${args[@]}" >"$WORK/page.json" 2>"$ERR" || die "$(s3_error_code "$ERR")" 69
    jq -c '(.Contents // [])[] | {k: .Key, s: .Size, e: (.ETag // ""), m: (.LastModified // "")}' "$WORK/page.json" >>"$WORK/items.ndjson" 2>"$ERR" || die "listagem_pagina_invalida" 70
    trunc="$(jq -r '.IsTruncated // false' "$WORK/page.json" 2>"$ERR")" || die "listagem_pagina_invalida" 70
    if [ "$trunc" = "true" ]; then
      token="$(jq -r '.NextContinuationToken // ""' "$WORK/page.json" 2>"$ERR")" || die "listagem_pagina_invalida" 70
      [ -n "$token" ] || die "listagem_token_ausente" 70
    else
      break
    fi
  done
  jq -s -c 'sort_by(.k)' "$WORK/items.ndjson" >"$out" 2>"$ERR" || die "listagem_pagina_invalida" 70
  rm -f "$WORK/items.ndjson" "$WORK/page.json"
  # Formato: chave sem caracteres de controle e tamanho inteiro >= 0; e unicidade: sem chave repetida.
  jq -e 'all(.[]; (.k | type == "string" and length > 0 and (test("[[:cntrl:]]") | not))
                  and (.s | type == "number" and . >= 0 and . == floor))' "$out" >/dev/null 2>"$ERR" || die "listagem_formato_invalido" 70
  jq -e '(map(.k) | unique | length) == length' "$out" >/dev/null 2>"$ERR" || die "listagem_chave_repetida" 70
}
