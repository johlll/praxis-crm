#!/usr/bin/env bash
# B3.2e — a reserva da republicação da inbox sob concorrência REAL (várias
# sessões Postgres simultâneas). O pgTAP 41 roda numa sessão só; aqui se prova,
# entre transações:
#
#   1. Dois reconciliadores reservam o mesmo lote ao mesmo tempo: cada entrada
#      aparece para um só (SKIP LOCKED), nenhuma se perde, nenhum espera.
#   2. A reserva vence: um worker novo recebe um token novo; o token antigo não
#      confirma nem registra falha; a reserva nova segue intacta.
#   3. A entrada é processada entre a reserva e a confirmação: a confirmação
#      técnica não a reabre, e o estado não regride.
#   4. O canal muda de paused para active: a entrada liberada com channel_paused
#      volta a ser elegível.
#   5. O canal continua paused: a mesma entrada não é republicada em nenhum dos
#      ciclos seguintes.
#   6. O worker cai depois da reserva: a entrada volta a ser elegível depois do
#      vencimento; a cifra, o estado e o claim não mudaram.
#
# Canais próprios, dados fictícios e o Postgres local do CI. Nada de provedor,
# nada hospedado, nenhuma mensagem enviada, nenhum evento publicado.
set -euo pipefail

DB_CONTAINER="supabase_db_praxis-crm"
WS="10000000-0000-0000-0000-000000000001"
DONO="20000000-0000-0000-0000-000000000001"
SUFIXO="$(date +%s%N | tail -c 6)"
CH=(); RK=()
for n in 1 2 3 4 5 6; do
  CH[$n]="$(cat /proc/sys/kernel/random/uuid)"
  RK[$n]="WABA-rec-$SUFIXO:+55119400${SUFIXO:0:4}0$n"
done

psql_as() { # $1 = application_name; resto = argumentos do psql
  local app="$1"; shift
  docker exec -i -e PGAPPNAME="$app" "$DB_CONTAINER" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -qAt "$@"
}

SERVICE_SQL="select set_config('request.headers', json_build_object('x-praxis-whatsapp-env', 'v1.preview.' || e.x || '.' || private.whatsapp_environment_signature('preview', e.x, k.signing_key))::text, false)
  from (select extract(epoch from now())::bigint + 600 as x) e,
       (select signing_key from public.whatsapp_environment_keys where environment = 'preview') k \\g /dev/null
set role service_role;"

fail() { echo "FALHOU: $*" >&2; exit 1; }
q() { psql_as b3e_main -c "$1"; }

# Uma sessão própria (conexão nova, transação real) como service_role.
svc() { # $1 = application_name, $2 = SQL
  psql_as "$1" <<SQL
$SERVICE_SQL
$2
SQL
}

reserve() { svc "$1" "select public.whatsapp_inbox_reconcile_reserve(${2:-25}, ${3:-120});"; }
confirm() { svc b3e_confirm "select public.whatsapp_inbox_reconcile_confirm('$1'::uuid, '$2'::uuid) ->> 'outcome';"; }
pfail() { svc b3e_fail "select public.whatsapp_inbox_reconcile_fail('$1'::uuid, '$2'::uuid, 'inbox_event_publish_failed') ->> 'outcome';"; }
# As entradas de um canal numa resposta de reserva, em ordem, separadas por espaço.
ids_in() { # $1 = jsonb da resposta, $2.. = ids procurados
  local resp="$1"; shift
  local list; list="$(printf "'%s'," "$@")"
  q "select coalesce(string_agg(e ->> 'inbox_id', ' ' order by e ->> 'inbox_id'), '') from jsonb_array_elements('$resp'::jsonb -> 'entries') e where e ->> 'inbox_id' in (${list%,})"
}
tok_of() { q "select e ->> 'reservation_token' from jsonb_array_elements('$1'::jsonb -> 'entries') e where e ->> 'inbox_id' = '$2'"; }
state_of() { q "select concat_ws('|', state, claim_count, claim_token is not null) from public.whatsapp_webhook_inbox where id = '$1'"; }
# Tudo o que NÃO é técnico da reconciliação: nada disto pode mudar.
core_of() { q "select md5((to_jsonb(i) - array['reconcile_token','reconcile_reserved_at','reconcile_reserved_until','reconcile_attempts','last_republished_at','last_republish_error_code','reconcile_next_at'])::text) from public.whatsapp_webhook_inbox i where i.id = '$1'"; }
# Tira todas as entradas do ambiente de cena, menos as do canal $1: o lote é do
# ambiente inteiro e o CI roda outros scripts antes.
isolate() {
  q "update public.whatsapp_webhook_inbox set state = 'processed', processed_at = clock_timestamp(), claim_token = null, claimed_at = null, lease_until = null
     where environment = 'preview' and state in ('pending', 'processing') and channel_id <> '$1'" > /dev/null
}

