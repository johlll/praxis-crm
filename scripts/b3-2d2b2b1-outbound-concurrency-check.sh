#!/usr/bin/env bash
# B3.2d-2b2b1 — o efeito de mensagem de saída observada
# (public.whatsapp_effect_outbound_observed) sob concorrência REAL (várias
# sessões Postgres simultâneas). O pgTAP 37 roda numa sessão só; aqui se
# prova, entre transações:
#
#   1. Duas execuções do MESMO evento (mesma entrada, mesmo token) ao mesmo
#      tempo: uma `applied`, a outra espera a trava da inbox e vê
#      `already_processed`. Uma mensagem só.
#   2. `smb.message.echoes` e `smb.message.created` da MESMA mensagem (dois
#      eventos, o mesmo id do provedor; só um traz o wamid) ao mesmo tempo:
#      um `applied`, o outro `duplicate`; uma mensagem, com o wamid.
#   3. Duas mensagens diferentes para o MESMO destinatário novo (telefone +
#      BSUID) ao mesmo tempo: uma identidade só, uma conversa só, duas
#      mensagens, nenhum contato ou lead.
#   4. O mesmo wamid com ids do provedor diferentes, ao mesmo tempo: um
#      `applied`, o outro `message_conflict`; uma mensagem, e o conflito não
#      grava ledger nem finaliza a entrada.
#   5. O canal é pausado com um efeito em andamento: a pausa espera o
#      efeito terminar; um claim obtido com o canal ativo e usado depois da
#      pausa vê `channel_paused`, sem efeito.
#
# Nos cenários 2 a 5, uma sessão segura a trava do telefone (a mesma que o
# efeito pede) para que as execuções esperem juntas e corram uma logo
# depois da outra. Canal próprio, dados fictícios e o Postgres local do CI.
# Nada de provedor, nada hospedado, nenhuma mensagem enviada.
set -euo pipefail

DB_CONTAINER="supabase_db_praxis-crm"
WS="10000000-0000-0000-0000-000000000001"
DONO="20000000-0000-0000-0000-000000000001"
CANAL="$(cat /proc/sys/kernel/random/uuid)"
ROUTING="b3d2b2b1-conc-$(date +%s%N | tail -c 9)"
SUFIXO="$(date +%s%N | tail -c 7)"
P1="+55119200${SUFIXO:0:5}1"
P2="+55119200${SUFIXO:0:5}2"
P3="+55119200${SUFIXO:0:5}3"
P4="+55119200${SUFIXO:0:5}4"
P5="+55119200${SUFIXO:0:5}5"
B3="$(head -c 32 /dev/urandom | base64)"
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
    if [ "$(psql_as b3d2b2b1_main -c "select count(*) from pg_stat_activity where application_name = '$1' and query like '%pg_sleep%' and state = 'active'")" = "1" ]; then
      return 0
    fi
    sleep 0.1
  done
  fail "a sessão $1 não chegou ao pg_sleep"
}

wait_lock_waiters() { # espera $1 sessões com prefixo $2 paradas numa trava
  for _ in $(seq 1 100); do
    if [ "$(psql_as b3d2b2b1_main -c "select count(*) from pg_stat_activity where application_name like '$2%' and wait_event_type = 'Lock'")" = "$1" ]; then
      return 0
    fi
    sleep 0.1
  done
  fail "as $1 sessões $2* não chegaram à espera pela trava"
}

lookup() { [ -n "$1" ] && echo "'{\"1\": \"$1\"}'::jsonb" || echo "null"; }
obs_sql() { # entrada token pmid wamid telefone bsuid
  local wamid="null"; [ -n "$4" ] && wamid="'$4'"
  local phone="null"; [ -n "$5" ] && phone="'$5'"
  local cipher="null" version="null"; [ -n "$6" ] && cipher="'$CT'" && version="'1'"
  echo "$SERVICE_SQL
select public.whatsapp_effect_outbound_observed('$1'::uuid, '$2'::uuid, '$3', $wamid, 'text', 'Mensagem fictícia do escritório (concorrência)', now(), $phone, $(lookup "$6"), $cipher, $version) ->> 'outcome';"
}
q() { psql_as b3d2b2b1_main -c "$1"; }

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

# Duas execuções em paralelo, paradas na trava; devolve as saídas em $R1 e $R2.
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
SETUP="$(psql_as b3d2b2b1_setup <<SQL
insert into public.whatsapp_environment_keys (environment, signing_key) values
  ('preview', 'chave-whatsapp-preview-concorrencia-0123456789')
on conflict do nothing;
$SERVICE_SQL
select public.whatsapp_create_simulated_channel('$CANAL'::uuid, '$WS'::uuid, '$DONO'::uuid, 'Concorrência B3.2d-2b2b1', '$ROUTING', '1',
  'QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFB', '1') is not null as ok \gset
