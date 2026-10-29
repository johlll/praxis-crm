#!/usr/bin/env bash
# B3.2d-2b2a — o efeito de mensagem recebida
# (public.whatsapp_effect_inbound_message) sob concorrência REAL (várias
# sessões Postgres simultâneas). O pgTAP 36 roda numa sessão só; aqui se
# prova, entre transações:
#
#   1. Duas execuções do MESMO evento (mesma entrada, mesmo token) ao mesmo
#      tempo: uma `applied`, a outra espera a trava da inbox e vê
#      `already_processed`. Uma mensagem só.
#   2. Dois eventos do MESMO remetente novo (telefone + BSUID) ao mesmo
#      tempo: uma identidade só, uma conversa só, um lead só, duas
#      mensagens.
#   3. Enriquecimento simultâneo: a identidade só tem o telefone; dois
#      eventos com telefone + BSUID ao mesmo tempo. Uma identidade, que
#      ganha o BSUID uma vez; nenhuma identidade nova.
#   4. Telefone de uma identidade e BSUID de outra, em dois eventos ao
#      mesmo tempo: os dois `identity_conflict`, nenhum efeito, as
#      identidades intactas e as entradas ainda em processing.
#
# Nos cenários 2 a 4, uma sessão segura a trava do telefone (a mesma que o
# efeito pede) para que as duas execuções esperem juntas e corram uma logo
# depois da outra. Canal próprio, dados fictícios e o Postgres local do CI.
# Nada de provedor, nada hospedado.
set -euo pipefail

DB_CONTAINER="supabase_db_praxis-crm"
WS="10000000-0000-0000-0000-000000000001"
DONO="20000000-0000-0000-0000-000000000001"
CANAL="$(cat /proc/sys/kernel/random/uuid)"
ROUTING="b3d2b2a-conc-$(date +%s%N | tail -c 9)"
SUFIXO="$(date +%s%N | tail -c 7)"
P2="+55119100${SUFIXO:0:5}2"
P3="+55119100${SUFIXO:0:5}3"
P4="+55119100${SUFIXO:0:5}4"
B2="$(head -c 32 /dev/urandom | base64)"
B3="$(head -c 32 /dev/urandom | base64)"
B4="$(head -c 32 /dev/urandom | base64)"
CT="$(head -c 40 /dev/urandom | base64)"

psql_as() { # $1 = application_name; resto = argumentos do psql
  local app="$1"; shift
  docker exec -i -e PGAPPNAME="$app" "$DB_CONTAINER" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -qAt "$@"
}

SERVICE_SQL="select set_config('request.headers', json_build_object('x-praxis-whatsapp-env', 'v1.preview.' || e.x || '.' || private.whatsapp_environment_signature('preview', e.x, k.signing_key))::text, false)
  from (select extract(epoch from now())::bigint + 600 as x) e,
       (select signing_key from public.whatsapp_environment_keys where environment = 'preview') k \\g /dev/null
set role service_role;"

fail() { echo "FALHOU: $*" >&2; exit 1; }

wait_sleeping() { # espera a sessão $1 entrar no pg_sleep (transação aberta)
  for _ in $(seq 1 100); do
    if [ "$(psql_as b3d2b2a_main -c "select count(*) from pg_stat_activity where application_name = '$1' and query like '%pg_sleep%' and state = 'active'")" = "1" ]; then
      return 0
    fi
    sleep 0.1
  done
  fail "a sessão $1 não chegou ao pg_sleep"
}

wait_lock_waiters() { # espera $1 sessões com prefixo $2 paradas numa trava
  for _ in $(seq 1 100); do
    if [ "$(psql_as b3d2b2a_main -c "select count(*) from pg_stat_activity where application_name like '$2%' and wait_event_type = 'Lock'")" = "$1" ]; then
      return 0
    fi
    sleep 0.1
  done
  fail "as $1 sessões $2* não chegaram à espera pela trava"
}

lookup() { [ -n "$1" ] && echo "'{\"1\": \"$1\"}'::jsonb" || echo "null"; }
apply_sql() { # entrada token pmid telefone bsuid
  local phone="null"; [ -n "$4" ] && phone="'$4'"
  local cipher="null" version="null"; [ -n "$5" ] && cipher="'$CT'" && version="'1'"
  echo "$SERVICE_SQL
select public.whatsapp_effect_inbound_message('$1'::uuid, '$2'::uuid, '$3', 'text', 'Mensagem fictícia de concorrência', now(), $phone, $(lookup "$5"), $cipher, $version, null) ->> 'outcome';"
}
q() { psql_as b3d2b2a_main -c "$1"; }

