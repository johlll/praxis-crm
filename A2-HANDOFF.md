# A2 — Handoff: autenticação, workspace e equipe

**Projeto:** Praxis CRM Jurídico
**Fase:** A2
**Branch:** `feat/a2-auth-workspace`
**PR:** https://github.com/johlll/praxis-crm/pull/1 (aberto, **não mesclado**)
**Preview:** https://praxis-crm-git-feat-a2-auth-workspace-johllls-projects.vercel.app
**Data:** 07/09/2026
**Status:** implementada por completo e **CI totalmente verde** — typecheck,
lint, 87 testes unitários, migrations do zero, tipos gerados batendo com o
commitado, 62 asserções pgTAP, isolamento entre workspaces, build e os
**8 testes e2e passando pela primeira vez**, todos no mesmo run
(`34160097967`). Uma peça continua dependendo de credencial que só o
usuário tem — ver seção 5.

O caminho até aqui não foi direto: depois da primeira vez que o pgTAP
ficou verde (seção 3, itens 8–11), o e2e revelou mais **9 bugs reais**
distintos, um de cada vez, ao longo de **13 rodadas de CI** — cada rodada
isolando exatamente uma causa (nunca uma correção "no escuro"). Lista
completa nos itens 12–20 da seção 3. Nenhum desses bugs era visível por
leitura de código; todos só apareceram rodando de verdade contra Postgres
e GoTrue reais no runner do GitHub.

---

## 1. Decisão de infraestrutura (mudança de rumo no meio da fase)

A primeira tentativa desta fase parou na preparação porque faltavam Docker
local e um projeto Supabase vinculado — registrado em
`docs/decisoes/versoes.md`. O usuário então decidiu explicitamente:

> Docker local não será requisito para a A2. Desenvolvimento usa um projeto
> Supabase hospedado exclusivo de dev (`praxis-crm-dev`). O CI sobe
> Supabase local via Docker (o runner do GitHub tem) e reproduz o banco do
> zero ali.

Esta versão do handoff é a implementação completa sob essa decisão.

---

## 2. O que foi implementado

### 2.1 Banco de dados

4 migrations em `supabase/migrations/` (detalhe em `docs/arquitetura.md`):
schema `private` (funções auxiliares de RLS, nunca exposto pela Data API),
5 tabelas (`workspaces`, `users`, `memberships`, `workspace_invitations`,
`audit_logs`) com RLS habilitada **e forçada**, policy explícita e separada
por operação (SELECT/INSERT/UPDATE/DELETE) em cada uma, e 7 funções de
negócio `SECURITY DEFINER` expostas via RPC.

`supabase/seed.sql`: 2 workspaces, 4 usuários fictícios (`@praxis.test`,
senha `praxis-seed-nao-e-senha-real`), 4 convites cobrindo os 4 estados
pedidos (pendente, expirado, cancelado, aceito).

### 2.2 Autenticação e sessão

`@supabase/ssr` — cliente de navegador, cliente de servidor, `src/proxy.ts`
(renova sessão, protege rota, aplica CSP). `/entrar` (login + cadastro na
mesma tela), `/auth/confirm` (callback de confirmação de e-mail),
`/onboarding` (criar o primeiro workspace), logout.

### 2.3 Workspace ativo

Cookie assinado HMAC-SHA256, `httpOnly`, `secure` em produção,
`sameSite=lax`. Toda leitura revalida contra o banco — a assinatura só
impede adulteração, nunca substitui a checagem de membership real.

### 2.4 Equipe e convites

`/configuracoes/equipe`: lista de membros, troca de papel, remoção
(protegendo o último owner), convites pendentes com cancelamento. Convite
gera link para copiar — sem Resend, sem infraestrutura de e-mail, como
pedido. Token: 256 bits de entropia, só o hash SHA-256 vai para o banco.

### 2.5 Matriz de permissões

`src/lib/roles.ts` (client-safe) + `src/server/authz/permissions.ts`
(`requireUser`, `requireWorkspace`, `requireMembership`,
`requirePermission`). Ver `docs/arquitetura.md` para por que estão em dois
arquivos.

### 2.6 Interface

