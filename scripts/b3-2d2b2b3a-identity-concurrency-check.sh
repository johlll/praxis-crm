#!/usr/bin/env bash
# B3.2d-2b2b3a — o efeito de identidade alterada e troca de número
# (public.whatsapp_effect_identity_change) sob concorrência REAL (várias
# sessões Postgres simultâneas). O pgTAP 39 roda numa sessão só; aqui se
# prova, entre transações:
#
#   1. Duas trocas simultâneas da MESMA identidade para o mesmo telefone
#      novo (dois eventos): uma `applied`, a outra `duplicate` (o BSUID
#      reconhece a identidade já trocada). Uma identidade com o número.
#   2. Duas identidades tentando assumir o MESMO telefone: uma `applied`, a
#      outra `identity_conflict`; a segunda continua com o próprio número.
#   3. Duas identidades tentando assumir o MESMO BSUID novo (cada uma com o
#      próprio telefone novo): uma `applied`; para a segunda, telefone e
#      BSUID apontam para identidades diferentes → `identity_conflict`.
#   4. O canal é pausado com um efeito em andamento: a pausa espera; um
#      claim obtido com o canal ativo e usado depois vê `channel_paused`.
#   5. Falha depois do ledger e antes da atualização da conversa: nada
#      sobrevive (telefone, ledger, inbox); sem a falha, a mesma entrada
#      aplica.
#   6. A lease vence enquanto o efeito espera uma trava: ao conseguir a
#      trava, o efeito reconfere e devolve `claim_lost`, sem escrever.
#   7. A lease vence enquanto o efeito espera a trava de LINHA da conversa
#      (outra sessão a segura com SELECT ... FOR UPDATE, fora das travas
#      consultivas): ao conseguir a linha, o efeito reconfere e devolve
#      `claim_lost`; identidade, conversa, vínculos, auditoria, ledger e
#      claim ficam como estavam.
#
# Uma sessão segura a trava consultiva (a mesma que o efeito pede: telefone
# novo ou BSUID novo) para que as execuções esperem juntas, em ordem. Canal
# próprio, dados fictícios e o Postgres local do CI. Nada de provedor, nada
# hospedado, nenhuma mensagem enviada.
set -euo pipefail

DB_CONTAINER="supabase_db_praxis-crm"
WS="10000000-0000-0000-0000-000000000001"
DONO="20000000-0000-0000-0000-000000000001"
CANAL="$(cat /proc/sys/kernel/random/uuid)"
ROUTING="b3d2b2b3a-conc-$(date +%s%N | tail -c 9)"
SUFIXO="$(date +%s%N | tail -c 6)"
tel() { echo "+55119400${SUFIXO:0:4}$1"; } # $1 = dois dígitos
BA="$(head -c 32 /dev/urandom | base64)"
BX="$(head -c 32 /dev/urandom | base64)"
CT="$(head -c 40 /dev/urandom | base64)"
BY="$(head -c 32 /dev/urandom | base64)"
K7="$(cat /proc/sys/kernel/random/uuid)"; L7="$(cat /proc/sys/kernel/random/uuid)"; O7="$(cat /proc/sys/kernel/random/uuid)"

psql_as() { # $1 = application_name; resto = argumentos do psql
  local app="$1"; shift
  docker exec -i -e PGAPPNAME="$app" "$DB_CONTAINER" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -qAt "$@"
}

SERVICE_SQL="select set_config('request.headers', json_build_object('x-praxis-whatsapp-env', 'v1.preview.' || e.x || '.' || private.whatsapp_environment_signature('preview', e.x, k.signing_key))::text, false)
  from (select extract(epoch from now())::bigint + 600 as x) e,
       (select signing_key from public.whatsapp_environment_keys where environment = 'preview') k \\g /dev/null
set role service_role;"

fail() { echo "FALHOU: $*" >&2; exit 1; }
q() { psql_as b3d2b2b3a_main -c "$1"; }

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