with e as (
  select n, public.whatsapp_inbox_store('$CANAL'::uuid, '$WS'::uuid, 'simulated', '$ROUTING', 'evt-ob-' || n,
    case when n % 2 = 0 then 'whatsapp.smb.message.created' else 'whatsapp.smb.message.echoes' end,
    repeat('a', 64), '1', 'AAAAAAAAAAAAAAAA', 'Q29ycG8gZmljdGljaW8gMQ==', 'AAAAAAAAAAAAAAAAAAAAAA==', 3600) ->> 'inbox_id' as id
  from generate_series(1, 9) n
)
select string_agg(e.id || ',' || (public.whatsapp_inbox_claim(e.id::uuid, 600) ->> 'claim_token'), ' ' order by n) from e;
SQL
)"
read -r -a ENTRIES <<<"$(echo "$SETUP" | tail -1)"
[ "${#ENTRIES[@]}" = "9" ] || fail "preparo sem resultado: $SETUP"
id() { echo "${ENTRIES[$1]%%,*}"; }
tok() { echo "${ENTRIES[$1]##*,}"; }
COMERCIAL_ANTES="$(q "select (select count(*) from public.contacts) || '|' || (select count(*) from public.leads) || '|' || (select count(*) from public.opportunities) || '|' || (select count(*) from public.activities)")"

echo "== 1. duas execuções do mesmo evento ao mesmo tempo"
OUT_X="$(mktemp)"
psql_as b3d2b2b1_x > "$OUT_X" 2>&1 <<SQL &
begin;
select 1 from public.whatsapp_webhook_inbox where id = '$(id 0)' for update;
select pg_sleep(4);
commit;
SQL
HOLD_PID=$!
wait_sleeping b3d2b2b1_x
run_pair b3d2b2b1_e "$(obs_sql "$(id 0)" "$(tok 0)" "pm-ob-1" "wamid.CONC1" "$P1" "")" "$(obs_sql "$(id 0)" "$(tok 0)" "pm-ob-1" "wamid.CONC1" "$P1" "")"
[ "$(printf '%s\n%s\n' "$R1" "$R2" | sort | tr '\n' ' ')" = "already_processed applied " ] || fail "esperado um applied e um already_processed: $R1 / $R2"
[ "$(q "select count(*) from public.messages where channel_id = '$CANAL' and provider_message_id = 'pm-ob-1'")" = "1" ] || fail "o mesmo evento gravou mais de uma mensagem"
echo "   ok: applied e already_processed; uma mensagem"

echo "== 2. echoes e created da mesma mensagem ao mesmo tempo"
hold_phone_lock b3d2b2b1_h2 "$P2"
run_pair b3d2b2b1_c "$(obs_sql "$(id 1)" "$(tok 1)" "pm-ob-2" "" "$P2" "")" "$(obs_sql "$(id 2)" "$(tok 2)" "pm-ob-2" "wamid.CONC2" "$P2" "")"
[ "$(printf '%s\n%s\n' "$R1" "$R2" | sort | tr '\n' ' ')" = "applied duplicate " ] || fail "esperado um applied e um duplicate: $R1 / $R2"
MSG="$(q "select count(*) || '|' || count(*) filter (where wa_message_id = 'wamid.CONC2') from public.messages where channel_id = '$CANAL' and (provider_message_id = 'pm-ob-2' or wa_message_id = 'wamid.CONC2')")"
[ "$MSG" = "1|1" ] || fail "esperada uma mensagem, com o wamid, veio: $MSG"
[ "$(q "select count(distinct message_id) || '|' || count(*) from public.whatsapp_effect_ledger where inbox_id in ('$(id 1)', '$(id 2)')")" = "1|2" ] || fail "os dois ledgers deveriam apontar para a mesma mensagem"
echo "   ok: applied e duplicate; uma mensagem com o wamid; os dois ledgers nela"

echo "== 3. duas mensagens para o mesmo destinatário novo (telefone + BSUID) ao mesmo tempo"
hold_phone_lock b3d2b2b1_h3 "$P3"
run_pair b3d2b2b1_n "$(obs_sql "$(id 3)" "$(tok 3)" "pm-ob-3a" "" "$P3" "$B3")" "$(obs_sql "$(id 4)" "$(tok 4)" "pm-ob-3b" "" "$P3" "$B3")"
[ "$R1 $R2" = "applied applied" ] || fail "as duas mensagens deveriam aplicar: $R1 / $R2"
IDENT="$(q "select count(*) || '|' || count(*) filter (where bsuid_blind_index = decode('$B3', 'base64')) from public.whatsapp_identities where channel_id = '$CANAL' and (phone_e164 = '$P3' or bsuid_blind_index = decode('$B3', 'base64'))")"
[ "$IDENT" = "1|1" ] || fail "esperada uma identidade com telefone e BSUID, veio: $IDENT"
CONV="$(q "select count(distinct c.id) || '|' || count(m.id) || '|' || bool_and(c.contact_id is null and c.lead_id is null) from public.conversations c join public.whatsapp_identities i on i.id = c.identity_id left join public.messages m on m.conversation_id = c.id where i.channel_id = '$CANAL' and i.phone_e164 = '$P3'")"
[ "$CONV" = "1|2|true" ] || fail "esperada uma conversa sem contato nem lead e duas mensagens, veio: $CONV"
echo "   ok: uma identidade, uma conversa, duas mensagens, nada comercial"

