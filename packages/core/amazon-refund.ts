/**
 * Refund at Amazon from a case (pure logic, shared by server and browser).
 *
 * Amazon has no refund endpoint in the SP-API. A seller refunds an order by an
 * "order adjustment": feed type POST_PAYMENT_ADJUSTMENT_DATA (Feeds API
 * 2021-06-30, XML schema OrderAdjustment). Amazon then refunds the buyer from
 * the payment of the order. One adjusted item per order item; amounts are the
 * money given back, per price component (Principal = item price, Shipping).
 *
 * Checked here before anything is sent: the order is shipped, every amount is
 * positive, a line never gets back more than was paid for it minus what
 * SupportX already refunded, and the total equals what the person confirmed.
 */

/** Order item as the Orders API v0 reports it (amounts in cents, gross in EU marketplaces). */
export interface AmazonOrderItem {
  orderItemId: string;
  sku?: string;
  asin?: string;
  title?: string;
  quantity: number;
  itemPriceCents: number;
  shippingPriceCents: number;
  /** Promotion discount on the item price (already deducted by Amazon from what the buyer paid). */
  promotionDiscountCents: number;
}

export interface AmazonOrderView {
  orderId: string;
  /** Pending, Unshipped, PartiallyShipped, Shipped, Canceled, Unfulfillable, … */
  status: string;
  /** MFN = seller-fulfilled, AFN = fulfilled by Amazon (FBA). */
  fulfillmentChannel: string;
  marketplaceId: string;
  currency: string;
  items: AmazonOrderItem[];
}

/** Reasons from Amazon's OrderAdjustment schema that fit support cases, with German labels. */
export const AMAZON_REFUND_REASONS = [
  { value: "CustomerReturn", label: "Rücksendung des Kunden" },
  { value: "GeneralAdjustment", label: "Kulanz / Teilerstattung" },
  { value: "DifferentItem", label: "Falscher Artikel geliefert" },
  { value: "PriceError", label: "Preisfehler" },
  { value: "CouldNotShip", label: "Konnte nicht versenden" },
  { value: "Undeliverable", label: "Nicht zustellbar" },
  { value: "CustomerCancel", label: "Kunde hat storniert" },
  { value: "Other", label: "Sonstiges" },
] as const;
export type AmazonRefundReason = (typeof AMAZON_REFUND_REASONS)[number]["value"];

export function isAmazonRefundReason(v: string): v is AmazonRefundReason {
  return AMAZON_REFUND_REASONS.some((r) => r.value === v);
}

/** Amazon order number "302-1234567-1234567". */
export const AMAZON_ORDER_ID = /^\d{3}-\d{7}-\d{7}$/;

/** Statuses in which Amazon accepts an adjustment; before shipping the order is cancelled instead. */
const REFUNDABLE_STATUS = new Set(["Shipped", "PartiallyShipped", "InvoiceUnconfirmed"]);

export function refundBlocker(order: Pick<AmazonOrderView, "status">): string | null {
  if (REFUNDABLE_STATUS.has(order.status)) return null;
  if (order.status === "Canceled") return "Die Bestellung ist bei Amazon storniert. Es gibt nichts zu erstatten.";
  if (order.status === "Pending" || order.status === "Unshipped") return "Die Bestellung ist noch nicht versandt. Amazon erstattet erst nach dem Versand; vorher bitte in Seller Central stornieren.";
  return `Amazon-Status „${order.status}“: eine Erstattung ist so nicht möglich.`;
}

/** What one line may still get back (paid minus earlier SupportX refunds). */
export function refundableOf(item: AmazonOrderItem, earlier: ReadonlyArray<RefundLine>): { principalCents: number; shippingCents: number } {
  const prior = earlier.filter((l) => l.orderItemId === item.orderItemId);
  const paid = Math.max(0, item.itemPriceCents - item.promotionDiscountCents);
  return {
    principalCents: Math.max(0, paid - prior.reduce((s, l) => s + l.principalCents, 0)),
    shippingCents: Math.max(0, item.shippingPriceCents - prior.reduce((s, l) => s + l.shippingCents, 0)),
  };
}

export interface RefundLine {
  orderItemId: string;
  principalCents: number;
  shippingCents: number;
}

export type RefundCheck = { ok: true; lines: RefundLine[]; totalCents: number } | { ok: false; error: string };