echo "== preparo (canais e entradas próprios)"
psql_as b3e_setup > /dev/null <<SQL
insert into public.whatsapp_environment_keys (environment, signing_key) values
  ('preview', 'chave-whatsapp-preview-concorrencia-0123456789')
on conflict do nothing;
insert into public.whatsapp_channels (id, workspace_id, label, display_phone_number, created_by, provider, is_simulator, environment,
  routing_key, status, send_enabled, status_changed_at, provider_account_ref)
select c.id::uuid, '$WS'::uuid, 'Concorrência B3.2e', '1', '$DONO'::uuid, 'ycloud', false, 'preview', c.routing, 'active', true, now() - interval '1 day', 'WABA-rec-$SUFIXO'
from (values
  ('${CH[1]}', '${RK[1]}'), ('${CH[2]}', '${RK[2]}'), ('${CH[3]}', '${RK[3]}'),
  ('${CH[4]}', '${RK[4]}'), ('${CH[5]}', '${RK[5]}'), ('${CH[6]}', '${RK[6]}')
) c(id, routing);
SQL

# Entrada recebida há 10 minutos no canal $1 (índice). Devolve o id.
new_entry() {
  local id
  id="$(svc b3e_setup "select public.whatsapp_inbox_store('${CH[$1]}'::uuid, '$WS'::uuid, 'ycloud', '${RK[$1]}', '$2', 'whatsapp.inbound_message.received',
    repeat('a', 64), '1', 'AAAAAAAAAAAAAAAA', 'Q29ycG8gZmljdGljaW8gMQ==', 'AAAAAAAAAAAAAAAAAAAAAA==', 3600) ->> 'inbox_id';")"
  q "update public.whatsapp_webhook_inbox set received_at = clock_timestamp() - interval '10 minutes' where id = '$id'" > /dev/null
  echo "$id"
}

echo "== 1. dois reconciliadores, o mesmo lote"
isolate "${CH[1]}"
L=()
for n in $(seq 1 20); do L+=("$(new_entry 1 "evt-rc1-$n")"); done
OUT_1="$(mktemp)"; OUT_2="$(mktemp)"
# Os dois começam juntos: cada um espera a mesma barreira de tempo real.
BARREIRA="select pg_sleep(greatest(0, (ceiling(extract(epoch from clock_timestamp())) + 1) - extract(epoch from clock_timestamp()))) \\g /dev/null"
psql_as b3e_r1 > "$OUT_1" 2>&1 <<SQL &
$SERVICE_SQL
$BARREIRA
select public.whatsapp_inbox_reconcile_reserve(15, 120);
SQL
P1=$!
psql_as b3e_r2 > "$OUT_2" 2>&1 <<SQL &
$SERVICE_SQL
$BARREIRA
select public.whatsapp_inbox_reconcile_reserve(15, 120);
SQL
P2=$!
wait "$P1" || fail "reconciliador 1: $(cat "$OUT_1")"
wait "$P2" || fail "reconciliador 2: $(cat "$OUT_2")"
R1="$(tail -1 "$OUT_1")"; R2="$(tail -1 "$OUT_2")"
A1="$(ids_in "$R1" "${L[@]}")"; A2="$(ids_in "$R2" "${L[@]}")"
N1="$(wc -w <<<"$A1" | tr -d ' ')"; N2="$(wc -w <<<"$A2" | tr -d ' ')"
INTER="$(comm -12 <(tr ' ' '\n' <<<"$A1" | sort) <(tr ' ' '\n' <<<"$A2" | sort) | grep -c . || true)"
[ "$INTER" = "0" ] || fail "a mesma entrada foi para os dois reconciliadores ($INTER): 1=[$A1] 2=[$A2]"
[ "$((N1 + N2))" = "20" ] || fail "esperava as 20 entradas reservadas entre os dois, vieram $N1 + $N2"
[ "$N1" -le 15 ] && [ "$N2" -le 15 ] || fail "lote maior que o pedido: $N1, $N2"
ATT="$(q "select string_agg(distinct reconcile_attempts::text, ',') from public.whatsapp_webhook_inbox where channel_id = '${CH[1]}'")"
[ "$ATT" = "1" ] || fail "cada entrada devia ter exatamente uma tentativa, veio: $ATT"
echo "   ok: $N1 + $N2 = 20, nenhuma repetida"

