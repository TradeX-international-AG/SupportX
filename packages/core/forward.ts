/**
 * Forwarding one mail of a case to other addresses. Pure helpers shared by the
 * service, the UI and the tests: recipient parsing, the mode per case and the
 * text of a relay-safe forward.
 */
import type { SourcePlatform } from "./contracts.ts";
import { PLATFORM_NAMES, RELAY_PLATFORMS as RELAY_LIST } from "./marketplaces.ts";
import { RETURN_STATUS_DE } from "./returns.ts";

export const MAX_FORWARD_RECIPIENTS = 10;
export const MAX_FORWARD_COMMENT = 5000;

/** Platforms whose mails arrive through a buyer relay address that must stay in the mailbox. */
const RELAY_PLATFORMS: ReadonlySet<string> = new Set(RELAY_LIST);

/** Sender domains of marketplace relay addresses, also when no routing rule set the platform. */
const RELAY_DOMAINS = [/(^|\.)marketplace\.amazon\.[a-z.]+$/, /(^|\.)members\.ebay\.[a-z.]+$/];

const EMAIL = /^[^\s@<>(),;:"\[\]]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/i;
const EMAIL_IN_TEXT = /[^\s@<>(),;:"'\[\]]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+/gi;

export type ForwardMode = "original" | "text";

export function isRelayAddress(address: string): boolean {
  const domain = address.toLowerCase().split("@")[1] ?? "";
  return RELAY_DOMAINS.some((d) => d.test(domain));
}

/**
 * Original forward only for plain mail cases. A marketplace relay mail goes out
 * as text without addresses: the relay address identifies the buyer and would let
 * the recipient write to the customer around the marketplace.
 */
export function forwardMode(platform: SourcePlatform | string, addresses: ReadonlyArray<string>): ForwardMode {
  if (RELAY_PLATFORMS.has(platform)) return "text";
  return addresses.some(isRelayAddress) ? "text" : "original";
}

/** Split a typed list ("a@x.de, b@y.de; c@z.de") into checked, de-duplicated addresses. */
export function parseRecipients(input: string | ReadonlyArray<string>): { valid: string[]; invalid: string[] } {
  const parts = (typeof input === "string" ? [input] : [...input]).flatMap((p) => p.split(/[\s,;]+/)).map((p) => p.trim().replace(/^<|>$/g, "")).filter(Boolean);
  const valid: string[] = [];
  const invalid: string[] = [];
  for (const p of parts) {
    const a = p.toLowerCase();
    if (!EMAIL.test(a) || a.length > 254) invalid.push(p);
    else if (!valid.includes(a)) valid.push(a);
  }
  return { valid, invalid };
}

/** "Fwd: Betreff", without stacking prefixes. */
export function forwardSubject(subject: string): string {
  const base = subject.replace(/^\s*((fwd?|wg|aw|re)\s*:\s*)+/i, "").trim();
  return `Fwd: ${base || "(ohne Betreff)"}`.slice(0, 500);
}

/** Every mail address in a text replaced by a placeholder. */
export function maskAddresses(text: string): string {
  return text.replace(EMAIL_IN_TEXT, "[Adresse entfernt]");
}

const PLATFORM_NAME: Record<string, string> = PLATFORM_NAMES;

/** Body of a relay-safe forward: own comment, then the original text with all addresses removed. */
export function forwardText(input: { comment: string; platform: string; receivedAt: Date | string; subject: string; direction: "inbound" | "outbound"; body: string; leftOut?: ReadonlyArray<string> }): string {
  const when = new Date(input.receivedAt).toLocaleString("de-DE", { dateStyle: "short", timeStyle: "short", timeZone: "Europe/Berlin" });
  const from = input.direction === "inbound" ? `Kunde über ${PLATFORM_NAME[input.platform] ?? input.platform}` : "wir (Kundenservice)";
  const lines = [
    ...(input.comment.trim() ? [input.comment.trim(), ""] : []),
    "---------- Weitergeleitete Nachricht ----------",
    `Von: ${from}`,
    `Datum: ${when}`,
    `Betreff: ${maskAddresses(input.subject) || "(ohne Betreff)"}`,
    "",
    maskAddresses(input.body).trim(),
  ];
  if (input.leftOut?.length) lines.push("", `Nicht mitgesendet (zu groß): ${input.leftOut.join(", ")}`);
  return lines.join("\n");
}

/** One entry of the case history for a whole-case forward, oldest first. */
export interface CaseForwardEntry {
  at: Date | string;
  /** inbound: the customer; outbound: we (our reply, also one written outside SupportX). */
  direction: "inbound" | "outbound";
  fromAddress?: string | null;
  fromName?: string | null;
  subject?: string | null;
  body: string;
  /** e.g. "noch nicht gesendet", "Versand ungeklärt" for our replies that are not confirmed. */
  stateNote?: string;
  attachmentNames?: ReadonlyArray<string>;
}

/** The order facts the forward lists (structural, so the browser bundle needs no server types). */
export interface CaseForwardOrder {
  provider?: string;
  orderNumber?: string;
  orderNumberAtCustomer?: string;
  orderDate?: string;
  status?: string;
  salesChannelName?: string;
  salesChannel?: string;
  grossAmount?: number;
  shippingGrossAmount?: number;
  currency?: string;
  retrievedAt?: string;
  lines: ReadonlyArray<{ position?: number; title: string; articleNumber?: string; quantity: number; shippedQuantity?: number; returnedQuantity?: number; grossAmount?: number }>;
  shipments: ReadonlyArray<{ shipmentNumber?: string; erpStatus?: string; shippingDate?: string; deliveryDate?: string; parcels: ReadonlyArray<{ trackingId?: string; trackingUrl?: string }>; returnLabels?: number }>;
  invoices: ReadonlyArray<{ invoiceNumber?: string; invoiceDate?: string; type?: string; status?: string; paymentStatus?: string; grossAmount?: number }>;
  returns?: ReadonlyArray<{ returnNumber?: string; erpStatus?: string; createdAt?: string; items: ReadonlyArray<{ title?: string; quantity: number; reason?: string }> }>;
  returnsError?: string;
}

export interface CaseForwardInput {
  comment: string;
  platform: string;
  subject: string;
  status?: string;
  outcome?: string | null;
  assignee?: string | null;
  customer?: { name?: string | null; address?: string | null };
  /** Order match state of the case: unique, ambiguous, missing, pending, error. */
  orderMatch?: string | null;
  order?: CaseForwardOrder | null;
  entries: ReadonlyArray<CaseForwardEntry>;
  notes?: ReadonlyArray<{ at: Date | string; author?: string | null; body: string }>;
  /** Remove every mail address (marketplace relay cases): the recipient cannot write to the buyer around the marketplace. */
  mask: boolean;
  attached?: ReadonlyArray<string>;
  leftOut?: ReadonlyArray<string>;
}

const CASE_STATUS_DE: Record<string, string> = { open: "offen", waiting: "wartet", closed: "erledigt" };
const INVOICE_TYPE_DE: Record<string, string> = { STANDARD_INVOICE: "Rechnung", CREDIT_NOTE: "Gutschrift", ADVANCE_PAYMENT_INVOICE: "Anzahlungsrechnung", PREPAYMENT_INVOICE: "Vorkasse-Rechnung", RETAIL_INVOICE: "Rechnung" };
const RETURN_DE: Readonly<Record<string, string>> = RETURN_STATUS_DE;

function berlin(at: Date | string, withTime = true): string {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return String(at);
  return d.toLocaleString("de-DE", withTime ? { dateStyle: "short", timeStyle: "short", timeZone: "Europe/Berlin" } : { dateStyle: "short", timeZone: "Europe/Berlin" });
}

function money(value: number | undefined, currency: string | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return "";
  return `${value.toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency ?? ""}`.trim();
}

function orderBlock(o: CaseForwardOrder, match: string | null | undefined): string[] {
  const erp = o.provider === "plentymarkets" ? "plentymarkets" : "weclapp";
  const lines = [`BESTELLUNG (${erp}${o.retrievedAt ? `, Stand ${berlin(o.retrievedAt)}` : ""})`];
  const kv = (k: string, v: string | undefined) => { if (v) lines.push(`${k}: ${v}`); };
  kv("Auftragsnummer", o.orderNumber);
  if (o.orderNumberAtCustomer && o.orderNumberAtCustomer !== o.orderNumber) kv("Bestellnummer Kunde/Marktplatz", o.orderNumberAtCustomer);
  kv("Bestelldatum", o.orderDate ? berlin(o.orderDate, false) : undefined);
  kv("Status", o.status);
  kv("Verkaufskanal", o.salesChannelName ?? o.salesChannel);
  kv("Gesamtbetrag", money(o.grossAmount, o.currency));
  kv("davon Versand", o.shippingGrossAmount ? money(o.shippingGrossAmount, o.currency) : undefined);
  if (match && match !== "unique") lines.push("Hinweis: Die Bestellung ist dem Fall nicht eindeutig zugeordnet.");
  if (o.lines.length) {
    lines.push("", "Positionen:");
    for (const l of o.lines) {
      const extra = [
        l.articleNumber ? `Art.-Nr. ${l.articleNumber}` : "",
        l.shippedQuantity !== undefined ? `versendet ${l.shippedQuantity}` : "",
        l.returnedQuantity ? `retourniert ${l.returnedQuantity}` : "",
        money(l.grossAmount, o.currency),
      ].filter(Boolean).join(", ");
      lines.push(`- ${l.quantity} × ${l.title}${extra ? ` (${extra})` : ""}`);
    }
  }
  lines.push("", "Versand:");
  if (!o.shipments.length) lines.push("- keine Lieferung erfasst");
  for (const s of o.shipments) {
    const head = [s.shipmentNumber ? `Lieferung ${s.shipmentNumber}` : "Lieferung", s.erpStatus ? `Status ${s.erpStatus}` : "", s.shippingDate ? `versendet ${berlin(s.shippingDate, false)}` : "", s.deliveryDate ? `Liefertermin laut ERP ${berlin(s.deliveryDate, false)}` : "", s.returnLabels ? `${s.returnLabels} Retourenlabel` : ""].filter(Boolean).join(", ");
    lines.push(`- ${head}`);
    for (const p of s.parcels) if (p.trackingId || p.trackingUrl) lines.push(`  Sendungsnummer: ${[p.trackingId, p.trackingUrl].filter(Boolean).join(" ")}`);
  }
  lines.push("", "Rechnungen und Gutschriften:");
  if (!o.invoices.length) lines.push("- keine");
  for (const i of o.invoices) {
    lines.push(`- ${[INVOICE_TYPE_DE[i.type ?? ""] ?? i.type ?? "Rechnung", i.invoiceNumber, i.invoiceDate ? `vom ${berlin(i.invoiceDate, false)}` : "", money(i.grossAmount, o.currency), i.status ? `Status ${i.status}` : "", i.paymentStatus ? `Zahlung ${i.paymentStatus}` : ""].filter(Boolean).join(" ")}`);
  }
  lines.push("", "Retouren:");
  if (o.returns === undefined) lines.push("- nicht geprüft");
  else if (!o.returns.length) lines.push("- keine");
  for (const r of o.returns ?? []) {
    lines.push(`- ${[r.returnNumber ? `Retoure ${r.returnNumber}` : "Retoure", r.erpStatus ? RETURN_DE[r.erpStatus] ?? r.erpStatus : "", r.createdAt ? `angelegt ${berlin(r.createdAt, false)}` : ""].filter(Boolean).join(", ")}`);
    for (const it of r.items) lines.push(`  ${it.quantity} × ${it.title ?? "Artikel"}${it.reason ? ` (Grund: ${it.reason})` : ""}`);
  }
  if (o.returnsError) lines.push(`(Retouren konnten nicht vollständig gelesen werden: ${o.returnsError})`);
  return lines;
}

const MATCH_DE: Record<string, string> = { ambiguous: "mehrere Bestellungen passen, keine zugeordnet", missing: "keine Bestellung gefunden", pending: "Bestellung wird noch gesucht", error: "Bestellung konnte nicht gelesen werden" };

/**
 * Body of a whole-case forward: own comment, case facts, the order from the ERP
 * and the full history (customer messages and our replies), oldest first. In
 * marketplace relay cases every mail address is removed.
 */
export function caseForwardText(input: CaseForwardInput): string {
  const m = (s: string) => (input.mask ? maskAddresses(s) : s);
  const platform = PLATFORM_NAME[input.platform] ?? input.platform;
  const out: string[] = [];
  if (input.comment.trim()) out.push(input.comment.trim(), "");
  out.push("========== Weitergeleiteter Fall ==========", `Betreff: ${m(input.subject) || "(ohne Betreff)"}`, `Kanal: ${platform}`);
  if (input.status) out.push(`Status: ${CASE_STATUS_DE[input.status] ?? input.status}`);
  if (input.assignee) out.push(`Zuständig: ${input.assignee}`);
  const cust = [input.customer?.name, input.mask ? "" : input.customer?.address].filter(Boolean).join(" ");
  if (cust) out.push(`Kunde: ${m(cust)}`);
  out.push("");
  if (input.order) out.push(...orderBlock(input.order, input.orderMatch).map(m), "");
  else out.push(`BESTELLUNG: ${MATCH_DE[input.orderMatch ?? ""] ?? "keine zugeordnet"}`, "");
  out.push(`VERLAUF (${input.entries.length} ${input.entries.length === 1 ? "Nachricht" : "Nachrichten"}, älteste zuerst)`);
  for (const e of input.entries) {
    const who = e.direction === "inbound"
      ? `Kunde${input.mask ? ` über ${platform}` : e.fromName || e.fromAddress ? ` (${[e.fromName, e.fromAddress ? `<${e.fromAddress}>` : ""].filter(Boolean).join(" ")})` : ""}`
      : "Wir (Kundenservice)";
    out.push("", `---------- ${who}, ${berlin(e.at)}${e.stateNote ? `, ${e.stateNote}` : ""} ----------`);
    if (e.subject) out.push(`Betreff: ${m(e.subject)}`);
    if (e.attachmentNames?.length) out.push(`Anhänge: ${e.attachmentNames.join(", ")}`);
    out.push("", m(e.body).trim() || "(kein Text)");
  }
  if (input.notes?.length) {
    out.push("", "INTERNE NOTIZEN");
    for (const n of input.notes) out.push(`- ${berlin(n.at)}${n.author ? ` ${n.author}` : ""}: ${m(n.body).trim()}`);
  }
  if (input.attached?.length) out.push("", `Angehängt: ${input.attached.join(", ")}`);
  if (input.leftOut?.length) out.push("", `Nicht mitgesendet (zu groß): ${input.leftOut.join(", ")}`);
  return out.join("\n");
}

/** "Fwd: Fall: Betreff". */
export function caseForwardSubject(subject: string): string {
  const base = subject.replace(/^\s*((fwd?|wg|aw|re)\s*:\s*)+/i, "").trim();
  return `Fwd: Fall: ${base || "(ohne Betreff)"}`.slice(0, 500);
}
