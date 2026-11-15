import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkCreditNote, proposeCreditNote } from "../../packages/core/credit-note.ts";
import type { CreditSourceInvoice } from "../../packages/core/contracts.ts";

// Synthetic invoice only.
const invoice: CreditSourceInvoice = {
  id: "inv", invoiceNumber: "RE-1", status: "OPEN_ITEM_CREATED", type: "STANDARD_INVOICE", currency: "EUR", grossCents: 4960, shippingGrossCents: 490,
  items: [{ id: "a", title: "Artikel A", articleNumber: "SKU-A", quantity: 1, grossCents: 2490 }, { id: "b", title: "Artikel B", articleNumber: "SKU-B", quantity: 2, grossCents: 1980 }],
};

describe("Gutschrift-Vorschlag", () => {
  it("matches marketplace refund lines by article number", () => {
    const p = proposeCreditNote(invoice, { kind: "marketplace", label: "Amazon", lines: [{ sku: "sku-b", principalCents: 990 }], shippingCents: 490 });
    assert.deepEqual(p.lines, { a: 0, b: 990 });
    assert.equal(p.shippingCents, 490);
    assert.match(p.note, /Artikelnummer/);
  });

  it("spreads in proportion when the numbers do not match, never above a line", () => {
    const p = proposeCreditNote(invoice, { kind: "marketplace", label: "Amazon", lines: [{ sku: "OTHER", principalCents: 894 }], shippingCents: 0 });
    assert.equal(p.lines.a! + p.lines.b!, 894);
    assert.ok(p.lines.a! <= 2490 && p.lines.b! <= 1980);
    assert.match(p.note, /anteilig/);
  });

  it("spreads a plain amount over lines, then shipping; no source = whole invoice", () => {
    const p = proposeCreditNote(invoice, { kind: "amount", label: "Liste", cents: 4960 });
    assert.deepEqual(p.lines, { a: 2490, b: 1980 });
    assert.equal(p.shippingCents, 490);
    assert.deepEqual(proposeCreditNote(invoice, null).lines, { a: 2490, b: 1980 });
  });

  it("checks the amounts", () => {
    assert.deepEqual(checkCreditNote(invoice, [{ itemId: "a", grossCents: 2490 }, { itemId: "b", grossCents: 0 }], 490, 0), { ok: true, lines: [{ itemId: "a", grossCents: 2490 }], shippingCents: 490, totalCents: 2980 });
    assert.equal(checkCreditNote(invoice, [{ itemId: "a", grossCents: 2491 }], 0, 0).ok, false);
    assert.equal(checkCreditNote(invoice, [{ itemId: "a", grossCents: 100 }], 491, 0).ok, false);
    assert.equal(checkCreditNote(invoice, [{ itemId: "x", grossCents: 100 }], 0, 0).ok, false);
    assert.equal(checkCreditNote(invoice, [{ itemId: "a", grossCents: 2490 }], 0, 4000).ok, false, "earlier credit notes count");
    assert.equal(checkCreditNote({ ...invoice, type: "CREDIT_NOTE" }, [{ itemId: "a", grossCents: 1 }], 0, 0).ok, false);
    assert.equal(checkCreditNote(invoice, [], 0, 0).ok, false);
  });
});
