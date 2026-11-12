#!/usr/bin/env bash
# B6c — funções comuns do backup e da restauração (formato praxis-backup/v1).
#
# Regras que valem para os dois scripts:
#   - NUNCA imprimir URL, senha, SQL, dado ou a saída das ferramentas (pg_dump, psql, age, tar).
#     Só mensagens com CÓDIGO FECHADO ("ERRO: <codigo>"). A saída das ferramentas vai para um
#     arquivo temporário que nunca é lido nem impresso.
#   - A URL do banco vem SÓ de variável de ambiente. Ela é desmontada aqui em variáveis PG* do
#     libpq (lidas pelo processo filho) e a variável original é apagada: o endereço e a senha
#     nunca viram argumento de comando.
#   - Sem rastreamento de comandos do shell, em nenhum lugar (ele imprimiria URL e senha).

PRAXIS_BACKUP_FORMAT="praxis-backup/v1"
PRAXIS_PG_MAJOR="17"
# Arquivos do pacote, na ordem em que a restauração os aplica.
PRAXIS_PKG_FILES=(
  "01-schema-auth.sql"
  "02-schema-app.sql"
  "03-schema-auth-triggers.sql"
  "04-data-auth.sql"
  "05-data-app.sql"
)

die() { # $1 = código fechado; $2 = código de saída (padrão 1)
  printf 'ERRO: %s\n' "$1" >&2
  exit "${2:-1}"
}

need_tool() { # $1 = ferramenta
  command -v "$1" >/dev/null 2>&1 || die "ferramenta_ausente:$1" 127
}

pct_decode() { # decodifica %XX (senha/usuário da URL) sem passar por eval
  local s="$1"
  s="${s//\\/\\\\}"
  printf '%b' "${s//%/\\x}"
}

# Desmonta uma URL postgresql://usuario:senha@host:porta/banco?sslmode=... em variáveis PG*.
# Devolve 1 se a URL não tiver o formato esperado. Não imprime nada.
parse_database_url() {
  local url="$1" rest userinfo hostport path query user pass host port db ssl
  case "$url" in
    postgresql://*|postgres://*) ;;
    *) return 1 ;;
  esac
  rest="${url#*://}"
  case "$rest" in *@*) ;; *) return 1 ;; esac
  userinfo="${rest%@*}"
  rest="${rest##*@}"
  query=""
  case "$rest" in *\?*) query="${rest#*\?}"; rest="${rest%%\?*}" ;; esac
  hostport="${rest%%/*}"
  path=""
  case "$rest" in */*) path="${rest#*/}" ;; esac
  user="${userinfo%%:*}"
  pass=""
  case "$userinfo" in *:*) pass="${userinfo#*:}" ;; esac
  case "$hostport" in
    \[*\]*) host="${hostport%%\]*}"; host="${host#\[}"; port="${hostport##*\]}"; port="${port#:}" ;;
    *:*) host="${hostport%%:*}"; port="${hostport##*:}" ;;
    *) host="$hostport"; port="" ;;
  esac
  db="${path:-postgres}"
  [ -n "$user" ] && [ -n "$host" ] || return 1
  case "$port" in ''|*[!0-9]*) [ -z "$port" ] || return 1 ;; esac
  ssl=""
  case "&$query&" in *"&sslmode="*) ssl="${query#*sslmode=}"; ssl="${ssl%%&*}" ;; esac
  case "$host" in
    localhost|127.*|::1) : "${ssl:=prefer}" ;;
    *) : "${ssl:=require}" ;;
  esac
  export PGHOST PGPORT PGUSER PGPASSWORD PGDATABASE PGSSLMODE
  PGHOST="$host"
  PGPORT="${port:-5432}"
  PGUSER="$(pct_decode "$user")"
  PGPASSWORD="$(pct_decode "$pass")"
  PGDATABASE="$(pct_decode "$db")"
  PGSSLMODE="$ssl"
  return 0
}

pg_major_ok() { # a ferramenta $1 (pg_dump/psql) é da versão 17?
  local v
  v="$("$1" --version 2>/dev/null || true)"
  case "$v" in *" ${PRAXIS_PG_MAJOR}."*|*" ${PRAXIS_PG_MAJOR} "*) return 0 ;; esac
  return 1
}

sha256_of() { # hash SHA-256 (hex) do arquivo $1
  local out
  out="$(sha256sum "$1")" || return 1
  printf '%s' "${out%% *}"
}

is_sha256() { # $1 tem 64 dígitos hexadecimais?
  case "$1" in
    *[!0-9a-fA-F]*|'') return 1 ;;
  esac
  [ "${#1}" -eq 64 ]
}