# Chamada do efeito: entrada token mudança tel_anterior bsuid_anterior tel_novo bsuid_novo
ic_sql() {
  local pp="null" pl="null" pv="null" np="null" nl="null" nc="null" nv="null"
  [ -n "$4" ] && pp="'$4'"
  [ -n "$5" ] && pl="'{\"1\": \"$5\"}'::jsonb" && pv="'1'"
  [ -n "$6" ] && np="'$6'"
  [ -n "$7" ] && nl="'{\"1\": \"$7\"}'::jsonb" && nc="'$CT'" && nv="'1'"
  echo "$SERVICE_SQL
select public.whatsapp_effect_identity_change('$1'::uuid, '$2'::uuid, '$3', now(), $pp, $pl, $pv, $np, $nl, $nc, $nv) ->> 'outcome';"
}

lock_expr() { # telefone ou "bsuid:<base64>"
  case "$1" in
    bsuid:*) echo "hashtextextended('$CANAL' || ':bsuid:' || encode(decode('${1#bsuid:}', 'base64'), 'hex'), 0)" ;;
    *) echo "hashtextextended('$CANAL' || ':' || '$1', 0)" ;;
  esac
}

hold_lock() { # $1 = application_name, $2 = chave (telefone ou bsuid:<base64>), $3 = segundos
  psql_as "$1" > /dev/null 2>&1 <<SQL &
begin;
select pg_advisory_xact_lock($(lock_expr "$2"));
select pg_sleep(${3:-4});
commit;
SQL
  HOLD_PID=$!
  wait_sleeping "$1"
}

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

phone_of() { q "select coalesce(i.phone_e164, '-') || '|' || coalesce(c.wa_id, '-') from public.whatsapp_identities i left join public.conversations c on c.identity_id = i.id where i.id = '$1'"; }
owners() { q "select count(*) from public.whatsapp_identities where channel_id = '$CANAL' and phone_e164 = '$1'"; }

echo "== preparo (canal, identidades, conversas e entradas próprios)"
SETUP="$(psql_as b3d2b2b3a_setup <<SQL
insert into public.whatsapp_environment_keys (environment, signing_key) values
  ('preview', 'chave-whatsapp-preview-concorrencia-0123456789')
on conflict do nothing;
$SERVICE_SQL
select public.whatsapp_create_simulated_channel('$CANAL'::uuid, '$WS'::uuid, '$DONO'::uuid, 'Concorrência B3.2d-2b2b3a', '$ROUTING', '1',
  'QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFB', '1') is not null as ok \gset