Shell da A1.1 preservado integralmente. Sidebar com seletor de workspace
real (substituiu "Rocha & Antunes"); Topbar com usuário real (substituiu
"Camila Rezende"/"CR"/"Advogada sênior"). Componentes shadcn — ver seção 4.

### 2.7 Testes

- **87 testes unitários** (Vitest) — todos passando, incluindo os 86 da
  A1/A1.1 e o novo teste da sidebar com workspace real.
- **62 asserções pgTAP** em 4 arquivos (`supabase/tests/database/`) —
  rodaram de verdade no CI (não só localmente, que não tem Docker) e
  pegaram **4 bugs reais** antes deste PR ficar verde — ver seção 3.
- **8 testes e2e** (Playwright, `tests/e2e/auth-workspace.spec.ts`) — a
  jornada completa das 7 etapas pedidas: login, senha errada, onboarding
  sem membership, convite, aceite pelo segundo usuário, troca de
  workspace, cookie adulterado, logout. **Passando de verdade no CI**
  (run `34160097967`) — nunca executados nesta máquina, que não tem
  Docker. `retries: 0` (mesmo no CI, ver seção 3 item 17).

### 2.8 CI

`.github/workflows/ci.yml`: `npm ci` → typecheck → lint → testes unitários
→ `supabase start` → `supabase db reset --local` (migrations do zero) →
gera tipos e compara com o commitado → pgTAP → teste de isolamento →
escreve `.env.local` de verdade com as credenciais do Supabase local (ver
item 15 da seção 7 sobre por que é um arquivo, não variável de ambiente
herdada) → build → instala navegadores do Playwright → e2e → para o
Supabase local. Não depende do projeto hospedado nem de produção. Webserver
do Playwright roda com `stdout`/`stderr` em `"pipe"` — qualquer log do
Next.js (inclusive erro de Server Action) aparece no próprio job do CI,
sem precisar baixar artefato separado.

---

## 3. O que foi encontrado e corrigido durante a implementação

Registro do que não saiu certo de primeira — porque a maior parte só
apareceu ao tentar validar de verdade, não ao só escrever o código:

1. **`pg_trigger_depth()` invertido.** A trigger que protege o e-mail em
   `public.users` contra alteração direta pelo cliente usava
   `pg_trigger_depth() = 0` — mas dentro da própria trigger a profundidade
   nunca é zero (ela mesma já é um nível). Corrigido para `= 1`
   (disparada como gatilho único, ou seja, por um UPDATE de topo).
   Encontrado relendo a lógica com calma, não por teste — reforça por que
   `04_security_hardening.test.sql` existe.
2. **Corrupção de `$$` ao editar SQL via `node -e` no Bash.** Duas
   funções da primeira migration perderam um `$` cada (`as $$` virou
   `as $`), quebrando o dollar-quoting. Descoberto relendo o arquivo
   depois da edição. Corrigido trocando para a tag `$body$` e, dali em
   diante, escrevendo SQL só com as ferramentas de arquivo diretas, nunca
   mais via shell.
3. **`member-row.tsx` (Client Component) quebrava o build.** Importava
   `ROLE_LABEL`/`Role` de `src/server/authz/permissions.ts`, que também
   exporta funções dependentes de `next/headers` — o Next recusa isso
   corretamente (erro real, não falso positivo). Corrigido extraindo os
   tipos e a matriz para `src/lib/roles.ts`, sem nenhuma dependência de
   servidor, e atualizando todos os Client Components para importar dali.
4. **`middleware.ts` descontinuado no Next 16.3.4.** O próprio
   `next build` avisa. Migrado para `src/proxy.ts` (mesmo mecanismo,
   `config.matcher` idêntico — só o nome mudou). Confirmado no código-fonte
   do Next instalado, não só no aviso.
5. **`acceptInvitationAction` não ativava o workspace recém-aceito.**
   Encontrado ao escrever o teste e2e #4: depois de aceitar, o usuário
   ainda não tinha cookie de workspace ativo, então caía em `/onboarding`
   mesmo já sendo membro de verdade. Corrigido chamando
   `switchActiveWorkspace()` com o `workspace_id` que a própria função RPC
   devolve, antes do redirect.
