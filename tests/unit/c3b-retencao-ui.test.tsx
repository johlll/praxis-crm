/**
 * C3b — painel de retenção dentro da seção "Privacidade e LGPD": estado em linguagem clara,
 * motivos de bloqueio, preservação legal, anonimização com confirmação forte e a tela depois de
 * anonimizar (sem nada do que existia antes). A exportação da C3a segue como estava.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ContactPrivacySection } from "@/components/contacts/contact-privacy-section";
import type { RetentionStatus } from "@/modules/privacy/retention";

const CONTACT = "c0000000-0000-0000-0000-000000000001";
const HOLD = "d0000000-0000-0000-0000-000000000001";
const root = resolve(import.meta.dirname, "../..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8").split("\r").join("");

const base: RetentionStatus = {
  state: "eligible",
  eligible: true,
  reasons: [],
  lead_count: 1,
  archived_lead_count: 1,
  retention_due_at: "2025-06-15T12:00:00+00:00",
  anonymized_at: null,
  retention_months: 12,
  holds: [],
};
const blocked = (reasons: RetentionStatus["reasons"], over: Partial<RetentionStatus> = {}): RetentionStatus => ({
  ...base,
  state: "blocked",
  eligible: false,
  reasons,
  ...over,
});
const anonymized: RetentionStatus = { ...base, state: "anonymized", eligible: false, lead_count: 0, archived_lead_count: 0, retention_due_at: null, anonymized_at: "2026-11-11T15:00:00+00:00" };

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("exibição e permissão", () => {
  it("a tela do contato carrega o estado da retenção só para quem tem privacy.manage", () => {
    const page = read("src/app/(app)/contatos/[id]/page.tsx");
    expect(page).toContain('roleHasPermission(user.role, "privacy.manage")');
    expect(page).toMatch(/canExportPrivacy \? await getRetentionStatus\(contact\.id\) : null/);
    expect(page).toContain("initialRetention={retention?.ok ? retention.status : null}");
  });

  it("sem a propriedade de retenção (uso da C3a), o painel não aparece e a exportação segue igual", () => {
    render(<ContactPrivacySection contactId={CONTACT} />);
    expect(screen.queryByText("Retenção e anonimização")).toBeNull();
    expect(screen.getByRole("button", { name: "Exportar dados do titular" })).toBeTruthy();
  });
});

describe("painel de retenção", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("estado indisponível: aviso claro e nenhuma ação", () => {
    render(<ContactPrivacySection contactId={CONTACT} initialRetention={null} />);
    expect(screen.getByText(/Não foi possível carregar o estado de retenção/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Anonimizar contato" })).toBeNull();
  });

  it("bloqueado: mostra cada motivo em linguagem clara (com o vencimento do prazo) e não oferece anonimizar", () => {
    render(
      <ContactPrivacySection
        contactId={CONTACT}
        initialRetention={blocked(["retention_period_open", "client_present", "proposal_document_present"], { retention_due_at: "2027-03-10T12:00:00+00:00" })}
      />,
    );
    expect(screen.getByText(/Anonimização bloqueada/)).toBeTruthy();
    expect(screen.getByText(/Prazo de retenção de 12 meses em andamento; vence em 10\/03\/2027/)).toBeTruthy();
    expect(screen.getByText(/O contato é cliente/)).toBeTruthy();
    expect(screen.getByText(/PDF ou e-mail enviado, guardados fora do banco; é necessária revisão humana/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Anonimizar contato" })).toBeNull();
  });

  it("elegível: informa o prazo cumprido e oferece anonimizar", () => {
    render(<ContactPrivacySection contactId={CONTACT} initialRetention={base} />);
    expect(screen.getByText(/Elegível para anonimização/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Anonimizar contato" })).toBeTruthy();
    expect(screen.getByText(/Leads arquivados são retidos por 12 meses/)).toBeTruthy();
  });

  it("nada é chamado antes da confirmação; cancelar volta sem chamar o servidor", () => {
    render(<ContactPrivacySection contactId={CONTACT} initialRetention={base} />);
    fireEvent.click(screen.getByRole("button", { name: "Anonimizar contato" }));
    expect(screen.getByText(/Esta ação é/)).toBeTruthy();
    expect(screen.getByText(/irreversível/)).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: "Cancelar" })[0]!);
    expect(screen.getByRole("button", { name: "Anonimizar contato" })).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("confirmação forte: o botão só habilita com ANONIMIZAR digitado exatamente", () => {
    render(<ContactPrivacySection contactId={CONTACT} initialRetention={base} />);
    fireEvent.click(screen.getByRole("button", { name: "Anonimizar contato" }));
    const final = screen.getByRole("button", { name: "Anonimizar definitivamente" }) as HTMLButtonElement;
    const input = screen.getByLabelText("Digite ANONIMIZAR para confirmar");
    expect(final.disabled).toBe(true);
    fireEvent.change(input, { target: { value: "anonimizar" } });
    expect(final.disabled).toBe(true);
    fireEvent.change(input, { target: { value: "ANONIMIZAR" } });
    expect(final.disabled).toBe(false);
  });

  it("anonimizar: envia só a ação e a confirmação; depois mostra o contato anonimizado, sem dado anterior e sem exportar", async () => {
    fetchMock.mockResolvedValue(json({ status: anonymized, outcome: "anonymized" }));
    render(<ContactPrivacySection contactId={CONTACT} initialRetention={base} />);
    fireEvent.click(screen.getByRole("button", { name: "Anonimizar contato" }));
    fireEvent.change(screen.getByLabelText("Digite ANONIMIZAR para confirmar"), { target: { value: "ANONIMIZAR" } });
    fireEvent.click(screen.getByRole("button", { name: "Anonimizar definitivamente" }));

    await waitFor(() => expect(screen.getByText(/Contato anonimizado em 11\/11\/2026/)).toBeTruthy());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`/api/privacy/contacts/${CONTACT}/retention`);
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ action: "anonymize", confirmation: "ANONIMIZAR" });
    // Depois de anonimizar: nada para exportar, anonimizar ou preservar.
    expect(screen.queryByRole("button", { name: "Exportar dados do titular" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Anonimizar contato" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Criar preservação" })).toBeNull();
    expect(screen.getByText(/removidos de forma irreversível/)).toBeTruthy();
  });

  it("recusa do banco (a situação mudou): aviso, motivos atualizados e o contato segue como estava", async () => {
    fetchMock.mockResolvedValue(json({ status: blocked(["legal_hold_active"]), outcome: "refused" }));
    render(<ContactPrivacySection contactId={CONTACT} initialRetention={base} />);
    fireEvent.click(screen.getByRole("button", { name: "Anonimizar contato" }));
    fireEvent.change(screen.getByLabelText("Digite ANONIMIZAR para confirmar"), { target: { value: "ANONIMIZAR" } });
    fireEvent.click(screen.getByRole("button", { name: "Anonimizar definitivamente" }));

    await waitFor(() => expect(screen.getByText(/A anonimização foi recusada/)).toBeTruthy());
    expect(screen.getByText(/Há preservação legal ativa/)).toBeTruthy();
    expect(screen.queryByText(/Contato anonimizado em/)).toBeNull();
  });

  it("falha do servidor: mensagem genérica, sem detalhe técnico", async () => {
    fetchMock.mockResolvedValue(json({ error: "retention_failed" }, 500));
    render(<ContactPrivacySection contactId={CONTACT} initialRetention={base} />);
    fireEvent.click(screen.getByRole("button", { name: "Anonimizar contato" }));
    fireEvent.change(screen.getByLabelText("Digite ANONIMIZAR para confirmar"), { target: { value: "ANONIMIZAR" } });
    fireEvent.click(screen.getByRole("button", { name: "Anonimizar definitivamente" }));
    await waitFor(() => expect(screen.getByText(/Nada foi alterado/)).toBeTruthy());
    expect(screen.queryByText(/retention_failed/)).toBeNull();
  });

  it("criar preservação legal: motivo em código fechado e estado atualizado", async () => {
    fetchMock.mockResolvedValue(
      json({
        status: blocked(["legal_hold_active"], { holds: [{ id: HOLD, reason_code: "case_in_progress", status: "active", created_at: "2026-11-11T12:00:00+00:00", released_at: null }] }),
        outcome: null,
      }),
    );
    render(<ContactPrivacySection contactId={CONTACT} initialRetention={base} />);
    fireEvent.change(screen.getByLabelText("Motivo da preservação legal"), { target: { value: "case_in_progress" } });
    fireEvent.click(screen.getByRole("button", { name: "Criar preservação" }));

    await waitFor(() => expect(screen.getByText(/Caso em andamento — desde 11\/11\/2026/)).toBeTruthy());
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body as string)).toEqual({ action: "hold_create", reasonCode: "case_in_progress" });
    expect(screen.getByText(/Preservação legal registrada/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Anonimizar contato" })).toBeNull();
  });

  it("encerrar preservação: envia só o id e volta ao estado elegível", async () => {
    fetchMock.mockResolvedValue(json({ status: base, outcome: null }));
    render(
      <ContactPrivacySection
        contactId={CONTACT}
        initialRetention={blocked(["legal_hold_active"], { holds: [{ id: HOLD, reason_code: "judicial_process", status: "active", created_at: "2026-11-01T12:00:00+00:00", released_at: null }] })}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Encerrar" }));
    await waitFor(() => expect(screen.getByText(/Preservação legal encerrada/)).toBeTruthy());
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body as string)).toEqual({ action: "hold_release", holdId: HOLD });
    expect(screen.getByRole("button", { name: "Anonimizar contato" })).toBeTruthy();
  });

  it("o motivo da preservação é uma lista fechada: só as cinco opções", () => {
    render(<ContactPrivacySection contactId={CONTACT} initialRetention={base} />);
    const options = Array.from((screen.getByLabelText("Motivo da preservação legal") as HTMLSelectElement).options).map((o) => o.value);
    expect(options).toEqual(["judicial_process", "legal_obligation", "case_in_progress", "regulatory_inquiry", "other_legal"]);
  });

  it("contato já anonimizado desde o carregamento: sem exportação e sem ações", () => {
    render(<ContactPrivacySection contactId={CONTACT} initialRetention={anonymized} />);
    expect(screen.getByText(/Contato anonimizado em 11\/11\/2026/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Exportar dados do titular" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Criar preservação" })).toBeNull();
  });
});