reset role;
-- A1 com telefone e BSUID; as outras só com telefone. Uma conversa cada.
insert into public.whatsapp_identities (workspace_id, channel_id, environment, provider, phone_e164, bsuid_blind_index, bsuid_ciphertext, bsuid_key_version)
values ('$WS'::uuid, '$CANAL'::uuid, 'preview', 'simulated', '$(tel 01)', decode('$BA', 'base64'), decode('$CT', 'base64'), '1');
insert into public.conversations (workspace_id, channel_id, identity_id, wa_id)
select '$WS'::uuid, '$CANAL'::uuid, id, phone_e164 from public.whatsapp_identities where channel_id = '$CANAL'::uuid;
insert into public.conversations (workspace_id, channel_id, wa_id)
select '$WS'::uuid, '$CANAL'::uuid, p from unnest(array['$(tel 02)', '$(tel 03)', '$(tel 04)', '$(tel 05)', '$(tel 06)', '$(tel 07)', '$(tel 08)', '$(tel 09)']) p;
-- A conversa de $(tel 09) vinculada a contato, lead e oportunidade fictícios.
insert into public.contacts (id, workspace_id, type, name, created_by) values ('$K7'::uuid, '$WS'::uuid, 'pf', 'Cliente Fictício Concorrência', '$DONO'::uuid);
insert into public.leads (id, workspace_id, contact_id, legal_area, created_by) values ('$L7'::uuid, '$WS'::uuid, '$K7'::uuid, 'Trabalhista', '$DONO'::uuid);
insert into public.opportunities (id, workspace_id, lead_id, pipeline_id, stage_id, created_by)
select '$O7'::uuid, '$WS'::uuid, '$L7'::uuid, p.id, (select s.id from public.pipeline_stages s where s.pipeline_id = p.id order by s.position limit 1), '$DONO'::uuid
from public.pipelines p where p.workspace_id = '$WS'::uuid and p.is_default;
update public.conversations set contact_id = '$K7'::uuid, lead_id = '$L7'::uuid, opportunity_id = '$O7'::uuid
where channel_id = '$CANAL'::uuid and wa_id = '$(tel 09)';
$SERVICE_SQL
with e as (
  select n, public.whatsapp_inbox_store('$CANAL'::uuid, '$WS'::uuid, 'simulated', '$ROUTING', 'evt-ic-' || n, 'whatsapp.inbound_message.received',
    repeat('a', 64), '1', 'AAAAAAAAAAAAAAAA', 'Q29ycG8gZmljdGljaW8gMQ==', 'AAAAAAAAAAAAAAAAAAAAAA==', 3600) ->> 'inbox_id' as id
  from generate_series(1, 11) n
)
select string_agg(e.id || ',' || (public.whatsapp_inbox_claim(e.id::uuid, 600) ->> 'claim_token'), ' ' order by n) from e;
SQL
)"
read -r -a ENTRIES <<<"$(echo "$SETUP" | tail -1)"
[ "${#ENTRIES[@]}" = "11" ] || fail "preparo sem resultado: $SETUP"
id() { echo "${ENTRIES[$1]%%,*}"; }
tok() { echo "${ENTRIES[$1]##*,}"; }
ident() { q "select id from public.whatsapp_identities where channel_id = '$CANAL' and phone_e164 = '$1'"; }
A1="$(ident "$(tel 01)")"; A2="$(ident "$(tel 02)")"; B2="$(ident "$(tel 03)")"; A3="$(ident "$(tel 04)")"; B3="$(ident "$(tel 05)")"
A4="$(ident "$(tel 06)")"; A5="$(ident "$(tel 07)")"; A6="$(ident "$(tel 08)")"; A7="$(ident "$(tel 09)")"
COMERCIAL_ANTES="$(q "select (select count(*) from public.contacts) || '|' || (select count(*) from public.contact_phones) || '|' || (select count(*) from public.contact_identifiers) || '|' || (select count(*) from public.leads) || '|' || (select count(*) from public.opportunities) || '|' || (select count(*) from public.activities)")"
IDENT_ANTES="$(q "select count(*) from public.whatsapp_identities where channel_id = '$CANAL'")"

echo "== 1. duas trocas da mesma identidade para o mesmo telefone novo"
hold_lock b3d2b2b3a_h1 "$(tel 11)"
run_in_order b3d2b2b3a_a "$(ic_sql "$(id 0)" "$(tok 0)" phone_number "$(tel 01)" "$BA" "$(tel 11)" "")" "$(ic_sql "$(id 1)" "$(tok 1)" phone_number "$(tel 01)" "$BA" "$(tel 11)" "")"
[ "$R1 $R2" = "applied duplicate" ] || fail "esperado applied e duplicate: $R1 / $R2"
[ "$(phone_of "$A1")" = "$(tel 11)|$(tel 11)" ] || fail "a identidade não ficou com o número novo: $(phone_of "$A1")"
[ "$(owners "$(tel 11)")|$(owners "$(tel 01)")" = "1|0" ] || fail "o número novo ou o antigo ficou em mais de uma identidade"
echo "   ok: applied e duplicate; uma identidade com o número novo, a conversa acompanha"

echo "== 2. duas identidades tentando assumir o mesmo telefone"
hold_lock b3d2b2b3a_h2 "$(tel 12)"
run_in_order b3d2b2b3a_b "$(ic_sql "$(id 2)" "$(tok 2)" phone_number "$(tel 02)" "" "$(tel 12)" "")" "$(ic_sql "$(id 3)" "$(tok 3)" phone_number "$(tel 03)" "" "$(tel 12)" "")"
[ "$R1 $R2" = "applied identity_conflict" ] || fail "esperado applied e identity_conflict: $R1 / $R2"
[ "$(phone_of "$A2")|$(phone_of "$B2")" = "$(tel 12)|$(tel 12)|$(tel 03)|$(tel 03)" ] || fail "a segunda identidade perdeu o número ou a primeira não trocou"
[ "$(q "select state || '|' || (select count(*) from public.whatsapp_effect_ledger where inbox_id = '$(id 3)') from public.whatsapp_webhook_inbox where id = '$(id 3)'")" = "processing|0" ] || fail "o conflito gravou ledger ou finalizou a entrada"
echo "   ok: applied e identity_conflict; a segunda continua com o próprio número, sem ledger, entrada em processing"

