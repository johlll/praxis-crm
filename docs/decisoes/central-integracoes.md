# Central de Integrações

Página `/integracoes`: seis ferramentas, o que o Praxis faz hoje com cada uma e o estado que dá para **comprovar**.
**Nada é conectado, ativado ou sincronizado por ela.** A configuração do Google Agenda continua em
`/configuracoes/integracoes`, com a mesma rota, parâmetros, retornos de autorização e controles.

## Acesso

Todo membro vê a central. Estado e ações seguem o papel da sessão; nenhuma permissão existente mudou.

## Leituras

Só duas, com a sessão da pessoa:

1. `list_calendar_connections` (RPC existente, sem token; já devolve a própria conexão e, para proprietário e
   administrador, as do escritório) — só quando há provedor configurado e o papel pode conectar;
2. canais do **simulador** de WhatsApp, pela RLS.

A central não chama Google nem Meta, não renova autorização, não lista agendas, não sincroniza, não cria evento,
não usa chave de serviço e não lê credencial. Falha de leitura vira **erro no cartão** com "Tentar novamente" —
nunca "não conectado" — e o outro cartão continua. No log entram só o cartão e o tipo do erro.

## Estados

| Cartão | O que pode dizer | Ação |
| --- | --- | --- |
| WhatsApp | "Canal real não validado" + quantos canais **fictícios** ativos; testes reais pausados | Ver detalhes (Conversas; simulador para quem tem `conversation.simulate`) |
| Google Agenda | não configurado no ambiente · sem acesso para conectar · sua conta: conectada / falta escolher a agenda / precisa autorizar de novo / não conectada · falha | Abrir configuração, Configurar ou Gerenciar, só com `calendar.connect_own` |
| Meta Ads, Google Ads | "Ainda não disponível" | Ver detalhes (Tráfego Pago) |
| Assinatura Digital | "Funcionalidade futura", sem fornecedor | Ver detalhes |
| Automações | "Recurso interno do Praxis" | Abrir automações, só com `automation.view` |

- **WhatsApp:** a sessão só enxerga canais do simulador; canais reais só são alcançados com a chave de serviço, que
  a central não usa. Por isso ela não afirma que há conexão real **nem que não há**.
- **Google Agenda:** "conectada" é o último registro no Praxis, não uma consulta ao Google. Conexão **pessoal** é o
  estado do cartão; as das outras pessoas aparecem só para `calendar.manage`, em **contagens**, sem nome ou e-mail.
- **Automações** não é a IA de atualização de status, que segue pausada.
- Sem menu "⋮" e sem botão "Conectar" que não faz nada. Categorias e contagens saem dos próprios cartões.

## Ícones

Arquivos locais em `public/logos/integracoes/`, usados só para identificar cada serviço; as marcas pertencem aos
seus donos e não indicam parceria.

| Arquivo | Origem |
| --- | --- |
| `whatsapp.svg`, `meta-ads.svg`, `google-ads.svg` | coleção pública `gilbarbara/logos` |
| `google-agenda.svg` | ícone de 2020 do Google Agenda (Wikimedia Commons), como na referência |
| `assinatura-d4sign.svg` | composição **como na referência** (marca inclinada roxa sobre o nome), com as letras do logotipo oficial. A marca atual da D4Sign é outra (branca, "by Zucchetti") |

Automações usa o ícone do próprio Praxis, o mesmo do menu.

**Atenção:** o ícone da Assinatura Digital segue a referência a pedido; **nenhum fornecedor foi escolhido ou
contratado**, e o cartão diz isso. Se o fornecedor for outro (ou para não sugerir um), basta trocar o arquivo.

## Falta para as integrações (fora desta etapa)

- Google Agenda: ativação em Production (B2), com configuração e conta do escritório.
- WhatsApp: validação real com conta e número isolados (B3), hoje pausada.
- Meta Ads e Google Ads: contrato de integração somente leitura (`trafego-pago.md`).
- Assinatura digital: escolher fornecedor, avaliar requisitos jurídicos e de dados, e então construir.