# Segura a trava do telefone (a mesma do efeito) por 4 s.
hold_phone_lock() { # $1 = application_name, $2 = telefone
  psql_as "$1" > /dev/null 2>&1 <<SQL &
begin;
select pg_advisory_xact_lock(hashtextextended('$CANAL' || ':' || '$2', 0));
select pg_sleep(4);
commit;
SQL
  HOLD_PID=$!
  wait_sleeping "$1"
}

# Duas execuções em paralelo, paradas na trava; devolve as saídas em $OUT_1 e $OUT_2.
run_pair() { # prefixo sql1 sql2
  OUT_1="$(mktemp)"; OUT_2="$(mktemp)"
  echo "$2" | psql_as "${1}1" > "$OUT_1" 2>&1 &
  local p1=$!
  echo "$3" | psql_as "${1}2" > "$OUT_2" 2>&1 &
  local p2=$!
  wait_lock_waiters 2 "$1"
  wait "$HOLD_PID" || fail "a sessão que segura a trava falhou"
  wait $p1 || fail "execução 1 falhou: $(cat "$OUT_1")"
  wait $p2 || fail "execução 2 falhou: $(cat "$OUT_2")"
  R1="$(tail -1 "$OUT_1")"; R2="$(tail -1 "$OUT_2")"
}

echo "== preparo (canal e entradas próprios)"
SETUP="$(psql_as b3d2b2a_setup <<SQL
insert into public.whatsapp_environment_keys (environment, signing_key) values
  ('preview', 'chave-whatsapp-preview-concorrencia-0123456789')
on conflict do nothing;
$SERVICE_SQL
select public.whatsapp_create_simulated_channel('$CANAL'::uuid, '$WS'::uuid, '$DONO'::uuid, 'Concorrência B3.2d-2b2a', '$ROUTING', '1',
  'QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFB', '1') is not null as ok \gset
reset role;
-- Uma identidade interna ativa (telefone e BSUID): todo remetente é
-- comparável, e quem não casa é external (cria um lead).
insert into public.whatsapp_internal_identities (workspace_id, channel_id, environment, provider, label, phone_e164, bsuid_blind_index, bsuid_ciphertext, bsuid_key_version, created_by)
values ('$WS'::uuid, '$CANAL'::uuid, 'preview', 'simulated', 'Recepção (fictícia)', '+5511910009999', decode('$(head -c 32 /dev/urandom | base64)', 'base64'), decode('$CT', 'base64'), '1', '$DONO'::uuid);
set role service_role;
with e as (
  select n, public.whatsapp_inbox_store('$CANAL'::uuid, '$WS'::uuid, 'simulated', '$ROUTING', 'evt-ef-' || n, 'whatsapp.inbound_message.received',
    repeat('a', 64), '1', 'AAAAAAAAAAAAAAAA', 'Q29ycG8gZmljdGljaW8gMQ==', 'AAAAAAAAAAAAAAAAAAAAAA==', 3600) ->> 'inbox_id' as id
  from generate_series(1, 10) n
)
select string_agg(e.id || ',' || (public.whatsapp_inbox_claim(e.id::uuid, 600) ->> 'claim_token'), ' ' order by n) from e;
SQL
)"
read -r -a ENTRIES <<<"$(echo "$SETUP" | tail -1)"
[ "${#ENTRIES[@]}" = "10" ] || fail "preparo sem resultado: $SETUP"
id() { echo "${ENTRIES[$1]%%,*}"; }
tok() { echo "${ENTRIES[$1]##*,}"; }

echo "== 1. duas execuções do mesmo evento ao mesmo tempo"
OUT_X="$(mktemp)"
psql_as b3d2b2a_x > "$OUT_X" 2>&1 <<SQL &
begin;
select 1 from public.whatsapp_webhook_inbox where id = '$(id 0)' for update;
select pg_sleep(4);
commit;
SQL
HOLD_PID=$!
wait_sleeping b3d2b2a_x
run_pair b3d2b2a_e "$(apply_sql "$(id 0)" "$(tok 0)" "pm-ef-1" "+5511910000001" "")" "$(apply_sql "$(id 0)" "$(tok 0)" "pm-ef-1" "+5511910000001" "")"
[ "$(printf '%s\n%s\n' "$R1" "$R2" | sort | tr '\n' ' ')" = "already_processed applied " ] || fail "esperado um applied e um already_processed: $R1 / $R2"
[ "$(q "select count(*) from public.messages where channel_id = '$CANAL' and provider_message_id = 'pm-ef-1'")" = "1" ] || fail "o mesmo evento gravou mais de uma mensagem"
echo "   ok: applied e already_processed; uma mensagem"