echo "== 3. duas identidades tentando assumir o mesmo BSUID novo"
hold_lock b3d2b2b3a_h3 "bsuid:$BX"
run_in_order b3d2b2b3a_c "$(ic_sql "$(id 4)" "$(tok 4)" phone_number "$(tel 04)" "" "$(tel 14)" "$BX")" "$(ic_sql "$(id 5)" "$(tok 5)" phone_number "$(tel 05)" "" "$(tel 15)" "$BX")"
[ "$R1 $R2" = "applied identity_conflict" ] || fail "esperado applied e identity_conflict: $R1 / $R2"
[ "$(q "select count(*) || '|' || bool_and(id = '$A3') from public.whatsapp_identities where bsuid_blind_index = decode('$BX', 'base64')")" = "1|true" ] || fail "o BSUID novo não ficou só na primeira identidade"
[ "$(phone_of "$B3")" = "$(tel 05)|$(tel 05)" ] || fail "a segunda identidade mudou de número"
echo "   ok: applied e identity_conflict; o BSUID fica só na primeira, a segunda intacta"

echo "== 5. falha depois do ledger, ao atualizar a conversa"
q "create function public.b3d2b2b3a_falha() returns trigger language plpgsql as \$f\$ begin if old.wa_id = '$(tel 07)' then raise exception 'falha_simulada'; end if; return new; end \$f\$;
create trigger b3d2b2b3a_falha before update on public.conversations for each row execute function public.b3d2b2b3a_falha();" > /dev/null
OUT_Z="$(mktemp)"
if echo "$(ic_sql "$(id 6)" "$(tok 6)" phone_number "$(tel 07)" "" "$(tel 17)" "")" | psql_as b3d2b2b3a_z > "$OUT_Z" 2>&1; then
  q "drop trigger b3d2b2b3a_falha on public.conversations; drop function public.b3d2b2b3a_falha();" > /dev/null
  fail "a falha simulada deveria abortar o efeito: $(cat "$OUT_Z")"
fi
q "drop trigger b3d2b2b3a_falha on public.conversations; drop function public.b3d2b2b3a_falha();" > /dev/null
grep -q "falha_simulada" "$OUT_Z" || fail "erro inesperado: $(cat "$OUT_Z")"
[ "$(phone_of "$A5")|$(owners "$(tel 17)")|$(q "select state || '|' || (select count(*) from public.whatsapp_effect_ledger where inbox_id = '$(id 6)') from public.whatsapp_webhook_inbox where id = '$(id 6)'")" = "$(tel 07)|$(tel 07)|0|processing|0" ] || fail "a falha deixou telefone, ledger ou entrada finalizada"
[ "$(echo "$(ic_sql "$(id 6)" "$(tok 6)" phone_number "$(tel 07)" "" "$(tel 17)" "")" | psql_as b3d2b2b3a_main | tail -1)" = "applied" ] || fail "sem a falha, a mesma entrada deveria aplicar"
echo "   ok: nada sobreviveu à falha; sem ela, a mesma entrada aplicou"

echo "== 6. a lease vence enquanto o efeito espera a trava"
hold_lock b3d2b2b3a_h6 "$(tel 18)" 5
q "update public.whatsapp_webhook_inbox set lease_until = clock_timestamp() + interval '2 seconds' where id = '$(id 7)'" > /dev/null
OUT_L="$(mktemp)"
echo "$(ic_sql "$(id 7)" "$(tok 7)" phone_number "$(tel 08)" "" "$(tel 18)" "")" | psql_as b3d2b2b3a_l1 > "$OUT_L" 2>&1 &
P_L=$!
wait_lock_waiters 1 b3d2b2b3a_l
wait "$HOLD_PID" || fail "a sessão que segura a trava falhou"
wait $P_L || fail "o efeito falhou: $(cat "$OUT_L")"
[ "$(tail -1 "$OUT_L")" = "claim_lost" ] || fail "a lease venceu durante a espera: esperado claim_lost, veio $(tail -1 "$OUT_L")"
[ "$(phone_of "$A6")|$(owners "$(tel 18)")|$(q "select count(*) from public.whatsapp_effect_ledger where inbox_id = '$(id 7)'")" = "$(tel 08)|$(tel 08)|0|0" ] || fail "o claim perdido deixou efeito"
echo "   ok: claim_lost depois da espera, nada escrito"

