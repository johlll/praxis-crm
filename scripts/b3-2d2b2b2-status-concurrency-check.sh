#!/usr/bin/env bash
# B3.2d-2b2b2 — o efeito de status e custo (public.whatsapp_effect_message_status)
# sob concorrência REAL (várias sessões Postgres simultâneas). O pgTAP 38
# roda numa sessão só; aqui se prova, entre transações:
#
#   1. Dois status da MESMA mensagem (read e delivered, em entradas
#      diferentes) enquanto outra transação segura a linha da mensagem: o
#      read chega primeiro, o delivered depois. Um `applied`, um
#      `duplicate`; a mensagem termina em read — o delivered, calculado
#      sobre uma leitura velha, nunca a faz regredir.
#   2. delivered/read concorrendo com failed tardio, nas duas ordens: failed
#      e depois read → read corrige; read e depois failed → failed não
#      regride. As duas terminam em read, sem erro gravado.
#   3. Custo final (delivered) concorrendo com uma estimativa tardia (sent):
#      o final fica e é o cobrado; a estimativa não muda nada.
#   4. O status chega enquanto a saída observada da MESMA mensagem ainda
#      está na transação que a grava (segurando a trava do id do provedor):
#      o status espera e aplica sobre a mensagem gravada, sem
#      message_not_found.
#   5. O canal é pausado com um efeito de status em andamento: a pausa
#      espera o efeito terminar; um claim obtido com o canal ativo e usado
#      depois da pausa vê `channel_paused`, sem efeito.
#
# Canal próprio, dados fictícios e o Postgres local do CI. Nada de provedor,
# nada hospedado, nenhuma mensagem enviada.
set -euo pipefail

DB_CONTAINER="supabase_db_praxis-crm"
WS="10000000-0000-0000-0000-000000000001"
DONO="20000000-0000-0000-0000-000000000001"
CANAL="$(cat /proc/sys/kernel/random/uuid)"
ROUTING="b3d2b2b2-conc-$(date +%s%N | tail -c 9)"
SUFIXO="$(date +%s%N | tail -c 7)"
TELEFONE="+55119300${SUFIXO:0:5}1"

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
    if [ "$(psql_as b3d2b2b2_main -c "select count(*) from pg_stat_activity where application_name = '$1' and query like '%pg_sleep%' and state = 'active'")" = "1" ]; then
      return 0
    fi
    sleep 0.1
  done
  fail "a sessão $1 não chegou ao pg_sleep"
}

wait_lock_waiters() { # espera $1 sessões com prefixo $2 paradas numa trava
  for _ in $(seq 1 100); do
    if [ "$(psql_as b3d2b2b2_main -c "select count(*) from pg_stat_activity where application_name like '$2%' and wait_event_type = 'Lock'")" = "$1" ]; then
      return 0
    fi
    sleep 0.1
  done
  fail "as $1 sessões $2* não chegaram à espera pela trava"
}

# Chamada do efeito de status: entrada token pmid status [valor moeda finalidade]
st_sql() {
  local amount="null" cur="null" fin="null"
  [ -n "${5:-}" ] && amount="$5" && cur="'$6'" && fin="'$7'"
  echo "$SERVICE_SQL
select public.whatsapp_effect_message_status('$1'::uuid, '$2'::uuid, '$3', null, null, '$4', null, now(), null, null, null, null, $amount, $cur, null, $fin) ->> 'outcome';"
}
q() { psql_as b3d2b2b2_main -c "$1"; }
pm_lock() { echo "hashtextextended('$CANAL' || ':message:' || '$1', 0)"; }

# Segura a trava do id do provedor (a mesma do efeito) por 4 s.
hold_pm_lock() { # $1 = application_name, $2 = id do provedor
  psql_as "$1" > /dev/null 2>&1 <<SQL &
begin;
select pg_advisory_xact_lock($(pm_lock "$2"));
select pg_sleep(4);
commit;
SQL
  HOLD_PID=$!
  wait_sleeping "$1"
}

