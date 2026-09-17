#!/usr/bin/env node
// A10 — cria, no praxis-crm-dev, um escritório EXCLUSIVAMENTE demonstrativo
// para validar a Visão geral. Repetível: se o escritório já existe, não
// grava nada (nem duplica dados). Nunca altera escritórios, usuários ou
// permissões existentes: as quatro contas usadas são novas e dedicadas
// (e-mails fictícios @praxis.test), com senhas únicas guardadas só no
// arquivo local indicado, fora do Git. Senha nenhuma é impressa nem vai
// no texto do SQL — só o hash argon2id, calculado aqui.
//
// Os dados comerciais vêm do MESMO gerador do seed local
// (supabase/seed.sql, entre os marcadores "A10 demo generator").
//
// Uso:
//   node scripts/a10-demo-workspace.mjs --credentials <arquivo>            (simulação: rollback)
//   node scripts/a10-demo-workspace.mjs --credentials <arquivo> --apply    (grava)
//
// Pré-requisito: `supabase link` feito para o praxis-crm-dev.

import { execSync } from "node:child_process";
import { argon2Sync, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const EXPECTED_REF = "rgoeppjwnltcbeqipovh"; // praxis-crm-dev
const WORKSPACE_ID = "d10a0000-0000-4000-8000-000000000001";
const PIPELINE_ID = "d10a0000-0000-4000-8000-000000000002";
const ROLES = [
  { key: "owner", role: "owner", id: "d10a0000-0000-4000-8000-000000000011", name: "Demo Proprietária (A10)" },
  { key: "lawyer", role: "lawyer", id: "d10a0000-0000-4000-8000-000000000012", name: "Demo Advogado (A10)" },
  { key: "sales", role: "sales", id: "d10a0000-0000-4000-8000-000000000013", name: "Demo Atendimento (A10)" },
  { key: "viewer", role: "viewer", id: "d10a0000-0000-4000-8000-000000000014", name: "Demo Visualizador (A10)" },
];

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const credIndex = args.indexOf("--credentials");
const credPath = credIndex >= 0 ? args[credIndex + 1] : undefined;
if (!credPath) {
  console.error("Informe --credentials <arquivo local fora do Git>.");
  process.exit(1);
}

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
if (path.resolve(credPath).startsWith(root + path.sep)) {
  console.error("O arquivo de credenciais precisa ficar FORA do repositório.");
  process.exit(1);
}

// 1. Projeto de destino.
const refFile = path.join(root, "supabase", ".temp", "project-ref");
const ref = fs.existsSync(refFile) ? fs.readFileSync(refFile, "utf8").trim() : "";
if (ref !== EXPECTED_REF) {
  console.error(`Projeto vinculado é "${ref || "(nenhum)"}", esperado ${EXPECTED_REF} (praxis-crm-dev). Nada foi feito.`);
  process.exit(1);
}
console.log(`Projeto de destino: praxis-crm-dev (${ref}) · modo: ${apply ? "GRAVAR" : "simulação (rollback)"}`);

// 2. Credenciais locais (criadas uma vez, reaproveitadas depois).
let creds = {};
if (fs.existsSync(credPath)) {
  for (const line of fs.readFileSync(credPath, "utf8").split(/\r?\n/)) {
    const m = line.match(/^([a-z]+)\.(email|senha)=(.*)$/);
    if (m) (creds[m[1]] ??= {})[m[2]] = m[3].trim();
  }
}
let wroteCreds = false;
for (const r of ROLES) {
  if (!creds[r.key]?.email || !creds[r.key]?.senha) {
    creds[r.key] = { email: `demo-a10.${r.key}@praxis.test`, senha: randomBytes(18).toString("base64url") };
    wroteCreds = true;
  }
}
if (wroteCreds) {
  const body = [
    "# Contas dedicadas do escritório demonstrativo da A10 (praxis-crm-dev). Não versionar.",
    ...ROLES.flatMap((r) => [`${r.key}.email=${creds[r.key].email}`, `${r.key}.senha=${creds[r.key].senha}`]),
    "",
  ].join("\n");
  fs.writeFileSync(credPath, body, { mode: 0o600 });
  console.log("Credenciais novas gravadas no arquivo local indicado (valores não exibidos).");
}

function argon2id(password) {
  const salt = randomBytes(16);
  const params = { memory: 19456, passes: 2, parallelism: 1 };
  const hash = argon2Sync("argon2id", { message: password, nonce: salt, tagLength: 32, ...params });
  const b64 = (buf) => Buffer.from(buf).toString("base64").replace(/=+$/, "");
  return `$argon2id$v=19$m=${params.memory},t=${params.passes},p=${params.parallelism}$${b64(salt)}$${b64(hash)}`;
}

const lit = (value) => `'${String(value).replace(/'/g, "''")}'`;

// 3. SQL.
const seed = fs.readFileSync(path.join(root, "supabase", "seed.sql"), "utf8");
const generator = seed.match(/-- >>> A10 demo generator[\s\S]*?-- <<< A10 demo generator/);
if (!generator) {
  console.error("Gerador não encontrado em supabase/seed.sql.");
  process.exit(1);
}

const userRows = ROLES.map(
  (r) => `(${lit(r.id)}::uuid, ${lit(creds[r.key].email)}, ${lit(argon2id(creds[r.key].senha))}, ${lit(r.name)}, ${lit(r.role)})`,
).join(",\n    ");

const targets = JSON.stringify([
  {
    workspace_id: WORKSPACE_ID,
    pipeline_id: PIPELINE_ID,
    owner: ROLES[0].id,
    lawyer: ROLES[1].id,
    sales: ROLES[2].id,
    leads: 64,
  },
]);

const sql = `
begin;

do $setup$
declare
  v_conflict integer;
begin
  perform set_config('praxis.demo_targets', '[]', false);

  if exists (select 1 from public.workspaces where id = ${lit(WORKSPACE_ID)}) then
    raise notice 'Escritório demonstrativo já existe — nada a gravar.';
    return;
  end if;

  -- Nunca reaproveita nem altera uma conta existente.
  select count(*) into v_conflict
  from auth.users u
  join (values
    ${userRows}
  ) as d(id, email, hash, full_name, role) on u.email = d.email or u.id = d.id;
  if v_conflict > 0 then
    raise exception 'Já existe conta com o e-mail ou id reservado para a demonstração; nada foi alterado.';
  end if;

  insert into auth.users (
    instance_id, id, aud, role, email, encrypted_password,
    email_confirmed_at, confirmation_token, recovery_token,
    email_change, email_change_token_new, email_change_token_current,
    phone_change, phone_change_token, reauthentication_token,
    raw_app_meta_data, raw_user_meta_data,
    is_super_admin, is_sso_user, is_anonymous, created_at, updated_at
  )
  select '00000000-0000-0000-0000-000000000000', d.id, 'authenticated', 'authenticated', d.email, d.hash,
         now(), '', '', '', '', '', '', '', '',
         '{"provider":"email","providers":["email"]}', jsonb_build_object('full_name', d.full_name),
         false, false, false, now(), now()
  from (values
    ${userRows}
  ) as d(id, email, hash, full_name, role);

  insert into auth.identities (provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
  select d.id::text, d.id, jsonb_build_object('sub', d.id::text, 'email', d.email, 'email_verified', true), 'email', now(), now(), now()
  from (values
    ${userRows}
  ) as d(id, email, hash, full_name, role);

  insert into public.workspaces (id, name, slug, created_by, is_demo)
  values (${lit(WORKSPACE_ID)}, 'Escritório Demonstração (A10)', 'escritorio-demonstracao-a10', ${lit(ROLES[0].id)}, true);

  insert into public.memberships (workspace_id, user_id, role, status)
  select ${lit(WORKSPACE_ID)}, d.id, d.role::public.membership_role, 'active'
  from (values
    ${userRows}
  ) as d(id, email, hash, full_name, role);

  insert into public.pipelines (id, workspace_id, name, is_default, created_by)
  values (${lit(PIPELINE_ID)}, ${lit(WORKSPACE_ID)}, 'Comercial', true, ${lit(ROLES[0].id)});

  insert into public.pipeline_stages (workspace_id, pipeline_id, name, position)
  select ${lit(WORKSPACE_ID)}, ${lit(PIPELINE_ID)}, s.name, s.position
  from (values
    ('Fazer primeiro contato', 0), ('Qualificar oportunidade', 1), ('Verificar aderência e conflito', 2),
    ('Agendar consulta', 3), ('Realizar consulta', 4), ('Enviar proposta', 5),
    ('Negociar honorários', 6), ('Aguardar assinatura', 7)
  ) as s(name, position);

  insert into public.lost_reasons (workspace_id, label, position)
  select ${lit(WORKSPACE_ID)}, r.label, r.position
  from (values
    ('Honorários acima do orçamento', 0), ('Escolheu outro escritório', 1), ('Sem viabilidade jurídica', 2),
    ('Cliente desistiu', 3), ('Sem retorno do cliente', 4)
  ) as r(label, position);

  perform set_config('praxis.demo_targets', ${lit(targets)}, false);
end;
$setup$;

${generator[0]}

select
  (select count(*) from public.workspaces where id = ${lit(WORKSPACE_ID)} and is_demo) as escritorio_demo,
  (select count(*) from public.memberships where workspace_id = ${lit(WORKSPACE_ID)}) as membros,
  (select count(*) from public.leads where workspace_id = ${lit(WORKSPACE_ID)}) as leads,
  (select count(*) from public.opportunities where workspace_id = ${lit(WORKSPACE_ID)}) as oportunidades,
  (select count(*) from public.activities where workspace_id = ${lit(WORKSPACE_ID)}) as atividades,
  (select count(*) from public.proposals where workspace_id = ${lit(WORKSPACE_ID)}) as propostas,
  (select count(*) from public.workspaces where is_demo) as escritorios_demo_total;

${apply ? "commit;" : "rollback;"}
`;

const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "a10-demo-")), "run.sql");
try {
  fs.writeFileSync(tmp, sql, { mode: 0o600 });
  let out;
  try {
    out = execSync(`npx supabase db query --linked --file "${tmp}"`, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    // Só a mensagem do Postgres: o trecho de SQL citado no erro pode conter hashes.
    const text = `${error.stdout ?? ""}${error.stderr ?? ""}`;
    // A saída da CLI é JSON: a mensagem termina no primeiro "\n" escapado.
    const message = text.match(/ERROR:\s+(.+?)(?:\\n|\n|")/)?.[1] ?? "falha ao executar (detalhes omitidos)";
    console.error(`Nada foi gravado. Erro: ${message}`);
    process.exitCode = 1;
    out = null;
  }
  if (out !== null) {
    const rows = JSON.parse(out.slice(out.indexOf("{"))).rows ?? [];
    console.log(JSON.stringify(rows, null, 1));
  }
} finally {
  fs.rmSync(path.dirname(tmp), { recursive: true, force: true });
}
