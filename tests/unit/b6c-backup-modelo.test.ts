/**
 * @vitest-environment node
 *
 * B6c — backup lógico criptografado e restauração testável (plano Free, sem serviço pago).
 *
 * Aqui, as garantias ESTÁTICAS (o comportamento com pg_dump/age reais está em
 * scripts/backup/check-backup-restore.sh, que o CI roda contra o Postgres local):
 *  - o workflow-modelo só agenda o diário e o manual, nunca roda em pull_request nem no repositório
 *    público, não tem permissão de escrita e só envia o pacote criptografado e o checksum;
 *  - versões fixas (PostgreSQL 17, age com SHA-256, runner);
 *  - os scripts não usam xtrace, não recebem a URL como argumento, usam só chave pública no backup e
 *    pedem a chave privada por caminho local na restauração;
 *  - nenhuma chave privada age no repositório e nenhum workflow público usa os secrets do backup.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const RAIZ = process.cwd();
const ler = (caminho: string) => readFileSync(join(RAIZ, caminho), "utf8").split("\r").join("");
const MODELO = "docs/backup/modelo-repositorio-privado/.github/workflows/backup-diario.yml";
const SCRIPTS = ["scripts/backup/lib.sh", "scripts/backup/backup-db.sh", "scripts/backup/restore-db.sh", "scripts/backup/check-backup-restore.sh"];
const workflow = ler(MODELO);

/** Chaves de primeiro nível do workflow (`on`, `jobs`, ...), sem depender de um parser de YAML. */
function secaoOn(texto: string): string {
  const inicio = texto.indexOf("\non:");
  const fim = texto.indexOf("\nconcurrency:");
  expect(inicio).toBeGreaterThan(-1);
  expect(fim).toBeGreaterThan(inicio);
  return texto.slice(inicio, fim);
}