echo "== 7. a lease vence enquanto o efeito espera a trava de linha da conversa"
CONV7="$(q "select id from public.conversations where identity_id = '$A7'")"
[ "$(q "select concat_ws('|', contact_id, lead_id, opportunity_id) from public.conversations where id = '$CONV7'")" = "$K7|$L7|$O7" ] || fail "a conversa do cenário 7 deveria estar vinculada"
CONV7_ANTES="$(q "select row_to_json(c)::text from public.conversations c where id = '$CONV7'")"
IDENT7_ANTES="$(q "select row_to_json(i)::text from public.whatsapp_identities i where id = '$A7'")"
AUD7_ANTES="$(q "select count(*) from public.audit_logs where resource_id = '$A7' or resource_id = '$CONV7'")"
# Outra sessão trava a LINHA da conversa (nenhuma trava consultiva).
psql_as b3d2b2b3a_r7h > /dev/null 2>&1 <<SQL &
begin;
select id from public.conversations where id = '$CONV7' for update;
select pg_sleep(5);
commit;
SQL
HOLD_PID=$!
wait_sleeping b3d2b2b3a_r7h
q "update public.whatsapp_webhook_inbox set lease_until = clock_timestamp() + interval '2 seconds' where id = '$(id 10)'" > /dev/null
INBOX7_ANTES="$(q "select concat_ws('|', state, claim_token, claimed_at, lease_until) from public.whatsapp_webhook_inbox where id = '$(id 10)'")"
OUT_R="$(mktemp)"
echo "$(ic_sql "$(id 10)" "$(tok 10)" phone_number "$(tel 09)" "" "$(tel 20)" "$BY")" | psql_as b3d2b2b3a_r7e > "$OUT_R" 2>&1 &
P_R=$!
wait_lock_waiters 1 b3d2b2b3a_r7e
# A espera é pela linha que a outra sessão segura (não por trava consultiva).
[ "$(q "select count(*) from pg_stat_activity e where e.application_name = 'b3d2b2b3a_r7e' and e.wait_event_type = 'Lock'
  and e.wait_event in ('transactionid', 'tuple')
  and exists (select 1 from pg_stat_activity h where h.application_name = 'b3d2b2b3a_r7h' and h.pid = any(pg_blocking_pids(e.pid)))")" = "1" ]   || fail "o efeito não está esperando a trava de linha da conversa"
for _ in $(seq 1 50); do
  [ "$(q "select (lease_until <= clock_timestamp())::text from public.whatsapp_webhook_inbox where id = '$(id 10)'")" = "true" ] && break
  sleep 0.1
done
[ "$(q "select (lease_until <= clock_timestamp())::text from public.whatsapp_webhook_inbox where id = '$(id 10)'")" = "true" ] || fail "a lease não venceu durante a espera"
[ "$(q "select count(*) from pg_stat_activity where application_name = 'b3d2b2b3a_r7e' and wait_event_type = 'Lock'")" = "1" ] || fail "o efeito parou de esperar antes de a lease vencer"
wait "$HOLD_PID" || fail "a sessão que segura a linha falhou"
wait $P_R || fail "o efeito falhou: $(cat "$OUT_R")"
[ "$(tail -1 "$OUT_R")" = "claim_lost" ] || fail "a lease venceu na espera pela linha: esperado claim_lost, veio $(tail -1 "$OUT_R")"
[ "$(q "select row_to_json(i)::text from public.whatsapp_identities i where id = '$A7'")" = "$IDENT7_ANTES" ] || fail "o claim perdido mudou telefone ou BSUID da identidade"
[ "$(q "select row_to_json(c)::text from public.conversations c where id = '$CONV7'")" = "$CONV7_ANTES" ] || fail "o claim perdido mudou a conversa ou os vínculos"
[ "$(q "select count(*) from public.audit_logs where resource_id = '$A7' or resource_id = '$CONV7'")" = "$AUD7_ANTES" ] || fail "o claim perdido gravou auditoria"
[ "$(q "select count(*) from public.whatsapp_effect_ledger where inbox_id = '$(id 10)'")" = "0" ] || fail "o claim perdido gravou ledger"
[ "$(q "select concat_ws('|', state, claim_token, claimed_at, lease_until) from public.whatsapp_webhook_inbox where id = '$(id 10)'")" = "$INBOX7_ANTES" ] || fail "o claim perdido mexeu na entrada"
[ "$(q "select concat_ws('|', state, claim_token) from public.whatsapp_webhook_inbox where id = '$(id 10)'")" = "processing|$(tok 10)" ] || fail "a entrada deveria seguir em processing com o mesmo claim"
[ "$(owners "$(tel 20)")|$(q "select count(*) from public.whatsapp_identities where bsuid_blind_index = decode('$BY', 'base64')")" = "0|0" ] || fail "o telefone ou o BSUID novos ficaram gravados"
echo "   ok: o efeito esperou a linha da conversa, a lease venceu e veio claim_lost; nada mudou"

