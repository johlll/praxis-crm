#!/usr/bin/env bash
# B3.2d-2b2b3b — o efeito dos eventos operacionais da conta e do número
# (public.whatsapp_effect_account_event) sob concorrência REAL (várias
# sessões Postgres simultâneas). O pgTAP 40 roda numa sessão só; aqui se
# prova, entre transações:
#
#   1. O MESMO evento duas vezes: uma execução grava, a outra espera a
#      trava da entrada e vê `already_processed`. Uma linha operacional, um
#      ledger, uma auditoria.
#   2. Dois eventos de EXCLUSÃO simultâneos (entradas diferentes): o canal
#      termina disconnected, sem envio; o primeiro vira `applied`, o segundo
#      `recorded`; uma única auditoria da transição.
#   3. Um evento ANTIGO chegando depois de um de estado mais novo (os dois
#      esperando a trava do canal): `applied` e `stale_event`; o estado e as
#      datas não regridem; o antigo fica preservado.
#   4. Uma PAUSA administrativa concorrente com a exclusão, nas duas ordens
#      (pausa antes: a exclusão vê o canal pausado e desconecta; exclusão
#      antes: a pausa vê o canal desconectado e é recusada). Sem deadlock; o
#      resultado final respeita a ordem efetiva das transações.
#   5. A lease vence enquanto o efeito espera a trava de LINHA do canal e,
#      em outra entrada, a do WORKSPACE (outra sessão as segura, fora de
#      qualquer outra trava): ao conseguir a linha o efeito reconfere e
#      devolve `claim_lost`; nenhum evento, ledger, auditoria ou mudança no
#      canal; a entrada segue em processing com o mesmo claim.
#   6. Falha simulada depois do ledger (ao gravar o evento) e depois do
#      evento (ao desconectar o canal): nada sobrevive; sem a falha, a
#      mesma entrada aplica.
#
# Uma sessão segura a linha do canal (SELECT ... FOR UPDATE) para que as
# execuções esperem juntas, em ordem de chegada. Canais próprios, dados
# fictícios e o Postgres local do CI. Nada de provedor, nada hospedado,
# nenhuma mensagem enviada.
set -euo pipefail

DB_CONTAINER="supabase_db_praxis-crm"
WS="10000000-0000-0000-0000-000000000001"
DONO="20000000-0000-0000-0000-000000000001"
SUFIXO="$(date +%s%N | tail -c 6)"
REF="WABA-conc-$SUFIXO"
T0="2026-10-30 12:00:00+00"
T1="2026-10-30 13:00:00+00"
T2="2026-10-30 14:00:00+00"
CH=(); RK=()
for n in 1 2 3 4 5 6 7 8; do
  CH[$n]="$(cat /proc/sys/kernel/random/uuid)"
  RK[$n]="$REF:+55119500${SUFIXO:0:4}0$n"
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
q() { psql_as b3d2b2b3b_main -c "$1"; }

wait_sleeping() { # espera a sessão $1 entrar no pg_sleep (transação aberta)
  for _ in $(seq 1 100); do
    if [ "$(q "select count(*) from pg_stat_activity where application_name = '$1' and query like '%pg_sleep%' and state = 'active'")" = "1" ]; then
      return 0
    fi
    sleep 0.1
  done
  fail "a sessão $1 não chegou ao pg_sleep"
}

wait_lock_waiters() { # espera $1 sessões com prefixo $2 paradas numa trava
  for _ in $(seq 1 100); do
    if [ "$(q "select count(*) from pg_stat_activity where application_name like '$2%' and wait_event_type = 'Lock'")" = "$1" ]; then
      return 0
    fi
    sleep 0.1
  done
  fail "as $1 sessões $2* não chegaram à espera pela trava"
}

# Chamada do efeito: entrada token tipo escopo conta routing_key quando código
eff_sql() {
  local rk="null" cd="null"
  [ -n "$6" ] && rk="'$6'"
  [ -n "$8" ] && cd="'$8'"
  echo "$SERVICE_SQL
select public.whatsapp_effect_account_event('$1'::uuid, '$2'::uuid, '$4', '$3', '$5', $rk, '$7'::timestamptz, $cd) ->> 'outcome';"
}
# Exclusão do número do canal $3 (índice), no horário $4.
del_sql() { eff_sql "$(id "$1")" "$(tok "$1")" whatsapp.phone_number.deleted phone_number "$REF" "${RK[$2]}" "$3" ""; }