6. **`shadcn init` interativo demais para automatizar com segurança.** A
   CLI (v4.21.0) só oferece presets com tema próprio (Nova, Vega, Maia...)
   por um menu interativo — sem uma opção não-interativa de "sem tema".
   Rodar `--yes` com um preset arriscava misturar cores do shadcn com as
   nossas. Abandonado o `init` automatizado; `components.json` escrito à
   mão e os 7 componentes (Button, Input, Label, Dialog, DropdownMenu,
   Alert, e um `FormField` próprio no lugar do `Form` — que dependeria de
   `react-hook-form`, fora da lista de dependências autorizadas)
   implementados usando os mesmos primitivos Radix que o shadcn usaria,
   estilizados só com os tokens de `src/design/tokens.ts`. Confirmado
   visualmente (captura de tela) que nada do tema padrão do shadcn vazou.
7. **Admin conseguia conceder o papel de owner.** Numa revisão específica
   das funções de negócio (não um teste falhando — uma releitura
   deliberada pensando "o que um admin mal-intencionado conseguiria
   fazer"), notei que nem `create_workspace_invitation` nem
   `update_membership_role` restringiam QUEM pode conceder/promover a
   *owner* — um admin (não owner) podia convidar ou promover alguém a
   owner, e a partir daí coordenar para rebaixar os owners originais.
   Corrigido: as duas funções agora exigem que quem concede o papel de
   owner já seja owner. Adicionadas 3 asserções pgTAP para isso (2 em
   `02_invitations.test.sql`, 1 em `03_last_owner.test.sql`) — nenhuma
   delas foi pedida explicitamente pelo prompt, vieram da revisão de
   segurança da seção 11.

**Itens 8–11 encontrados pelo CI de verdade, não por leitura** — o PR
passou por 4 runs até ficar verde no pgTAP; cada um pegou algo real:

8. **`created_by` de `workspaces` impedia o próprio seed de rodar.** A
   trigger `private.set_created_by_to_current_user()` sobrescrevia
   `created_by` incondicionalmente com `auth.uid()` — dentro do seed
   (rodando como `postgres`, sem sessão), `auth.uid()` é `null`, e a
   trigger zerava o valor explícito que `supabase/seed.sql` define para os
   workspaces fictícios, batendo no `NOT NULL`. Erro real do primeiro run
   verde de migrations: `null value in column "created_by" ... violates
   not-null constraint (SQLSTATE 23502)`. Corrigido: só sobrescreve quando
   existe sessão real — um cliente autenticado continua sem conseguir
   spoofar `created_by`.
9. **`database.ts` provisório divergia do gerador real — como esperado,
   mas eu não tinha como reconstruir o arquivo certo só do diff.** O
   `db:types:check` acusou a divergência (comportamento correto do
   check); adicionei impressão do arquivo completo no log do CI quando
   diverge, extraí o conteúdo real de lá e substitui o stub inteiro —
   `diff` confirma agora que é byte a byte igual ao que o CI gera.
10. **Embed ambíguo descoberto pelos tipos reais.** Com o `database.ts`
    de verdade, `memberships` passou a ter DUAS foreign keys para `users`
    (`user_id` e `invited_by`) explícitas no tipo — o embed
    `user:users(...)` em `team/queries.ts` que compilava contra o stub
    manual (que só listava uma FK) parou de compilar contra o tipo real.
    Corrigido com o hint `users!memberships_user_id_fkey(...)` que o
    PostgREST exige quando há mais de um caminho de relacionamento
    possível.
11. **Dois bugs nos meus próprios testes pgTAP, achados só ao rodar de
    verdade:**
    - Uma policy `using (false)` de UPDATE/DELETE **não lança exceção**
      (diferente de `with check (false)` no INSERT) — ela só faz o
      comando não enxergar linha nenhuma, afetando zero linhas
      silenciosamente. Meus testes esperavam `throws_ok` com SQLSTATE
      `42501`; corrigidos para `lives_ok` + conferir que a linha
      realmente não mudou.
    - `accept_workspace_invitation` tentava gravar `status = 'expired'`
      antes de levantar a exceção de convite expirado — mas um `RAISE
      EXCEPTION` desfaz tudo que a própria chamada de função fez até ali
      (Postgres não tem sub-transação implícita dentro de uma função),
      então a gravação nunca sobrevivia. Removida a tentativa (o teste
      esperava `status='expired'`; corrigido para esperar `'pending'`,
      que é o que realmente acontece — "expirado" passa a ser um estado
      derivado na leitura, como `preview_workspace_invitation()` já
      fazia).
    - Bônus: minha suposição de como o Postgres serializa
      `SET search_path = ''` em `pg_proc.proconfig` estava errada — a
      comparação exata `cfg = 'search_path='` não batia com nada (0 de
      12 funções "passavam", inclusive as que realmente têm a diretiva).
      Trocado para `cfg LIKE 'search_path=%'`, que verifica a mesma
      propriedade de segurança (search_path pinado, não deixado no
      padrão do chamador) sem depender de eu adivinhar o formato exato
      de serialização interna do Postgres.

**Itens 12–20 — a maratona do e2e, 13 rodadas de CI até os 8 testes
passarem juntos.** Depois do pgTAP ficar verde, o e2e começou a rodar de
verdade pela primeira vez e, como `test.describe.serial` para no primeiro
teste que falha, cada rodada só revelava o **próximo** bug na fila — nunca
todos de uma vez:

12. **Seed sem `auth.identities` — mas não era esse o problema de
    verdade.** O login por senha voltava `HTTP 500` com
    `"Database error querying schema"` (mensagem genérica do GoTrue, que
    não expõe o erro interno por segurança). Hipótese razoável mas errada:
    faltava a linha de identidade do provider "email" — adicionei uma por
    usuário. Não resolveu (mesmo erro, idêntico, no run seguinte) — a causa
    real era outra (item 13). A linha de `auth.identities` ficou (é
    tecnicamente correta e inofensiva), mas não foi ela que consertou nada.
13. **Causa real do item 12: colunas de token `NULL` em `auth.users`.**
    Só descoberta puxando o log do próprio container `auth` no CI (a
    resposta HTTP não mostra isso) — erro exato:
    `sql: Scan error on column index 8, name "email_change": converting
    NULL to string is unsupported`. O INSERT do seed preenchia
    `confirmation_token`/`recovery_token` com `''` mas deixava
    `email_change`, `email_change_token_new`,
    `email_change_token_current`, `phone_change`, `phone_change_token` e
    `reauthentication_token` sem valor (logo `NULL`) — o driver Go do
    GoTrue não aceita `NULL` nesses campos ao montar o usuário para login.
    Corrigido preenchendo todos com `''`.
14. **`signInAction` nunca ativava nenhum workspace.** Com o login
    funcionando de verdade, quem já tinha membership (a dona do seed) caía
    em `/onboarding` só por falta de cookie de workspace ativo — mesmo
    sendo dona de um workspace de verdade. Corrigido: se não há workspace
    ativo após o login, ativa o primeiro da lista de memberships reais do
    próprio usuário (nunca um id vindo do cliente).
15. **`getActiveWorkspaceId`, `switchActiveWorkspace` e
    `listMyWorkspaces` sem filtro por `user_id` — bug de produção real,
    não só de teste.** A policy de SELECT de `memberships` é por
    workspace (qualquer membro vê os colegas — necessário para a tela de
    equipe), não por dono da linha. As três funções assumiam,
    incorretamente, que a RLS já restringia à membership do próprio
    usuário, e usavam `.maybeSingle()` sem esse filtro — assim que um
    workspace tem 2+ membros (o caso normal, não uma peculiaridade do
    seed), a consulta bate mais de uma linha e `.maybeSingle()` falha,
    reportando "não é membro" mesmo para quem é dono de verdade. Isso
    teria quebrado em produção assim que qualquer escritório tivesse mais
    de uma pessoa. Corrigidas as três, filtrando também por `user_id`
    (obtido via `supabase.auth.getUser()`, nunca do cliente). Detalhe
    arquitetural em `docs/arquitetura.md`.
16. **Regex quebrada no helper de teste `switchWorkspace()`.**
    `new RegExp(workspaceName)` — mas nomes de workspace têm parênteses
    literais (`"Escritório Um (seed)"`), que em regex viram grupo de
    captura, não texto. O padrão nunca batia com o texto real do
    menuitem. Corrigido para usar a string direta (substring), como o
    resto do arquivo já fazia.
17. **Retry do Playwright mascarando a causa real de uma falha.** O teste
    "usuário sem membership" cria um workspace de verdade no banco — com
    `retries: 1`, uma retentativa após falha reexecutava o login sobre um
    usuário que a tentativa anterior **já tinha dado** um workspace,
    trocando o sintoma real por um completamente diferente e enganoso
    ("já não vai mais pro onboarding"). `test.describe.serial` com efeito
    colateral real no banco e sem reset entre tentativas é incompatível
    com retry — mudado para `retries: 0` permanentemente (não só durante a
    depuração): é melhor ver a falha real uma vez do que uma falha
    mascarada duas vezes.
18. **Faltava `revalidatePath` na troca de workspace.** Quem troca de
    workspace normalmente já está em `/visao-geral`; `redirect()` para o
    mesmo caminho, sozinho, não força o `(app)/layout.tsx` a reler o
    cookie recém-gravado. Adicionado `revalidatePath("/", "layout")` antes
    do redirect — padrão documentado do Next.js para mutation + redirect à
    mesma rota.
19. **`z.string().uuid()` do Zod rejeitando os ids fictícios do seed.**
    O validador exige os bits de versão/variante do RFC 4122 — mas os ids
    do seed (`10000000-0000-0000-0000-000000000001`, escolhidos de
    propósito para serem legíveis) não têm esses bits, e eram rejeitados
    como "Invalid UUID" antes mesmo de a troca de workspace ser tentada de
    verdade (o log de debug mostrou o parse falhando silenciosamente).
    Criado `src/lib/uuid.ts` com um schema mais solto (só o formato
    hex-com-traços, sem exigir versão/variante) e trocados os 4 call sites
    que usavam `.uuid()` estrito — um uuid real de `gen_random_uuid()`
    continua batendo normalmente, não há perda de validação de verdade.
20. **Logout via `<form>` dentro de `DropdownMenuItem` — corrida com o
    Radix.** O item "Sair" era um `<form action={signOutAction}>` dentro
    de um `DropdownMenuItem asChild`. O Radix fecha (desmonta) o menu ao
    selecionar o item — inclusive o próprio form — correndo contra a
    submissão nativa, que às vezes nem chegava a completar antes do form
    sumir do DOM: o clique "funcionava" na interface (o menu fechava) mas
    o logout nunca era efetivado de verdade. Corrigido com `SignOutItem`
    (Client Component novo), que chama `signOutAction()` direto por
    `onSelect` dentro de `startTransition` — mesmo padrão já usado (e já
    validado) na troca de workspace do sidebar. Efeito colateral bom: o
    elemento passou a ter o papel ARIA correto (`menuitem`, o mesmo dos
    itens de workspace) em vez de `button` — só existia como `button`
    porque o `<form><button>` antigo forçava isso.

---

## 4. Dependências instaladas (só as da lista autorizada + o que elas exigem)

| Pacote | Versão | Motivo |
|---|---|---|
| `@supabase/supabase-js` | 2.115.0 | |
| `@supabase/ssr` | 0.12.6 | peer de supabase-js `^2.114.0`, satisfeito |
| `zod` | 4.5.4 | |
| `supabase` (CLI) | 2.116.0 | devDependency |
| `@playwright/test` | 1.63.0 | exigido pelo e2e de autenticação |
| `@radix-ui/react-dialog` | 1.1.23 | primitivo do componente Dialog |
| `@radix-ui/react-dropdown-menu` | 2.1.24 | primitivo do DropdownMenu |
| `@radix-ui/react-label` | 2.1.15 | primitivo do Label |
| `@radix-ui/react-slot` | 1.3.3 | usado por Button (`asChild`) e Label |

`@supabase/auth-helpers-nextjs` **não** foi instalado — confirmado
descontinuado (`npm view` devolve "Package no longer supported") antes de
descartá-lo, não por suposição. Detalhe completo em
`docs/decisoes/versoes.md`.

---

## 5. O que ainda depende de credencial

As seções 2 e 3 do prompt original da A2 pedem, além de escrever o código:
login na CLI, vincular **só** `praxis-crm-dev`, `db push --dry-run`,
revisão, aplicar no projeto de dev, `gen types --linked`, e rodar os testes
de autenticação/isolamento **contra o projeto de desenvolvimento**. Nada
disso foi feito nesta máquina — precisa de um destes dois, que só o
usuário pode fornecer:

- Um **token de acesso pessoal do Supabase**
  (https://supabase.com/dashboard/account/tokens), para eu rodar
  `supabase login --token <token>` e `supabase link --project-ref <ref>`
  sozinho, ou
- O usuário rodar `supabase login` + `supabase link --project-ref <ref>`
  localmente e me passar a URL/Publishable Key do `praxis-crm-dev`.

Com qualquer um dos dois, o restante das seções 1–3 do prompt (dry-run,
aplicar migration no projeto de dev, gerar tipos `--linked`) é rápido —
todo o trabalho de escrever e validar estruturalmente já está feito.

### `src/server/types/database.ts` já é o arquivo real gerado

Começou escrito à mão (não havia Docker nesta máquina para gerar de
verdade) e, como esperado, o `db:types:check` do CI acusou divergência no
primeiro run. Em vez de adivinhar o diff, o `check-db-types.sh` passou a
imprimir o arquivo completo no log quando diverge; extraí o conteúdo real
de lá e substituí o stub inteiro — confirmado **byte a byte igual**
(`diff`) ao que `supabase gen types typescript --local` gera. `db:types:check`
está verde desde então. Ainda depende do `--linked` contra `praxis-crm-dev`
(seção acima) só para o dia em que o schema do projeto hospedado divergir
do que as migrations locais descrevem — não deveria acontecer se as
migrations forem sempre a fonte de verdade aplicada nos dois lugares.

---

## 6. Verificação

Nesta máquina (sem Docker, sem projeto hospedado):

| Comando | Resultado |
|---|---|
| `npm run typecheck` | sem erros |
| `npm run lint` | sem erros nem avisos |
| `npm test` | 3 arquivos, **87 testes**, todos passando |
| `npm run build` | **com credenciais placeholder** (não commitadas, só para provar que a estrutura de build está correta) — 18 rotas, todas dinâmicas exceto `/` e `/icon.svg`, `ƒ Proxy (Middleware)` confirmando que `proxy.ts` está ativo |
| `npx playwright test --list` | 8 testes listados corretamente nos 7 passos pedidos |

**CSP verificada de fato, não só lida no código:** com o servidor rodando
(credenciais placeholder), `curl -D-` confirmou o cabeçalho
`Content-Security-Policy` com nonce; abri a página `/entrar` no Chromium
via `playwright-cli`, zero erros e zero avisos no console, e conferi no
HTML servido que **todo** `<script>` da página carrega o `nonce`
correspondente ao da CSP — nenhum script sem nonce. Também confirmei que
`/onboarding` sem sessão redireciona para `/entrar?next=/onboarding`
(proteção de rota funcionando).

As credenciais placeholder usadas nessa verificação nunca foram commitadas
— ficaram só em `.env.local` (gitignorado) pelo tempo do teste e foram
removidas logo em seguida; `git status`/`git diff` confirmam que
`.env.local` não está no stage.

**No CI (Docker real, Postgres real, GoTrue real) — a validação que
importa:** o PR levou 4 runs até ficar verde no pgTAP (itens 8–11 da seção
3) e mais 13 até os 8 testes e2e passarem juntos pela primeira vez (itens
12–20). Cada run anterior pegou exatamente um bug real — um `NOT NULL` que
o seed disparava, o `database.ts` provisório de fato divergindo do gerador
real, um embed ambíguo, dois bugs nos próprios testes pgTAP, colunas
`NULL` em `auth.users` que o GoTrue rejeitava, workspace não ativado no
login, três consultas de `memberships` sem filtro por `user_id` (bug de
produção real, não só de teste), uma regex quebrada no teste, retry
mascarando falha real, `revalidatePath` faltando, validação de UUID
estrita demais para os ids do seed, e uma corrida entre `<form>` e o
fechamento do menu do Radix no logout. **Resultado final, no mesmo run**
(`34160097967`): typecheck, lint, 87 testes unitários, migrations do zero,
tipos batendo, 62 asserções pgTAP, isolamento entre workspaces, build e
**8/8 testes e2e** — tudo verde ao mesmo tempo. Isso é o processo
funcionando como desenhado: o ponto de ter o CI validando de verdade era
justamente não confiar só na minha leitura do SQL/TypeScript, e cada um
desses 20 bugs só apareceu rodando contra serviços reais.

---

## 7. Riscos e decisões pendentes

1. ~~Credenciais do Supabase local não chegavam no `next start` do
   e2e~~ — **duas rodadas de correção, a segunda mudando de estratégia.**
   Primeiro: `--override-name api.anon_key=...` não existe de verdade — o
   nome real é `PUBLISHABLE_KEY` (confirmado no log: o Build tinha
   `NEXT_PUBLIC_SUPABASE_URL` certo, mas só `PUBLISHABLE_KEY`, não
   `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`). Corrigido capturando o nome
   padrão via `eval` e reexportando com `$GITHUB_ENV`. Isso resolveu a
   chave, mas o run seguinte voltou a reclamar — desta vez de
   `NEXT_PUBLIC_SUPABASE_URL`, que **estava confirmadamente presente** no
   ambiente do próprio step (visto no log). O webServer que o Playwright
   sobe roda `next start` dentro de mais uma camada de subprocesso
   (`playwright test` → `npm run start` → `next start`), e alguma dessas
   camadas não repassava a variável de forma confiável. Troquei de
   estratégia: em vez de depender de `$GITHUB_ENV`/herança de ambiente
   entre processos, o step agora escreve um `.env.local` de verdade no
   checkout — Next.js lê esse arquivo direto tanto em build quanto em
   start, sem depender de quantos processos filhos o valor atravessou.
   Também troquei os nomes de variável "adivinhados" por uma falha
   explícita (`${API_URL:?...}`) caso a CLI mude de novo, em vez de
   escrever um `.env.local` com valor vazio e falhar de forma confusa só
   60 segundos depois.
2. **Nenhuma tela de "reset de senha"** — não estava no escopo pedido
   (login por e-mail/senha, cadastro, confirmação de e-mail); ficaria natural
   como extensão pequena de `/entrar`, mas eu não implementei sem que fosse
   pedido.
3. **`workspaces.rename`** tem policy de UPDATE pronta e testada, mas
   **nenhuma tela usa ela nesta fase** — não fazia parte do escopo pedido
   para a A2, ficou só a policy (documentada em `docs/arquitetura.md`) para
   quando a tela de configurações do workspace existir.
4. **`playwright.config.ts` usa `retries: 0` mesmo no CI, de propósito
   permanente** (item 17 da seção 3) — `test.describe.serial` com efeito
   colateral real no banco (workspace criado, convite criado) não é seguro
   sob retry: uma retentativa reexecuta sobre estado que a tentativa
   anterior já alterou, trocando a falha real por um sintoma diferente e
   enganoso. Se o e2e ficar instável por motivo genuinamente externo (rede,
   timing do runner), a correção certa é investigar a instabilidade, não
   religar retry.

---

## 8. Confirmações explícitas

- **Nenhuma fase além da A2 foi iniciada.** Sem leads, contatos, pipeline,
  atividades, WhatsApp ou dashboard.
- **Nenhum arquivo de referência visual foi alterado** — confirmado com
  `find` na pasta `Desktop/Henrique/Protótipo CRM`: nenhuma modificação.
- **Sem merge em `main`.** Tudo na branch `feat/a2-auth-workspace`.
- **Revisão de segredo no stage feita antes de cada commit** — nenhum
  `.env`, chave ou token no repositório; `.env.example` só com nomes.
