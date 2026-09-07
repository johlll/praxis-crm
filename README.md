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
npm run dev      # http://localhost:3000
```

## Verificação

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

## Estado atual — fase A1 concluída

Entregue nesta fase:

- projeto Next.js + TypeScript strict + Tailwind v4;
- design system com os tokens extraídos dos protótipos (`src/design/tokens.ts`
  e `src/app/globals.css`, mantidos em sincronia por teste);
- `AppShell`, `Sidebar`, `Topbar` e `GlobalSearch` conferidos contra a
  referência a 1440×900 (sidebar 228px, itens de 32px, header de 60px, busca
  de 420×34);
- `EmptyState`, `LoadingState` e `ErrorState`;
- as 10 rotas do menu, navegáveis, cada uma dizendo em qual fase será
  construída — nenhum dado fictício exibido como se fosse real;
- CI com typecheck, lint, testes e build;
- cabeçalhos de segurança e a regra de lint que barra o cliente `service_role`
  fora de webhooks e jobs (a barreira existe antes do arquivo que ela protege).

Ainda não existe banco, autenticação nem dado algum: isso é a fase A2.

## Decisões

- `docs/decisoes/versoes.md` — versões escolhidas, com o motivo de TypeScript
  6.0.3 (e não 7) e de ESLint 9 (e não 10).