hold_row() { # $1 = application_name, $2 = SQL que trava a linha, $3 = segundos
  psql_as "$1" > /dev/null 2>&1 <<SQL &
begin;
$2;
select pg_sleep(${3:-4});
commit;
SQL
  HOLD_PID=$!
  wait_sleeping "$1"
}
hold_channel() { hold_row "$1" "select id from public.whatsapp_channels where id = '${CH[$2]}' for update" "${3:-6}"; }

# Estado do canal: status|send_enabled|provider_status_event_at|last_event_at (UTC, sem fração).
chs() { q "select concat_ws('|', status, send_enabled::text, coalesce(to_char(provider_status_event_at at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS'), '-'), coalesce(to_char(last_event_at at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS'), '-')) from public.whatsapp_channels where id = '${CH[$1]}'"; }
evs() { q "select coalesce(string_agg(result, ',' order by occurred_at, provider_event_id), '-') from public.whatsapp_channel_events where channel_id = '${CH[$1]}'"; }
lgr() { q "select count(*) from public.whatsapp_effect_ledger where channel_id = '${CH[$1]}'"; }
aud() { q "select count(*) from public.audit_logs where resource_id = '${CH[$1]}' and action = 'whatsapp.channel.disconnected'"; }
inbox_state() { q "select concat_ws('|', state, claim_token, claimed_at, lease_until) from public.whatsapp_webhook_inbox where id = '$(id "$1")'"; }
chrow() { q "select row_to_json(c)::text from public.whatsapp_channels c where id = '${CH[$1]}'"; }

echo "== preparo (canais, entradas e claims próprios)"
SETUP="$(psql_as b3d2b2b3b_setup <<SQL
insert into public.whatsapp_environment_keys (environment, signing_key) values
  ('preview', 'chave-whatsapp-preview-concorrencia-0123456789')
on conflict do nothing;
insert into public.whatsapp_channels (id, workspace_id, label, display_phone_number, created_by, provider, is_simulator, environment,
  routing_key, status, send_enabled, status_changed_at, provider_account_ref)
select c.id::uuid, '$WS'::uuid, 'Concorrência B3.2d-2b2b3b', '1', '$DONO'::uuid, 'ycloud', false, 'preview', c.routing, 'active', true, now(), '$REF'
from (values
  ('${CH[1]}', '${RK[1]}'), ('${CH[2]}', '${RK[2]}'), ('${CH[3]}', '${RK[3]}'), ('${CH[4]}', '${RK[4]}'),
  ('${CH[5]}', '${RK[5]}'), ('${CH[6]}', '${RK[6]}'), ('${CH[7]}', '${RK[7]}'), ('${CH[8]}', '${RK[8]}')
) c(id, routing);
$SERVICE_SQL
with e(n, ch, routing, evt, typ) as (values
  (1, '${CH[1]}', '${RK[1]}', 'evt-ae-1', 'whatsapp.phone_number.deleted'),
  (2, '${CH[2]}', '${RK[2]}', 'evt-ae-2', 'whatsapp.phone_number.deleted'),
  (3, '${CH[2]}', '${RK[2]}', 'evt-ae-3', 'whatsapp.phone_number.deleted'),
  (4, '${CH[3]}', '${RK[3]}', 'evt-ae-4', 'whatsapp.phone_number.deleted'),
  (5, '${CH[3]}', '${RK[3]}', 'evt-ae-5', 'whatsapp.phone_number.deleted'),
  (6, '${CH[4]}', '${RK[4]}', 'evt-ae-6', 'whatsapp.phone_number.deleted'),
  (7, '${CH[5]}', '${RK[5]}', 'evt-ae-7', 'whatsapp.phone_number.deleted'),
  (8, '${CH[6]}', '${RK[6]}', 'evt-ae-8', 'whatsapp.phone_number.quality_updated'),
  (9, '${CH[6]}', '${RK[6]}', 'evt-ae-9', 'whatsapp.phone_number.quality_updated'),
  (10, '${CH[7]}', '${RK[7]}', 'evt-ae-10', 'whatsapp.phone_number.deleted'),
  (11, '${CH[8]}', '${RK[8]}', 'evt-ae-11', 'whatsapp.phone_number.deleted')
), s as (
  select e.n, public.whatsapp_inbox_store(e.ch::uuid, '$WS'::uuid, 'ycloud', e.routing, e.evt, e.typ,
    repeat('a', 64), '1', 'AAAAAAAAAAAAAAAA', 'Q29ycG8gZmljdGljaW8gMQ==', 'AAAAAAAAAAAAAAAAAAAAAA==', 3600) ->> 'inbox_id' as id
  from e
)
select string_agg(s.id || ',' || (public.whatsapp_inbox_claim(s.id::uuid, 600) ->> 'claim_token'), ' ' order by n) from s;
SQL
)"
read -r -a ENTRIES <<<"$(echo "$SETUP" | tail -1)"
[ "${#ENTRIES[@]}" = "11" ] || fail "preparo sem resultado: $SETUP"
id() { echo "${ENTRIES[$(($1 - 1))]%%,*}"; }
tok() { echo "${ENTRIES[$(($1 - 1))]##*,}"; }
COMERCIAL_ANTES="$(q "select (select count(*) from public.contacts) || '|' || (select count(*) from public.contact_phones) || '|' || (select count(*) from public.contact_identifiers) || '|' || (select count(*) from public.leads) || '|' || (select count(*) from public.opportunities) || '|' || (select count(*) from public.activities) || '|' || (select count(*) from public.conversations) || '|' || (select count(*) from public.messages) || '|' || (select count(*) from public.whatsapp_identities)")"

