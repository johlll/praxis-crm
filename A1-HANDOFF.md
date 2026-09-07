# A1 — Handoff para auditoria

**Projeto:** Praxis CRM Jurídico (nome provisório)
**Fase:** A1 — Fundação técnica e design system
**Data:** 07/09/2026
**Plano de referência:** `~/.claude/plans/esse-ser-um-prot-tipo-fancy-lynx.md`
(revisão 2 + 4 emendas)

Esta fase entrega o esqueleto visual e a infraestrutura de qualidade. **Não há
banco, autenticação nem dado algum** — isso é A2, que ainda não foi iniciada.

---

## 1. Escopo entregue

| Item do plano (A1) | Situação |
|---|---|
| Projeto Next.js + TypeScript strict + Tailwind | entregue |
| shadcn/ui | **não instalado** — ver §5 |
| Tokens do design system | entregue, com teste anti-deriva |
| `AppShell`, `Sidebar`, `Topbar` | entregue, conferidos contra a referência |
| `EmptyState`, `LoadingState`, `ErrorState` | entregue |
| CI (typecheck, lint, testes, build) | entregue |
| Geração de tipos no CI | **não se aplica em A1** — depende do Supabase (A2) |
| Deploy de preview protegido | **não feito** — Vercel não conectada, por decisão |

Além do previsto, foram antecipados dois controles de segurança que o plano
exige "em toda fase" e que ficariam frágeis se criados depois:

- cabeçalhos de segurança em `next.config.ts` (`X-Frame-Options`,
  `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`, HSTS);
- regra de lint que **barra a importação do cliente `service_role`** fora de
  `src/app/api/webhooks/**`, `src/app/api/cron/**` e do próprio módulo. A
  barreira existe antes do arquivo que ela protege, para que o caminho nunca
  chegue a existir sem ela.

A CSP ficou deliberadamente de fora: só faz sentido escrevê-la quando
soubermos quais origens externas o app usa de fato (Supabase em A2).

---

## 2. Estrutura

```
praxis-crm/
├── .github/workflows/ci.yml
├── docs/decisoes/versoes.md
├── src/
│   ├── app/
│   │   ├── layout.tsx            fontes (Public Sans, Instrument Serif, IBM Plex Mono)
│   │   ├── globals.css           tokens como CSS variables + reset
│   │   ├── icon.svg              favicon
│   │   ├── page.tsx              redireciona para /visao-geral
│   │   └── (app)/                shell + as 10 rotas do menu
│   ├── components/
│   │   ├── app-shell/            AppShell, Sidebar, Topbar, GlobalSearch, PagePlaceholder
│   │   └── feedback/             EmptyState, LoadingState, ErrorState
│   ├── design/tokens.ts          fonte de verdade dos tokens em TypeScript
│   └── lib/cn.ts
└── tests/
    ├── setup.ts
    └── unit/                     tokens.test.ts, navigation.test.tsx
```

Rotas geradas (14 estáticas): `/`, `/visao-geral`, `/leads`, `/pipeline`,
`/atividades`, `/agenda`, `/conversas`, `/clientes`, `/automacoes`,
`/relatorios`, `/configuracoes`, `/_not-found`.

Cada rota ainda não construída exibe um `PagePlaceholder` que diz **em qual
fase ela será feita**. Nenhum dado fictício é exibido como se fosse real —
requisito da correção 16 do plano, aplicado desde já.

---

## 3. Fidelidade visual

Medições feitas no DOM, comparando a aplicação com `Pipeline.dc.html`
renderizado no mesmo navegador a 1440×900:

| Medida | Referência | Aplicação |
|---|---|---|
| Largura da sidebar | 228px | 228px |
| Altura do bloco do logo | 53px | 53px |
| Topo do menu | 69px | 69px |
| Altura do item de menu | 32px | 32px |
| Altura do header | 60px | 60px |
| Campo de busca | 420×34 | 420×34 |
| Coluna do `<h1>` | 248px | 248px |

Duas correções vieram dessa comparação: o `line-height` padrão do Tailwind
(1.5) inflava os itens de menu para 35,5px, e o menu estava dividido em dois
blocos por um separador que a referência não tem.

**Tokens extraídos** (todos em `src/design/tokens.ts` e `globals.css`): 38
cores, 3 famílias tipográficas, escala de 6 tamanhos (9,5 / 11 / 12 / 13 / 15 /
19px), 6 raios, 3 sombras, 2 densidades (11px e 7px), larguras estruturais e 2
breakpoints. O teste `tokens.test.ts` percorre o objeto de cores e falha se
alguma não estiver declarada no CSS — é o que impede a deriva entre lógica e
estilo.

---

## 4. Decisões e desvios (todos registrados em `docs/decisoes/versoes.md`)

### 4.1 TypeScript 6.0.3, não 7.0.2

