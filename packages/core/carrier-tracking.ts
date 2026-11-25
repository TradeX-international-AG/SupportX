
/**
 * Parcel status from the carrier itself (DHL Shipment Tracking – Unified API).
 * Pure helpers shared by the service, the draft check and the browser: which
 * parcel numbers of a case are worth asking DHL about, how a status reads in
 * German, and which facts a reply may cite. A carrier scan is the only thing
 * that may back a "zugestellt" sentence; an ERP booking or a link never does.
 */

/** Same shape as CarrierFact in contracts.ts (structural, so the browser bundle needs no server types). */
export interface CarrierFact {
  id: string;
  text: string;
  source: string;
  observedAt?: string;
}

/** DHL's own status codes (Unified API `status.statusCode`). */
export type CarrierStatusCode = "pre-transit" | "transit" | "delivered" | "failure" | "unknown";

export interface CarrierEvent {
  at?: string;
  statusCode?: CarrierStatusCode;
  /** DHL's short status text and longer description, as DHL wrote it. */
  status?: string;
  description?: string;
  /** "Ort, Land", only when DHL names it. */
  location?: string;
}

/** What one tracking call returned, as stored per workspace and parcel number. */
export interface CarrierTrackingResult {
  carrier: "dhl";
  trackingNumber: string;
  /** "found": DHL knows the number; "not_found": DHL answered 404; "error": the call failed. */
  state: "found" | "not_found" | "error";
  statusCode?: CarrierStatusCode;
  status?: string;
  description?: string;
  statusAt?: string;
  location?: string;
  /** Time of the delivery event, only when DHL reports the parcel as delivered. */
  deliveredAt?: string;
  /** DHL marks parcels that went back to the sender (return shipment). */
  returnFlag?: boolean;
  /** DHL's service, e.g. "parcel-de", "express". */
  service?: string;
  estimatedDelivery?: string;
  events: ReadonlyArray<CarrierEvent>;
  error?: string;
  /** When SupportX asked DHL. */
  fetchedAt: string;
}

/** Where a parcel number in a case comes from. */
export interface ParcelTarget {
  trackingNumber: string;
  /** "shipment": a parcel of a weclapp delivery; "customer": a number the customer wrote (often a return). */
  origin: "shipment" | "customer" | "return_label";
  label: string;
  /** Recipient postal code from weclapp; DHL shows more details only with the right one. */
  postalCode?: string;
}

const OTHER_CARRIER_HOST = /(^|\.)(dpd\.(de|com)|gls-group\.(eu|com)|gls-pakete\.de|ups\.com|myhermes\.de|hermesworld\.com|fedex\.com|tnt\.com|gofo\.(de|com))$/i;
const DHL_HOST = /(^|\.)(dhl\.(de|com)|deutschepost\.de)$/i;
// DHL Paket (12 or 20 digits), Express (10), "JJD…" labels, Warenpost/Einschreiben (XX123456789DE).
const DHL_FORMATS = [/^\d{10,20}$/, /^JJD\d{10,22}$/i, /^JVGL\d{8,20}$/i, /^[A-Z]{2}\d{9}DE$/i];

/** Spaces and dashes are not part of a parcel number. */
export function normalizeTrackingNumber(value: string): string {
  return value.replace(/[\s-]+/g, "").toUpperCase();
}

/**
 * Is this number worth one DHL call? A tracking address of DHL/Deutsche Post says
 * yes, one of another carrier says no; without an address the number format decides.
 */
export function isDhlCandidate(trackingNumber: string, trackingUrl?: string): boolean {
  const n = normalizeTrackingNumber(trackingNumber);
  if (n.length < 8 || n.length > 35 || !/^[A-Z0-9]+$/.test(n)) return false;
  if (trackingUrl) {
    try {
      const host = new URL(trackingUrl).hostname;
      if (DHL_HOST.test(host)) return true;
      if (OTHER_CARRIER_HOST.test(host)) return false;
    } catch {
      /* not an address: fall back to the format */
    }
  }
  return DHL_FORMATS.some((f) => f.test(n));
}

interface OrderInput {
  shipments: ReadonlyArray<{
    shipmentNumber?: string;
    recipientPostalCode?: string;
    parcels: ReadonlyArray<{ trackingId?: string; trackingUrl?: string }>;
  }>;
}

/** Most parcel numbers one case asks DHL about in one go (free tier: 250 calls a day). */
export const MAX_PARCELS_PER_CASE = 10;

/**
 * The DHL parcel numbers of a case: every parcel of every weclapp delivery, then
 * parcel numbers the customer wrote (a return label number, for example), each once.
 */