echo "== 1. o mesmo evento duas vezes"
hold_channel b3d2b2b3b_h1 1
OUT_1="$(mktemp)"; OUT_2="$(mktemp)"
echo "$(del_sql 1 1 "$T0")" | psql_as b3d2b2b3b_a1 > "$OUT_1" 2>&1 &
P1=$!
wait_lock_waiters 1 b3d2b2b3b_a
echo "$(del_sql 1 1 "$T0")" | psql_as b3d2b2b3b_a2 > "$OUT_2" 2>&1 &
P2=$!
wait_lock_waiters 2 b3d2b2b3b_a
wait "$HOLD_PID" || fail "a sessão que segura a linha falhou"
wait $P1 || fail "execução 1 falhou: $(cat "$OUT_1")"
wait $P2 || fail "execução 2 falhou: $(cat "$OUT_2")"
[ "$(tail -1 "$OUT_1") $(tail -1 "$OUT_2")" = "applied already_processed" ] || fail "esperado applied e already_processed: $(tail -1 "$OUT_1") / $(tail -1 "$OUT_2")"
[ "$(chs 1)|$(evs 1)|$(lgr 1)|$(aud 1)" = "disconnected|false|2026-10-30T12:00:00|2026-10-30T12:00:00|applied|1|1" ] || fail "estado final do cenário 1: $(chs 1)|$(evs 1)|$(lgr 1)|$(aud 1)"
echo "   ok: applied e already_processed; uma linha operacional, um ledger, uma auditoria"

echo "== 2. duas exclusões simultâneas (entradas diferentes)"
hold_channel b3d2b2b3b_h2 2
echo "$(del_sql 2 2 "$T0")" | psql_as b3d2b2b3b_b1 > "$OUT_1" 2>&1 &
P1=$!
wait_lock_waiters 1 b3d2b2b3b_b
echo "$(del_sql 3 2 "$T1")" | psql_as b3d2b2b3b_b2 > "$OUT_2" 2>&1 &
P2=$!
wait_lock_waiters 2 b3d2b2b3b_b
wait "$HOLD_PID" || fail "a sessão que segura a linha falhou"
wait $P1 || fail "execução 1 falhou: $(cat "$OUT_1")"
wait $P2 || fail "execução 2 falhou: $(cat "$OUT_2")"
[ "$(tail -1 "$OUT_1") $(tail -1 "$OUT_2")" = "applied recorded" ] || fail "esperado applied e recorded: $(tail -1 "$OUT_1") / $(tail -1 "$OUT_2")"
[ "$(chs 2)|$(evs 2)|$(lgr 2)|$(aud 2)" = "disconnected|false|2026-10-30T12:00:00|2026-10-30T13:00:00|applied,recorded|2|1" ] || fail "estado final do cenário 2: $(chs 2)|$(evs 2)|$(lgr 2)|$(aud 2)"
echo "   ok: applied e recorded; disconnected, sem envio, duas linhas operacionais e uma única auditoria da transição"

