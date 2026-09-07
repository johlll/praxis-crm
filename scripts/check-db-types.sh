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
  diff "$COMMITTED" "$FRESH" >&2 || true
  echo >&2
  # Conteúdo completo do arquivo esperado — útil quando quem está lendo o
  # log não tem Docker para rodar o gerador (é o caso do ambiente de
  # desenvolvimento atual, ver A2-HANDOFF.md).
  echo "===== INICIO DO ARQUIVO GERADO =====" >&2
  cat "$FRESH" >&2
  echo "===== FIM DO ARQUIVO GERADO =====" >&2
  exit 1
fi

echo "src/server/types/database.ts está em dia com as migrations."
