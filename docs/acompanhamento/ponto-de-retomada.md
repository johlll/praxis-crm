# Praxis — ponto de retomada

Atualizado em 26/11/2026 (horário de Brasília), na branch `feat/visao-geral-periodo`.

Registro de onde cada frente parou. **Não é consulta em tempo real**: antes de qualquer ação externa, reconferir a
`main`, os HEADs das PRs, o histórico de migrations do banco hospedado e as travas. Ao retomar uma frente pausada,
continuar deste ponto; não reiniciar nem apagar o trabalho anterior. Não dizer que algo foi ativado, testado com
provedor real ou publicado quando só foi implementado, simulado ou relatado.

Este repositório é público: aqui não entram credenciais, dados de clientes nem caminhos de máquinas pessoais.

## Frentes

| Frente | Situação |
| --- | --- |
| Tráfego Pago — parte visual | **publicada em Production** (#367), com dados fictícios |
| Tráfego Pago — integrações Meta Ads e Google Ads | **não existem** |
| Financeiro e Central de Integrações | **publicados em Production** (#368): o Financeiro como demonstração; a central só informa a situação |
| Visão geral — período personalizado | implementado na branch `feat/visao-geral-periodo`, em PR **sem merge**; migration **não aplicada** no hospedado |
| IA / extrator (#366) | **PAUSADA**; PR aberta, sem merge |
| Validação real do WhatsApp (YCloud) | **PAUSADA** |

Prazo de entrega informado: 05/12/2026. Ajustes cosméticos e melhorias não bloqueantes vão para a lista posterior.
Segurança, isolamento, integridade e envio indevido continuam sendo condições antes de ativar recursos.

## Projeto

- App publicado: https://praxis-crm-eight.vercel.app
- Supabase hospedado: `rgoeppjwnltcbeqipovh`. No estado conhecido, Preview e Production usam esse mesmo banco.
- Escritório demonstrativo: `d10a0000-0000-4000-8000-000000000001` (`is_demo = true`). O nome do escritório não
  basta para autorizar escrita: conferir UUID, projeto e escopo.
- `main`: `153286cb4982786c60641f3c6056c4a68340f400` (merge da #368).

## Publicado

| PR | O que é | HEAD aprovado → merge | Migration (aplicada) | Histórico |
| --- | --- | --- | --- | --- |
| #364 | documentos por caso | `6c1d08e` → `32b19c1` | `20261123120000` | 124 |
| #358 | horário de origem das mensagens | `b6caca2` → `17af640` | `20261124120000` | 125 |
| #365 | aplicador de status | `d6a9993` → `f2e51aa` | `20261125120000` | 126 |
| #367 | Tráfego Pago (visual, dados fictícios) | `61689ff` → `5c29fdb` | nenhuma | sem mudança |
| #368 | Financeiro (demonstração) e Central de Integrações | `d25b943` → `153286c` | nenhuma | sem mudança |

- **Documentos**: recebimento FECHADO nas duas travas (`CASE_DOCUMENTS_UPLOAD_ENABLED` ausente e portão do banco
  falso). Não liberar upload real antes de: backup ativo com recuperação testada; limpeza que não dependa do uso do
  app; solução comprovada para envio que termine depois da validade do token; conferência dos prazos efetivos do
  Storage (a folga de uma hora sozinha não é garantia). Não criar arquivo sintético no hospedado sem nova
  autorização.
- **Horário de origem**: chegada ao CRM não é o horário de origem. Nenhum preenchimento presumido; as 18 mensagens
  antigas seguem sem horário de origem. No CI da `main` houve uma falha ao buscar fonte do Google no Build; a única
  reexecução passou.
- **Aplicador**: `status_track_automation_gate` FECHADO; nenhuma decisão ou evento automático registrado no
  hospedado. Não há geração nem execução automática em operação. Atendimento, andamento do serviço e etapa
  comercial são trilhas diferentes; ganho, perda, etapa comercial, conclusão de etapa e de serviço seguem manuais.

## Tráfego Pago

- **Publicado** em 26/11 (#367): CI da `main` verde na primeira tentativa (run `45802886535`) e verificação de
  Production só com leitura.
- Só a parte visual, com dados fictícios no escritório demonstrativo. **Não há** integração, OAuth, token, conta,
  sincronização ou tabela. Antes de dado real, ver a lista em `docs/decisoes/trafego-pago.md` (inclui quem pode ver
  investimento e a regra de lead qualificado e de contrato).

## Financeiro e Central de Integrações (publicados)

- **Publicado** em 26/11 (#368, merge `153286c`, HEAD aprovado `d25b943`): CI da `main` verde na primeira tentativa
  (run `45837370543`) e verificação de Production só com leitura (87/87), incluindo advogado, atendimento e
  visualizador sem acesso ao Financeiro. Dos papéis com acesso, só o proprietário foi usado em Production.
- O Financeiro está publicado como **demonstração**, não como registro financeiro. A central **não criou** as
  integrações futuras.

Decisões: `docs/decisoes/financeiro.md` e `docs/decisoes/central-integracoes.md`. Sem migration, escrita no banco,
variável, credencial ou configuração externa.

**Implementado**
- `/financeiro` (proprietário, administrador e gestor, conferido no servidor): seletor de mês, quatro cartões,
  fluxo de caixa diário, rosca de honorários a receber, lançamentos com busca e ordenação.
- `/integracoes`: seis cartões com categoria e estado comprovável, só leitura; leva à configuração já existente do
  Google Agenda, que não mudou.

**Continua demonstrativo**
- Todo o Financeiro: lançamentos fictícios só no escritório demonstrativo; "Novo lançamento" é **simulação** em
  memória, que some ao recarregar. Nos demais escritórios, "Ainda não há lançamentos neste módulo".
- Os lançamentos fictícios são **estáveis por mês**: a data atual só corta o realizado, classifica vencimentos e
  define a comparação; não muda datas, valores nem identificadores.
- **Não é um Financeiro completo.**

**Falta implementar ou ativar** (cada item com ordem própria)
- Financeiro real: modelo de dados, permissões de escrita, parcelas e recebimento parcial, conciliação, cobrança,
  documentos fiscais, importação e retenção.
- Meta Ads, Google Ads e assinatura digital: não existem (assinatura sem fornecedor definido; o ícone segue a
  referência visual e não indica contratação).
- Google Agenda em Production: ativação pendente. WhatsApp real: validação pausada.
- **As integrações não estão prontas**: a central só informa a situação.

## Visão geral — período personalizado (frente atual, sem merge)

Definições: `docs/decisoes/a10-dashboard.md`, seção "Período".

**Implementado**
- Um calendário num painel no lugar do seletor de 7/30/90, com os três atalhos; datas na URL; até 366 dias, sem
  futuro, validadas no app e no banco; comparação com o intervalo anterior de mesma duração.
- Migration **nova** `20261127120000_dashboard_periodo_personalizado.sql`: `get_dashboard` e
  `get_dashboard_attribution` aceitam as duas datas. Não altera tabela, dado nem migration anterior.

**Falta** (cada item com ordem própria)
- **Aplicar a migration no hospedado**, o arquivo inteiro **numa única transação** (ele remove a assinatura antiga e
  cria a nova). Os consumidores atuais continuam funcionando depois dela.
- Merge e publicação. Antes da migration, o app novo mantém os atalhos e, para datas escolhidas, avisa que o período
  personalizado não está disponível, sem mostrar números. É o caso do Preview, que usa o banco hospedado.
- Ordem recomendada: migration primeiro, depois o merge.

Não foi iniciado o Financeiro real.

## IA — PAUSADA na #366

- PR: https://github.com/johlll/praxis-crm/pull/366 · branch `feat/conversas-extrator`
- HEAD `16a33b1e269470381aefac86bf2a527f41221858` sobre a `main` `f2e51aa`; CI run `45719807170` verde.
- Esse CI é sobre a `main` antiga: depois da #367 (e de qualquer outro merge), reconferir base, conflitos e CI.
- **Não mesclada.** Migrations **não aplicadas** no hospedado:
  `20261126120000_conversas_aplicador_alvo_estavel.sql` e `20261126130000_conversas_extrator_contexto.sql`.
  Não presumir histórico 127/128. Não modificar migrations já publicadas.
- **Ordem das migrations:** a do período personalizado (`20261127120000`) tem número posterior ao das duas da #366.
  Se ela for aplicada primeiro, renumerar as da #366 para depois dela antes de aplicá-las, e rever a #366 sobre a
  nova `main`.
- Entrega: correção do alvo do aplicador (o caso podia mudar enquanto ele esperava a trava; reproduzido por dois
  caminhos reais locais e coberto por regressão); leitura de contexto restrita; instruções e esquema estritos;
  quatro camadas desligadas (`STATUS_EXTRACTOR_ENABLED`, portão do banco, modelo não configurado,
  `STATUS_EXTRACTOR_APPLY_ENABLED`). Só respostas SIMULADAS; nenhum provedor implementado ou chamado. Sem rota,
  job ou agendamento. **A correção do alvo ainda não está no hospedado.**

### Pendências da revisão, antes de conectar um modelo

1. Incluir o caso (`opportunity_id`) na chave determinística e conferir a coerência entre os campos da chave e do
   fingerprint do aplicador. *Conferido por leitura em 25/11: a chave atual não inclui o caso.*
2. Não autorizar mudança com base em texto cortado como se fosse a mensagem completa: tratar a incompletude e
   testar uma ressalva ou negação na parte omitida. *Conferido por leitura em 25/11: o contexto corta em 1.500
   caracteres sem informar o corte.*
3. Retirar campos de nome e telefone não anonimiza: o corpo das mensagens ainda pode conter dados pessoais.
4. Disparo e local do processamento fazem parte da entrega funcional, não são detalhe para adiar sem prazo.
5. Avaliar várias propostas para a mesma trilha, sem sobrescrever versões nem escolher entre contraditórias pela
   ordem da resposta.

### Autorização registrada para quando a frente for retomada (NÃO é ordem para executar agora)

- OpenAI, mesma conta/organização da Vitória, modelo de avaliação inicial `gpt-6-luna`, **até US$ 2 no total**, só
  com dados **fictícios**, sem renovação automática.
- Credencial própria do extrator, de preferência em projeto separado. Não copiar a chave da Vitória nem alterar o
  projeto, a cobrança, a configuração ou o funcionamento dela.
- **Não** autoriza: dados reais de clientes no modelo, mudança automática em Production, número oficial do
  WhatsApp ou upload de documentos.
- O teto de US$ 10 por mês foi só sugestão: **não** foi aprovado como gasto recorrente. A assinatura do ChatGPT
  não paga a API.

### Como retomar, quando houver ordem

1. Reconferir #366, `main`, histórico de migrations e travas.
2. Resolver as pendências 1 e 2 com regressão.
3. Adaptador para `gpt-6-luna` (conforme disponibilidade na conta): credencial exclusiva, resposta estruturada,
   sem ferramentas ou navegação, com limites de entrada, saída, tempo e custo.
4. Testar com conversas fictícias e aplicação desligada, dentro dos US$ 2.
5. Definir o processamento após mensagens novas do cliente ou do escritório, agrupando as próximas, sem chamada
   duplicada (janela de poucos segundos foi sugestão, não decisão).
6. Guardar só metadados mínimos de custo e resultado; não registrar conversas em log. `store: false` não é
   retenção zero. Conferir contrato, retenção, região e aprovação do responsável antes de dados reais.
7. Só então discutir publicação, teste real e ativação limitada. Migrations no hospedado, merge, variáveis e
   abertura de portões continuam exigindo ordem explícita.

## WhatsApp / YCloud — PAUSADA

- Depende de conta isolada e número de teste. Não conectar o número oficial do escritório por inferência.
- Testes anteriores do chatbot **não** comprovam o caminho novo do CRM e do extrator. Não refazer o bot.
- A Vitória não foi modificada: atendimento, chaves e integrações preservados.
- Falta comprovar com eventos reais: classificação cliente/escritório; tipo de arquivo; significado e estabilidade
  de `sendTime`; entrega, reentrega e duplicatas; convivência com o WhatsApp Business App; ausência de resposta
  dupla; transferência ou pausa para atendimento humano.
- Testar primeiro com conta e número isolados, lista autorizada, observação e critérios de parada. Não enviar a
  clientes reais.
- Antes de alterar, reler `docs/decisoes/b3-whatsapp-real.md` e relacionados.

## Outras frentes abertas

- Google Agenda: teste controlado em Preview feito; ativação em Production pendente. Conectar o Google não
  substitui a Agenda do Praxis.
- Documentos reais: bloqueados pelas condições acima.
- Fechamento geral: validação integrada, separação de ambientes antes de dados reais, entrega e aceite, pendências
  de formulário e site. CI verde sozinho não é produto operacional.
- Backups, retratos de publicação e capturas ficam em pastas locais, fora do repositório; para revisão externa,
  precisam ser anexados.