echo "== 3. evento antigo depois de um de estado mais novo"
hold_channel b3d2b2b3b_h3 3
echo "$(del_sql 4 3 "$T2")" | psql_as b3d2b2b3b_c1 > "$OUT_1" 2>&1 &
P1=$!
wait_lock_waiters 1 b3d2b2b3b_c
echo "$(del_sql 5 3 "$T1")" | psql_as b3d2b2b3b_c2 > "$OUT_2" 2>&1 &
P2=$!
wait_lock_waiters 2 b3d2b2b3b_c
wait "$HOLD_PID" || fail "a sessão que segura a linha falhou"
wait $P1 || fail "execução 1 falhou: $(cat "$OUT_1")"
wait $P2 || fail "execução 2 falhou: $(cat "$OUT_2")"
[ "$(tail -1 "$OUT_1") $(tail -1 "$OUT_2")" = "applied stale_event" ] || fail "esperado applied e stale_event: $(tail -1 "$OUT_1") / $(tail -1 "$OUT_2")"
[ "$(chs 3)|$(evs 3)|$(lgr 3)|$(aud 3)" = "disconnected|false|2026-10-30T14:00:00|2026-10-30T14:00:00|stale_event,applied|2|1" ] || fail "estado final do cenário 3: $(chs 3)|$(evs 3)|$(lgr 3)|$(aud 3)"
echo "   ok: applied e stale_event; o estado e as datas não regridem; o evento antigo ficou preservado"

