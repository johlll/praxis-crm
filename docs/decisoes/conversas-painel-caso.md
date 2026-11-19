# Conversas + IA — painel do caso (PR A da correção de direção)

Primeira entrega do painel fiel à referência de **hierarquia e interação** (cabeçalho compacto do caso, lápis,
abas horizontais, Resumo em cartões, formulários fora da consulta). Não conclui todas as funcionalidades da
referência: o que falta está registrado no fim, com a ordem das próximas entregas.

> **Etapa B entregue em seguida:** número interno do caso, catálogo de tipos de serviço, roteiro aplicado ao caso e
> marcos concluídos, convivendo com `case_progress` — ver [conversas-painel-servico.md](conversas-painel-servico.md).
> Os itens 1 a 4 das "Próximas entregas" abaixo saíram dali; 5 a 8 continuam pendentes.

Base: fundação das trilhas ([conversas-ia-fundacao.md](conversas-ia-fundacao.md), #356) e interface
([conversas-interface.md](conversas-interface.md), #357). Esta PR mantém o acabamento do Praxis e **substitui só a
organização do painel**; segurança, permissões, versão, idempotência e o isolamento entre casos da #357 continuam.

Migration nova (aditiva, só leitura): `20261120120000_conversas_painel_caso.sql` — **não aplicada no hospedado**.

## O que mudou na tela

### Painel do caso

| Parte | O que mostra | Fonte |
|---|---|---|
| Cabeçalho | assunto (área do lead), "Aberta em …" (+ desempate real), **selo** e **lápis** | oportunidade e lead |
| Nota de foco | "Caso vinculado a esta conversa." ou por que o caso mostrado **não** é o vínculo | foco (URL) × `conversations.opportunity_id` |
| Trocar caso | seletor com área, abertura, selo e a marca "vínculo da conversa" | `list_conversation_case_options` |
| Abas | **Resumo · Tarefas · Histórico** (estado na URL: `aba`) | — |
| Resumo | cartões "Informações do caso", "Andamento", "Próximas ações" e "Consentimento do contato" (recolhível) | ver abaixo |
| Tarefas | pendentes e concluídas **vinculadas à oportunidade**, com os fluxos existentes | `activities.opportunity_id` |
| Histórico | eventos das fontes canônicas, cada um uma vez, com a origem | `status_track_events`, `stage_transitions`, oportunidade |
| Edição (lápis) | correção da situação, correção do andamento, etapa comercial (só leitura) e pausas | trilhas de status |

**Documentos não aparece** — nem como aba pronta nem desativada. Entra em entrega própria (ver "Próximas entregas").

### Selo do caso

Sempre com **natureza escrita** e ícone próprio (nunca só cor):

| Oportunidade | Selo |
|---|---|
| aberta | `Comercial · <etapa do Kanban>` |
| ganha | `Serviço · <andamento registrado>`; sem registro: `Serviço · Andamento não informado` |
| perdida | `Perdida` |

A **situação do atendimento** é da conversa, nunca entra no selo e aparece à parte: ícone de mensagem e, para leitor
de tela e dica, "Situação do atendimento: …" (no cabeçalho da conversa com o prefixo visível "Atendimento ·").

### Lista e cabeçalho da conversa

Cada conversa mostra o **assunto e o selo** do caso pela mesma regra do painel, e a situação do atendimento à parte.
Com **vários casos e nenhum vínculo inequívoco**: "N casos" (lista e cabeçalho) e, no painel, "Escolha o caso" com
os cartões de cada caso — **nenhum andamento é atribuído ao cliente inteiro**. Sem caso e com área no lead, a área
continua aparecendo como antes.

### Andamento visual

- **Oportunidade aberta:** etapas comerciais do pipeline (sem as terminais de ganho e perda), em ordem, marcando a
  **atual**. Anterior e seguinte são **só a ordem do funil**: não há "✓" nem "concluída" — o banco não registra
  conclusão de etapa. Até 4 etapas, faixa horizontal (como na referência); acima disso, lista vertical.
- **Ganha:** o andamento registrado (`case_progress`) e um aviso honesto de que as etapas do serviço ainda não são
  configuradas. Nada de protocolo, sentença ou roteiro inventado.
- **Perdida:** selo e motivo, sem andamento.

### Identificação do caso

Só dados gravados: a **área do lead** como assunto e a **data de abertura**. Nenhum código de caso, tipo de serviço ou
número de processo é inventado. Quando outra oportunidade do contato tem **a mesma área, a mesma etapa e a mesma
natureza**, entra um identificador adicional **real**: a hora de abertura ("às 14:40") e, se até o minuto coincide, o
início do identificador da oportunidade ("ref. 1A2B3C4D").

## Regra única do caso (lista e painel)

`private.conversation_case_resolution(conversa, papel, ator)` é a regra-base, usada pela lista
(`list_conversation_inbox`) e pelo painel (`list_conversation_case_options`). Antes ela só existia no TypeScript do
painel. Ordem:

1. o **vínculo persistido** da conversa, se está entre as opções (vence mesmo se o lead da conversa tiver um único
   caso — o banco aceita vínculo numa oportunidade de outro lead do mesmo contato);
2. senão, a **única** oportunidade do lead da conversa;
3. senão, a **única** oportunidade do contato;
4. senão, **nenhuma** — e a contagem diz quantos casos há.

As opções são exatamente as do painel (leads do mesmo contato, no alcance do papel por
`private.lead_accessible_to_role`), então **lista e painel não divergem em permissão** (o pgTAP compara os dois em
cinco papéis). O foco da URL (`caso`) fica fora: é estado da tela aberta e **nunca** altera
`conversations.opportunity_id`. Quando o caso mostrado não é o vínculo, o painel diz por quê ("Escolhido nesta tela",
"Único caso do lead", "Único caso deste contato") e oferece "Ver o caso vinculado" quando ele existe.

## Edição pelo lápis

- Abre **dentro do painel** (`editar=1` na URL): Voltar/Avançar abrem e fecham; "Voltar ao caso" e o X também.
- Seções: **Situação do atendimento** (da conversa), **Andamento do serviço** (do caso; só oportunidade ganha),
  **Etapa comercial** (só leitura — muda pelo Pipeline, fonte canônica `stage_transitions`) e **Alterações automáticas
  de status** (pausa/retomada por trilha, cada uma nomeada pela trilha).
- Os editores são os mesmos da #357 (`TrackStatusEditor`, `AutomationControl`): mesma permissão, versão esperada,
  aviso de conflito com "Atualizar", chave de idempotência e identidade `trilha:alvo`. Trocar de caso com a edição
  aberta leva a um editor do zero para o novo alvo.
- A seção de automação diz que ela ainda não foi ativada e que **não pausa nem retoma o bot de atendimento** e não
  impede a correção manual.
- O lápis só aparece para quem edita algo (situação, andamento de caso ganho ou pausa comercial de caso aberto).
  Visualizador não vê lápis, e `editar=1` no endereço não abre controle nenhum.
- **Não há edição de campo sem persistência**: nada de tipo, processo, imóvel ou observações.

## Abas

- **Resumo:** cliente, área, etapa comercial (aberta), responsável, valor (só o que a projeção por papel do servidor
  libera; valor não informado não vira "R$ 0,00"), aberta/ganha em, contrato assinado, motivo da perda; andamento;
  até 3 próximas ações (pendentes do caso, por prazo, com a atrasada marcada); consentimento recolhível — **aberto
  quando falta consentimento vigente**, que é o que bloqueia o envio.
- **Tarefas:** `ActivitiesSection` reaproveitada (criar já vinculada ao caso, concluir, reagendar, transferir, editar,
  excluir; `activity.edit` e contato não anonimizado). Pendentes completas e as **20 concluídas mais recentes** (o
  total aparece, com link para a oportunidade). Atividades do lead **sem** caso não aparecem: o texto aponta para a
  página do lead. Nada é associado automaticamente.
- **Histórico:** situação do atendimento desta conversa, andamento do serviço e pausas (`status_track_events`, com
  evidências e alcance como na #357), movimentações comerciais (`stage_transitions`, com nomes das etapas e autor) e
  os marcos gravados na oportunidade (abertura e ganho). Cada evento aparece **uma vez**, com a etiqueta da origem. A
  perda não entra como evento porque a oportunidade não grava quando foi perdida. Propostas, notas e mensagens
  continuam na linha do tempo do lead (link).

## Estado na URL (acréscimos)

| Parâmetro | Significado | Padrão |
|---|---|---|
| `aba` | `resumo`, `tarefas` ou `historico` | `resumo` (omitido) |
| `editar` | `1` abre a edição pelo lápis | fechado |

Ficam com a conversa aberta (como `caso`): filtro, busca e página da lista os preservam; abrir **outra** conversa não
os leva. Valor inválido volta ao padrão, sem erro.

## Migration

`20261120120000_conversas_painel_caso.sql`, **aditiva e só de leitura**: nenhuma tabela, coluna, gatilho, dado ou
escrita. Cria `private.conversation_case_resolution` (revogada de `public`, `anon`, `authenticated` e
`service_role`) e recria `list_conversation_case_options` e `list_conversation_inbox` com a **mesma assinatura, o
mesmo alcance e as mesmas chaves**, só com chaves novas (`case_count`, `default_opportunity_id`, `default_source`;
`case`, `case_count`, `case_source`). `list_conversations` não é tocada. Ordem, paginação, busca, filtro e contagens
da lista são as mesmas (conferido pelo script de atualização).

**Ordem com a #358:** esta migration tem timestamp **posterior** ao da #358 (`20261119120000`). Se as duas forem
publicadas, a da #358 precisa ser aplicada antes desta; aplicar esta primeiro deixaria a #358 "fora de ordem" no
histórico de migrations. A ordem tem de ser conferida antes de qualquer publicação — isto **não** autoriza publicar a
#358.

## Testes

- pgTAP `58_conversas_painel_caso` (45): superfície (função privada fechada), ordem da regra, vínculo cruzado de
  lead, "nenhum por palpite", alcance do advogado, **lista = painel** em todas as conversas para dono, advogado,
  atendimento, gestor e visualizador, chaves antigas preservadas, isolamento entre escritórios, só leitura. Vermelho
  na versão anterior.
- Script `check-upgrade-conversas-painel-caso.sh` (no CI): lista e opções de caso iguais às de antes nas chaves
  antigas (ordem, total, contagens, valores), chaves novas coerentes, nenhuma conversa alterada.
- Unitários `conversas-painel-caso.test.ts` (regras puras, URL, leitura, contrato da migration, promessas) e
  `conversas-painel-caso-render.test.tsx` (painel renderizado); `conversas-estado-entre-casos.test.tsx` (isolamento
  da #357) agora roda dentro da edição.
- e2e `conversations.spec.ts`: correção pelo lápis, Histórico na aba, visualizador sem lápis.
- Mutações (4 no SQL, 4 na interface), todas detectadas.
- Validação local com dados sintéticos em 1440, 1280, 1100, 1024, 768 e 390 px (descrição da PR).

## Próximas entregas (registradas, não implementadas aqui)

Itens 1 a 4 **entregues na etapa B** ([conversas-painel-servico.md](conversas-painel-servico.md)); 5 a 8 continuam
pendentes.

1. **Número interno do caso** — aprovado como conceito, sempre separado do número judicial. Sem numerar
   retroativamente todos os registros por migration sem revisão específica.
2. **Tipo de serviço e etapas** — catálogo por escritório com **modelos sugeridos para copiar**, por escolha do
   escritório; nada ativado automaticamente.
3. **Convivência com `case_progress`** — `case_progress` **não** é "situação de espera": também contém análise,
   execução e conclusão. Antes de criar uma etapa de serviço independente, definir como as duas convivem sem
   contradição.
4. **Marcos concluídos** — só com registro efetivo de conclusão; nunca inferidos pela posição.
5. **Observações** — notas acrescentadas e vinculadas ao caso, preservando as notas gerais do lead.
6. **Documentos** — exigem implementação real de acesso, armazenamento, conferência humana (arquivo recebido não é
   documento analisado) e retenção; propostas em PDF ficam em grupo próprio.
7. **Automação** — a etapa futura de automação deve considerar este modelo. Esta PR **não** declara as etapas do
   serviço permanentemente incompatíveis com a IA.
8. Número do processo (CNJ) só quando houver persistência e significado definidos; não é preciso reproduzir
   "Processo: Em elaboração".

## Limites conhecidos

- Com muitas etapas no funil, o andamento comercial vira lista vertical (a faixa horizontal da referência só cabe
  até 4 etapas na largura do painel).
- O Histórico une fontes com paginação independente (como na #357): ao carregar eventos mais antigos de uma trilha,
  eles podem entrar entre eventos já mostrados de outra fonte; as movimentações comerciais vêm completas.
- A aba Tarefas mostra as 20 concluídas mais recentes; o total completo fica na página da oportunidade.
- Não há contador de não lidas nem "Para humano" (sem fonte), como na #357.