echo "== 2. dois eventos do mesmo remetente novo (telefone + BSUID) ao mesmo tempo"
hold_phone_lock b3d2b2a_h2 "$P2"
run_pair b3d2b2a_n "$(apply_sql "$(id 1)" "$(tok 1)" "pm-ef-2a" "$P2" "$B2")" "$(apply_sql "$(id 2)" "$(tok 2)" "pm-ef-2b" "$P2" "$B2")"
[ "$R1 $R2" = "applied applied" ] || fail "os dois eventos deveriam aplicar: $R1 / $R2"
IDENT="$(q "select count(*) || '|' || count(*) filter (where bsuid_blind_index = decode('$B2', 'base64')) from public.whatsapp_identities where channel_id = '$CANAL' and (phone_e164 = '$P2' or bsuid_blind_index = decode('$B2', 'base64'))")"
[ "$IDENT" = "1|1" ] || fail "esperada uma identidade com telefone e BSUID, veio: $IDENT"
CONV="$(q "select count(distinct c.id) || '|' || count(distinct c.lead_id) || '|' || count(m.id) from public.conversations c join public.whatsapp_identities i on i.id = c.identity_id left join public.messages m on m.conversation_id = c.id where i.channel_id = '$CANAL' and i.phone_e164 = '$P2'")"
[ "$CONV" = "1|1|2" ] || fail "esperada uma conversa, um lead e duas mensagens, veio: $CONV"
echo "   ok: uma identidade, uma conversa, um lead, duas mensagens"

echo "== 3. enriquecimento simultâneo telefone/BSUID"
[ "$(echo "$(apply_sql "$(id 3)" "$(tok 3)" "pm-ef-3" "$P3" "")" | psql_as b3d2b2a_main | tail -1)" = "applied" ] || fail "a identidade só com telefone não foi criada"
hold_phone_lock b3d2b2a_h3 "$P3"
run_pair b3d2b2a_r "$(apply_sql "$(id 4)" "$(tok 4)" "pm-ef-3a" "$P3" "$B3")" "$(apply_sql "$(id 5)" "$(tok 5)" "pm-ef-3b" "$P3" "$B3")"
[ "$R1 $R2" = "applied applied" ] || fail "os dois eventos deveriam aplicar: $R1 / $R2"
IDENT="$(q "select count(*) || '|' || count(*) filter (where phone_e164 = '$P3' and bsuid_blind_index = decode('$B3', 'base64')) from public.whatsapp_identities where channel_id = '$CANAL' and (phone_e164 = '$P3' or bsuid_blind_index = decode('$B3', 'base64'))")"
[ "$IDENT" = "1|1" ] || fail "esperada uma identidade enriquecida, veio: $IDENT"
echo "   ok: uma identidade, enriquecida com o BSUID uma vez"

echo "== 4. telefone e BSUID de identidades diferentes, ao mesmo tempo"
[ "$(echo "$(apply_sql "$(id 6)" "$(tok 6)" "pm-ef-4p" "$P4" "")" | psql_as b3d2b2a_main | tail -1)" = "applied" ] || fail "a identidade do telefone não foi criada"
[ "$(echo "$(apply_sql "$(id 7)" "$(tok 7)" "pm-ef-4b" "" "$B4")" | psql_as b3d2b2a_main | tail -1)" = "applied" ] || fail "a identidade do BSUID não foi criada"
BEFORE="$(q "select string_agg(id::text || coalesce(phone_e164, '-') || coalesce(encode(bsuid_blind_index, 'base64'), '-'), ',' order by id) from public.whatsapp_identities where channel_id = '$CANAL'")"
hold_phone_lock b3d2b2a_h4 "$P4"
run_pair b3d2b2a_c "$(apply_sql "$(id 8)" "$(tok 8)" "pm-ef-4c" "$P4" "$B4")" "$(apply_sql "$(id 9)" "$(tok 9)" "pm-ef-4d" "$P4" "$B4")"
[ "$R1 $R2" = "identity_conflict identity_conflict" ] || fail "os dois deveriam ser identity_conflict: $R1 / $R2"
[ "$(q "select string_agg(id::text || coalesce(phone_e164, '-') || coalesce(encode(bsuid_blind_index, 'base64'), '-'), ',' order by id) from public.whatsapp_identities where channel_id = '$CANAL'")" = "$BEFORE" ] || fail "o conflito mudou identidades"
[ "$(q "select count(*) from public.messages where channel_id = '$CANAL' and provider_message_id in ('pm-ef-4c', 'pm-ef-4d')")" = "0" ] || fail "o conflito gravou mensagem"
[ "$(q "select count(*) from public.whatsapp_effect_ledger where inbox_id in ('$(id 8)', '$(id 9)')")" = "0" ] || fail "o conflito gravou ledger"
[ "$(q "select string_agg(state, ',') from public.whatsapp_webhook_inbox where id in ('$(id 8)', '$(id 9)')")" = "processing,processing" ] || fail "o conflito finalizou a inbox"
echo "   ok: dois identity_conflict; identidades intactas; nenhum ledger, mensagem ou finalização"

echo "== efeito de mensagem recebida sob concorrência real: OK"
