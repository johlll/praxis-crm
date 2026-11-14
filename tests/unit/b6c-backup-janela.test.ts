/**
 * @vitest-environment node
 *
 * B6c — agendamento GRATUITO e resistente a atraso (ou descarte) do cron do GitHub: quatro oportunidades por dia
 * (07:30, 11:30, 15:30 e 19:30 UTC), mas no máximo UM backup completo dentro de uma janela de 20 horas.
 *
 * Antes de instalar ferramentas ou tocar no banco, o job `janela` consulta SÓ os METADADOS dos artefatos do próprio
 * repositório (GITHUB_TOKEN efêmero, `actions: read`) e decide `executar=true|false`. O job `backup` — o único com
 * secrets — só roda se a janela mandar. Aqui:
 *  - garantias ESTÁTICAS do modelo (horários, gatilhos, permissões, onde ficam os secrets, ações aprovadas);
 *  - o script REAL do passo "decidir" (extraído do próprio modelo) é executado com um `gh` de mentira que devolve
 *    metadados sintéticos e com o `jq` de verdade: recente → não executa; ausente, antigo ou inválido → executa;
 *    disparo manual → sempre executa, sem consultar nada; falha da API → falha fechado; só artefato COMPLETO e
 *    de execução BEM-SUCEDIDA conta; o log só tem códigos fechados e idade agregada.
 * Nenhuma chamada de rede, nenhum dado de Production. Chaves e nomes fictícios.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

const RAIZ = process.cwd();
const ler = (caminho: string) => readFileSync(join(RAIZ, caminho), "utf8").split("\r").join("");
const MODELO = "docs/backup/modelo-repositorio-privado/.github/workflows/backup-diario.yml";
const workflow = ler(MODELO);

const REPO = "exemplo/praxis-crm-backups";
const CAMINHO_WORKFLOW = ".github/workflows/backup-diario.yml";
const TOKEN_FICTICIO = "ghs_tokenficticio0123456789abcdefghij";

/** Os dois jobs do modelo, sem depender de um parser de YAML. */
const iJanela = workflow.indexOf("\n  janela:");
const iBackup = workflow.indexOf("\n  backup:");
const jobJanela = workflow.slice(iJanela, iBackup);
const jobBackup = workflow.slice(iBackup);

const semComentarios = (texto: string) =>
  texto
    .split("\n")
    .filter((linha) => !linha.trim().startsWith("#"))
    .join("\n");

