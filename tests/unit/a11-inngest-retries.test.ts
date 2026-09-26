import { describe, expect, it } from "vitest";

/**
 * Item 9 da auditoria pós-dry-run: o total de retries do Inngest precisa
 * alinhar com o limiar que mark_webhook_event_failed()
 * (20260921100500_a11_ingestion_functions.sql) usa para marcar um evento
 * como `dead` (`attempts + 1 >= 10`). `retries: 9` = 10 execuções no
 * total (1 tentativa inicial + 9 retries) — a última execução falha
 * exatamente quando `attempts` alcança 10.
 *
 * Import isolado (só a constante): construir o cliente/função do Inngest
 * no import é inerte por design (ver comentário em src/app/api/inngest/
 * route.ts) — não exige configuração nem rede.
 */
describe("alinhamento entre retries do Inngest e o limiar de dead", () => {
  it("A11_INGEST_MAX_RETRIES produz exatamente 10 execuções no total", async () => {
    const { A11_INGEST_MAX_RETRIES } = await import("@/app/api/inngest/route");
    // 1 tentativa inicial + N retries = 10, o mesmo limiar de
    // mark_webhook_event_failed (attempts + 1 >= 10 -> dead).
    expect(1 + A11_INGEST_MAX_RETRIES).toBe(10);
  });
});