echo "== 1b. uma sessão segura a linha: o outro reconciliador pula, sem esperar"
isolate "${CH[6]}"
E_LOCK="$(new_entry 6 evt-rc1b-1)"; E_FREE="$(new_entry 6 evt-rc1b-2)"
psql_as b3e_h1 > /dev/null 2>&1 <<SQL &
begin;
select id from public.whatsapp_webhook_inbox where id = '$E_LOCK' for update;
select pg_sleep(4);
commit;
SQL
HOLD=$!
for _ in $(seq 1 100); do
  [ "$(q "select count(*) from pg_stat_activity where application_name = 'b3e_h1' and query like '%pg_sleep%' and state = 'active'")" = "1" ] && break
  sleep 0.1
done
R_L="$(svc b3e_r3 "select public.whatsapp_inbox_reconcile_reserve(25, 120);")"
[ "$(ids_in "$R_L" "$E_LOCK")" = "" ] || fail "a entrada travada foi reservada"
[ "$(ids_in "$R_L" "$E_FREE")" = "$E_FREE" ] || fail "a entrada livre devia ser reservada: $R_L"
kill -0 "$HOLD" 2>/dev/null || fail "a sessão que segura a linha já terminou: o reconciliador esperou por ela em vez de pular"
wait "$HOLD"
echo "   ok: pulou a travada, sem esperar"

echo "== 2. a reserva vence: token novo, o antigo não vale"
isolate "${CH[2]}"
E2="$(new_entry 2 evt-rc2-1)"
R_A="$(reserve b3e_w1 25 30)"
T_A="$(tok_of "$R_A" "$E2")"
[ -n "$T_A" ] || fail "o primeiro worker devia reservar: $R_A"
[ "$(ids_in "$(reserve b3e_w2)" "$E2")" = "" ] || fail "com a reserva vigente, o segundo worker não devia receber a entrada"
q "update public.whatsapp_webhook_inbox set reconcile_reserved_at = clock_timestamp() - interval '5 minutes', reconcile_reserved_until = clock_timestamp() - interval '1 second' where id = '$E2'" > /dev/null
[ "$(confirm "$E2" "$T_A")" = "reservation_lost" ] || fail "token vencido confirmou"
R_B="$(reserve b3e_w2)"
T_B="$(tok_of "$R_B" "$E2")"
[ -n "$T_B" ] && [ "$T_B" != "$T_A" ] || fail "o worker novo devia receber um token novo: $T_A / $T_B"
[ "$(confirm "$E2" "$T_A")" = "reservation_lost" ] || fail "o token antigo confirmou a reserva nova"
[ "$(pfail "$E2" "$T_A")" = "reservation_lost" ] || fail "o token antigo liberou a reserva nova"
[ "$(q "select reconcile_token = '$T_B' from public.whatsapp_webhook_inbox where id = '$E2'")" = "t" ] || fail "a reserva nova não ficou intacta"
[ "$(confirm "$E2" "$T_B")" = "confirmed" ] || fail "o token novo devia confirmar"
echo "   ok"

echo "== 3. processada entre a reserva e a confirmação"
isolate "${CH[3]}"
E3="$(new_entry 3 evt-rc3-1)"
R3="$(reserve b3e_w3)"; T3="$(tok_of "$R3" "$E3")"
[ -n "$T3" ] || fail "devia reservar: $R3"
CLAIM3="$(svc b3e_c3 "select public.whatsapp_inbox_claim('$E3'::uuid, 300) ->> 'claim_token';")"
[ -n "$CLAIM3" ] || fail "o claim não pode ser impedido pela reserva"
[ "$(svc b3e_c3 "select public.whatsapp_inbox_complete('$E3'::uuid, '$CLAIM3'::uuid) ->> 'outcome';")" = "completed" ] || fail "não completou"
CORE3="$(core_of "$E3")"
[ "$(confirm "$E3" "$T3")" = "confirmed" ] || fail "a confirmação técnica devia passar"
[ "$(core_of "$E3")" = "$CORE3" ] || fail "a confirmação mudou a entrada processada"
[ "$(state_of "$E3")" = "processed|1|f" ] || fail "o estado regrediu: $(state_of "$E3")"
[ "$(ids_in "$(reserve b3e_w3)" "$E3")" = "" ] || fail "a entrada processada voltou a ser reservada"
echo "   ok"