// ---------------------------------------------------------------------------------------------------------
describe("quatro janelas por dia, sem pull_request, com permissões só de leitura", () => {
  it("a estrutura tem dois jobs: `janela` (decide) e `backup` (precisa da janela)", () => {
    expect(iJanela).toBeGreaterThan(-1);
    expect(iBackup).toBeGreaterThan(iJanela);
    const jobs = workflow.slice(workflow.indexOf("\njobs:"));
    expect([...jobs.matchAll(/^ {2}([a-z]+):$/gm)].map((m) => m[1])).toEqual(["janela", "backup"]);
    expect(jobBackup).toMatch(/\n {4}needs: janela\n/);
  });

  it("os quatro horários diários estão no workflow: 07:30, 11:30, 15:30 e 19:30 UTC", () => {
    const on = workflow.slice(workflow.indexOf("\non:"), workflow.indexOf("\nconcurrency:"));
    expect([...on.matchAll(/- cron: "([^"]+)"/g)].map((m) => m[1])).toEqual(["30 7 * * *", "30 11 * * *", "30 15 * * *", "30 19 * * *"]);
    // workflow_dispatch continua existindo.
    expect([...on.matchAll(/^ {2}([a-z_]+):/gm)].map((m) => m[1])).toEqual(["schedule", "workflow_dispatch"]);
  });

  it("não existe pull_request (nem outro gatilho que rode código de terceiros)", () => {
    expect(semComentarios(workflow)).not.toMatch(/pull_request|pull_request_target|\bpush:|repository_dispatch|issue_comment/);
    // `workflow_run` como GATILHO: só a seção `on:` conta (`.workflow_run.id` é um campo da API de artefatos).
    expect(workflow.slice(workflow.indexOf("\non:"), workflow.indexOf("\nconcurrency:"))).not.toMatch(/workflow_run/);
  });

  it("permissões só de leitura: contents: read no workflow e actions: read apenas no job da janela", () => {
    expect(workflow).not.toMatch(/: write\b/);
    expect(workflow).toMatch(/\npermissions:\n {2}contents: read\n/);
    const blocos = [...workflow.matchAll(/^( *)permissions:\n((?: +[a-z-]+: [a-z]+\n)+)/gm)];
    expect(blocos).toHaveLength(2);
    const [topo, janela] = blocos;
    expect(topo![2]!.trim().split("\n").map((l) => l.trim())).toEqual(["contents: read"]);
    expect(janela![2]!.trim().split("\n").map((l) => l.trim())).toEqual(["contents: read", "actions: read"]);
    expect(jobJanela).toContain("actions: read");
    expect(jobBackup).not.toContain("actions:");
    expect(workflow.match(/actions: read/g)).toHaveLength(1);
    // Todo valor de permissão é `read`.
    for (const bloco of blocos) for (const linha of bloco[2]!.trim().split("\n")) expect(linha.trim()).toMatch(/^[a-z-]+: read$/);
  });

  it("concorrência 1, timeout de 30 minutos no backup e retenção de 30 dias continuam iguais", () => {
    expect(workflow).toMatch(/concurrency:\n {2}group: praxis-backup\n {2}cancel-in-progress: false/);
    expect(jobBackup).toMatch(/timeout-minutes: 30\n/);
    expect(jobJanela).toMatch(/timeout-minutes: \d+\n/);
    expect(workflow).toContain("retention-days: 30");
  });

  it("nenhuma Action nova: só checkout e upload-artifact, nos SHAs já aprovados, e ambos no job do backup", () => {
    const usos = [...workflow.matchAll(/^\s*(?:- )?uses: (\S+)/gm)].map((m) => m[1]);
    expect(usos).toEqual([
      "actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09",
      "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02",
    ]);
    expect(jobJanela).not.toContain("uses:");
    expect(jobBackup.match(/uses:/g)).toHaveLength(2);
  });

  it("o job da janela não tem secrets nem scripts de backup; os secrets existem só no job do backup", () => {
    expect(jobJanela).not.toMatch(/secrets\./);
    expect(jobJanela).not.toMatch(/backup-db\.sh|backup-storage\.sh|BACKUP_DATABASE_URL|BACKUP_AGE_PUBLIC_KEY|BACKUP_STORAGE|pg_dump|aws |apt-get|age-keygen|install/i);
    expect(workflow.slice(0, iBackup)).not.toMatch(/secrets\.BACKUP/);
    expect(jobBackup).toMatch(/secrets\.BACKUP_DATABASE_URL/);
  });

  it("o job do backup só roda se a janela mandar, e nunca no repositório público", () => {
    const cabecalho = jobBackup.split("\n").slice(0, 12).join("\n");
    expect(cabecalho).toMatch(/if: \$\{\{ github\.repository != 'johlll\/praxis-crm' && needs\.janela\.outputs\.executar == 'true' \}\}/);
    expect(jobJanela).toContain("if: ${{ github.repository != 'johlll/praxis-crm' }}");
    expect(jobJanela).toMatch(/outputs:\n {6}executar: \$\{\{ steps\.decidir\.outputs\.executar \}\}/);
  });

  it("a janela falha fechada: sem continue-on-error, `|| true`, always() nem failure()", () => {
    expect(semComentarios(jobJanela)).not.toMatch(/continue-on-error|\|\| true|if: always\(\)|if: failure\(\)/);
  });
});

// ---------------------------------------------------------------------------------------------------------
/** Extrai o corpo do `run: |` do passo `id: decidir` (dedent de 10 espaços). */
function scriptDecidir(): string {
  const linhas = jobJanela.split("\n");
  const inicio = linhas.findIndex((l) => l.trim() === "id: decidir");
  expect(inicio).toBeGreaterThan(-1);
  const run = linhas.findIndex((l, i) => i > inicio && l === "        run: |");
  expect(run).toBeGreaterThan(inicio);
  const corpo: string[] = [];
  for (const linha of linhas.slice(run + 1)) {
    if (linha.trim() !== "" && !linha.startsWith("          ")) break;
    corpo.push(linha.startsWith("          ") ? linha.slice(10) : "");
  }
  return `${corpo.join("\n").trimEnd()}\n`;
}

function acharBash(): string {
  if (process.platform !== "win32") return "bash";
  for (const candidato of [process.env.BASH_EXE, "C:\\Program Files\\Git\\bin\\bash.exe", "C:\\Program Files\\Git\\usr\\bin\\bash.exe"]) {
    if (candidato && existsSync(candidato)) return candidato;
  }
  return "bash";
}
const BASH = acharBash();
const fwd = (caminho: string) => caminho.split("\\").join("/");

const FAKE_GH = `#!/usr/bin/env bash
# gh de mentira: registra cada chamada e devolve metadados sintéticos (nunca fala com a rede).
printf '%s\\n' "$*" >>"$FAKE_GH_LOG"
if [ "\${FAKE_GH_FALHA:-}" = "tudo" ]; then exit 1; fi
args="$*"
case "$args" in
  *"actions/artifacts"*)
    if [ "\${FAKE_GH_FALHA:-}" = "artefatos" ]; then exit 1; fi
    cat "$FAKE_GH_ARTEFATOS" ;;
  *"actions/runs/"*)
    if [ "\${FAKE_GH_FALHA:-}" = "execucao" ]; then exit 1; fi
    run="\${args##*/runs/}"
    run="\${run%% *}"
    arquivo="$FAKE_GH_RUNS/$run.json"
    if [ -f "$arquivo" ]; then cat "$arquivo"; else exit 1; fi ;;
  *) exit 1 ;;
esac
`;

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const iso = (horasAtras: number) => new Date(Date.now() - horasAtras * 3_600_000).toISOString().replace(/\.\d{3}Z$/, "Z");

type Artefato = { run: number; horas: number; nome?: string; expirado?: boolean; bytes?: number; nomeRun?: number };
const artefato = (a: Artefato) => ({
  id: 9_000_000 + a.run,
  node_id: "MDg6QXJ0aWZhY3Q=",
  name: a.nome ?? `praxis-backup-${a.run}`,
  size_in_bytes: a.bytes ?? 595_550,
  url: `https://api.github.com/repos/${REPO}/actions/artifacts/${9_000_000 + a.run}`,
  archive_download_url: `https://api.github.com/repos/${REPO}/actions/artifacts/${9_000_000 + a.run}/zip`,
  expired: a.expirado ?? false,
  digest: "sha256:0f85ea3bf0fe147c0ef40c28c2519debd02b43602c0757658d517347314b2f54",
  created_at: iso(a.horas),
  updated_at: iso(a.horas),
  expires_at: iso(a.horas - 24 * 30),
  workflow_run: { id: a.nomeRun ?? a.run, repository_id: 1, head_repository_id: 1, head_branch: "main", head_sha: "a".repeat(40) },
});
type Execucao = { status?: string; conclusion?: string | null; path?: string };
const execucao = (e: Execucao = {}) => ({
  status: e.status ?? "completed",
  conclusion: e.conclusion === undefined ? "success" : e.conclusion,
  path: e.path ?? CAMINHO_WORKFLOW,
  workflow_id: 351985371,
  event: "schedule",
});

type Cenario = {
  evento?: string;
  artefatos?: Artefato[];
  execucoes?: Record<number, Execucao | "ausente">;
  falha?: "tudo" | "artefatos" | "execucao";
};
type Resultado = { codigo: number | null; stdout: string; stderr: string; executar: string[]; chamadas: string[] };

function rodar(c: Cenario): Resultado {
  const dir = mkdtempSync(join(tmpdir(), "janela-"));
  dirs.push(dir);
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "gh"), FAKE_GH);
  chmodSync(join(bin, "gh"), 0o755);
  writeFileSync(join(dir, "decidir.sh"), scriptDecidir());
  const artefatos = (c.artefatos ?? []).map(artefato);
  writeFileSync(join(dir, "artefatos.json"), JSON.stringify({ total_count: artefatos.length, artifacts: artefatos }));
  mkdirSync(join(dir, "runs"));
  for (const [id, e] of Object.entries(c.execucoes ?? {})) {
    if (e !== "ausente") writeFileSync(join(dir, "runs", `${id}.json`), JSON.stringify(execucao(e)));
  }
  writeFileSync(join(dir, "saida.txt"), "");
  writeFileSync(join(dir, "gh.log"), "");
  const r = spawnSync(BASH, [fwd(join(dir, "decidir.sh"))], {
    encoding: "utf8",
    timeout: 60_000,
    env: {
      ...process.env,
      PATH: `${bin}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}`,
      GITHUB_EVENT_NAME: c.evento ?? "schedule",
      GITHUB_REPOSITORY: REPO,
      GITHUB_WORKFLOW_REF: `${REPO}/${CAMINHO_WORKFLOW}@refs/heads/main`,
      GITHUB_OUTPUT: fwd(join(dir, "saida.txt")),
      GH_TOKEN: TOKEN_FICTICIO,
      LIMITE_HORAS: "20",
      FAKE_GH_LOG: fwd(join(dir, "gh.log")),
      FAKE_GH_ARTEFATOS: fwd(join(dir, "artefatos.json")),
      FAKE_GH_RUNS: fwd(join(dir, "runs")),
      FAKE_GH_FALHA: c.falha ?? "",
    },
  });
  const linhas = (arquivo: string) =>
    readFileSync(join(dir, arquivo), "utf8")
      .split(/\r?\n/)
      .filter((l) => l.length > 0);
  return {
    codigo: r.status,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    executar: linhas("saida.txt"),
    chamadas: linhas("gh.log"),
  };
}

