import type { GoogleHttp } from "@/server/calendar/google/http";

/**
 * `fetch` simulado para o adaptador do Google: registra cada requisição
 * (método, URL, cabeçalhos, corpo) e responde pelo `handler`. Nenhuma chamada
 * de rede. Dados fictícios.
 */
export type RecordedRequest = {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: string | null;
};

export type FakeReply = { status: number; json?: unknown; text?: string } | "timeout" | "network";

export function fakeGoogleHttp(handler: (req: RecordedRequest) => FakeReply | Promise<FakeReply>, timeoutMs = 50) {
  const requests: RecordedRequest[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    const req: RecordedRequest = {
      method: init?.method ?? "GET",
      url: new URL(String(input)),
      headers,
      body: typeof init?.body === "string" ? init.body : null,
    };
    requests.push(req);
    const reply = await handler(req);
    if (reply === "network") throw new TypeError("fetch failed");
    if (reply === "timeout") {
      // Nunca responde: só o prazo (AbortSignal) encerra.
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("timeout", "TimeoutError")));
      });
    }
    const body = reply.text ?? (reply.json === undefined ? "" : JSON.stringify(reply.json));
    return new Response(reply.status === 204 ? null : body, { status: reply.status });
  }) as typeof fetch;
  const http: GoogleHttp = { fetch: fetchImpl, timeoutMs };
  return { http, requests };
}

/** Corpo de erro no formato da Google Calendar API. */
export const googleError = (code: number, reason: string) => ({
  error: { code, message: "mensagem do Google (não deve vazar)", errors: [{ domain: "global", reason, message: "x" }] },
});

/** ID token fictício (assinatura irrelevante: o token vem direto do endpoint por TLS). */
export function fakeIdToken(claims: Record<string, unknown>): string {
  const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
  return `${b64({ alg: "RS256", typ: "JWT" })}.${b64(claims)}.assinatura-ficticia`;
}
