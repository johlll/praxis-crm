# A2 — Handoff (parada na preparação)

**Projeto:** Praxis CRM Jurídico
**Fase:** A2 — Autenticação, workspace e equipe
**Branch:** `feat/a2-auth-workspace` (local, **não enviada ao GitHub**)
**Data:** 07/09/2026
**Status: bloqueada na seção 0 do prompt da A2, por instrução explícita dela.**

O prompt da A2 lista, na sua própria seção "0. Preparação e bloqueios", uma
condição de parada: *"Se faltar projeto Supabase de desenvolvimento, Docker
ou alguma credencial necessária, informe exatamente o que falta e pare nesse
ponto. Não contorne testes de banco nem use produção."*

Os dois faltam. Este documento diz exatamente o quê, o que já foi feito
apesar disso, e o que preciso de você para destravar.

---

## O que está faltando

### 1. Docker

`docker` não existe no PATH (testado no Git Bash e no PowerShell), e
`C:\Program Files\Docker\Docker Desktop.exe` não existe nesta máquina.

`supabase start` — o comando que sobe Postgres, GoTrue (Auth), Storage e o
resto localmente — depende de Docker. Sem ele:

- não há como aplicar as migrations e ver se elas realmente rodam;
- não há como rodar os testes pgTAP das policies de RLS;
- não há um Postgres local contra o qual rodar `supabase test db`;
- não há URL/chave anônima locais para a aplicação autenticar de verdade.

**O que resolve:** instalar o Docker Desktop
(https://www.docker.com/products/docker-desktop/) e deixá-lo rodando.

### 2. Projeto Supabase de desenvolvimento

```
$ npx supabase projects list
{"_tag":"Error","error":{"code":"LegacyPlatformAuthRequiredError", ...}}
```

Não há sessão de `supabase login` nem `SUPABASE_ACCESS_TOKEN` nesta máquina,
e não existe em lugar nenhum um `NEXT_PUBLIC_SUPABASE_URL` /
`NEXT_PUBLIC_SUPABASE_ANON_KEY` de um projeto real.

**O que resolve — uma das duas:**

- **Opção A (recomendada):** você cria o projeto de desenvolvimento pelo
  painel do Supabase (https://supabase.com/dashboard) e me passa a URL e a
  chave anon dele (a `service_role` só entra bem mais tarde — a A2
  explicitamente não a usa).
- **Opção B:** com Docker já instalado, `supabase start` sobe um Postgres
  local completo sem depender de projeto algum na nuvem — só nesta máquina.
  Se preferir, eu sigo só com isso e o projeto de nuvem fica para quando
  fizer sentido (deploy real).

Qualquer uma das duas destrava a A2. As duas juntas (local para o dia a dia,
projeto de nuvem para o preview da Vercel mais adiante) é o que o plano
original sugere, mas não é preciso ter as duas agora.

---

## O que já foi feito, dentro do que a preparação permite sem Docker/projeto

Tudo isto está na branch local `feat/a2-auth-workspace`, **commitada mas não
enviada ao GitHub** — não abri Pull Request, porque a fase não está
implementada, só preparada.

- Confirmado working tree limpo e `main` sincronizado com o remoto antes de
  criar a branch.
- Branch `feat/a2-auth-workspace` criada a partir de `main`.
- Versões pesquisadas no registry (não presumidas) e registradas em
  `docs/decisoes/versoes.md`, seção "Dependências de A2":
  - `@supabase/supabase-js@2.115.0`
  - `@supabase/ssr@0.12.6` — a abordagem oficial atual; confirmei que
    `@supabase/auth-helpers-nextjs` está descontinuado
    (`npm view` devolve "Package no longer supported") antes de descartá-lo
  - `zod@4.5.4`
  - `supabase@2.116.0` (CLI, devDependency)
  - `@playwright/test@1.63.0`
- Essas cinco dependências instaladas, e só elas — nenhum componente shadcn
  ainda, porque instalá-los sem as telas reais para usá-los seria antecipar
  dependência de novo, o mesmo erro que a emenda 4 da A1 corrigiu.
- `supabase init` rodado — cria só arquivos locais
  (`supabase/config.toml`, `supabase/.gitignore`), não precisa de Docker.
  Conferido: o schema `public`/`graphql_public` é o único exposto pela Data
  API por padrão, o que já deixa o futuro schema `private` (das funções
  `SECURITY DEFINER`) fora do alcance do PostgREST sem precisar de nada
  extra.
- `.env.example` criado com nomes e explicações, **sem nenhum valor real**:
  `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
  `SUPABASE_SERVICE_ROLE_KEY` (documentada como não usada nesta fase) e
  `WORKSPACE_ACTIVE_COOKIE_SECRET` (para assinar o cookie de workspace
  ativo, exigido pela seção 4 do prompt).
- Suíte inteira revalidada com as dependências novas instaladas:

| Comando | Resultado |
|---|---|
| `npm run typecheck` | sem erros |
| `npm run lint` | sem erros |
| `npm test` | 3 arquivos, 86 testes, todos passando |
| `npm run build` | 14 rotas estáticas |

Nada do design system, do shell ou das telas da A1/A1.1 foi tocado.

---

## O que **não** foi feito, e por quê

Nada da seção 1 em diante do prompt da A2: nenhuma migration, nenhuma
policy de RLS, nenhuma função `SECURITY DEFINER`, nenhum código de
autenticação, nenhuma tela, nenhum teste de banco. Escrever isso agora
significaria ou inventar uma URL/chave falsas (proibido explicitamente:
"nunca invente credenciais"), ou escrever SQL de RLS sem poder rodá-lo nem
uma vez — o que contraria diretamente "não contorne testes de banco". Nos
critérios de aceite que você mesmo definiu, segurança e isolamento não são
opcionais; então não são coisas que eu deveria entregar sem verificação.

## Próximo passo

Assim que Docker estiver instalado e eu tiver (ou tiver criado, se preferir
a opção B) um projeto de desenvolvimento, retomo exatamente daqui — mesma
branch, sem refazer o que já está pronto — e sigo o restante do prompt da
A2 até o Pull Request.
