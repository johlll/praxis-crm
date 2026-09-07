# A2 — Handoff: autenticação, workspace e equipe

**Projeto:** Praxis CRM Jurídico
**Fase:** A2
**Branch:** `feat/a2-auth-workspace`
**Data:** 07/09/2026
**Status:** implementada por completo — schema, RLS, funções, autenticação,
telas, testes (unitários + pgTAP + e2e) e CI. **Não mesclada em `main`.**
Uma peça depende de credencial que só o usuário tem — ver seção 5.

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
- **60 asserções pgTAP** em 4 arquivos (`supabase/tests/database/`) —
  escritas e com `plan()` conferido por script contra a contagem real de
  asserções, mas **nunca executadas** nesta máquina (sem Docker). Rodam de
  verdade no CI.
- **8 testes e2e** (Playwright, `tests/e2e/auth-workspace.spec.ts`) — a
  jornada completa das 7 etapas pedidas. Sintaticamente válidos
  (`npx playwright test --list` lista os 8 corretamente), mas também nunca
  executados aqui — precisam do Supabase local que só o CI sobe.

### 2.8 CI

`.github/workflows/ci.yml` reescrito: `npm ci` → typecheck → lint → testes
unitários → `supabase start` → `supabase db reset --local` (migrations do
zero) → gera tipos e compara com o commitado → pgTAP → build (com as
credenciais do Supabase local) → Playwright → `supabase stop`. Não depende
do projeto hospedado nem de produção.

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

### `src/server/types/database.ts` é provisório

Escrito à mão (comentário no topo do arquivo explica isso), porque gerar
de verdade exige `--linked` (credencial acima) ou `--local` (Docker, que
esta máquina não tem). O CI regenera via `--local` e compara
(`npm run db:types:check`) — é bem possível que a primeira rodada do CI
acuse divergência de formatação entre o que escrevi à mão e o que o
gerador real produz (ordem de propriedade, forma exata do tipo `Json`
etc.), mesmo sendo semanticamente equivalente. Se isso acontecer, é o
comportamento **correto e esperado** do check — não um defeito do CI. Basta
rodar `npm run db:types:local` (com `supabase start` já de pé) e commitar o
resultado real.

---

## 6. Verificação feita nesta máquina

Não há Supabase real (local nem hospedado) aqui, então nada que dependa de
banco foi executado de ponta a ponta. O que **foi** verificado:

| Comando | Resultado |
|---|---|
| `npm run typecheck` | sem erros |
| `npm run lint` | sem erros nem avisos |
| `npm test` | 3 arquivos, **87 testes**, todos passando |
| `npm run build` | **com credenciais placeholder** (não commitadas, só para provar que a estrutura de build está correta) — 18 rotas, todas dinâmicas exceto `/` e `/icon.svg`, `ƒ Proxy (Middleware)` confirmando que `proxy.ts` está ativo |
| `npx playwright test --list` | 8 testes listados corretamente nos 7 passos pedidos |
| Contagem de `plan()` vs. asserções reais nos 4 arquivos pgTAP | as quatro batem |

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

---

## 7. Riscos e decisões pendentes

1. **`database.ts` provisório** — seção 5. Risco baixo (semanticamente
   correto, só formatação pode divergir), corrigido automaticamente no
   primeiro `npm run db:types:local` real.
2. **pgTAP e e2e nunca rodaram** — escritos com cuidado, revisados
   manualmente (inclusive um bug real encontrado assim — item 5 da seção
   3), mas a garantia final é o CI, não esta conversa.
3. **`--override-name api.anon_key=...` no CI** (passo de exportar as
   credenciais do Supabase local para o build/e2e) foi montado a partir do
   único exemplo que a própria CLI documenta no `--help`
   (`api.url=NEXT_PUBLIC_SUPABASE_URL`); o nome exato da chave
   (`api.anon_key`) foi inferido pelo padrão, não confirmado rodando —
   Docker não existe aqui para testar. Se o CI mostrar um nome diferente,
   é um ajuste de uma linha no workflow, não um problema estrutural.
4. **Nenhuma tela de "reset de senha"** — não estava no escopo pedido
   (login por e-mail/senha, cadastro, confirmação de e-mail); ficaria natural
   como extensão pequena de `/entrar`, mas eu não implementei sem que fosse
   pedido.
5. **`workspaces.rename`** tem policy de UPDATE pronta e testada, mas
   **nenhuma tela usa ela nesta fase** — não fazia parte do escopo pedido
   para a A2, ficou só a policy (documentada em `docs/arquitetura.md`) para
   quando a tela de configurações do workspace existir.

---

## 8. Confirmações explícitas

- **Nenhuma fase além da A2 foi iniciada.** Sem leads, contatos, pipeline,
  atividades, WhatsApp ou dashboard.
- **Nenhum arquivo de referência visual foi alterado** — confirmado com
  `find` na pasta `Desktop/Henrique/Protótipo CRM`: nenhuma modificação.
- **Sem merge em `main`.** Tudo na branch `feat/a2-auth-workspace`.
- **Revisão de segredo no stage feita antes de cada commit** — nenhum
  `.env`, chave ou token no repositório; `.env.example` só com nomes.