# Segura a LINHA da mensagem (como qualquer outra escrita nela) por 4 s.
hold_row() { # $1 = application_name, $2 = id do provedor
  psql_as "$1" > /dev/null 2>&1 <<SQL &
begin;
select 1 from public.messages where channel_id = '$CANAL' and provider_message_id = '$2' for update;
select pg_sleep(4);
commit;
SQL
  HOLD_PID=$!
  wait_sleeping "$1"
}

# Duas execuções EM ORDEM, as duas paradas atrás da trava segurada: a
# primeira entra na fila antes da segunda. Saídas em $R1 e $R2.
run_in_order() { # prefixo sql1 sql2
  OUT_1="$(mktemp)"; OUT_2="$(mktemp)"
  echo "$2" | psql_as "${1}1" > "$OUT_1" 2>&1 &
  local p1=$!
  wait_lock_waiters 1 "$1"
  echo "$3" | psql_as "${1}2" > "$OUT_2" 2>&1 &
  local p2=$!
  wait_lock_waiters 2 "$1"
  wait "$HOLD_PID" || fail "a sessão que segura a trava falhou"
  wait $p1 || fail "execução 1 falhou: $(cat "$OUT_1")"
  wait $p2 || fail "execução 2 falhou: $(cat "$OUT_2")"
  R1="$(tail -1 "$OUT_1")"; R2="$(tail -1 "$OUT_2")"
}

msg() { # status|erro|valor|finalidade|cobrado da mensagem $1
  q "select status || '|' || coalesce(error_reason, '-') || '|' || coalesce(provider_cost_amount::text, '-') || '|' || coalesce(provider_cost_finality, '-') || '|' || coalesce(provider_cost_billable_amount::text, '-')
     from public.messages where channel_id = '$CANAL' and provider_message_id = '$1'"
}

echo "== preparo (canal, conversa, mensagens e entradas próprios)"
SETUP="$(psql_as b3d2b2b2_setup <<SQL
insert into public.whatsapp_environment_keys (environment, signing_key) values
  ('preview', 'chave-whatsapp-preview-concorrencia-0123456789')
on conflict do nothing;
$SERVICE_SQL
select public.whatsapp_create_simulated_channel('$CANAL'::uuid, '$WS'::uuid, '$DONO'::uuid, 'Concorrência B3.2d-2b2b2', '$ROUTING', '1',
  'QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFB', '1') is not null as ok \gset
reset role;
insert into public.conversations (workspace_id, channel_id, wa_id) values ('$WS'::uuid, '$CANAL'::uuid, '$TELEFONE');
insert into public.messages (workspace_id, conversation_id, channel_id, direction, origin, sender_classification, content_kind, body_text,
  provider, provider_message_id, status, status_updated_at)
select '$WS'::uuid, c.id, '$CANAL'::uuid, 'outbound', 'business_app', 'internal', 'text', 'Mensagem fictícia (concorrência de status)',
  'simulated', pm, 'sent', now() - interval '1 minute'
from public.conversations c, unnest(array['pm-st-1', 'pm-st-2a', 'pm-st-2b', 'pm-st-3', 'pm-st-5']) pm
where c.channel_id = '$CANAL'::uuid;
$SERVICE_SQL
with e as (
  select n, public.whatsapp_inbox_store('$CANAL'::uuid, '$WS'::uuid, 'simulated', '$ROUTING', 'evt-st-' || n,
    case when n = 9 then 'whatsapp.smb.message.echoes' else 'whatsapp.message.updated' end,
    repeat('a', 64), '1', 'AAAAAAAAAAAAAAAA', 'Q29ycG8gZmljdGljaW8gMQ==', 'AAAAAAAAAAAAAAAAAAAAAA==', 3600) ->> 'inbox_id' as id
  from generate_series(1, 12) n
)
select string_agg(e.id || ',' || (public.whatsapp_inbox_claim(e.id::uuid, 600) ->> 'claim_token'), ' ' order by n) from e;
SQL
)"
read -r -a ENTRIES <<<"$(echo "$SETUP" | tail -1)"
[ "${#ENTRIES[@]}" = "12" ] || fail "preparo sem resultado: $SETUP"
id() { echo "${ENTRIES[$1]%%,*}"; }
tok() { echo "${ENTRIES[$1]##*,}"; }
ANTES="$(q "select (select count(*) from public.contacts) || '|' || (select count(*) from public.leads) || '|' || (select count(*) from public.opportunities) || '|' || (select count(*) from public.activities) || '|' || (select count(*) from public.whatsapp_identities) || '|' || (select count(*) from public.conversations)")"

