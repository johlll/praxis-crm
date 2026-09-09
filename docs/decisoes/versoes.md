# Versões da stack — verificação de 07/09/2026

Registro exigido pela §2.1 do plano. Nenhuma versão foi escolhida por
familiaridade; todas foram consultadas no registry npm na data acima.

## Ambiente

| Item | Versão | Observação |
|---|---|---|
| Node | 24.18.0 (local) | linha LTS ativa; `engines.node >= 24` |
| Gerenciador | npm 11.16.0 | ver "Desvio" abaixo |

## Dependências de A1

| Pacote | Escolhido | Última estável | Motivo |
|---|---|---|---|
| next | 16.3.4 | 16.3.4 | `latest`, não canary/beta |
| react / react-dom | 19.2.8 | 19.2.8 | dentro do peer range do Next 16 (`^19.0.0`) |
| typescript | **6.0.3** | 7.0.2 | **ver decisão abaixo** |
| tailwindcss | 4.3.3 | 4.3.3 | via `@tailwindcss/postcss` |
| eslint | **9.39.5** | 10.10.0 | **ver decisão abaixo** |
| eslint-config-next | 16.3.4 | 16.3.4 | alinhado ao Next |
| typescript-eslint | 8.69.0 | 8.69.0 | |
| vitest | 5.0.0 | 5.0.0 | |
| @testing-library/react | 16.3.3 | 16.3.3 | |
| jsdom | 30.0.1 | 30.0.1 | |
| lucide-react | 1.41.0 | 1.41.0 | |

## Decisão: TypeScript 6.0.3, não 7.0.2

O TypeScript 7.0.2 é a última versão estável, mas **reprova no critério de
ecossistema** da §2.1.2: `typescript-eslint@8.69.0` — inclusive na tag
`canary` — declara `peerDependencies.typescript: ">=4.8.4 <6.1.0"`. Adotar o
TS 7 agora significaria abrir mão do lint com reconhecimento de tipos, que é
justamente o que sustenta as regras de autorização e de importação restrita
do cliente `service_role`.

A escolha é **6.0.3**, a versão estável mais alta dentro da faixa suportada.

**Reavaliar quando:** `typescript-eslint` publicar suporte a TS 7. Verificar
com `npm view typescript-eslint peerDependencies` a cada atualização de
dependências. A migração deve ser tarefa própria, com a suíte completa.

## Decisão: ESLint 9.39.5, não 10.10.0

O ESLint 10.10.0 é a última versão estável, mas **reprova ao rodar**, não
apenas na leitura do changelog: o `eslint-plugin-react` empacotado pelo
`eslint-config-next@16.3.4` ainda chama `context.getFilename()`, removido no
ESLint 10. O lint abortava com

```
TypeError: contextOrFilename.getFilename is not a function
```

**10.10.0 foi tentado e rejeitado** por essa incompatibilidade — não é uma
opção em aberto, é a versão descartada. A escolha é **9.39.5**, a última
estável dentro da faixa que o `eslint-config-next` desta versão do Next
realmente suporta em execução.

**Reavaliar quando:** `eslint-config-next` publicar uma versão cujas
dependências (`eslint-plugin-react`, `eslint-plugin-jsx-a11y`, etc.) já
tenham migrado para a API do ESLint 10. Verificar rodando `npm run lint` de
fato, não só conferindo `peerDependencies` — foi assim que a falha anterior
apareceu.

## Desvio: npm em vez de pnpm

O plano previa `pnpm-lock.yaml`. O Corepack falhou neste ambiente
(`EPERM` ao escrever em `C:\Program Files\nodejs`, exige administrador), e a
instalação global esbarraria no mesmo ponto. Adotado **npm** com
`package-lock.json`, que cumpre a mesma função de lockfile commitado.

Trocar para pnpm depois é possível (apagar `package-lock.json`, rodar
`pnpm import` e depois `pnpm install`), e só faz sentido se o ganho de espaço
em disco ou a velocidade de instalação passarem a importar.

## Próxima verificação

No início de **A2**, antes de instalar `@supabase/supabase-js`,
`@supabase/ssr` e a CLI do Supabase — conforme a emenda 4, essas
dependências não entram antes da fase que as usa.

## Dependências de A2 — verificação de 07/09/2026

