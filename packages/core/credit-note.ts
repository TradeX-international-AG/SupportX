import type { CreditSourceInvoice } from "./contracts.ts";

/**
 * Credit note draft in the ERP from a refund (pure logic, shared by server and
 * browser). SupportX proposes the amounts per invoice line from what was
 * refunded; a person checks them and confirms the total. The ERP creates the
 * credit note as a draft; booking stays with the person in the ERP.
 */

/** What was refunded, as far as SupportX knows. */
export type CreditSource =
  | { kind: "marketplace"; label: string; lines: ReadonlyArray<{ sku?: string; title?: string; principalCents: number }>; shippingCents: number }
  | { kind: "amount"; label: string; cents: number }
  | null;

export interface CreditProposal {
  lines: Record<string, number>;
  shippingCents: number;
  /** How the amounts were found, for the person. */
  note: string;
}

const norm = (v: string | undefined) => v?.trim().toLowerCase() ?? "";

/** Spreads `cents` over the lines in proportion to their gross, capped per line; rounding rest on the largest. */
function spread(items: ReadonlyArray<{ id: string; grossCents: number }>, cents: number): Record<string, number> {
  const total = items.reduce((s, i) => s + i.grossCents, 0);
  const out: Record<string, number> = {};
  if (total <= 0 || cents <= 0) return Object.fromEntries(items.map((i) => [i.id, 0]));
  const target = Math.min(cents, total);
  let used = 0;
  for (const i of items) {
    out[i.id] = Math.min(i.grossCents, Math.floor((i.grossCents * target) / total));
    used += out[i.id]!;
  }
  const largest = [...items].sort((a, b) => b.grossCents - a.grossCents);
  for (const i of largest) {
    if (used >= target) break;
    const add = Math.min(target - used, i.grossCents - out[i.id]!);
    out[i.id]! += add;
    used += add;
  }
  return out;
}

export function proposeCreditNote(invoice: CreditSourceInvoice, source: CreditSource): CreditProposal {
  const items = invoice.items.filter((i) => i.grossCents > 0);
  if (!source) return { lines: Object.fromEntries(items.map((i) => [i.id, i.grossCents])), shippingCents: invoice.shippingGrossCents, note: "Kein Erstattungsbetrag bekannt: die ganze Rechnung ist vorgeschlagen." };
  if (source.kind === "amount") {
    const lines = spread(items, Math.min(source.cents, invoice.grossCents - invoice.shippingGrossCents));
    const rest = source.cents - Object.values(lines).reduce((s, v) => s + v, 0);
    return { lines, shippingCents: Math.max(0, Math.min(invoice.shippingGrossCents, rest)), note: `${source.label}: auf die Positionen verteilt.` };
  }
  const shippingCents = Math.min(source.shippingCents, invoice.shippingGrossCents);
  // By article number = marketplace SKU; otherwise in proportion.
  const bySku = new Map<string, number>();
  let matched = true;
  for (const l of source.lines) {
    const item = items.find((i) => i.articleNumber && norm(i.articleNumber) === norm(l.sku)) ?? items.find((i) => norm(i.title) === norm(l.title) && !!l.title);
    if (!item) { matched = false; break; }
    bySku.set(item.id, Math.min(item.grossCents, (bySku.get(item.id) ?? 0) + l.principalCents));
  }
  const principal = source.lines.reduce((s, l) => s + l.principalCents, 0);
  if (matched) return { lines: Object.fromEntries(items.map((i) => [i.id, bySku.get(i.id) ?? 0])), shippingCents, note: `${source.label}: Positionen über die Artikelnummer zugeordnet.` };
  return { lines: spread(items, principal), shippingCents, note: `${source.label}: Artikelnummern passen nicht zur Rechnung, Betrag anteilig verteilt. Bitte prüfen.` };
}

export type CreditCheck = { ok: true; lines: Array<{ itemId: string; grossCents: number }>; shippingCents: number; totalCents: number } | { ok: false; error: string };

/**
 * Validates the amounts: each line at most its gross, shipping at most the
 * invoice's shipping, the total at most what is left of the invoice after
 * earlier SupportX credit notes.
 */
export function checkCreditNote(invoice: CreditSourceInvoice, lines: ReadonlyArray<{ itemId: string; grossCents: number }>, shippingCents: number, earlierCents: number): CreditCheck {
  if (invoice.type === "CREDIT_NOTE") return { ok: false, error: "Das ist schon eine Gutschrift." };
  if (invoice.status === "CANCELLED") return { ok: false, error: "Die Rechnung ist storniert." };
  const out: Array<{ itemId: string; grossCents: number }> = [];
  const seen = new Set<string>();
  for (const l of lines) {
    if (seen.has(l.itemId)) return { ok: false, error: "Eine Position ist doppelt angegeben." };
    seen.add(l.itemId);
    const item = invoice.items.find((i) => i.id === l.itemId);
    if (!item) return { ok: false, error: "Eine Position gehört nicht zu dieser Rechnung." };
    if (!Number.isSafeInteger(l.grossCents) || l.grossCents < 0) return { ok: false, error: "Beträge bitte als positive Zahl eingeben." };
    if (l.grossCents > item.grossCents) return { ok: false, error: `„${item.title}“: höchstens ${(item.grossCents / 100).toFixed(2).replace(".", ",")} möglich.` };
    if (l.grossCents > 0) out.push({ itemId: l.itemId, grossCents: l.grossCents });
  }
  if (!Number.isSafeInteger(shippingCents) || shippingCents < 0 || shippingCents > invoice.shippingGrossCents) return { ok: false, error: "Versand: höchstens die Versandkosten der Rechnung." };
  if (out.length === 0) return { ok: false, error: "Bitte mindestens eine Position mit Betrag angeben." };
  const totalCents = out.reduce((s, l) => s + l.grossCents, 0) + shippingCents;
  if (totalCents > invoice.grossCents - earlierCents) return { ok: false, error: "Zusammen mit früheren Gutschriften aus SupportX wäre das mehr als die Rechnung." };
  return { ok: true, lines: out, shippingCents, totalCents };
}