/** Validates the requested amounts against the order. Lines with 0 are dropped. */
export function checkRefund(order: AmazonOrderView, requested: ReadonlyArray<RefundLine>, earlier: ReadonlyArray<RefundLine>): RefundCheck {
  const blocker = refundBlocker(order);
  if (blocker) return { ok: false, error: blocker };
  const lines: RefundLine[] = [];
  const seen = new Set<string>();
  for (const r of requested) {
    if (seen.has(r.orderItemId)) return { ok: false, error: "Eine Position ist doppelt angegeben." };
    seen.add(r.orderItemId);
    const item = order.items.find((i) => i.orderItemId === r.orderItemId);
    if (!item) return { ok: false, error: "Eine Position gehört nicht zu dieser Amazon-Bestellung." };
    for (const v of [r.principalCents, r.shippingCents]) if (!Number.isSafeInteger(v) || v < 0) return { ok: false, error: "Beträge bitte als positive Zahl eingeben." };
    if (r.principalCents === 0 && r.shippingCents === 0) continue;
    const left = refundableOf(item, earlier);
    const name = item.title ?? item.sku ?? item.orderItemId;
    if (r.principalCents > left.principalCents) return { ok: false, error: `„${name}“: höchstens ${formatCents(left.principalCents, order.currency)} für den Artikel möglich.` };
    if (r.shippingCents > left.shippingCents) return { ok: false, error: `„${name}“: höchstens ${formatCents(left.shippingCents, order.currency)} Versand möglich.` };
    lines.push({ orderItemId: r.orderItemId, principalCents: r.principalCents, shippingCents: r.shippingCents });
  }
  const totalCents = lines.reduce((s, l) => s + l.principalCents + l.shippingCents, 0);
  if (totalCents <= 0) return { ok: false, error: "Bitte einen Betrag eintragen." };
  return { ok: true, lines, totalCents };
}

const ZERO_DECIMAL = new Set(["JPY"]);

/** Cents → the decimal string the feed expects ("12.50"; JPY without decimals). */
export function feedAmount(cents: number, currency: string): string {
  return ZERO_DECIMAL.has(currency) ? String(Math.round(cents / 100)) : (cents / 100).toFixed(2);
}

/** Feed amount ("12.50") → cents. */
export function amountToCents(v: string | number | undefined | null): number {
  const n = typeof v === "number" ? v : Number(String(v ?? "0").replace(",", "."));
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

export function formatCents(cents: number, currency = "EUR"): string {
  try {
    return new Intl.NumberFormat("de-DE", { style: "currency", currency }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency}`;
  }
}

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

/** The OrderAdjustment feed document for one order. Exported for contract tests. */
export function adjustmentFeedXml(input: { sellerId: string; orderId: string; currency: string; reason: AmazonRefundReason; lines: ReadonlyArray<RefundLine> }): string {
  if (!AMAZON_ORDER_ID.test(input.orderId)) throw new Error("Ungültige Amazon-Bestellnummer.");
  if (!/^[A-Z]{3}$/.test(input.currency)) throw new Error("Ungültige Währung.");
  const cur = xml(input.currency);
  const component = (type: string, cents: number) =>
    cents > 0 ? `<Component><Type>${type}</Type><Amount currency="${cur}">${feedAmount(cents, input.currency)}</Amount></Component>` : "";
  const items = input.lines
    .map((l) => `<AdjustedItem><AmazonOrderItemCode>${xml(l.orderItemId)}</AmazonOrderItemCode><AdjustmentReason>${xml(input.reason)}</AdjustmentReason><ItemPriceAdjustments>${component("Principal", l.principalCents)}${component("Shipping", l.shippingCents)}</ItemPriceAdjustments></AdjustedItem>`)
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?>
<AmazonEnvelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="amzn-envelope.xsd"><Header><DocumentVersion>1.01</DocumentVersion><MerchantIdentifier>${xml(input.sellerId)}</MerchantIdentifier></Header><MessageType>OrderAdjustment</MessageType><Message><MessageID>1</MessageID><OrderAdjustment><AmazonOrderID>${xml(input.orderId)}</AmazonOrderID>${items}</OrderAdjustment></Message></AmazonEnvelope>
`;
}

export interface ProcessingReport {
  processed: number;
  successful: number;
  withError: number;
  messages: string[];
}

const tag = (src: string, name: string): string | undefined => new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(src)?.[1]?.trim();
const unxml = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

/** Parses Amazon's XML processing report of a feed. */
export function parseProcessingReport(text: string): ProcessingReport | null {
  const summary = tag(text, "ProcessingSummary");
  if (!summary) return null;
  const n = (name: string) => Number(tag(summary, name) ?? 0) || 0;
  const messages = [...text.matchAll(/<Result>([\s\S]*?)<\/Result>/g)]
    .map((m) => ({ code: tag(m[1]!, "ResultCode"), text: tag(m[1]!, "ResultDescription") }))
    .filter((r) => r.text)
    .map((r) => `${r.code ? `${r.code}: ` : ""}${unxml(r.text!)}`)
    .slice(0, 5);
  return { processed: n("MessagesProcessed"), successful: n("MessagesSuccessful"), withError: n("MessagesWithError"), messages };
}

/**
 * Partial refund as a percentage of the item price paid (after promotions), per
 * item, rounded to the cent and never above what is still refundable. Shipping
 * is not included. Returns cents per order item id; null for an invalid percent.
 */
export function percentAmounts(items: ReadonlyArray<Pick<AmazonOrderItem, "orderItemId" | "itemPriceCents" | "promotionDiscountCents"> & { refundablePrincipalCents: number }>, percent: number): Record<string, number> | null {
  if (!Number.isFinite(percent) || percent <= 0 || percent > 100) return null;
  return Object.fromEntries(items.map((i) => {
    const paid = Math.max(0, i.itemPriceCents - i.promotionDiscountCents);
    return [i.orderItemId, Math.min(i.refundablePrincipalCents, Math.round((paid * percent) / 100))];
  }));
}