echo "== 4. o canal é pausado enquanto o efeito roda, e depois de um claim"
hold_lock b3d2b2b3a_h4 "$(tel 16)"
OUT_4="$(mktemp)"; OUT_P="$(mktemp)"
echo "$(ic_sql "$(id 8)" "$(tok 8)" phone_number "$(tel 06)" "" "$(tel 16)" "")" | psql_as b3d2b2b3a_p4e > "$OUT_4" 2>&1 &
P_EF=$!
wait_lock_waiters 1 b3d2b2b3a_p4e
psql_as b3d2b2b3a_p4p -c "update public.whatsapp_channels set status = 'paused', send_enabled = false, status_changed_at = now() where id = '$CANAL'" > "$OUT_P" 2>&1 &
P_PAUSE=$!
for _ in $(seq 1 30); do
  [ "$(q "select count(*) from pg_stat_activity where application_name = 'b3d2b2b3a_p4p' and wait_event_type = 'Lock'")" = "1" ] && break
  kill -0 "$P_PAUSE" 2> /dev/null || fail "a pausa terminou sem esperar o efeito em andamento"
  sleep 0.1
done
[ "$(q "select count(*) from pg_stat_activity where application_name = 'b3d2b2b3a_p4p' and wait_event_type = 'Lock'")" = "1" ] || fail "a pausa não esperou o efeito em andamento"
wait "$HOLD_PID" || fail "a sessão que segura a trava falhou"
wait $P_EF || fail "o efeito falhou: $(cat "$OUT_4")"
wait $P_PAUSE || fail "a pausa falhou: $(cat "$OUT_P")"
[ "$(tail -1 "$OUT_4")" = "applied" ] || fail "o efeito que leu o canal ativo deveria aplicar: $(tail -1 "$OUT_4")"
[ "$(q "select status from public.whatsapp_channels where id = '$CANAL'")" = "paused" ] || fail "a pausa não ficou gravada"
[ "$(echo "$(ic_sql "$(id 9)" "$(tok 9)" phone_number "$(tel 16)" "" "$(tel 19)" "")" | psql_as b3d2b2b3a_main | tail -1)" = "channel_paused" ] || fail "o claim antigo deveria ver o canal pausado"
[ "$(phone_of "$A4")|$(q "select count(*) from public.whatsapp_effect_ledger where inbox_id = '$(id 9)'")|$(q "select state from public.whatsapp_webhook_inbox where id = '$(id 9)'")" = "$(tel 16)|$(tel 16)|0|processing" ] || fail "o canal pausado deixou efeito ou finalizou a entrada"
echo "   ok: a pausa esperou o efeito em andamento; o claim antigo viu channel_paused, sem efeito"

[ "$(q "select (select count(*) from public.contacts) || '|' || (select count(*) from public.contact_phones) || '|' || (select count(*) from public.contact_identifiers) || '|' || (select count(*) from public.leads) || '|' || (select count(*) from public.opportunities) || '|' || (select count(*) from public.activities)")" = "$COMERCIAL_ANTES" ] || fail "a troca de identidade mexeu em registro comercial"
[ "$(q "select count(*) from public.whatsapp_identities where channel_id = '$CANAL'")" = "$IDENT_ANTES" ] || fail "a troca de identidade criou identidade"
echo "== efeito de identidade alterada sob concorrência real: OK"
