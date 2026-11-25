/**
 * Integração com o modelo do extrator (docs/decisoes/conversas-extrator.md).
 *
 * Só a INTERFACE: nenhum provedor está contratado nem configurado nesta etapa, e nenhum adaptador faz chamada de
 * rede. A escolha do provedor e do modelo é uma decisão pendente (custo, contrato de tratamento de dados — as
 * mensagens são dados pessoais —, região e retenção). Enquanto não houver escolha, `resolveExtractionModel`
 * devolve nulo e o extrator para em `no_model`, sem chamar nada.
 *
 * Um adaptador futuro precisa: receber `system` e `user` separados (o texto das mensagens só em `user`), não
 * habilitar ferramentas nem navegação, temperatura baixa, limite de saída pequeno, e devolver o TEXTO bruto — quem
 * lê e confere é o `parseModelOutput`. Credencial só por variável própria do extrator (nunca a da Vitória).
 */

export type ExtractionModelRequest = { system: string; user: string };

export interface StatusExtractionModel {
  /** Identificador estável do modelo (entra na referência do extrator, ex.: "provedor.modelo"). */
  readonly id: string;
  complete(request: ExtractionModelRequest): Promise<string>;
}

export type ExtractionModelEnv = Readonly<Record<string, string | undefined>>;

/** Nenhum provedor implementado: sempre nulo até a decisão ser tomada. */
export function resolveExtractionModel(env: ExtractionModelEnv): StatusExtractionModel | null {
  void env.STATUS_EXTRACTOR_PROVIDER;
  return null;
}
