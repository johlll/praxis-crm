import type { ConsumeResult, OAuthSession, OAuthStateStore } from "@/server/calendar/google/oauth-flow";
import type { ProviderTokens } from "@/server/calendar/provider";

/**
 * Espelhos em memória das RPCs da migration `20261013100000_b2_google_oauth`
 * (o banco real é coberto pelo pgTAP `26_b2_google_oauth`):
 *  - `begin/consume_calendar_oauth`: consumir APAGA (uso único) e só depois
 *    confere prazo, ambiente, sessão e navegador;
 *  - `connect_calendar_identity`: identidade da conta, cliente OAuth e regra
 *    do refresh token ausente.
 */

type Row = {
  stateHash: string;
  browserHash: string;
  nonceHash: string;
  verifierCiphertext: string;
  keyVersion: string;
  session: OAuthSession;
  environment: string;
  expiresAt: number;
};

export class MemoryOAuthStates implements OAuthStateStore {
  rows: Row[] = [];
  /** Ambiente autenticado da requisição (o banco o lê do cabeçalho assinado). */
  environment = "preview";

  constructor(readonly now: () => Date) {}

  async begin(p: Parameters<OAuthStateStore["begin"]>[0]): Promise<void> {
    this.rows = this.rows.filter((r) => r.expiresAt >= this.now().getTime());
    this.rows.push({ ...p, environment: this.environment, expiresAt: this.now().getTime() + 10 * 60_000 });
  }

  async consume(p: { stateHash: string; session: OAuthSession; browserHash: string | null }): Promise<ConsumeResult> {
    const index = this.rows.findIndex((r) => r.stateHash === p.stateHash);
    if (index < 0) return { status: "not_found" };
    const [row] = this.rows.splice(index, 1);
    if (row!.expiresAt < this.now().getTime()) return { status: "expired" };
    if (row!.environment !== this.environment) return { status: "wrong_environment" };
    if (row!.session.userId !== p.session.userId || row!.session.workspaceId !== p.session.workspaceId) return { status: "session_mismatch" };
    if (!p.browserHash || row!.browserHash !== p.browserHash) return { status: "browser_mismatch" };
    return { status: "ok", nonceHash: row!.nonceHash, verifierCiphertext: row!.verifierCiphertext, keyVersion: row!.keyVersion };
  }
}

export type MemoryConnection = {
  id: string;
  userId: string;
  workspaceId: string;
  subject: string | null;
  clientId: string | null;
  email: string;
  refreshToken: string | null;
  accessToken: string;
  keyVersion: string;
  status: "active" | "needs_reauth" | "disconnected";
  calendarId: string | null;
};

export class MemoryIdentityConnections {
  rows: MemoryConnection[] = [];
  keyVersion = "v1";
  private seq = 0;

  connect = async (session: OAuthSession, tokens: ProviderTokens): Promise<{ connectionId: string; refreshKept: boolean }> => {
    if (this.rows.some((c) => c.workspaceId === session.workspaceId && c.status !== "disconnected" && c.subject === tokens.accountSubject && c.userId !== session.userId)) {
      throw new Error("calendar_account_in_use");
    }
    const existing = this.rows.find((c) => c.workspaceId === session.workspaceId && c.userId === session.userId && c.status !== "disconnected");
    let kept = false;
    if (existing) {
      if (existing.subject !== null && existing.subject !== tokens.accountSubject) throw new Error("calendar_account_mismatch");
      const same = existing.subject === tokens.accountSubject || (existing.subject === null && existing.email === tokens.accountEmail);
      if (!tokens.refreshToken) {
        if (
          existing.subject !== tokens.accountSubject ||
          existing.clientId !== tokens.oauthClientId ||
          existing.keyVersion !== this.keyVersion ||
          existing.status !== "active" ||
          !existing.refreshToken
        ) {
          throw new Error("refresh_token_missing");
        }
        kept = true;
      }
      Object.assign(existing, {
        subject: tokens.accountSubject,
        clientId: tokens.oauthClientId,
        email: tokens.accountEmail,
        refreshToken: kept ? existing.refreshToken : tokens.refreshToken,
        accessToken: tokens.accessToken,
        keyVersion: this.keyVersion,
        status: "active",
        calendarId: same ? existing.calendarId : null,
      });
      return { connectionId: existing.id, refreshKept: kept };
    }
    if (!tokens.refreshToken) throw new Error("refresh_token_missing");
    this.seq += 1;
    const row: MemoryConnection = {
      id: `conexao-${this.seq}`,
      userId: session.userId,
      workspaceId: session.workspaceId,
      subject: tokens.accountSubject,
      clientId: tokens.oauthClientId,
      email: tokens.accountEmail,
      refreshToken: tokens.refreshToken,
      accessToken: tokens.accessToken,
      keyVersion: this.keyVersion,
      status: "active",
      calendarId: null,
    };
    this.rows.push(row);
    return { connectionId: row.id, refreshKept: false };
  };
}