describe("12–13. o modelo só agenda o diário e o manual, e nunca roda em pull request", () => {
  it("12. gatilhos: exatamente schedule (07:30 UTC) e workflow_dispatch", () => {
    const on = secaoOn(workflow);
    const gatilhos = [...on.matchAll(/^ {2}([a-z_]+):/gm)].map((m) => m[1]);
    expect(gatilhos).toEqual(["schedule", "workflow_dispatch"]);
    expect([...on.matchAll(/- cron: "([^"]+)"/g)].map((m) => m[1])).toEqual(["30 7 * * *"]);
  });

  it("12. roda depois do lote de retenção da C3b (06:17 UTC)", () => {
    const retencao = ler("src/app/api/inngest/privacy-retention-scheduler.ts");
    expect(retencao).toContain('cron: "17 6 * * *"');
    expect(workflow).toContain('cron: "30 7 * * *"');
  });

  it("13. nenhum outro evento: nem pull_request, nem pull_request_target, nem push", () => {
    const semComentarios = workflow
      .split("\n")
      .filter((linha) => !linha.trim().startsWith("#"))
      .join("\n");
    expect(semComentarios).not.toMatch(/pull_request|pull_request_target|\bpush:|workflow_run|repository_dispatch|issue_comment/);
  });

  it("13. nunca no repositório público do Praxis e só em repositório privado", () => {
    expect(workflow).toContain("if: ${{ github.repository != 'johlll/praxis-crm' }}");
    expect(workflow).toContain(`test "$(gh api "repos/\${GITHUB_REPOSITORY}" --jq '.private')" = "true"`);
  });

  it("o modelo NÃO está em .github/workflows da raiz (não roda neste repositório) e nenhum workflow público usa os secrets do backup", () => {
    expect(MODELO.startsWith(".github/")).toBe(false);
    const dir = join(RAIZ, ".github/workflows");
    for (const nome of readdirSync(dir)) {
      const texto = ler(`.github/workflows/${nome}`);
      expect(texto, nome).not.toMatch(/BACKUP_DATABASE_URL|BACKUP_AGE_PUBLIC_KEY|secrets\.BACKUP/);
      expect(texto, nome).not.toContain("praxis-backup");
    }
  });
});

describe("modelo: concorrência 1, tempo limite, permissões mínimas e versões fixas", () => {
  it("concorrência 1 (sem cancelar a que roda) e timeout definido", () => {
    expect(workflow).toMatch(/concurrency:\n {2}group: praxis-backup\n {2}cancel-in-progress: false/);
    expect(workflow).toMatch(/timeout-minutes: \d+/);
  });

  it("nenhuma permissão de escrita: só contents: read", () => {
    expect(workflow).toMatch(/permissions:\n {2}contents: read\n/);
    expect(workflow).not.toMatch(/: write\b/);
    expect(workflow.match(/^\s*permissions:/gm)).toHaveLength(1);
  });

  it("PostgreSQL client 17 e age com versão e SHA-256 fixados, runner fixo", () => {
    expect(workflow).toContain("runs-on: ubuntu-24.04");
    expect(workflow).toContain("postgresql-client-17");
    expect(workflow).toContain('AGE_VERSION: "1.3.2"');
    expect(workflow).toContain('AGE_SHA256: "cbe24006683f8eb669266162894b9a522a1af52f2665fbc63a4bb032ed26ac10"');
    expect(workflow).toContain("sha256sum --check --status");
    // O mesmo hash e a mesma versão valem no CI deste repositório, que testa o procedimento.
    const ci = ler(".github/workflows/ci.yml");
    expect(ci).toContain("cbe24006683f8eb669266162894b9a522a1af52f2665fbc63a4bb032ed26ac10");
    expect(ci).toContain("age-v1.3.2-linux-amd64.tar.gz");
    expect(ci).toContain("postgresql-client-17");
  });

  it("só duas ações de terceiros, com versão: checkout e upload-artifact", () => {
    const usos = [...workflow.matchAll(/^\s*(?:- )?uses: (\S+)/gm)].map((m) => m[1]);
    expect(usos.sort()).toEqual(["actions/checkout@v5", "actions/upload-artifact@v4"]);
  });

  it("falha se dump, criptografia, checksum ou upload falharem (sem continue-on-error)", () => {
    expect(workflow).not.toMatch(/continue-on-error|\|\| true|if: always\(\)|if: failure\(\)/);
    expect(workflow).toContain("run: bash scripts/backup/backup-db.sh");
    expect(workflow).toContain("if-no-files-found: error");
  });

  it("os secrets entram só como variáveis de ambiente do passo do backup", () => {
    const usosDeSecret = [...workflow.matchAll(/secrets\.([A-Z_]+)/g)].map((m) => m[1]).sort();
    expect(usosDeSecret).toEqual(["BACKUP_AGE_PUBLIC_KEY", "BACKUP_DATABASE_URL"]);
    expect(workflow).not.toMatch(/AGE-SECRET|PRIVATE|identity|\.txt/);
  });
});

describe("14. só o pacote criptografado e o checksum são enviados, por 30 dias", () => {
  it("um único upload, só *.tar.gz.age e *.tar.gz.age.sha256, retenção de 30 dias", () => {
    expect(workflow.match(/upload-artifact/g)).toHaveLength(1);
    const bloco = workflow.slice(workflow.indexOf("uses: actions/upload-artifact@v4"));
    const caminhos = [...bloco.matchAll(/^\s+(backup-out\/\S+)$/gm)].map((m) => m[1]);
    expect(caminhos).toEqual(["backup-out/*.tar.gz.age", "backup-out/*.tar.gz.age.sha256"]);
    expect(bloco).toContain("retention-days: 30");
    expect(bloco).not.toMatch(/path: \.|path: backup-out\/?\s*$|\*\*|\.sql|\.json|\.tar\.gz\s*$/m);
  });

  it("o passo anterior confere que a saída tem exatamente dois arquivos e o checksum bate", () => {
    expect(workflow).toContain('test "$(ls -1 | wc -l)" -eq 2');
    expect(workflow).toContain("sha256sum --check --status ./*.tar.gz.age.sha256");
  });
});

describe("scripts: nada de xtrace, URL só por ambiente, chave pública no backup e privada só por caminho", () => {
  it("nenhum script usa set -x / xtrace nem imprime com echo/printf as variáveis secretas", () => {
    for (const arquivo of SCRIPTS) {
      const fonte = ler(arquivo);
      expect(fonte, arquivo).not.toMatch(/set\s+-[a-z]*x|xtrace|PS4=/);
      // O teste de integração grava de propósito uma senha FICTÍCIA numa ferramenta simulada para provar
      // que ela só chega por ambiente; os scripts de produção nunca imprimem URL nem senha.
      if (arquivo.endsWith("check-backup-restore.sh")) continue;
      expect(fonte, arquivo).not.toMatch(/(echo|printf)[^\n]*\$\{?(BACKUP_DATABASE_URL|RESTORE_DATABASE_URL|PGPASSWORD)/);
    }
  });

  it("backup: URL e chave pública só por variável de ambiente; nunca a chave privada; URL apagada depois de desmontada", () => {
    const fonte = ler("scripts/backup/backup-db.sh");
    expect(fonte).toContain('[ -n "${BACKUP_DATABASE_URL:-}" ] || die "backup_url_ausente" 64');
    expect(fonte).toContain("parse_database_url");
    expect(fonte).toContain("unset BACKUP_DATABASE_URL");
    expect(fonte).toContain('--recipient "$RECIPIENT"');
    expect(fonte).not.toMatch(/--identity|\s-i\s|age -d|--decrypt|AGE-SECRET/);
    expect(fonte).not.toMatch(/pg_dump[^\n]*(\$1|\$BACKUP_DATABASE_URL|--dbname|postgresql:\/\/)/);
    expect(fonte).toMatch(/\[\[ "\$BACKUP_AGE_PUBLIC_KEY" =~ \^age1/);
  });

  it("backup: limpeza em texto claro mesmo se falhar, saída só com .age e .sha256, sem mostrar a saída das ferramentas", () => {
    const fonte = ler("scripts/backup/backup-db.sh");
    expect(fonte).toContain("trap cleanup EXIT");
    expect(fonte).toContain('rm -rf "$WORK"');
    expect(fonte).toContain('rm -f "${OUT_FILES[@]}"');
    expect(fonte).toContain('rm -rf "$PKG" "$WORK/pacote.tar.gz"');
    expect(fonte.match(/2>"\$ERR"/g)!.length).toBeGreaterThanOrEqual(5);
    expect(fonte).not.toMatch(/cat "\$ERR"|<"\$ERR"|\$\(cat "\$ERR/);
    expect(fonte).toContain("--exclude-extension='*'");
  });

  it("restauração: chave privada por caminho local, hash antes de descriptografar, destino recusado, nunca o hospedado", () => {
    const fonte = ler("scripts/backup/restore-db.sh");
    expect(fonte).toContain("--identity) IDENTITY=");
    expect(fonte).toContain('[ -n "$IDENTITY" ] || die "chave_privada_ausente" 64');
    expect(fonte.indexOf('die "checksum_invalido" 65')).toBeLessThan(fonte.indexOf("age --decrypt"));
    expect(fonte.indexOf("destino_recusado:hospedado")).toBeLessThan(fonte.indexOf("age --decrypt"));
    expect(fonte).toMatch(/\*supabase\*\|\*pooler\*/);
    expect(fonte).toContain("destino_recusado:production");
    expect(fonte).toContain("destino_recusado:nao_local");
    expect(fonte).toContain("RESTORE_ALLOW_DISPOSABLE_REMOTE");
    // Sempre num banco NOVO; nunca escreve num banco existente.
    expect(fonte).toContain('create database \\"$NEWDB\\"');
    expect(fonte).toMatch(/NEWDB="praxis_restore_\$\{STAMP\}"/);
    expect(fonte).not.toMatch(/drop database[^\n]*ADMIN_DB|drop schema/);
    expect(fonte).toContain("trap cleanup EXIT");
    expect(fonte).toContain('rm -rf "$WORK"');
  });

  it("restauração: valida estrutura, linhas e FKs contra o manifesto", () => {
    const fonte = ler("scripts/backup/restore-db.sh");
    for (const codigo of ["validacao_estrutura:", "validacao_linhas", "validacao_fks_orfas", "validacao_constraints_nao_validadas", "manifesto_hash_divergente"]) {
      expect(fonte, codigo).toContain(codigo);
    }
    const validacao = ler("scripts/backup/restore-validate.sql");
    expect(validacao).toContain("not k.convalidated");
    const fks = ler("scripts/backup/restore-fks.sql");
    expect(fks).toContain("not exists (select 1 from %s p where %s)");
  });

  it("o bootstrap da restauração só mexe no banco NOVO e não carrega dado nenhum", () => {
    const sql = ler("scripts/backup/restore-bootstrap.sql");
    expect(sql).not.toMatch(/\binsert\b|\bcopy\b/i);
    expect(sql).toContain("drop schema if exists public cascade;");
  });
});

describe("15. nenhuma chave privada age no repositório", () => {
  // Montado em pedaços para o próprio teste não casar com o padrão.
  const PADRAO = new RegExp("AGE-SECRET" + "-KEY-1[0-9A-Z]{58}");

  function arquivosRastreados(): string[] {
    try {
      const saida = execFileSync("git", ["ls-files", "-z"], { cwd: RAIZ, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
      return saida.split("\0").filter(Boolean);
    } catch {
      const achados: string[] = [];
      const varrer = (dir: string) => {
        for (const entrada of readdirSync(join(RAIZ, dir), { withFileTypes: true })) {
          if ([".git", "node_modules", ".next", "playwright-report", "test-results"].includes(entrada.name)) continue;
          const rel = dir ? `${dir}/${entrada.name}` : entrada.name;
          if (entrada.isDirectory()) varrer(rel);
          else achados.push(rel);
        }
      };
      varrer("");
      return achados;
    }
  }

  it("nenhum arquivo rastreado contém uma chave privada age (nem o teste de integração)", () => {
    const suspeitos: string[] = [];
    for (const arquivo of arquivosRastreados()) {
      const completo = join(RAIZ, arquivo);
      if (!existsSync(completo) || !statSync(completo).isFile() || statSync(completo).size > 2_000_000) continue;
      if (/\.(png|jpe?g|webp|gif|ico|pdf|woff2?|ttf|otf|zip|gz)$/i.test(arquivo)) continue;
      if (PADRAO.test(readFileSync(completo, "latin1"))) suspeitos.push(arquivo);
    }
    expect(suspeitos).toEqual([]);
  });

  it("o repositório não rastreia arquivos de chave nem de backup (.age, id.txt, *.sql de dump)", () => {
    const proibidos = arquivosRastreados().filter((arquivo) => /(^|\/)(id|key|keys|identity)\.txt$|\.age$|\/backup-out\/|(^|\/)praxis-crm-backup-/.test(arquivo));
    expect(proibidos).toEqual([]);
  });

  it(".gitignore impede commitar a saída do backup e chaves", () => {
    const ignore = ler(".gitignore");
    expect(ignore).toContain("backup-out/");
    expect(ignore).toMatch(/\*\.age\b/);
  });

  it("o scanner enxerga uma chave (prova de que o teste não é vácuo)", () => {
    const falsa = "AGE-SECRET" + "-KEY-1" + "Q".repeat(58);
    expect(PADRAO.test(`x ${falsa} y`)).toBe(true);
    expect(PADRAO.test("AGE-SECRET" + "-KEY-1" + "Q".repeat(10))).toBe(false);
  });
});