echo "== 4. o mesmo wamid com ids do provedor diferentes ao mesmo tempo"
hold_phone_lock b3d2b2b1_h4 "$P4"
run_pair b3d2b2b1_w "$(obs_sql "$(id 5)" "$(tok 5)" "pm-ob-4a" "wamid.CONC4" "$P4" "")" "$(obs_sql "$(id 6)" "$(tok 6)" "pm-ob-4b" "wamid.CONC4" "$P4" "")"
[ "$(printf '%s\n%s\n' "$R1" "$R2" | sort | tr '\n' ' ')" = "applied message_conflict " ] || fail "esperado um applied e um message_conflict: $R1 / $R2"
[ "$(q "select count(*) from public.messages where channel_id = '$CANAL' and wa_message_id = 'wamid.CONC4'")" = "1" ] || fail "o mesmo wamid gravou mais de uma mensagem"
[ "$(q "select count(l.id) || '|' || string_agg(w.state, ',' order by w.state) from public.whatsapp_effect_ledger l right join public.whatsapp_webhook_inbox w on w.id = l.inbox_id where w.id in ('$(id 5)', '$(id 6)')")" = "1|processed,processing" ] || fail "o conflito gravou ledger ou finalizou a entrada"
echo "   ok: applied e message_conflict; uma mensagem; o conflito sem ledger e com a entrada em processing"

echo "== 5. o canal é pausado enquanto o efeito roda, e depois de um claim"
hold_phone_lock b3d2b2b1_h5 "$P5"
OUT_5="$(mktemp)"; OUT_P="$(mktemp)"
echo "$(obs_sql "$(id 7)" "$(tok 7)" "pm-ob-5" "" "$P5" "")" | psql_as b3d2b2b1_p5e > "$OUT_5" 2>&1 &
P_EF=$!
wait_lock_waiters 1 b3d2b2b1_p5e
psql_as b3d2b2b1_p5p -c "update public.whatsapp_channels set status = 'paused', send_enabled = false, status_changed_at = now() where id = '$CANAL'" > "$OUT_P" 2>&1 &
P_PAUSE=$!
# O efeito já leu o canal ativo e o segura: a pausa espera ele terminar.
for _ in $(seq 1 30); do
  [ "$(q "select count(*) from pg_stat_activity where application_name = 'b3d2b2b1_p5p' and wait_event_type = 'Lock'")" = "1" ] && break
  kill -0 "$P_PAUSE" 2> /dev/null || fail "a pausa terminou sem esperar o efeito em andamento"
  sleep 0.1
done
[ "$(q "select count(*) from pg_stat_activity where application_name = 'b3d2b2b1_p5p' and wait_event_type = 'Lock'")" = "1" ] || fail "a pausa não esperou o efeito em andamento"
wait "$HOLD_PID" || fail "a sessão que segura a trava falhou"
wait $P_EF || fail "o efeito falhou: $(cat "$OUT_5")"
wait $P_PAUSE || fail "a pausa falhou: $(cat "$OUT_P")"
[ "$(tail -1 "$OUT_5")" = "applied" ] || fail "o efeito que leu o canal ativo deveria aplicar: $(tail -1 "$OUT_5")"
[ "$(q "select status from public.whatsapp_channels where id = '$CANAL'")" = "paused" ] || fail "a pausa não ficou gravada"
[ "$(echo "$(obs_sql "$(id 8)" "$(tok 8)" "pm-ob-5b" "" "+55119200${SUFIXO:0:5}6" "")" | psql_as b3d2b2b1_main | tail -1)" = "channel_paused" ] || fail "o claim antigo deveria ver o canal pausado"
[ "$(q "select count(*) from public.messages where channel_id = '$CANAL' and provider_message_id = 'pm-ob-5b'")|$(q "select count(*) from public.whatsapp_effect_ledger where inbox_id = '$(id 8)'")|$(q "select state from public.whatsapp_webhook_inbox where id = '$(id 8)'")" = "0|0|processing" ] || fail "o canal pausado deixou efeito ou finalizou a entrada"
echo "   ok: a pausa esperou o efeito em andamento; o claim antigo viu channel_paused, sem efeito, entrada em processing"

[ "$(q "select (select count(*) from public.contacts) || '|' || (select count(*) from public.leads) || '|' || (select count(*) from public.opportunities) || '|' || (select count(*) from public.activities)")" = "$COMERCIAL_ANTES" ] || fail "a saída observada criou registro comercial"
echo "== efeito de saída observada sob concorrência real: OK"