O 7.0.2 é a última estável, mas `typescript-eslint@8.69.0` declara
`peerDependencies.typescript: ">=4.8.4 <6.1.0"` — inclusive na tag `canary`.
Adotar o 7 custaria o lint com reconhecimento de tipos, que é o que vai
sustentar as regras de autorização. Escolhida a maior versão dentro da faixa
suportada. **Reavaliar** quando o `typescript-eslint` publicar suporte a TS 7.

### 4.2 ESLint 9.39.5, não 10.10.0

Descoberto ao rodar, não ao ler changelog: o `eslint-plugin-react` empacotado
pelo `eslint-config-next` ainda chama `context.getFilename()`, removido no
ESLint 10 — o lint abortava com
`TypeError: contextOrFilename.getFilename is not a function`.

### 4.3 npm, não pnpm

O plano previa `pnpm-lock.yaml`. O Corepack falha nesta máquina com `EPERM` ao
escrever em `C:\Program Files\nodejs` (exige administrador). Adotado npm com
`package-lock.json` commitado, que cumpre a mesma função. Migrar depois é
`pnpm import` + `pnpm install`.

### 4.4 `eslint-config-next` sem `FlatCompat`

A primeira versão do `eslint.config.mjs` usava `FlatCompat`, que quebrava com
`Converting circular structure to JSON`. O pacote (v16) já exporta flat config
nativo em `eslint-config-next/core-web-vitals` e `/typescript` — importado
direto. A dependência `@eslint/eslintrc` foi removida.

---

## 5. O que **não** foi feito, e por quê

- **shadcn/ui não foi instalado.** Nenhum componente desta fase precisou dele
  (a sidebar, o topo e os três estados são markup próprio, ajustado ao pixel da
  referência). Instalá-lo agora contrariaria a emenda 4 — dependência entra na
  fase que a usa. Entra quando aparecer o primeiro diálogo ou menu real (A5).
- **Vercel não conectada, nenhum deploy feito.** Decisão sua.
- **Supabase não tocado.** Nenhuma dependência dele foi instalada.
- **Playwright não instalado.** O e2e começa em A2, com login. A conferência
  visual desta fase usou o `playwright-cli` global, fora do projeto.
- **Nenhum dado.** Não há seed, banco, sessão nem usuário. O nome do escritório
  ("Rocha & Antunes") e o do usuário ("Camila Rezende") aparecem no shell como
  texto fixo, copiados do protótipo para conferência visual, e serão
  substituídos pelo workspace e pela sessão em A2. Estão marcados com
  comentário no código.
- **Bloco "Metas do mês" da sidebar não implementado**: depende de dados reais
  (consultas realizadas no período). Entra em A10.
- **Contadores do menu** (Leads 9, Pipeline 19, Atividades 12, Conversas 5):
  mesma razão, entram a partir de A4.

---

## 6. Controles de segurança desta fase

Checklist da §14 do plano, no que se aplica a uma fase sem dados:

- [x] Segredos fora do repositório — `.gitignore` cobre `.env*` (exceto
      `.env.example`), e não há segredo algum no código
- [x] Cabeçalhos de segurança configurados
- [x] Barreira do `service_role` criada antes do módulo que ela protege
- [x] `ErrorState` não recebe erro cru do servidor (documentado no componente)
- [x] Nenhum dado real de cliente em lugar nenhum
- [ ] CSP — adiada para A2, quando as origens externas forem conhecidas
- [ ] RLS, autorização, auditoria, isolamento — não se aplicam: não há banco

---

## 7. Riscos conhecidos

1. **TypeScript 6 é uma escolha datada.** Quando o `typescript-eslint` suportar
   o 7, a migração precisa ser tarefa própria, com a suíte inteira rodando.
2. **`next-env.d.ts` e `tsconfig.json` são reescritos pelo `next build`** (o
   build ajustou `jsx` para `react-jsx` e acrescentou um caminho ao `include`).
   Isso é esperado; se o arquivo aparecer modificado num diff sem que ninguém o
   tenha editado, foi o build.
3. **A fidelidade visual foi verificada só a 1440×900 e só no Pipeline.** Os
   breakpoints de 1024 e 1280 estão declarados nos tokens mas ainda não têm
   layout que os exercite — isso só será testável quando existir tabela e
   kanban (A5).
4. **Fontes do Google carregadas via `next/font`** — em produção isso vira
   arquivo local no build, mas vale confirmar na primeira revisão de CSP.

---

## 8. Como verificar

```bash
cd praxis-crm
npm ci
npm run typecheck
npm run lint
npm test
npm run build
npm run dev        # http://localhost:3000
```

Para a conferência visual lado a lado, sirva a pasta de referência por HTTP
(o protocolo `file:` é bloqueado pelo navegador de automação) e compare
`/pipeline` com `Pipeline.dc.html` a 1440×900.

**Resultado da última execução (07/09/2026), com `node v24.18.0` e
`npm 11.16.0`:**

| Comando | Resultado |
|---|---|
| `npm ci` | 457 pacotes, sem erro |
| `npm run typecheck` | sem erros |
| `npm run lint` | sem erros nem avisos |
| `npm test` | 2 arquivos, 5 testes, todos passando |
| `npm run build` | compilado, 14 rotas estáticas |

