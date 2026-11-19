/**
 * An order as the marketplace itself shows it, read live on a person's click
 * ("Beim Marktplatz nachsehen"). weclapp stays the order source for drafts;
 * this view only answers "what does the marketplace say right now" (status per
 * item, cancellations, returns, refunds). Pure types and label maps, shared by
 * connectors, service, UI and tests.
 */

export interface MarketplaceOrderLine {
  title: string;
  sku?: string;
  quantity?: number;
  /** Raw status code from the marketplace. */
  status?: string;
  statusLabel: string;
}

export interface MarketplaceOrderRefund {
  amount?: number;
  currency?: string;
  state?: string;
  stateLabel: string;
  date?: string;
}

export interface MarketplaceOrderView {
  platform: string;
  orderId: string;
  /** Raw order status; undefined when the marketplace keeps the status per item only. */
  status?: string;
  statusLabel: string;
  createdAt?: string;
  lines: MarketplaceOrderLine[];
  tracking: Array<{ carrier?: string; number?: string; url?: string }>;
  refunds: MarketplaceOrderRefund[];
  fetchedAt: string;
}

/** Read-only order lookup of one marketplace account. Null = no order with this number in this account. */
export interface MarketplaceOrderLookup {
  lookupOrder(orderId: string): Promise<MarketplaceOrderView | null>;
}

/** Mirakl OR11 order_state / order_line_state. */
export const MIRAKL_STATE_DE: Readonly<Record<string, string>> = {
  STAGING: "wird geprüft (Betrugsprüfung)",
  WAITING_ACCEPTANCE: "wartet auf Annahme",
  WAITING_DEBIT: "wartet auf Zahlung",
  WAITING_DEBIT_PAYMENT: "wartet auf Zahlung",
  SHIPPING: "zu versenden",
  TO_COLLECT: "zur Abholung",
  SHIPPED: "versendet",
  RECEIVED: "beim Kunden angekommen (vom Kunden bestätigt)",
  CLOSED: "abgeschlossen",
  REFUSED: "abgelehnt",
  CANCELED: "storniert",
  INCIDENT_OPEN: "Problem gemeldet",
  WAITING_REFUND: "Erstattung angefragt",
  WAITING_REFUND_PAYMENT: "Erstattung wird ausgezahlt",
  REFUNDED: "erstattet",
};

/** Kaufland order unit status (Seller API v2). */
export const KAUFLAND_STATUS_DE: Readonly<Record<string, string>> = {
  open: "neu (noch nicht versandbereit)",
  need_to_be_sent: "zu versenden",
  sent: "versendet",
  received: "beim Kunden angekommen",
  sent_and_autoreceived: "versendet, als angekommen gewertet",
  cancelled: "storniert",
  return_requested: "Rücksendung angemeldet",
  returned: "zurückgeschickt",
  returned_paid: "zurückgeschickt, erstattet",
};

/** OTTO positionItems[].fulfillmentStatus (Orders v4). */
export const OTTO_STATUS_DE: Readonly<Record<string, string>> = {
  ANNOUNCED: "angekündigt (Zahlung offen)",
  PROCESSABLE: "zu versenden",
  SENT: "versendet",
  RETURNED: "zurückgeschickt",
  CANCELLED_BY_PARTNER: "von uns storniert",
  CANCELLED_BY_MARKETPLACE: "von OTTO storniert",
};

/** German label for a raw status; unknown codes are shown as they are. */
export function statusLabel(map: Readonly<Record<string, string>>, raw: unknown): string {
  if (typeof raw !== "string" || !raw) return "unbekannt";
  return map[raw] ?? map[raw.toLowerCase()] ?? map[raw.toUpperCase()] ?? raw;
}

/**
 * One status for the whole order when the marketplace keeps it per item:
 * all items the same → that label, otherwise "gemischt" with the counts.
 */
export function summariseLines(lines: ReadonlyArray<MarketplaceOrderLine>): string {
  if (lines.length === 0) return "keine Positionen";
  const counts = new Map<string, number>();
  for (const l of lines) counts.set(l.statusLabel, (counts.get(l.statusLabel) ?? 0) + (l.quantity ?? 1));
  if (counts.size === 1) return [...counts.keys()][0]!;
  return `gemischt: ${[...counts].map(([label, n]) => `${n} × ${label}`).join(", ")}`;
}

/** Plausible marketplace order numbers only (letters, digits, - and _), so nothing else ends up in a URL. */
export function cleanOrderId(raw: string): string | null {
  const v = raw.trim();
  return /^[A-Za-z0-9][A-Za-z0-9_-]{2,59}$/.test(v) ? v : null;
}
