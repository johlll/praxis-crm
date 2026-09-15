import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Estabilização pós-A9 — inventário §1b (primeira página tratada como lista
 * completa) e §2 ("Tentar novamente" que não refaz a busca).
 */

type Result = { data: unknown; error: { message: string } | null; count?: number | null };

const state = vi.hoisted(() => ({
  rpc: (() => ({ data: null, error: null })) as (fn: string, args: Record<string, unknown>) => Result,
  table: (() => ({ data: [], error: null, count: 0 })) as (range: [number, number] | null) => Result,
}));

function queryBuilder() {
  let range: [number, number] | null = null;
  const settle = () => Promise.resolve(state.table(range));
  const builder: Record<string | symbol, unknown> = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "then") return (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => settle().then(res, rej);
        if (prop === "range") return (from: number, to: number) => ((range = [from, to]), builder);
        return () => builder;
      },
    },
  );
  return builder;
}

vi.mock("@/server/supabase/server", () => ({
  createServerSupabaseClient: async () => ({
    rpc: async (fn: string, args: Record<string, unknown>) => state.rpc(fn, args),
    from: () => queryBuilder(),
  }),
}));

const { listAllLeads, listContactOptions } = await import("@/modules/leads/queries");
const { listAllOpportunities } = await import("@/modules/opportunities/queries");
const { DataLoadError } = await import("@/server/data/load-error");

function leadRow(i: number) {
  return {
    id: `lead-${i}`,
    contact_id: `c-${i}`,
    contact_name: `Contato ${i}`,
    legal_area: "Cível",
    summary: null,
    tags: [],
    priority: "media",
    status: "ativo",
    assigned_to: null,
    assigned_to_name: null,
    created_at: "2026-09-01",
    updated_at: "2026-09-01",
  };
}

/** Simula list_leads/list_opportunities paginando `total` linhas de verdade. */
function paginatedRpc(total: number, row: (i: number) => Record<string, unknown>, failPage?: number) {
  return (_fn: string, args: Record<string, unknown>): Result => {
    const page = args.p_page as number;
    const size = args.p_page_size as number;
    if (page === failPage) return { data: null, error: { message: "timeout" } };
    const start = (page - 1) * size;
    const items = Array.from({ length: Math.max(0, Math.min(size, total - start)) }, (_, k) => row(start + k));
    return { data: [{ items, total_count: total }], error: null };
  };
}

beforeEach(() => {
  state.rpc = () => ({ data: null, error: null });
  state.table = () => ({ data: [], error: null, count: 0 });
});

describe("§1b listas completas além do limite de uma página", () => {
  it("listAllLeads traz os 250 leads, não só os 20 da primeira página", async () => {
    state.rpc = paginatedRpc(250, leadRow);
    const leads = await listAllLeads("ws", { status: "ativo" });
    expect(leads).toHaveLength(250);
    expect(new Set(leads.map((l) => l.id)).size).toBe(250);
  });

  it("listAllLeads lança DataLoadError se uma página intermediária falhar — nunca lista parcial", async () => {
    state.rpc = paginatedRpc(250, leadRow, 2);
    await expect(listAllLeads("ws")).rejects.toBeInstanceOf(DataLoadError);
  });

  it("listAllLeads lança DataLoadError se uma página vier vazia antes do total", async () => {
    state.rpc = (_fn, args) =>
      (args.p_page as number) === 1
        ? { data: [{ items: Array.from({ length: 100 }, (_, i) => leadRow(i)), total_count: 150 }], error: null }
        : { data: [{ items: [], total_count: 150 }], error: null };
    await expect(listAllLeads("ws")).rejects.toBeInstanceOf(DataLoadError);
  });

  it("listAllOpportunities traz as 130 oportunidades do lead", async () => {
    state.rpc = paginatedRpc(130, (i) => ({
      id: `o-${i}`,
      lead_id: "lead-1",
      contact_name: "X",
      legal_area: "Cível",
      pipeline_id: "p1",
      stage_id: "s1",
      stage_name: "Etapa",
      status: "open",
      client_id: null,
      stage_entered_at: "2026-09-01",
      created_at: "2026-09-01",
      updated_at: "2026-09-01",
      lock_version: 0,
      next_action: null,
      overdue_activities_count: 0,
    }));
    await expect(listAllOpportunities("ws", { leadId: "lead-1" })).resolves.toHaveLength(130);
  });

  it("listContactOptions passa do teto de 1.000 linhas do PostgREST em blocos", async () => {
    const total = 1_234;
    state.table = (range) => {
      const [from, to] = range ?? [0, 999];
      const upper = Math.min(to, total - 1, from + 999); // o servidor nunca devolve mais que max_rows
      const data = Array.from({ length: Math.max(0, upper - from + 1) }, (_, k) => ({ id: `c-${from + k}`, name: `C ${from + k}` }));
      return { data, error: null, count: total };
    };
    const options = await listContactOptions("ws");
    expect(options).toHaveLength(total);
    expect(new Set(options.map((o) => o.id)).size).toBe(total);
  });
});

describe("§2 error.tsx refaz a busca", () => {
  const appDir = join(process.cwd(), "src", "app");

  function findErrorFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((entry) => {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) return findErrorFiles(full);
      return entry === "error.tsx" ? [full] : [];
    });
  }

  it("nenhum error.tsx usa reset() (não busca de novo no servidor)", () => {
    const offenders = findErrorFiles(appDir).filter((file) => /\breset\b/.test(readFileSync(file, "utf8")));
    expect(offenders).toEqual([]);
  });

  it("toda rota autenticada tem limite de erro próprio ou herdado de (app)/error.tsx, e o layout é coberto", () => {
    const files = findErrorFiles(appDir).map((f) => f.replace(appDir, "").replaceAll("\\", "/"));
    expect(files).toContain("/(app)/error.tsx");
    expect(files).toContain("/error.tsx");
  });

  it.each(findErrorFilesSafe())("%s chama retry ao clicar em 'Tentar novamente'", async (relative) => {
    const mod = await import(/* @vite-ignore */ join(appDir, relative));
    const retry = vi.fn();
    const Boundary = mod.default as (props: { error: Error; retry: () => void }) => React.ReactElement;
    render(<Boundary error={Object.assign(new Error("falha"), { digest: "x" })} retry={retry} />);
    fireEvent.click(screen.getByRole("button", { name: /tentar novamente/i }));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  function findErrorFilesSafe(): string[] {
    try {
      return findErrorFiles(appDir).map((f) => f.replace(appDir, "").replaceAll("\\", "/"));
    } catch {
      return [];
    }
  }
});
