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
