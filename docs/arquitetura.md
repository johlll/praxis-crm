# Arquitetura — A2 (autenticação, workspace e equipe)

## Visão geral

```
Navegador ──▶ src/proxy.ts (renova sessão, CSP com nonce, protege rotas)
                │
                ▼
        Server Components / Server Actions
                │
                ├── @/server/supabase/server.ts  (sessão do usuário, RLS ativa)
                ├── @/server/authz/permissions.ts (requireUser/Workspace/Membership/Permission)
                ├── @/server/auth/workspace.ts     (cookie assinado de workspace ativo)
                └── @/lib/roles.ts                 (matriz de permissões, sem next/headers —
                                                      importável por Client Components)
                │
                ▼
        Supabase Postgres (RLS + funções SECURITY DEFINER)
```

Nenhum caminho desta fase usa a Secret Key (`service_role`). Toda escrita
de negócio passa por funções `SECURITY DEFINER` em `public`, chamadas via
`supabase.rpc(...)` com a sessão do próprio usuário.

## Banco de dados

Migrations em `supabase/migrations/`, aplicadas em ordem:

| Arquivo | Conteúdo |
|---|---|
| `20260907120000_a2_schema.sql` | schema `private`, enums, tabelas (`workspaces`, `users`, `memberships`, `workspace_invitations`, `audit_logs`), triggers de `updated_at`/`created_by` |
| `20260907120100_a2_private_functions.sql` | `private.auth_workspace_ids()`, `private.has_workspace_role()`, `private.shares_active_workspace_with()`, trigger de sincronização `auth.users` → `public.users` |
| `20260907120200_a2_rls.sql` | RLS habilitada e forçada nas 5 tabelas, policies explícitas por operação, trigger `private.protect_users_email()` |
| `20260907120300_a2_business_functions.sql` | as 7 funções RPC de negócio (criar workspace, convidar, cancelar, prévia, aceitar, mudar papel, remover) |

### Por que RLS nega INSERT/UPDATE/DELETE direto em quase tudo

`workspaces`, `memberships`, `workspace_invitations` e `audit_logs` têm
policy explícita `with check (false)` para a maioria das operações de
escrita — não por omissão, por decisão: a lógica de negócio (atomicidade
workspace+owner, hash de token, proteção do último owner, auditoria) só é
segura se centralizada em um lugar só. As duas exceções deliberadas, com
policy própria e testada: `workspaces.UPDATE` (renomear, só owner/admin) e
`users.UPDATE` (perfil próprio, com e-mail protegido por trigger via
`pg_trigger_depth()`).

### `private` vs `public`: duas categorias de `SECURITY DEFINER`