---

## 9. Próximo passo (A2) — não iniciado

Autenticação, workspace e equipe: Supabase Auth; `workspaces`, `users`,
`memberships`; função `auth_workspace_ids()` com `search_path` fixado; guard de
workspace ativo; matriz de permissões; convites; troca de workspace.

Pendências para começar:

1. criar **apenas** o projeto de desenvolvimento no Supabase;
2. verificar no registry as versões de `@supabase/supabase-js`,
   `@supabase/ssr` e da CLI antes de instalar (emenda 4 + §2.1 do plano).

A Vercel não bloqueia A2: o desenvolvimento roda local contra o Supabase de
desenvolvimento.

---

## 10. Microfase A1.1 — correções de acessibilidade e de registro

Aberta a pedido, depois da auditoria da A1. Sem banco, autenticação ou
funcionalidade comercial — só correção.

1. **Contraste de texto (WCAG 2.1 AA).** `textTertiary`, `textSoft` e
   `textMuted` foram escurecidos (de `#6E7671`/`#7C8480`/`#8A918D` para
   `#5C635F`/`#626865`/`#676C69`) para atingir 4.5:1 contra os três fundos
   claros do produto (surface/app/canvas) — o pior caso é sempre o canvas
   (`#EFEEE9`), por ser o mais escuro dos três. A hue e a ordem de ênfase do
   protótipo foram preservadas; `textDisabled` (`#A5AAA6`) continua abaixo de
   AA de propósito, mas agora só pode ser usado em elemento decorativo
   (`aria-hidden`) ou dica secundária desabilitada (o atalho ⌘K) — é o único
   token na lista `decorativeColorTokens`. Teste novo:
   `tests/unit/contrast.test.ts`, cobrindo os 7 tokens de `textColorTokens`
   (incluindo `primary` e `danger`, que já passavam) contra os 3 fundos.
2. **`tests/unit/tokens.test.ts` reescrito.** O teste antigo só checava se o
   valor de uma cor aparecia em algum lugar do arquivo CSS — duas cores
   trocadas entre si, ou uma variável renomeada cujo valor antigo sobrevivesse
   em outro trecho do arquivo, passariam sem aviso. O novo teste faz o parse
   do bloco `@theme` para um mapa nome→valor e compara cada token de
   `tokens.ts` contra a variável CSS do mesmo nome, cobrindo cores,
   tipografia (tamanho e família, esta última só na parte de fallback, que é
   a que precisa ficar igual), raios, sombras, larguras estruturais,
   densidade e breakpoints. Confirmado com um teste negativo manual (trocar
   um valor no CSS e ver o teste falhar, depois reverter). Como a densidade
   não tinha CSS var nenhuma, foram adicionadas `--density-comfortable` e
   `--density-compact` em `globals.css` — só a variável, nenhum componente
   passou a usá-la além do já existente cálculo inline.
3. **`docs/decisoes/versoes.md` corrigido.** A tabela ainda listava
   `eslint | 10.10.0` como escolhido, sobra de antes da troca para 9.39.5 —
   contradizia `package.json` e o próprio `A1-HANDOFF.md`. Corrigida a linha
   e adicionada a seção "Decisão: ESLint 9.39.5, não 10.10.0", no mesmo
   formato da decisão do TypeScript, deixando explícito que o 10.10.0 foi
   **tentado e rejeitado** por quebrar em execução, não uma opção em aberto.
4. **Foco da busca global corrigido.** `focus:outline-none` removia o
   indicador de foco do navegador sem repor nada — a única pista de foco era
   a borda mudar de cinza para verde, contraste insuficiente como indicador
   de foco. Trocado por `focus-visible:outline-none` combinado com
   `focus-visible:ring-2 focus-visible:ring-primary-ring`: o outline nativo é
   substituído por um anel de 2px na cor `--color-primary-ring` (`#E1EEE9`),
   a mesma usada em `shadow.ring` e nas seleções do design system — verificado
   via `getComputedStyle` (outline none + box-shadow com o ring) e por
   captura de tela.

**Arquivos alterados:** `src/design/tokens.ts`, `src/app/globals.css`,
`src/components/app-shell/global-search.tsx`, `docs/decisoes/versoes.md`,
`tests/unit/tokens.test.ts` (reescrito).
**Arquivos criados:** `src/lib/contrast.ts`, `tests/unit/contrast.test.ts`.

**Verificação (07/09/2026, após `npm ci` limpo):**

| Comando | Resultado |
|---|---|
| `npm ci` | 450 pacotes, sem erro |
| `npm run typecheck` | sem erros |
| `npm run lint` | sem erros nem avisos |
| `npm test` | 3 arquivos, **86 testes**, todos passando |
| `npm run build` | compilado, 14 rotas estáticas |

Dimensões, navegação e identidade visual do shell não foram tocadas — só
cor de texto (contraste), o teste de tokens e o indicador de foco.