const executa = (r: Resultado) => r.executar.includes("executar=true");
const naoExecuta = (r: Resultado) => r.executar.includes("executar=false");

// Cada caso abre um bash de verdade (no Windows, sob a carga da suíte inteira, leva ~1 s por execução): 60 s por teste.
describe("o script real da janela (extraído do modelo) com metadados sintéticos", { timeout: 60_000 }, () => {
  it("o ambiente do teste tem bash e jq de verdade (sem eles os testes abaixo seriam vácuo)", () => {
    const jq = spawnSync("jq", ["--version"], { encoding: "utf8" });
    expect(jq.status, "jq precisa estar no PATH (o runner do GitHub já traz)").toBe(0);
    const bash = spawnSync(BASH, ["-c", "echo ok"], { encoding: "utf8" });
    expect(bash.stdout.trim()).toBe("ok");
  });

  it("o script foi extraído do passo certo (usa gh e jq, só leitura, sem secrets)", () => {
    const script = scriptDecidir();
    expect(script).toContain("set -euo pipefail");
    expect(script).toContain('gh api --paginate "repos/${GITHUB_REPOSITORY}/actions/artifacts?per_page=100"');
    expect(script).toContain('gh api "repos/${GITHUB_REPOSITORY}/actions/runs/${execucao}"');
    expect(script).not.toMatch(/--method|-X |--input|-f |-F |\/zip|\/logs|\/secrets|archive_download_url|curl|wget/);
    expect(script).not.toMatch(/BACKUP_|secrets\./);
  });

  it("backup recente e bem-sucedido (2 h) em execução agendada: NÃO executa, só com metadados", () => {
    const r = rodar({ artefatos: [{ run: 111, horas: 2 }], execucoes: { 111: {} } });
    expect(r.codigo).toBe(0);
    expect(naoExecuta(r)).toBe(true);
    expect(r.executar).toEqual(["executar=false"]);
    expect(r.stdout.trim()).toBe("janela: backup_recente idade_horas=2 limite_horas=20 -> nao_executar");
    // Só duas consultas de metadados: a lista de artefatos e a execução que gerou o artefato (GET, sem corpo).
    expect(r.chamadas).toHaveLength(2);
    expect(r.chamadas[0]).toBe(`api --paginate repos/${REPO}/actions/artifacts?per_page=100`);
    expect(r.chamadas[1]).toBe(`api repos/${REPO}/actions/runs/111`);
  });

  it("sem artefato nenhum: executa", () => {
    const r = rodar({ artefatos: [] });
    expect(r.codigo).toBe(0);
    expect(executa(r)).toBe(true);
    expect(r.stdout.trim()).toBe("janela: sem_backup_recente limite_horas=20 -> executar");
  });

  it("a trava é de 20 horas: 19,9 h ainda é recente; 20,1 h executa", () => {
    const quase = rodar({ artefatos: [{ run: 1, horas: 19.9 }], execucoes: { 1: {} } });
    expect(naoExecuta(quase)).toBe(true);
    expect(quase.stdout.trim()).toBe("janela: backup_recente idade_horas=19 limite_horas=20 -> nao_executar");
    const passou = rodar({ artefatos: [{ run: 1, horas: 20.1 }], execucoes: { 1: {} } });
    expect(executa(passou)).toBe(true);
    // Artefato velho nem chega a pedir a execução: só a lista é consultada.
    expect(passou.chamadas).toHaveLength(1);
  });

  it("artefato mais velho que 20 horas (ou só velhos): executa", () => {
    const r = rodar({ artefatos: [{ run: 5, horas: 26 }, { run: 4, horas: 50 }], execucoes: { 5: {}, 4: {} } });
    expect(executa(r)).toBe(true);
  });

  it("workflow_dispatch SEMPRE executa, mesmo com backup recente, e nem consulta a API", () => {
    const r = rodar({ evento: "workflow_dispatch", artefatos: [{ run: 111, horas: 1 }], execucoes: { 111: {} } });
    expect(r.codigo).toBe(0);
    expect(r.executar).toEqual(["executar=true"]);
    expect(r.stdout.trim()).toBe("janela: disparo_manual -> executar");
    expect(r.chamadas).toEqual([]);
  });

  it("falha da API do GitHub BLOQUEIA a execução: erro fechado, nenhuma saída `executar` (nunca assume backup recente)", () => {
    for (const falha of ["tudo", "artefatos"] as const) {
      const r = rodar({ falha, artefatos: [{ run: 111, horas: 2 }], execucoes: { 111: {} } });
      expect(r.codigo, falha).not.toBe(0);
      expect(r.executar, falha).toEqual([]);
      expect(r.stderr.trim(), falha).toBe("ERRO: estado_anterior_indisponivel");
      expect(r.stdout.trim(), falha).toBe("");
    }
  });

  it("falha ao consultar a execução do artefato recente também bloqueia (não dá para saber se foi bem-sucedida)", () => {
    const cenarios: Cenario[] = [
      { artefatos: [{ run: 111, horas: 2 }], execucoes: { 111: "ausente" } }, // a consulta da execução não acha nada
      { artefatos: [{ run: 111, horas: 2 }] }, // nenhuma execução cadastrada no servidor de mentira
    ];
    for (const c of cenarios) {
      const r = rodar(c);
      expect(r.codigo).not.toBe(0);
      expect(r.executar).toEqual([]);
      expect(r.stderr.trim()).toBe("ERRO: estado_anterior_indisponivel");
    }
    const r = rodar({ falha: "execucao", artefatos: [{ run: 111, horas: 2 }], execucoes: { 111: {} } });
    expect(r.codigo).not.toBe(0);
    expect(r.executar).toEqual([]);
  });

  it("evento inesperado (nem schedule nem workflow_dispatch) falha fechado", () => {
    const r = rodar({ evento: "push", artefatos: [{ run: 111, horas: 2 }], execucoes: { 111: {} } });
    expect(r.codigo).not.toBe(0);
    expect(r.executar).toEqual([]);
    expect(r.stderr.trim()).toBe("ERRO: evento_inesperado");
    expect(r.chamadas).toEqual([]);
  });

  describe("somente artefato COMPLETO e de execução BEM-SUCEDIDA conta como backup", () => {
    const recente = (extra: Partial<Artefato> = {}): Artefato => ({ run: 777, horas: 2, ...extra });

    it("execução que falhou, foi cancelada ou ainda está rodando não conta (executa)", () => {
      for (const e of [
        { conclusion: "failure" },
        { conclusion: "cancelled" },
        { conclusion: "timed_out" },
        { status: "in_progress", conclusion: null },
        { status: "queued", conclusion: null },
      ]) {
        const r = rodar({ artefatos: [recente()], execucoes: { 777: e } });
        expect(r.codigo, JSON.stringify(e)).toBe(0);
        expect(executa(r), JSON.stringify(e)).toBe(true);
      }
    });

    it("artefato expirado, sem bytes, de outro nome ou com nome que não bate com a execução não conta", () => {
      for (const a of [
        recente({ expirado: true }),
        recente({ bytes: 0 }),
        recente({ nome: "playwright-report" }),
        recente({ nome: "praxis-backup-abc" }),
        recente({ nome: "praxis-backup-777-extra" }),
        recente({ nomeRun: 778 }), // o nome diz 777, mas a execução ligada ao artefato é outra
      ]) {
        const r = rodar({ artefatos: [a], execucoes: { 777: {}, 778: {} } });
        expect(r.codigo, JSON.stringify(a)).toBe(0);
        expect(executa(r), JSON.stringify(a)).toBe(true);
      }
    });

    it("execução de OUTRO workflow do mesmo repositório não conta", () => {
      const r = rodar({ artefatos: [recente()], execucoes: { 777: { path: ".github/workflows/outro.yml" } } });
      expect(executa(r)).toBe(true);
    });

    it("o caminho do workflow vem do próprio GITHUB_WORKFLOW_REF (aceita o sufixo @ref da API)", () => {
      const r = rodar({ artefatos: [recente()], execucoes: { 777: { path: `${CAMINHO_WORKFLOW}@refs/heads/main` } } });
      expect(naoExecuta(r)).toBe(true);
    });

    it("com vários artefatos, basta UM completo e bem-sucedido dentro das 20 horas", () => {
      const r = rodar({
        artefatos: [
          { run: 903, horas: 1 }, // mais novo, mas a execução falhou
          { run: 902, horas: 8, expirado: true },
          { run: 901, horas: 12 }, // bom
          { run: 900, horas: 30 },
        ],
        execucoes: { 903: { conclusion: "failure" }, 901: {}, 900: {} },
      });
      expect(naoExecuta(r)).toBe(true);
      expect(r.stdout.trim()).toBe("janela: backup_recente idade_horas=12 limite_horas=20 -> nao_executar");
    });
  });

  it("os logs só têm código fechado e idade agregada: nada de token, endereço, número de execução ou nome de artefato", () => {
    const cenarios: Cenario[] = [
      { artefatos: [{ run: 123456789, horas: 3 }], execucoes: { 123456789: {} } },
      { artefatos: [] },
      { evento: "workflow_dispatch" },
      { falha: "tudo", artefatos: [{ run: 123456789, horas: 3 }] },
      { evento: "push" },
    ];
    for (const c of cenarios) {
      const r = rodar(c);
      const saida = `${r.stdout}\n${r.stderr}`;
      for (const linha of saida.split(/\r?\n/).filter(Boolean)) {
        expect(linha).toMatch(
          /^(janela: (disparo_manual -> executar|sem_backup_recente limite_horas=\d+ -> executar|backup_recente idade_horas=\d+ limite_horas=\d+ -> nao_executar)|ERRO: (estado_anterior_indisponivel|evento_inesperado))$/,
        );
      }
      expect(saida).not.toContain(TOKEN_FICTICIO);
      expect(saida).not.toMatch(/https?:|123456789|praxis-backup-|exemplo\/|\.github|workflow|digest|sha256/i);
    }
  });
});