echo "== 4. canal de paused para active"
isolate "${CH[4]}"
E4="$(new_entry 4 evt-rc4-1)"
q "update public.whatsapp_channels set status = 'paused', send_enabled = false, status_changed_at = clock_timestamp() - interval '1 hour' where id = '${CH[4]}'" > /dev/null
CLAIM4="$(svc b3e_c4 "select public.whatsapp_inbox_claim('$E4'::uuid, 300) ->> 'claim_token';")"
[ "$(svc b3e_c4 "select public.whatsapp_inbox_release('$E4'::uuid, '$CLAIM4'::uuid, 'channel_paused') ->> 'outcome';")" = "released" ] || fail "não liberou"
[ "$(ids_in "$(reserve b3e_w4)" "$E4")" = "" ] || fail "com o canal ainda pausado não devia voltar"
# A mudança acontece em outra sessão, depois do release.
q "update public.whatsapp_channels set status = 'active', send_enabled = true, status_changed_at = clock_timestamp() where id = '${CH[4]}'" > /dev/null
[ "$(ids_in "$(reserve b3e_w4)" "$E4")" = "$E4" ] || fail "com o canal ativo, a entrada channel_paused devia voltar a ser elegível"
echo "   ok"

echo "== 5. canal continua paused: sem republicação em todo ciclo"
isolate "${CH[5]}"
E5="$(new_entry 5 evt-rc5-1)"
q "update public.whatsapp_channels set status = 'paused', send_enabled = false, status_changed_at = clock_timestamp() - interval '1 hour' where id = '${CH[5]}'" > /dev/null
# Nunca tentada: é publicada uma vez, mesmo com o canal pausado.
R5="$(reserve b3e_w5)"; T5="$(tok_of "$R5" "$E5")"
[ -n "$T5" ] || fail "nunca tentada em canal pausado devia ser publicada uma vez: $R5"
[ "$(confirm "$E5" "$T5")" = "confirmed" ] || fail "não confirmou"
CLAIM5="$(svc b3e_c5 "select public.whatsapp_inbox_claim('$E5'::uuid, 300) ->> 'claim_token';")"
[ "$(svc b3e_c5 "select public.whatsapp_inbox_release('$E5'::uuid, '$CLAIM5'::uuid, 'channel_paused') ->> 'outcome';")" = "released" ] || fail "não liberou"
# Mesmo com o backoff vencido, ciclo após ciclo.
q "update public.whatsapp_webhook_inbox set reconcile_next_at = clock_timestamp() - interval '1 minute' where id = '$E5'" > /dev/null
for ciclo in 1 2 3; do
  [ "$(ids_in "$(reserve b3e_w5)" "$E5")" = "" ] || fail "republicada com o canal parado, ciclo $ciclo"
done
[ "$(q "select reconcile_attempts from public.whatsapp_webhook_inbox where id = '$E5'")" = "1" ] || fail "o contador subiu sem republicação"
echo "   ok"

echo "== 6. o worker cai depois da reserva"
isolate "${CH[6]}"
E6="$(new_entry 6 evt-rc6-1)"
CORE6="$(core_of "$E6")"
R6="$(reserve b3e_w6 25 30)"; T6="$(tok_of "$R6" "$E6")"
[ -n "$T6" ] || fail "devia reservar: $R6"
# Queda: nenhuma confirmação. Antes de vencer, ninguém a recebe.
[ "$(ids_in "$(reserve b3e_w7)" "$E6")" = "" ] || fail "reserva vigente foi entregue a outro worker"
q "update public.whatsapp_webhook_inbox set reconcile_reserved_at = clock_timestamp() - interval '5 minutes', reconcile_reserved_until = clock_timestamp() - interval '1 second' where id = '$E6'" > /dev/null
R7="$(reserve b3e_w7)"; T7="$(tok_of "$R7" "$E6")"
[ -n "$T7" ] && [ "$T7" != "$T6" ] || fail "vencida a reserva, a entrada devia voltar com um token novo: $R7"
[ "$(core_of "$E6")" = "$CORE6" ] || fail "a queda mudou a entrada: cifra, estado ou claim"
[ "$(state_of "$E6")" = "pending|0|f" ] || fail "estado inesperado: $(state_of "$E6")"
echo "   ok"

echo "B3.2e — concorrência da reserva da republicação: OK"