export function parcelTargets(order: OrderInput | null, customerNumbers: ReadonlyArray<string>, returnLabels: ReadonlyArray<string> = []): ParcelTarget[] {
  const out = new Map<string, ParcelTarget>();
  order?.shipments.forEach((s, i) => {
    s.parcels.forEach((p, k) => {
      if (!p.trackingId || !isDhlCandidate(p.trackingId, p.trackingUrl)) return;
      const n = normalizeTrackingNumber(p.trackingId);
      const name = s.shipmentNumber ? `Lieferung ${s.shipmentNumber}` : `Lieferung ${i + 1}`;
      if (!out.has(n)) out.set(n, { trackingNumber: n, origin: "shipment", label: s.parcels.length > 1 ? `${name}, Paket ${k + 1}` : name, postalCode: s.recipientPostalCode });
    });
  });
  // Return labels made in SupportX: DHL by definition.
  for (const raw of returnLabels) {
    const n = normalizeTrackingNumber(raw);
    if (n && !out.has(n)) out.set(n, { trackingNumber: n, origin: "return_label", label: "Retourenlabel aus SupportX" });
  }
  for (const raw of customerNumbers) {
    const n = normalizeTrackingNumber(raw);
    if (!isDhlCandidate(n) || out.has(n)) continue;
    out.set(n, { trackingNumber: n, origin: "customer", label: "vom Kunden genannt" });
  }
  return [...out.values()].slice(0, MAX_PARCELS_PER_CASE);
}

/** How long a stored answer is used before DHL is asked again on opening the case. */
export const TRACKING_FRESH_MS = 2 * 60 * 60_000;
/** A click on "Neu abrufen" asks again at most this often per number. */
export const TRACKING_MIN_REFRESH_MS = 5 * 60_000;

/** Ask DHL again? Delivered parcels and fresh answers are kept; errors are retried after the click pause. */
export function needsFetch(result: Pick<CarrierTrackingResult, "state" | "statusCode" | "fetchedAt"> | undefined, now: Date, force: boolean): boolean {
  if (!result) return true;
  const age = now.getTime() - new Date(result.fetchedAt).getTime();
  if (force) return age >= TRACKING_MIN_REFRESH_MS;
  if (result.state === "found" && result.statusCode === "delivered") return false;
  if (result.state === "error") return age >= TRACKING_MIN_REFRESH_MS;
  return age >= TRACKING_FRESH_MS;
}

export const CARRIER_STATUS_DE: Readonly<Record<CarrierStatusCode, string>> = {
  "pre-transit": "angekündigt, noch nicht bei DHL eingeliefert",
  transit: "unterwegs",
  delivered: "zugestellt",
  failure: "Problem bei der Zustellung",
  unknown: "Status unbekannt",
};

export type CarrierTone = "good" | "warn" | "bad" | "neutral";

/** Chip text and colour for the case view. */
export function carrierChip(result: CarrierTrackingResult): { label: string; tone: CarrierTone } {
  if (result.state === "not_found") return { label: "bei DHL nicht gefunden", tone: "neutral" };
  if (result.state === "error") return { label: "Abruf fehlgeschlagen", tone: "warn" };
  const code = result.statusCode ?? "unknown";
  if (code === "delivered") return { label: result.returnFlag ? "zurück beim Absender" : "zugestellt", tone: "good" };
  if (code === "failure") return { label: CARRIER_STATUS_DE.failure, tone: "bad" };
  if (code === "transit") return { label: result.returnFlag ? "Rücksendung unterwegs" : "unterwegs", tone: "warn" };
  return { label: CARRIER_STATUS_DE[code], tone: "neutral" };
}

function day(iso: string | undefined): string {
  if (!iso) return "unbekannt";
  const [y, m, d] = iso.slice(0, 10).split("-");
  return `${d}.${m}.${y}`;
}

/**
 * Facts a reply may cite. Only answers DHL actually gave; "not found" and errors
 * add nothing. Ids: carrier.<n>.<statusCode>, so the draft check can tell a
 * delivery scan from a transit scan.
 */
export function carrierFacts(rows: ReadonlyArray<{ target: ParcelTarget; result: CarrierTrackingResult }>): CarrierFact[] {
  const facts: CarrierFact[] = [];
  rows.forEach(({ target, result }, i) => {
    if (result.state !== "found" || !result.statusCode || result.statusCode === "unknown") return;
    const what = target.origin === "customer" ? `Sendung ${target.trackingNumber} (vom Kunden genannt)` : `${target.label}, Sendungsnummer ${target.trackingNumber}`;
    const status = result.statusCode === "delivered" && result.returnFlag ? "an den Absender zurück zugestellt" : CARRIER_STATUS_DE[result.statusCode];
    const when = result.statusCode === "delivered" ? result.deliveredAt ?? result.statusAt : result.statusAt;
    const said = result.description || result.status;
    facts.push({
      id: `carrier.${i + 1}.${result.statusCode}`,
      text: `${what}: laut DHL ${status} (Stand ${day(when)})${said ? `, DHL-Meldung: „${said.slice(0, 200)}“` : ""}.`,
      source: "DHL",
      observedAt: result.fetchedAt,
    });
  });
  return facts;
}

/** A DHL delivery scan among the facts (backs a "zugestellt" sentence). */
export function hasCarrierDelivered(facts: ReadonlyArray<CarrierFact>): boolean {
  return facts.some((f) => /^carrier\.\d+\.delivered$/.test(f.id));
}

/** A DHL scan that shows the parcel left the sender (backs a "versendet/unterwegs" sentence). */
export function hasCarrierDispatch(facts: ReadonlyArray<CarrierFact>): boolean {
  return facts.some((f) => /^carrier\.\d+\.(transit|delivered|failure)$/.test(f.id));
}