echo "== 1. read e delivered da mesma mensagem, com a linha segurada"
hold_row b3d2b2b2_h1 "pm-st-1"
run_in_order b3d2b2b2_a "$(st_sql "$(id 0)" "$(tok 0)" "pm-st-1" "read")" "$(st_sql "$(id 1)" "$(tok 1)" "pm-st-1" "delivered")"
[ "$R1 $R2" = "applied duplicate" ] || fail "esperado applied (read) e duplicate (delivered): $R1 / $R2"
[ "$(msg pm-st-1)" = "read|-|-|-|-" ] || fail "a mensagem regrediu: $(msg pm-st-1)"
[ "$(q "select count(*) from public.whatsapp_effect_ledger where inbox_id in ('$(id 0)', '$(id 1)')")" = "2" ] || fail "esperados dois ledgers"
echo "   ok: read aplicado, delivered duplicate; a mensagem fica em read"

echo "== 2. failed tardio concorrendo com read, nas duas ordens"
hold_pm_lock b3d2b2b2_h2 "pm-st-2a"
run_in_order b3d2b2b2_b "$(st_sql "$(id 2)" "$(tok 2)" "pm-st-2a" "failed")" "$(st_sql "$(id 3)" "$(tok 3)" "pm-st-2a" "read")"
[ "$R1 $R2" = "applied applied" ] || fail "failed e depois read: esperado applied e applied: $R1 / $R2"
[ "$(msg pm-st-2a)" = "read|-|-|-|-" ] || fail "o read não corrigiu o failed: $(msg pm-st-2a)"
hold_pm_lock b3d2b2b2_h3 "pm-st-2b"
run_in_order b3d2b2b2_c "$(st_sql "$(id 4)" "$(tok 4)" "pm-st-2b" "read")" "$(st_sql "$(id 5)" "$(tok 5)" "pm-st-2b" "failed")"
[ "$R1 $R2" = "applied duplicate" ] || fail "read e depois failed: esperado applied e duplicate: $R1 / $R2"
[ "$(msg pm-st-2b)" = "read|-|-|-|-" ] || fail "o failed tardio fez a mensagem regredir: $(msg pm-st-2b)"
echo "   ok: read corrige o failed; failed tardio não regride o read"

echo "== 3. custo final concorrendo com uma estimativa tardia"
hold_pm_lock b3d2b2b2_h4 "pm-st-3"
run_in_order b3d2b2b2_d "$(st_sql "$(id 6)" "$(tok 6)" "pm-st-3" "delivered" "0.0315" "BRL" "final")" "$(st_sql "$(id 7)" "$(tok 7)" "pm-st-3" "sent" "0.0500" "BRL" "estimated")"
[ "$R1 $R2" = "applied duplicate" ] || fail "esperado applied (final) e duplicate (estimativa tardia): $R1 / $R2"
[ "$(msg pm-st-3)" = "delivered|-|0.031500|final|0.031500" ] || fail "o custo final não ficou: $(msg pm-st-3)"
echo "   ok: o custo final fica e é o cobrado"

