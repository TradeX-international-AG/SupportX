import assert from "node:assert/strict";
import { after, afterEach, describe, it } from "node:test";
import { createCreditNote, lookupCreditNote, setCreditNotesEnabled, settleUncertainCreditNote } from "../../packages/services/credit-notes.ts";
import { getCase } from "../../packages/services/cases.ts";
import type { ServiceError } from "../../packages/services/context.ts";
import { many, one } from "../../packages/storage/db.ts";
import { caseByThread, closeDb, createHarness, loadDemoMails, seedWorkspace, syncAndDrain, type Harness, type SeededWorkspace } from "./harness.ts";

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});
after(closeDb);

const code = (p: Promise<unknown>, expected: string) => assert.rejects(p, (e: ServiceError) => e.code === expected);

async function setup(): Promise<{ h: Harness; s: SeededWorkspace; caseId: string }> {
  h = await createHarness();
  const s = await seedWorkspace(h);
  loadDemoMails(h.graph);
  await syncAndDrain(h, s);
  const conv = await caseByThread(h, s, "conv-amazon-wismo");
  return { h, s, caseId: conv.id };
}

const posts = (h: Harness) => h.weclapp.requests.filter((r) => !r.startsWith("GET "));

describe("Gutschrift-Entwurf in weclapp aus dem Fall", () => {
  it("is off until the owner switches it on, and only a person can do it", async () => {
    const { h, s, caseId } = await setup();
    await code(lookupCreditNote(h.ctx, s.agent, caseId), "CREDIT_NOTES_OFF");
    await code(setCreditNotesEnabled(h.ctx, s.agent, true), "FORBIDDEN");
    await setCreditNotesEnabled(h.ctx, s.owner, true);
    assert.equal((await getCase(h.ctx, s.agent, caseId)).creditNotesEnabled, true);
    await code(lookupCreditNote(h.ctx, s.viewer, caseId), "FORBIDDEN");
    await code(createCreditNote(h.ctx, { type: "worker", workspaceId: s.workspaceId }, caseId, { invoiceId: "inv-1", lines: [{ itemId: "invi-1", amount: "1" }], confirm: true, expectedTotalCents: 100 }), "FORBIDDEN");
    const other = await seedWorkspace(h, "Anderer Händler");
    await code(lookupCreditNote(h.ctx, other.owner, caseId), "NOT_FOUND");
    assert.equal(posts(h).length, 0);
  });

  it("proposes from the refund list, creates a draft with the confirmed amounts and caps later ones", async () => {
    const { h, s, caseId } = await setup();
    await setCreditNotesEnabled(h.ctx, s.owner, true);
    await h.ctx.db.query("INSERT INTO refund_entries (workspace_id, conversation_id, added_manually, amount_cents, currency) VALUES ($1, $2, true, 990, 'EUR')", [s.workspaceId, caseId]);
    const view = await lookupCreditNote(h.ctx, s.agent, caseId);
    const inv = view.invoices.find((i) => i.id === "inv-1")!;
    assert.equal(inv.grossCents, 4470);
    assert.equal(inv.items[0]!.articleNumber, "D-1001");
    assert.equal(Object.values(inv.proposal.lines).reduce((a, b) => a + b, 0), 990);

    const input = { invoiceId: "inv-1", lines: [{ itemId: "invi-2", amount: "9,90" }], confirm: true as const, expectedTotalCents: 990 };
    await code(createCreditNote(h.ctx, s.agent, caseId, { ...input, confirm: false as unknown as true }), "CONFIRM_REQUIRED");
    await code(createCreditNote(h.ctx, s.agent, caseId, { ...input, expectedTotalCents: 1000 }), "TOTAL_CHANGED");
    await code(createCreditNote(h.ctx, s.agent, caseId, { ...input, lines: [{ itemId: "invi-2", amount: "19,81" }], expectedTotalCents: 1981 }), "INVALID");
    await code(createCreditNote(h.ctx, s.agent, caseId, { ...input, invoiceId: "inv-2" }), "NOT_FOUND");
    assert.equal(posts(h).length, 0, "nothing written before a valid confirmation");

    const r = await createCreditNote(h.ctx, s.agent, caseId, input);
    assert.equal(r.state, "created", r.error);
    assert.equal(r.resultCents, 990);
    const note = h.weclapp.data.salesInvoice.find((i) => i.salesInvoiceType === "CREDIT_NOTE")!;
    assert.equal(note.status, "NEW", "draft, not booked");
    assert.equal((note.salesInvoiceItems as unknown[]).length, 1);
    assert.equal(note.grossAmount, "9.90");
    assert.ok(!h.weclapp.requests.some((x) => x.includes("createCreditNoteOpenItem")), "never books");
    const entry = await one<{ credit_note_number: string; done_at: Date | null }>(h.ctx.db, "SELECT credit_note_number, done_at FROM refund_entries WHERE conversation_id = $1", [caseId]);
    assert.equal(entry!.credit_note_number, r.creditNoteNumber);
    assert.equal(entry!.done_at, null, "ticking done stays with the person");

    // What is left of the invoice: 44,70 − 9,90.
    await code(createCreditNote(h.ctx, s.agent, caseId, { invoiceId: "inv-1", lines: [{ itemId: "invi-1", amount: "24,90" }, { itemId: "invi-2", amount: "19,80" }], confirm: true, expectedTotalCents: 4470 }), "INVALID");
    const log = await many<{ action: string }>(h.ctx.db, "SELECT action FROM audit_events WHERE target_id = $1 AND action LIKE 'erp.credit_note%'", [caseId]);
    assert.deepEqual(log.map((l) => l.action), ["erp.credit_note_created"]);
  });

  it("reports a read-only token, a draft without amounts and an unclear request", async () => {
    const { h, s, caseId } = await setup();
    await setCreditNotesEnabled(h.ctx, s.owner, true);
    const input = { invoiceId: "inv-1", lines: [{ itemId: "invi-1", amount: "5,00" }], confirm: true as const, expectedTotalCents: 500 };

    h.weclapp.writeFault = "forbidden";
    const denied = await createCreditNote(h.ctx, s.agent, caseId, input);
    assert.equal(denied.state, "failed");
    assert.match(denied.error!, /403/);

    h.weclapp.writeFault = "put_fails";
    const review = await createCreditNote(h.ctx, s.agent, caseId, input);
    assert.equal(review.state, "needs_review");
    assert.match(review.error!, /in weclapp anpassen/);

    h.weclapp.writeFault = "reset";
    const unclear = await createCreditNote(h.ctx, s.agent, caseId, input);
    assert.equal(unclear.state, "uncertain");
    h.weclapp.writeFault = "none";
    await code(createCreditNote(h.ctx, s.agent, caseId, input), "UNCERTAIN");
    await settleUncertainCreditNote(h.ctx, s.agent, caseId, unclear.id, { confirm: true, outcome: "none" });
    assert.equal((await createCreditNote(h.ctx, s.agent, caseId, input)).state, "created");
  });
});
