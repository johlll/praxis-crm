# Refinamento visual 1 — estrutura compartilhada e pipeline (15/11/2026)

Escopo aprovado por João: tema e estrutura compartilhada (barra lateral, área principal, cabeçalhos) e acabamento completo do pipeline com arrastar e soltar. Dashboard, contatos e conversas terão acabamento próprio depois; aqui só herdam o tema.

## Tema

- Paleta conferida no CSS do blog da Vizentini: fundo `#151A18` (`canvas`), superfícies/cards `#232B28` (`surface`), hover `#29322F` (`surface-hover`). O creme do cabeçalho do blog não é usado no CRM.
- Os nomes dos tokens continuam os mesmos (`src/design/tokens.ts` ⇄ `globals.css`), por isso as telas existentes herdam o tema sem redesenho. `app` passou a ser o preenchimento "rebaixado" (chips, campos).
- Bronze (`accent`) só em detalhes: marca, ícone do item ativo, avatar da conta e estado pendente.
- `on-solid` é o texto escuro sobre fundos sólidos claros (botão primário, badge de atrasadas). Todos os textos têm 4.5:1 contra os quatro fundos (`tests/unit/contrast.test.ts`).
- A fonte continua a mesma (Public Sans), sem nova dependência remota.
- `cn()` passou a conhecer a escala tipográfica do projeto. Sem isso, o tailwind-merge lia `text-small` como cor e apagava a cor do texto. Esse defeito já existia antes do tema escuro.

## Estrutura

- Barra lateral de 236 px com o workspace no topo e a conta no rodapé (Equipe, Sair).
- Os grupos "Comercial" e "Operação" reorganizam os mesmos itens de antes. Nada some (`navigation.test.tsx` confere), e os grupos começam abertos. Recolher um grupo é preferência deste navegador.
- Abaixo de 1024 px a barra vira gaveta (`mobile-nav.tsx`), com a mesma navegação, o mesmo seletor de workspace e as mesmas ações de conta.
- O cabeçalho fica no fundo da página, com título de 22 px e ações à direita. A prop `user` do `Topbar` ficou só por compatibilidade.

## Pipeline: arrastar e soltar

- Reaproveita o `@dnd-kit/core` que já estava instalado. Nenhuma dependência nova.
- O arraste, o teclado e o seletor "Mover" passam pelo mesmo fluxo de negócio de antes: `checkStageRequirementsAction`, depois `StageAdvanceDialog` se houver pendência, depois `moveOpportunityStageAction` com a etapa de origem e o `lock_version` do servidor.
- Permissão, requisitos, concorrência, auditoria, gatilho de contato anonimizado e evento da C1 continuam no servidor. Nenhum caminho novo.
- Durante a conferência e a gravação, o cartão aparece no destino marcado como pendente. Com requisito aberto, ele volta à origem até a confirmação. Falha ou cancelamento o recoloca na origem e o quadro é recarregado do servidor.
- Só um movimento por vez: o resto do quadro fica travado, sem envio duplicado.
- Contadores e posições vêm sempre do quadro recarregado do servidor.
- Mouse: o arraste começa depois de 6 px; abaixo disso é clique, que abre o detalhe.
- Toque: segurar cerca de 0,2 s levanta o cartão; deslizar antes disso rola normalmente. O encaixe por coluna fica desligado durante o arraste, para a rolagem automática não pular colunas.
- Teclado: alça, Espaço, setas esquerda e direita (de coluna em coluna), Espaço para soltar, Esc para cancelar. Anúncios em português.
- Colunas de ganho ou perda não recebem cartão; ganhar e perder têm botões próprios. Não há ordenação persistente dentro da coluna, porque ela não existia.
- O pipeline ganhou um esqueleto de carregamento (`pipeline/loading.tsx`).
