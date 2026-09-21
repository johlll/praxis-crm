# A11 — exemplo de integração do formulário público

Documento de **referência**. Nenhuma landing, quiz ou site de cliente foi
alterado nesta fase — este arquivo existe para quem for integrar depois.

## O contrato do `source_event_id`

O navegador gera o identificador **uma vez por submissão** e o reutiliza
em toda tentativa da mesma submissão. É isso que torna a idempotência
possível: o servidor reconhece "é o mesmo envio" sem precisar adivinhar
pelo conteúdo.

Regras, todas exercidas pelo código abaixo:

1. montar uma submissão final **imutável**;
2. gerar `source_event_id` com `crypto.randomUUID()` **uma única vez**;
3. guardar em memória **e** em `sessionStorage`;
4. reutilizar o mesmo UUID em timeout, perda de conexão e retry;
5. **renovar o token do Turnstile sem trocar o UUID**;
6. remover o UUID depois da confirmação definitiva;
7. gerar UUID novo se o conteúdo mudar materialmente ou começar outra
   submissão.

```html
<form id="contato" novalidate>
  <input name="name" required />
  <input name="email" type="email" />
  <input name="phone" inputmode="tel" />
  <textarea name="motivo"></textarea>

  <!-- Honeypot: precisa chegar VAZIO. Escondido por CSS, nunca por
       type="hidden" (robô preenche hidden com mais frequência). -->
  <input name="website" tabindex="-1" autocomplete="off" class="fora-da-tela" />

  <div class="cf-turnstile" data-sitekey="SUA_SITE_KEY" data-action="formulario"></div>
  <button type="submit">Enviar</button>
</form>
```

```js
const ENDPOINT = "https://app.exemplo.com.br/api/forms/SUA_CHAVE_PUBLICA";
const CONTRACT_VERSION = 1;
const STORAGE_KEY = "praxis:form:source-event-id";

/** Conteúdo de negócio da submissão — sem token, sem honeypot. */
function lerConteudo(form) {
  const data = new FormData(form);
  return {
    contact: {
      name: String(data.get("name") ?? ""),
      type: "pf",
      email: String(data.get("email") ?? ""),
      phone: String(data.get("phone") ?? ""),
    },
    answers: { motivo: String(data.get("motivo") ?? "") },
    attribution: lerAtribuicao(),
    consent: { decision: "granted", textVersion: "v1" },
  };
}

/** UTM/gclid/fbclid/landing/referrer capturados na chegada, não no envio. */
function lerAtribuicao() {
  const params = new URLSearchParams(location.search);
  return {
    channel: "formulario",
    source: params.get("utm_source") ?? undefined,
    medium: params.get("utm_medium") ?? undefined,
    campaign: params.get("utm_campaign") ?? undefined,
    content: params.get("utm_content") ?? undefined,
    term: params.get("utm_term") ?? undefined,
    gclid: params.get("gclid") ?? undefined,
    fbclid: params.get("fbclid") ?? undefined,
    landingUrl: location.href,
    referrer: document.referrer || undefined,
  };
}

/**
 * O UUID é da SUBMISSÃO, não da tentativa. Guardado junto de uma
 * impressão do conteúdo: se o visitante editar materialmente o que
 * escreveu, começa uma submissão nova — e portanto um UUID novo.
 */
function obterSourceEventId(conteudo) {
  const impressao = JSON.stringify(conteudo);
  let guardado = null;
  try {
    guardado = JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? "null");
  } catch {
    guardado = null;
  }

  if (guardado && guardado.impressao === impressao) return guardado.id;

  const id = crypto.randomUUID();
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ id, impressao }));
  } catch {
    // sessionStorage bloqueado: o UUID em memória ainda serve para os
    // retries desta página.
  }
  return id;
}

function limparSourceEventId() {
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    /* nada a fazer */
  }
}

async function enviar(form, { tentativa = 1 } = {}) {
  const conteudo = lerConteudo(form);
  const sourceEventId = obterSourceEventId(conteudo);

  // Token RENOVADO a cada tentativa — sem trocar o UUID. É exatamente por
  // isso que o token fica fora do hash de conteúdo do servidor.
  const turnstileToken = window.turnstile.getResponse();

  const resposta = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sourceEventId,
      contractVersion: CONTRACT_VERSION,
      occurredAt: new Date().toISOString(),
      turnstileToken,
      website: String(new FormData(form).get("website") ?? ""),
      ...conteudo,
    }),
  });

  if (resposta.status === 202) {
    const { protocol } = await resposta.json();
    limparSourceEventId(); // confirmação definitiva
    window.turnstile.reset();
    return { ok: true, protocol };
  }

  if (resposta.status === 409) {
    // Mesma chave com conteúdo diferente: o envio anterior VALEU. Não
    // reenviar; avisar que já foi recebido.
    limparSourceEventId();
    return { ok: false, motivo: "ja_recebido" };
  }

  if (resposta.status === 429) return { ok: false, motivo: "muitas_tentativas" };
  if (resposta.status === 403) {
    window.turnstile.reset();
    // Retry com token novo e o MESMO UUID.
    if (tentativa < 2) return enviar(form, { tentativa: tentativa + 1 });
  }

  return { ok: false, motivo: "falha" };
}
```

## O que o servidor devolve

| Situação | Resposta |
|---|---|
| Evento novo | `202 { "protocol": "...", "status": "received" }` |
| Repetição legítima (mesmo UUID, mesmo conteúdo) | **exatamente igual** ao acima, mesmo protocolo |
| Evento já processado, purgado ou expirado | **exatamente igual** ao acima |
| Mesmo UUID, conteúdo diferente | `409 { "error": "idempotency_payload_conflict" }` |
| Endpoint desconhecido, desativado ou chave revogada | `404 { "error": "form_endpoint_unavailable" }` |
| Turnstile inválido, hostname/action errados | `403 { "error": "captcha_failed" }` |
| Rate limit | `429 { "error": "rate_limited" }` |
| Corpo grande demais | `413 { "error": "payload_too_large" }` |
| Configuração do servidor ausente | `503 { "error": "service_unavailable" }` |

A resposta **nunca** devolve id interno, id de contato/lead/oportunidade,
se a pessoa já era conhecida, resultado de deduplicação ou estado do
worker. O `protocol` é opaco e serve só para o visitante referenciar o
envio.