echo "== 4. status enquanto a saída observada da mesma mensagem está sendo gravada"
OUT_H="$(mktemp)"
psql_as b3d2b2b2_h5 > "$OUT_H" 2>&1 <<SQL &
begin;
$SERVICE_SQL
select public.whatsapp_effect_outbound_observed('$(id 8)'::uuid, '$(tok 8)'::uuid, 'pm-st-4', null, 'text', 'Mensagem fictícia observada (concorrência)', now(), '$TELEFONE', null, null, null) ->> 'outcome';
select pg_sleep(4);
commit;
SQL
HOLD_PID=$!
wait_sleeping b3d2b2b2_h5
OUT_4="$(mktemp)"
echo "$(st_sql "$(id 9)" "$(tok 9)" "pm-st-4" "delivered")" | psql_as b3d2b2b2_e1 > "$OUT_4" 2>&1 &
P4=$!
wait_lock_waiters 1 b3d2b2b2_e
wait "$HOLD_PID" || fail "a saída observada falhou: $(cat "$OUT_H")"
grep -qx "applied" "$OUT_H" || fail "a saída observada deveria aplicar: $(cat "$OUT_H")"
wait $P4 || fail "o status falhou: $(cat "$OUT_4")"
[ "$(tail -1 "$OUT_4")" = "applied" ] || fail "o status deveria esperar e aplicar, veio: $(tail -1 "$OUT_4")"
[ "$(msg pm-st-4)" = "delivered|-|-|-|-" ] || fail "o status não ficou na mensagem gravada: $(msg pm-st-4)"
echo "   ok: o status esperou a mensagem e aplicou sobre ela"

echo "== 5. o canal é pausado enquanto o efeito roda, e depois de um claim"
hold_pm_lock b3d2b2b2_h6 "pm-st-5"
OUT_5="$(mktemp)"; OUT_P="$(mktemp)"
echo "$(st_sql "$(id 10)" "$(tok 10)" "pm-st-5" "delivered")" | psql_as b3d2b2b2_p5e > "$OUT_5" 2>&1 &
P_EF=$!
wait_lock_waiters 1 b3d2b2b2_p5e
psql_as b3d2b2b2_p5p -c "update public.whatsapp_channels set status = 'paused', send_enabled = false, status_changed_at = now() where id = '$CANAL'" > "$OUT_P" 2>&1 &
P_PAUSE=$!
# O efeito já leu o canal ativo e o segura: a pausa espera ele terminar.
for _ in $(seq 1 30); do
  [ "$(q "select count(*) from pg_stat_activity where application_name = 'b3d2b2b2_p5p' and wait_event_type = 'Lock'")" = "1" ] && break
  kill -0 "$P_PAUSE" 2> /dev/null || fail "a pausa terminou sem esperar o efeito em andamento"
  sleep 0.1
done
[ "$(q "select count(*) from pg_stat_activity where application_name = 'b3d2b2b2_p5p' and wait_event_type = 'Lock'")" = "1" ] || fail "a pausa não esperou o efeito em andamento"
wait "$HOLD_PID" || fail "a sessão que segura a trava falhou"
wait $P_EF || fail "o efeito falhou: $(cat "$OUT_5")"
wait $P_PAUSE || fail "a pausa falhou: $(cat "$OUT_P")"
[ "$(tail -1 "$OUT_5")" = "applied" ] || fail "o efeito que leu o canal ativo deveria aplicar: $(tail -1 "$OUT_5")"
[ "$(q "select status from public.whatsapp_channels where id = '$CANAL'")" = "paused" ] || fail "a pausa não ficou gravada"
[ "$(echo "$(st_sql "$(id 11)" "$(tok 11)" "pm-st-5" "read")" | psql_as b3d2b2b2_main | tail -1)" = "channel_paused" ] || fail "o claim antigo deveria ver o canal pausado"
[ "$(msg pm-st-5)|$(q "select count(*) from public.whatsapp_effect_ledger where inbox_id = '$(id 11)'")|$(q "select state from public.whatsapp_webhook_inbox where id = '$(id 11)'")" = "delivered|-|-|-|-|0|processing" ] || fail "o canal pausado deixou efeito ou finalizou a entrada"
echo "   ok: a pausa esperou o efeito em andamento; o claim antigo viu channel_paused, sem efeito, entrada em processing"

[ "$(q "select (select count(*) from public.contacts) || '|' || (select count(*) from public.leads) || '|' || (select count(*) from public.opportunities) || '|' || (select count(*) from public.activities) || '|' || (select count(*) from public.whatsapp_identities) || '|' || (select count(*) from public.conversations)")" = "$ANTES" ] || fail "o status criou registro comercial, identidade ou conversa"
echo "== efeito de status e custo sob concorrência real: OK"
