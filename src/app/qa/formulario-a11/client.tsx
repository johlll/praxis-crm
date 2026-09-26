"use client";

import Script from "next/script";
import { useRef, useState } from "react";

/**
 * Formulário de QA da A11 — replica fielmente o contrato documentado em
 * docs/decisoes/a11-exemplo-integracao.md, servido dentro do próprio
 * praxis-crm (não a landing da Vizentini) para que o hostname deste
 * deployment possa ser declarado em "Domínios permitidos" do endpoint.
 *
 * A chave pública do endpoint e a site key do Turnstile vêm de env vars
 * públicas — nada sensível aqui, as duas já nasceram para ir ao navegador.
 */

const ENDPOINT_KEY = process.env.NEXT_PUBLIC_QA_A11_FORM_ENDPOINT_KEY ?? "";
const TURNSTILE_SITE_KEY = process.env.NEXT_PUBLIC_QA_TURNSTILE_SITE_KEY ?? "";
const CONTRACT_VERSION = 1;
const STORAGE_KEY = "praxis:qa-form:source-event-id";
const TEXTO_CONSENTIMENTO_V1 =
  "Concordo com o uso dos meus dados de contato para que o escritório entre em contato comigo sobre este assunto.";

declare global {
  interface Window {
    turnstile?: {
      render: (container: HTMLElement, options: Record<string, unknown>) => string;
      getResponse: (widgetId?: string) => string | undefined;
      reset: (widgetId?: string) => void;
    };
  }
}

type Resultado =
  | { ok: true; protocol: string }
  | { ok: false; motivo: string }
  | null;

function lerConteudo(form: HTMLFormElement) {
  const data = new FormData(form);
  return {
    contact: {
      name: String(data.get("name") ?? ""),
      type: "pf",
      email: String(data.get("email") ?? ""),
      phone: String(data.get("phone") ?? ""),
    },
    answers: {
      telefone_alternativo: String(data.get("telefone_alternativo") ?? ""),
      melhor_horario: String(data.get("melhor_horario") ?? ""),
    },
    attribution: lerAtribuicao(),
    consent: { decision: "granted", textVersion: "v1", acceptedText: TEXTO_CONSENTIMENTO_V1 },
  };
}

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

function obterIdentidadeDaSubmissao(conteudo: unknown) {
  const impressao = JSON.stringify(conteudo);
  let guardado: { id: string; occurredAt: string; impressao: string } | null = null;
  try {
    guardado = JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? "null");
  } catch {
    guardado = null;
  }

  if (guardado && guardado.impressao === impressao) {
    return { id: guardado.id, occurredAt: guardado.occurredAt };
  }

  const id = crypto.randomUUID();
  const occurredAt = new Date().toISOString();
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ id, occurredAt, impressao }));
  } catch {
    // sessionStorage bloqueado: valores em memória ainda servem para retries.
  }
  return { id, occurredAt };
}

function limparSourceEventId() {
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    /* nada a fazer */
  }
}

export function QaFormularioA11Client() {
  const formRef = useRef<HTMLFormElement>(null);
  const [resultado, setResultado] = useState<Resultado>(null);
  const [enviando, setEnviando] = useState(false);

  async function enviar(form: HTMLFormElement, tentativa = 1): Promise<Resultado> {
    const conteudo = lerConteudo(form);
    const { id: sourceEventId, occurredAt } = obterIdentidadeDaSubmissao(conteudo);
    const turnstileToken = window.turnstile?.getResponse() ?? "";

    const resposta = await fetch(`/api/forms/${ENDPOINT_KEY}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sourceEventId,
        contractVersion: CONTRACT_VERSION,
        occurredAt,
        turnstileToken,
        website: String(new FormData(form).get("website") ?? ""),
        ...conteudo,
      }),
    });

    if (resposta.status === 202) {
      const { protocol } = await resposta.json();
      limparSourceEventId();
      window.turnstile?.reset();
      return { ok: true, protocol };
    }

    if (resposta.status === 409) {
      limparSourceEventId();
      return { ok: false, motivo: "ja_recebido" };
    }

    if (resposta.status === 429) return { ok: false, motivo: "muitas_tentativas" };
    if (resposta.status === 403) {
      window.turnstile?.reset();
      if (tentativa < 2) return enviar(form, tentativa + 1);
    }

    let motivo = `falha_http_${resposta.status}`;
    try {
      const body = await resposta.json();
      if (body?.error) motivo = body.error;
    } catch {
      /* corpo sem JSON — mantém o motivo genérico */
    }
    return { ok: false, motivo };
  }

  return (
    <div style={{ maxWidth: 480, margin: "40px auto", fontFamily: "system-ui, sans-serif" }}>
      <h1>QA — formulário A11</h1>
      <p style={{ color: "#666", fontSize: 14 }}>
        Página só de QA, fora da landing pública da Vizentini. Endpoint:{" "}
        <code>/api/forms/{ENDPOINT_KEY || "(NEXT_PUBLIC_QA_A11_FORM_ENDPOINT_KEY ausente)"}</code>
      </p>

      {TURNSTILE_SITE_KEY ? (
        <Script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer />
      ) : (
        <p style={{ color: "#a33" }}>
          NEXT_PUBLIC_QA_TURNSTILE_SITE_KEY ausente — o envio vai falhar com{" "}
          <code>captcha_failed</code> até essa variável ser configurada.
        </p>
      )}

      <form
        ref={formRef}
        id="contato"
        noValidate
        onSubmit={async (e) => {
          e.preventDefault();
          setEnviando(true);
          const r = await enviar(e.currentTarget);
          setResultado(r);
          setEnviando(false);
        }}
        style={{ display: "flex", flexDirection: "column", gap: 8 }}
      >
        <label>
          Nome
          <input name="name" required style={{ width: "100%" }} />
        </label>
        <label>
          E-mail
          <input name="email" type="email" style={{ width: "100%" }} />
        </label>
        <label>
          Telefone
          <input name="phone" inputMode="tel" style={{ width: "100%" }} placeholder="+5511999999999" />
        </label>
        <label>
          Telefone alternativo
          <input name="telefone_alternativo" style={{ width: "100%" }} />
        </label>
        <label>
          Melhor horário para contato
          <input name="melhor_horario" style={{ width: "100%" }} />
        </label>

        {/* Honeypot — precisa chegar vazio, escondido por CSS. */}
        <input
          name="website"
          tabIndex={-1}
          autoComplete="off"
          style={{ position: "absolute", left: "-9999px" }}
          aria-hidden
        />

        {TURNSTILE_SITE_KEY ? (
          <div className="cf-turnstile" data-sitekey={TURNSTILE_SITE_KEY} data-action="formulario" />
        ) : null}

        <button type="submit" disabled={enviando}>
          {enviando ? "Enviando…" : "Enviar"}
        </button>
      </form>

      {resultado ? (
        <pre style={{ marginTop: 16, background: "#f5f5f5", padding: 12 }}>
          {JSON.stringify(resultado, null, 2)}
        </pre>
      ) : null}
    </div>
  );
}
