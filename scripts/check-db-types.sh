#!/usr/bin/env bash
# Gera os tipos a partir do banco local (que já rodou as migrations desta
# branch) e falha se divergirem do que está commitado em
# src/server/types/database.ts. Pressupõe `supabase start` + migrations já
# aplicadas — é isso que impede o arquivo "gerado" de ficar desatualizado
# sem ninguém perceber.
set -euo pipefail

COMMITTED="src/server/types/database.ts"
FRESH="$(mktemp)"
trap 'rm -f "$FRESH"' EXIT

supabase gen types typescript --local --schema public > "$FRESH"

if ! diff -q "$COMMITTED" "$FRESH" > /dev/null; then
  echo "src/server/types/database.ts está desatualizado em relação às migrations." >&2
  echo "Rode 'npm run db:types:local' (com o Supabase local rodando) e commit o resultado." >&2
  echo >&2
  echo "Diferença:" >&2
  diff "$COMMITTED" "$FRESH" || true
  exit 1
fi

echo "src/server/types/database.ts está em dia com as migrations."