echo "== 4. pausa administrativa concorrente com a exclusão (nas duas ordens)"
PAUSE_SQL() { echo "$SERVICE_SQL
select public.whatsapp_pause_channel('${CH[$1]}'::uuid, '$WS'::uuid, '$DONO'::uuid) ->> 'status';"; }
# 4a. pausa primeiro: a exclusão espera e vê o canal pausado.
hold_channel b3d2b2b3b_h4 4
OUT_P="$(mktemp)"
echo "$(PAUSE_SQL 4)" | psql_as b3d2b2b3b_d1 > "$OUT_P" 2>&1 &
PP=$!
wait_lock_waiters 1 b3d2b2b3b_d
echo "$(del_sql 6 4 "$T0")" | psql_as b3d2b2b3b_d2 > "$OUT_1" 2>&1 &
P1=$!
wait_lock_waiters 2 b3d2b2b3b_d
wait "$HOLD_PID" || fail "a sessão que segura a linha falhou"
wait $PP || fail "a pausa falhou: $(cat "$OUT_P")"
wait $P1 || fail "a exclusão falhou: $(cat "$OUT_1")"
[ "$(tail -1 "$OUT_P") $(tail -1 "$OUT_1")" = "paused applied" ] || fail "esperado paused e applied: $(tail -1 "$OUT_P") / $(tail -1 "$OUT_1")"
[ "$(chs 4)|$(evs 4)|$(aud 4)" = "disconnected|false|2026-10-30T12:00:00|2026-10-30T12:00:00|applied|1" ] || fail "estado final do cenário 4a: $(chs 4)|$(evs 4)|$(aud 4)"
[ "$(q "select metadata ->> 'from_status' from public.audit_logs where resource_id = '${CH[4]}' and action = 'whatsapp.channel.disconnected'")" = "paused" ] || fail "a exclusão deveria ter visto o canal pausado"
[ "$(q "select count(*) from public.audit_logs where resource_id = '${CH[4]}' and action = 'whatsapp.channel.paused'")" = "1" ] || fail "a pausa deveria ter sido auditada"
echo "   ok: 4a — pausa primeiro: a exclusão viu paused e desconectou; as duas auditorias existem"
# 4b. exclusão primeiro: a pausa espera e vê o canal desconectado.
hold_channel b3d2b2b3b_h5 5
echo "$(del_sql 7 5 "$T0")" | psql_as b3d2b2b3b_e1 > "$OUT_1" 2>&1 &
P1=$!
wait_lock_waiters 1 b3d2b2b3b_e
echo "$(PAUSE_SQL 5)" | psql_as b3d2b2b3b_e2 > "$OUT_P" 2>&1 &
PP=$!
wait_lock_waiters 2 b3d2b2b3b_e
wait "$HOLD_PID" || fail "a sessão que segura a linha falhou"
wait $P1 || fail "a exclusão falhou: $(cat "$OUT_1")"
if wait $PP; then fail "a pausa deveria ser recusada com o canal já desconectado: $(cat "$OUT_P")"; fi
grep -q "invalid_channel_state" "$OUT_P" || fail "a pausa deveria falhar com invalid_channel_state: $(cat "$OUT_P")"
[ "$(tail -1 "$OUT_1")" = "applied" ] || fail "a exclusão deveria aplicar: $(tail -1 "$OUT_1")"
[ "$(chs 5)|$(evs 5)|$(aud 5)" = "disconnected|false|2026-10-30T12:00:00|2026-10-30T12:00:00|applied|1" ] || fail "estado final do cenário 4b: $(chs 5)|$(evs 5)|$(aud 5)"
[ "$(q "select metadata ->> 'from_status' from public.audit_logs where resource_id = '${CH[5]}' and action = 'whatsapp.channel.disconnected'")" = "active" ] || fail "a exclusão deveria ter visto o canal ativo"
[ "$(q "select count(*) from public.audit_logs where resource_id = '${CH[5]}' and action = 'whatsapp.channel.paused'")" = "0" ] || fail "a pausa recusada não deveria ter auditoria"
echo "   ok: 4b — exclusão primeiro: a pausa foi recusada (invalid_channel_state); sem deadlock; o resultado respeita a ordem efetiva"

echo "== 5. a lease vence enquanto o efeito espera uma trava de LINHA"
# 5a. a linha do canal. O efeito é de um tipo só observado: sem a conferência
# tardia da lease ele gravaria o evento ('recorded').
CH6_ANTES="$(chrow 6)"
hold_channel b3d2b2b3b_h6 6 5
q "update public.whatsapp_webhook_inbox set lease_until = clock_timestamp() + interval '2 seconds' where id = '$(id 8)'" > /dev/null
INBOX8_ANTES="$(inbox_state 8)"
OUT_L="$(mktemp)"
echo "$(eff_sql "$(id 8)" "$(tok 8)" whatsapp.phone_number.quality_updated phone_number "$REF" "${RK[6]}" "$T0" YELLOW)" | psql_as b3d2b2b3b_l1 > "$OUT_L" 2>&1 &
PL=$!
wait_lock_waiters 1 b3d2b2b3b_l
# A espera é pela linha que a outra sessão segura (não por trava consultiva).
[ "$(q "select count(*) from pg_stat_activity e where e.application_name = 'b3d2b2b3b_l1' and e.wait_event_type = 'Lock'
  and e.wait_event in ('transactionid', 'tuple')
  and exists (select 1 from pg_stat_activity h where h.application_name = 'b3d2b2b3b_h6' and h.pid = any(pg_blocking_pids(e.pid)))")" = "1" ] \
  || fail "o efeito não está esperando a trava de linha do canal"
for _ in $(seq 1 50); do
  [ "$(q "select (lease_until <= clock_timestamp())::text from public.whatsapp_webhook_inbox where id = '$(id 8)'")" = "true" ] && break
  sleep 0.1
done
[ "$(q "select (lease_until <= clock_timestamp())::text from public.whatsapp_webhook_inbox where id = '$(id 8)'")" = "true" ] || fail "a lease não venceu durante a espera"
[ "$(q "select count(*) from pg_stat_activity where application_name = 'b3d2b2b3b_l1' and wait_event_type = 'Lock'")" = "1" ] || fail "o efeito parou de esperar antes de a lease vencer"
wait "$HOLD_PID" || fail "a sessão que segura a linha falhou"
wait $PL || fail "o efeito falhou: $(cat "$OUT_L")"
[ "$(tail -1 "$OUT_L")" = "claim_lost" ] || fail "a lease venceu na espera pela linha do canal: esperado claim_lost, veio $(tail -1 "$OUT_L")"
[ "$(chrow 6)" = "$CH6_ANTES" ] || fail "o claim perdido mudou o canal"
[ "$(evs 6)|$(lgr 6)|$(aud 6)" = "-|0|0" ] || fail "o claim perdido deixou evento, ledger ou auditoria: $(evs 6)|$(lgr 6)|$(aud 6)"
[ "$(inbox_state 8)" = "$INBOX8_ANTES" ] || fail "o claim perdido mexeu na entrada"
[ "$(q "select concat_ws('|', state, claim_token) from public.whatsapp_webhook_inbox where id = '$(id 8)'")" = "processing|$(tok 8)" ] || fail "a entrada deveria seguir em processing com o mesmo claim"
echo "   ok: 5a — o efeito esperou a linha do canal, a lease venceu e veio claim_lost; nada mudou"
# 5b. a linha do WORKSPACE (a trava de chave que a gravação precisaria depois).
hold_row b3d2b2b3b_h7 "select id from public.workspaces where id = '$WS' for update" 5
q "update public.whatsapp_webhook_inbox set lease_until = clock_timestamp() + interval '2 seconds' where id = '$(id 9)'" > /dev/null
INBOX9_ANTES="$(inbox_state 9)"
echo "$(eff_sql "$(id 9)" "$(tok 9)" whatsapp.phone_number.quality_updated phone_number "$REF" "${RK[6]}" "$T0" YELLOW)" | psql_as b3d2b2b3b_l2 > "$OUT_L" 2>&1 &
PL=$!
wait_lock_waiters 1 b3d2b2b3b_l2
[ "$(q "select count(*) from pg_stat_activity e where e.application_name = 'b3d2b2b3b_l2' and e.wait_event_type = 'Lock'
  and e.wait_event in ('transactionid', 'tuple')
  and exists (select 1 from pg_stat_activity h where h.application_name = 'b3d2b2b3b_h7' and h.pid = any(pg_blocking_pids(e.pid)))")" = "1" ] \
  || fail "o efeito não está esperando a trava de linha do workspace"
for _ in $(seq 1 50); do
  [ "$(q "select (lease_until <= clock_timestamp())::text from public.whatsapp_webhook_inbox where id = '$(id 9)'")" = "true" ] && break
  sleep 0.1
done
[ "$(q "select (lease_until <= clock_timestamp())::text from public.whatsapp_webhook_inbox where id = '$(id 9)'")" = "true" ] || fail "a lease não venceu durante a espera pelo workspace"
[ "$(q "select count(*) from pg_stat_activity where application_name = 'b3d2b2b3b_l2' and wait_event_type = 'Lock'")" = "1" ] || fail "o efeito parou de esperar antes de a lease vencer"
wait "$HOLD_PID" || fail "a sessão que segura o workspace falhou"
wait $PL || fail "o efeito falhou: $(cat "$OUT_L")"
[ "$(tail -1 "$OUT_L")" = "claim_lost" ] || fail "a lease venceu na espera pelo workspace: esperado claim_lost, veio $(tail -1 "$OUT_L")"
[ "$(chrow 6)" = "$CH6_ANTES" ] || fail "o claim perdido mudou o canal (workspace)"
[ "$(evs 6)|$(lgr 6)|$(aud 6)" = "-|0|0" ] || fail "o claim perdido deixou evento, ledger ou auditoria (workspace): $(evs 6)|$(lgr 6)|$(aud 6)"
[ "$(inbox_state 9)" = "$INBOX9_ANTES" ] || fail "o claim perdido mexeu na entrada (workspace)"
echo "   ok: 5b — o efeito esperou a linha do workspace, a lease venceu e veio claim_lost; nada mudou"

echo "== 6. falha depois do ledger e depois do evento"
FALHA_FN="create function public.b3d2b2b3b_falha() returns trigger language plpgsql as \$f\$ begin raise exception 'falha_simulada'; end \$f\$;"
CH7_ANTES="$(chrow 7)"
q "$FALHA_FN create trigger b3d2b2b3b_falha_ev before insert on public.whatsapp_channel_events for each row execute function public.b3d2b2b3b_falha();" > /dev/null
OUT_Z="$(mktemp)"
if echo "$(del_sql 10 7 "$T0")" | psql_as b3d2b2b3b_z1 > "$OUT_Z" 2>&1; then
  q "drop trigger b3d2b2b3b_falha_ev on public.whatsapp_channel_events; drop function public.b3d2b2b3b_falha();" > /dev/null
  fail "a falha simulada deveria abortar o efeito: $(cat "$OUT_Z")"
fi
q "drop trigger b3d2b2b3b_falha_ev on public.whatsapp_channel_events; drop function public.b3d2b2b3b_falha();" > /dev/null
grep -q "falha_simulada" "$OUT_Z" || fail "erro inesperado: $(cat "$OUT_Z")"
[ "$(chrow 7)" = "$CH7_ANTES" ] || fail "a falha ao gravar o evento deixou o canal mudado"
[ "$(evs 7)|$(lgr 7)|$(aud 7)|$(q "select state from public.whatsapp_webhook_inbox where id = '$(id 10)'")" = "-|0|0|processing" ] || fail "a falha ao gravar o evento deixou ledger, evento, auditoria ou entrada finalizada"
[ "$(echo "$(del_sql 10 7 "$T0")" | psql_as b3d2b2b3b_main | tail -1)" = "applied" ] || fail "sem a falha, a mesma entrada deveria aplicar"
echo "   ok: 6a — nada sobreviveu à falha depois do ledger; sem ela, a mesma entrada aplicou"
CH8_ANTES="$(chrow 8)"
q "$FALHA_FN create trigger b3d2b2b3b_falha_ch before update on public.whatsapp_channels for each row when (new.status = 'disconnected') execute function public.b3d2b2b3b_falha();" > /dev/null
if echo "$(del_sql 11 8 "$T0")" | psql_as b3d2b2b3b_z2 > "$OUT_Z" 2>&1; then
  q "drop trigger b3d2b2b3b_falha_ch on public.whatsapp_channels; drop function public.b3d2b2b3b_falha();" > /dev/null
  fail "a falha simulada deveria abortar o efeito: $(cat "$OUT_Z")"
fi
q "drop trigger b3d2b2b3b_falha_ch on public.whatsapp_channels; drop function public.b3d2b2b3b_falha();" > /dev/null
grep -q "falha_simulada" "$OUT_Z" || fail "erro inesperado: $(cat "$OUT_Z")"
[ "$(chrow 8)" = "$CH8_ANTES" ] || fail "a falha ao desconectar deixou o canal mudado"
[ "$(evs 8)|$(lgr 8)|$(aud 8)|$(q "select state from public.whatsapp_webhook_inbox where id = '$(id 11)'")" = "-|0|0|processing" ] || fail "a falha ao desconectar deixou ledger, evento, auditoria ou entrada finalizada"
[ "$(echo "$(del_sql 11 8 "$T0")" | psql_as b3d2b2b3b_main | tail -1)" = "applied" ] || fail "sem a falha, a mesma entrada deveria aplicar"
echo "   ok: 6b — nada sobreviveu à falha depois do evento; sem ela, a mesma entrada aplicou"

[ "$(q "select (select count(*) from public.contacts) || '|' || (select count(*) from public.contact_phones) || '|' || (select count(*) from public.contact_identifiers) || '|' || (select count(*) from public.leads) || '|' || (select count(*) from public.opportunities) || '|' || (select count(*) from public.activities) || '|' || (select count(*) from public.conversations) || '|' || (select count(*) from public.messages) || '|' || (select count(*) from public.whatsapp_identities)")" = "$COMERCIAL_ANTES" ] || fail "um evento da conta mexeu em registro comercial, conversa, mensagem ou identidade"
echo "== efeito dos eventos da conta e do número sob concorrência real: OK"