| Pacote | Escolhido | Última estável | Motivo |
|---|---|---|---|
| @supabase/supabase-js | 2.115.0 | 2.115.0 | `latest`; peer de `@supabase/ssr` (`^2.114.0`) satisfeito |
| @supabase/ssr | 0.12.6 | 0.12.6 | pacote oficial atual para SSR — sucessor do `@supabase/auth-helpers-nextjs`, descontinuado (`npm view` retorna "Package no longer supported") |
| zod | 4.5.4 | 4.5.4 | `latest`, não beta/canary |
| supabase (CLI) | 2.116.0 | 2.116.0 | devDependency, para `supabase init`/`start`/`db`/`gen types` |
| @playwright/test | 1.63.0 | 1.63.0 | exigido pelo e2e de autenticação da A2; `engines.node >= 20`, satisfeito pelo Node 24 |

`@supabase/auth-helpers-nextjs` não foi instalado — descontinuado, substituído
por `@supabase/ssr`, que é a abordagem oficial atual para Next.js com App
Router (cliente de navegador + cliente de servidor lendo/escrevendo cookies
via `@supabase/ssr`'s `createBrowserClient`/`createServerClient`).

Nenhum componente shadcn foi instalado ainda — depende de `npx shadcn init`
rodar sobre as telas reais desta fase, o que só acontece depois que o
bloqueio da seção "Bloqueio" abaixo for resolvido.

## Decisão de infraestrutura revista: hospedado para dev, Docker só no CI (07/09/2026)

A primeira tentativa da A2 parou na preparação por falta de Docker local e
de projeto Supabase vinculado (registro histórico abaixo). O usuário then
decidiu explicitamente: Docker local deixa de ser requisito; o
desenvolvimento usa o projeto Supabase hospedado `praxis-crm-dev`
(exclusivo de desenvolvimento, nunca produção), e a reprodução completa do
banco (migrations do zero + pgTAP) passa a acontecer só no CI, no runner do
GitHub — que tem Docker.

Isso não elimina o bloqueio de credencial, só muda ONDE ele se resolve: em
vez de precisar de Docker nesta máquina, a implementação segue inteira
(schema, RLS, funções, telas, testes, CI) e só a CONEXÃO com o projeto
hospedado real (`supabase login`/`link`, aplicar migration nele, gerar
tipos `--linked`) fica pendente de uma credencial que só o usuário pode
fornecer (token de acesso pessoal do Supabase). Ver `A2-HANDOFF.md`,
seção "O que ainda depende de credencial", para o estado exato.

## Decisão: `middleware.ts` → `proxy.ts` (07/09/2026)

O `next build` (Next.js 16.3.4) já acusa `middleware.ts` como convenção
descontinuada: *"The 'middleware' file convention is deprecated. Please use
'proxy' instead."* Confirmado no próprio código-fonte instalado do Next
(`PROXY_FILENAME = 'proxy'` em `node_modules/next/dist/lib/constants.js`) —
mesmo mecanismo, mesma exportação `config.matcher`, só o nome do arquivo e
da função exportada mudam (`middleware` → `proxy`). Migrado para
`src/proxy.ts` em vez de manter uma convenção já descontinuada na versão
que o projeto usa.

## Bloqueio original, histórico (07/09/2026, superado pela decisão acima)

Ao chegar à seção 0 do prompt da A2 ("Preparação e bloqueios"), dois
requisitos que o próprio prompt lista como condição de parada estavam
ausentes nesta máquina:

1. **Docker não está instalado.** `docker` não existe no PATH (nem no Git
   Bash, nem no PowerShell), e `C:\Program Files\Docker\Docker Desktop.exe`
   não existe.
2. **Nenhum projeto Supabase de desenvolvimento estava vinculado.**
   `supabase projects list` retorna `LegacyPlatformAuthRequiredError` — a
   CLI não tem `SUPABASE_ACCESS_TOKEN` nem sessão de `supabase login`.

Mantido aqui só como registro de por que a primeira tentativa parou —
superado pela decisão de infraestrutura acima.

## Dependências de A5 — verificação de 10/09/2026

| Pacote | Escolhido | Última estável | Motivo |
|---|---|---|---|
| @dnd-kit/core | 6.3.1 | 6.3.1 | `latest`, não beta/canary; sem aviso de depreciação (`npm view deprecated` vazio); único pacote da família instalado — `@dnd-kit/sortable` não foi necessário (mover cards entre colunas discretas usa `useDraggable`/`useDroppable` direto, sem reordenar lista) |

Nenhuma outra dependência nova nesta fase — kanban, dialogs e tabela
reaproveitam Radix (`@/components/ui/dialog`) e os demais componentes de
UI já instalados nas fases anteriores.