- **`private.*`** — nunca exposto pela Data API (não está em
  `supabase/config.toml`'s `api.schemas`), `EXECUTE` revogado de `PUBLIC` e
  concedido só a `authenticated`/`anon` quando estritamente necessário.
  Existe só para as *policies* de RLS chamarem, quebrando o ciclo de
  recursão que existiria se uma policy de `memberships` tivesse que
  consultar `memberships` diretamente.
- **`public.*`** (as 7 funções de negócio) — deliberadamente expostas via
  RPC. Cada uma valida autorização e regra de negócio *internamente*
  (nunca confia na RLS da tabela que vai escrever, já que `SECURITY
  DEFINER` roda com o privilégio de quem definiu a função, não do
  chamador).

### Isolamento entre workspaces

`private.auth_workspace_ids()` é o único caminho que as policies usam para
saber "quais workspaces este usuário pode ver" — nunca um `JOIN` direto.
Todo índice composto começa por `workspace_id` (ou, em `memberships`, tem o
espelho `(user_id, workspace_id)` para o caminho inverso que
`auth_workspace_ids()` percorre a cada request).

**Atenção — a policy de SELECT de `memberships` é por workspace, não por
dono da linha.** Um membro autenticado enxerga a linha de `membership` de
**todos os colegas** dos workspaces em que está (é o que a tela de equipe
precisa: `listTeamMembers()` depende disso, sem `where` extra). Isso
significa que qualquer consulta que precise só da **própria** membership do
usuário — "qual é o meu papel aqui", "sou membro deste workspace", "quais
são os MEUS workspaces" — tem que filtrar `user_id = auth.uid()`
explicitamente na aplicação; a RLS sozinha não faz esse recorte. Três
funções (`getActiveWorkspaceId`, `switchActiveWorkspace` em
`src/server/auth/workspace.ts`, `listMyWorkspaces` em
`src/modules/workspace/queries.ts`) assumiam erroneamente que a RLS já
restringia à própria membership e usavam `.maybeSingle()` sem esse filtro —
assim que um workspace tinha 2+ membros, a consulta batia mais de uma linha
e `.maybeSingle()` falhava, reportando "não é membro" mesmo para quem era
dono de verdade. Corrigido filtrando por `user_id` nas três; ver
`A2-HANDOFF.md` §3 para o histórico completo.

## Autenticação (`@supabase/ssr`)

- `src/lib/supabase/browser.ts` — cliente do navegador (`createBrowserClient`)
- `src/server/supabase/server.ts` — cliente de servidor (`createServerClient`,
  `getAll`/`setAll` de cookies — não o trio `get`/`set`/`remove`, descontinuado)
- `src/proxy.ts` — renova a sessão a cada request via `supabase.auth.getUser()`
  (valida o JWT contra o Supabase; `getSession()` só leria o cookie sem
  confirmar validade)
- `src/app/auth/confirm/route.ts` — callback de confirmação de e-mail
  (`verifyOtp` com `token_hash`+`type`, não o formato antigo de link direto)

Não usa `@supabase/auth-helpers-nextjs` (descontinuado).

## Workspace ativo

`src/server/auth/workspace.ts`. Cookie `praxis_active_workspace`, valor
`<workspace_id>.<hmac-sha256-hex>`, `httpOnly`, `secure` em produção,
`sameSite=lax`, sem nenhum dado além do id. A assinatura só prova que o
cookie não foi adulterado *depois* de emitido — nunca é, sozinha, prova de
que a membership continua válida: `getActiveWorkspaceId()` sempre
revalida contra o banco (via RLS) antes de confiar no valor.

Fluxo de troca: navegador pede → `switchActiveWorkspace()` confirma
membership ativa no banco → só então grava o cookie. Nunca o contrário.

## Autorização (`src/lib/roles.ts` + `src/server/authz/permissions.ts`)

`src/lib/roles.ts` é intencionalmente **client-safe** (sem `next/headers`):
os papéis, seus rótulos e a matriz `Permission → Set<Role>` — importável
por Client Components para decidir o que mostrar. `src/server/authz/
permissions.ts` reexporta esses tipos e adiciona as funções que só fazem
sentido no servidor: `requireUser`, `requireWorkspace`, `requireMembership`,
`requirePermission`, e as variantes `OrRedirect` usadas no topo de páginas.

Essa separação existe porque a primeira versão misturava tudo num arquivo
só, e importar `ROLE_LABEL` de um Client Component (`member-row.tsx`)
arrastava `next/headers` para o bundle do navegador — o `next build` recusa
isso (erro real, pego durante o desenvolvimento, não hipotético).

## CSP com nonce por request

`src/proxy.ts` gera um nonce aleatório (`node:crypto`, disponível porque o
Next 16 roda `proxy.ts` sempre em runtime Node) a cada request, monta
`script-src 'self' 'nonce-XXX' 'strict-dynamic'` e define o cabeçalho
`Content-Security-Policy`. `src/app/layout.tsx` lê `headers()` — isso ativa
o mecanismo do Next de aplicar automaticamente esse nonce em todo `<script>`
que ele mesmo injeta (confirmado por inspeção do HTML servido: todo
`<script>` da build carrega o `nonce` correspondente). `connect-src` inclui
só `'self'` e a URL do projeto Supabase — nenhuma outra origem.

## Estrutura de diretórios (o que a A2 acrescentou)

```
supabase/
  migrations/           4 arquivos, nesta ordem
  seed.sql              fictício — 2 workspaces, 4 usuários, 4 convites
  tests/database/       4 arquivos pgTAP (57 asserções)
src/
  lib/
    roles.ts             client-safe: papéis e matriz de permissões
    errors.ts            mapeia erro técnico → mensagem sanitizada
    initials.ts
    env.client.ts         as 2 vars públicas, nada mais
    supabase/browser.ts
  server/
    env.ts                 valida env com Zod
    request-origin.ts
    supabase/server.ts
    auth/workspace.ts       cookie assinado de workspace ativo
    authz/permissions.ts    require*, matriz reexportada
    types/database.ts       GERADO (provisório — ver A2-HANDOFF.md)
  modules/
    auth/                 signUp/signIn/signOut
    onboarding/            criar primeiro workspace
    workspace/             trocar workspace, listar os do usuário
    team/                  convites, papéis, remoção
    shell/                 contexto cacheado (React cache()) do AppShell
  components/
    ui/                    button, input, label, alert, dialog,
                            dropdown-menu, form-field — shadcn hand-authored
                            (ver A2-HANDOFF.md — CLI interativa demais
                            para automatizar com segurança)
    auth/ onboarding/ team/  formulários client-side por domínio
  app/
    entrar/ auth/confirm/ onboarding/ convite/[token]/    fora do shell
    (app)/configuracoes/equipe/                            dentro do shell
  proxy.ts                 sessão + CSP + proteção de rota
tests/e2e/                 Playwright — jornada completa
```
