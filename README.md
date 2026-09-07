# Praxis CRM Jurídico

CRM comercial para escritórios de advocacia. Acompanha a jornada do lead da
origem até a assinatura do contrato de honorários e a conversão em cliente.

O plano de arquitetura completo está em
`~/.claude/plans/esse-ser-um-prot-tipo-fancy-lynx.md`. As telas aprovadas que
servem de referência visual estão em
`Desktop/Henrique/Protótipo CRM/Central de Atividades do CRM 3`
(somente leitura — não alterar).

## Rodar

```bash
npm install
cp .env.example .env.local   # preencher com um projeto Supabase de DEV
npm run dev                  # http://localhost:3000
```

`.env.example` documenta cada variável. Nunca aponte `.env.local` para
produção — só para `praxis-crm-dev` ou para um Supabase local
(`npm run db:start`, exige Docker).

## Verificação

```bash
npm run typecheck
npm run lint
npm test
npm run build      # exige as variáveis Supabase válidas em .env.local
```

Testes de banco e e2e exigem Docker (`npm run db:start` sobe Postgres/Auth
locais via Supabase CLI) ou rodam automaticamente no CI, que não depende de
Docker nesta máquina:

```bash
npm run db:reset        # aplica as migrations do zero, local
npm run test:db         # pgTAP — RLS, convites, último owner, hardening
npm run test:isolation  # só o arquivo de isolamento entre workspaces
npm run test:e2e        # Playwright — jornada completa de autenticação
```

## Estado atual — fase A2 concluída (não mesclada em `main`)

Autenticação (`@supabase/ssr`), isolamento por workspace via RLS, papéis e
matriz de permissões, workspace ativo com cookie assinado, convites de
equipe com token de uso único, e as telas correspondentes (`/entrar`,
`/onboarding`, `/convite/[token]`, `/configuracoes/equipe`) — shell da A1.1
preservado, agora com dados reais da sessão em vez dos nomes fixos do
protótipo.

Detalhes completos, inclusive o que ainda depende de uma credencial do
Supabase hospedado que só o usuário tem: `A2-HANDOFF.md`.
Arquitetura: `docs/arquitetura.md`. Segurança: `docs/seguranca.md`.

**Ainda não implementado** (fases seguintes): leads, contatos, pipeline,
atividades, WhatsApp, dashboard.

### Fase A1 (concluída antes)

- projeto Next.js + TypeScript strict + Tailwind v4;
- design system com os tokens extraídos dos protótipos (`src/design/tokens.ts`
  e `src/app/globals.css`, mantidos em sincronia por teste);
- `AppShell`, `Sidebar`, `Topbar` e `GlobalSearch` conferidos contra a
  referência a 1440×900;
- `EmptyState`, `LoadingState` e `ErrorState`;
- CI com typecheck, lint, testes e build;
- cabeçalhos de segurança (CSP finalizada na A2) e a regra de lint que barra
  o cliente `service_role` fora de webhooks e jobs.

## Decisões

- `docs/decisoes/versoes.md` — versões escolhidas (TypeScript 6.0.3 e não 7,
  ESLint 9 e não 10, `middleware.ts` → `proxy.ts` no Next 16.3.4) e a decisão
  de infraestrutura da A2 (Supabase hospedado para dev, Docker só no CI).
